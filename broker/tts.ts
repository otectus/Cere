import { spawn } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './paths.ts';

export const defaultVoice = 'en_US-amy-medium';
export const ttsTestLine = "Hello, I'm Cere. Local voice is ready. Let's make a little trouble.";
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export type Voice = { id: string; model: string; config: string; sampleRate: number; language: string };
type SpeechSettings = { voice: string; speechEnabled: boolean; quiet: boolean };
type SpeechState = { state: 'idle' | 'preparing' | 'speaking' | 'error'; backend: string; voice: string; error: string; fallback: string };

export function validateVoice(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Choose a Piper voice name, without a path or extension');
  return value;
}

export function voiceDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.CERE_VOICES_DIR) return [resolve(env.CERE_VOICES_DIR)];
  return [join(paths().config, 'voices'), join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'piper/voices'),
    join(root, 'voices'), join(root, 'tts/voices'), join(root, 'build/tts/voices')];
}

export async function resolveVoice(id: string, directories = voiceDirectories()): Promise<Voice> {
  validateVoice(id);
  for (const directory of directories) {
    const model = join(directory, id + '.onnx');
    try { if (!(await stat(model)).isFile()) continue; }
    catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
    // A broken override is an actionable error, not permission to use a different voice.
    let config = model + '.json';
    try { await access(config); } catch { config = join(directory, id + '.json'); }
    let metadata: any;
    try {
      if ((await stat(config)).size > 1024 * 1024) throw new Error('oversized configuration');
      metadata = JSON.parse(await readFile(config, 'utf8'));
    } catch { throw new Error(`Voice ${id} needs a valid .onnx.json or .json companion file in ${directory}`); }
    const sampleRate = metadata.audio?.sample_rate;
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error(`Voice ${id} has an invalid audio.sample_rate`);
    const language = typeof metadata.language?.code === 'string' && /^[a-zA-Z_-]{2,32}$/.test(metadata.language.code) ? metadata.language.code : 'en_US';
    return { id, model, config, sampleRate, language };
  }
  throw new Error(`Piper voice ${id} was not found. Add its .onnx and .onnx.json files to ${directories[0]}`);
}

export async function listVoices(directories = voiceDirectories()): Promise<Voice[]> {
  const names = new Set<string>();
  for (const directory of directories) {
    for (const name of await readdir(directory).catch(() => [])) if (name.endsWith('.onnx')) names.add(name.slice(0, -5));
  }
  const voices: Voice[] = [];
  for (const name of [...names].sort()) {
    try { voices.push(await resolveVoice(name, directories)); } catch { /* Incomplete drops are not selectable. */ }
  }
  return voices;
}

