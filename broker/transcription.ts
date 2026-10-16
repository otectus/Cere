import { spawn, type ChildProcess } from 'node:child_process';
import { getPriority, setPriority } from 'node:os';
import { access, chmod, copyFile, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { paths, privateDir } from './paths.ts';
import { chosenDevice, recorderArgs } from './audio-devices.ts';

export type TranscriptionSettings = { executable: string; model: string };
export type TranscriptionState = 'unavailable' | 'idle' | 'recording' | 'transcribing' | 'error';
export type TranscriptionStatus = {
  state: TranscriptionState;
  sessionId: string;
  revision: number;
  startedAt?: number;
  maximumSeconds: number;
  error: string;
  /** M20: the imported file being transcribed, by name only. */
  file?: string;
};
/** Where an imported transcript came from; a microphone transcript has no source file. */
export type TranscriptSource = { name: string; size: number; sha256: string; durationSeconds: number | null; truncated: boolean };
export type TranscriptionResult = { sessionId: string; revision: number; text: string; source?: TranscriptSource };
export type RecorderCommand = { command: string; args: string[] };
export type TranscriptionOptions = {
  changed(): void;
  settings(): TranscriptionSettings;
  runtimeDirectory?: string;
  recorder?: (output: string) => Promise<RecorderCommand> | RecorderCommand;
  env?: NodeJS.ProcessEnv;
  maximumMilliseconds?: number;
  /** The ffmpeg used to convert imported files; null means none is installed. Found in /usr/bin by default. */
  ffmpeg?: string | null;
};

type Job = {
  sessionId: string; revision: number; startedAt: number; directory: string; audio: string;
  executable: string; model: string; recorder?: ChildProcess; recorderClosed?: Promise<number | null>;
  controller: AbortController; maximum?: NodeJS.Timeout;
};

const transcriptLimit = 100_000;
/** M20 import bounds: the file read, and the audio that is converted and transcribed. */
export const importLimits = { bytes: 1024 * 1024 * 1024, seconds: 3600 };
const audioTypes = new Set(['.wav', '.mp3', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.webm', '.mp4', '.mkv', '.mov', '.m4v']);

/** Lower CPU priority for background processes, so replies and the window stay responsive. */
export const backgroundNice = 10;
function background(child: ChildProcess) {
  // Never raise priority: if the broker already runs nicer than this (a system tuner may renice it), keep that.
  child.once('spawn', () => { try { if (child.pid) setPriority(child.pid, Math.max(backgroundNice, getPriority())); } catch { /* Priority is a courtesy, not a requirement. */ } });
}
/** M10: the chosen microphone is checked first; a missing one fails here, before any recorder starts. */
export async function defaultRecorder(output: string): Promise<RecorderCommand> {
  const device = await chosenDevice('input');
  if (!device.startsWith('alsa:')) try {
    await access('/usr/bin/pw-record', constants.X_OK);
    return { command: '/usr/bin/pw-record', args: ['--format=s16', '--rate=16000', '--channels=1', '--latency=100ms', ...recorderArgs('pw-record', device), output] };
  } catch { /* ALSA is the local fallback when PipeWire tools are absent. */ }
  try {
    await access('/usr/bin/arecord', constants.X_OK);
    return { command: '/usr/bin/arecord', args: ['-q', '-t', 'wav', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', '60', ...recorderArgs('arecord', device), output] };
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
    if (this.current) throw new Error(this.current.recorder ? `The microphone is already recording for session ${this.current.sessionId}` : 'Voice input is busy transcribing a file. Cancel it first.');
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
      if (job.recorder) await stopProcess(job.recorder, job.recorderClosed!);
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
    if (job.recorder) await stopProcess(job.recorder, job.recorderClosed!);
    await this.cleanup(job);
    this.update({ state: this.configured() ? 'idle' : 'unavailable', sessionId: '', revision: this.generation, error: '', file: undefined });
    return this.status();
  }

  /**
   * M20: transcribes an audio file, or the sound of a video, that the user picked. It shares the one
   * voice job with the microphone. Other formats are converted to 16 kHz mono WAV by ffmpeg when it
   * is installed; only the first hour is transcribed. The result is returned for review with its
   * source; it is never sent, and the converted audio is removed afterwards.
   */
  async importFile(input: { sessionId: string; path: unknown }): Promise<TranscriptionResult> {
    if (this.closed) throw new Error('Voice input is closed');
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId.trim()) throw new Error('Choose a session before importing audio');
    if (this.current) throw new Error('Voice input is busy. Finish or cancel it first.');
    const revision = ++this.generation, controller = new AbortController();
    let job: Job | undefined;
    try {
      const configured = this.options.settings();
      const executable = await this.localFile(configured?.executable, true, 'whisper.cpp executable');
      const model = await this.localFile(configured?.model, false, 'whisper.cpp model');
      if (typeof input.path !== 'string' || !input.path.startsWith('/')) throw new Error('Choose an audio or video file');
      const source = await realpath(input.path), info = await stat(source), type = extname(source).toLowerCase();
      if (!info.isFile()) throw new Error('Choose a regular audio or video file');
      if (!audioTypes.has(type)) throw new Error('Choose WAV, MP3, OGG, Opus, FLAC, M4A, AAC, WebM, MP4, MKV or MOV');
      if (info.size > importLimits.bytes) throw new Error('Files up to 1 GB can be transcribed');
      this.assertCurrentReservation(revision);
      const root = privateDir(join(resolve(this.options.runtimeDirectory || paths().runtime), 'transcription'));
      const directory = await mkdtemp(join(root, 'import-')); await chmod(directory, 0o700);
      job = { sessionId: input.sessionId, revision, startedAt: Date.now(), directory, audio: join(directory, 'audio.wav'), executable, model, controller };
      this.current = job;
      this.update({ state: 'transcribing', sessionId: input.sessionId, revision, startedAt: job.startedAt, error: '', file: basename(source) });
      const sha256 = await this.digest(source, controller.signal);
      const converted = await this.convert(job, source, type);
      job.controller.signal.throwIfAborted(); this.assertCurrent(job);
      const prefix = join(directory, 'transcript');
      await this.whisper(job, prefix, 30 * 60_000);
      job.controller.signal.throwIfAborted(); this.assertCurrent(job);
      const text = (await readFile(prefix + '.txt', 'utf8')).trim();
      if (!text) throw new Error('whisper.cpp returned an empty transcript');
      if (text.length > transcriptLimit) throw new Error('The transcript exceeded 100,000 characters');
      await this.cleanup(job); this.current = undefined;
      this.update({ state: this.configured() ? 'idle' : 'unavailable', sessionId: '', revision, error: '', file: undefined });
      return { sessionId: input.sessionId, revision, text, source: { name: basename(source), size: info.size, sha256, ...converted } };
    } catch (error: any) {
      if (job) await this.cleanup(job);
      if (controller.signal.aborted || this.generation !== revision) throw new Error('Voice input was cancelled');
      if (this.current === job) this.current = undefined;
      if (this.generation === revision) this.update({ state: this.configured() ? 'error' : 'unavailable', sessionId: input.sessionId, revision, error: error.message || 'The file could not be transcribed', file: undefined });
      throw error;
    }
  }
  private async digest(path: string, signal: AbortSignal) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) { signal.throwIfAborted(); hash.update(chunk as Buffer); }
    return hash.digest('hex');
  }
  /** Converts to 16 kHz mono WAV with ffmpeg, bounded to the first hour; a 16 kHz WAV can be used as it is. */
  private async convert(job: Job, source: string, type: string): Promise<{ durationSeconds: number | null; truncated: boolean }> {
    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg) {
      if (type !== '.wav') throw new Error('Install ffmpeg to transcribe this format, or choose a 16 kHz WAV file');
      const handle = await open(source, 'r'), header = Buffer.alloc(44);
      try { await handle.read(header, 0, 44, 0); } finally { await handle.close(); }
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE' || header.readUInt32LE(24) !== 16000) throw new Error('Without ffmpeg, only 16 kHz WAV files can be transcribed');
      await copyFile(source, job.audio); await chmod(job.audio, 0o600);
      return { durationSeconds: null, truncated: false };
    }
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-i', source, '-vn', '-t', String(importLimits.seconds), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', job.audio],
      { env: this.options.env || process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    background(child);
    let stderr = '';
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', data => { stderr = (stderr + data).slice(-16384); });
    const closed = waitForClose(child);
    const terminate = () => child.kill('SIGKILL');
    job.controller.signal.addEventListener('abort', terminate, { once: true });
    const timeout = setTimeout(terminate, 10 * 60_000); timeout.unref();
    try {
      const code = await closed;
      job.controller.signal.throwIfAborted();
      if (code !== 0) throw new Error(`ffmpeg could not read this file (exit ${code})`);
    } finally { clearTimeout(timeout); job.controller.signal.removeEventListener('abort', terminate); }
    const match = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/), duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
    if ((await stat(job.audio)).size <= 44) throw new Error('This file has no audio track');
    return { durationSeconds: duration === null ? null : Math.round(duration), truncated: duration !== null && duration > importLimits.seconds };
  }
  private async findFfmpeg() {
    if (this.options.ffmpeg !== undefined) return this.options.ffmpeg || '';
    for (const candidate of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) { try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ } }
    return '';
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
  private async whisper(job: Job, prefix: string, limit = 5 * 60_000) {
    const child = spawn(job.executable, ['-m', job.model, '-f', job.audio, '--output-txt', '--output-file', prefix, '--no-timestamps'], {
      env: this.options.env || process.env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    // A04: transcribing a file is background work; dictation keeps normal priority.
    if (!job.recorder) background(child);
    let stderr = '', killTimer: NodeJS.Timeout | undefined;
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', data => { stderr = (stderr + data).slice(-4096); });
    const closed = waitForClose(child);
    const terminate = () => { child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref(); };
    job.controller.signal.addEventListener('abort', terminate, { once: true });
    const timeout = setTimeout(terminate, limit); timeout.unref();
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
    if (job.recorder) await stopProcess(job.recorder, job.recorderClosed!); await this.cleanup(job);
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
