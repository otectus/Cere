import { spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths, privateDir } from './paths.ts';

export type TranscriptionSettings = { executable: string; model: string };
export type TranscriptionState = 'unavailable' | 'idle' | 'recording' | 'transcribing' | 'error';
export type TranscriptionStatus = {
  state: TranscriptionState;
  sessionId: string;
  revision: number;
  startedAt?: number;
  maximumSeconds: number;
  error: string;
};
export type TranscriptionResult = { sessionId: string; revision: number; text: string };
export type RecorderCommand = { command: string; args: string[] };
export type TranscriptionOptions = {
  changed(): void;
  settings(): TranscriptionSettings;
  runtimeDirectory?: string;
  recorder?: (output: string) => Promise<RecorderCommand> | RecorderCommand;
  env?: NodeJS.ProcessEnv;
  maximumMilliseconds?: number;
};

type Job = {
  sessionId: string; revision: number; startedAt: number; directory: string; audio: string;
  executable: string; model: string; recorder: ChildProcess; recorderClosed: Promise<number | null>;
  controller: AbortController; maximum?: NodeJS.Timeout;
};

const transcriptLimit = 100_000;

async function defaultRecorder(output: string): Promise<RecorderCommand> {
  try {
    await access('/usr/bin/pw-record', constants.X_OK);
    return { command: '/usr/bin/pw-record', args: ['--format=s16', '--rate=16000', '--channels=1', '--latency=100ms', output] };
  } catch { /* ALSA is the local fallback when PipeWire tools are absent. */ }
  try {
    await access('/usr/bin/arecord', constants.X_OK);
    return { command: '/usr/bin/arecord', args: ['-q', '-t', 'wav', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', '60', output] };
  } catch { throw new Error('No local recorder is available. Install PipeWire pw-record or ALSA arecord.'); }
}

function waitForClose(process: ChildProcess): Promise<number | null> {
  return new Promise((resolveClose, reject) => {
    let spawnError: Error | undefined;
    process.once('error', error => { spawnError = error; });
    process.once('close', code => spawnError ? reject(spawnError) : resolveClose(code));
  });
}

async function stopProcess(process: ChildProcess, closed: Promise<unknown>, signal: NodeJS.Signals = 'SIGINT') {
  if (process.exitCode !== null || process.signalCode) return closed.catch(() => {});
  process.kill(signal);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([closed.catch(() => {}), new Promise<void>(resolveTimeout => {
      timer = setTimeout(() => { process.kill('SIGKILL'); resolveTimeout(); }, 1500); timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
  await closed.catch(() => {});
}

/** One broker-owned, local microphone and whisper.cpp lifecycle. */
export class Transcription {
  private readonly options: TranscriptionOptions;
  private current?: Job;
  private generation = 0;
  private closed = false;
  private state: TranscriptionStatus;

  constructor(options: TranscriptionOptions) {
    this.options = options;
    this.state = { state: this.configured() ? 'idle' : 'unavailable', sessionId: '', revision: 0, maximumSeconds: 60, error: '' };
  }

  status(): TranscriptionStatus {
    if (!this.current && !this.closed && this.state.state !== 'error') this.state.state = this.configured() ? 'idle' : 'unavailable';
    return { ...this.state };
  }

  async start(input: { sessionId: string }): Promise<TranscriptionStatus> {
    if (this.closed) throw new Error('Voice input is closed');
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId.trim()) throw new Error('Choose a session before recording');
    if (this.current) throw new Error(`The microphone is already recording for session ${this.current.sessionId}`);
    // Reserve the sole microphone before filesystem validation yields.
    const revision = ++this.generation, controller = new AbortController();
    this.state = { state: 'idle', sessionId: input.sessionId, revision, maximumSeconds: 60, error: '' };
    this.options.changed();
    let directory = '';
    try {
      const configured = this.options.settings();
      const executable = await this.localFile(configured?.executable, true, 'whisper.cpp executable');
      this.assertCurrentReservation(revision);
      const model = await this.localFile(configured?.model, false, 'whisper.cpp model');
      this.assertCurrentReservation(revision);
      const root = privateDir(join(resolve(this.options.runtimeDirectory || paths().runtime), 'transcription'));
      directory = await mkdtemp(join(root, 'capture-')); await chmod(directory, 0o700);
      const audio = join(directory, 'recording.wav'); await writeFile(audio, '', { mode: 0o600 });
      const record = await (this.options.recorder || defaultRecorder)(audio);
      this.assertCurrentReservation(revision);
      const recorder = spawn(record.command, record.args, { env: this.options.env || process.env, stdio: ['ignore', 'ignore', 'ignore'] });
      const recorderClosed = waitForClose(recorder);
      void recorderClosed.catch(() => {});
      // Observe an immediate spawn failure before claiming that recording began.
      await new Promise<void>((resolveStarted, reject) => {
        recorder.once('spawn', resolveStarted); recorder.once('error', reject);
      });
      const startedAt = Date.now();
      const job: Job = { sessionId: input.sessionId, revision, startedAt, directory, audio, executable, model, recorder, recorderClosed, controller };
      this.current = job;
      const maximum = Math.max(1, Math.min(60_000, this.options.maximumMilliseconds || 60_000));
      job.maximum = setTimeout(() => { void this.expire(job); }, maximum); job.maximum.unref();
      this.state = { state: 'recording', sessionId: job.sessionId, revision, startedAt, maximumSeconds: 60, error: '' };
      this.options.changed();
      // A recorder that exits by itself is an error unless finish/cancel owns it.
      void recorderClosed.then(code => {
        if (this.current === job && this.state.state === 'recording') void this.fail(job, `Microphone recording stopped unexpectedly${code === null ? '' : ` (exit ${code})`}.`);
      }, error => { if (this.current === job) void this.fail(job, `Could not start the microphone recorder: ${error.message}`); });
      return this.status();
    } catch (error: any) {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (this.generation === revision) this.update({ state: this.configured() ? 'error' : 'unavailable', sessionId: input.sessionId, revision, error: error.message || 'Voice input could not start' });
      throw error;
    }
  }

  async finish(): Promise<TranscriptionResult> {
    const job = this.current;
    if (!job || this.state.state !== 'recording') throw new Error('Voice input is not recording');
    if (job.maximum) clearTimeout(job.maximum);
    this.update({ state: 'transcribing', sessionId: job.sessionId, revision: job.revision, error: '' });
    try {
      await stopProcess(job.recorder, job.recorderClosed);
      job.controller.signal.throwIfAborted(); this.assertCurrent(job);
      if ((await stat(job.audio)).size <= 44) throw new Error('The microphone recording was empty');
      const prefix = join(job.directory, 'transcript');
      await this.whisper(job, prefix);
      job.controller.signal.throwIfAborted(); this.assertCurrent(job);
      const text = (await readFile(prefix + '.txt', 'utf8')).trim();
      if (!text) throw new Error('whisper.cpp returned an empty transcript');
      if (text.length > transcriptLimit) throw new Error('The transcript exceeded 100,000 characters');
      const result = { sessionId: job.sessionId, revision: job.revision, text };
      await this.cleanup(job);
      if (this.generation !== job.revision) throw new Error('This transcription result is stale');
      this.current = undefined;
      this.update({ state: this.configured() ? 'idle' : 'unavailable', sessionId: '', revision: job.revision, error: '' });
      return result;
    } catch (error: any) {
      await this.cleanup(job);
      if (job.controller.signal.aborted || this.generation !== job.revision) throw new Error('Voice input was cancelled');
      this.current = undefined;
      this.update({ state: 'error', sessionId: job.sessionId, revision: job.revision, error: error.message || 'Local transcription failed' });
      throw error;
    }
  }

  async cancel(): Promise<TranscriptionStatus> {
    const job = this.current;
    ++this.generation;
    if (!job) {
      this.update({ state: this.configured() ? 'idle' : 'unavailable', sessionId: '', revision: this.generation, error: '' });
      return this.status();
    }
    this.current = undefined;
    if (job.maximum) clearTimeout(job.maximum);
    job.controller.abort(new Error('Voice input was cancelled'));
    await stopProcess(job.recorder, job.recorderClosed);
    await this.cleanup(job);
    this.update({ state: this.configured() ? 'idle' : 'unavailable', sessionId: '', revision: this.generation, error: '' });
    return this.status();
  }

  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.cancel(); }

  private configured() {
    const settings = this.options.settings();
    return typeof settings?.executable === 'string' && !!settings.executable.trim() && typeof settings?.model === 'string' && !!settings.model.trim();
  }
  private update(patch: Partial<TranscriptionStatus>) { this.state = { ...this.state, ...patch }; this.options.changed(); }
  private assertCurrentReservation(revision: number) { if (this.closed || this.generation !== revision || this.current) throw new Error('Voice input start was cancelled'); }
  private assertCurrent(job: Job) { if (this.current !== job || this.generation !== job.revision) throw new Error('This transcription result is stale'); }
  private async localFile(value: unknown, executable: boolean, label: string) {
    if (typeof value !== 'string' || !value.startsWith('/')) throw new Error(`Configure an absolute local ${label} path`);
    const path = await realpath(value);
    if (!(await stat(path)).isFile()) throw new Error(`The configured ${label} is not a file`);
    if (executable) await access(path, constants.X_OK);
    return path;
  }
  private async whisper(job: Job, prefix: string) {
    const child = spawn(job.executable, ['-m', job.model, '-f', job.audio, '--output-txt', '--output-file', prefix, '--no-timestamps'], {
      env: this.options.env || process.env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '', killTimer: NodeJS.Timeout | undefined;
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', data => { stderr = (stderr + data).slice(-4096); });
    const closed = waitForClose(child);
    const terminate = () => { child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref(); };
    job.controller.signal.addEventListener('abort', terminate, { once: true });
    const timeout = setTimeout(terminate, 5 * 60_000); timeout.unref();
    try {
      const code = await closed;
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      if (code !== 0) throw new Error(`whisper.cpp failed (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error(`Could not start whisper.cpp: ${error.message}`);
      throw error;
    } finally {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      job.controller.signal.removeEventListener('abort', terminate);
    }
  }
  private async cleanup(job: Job) { await rm(job.directory, { recursive: true, force: true }); }
  private async expire(job: Job) {
    if (this.current !== job || this.state.state !== 'recording') return;
    ++this.generation; this.current = undefined;
    job.controller.abort(new Error('Voice input reached the 60-second limit'));
    await stopProcess(job.recorder, job.recorderClosed); await this.cleanup(job);
    this.update({ state: 'error', sessionId: job.sessionId, revision: this.generation, error: 'Voice input reached the 60-second recording limit. Try a shorter recording.' });
  }
  private async fail(job: Job, message: string) {
    if (this.current !== job) return;
    ++this.generation; this.current = undefined;
    if (job.maximum) clearTimeout(job.maximum);
    job.controller.abort(new Error(message)); await this.cleanup(job);
    this.update({ state: 'error', sessionId: job.sessionId, revision: this.generation, error: message });
  }
}