/** Read prose, not fenced code, markdown syntax, or link destinations. Bound playback. */
export function speechText(text: string): string {
  const prose: string[] = [];
  let fence = '', size = 0;
  // Scan fences once. Greedy fence/link regexes on malformed model output can
  // otherwise spend seconds backtracking on the broker's response thread.
  for (const line of text.slice(0, 100000).split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      continue;
    }
    if (!fence) { prose.push(line); size += line.length + 1; if (size >= 16000) break; }
  }
  return prose.join('\n').slice(0, 16000)
    .replace(/!\[[^\]]{0,512}\]\([^\n)]{0,2048}\)/g, ' ')
    .replace(/\[([^\]]{1,512})\]\([^\n)]{0,2048}\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]{1,512}>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[`*_~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
}

type ChildResult = { code: number | null; stdout: string; timedOut: boolean };
/** Own every subprocess; a stopped utterance cannot leave Piper/aplay running. */
function child(command: string, args: string[], options: {
  env: NodeJS.ProcessEnv; signal: AbortSignal; input?: string; timeout: number; line?: (line: string) => void;
}): Promise<ChildResult> {
  options.signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const proc = spawn(command, args, { env: options.env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '', pending = '', timedOut = false, killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      proc.kill('SIGTERM');
      killTimer ||= setTimeout(() => proc.kill('SIGKILL'), 750);
      killTimer.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, options.timeout);
    timeout.unref();
    options.signal.addEventListener('abort', terminate, { once: true });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (data: string) => {
      stdout = (stdout + data).slice(-16384);
      pending += data;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) { options.line?.(pending.slice(0, end)); pending = pending.slice(end + 1); }
      pending = pending.slice(-16384);
    });
    // Broken pipes are expected if a dependency exits before reading its input.
    proc.stdin.on('error', () => {});
    proc.stdin.end(options.input || '');
    let spawnError: Error | undefined;
    proc.on('error', error => { spawnError = error; });
    proc.on('close', code => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener('abort', terminate);
      if (options.signal.aborted) reject(options.signal.reason);
      else if (spawnError) reject(new Error(`Could not start ${command}: ${spawnError.message}`));
      else resolveResult({ code, stdout, timedOut });
    });
  });
}

export async function piperExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.CERE_PIPER_BIN) return env.CERE_PIPER_BIN;
  for (const path of [join(root, 'tts/piper/piper'), join(root, 'build/tts/piper/piper')]) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try installed Piper. */ }
  }
  return 'piper';
}

/** A shell-free equivalent of piper --output_raw | aplay. */
export async function playPiper(text: string, voice: Voice, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const executable = await piperExecutable(env);
  signal.throwIfAborted();
  await new Promise<void>((done, reject) => {
    const synth = spawn(executable, ['--model', voice.model, '--config', voice.config, '--output_raw'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const player = spawn(env.CERE_APLAY_BIN || 'aplay', ['-q', '-t', 'raw', '-r', String(voice.sampleRate), '-f', 'S16_LE', '-c', '1'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    let remaining = 2, failure: Error | undefined, bytes = 0, killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      synth.kill('SIGTERM'); player.kill('SIGTERM');
      killTimer ||= setTimeout(() => { synth.kill('SIGKILL'); player.kill('SIGKILL'); }, 750);
      killTimer.unref();
    };
    const fail = (error: Error) => { failure ||= error; terminate(); };
    const timeout = setTimeout(() => fail(new Error('Piper playback timed out')), 15 * 60 * 1000); timeout.unref();
    signal.addEventListener('abort', terminate, { once: true });
    synth.stdout.on('data', data => { bytes += data.length; });
    synth.stdout.pipe(player.stdin);
    synth.stdin.on('error', () => {});
    player.stdin.on('error', () => fail(new Error('Audio output closed before Piper finished')));
    for (const [proc, name] of [[synth, 'Piper'], [player, 'aplay']] as const) {
      proc.on('error', () => fail(new Error(`${name} is unavailable. Reinstall Cere or its audio dependencies.`)));
      proc.on('close', code => {
        if (code !== 0 && !signal.aborted) fail(new Error(`${name} failed (exit ${code}). Check the voice files and default audio output.`));
        if (--remaining) return;
        clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', terminate);
        if (signal.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (!bytes) reject(new Error('Piper produced no audio'));
        else done();
      });
    }
    synth.stdin.end(text + '\n');
  });
}

export class Speech {
  state: SpeechState = { state: 'idle', backend: '', voice: defaultVoice, error: '', fallback: '' };
  queue: { text: string; voice: string }[] = [];
  private controller?: AbortController;
  private running?: Promise<void>;
  private closed = false;
  private settings: () => SpeechSettings;
  private changed: () => void;
  private env: NodeJS.ProcessEnv;
  constructor(settings: () => SpeechSettings, changed = () => {}, env: NodeJS.ProcessEnv = process.env) {
    this.settings = settings; this.changed = changed; this.env = env;
  }
  snapshot() { return { ...this.state, queued: this.queue.length }; }
  private update(patch: Partial<SpeechState>) { this.state = { ...this.state, ...patch }; this.changed(); }
  speak(text: string, test = false): boolean {
    const settings = this.settings();
    if (this.closed || this.env.CERE_TTS_DISABLED === '1' || !test && (!settings.speechEnabled || settings.quiet)) return false;
    text = speechText(text); if (!text) return false;
    if (test) this.stop();
    if (this.queue.length >= 3) this.queue.shift();
    this.queue.push({ text, voice: settings.voice });
    this.pump();
    return true;
  }
  private pump() {
    if (this.running || !this.queue.length || this.closed) return;
    this.running = this.run().finally(() => { this.running = undefined; this.pump(); });
  }
  private async run() {
    const item = this.queue.shift()!, controller = this.controller = new AbortController();
    this.update({ state: 'preparing', voice: item.voice, backend: '', error: '', fallback: '' });
    try {
      const voice = await resolveVoice(item.voice, voiceDirectories(this.env));
      controller.signal.throwIfAborted();
      let accepted = false, fallback = '';
      const connect = new AbortController();
      const timeout = setTimeout(() => connect.abort(new Error('Speech Dispatcher did not connect')), 3000); timeout.unref();
      try {
        const result = await child(this.env.CERE_TTS_PYTHON || 'python3', [join(root, 'broker/speechd-client.py')], {
          env: this.env, signal: AbortSignal.any([controller.signal, connect.signal]), timeout: 15 * 60 * 1000,
          input: JSON.stringify({ text: item.text, voice: voice.id }),
          line: line => {
            if (line === 'accepted') { accepted = true; clearTimeout(timeout); this.update({ state: 'speaking', backend: 'speech-dispatcher' }); }
          },
        });
        if (result.code !== 0 || !accepted) throw new Error(result.timedOut ? 'Speech Dispatcher playback timed out' : 'Speech Dispatcher or its Cere Piper module is unavailable');
      } catch (error: any) {
        controller.signal.throwIfAborted();
        // Never replay an utterance that the dispatcher already accepted.
        if (accepted) throw error;
        fallback = error.message;
      } finally { clearTimeout(timeout); }
      if (fallback) {
        this.update({ state: 'speaking', backend: 'piper', fallback });
        await playPiper(item.text, voice, controller.signal, this.env);
      }
      this.update({ state: 'idle' });
    } catch (error: any) {
      this.update(controller.signal.aborted ? { state: 'idle' } : { state: 'error', error: error.message || 'Speech playback failed' });
    } finally { this.controller = undefined; }
  }
  stop() { this.queue = []; this.controller?.abort(new Error('Speech stopped')); if (!this.running) this.update({ state: 'idle' }); }
  async idle() { while (this.running) await this.running; }
  async close() { this.closed = true; this.stop(); await this.idle(); }
}
