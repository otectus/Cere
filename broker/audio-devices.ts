/**
 * M10: microphone and speaker selection. Devices come from PipeWire (pw-dump) or, without it, from
 * ALSA's device lists. A device is named by an ID that says how to reach it: "pw:<node name>" for a
 * PipeWire node, "alsa:<PCM>" for an ALSA device; an empty choice is the system default. A chosen
 * device that is missing fails visibly before any recorder or player starts: PipeWire would otherwise
 * quietly fall back to the default device. Speech Dispatcher cannot be pointed at a device, so speech
 * uses Cere's own player while a speaker is chosen.
 */
import { execFile } from 'node:child_process';

export type AudioDevice = { id: string; label: string; isDefault: boolean; state: string };
export type AudioInventory = { backend: 'pipewire' | 'alsa' | 'none'; inputs: AudioDevice[]; outputs: AudioDevice[]; error?: string };
export type AudioRunner = (command: string, args: string[]) => Promise<string>;
const execRun: AudioRunner = (command, args) => new Promise((resolve, reject) =>
  execFile(command, args, { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));

/** A device ID Cere accepts: no characters that could reach a shell or break an ALSA argument. */
export const deviceId = (value: unknown): string => {
  if (value === '' || value === undefined) return '';
  if (typeof value !== 'string' || !/^(pw:[A-Za-z0-9_.:@+-]{1,200}|alsa:[A-Za-z0-9_.:=,@+-]{1,200})$/.test(value)) throw new Error('Choose an audio device from the list');
  return value;
};

/** PipeWire nodes from pw-dump: sources are inputs, sinks are outputs, with the session defaults. */
export function parsePipeWire(json: string): AudioInventory {
  const objects = JSON.parse(json);
  if (!Array.isArray(objects)) throw new Error('Unexpected pw-dump output');
  const defaults: Record<string, string> = {};
  for (const object of objects) if (object?.type === 'PipeWire:Interface:Metadata' && object.props?.['metadata.name'] === 'default')
    for (const entry of object.metadata || []) if (entry?.key === 'default.audio.sink' || entry?.key === 'default.audio.source') defaults[entry.key] = String(entry.value?.name || '');
  const inputs: AudioDevice[] = [], outputs: AudioDevice[] = [];
  for (const object of objects) {
    const props = object?.type === 'PipeWire:Interface:Node' ? object.info?.props : undefined, kind = props?.['media.class'];
    if (kind !== 'Audio/Source' && kind !== 'Audio/Sink') continue;
    const name = String(props['node.name'] || '');
    if (!/^[A-Za-z0-9_.:@+-]{1,200}$/.test(name)) continue;
    const device = { id: 'pw:' + name, label: String(props['node.description'] || props['node.nick'] || name).slice(0, 200), state: String(object.info?.state || ''),
      isDefault: name === defaults[kind === 'Audio/Sink' ? 'default.audio.sink' : 'default.audio.source'] };
    (kind === 'Audio/Sink' ? outputs : inputs).push(device);
  }
  const order = (a: AudioDevice, b: AudioDevice) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label);
  return { backend: 'pipewire', inputs: inputs.sort(order), outputs: outputs.sort(order) };
}
/** ALSA device lists (aplay -L, arecord -L): hardware and default devices, not converter plugins. */
export function parseAlsa(playback: string, capture: string): AudioInventory {
  const parse = (text: string) => {
    const devices: AudioDevice[] = [];
    let current: AudioDevice | undefined;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) {
        const name = line.trim();
        current = /^(default|sysdefault|plughw|hw|front|pipewire|pulse)(:|$)/.test(name) && /^[A-Za-z0-9_.:=,@+-]{1,200}$/.test(name) ? { id: 'alsa:' + name, label: name, isDefault: name === 'default', state: '' } : undefined;
        if (current) devices.push(current);
      } else if (current && current.label === current.id.slice(5)) current.label = `${line.trim()} (${current.id.slice(5)})`.slice(0, 200);
    }
    return devices;
  };
  return { backend: 'alsa', inputs: parse(capture), outputs: parse(playback) };
}

let runner: AudioRunner = execRun, selection = { input: '', output: '' }, cache: { at: number; value: AudioInventory } | undefined;
/** Tests replace the commands that list devices. */
export function useAudioRunner(run: AudioRunner) { runner = run; cache = undefined; }
export function selectAudio(audio: { input: string; output: string }) { selection = { input: audio.input || '', output: audio.output || '' }; cache = undefined; }
export const audioSelection = () => ({ ...selection });

/** The devices now, from PipeWire if it answers, else ALSA; a few seconds of caching for repeated checks. */
export async function listAudioDevices(maxAgeMs = 0): Promise<AudioInventory> {
  if (cache && Date.now() - cache.at <= maxAgeMs) return cache.value;
  let value: AudioInventory;
  try { value = parsePipeWire(await runner('pw-dump', [])); }
  catch (pipewire: any) {
    try { value = parseAlsa(await runner('aplay', ['-L']), await runner('arecord', ['-L'])); }
    catch { value = { backend: 'none', inputs: [], outputs: [], error: 'Neither PipeWire nor ALSA listed any audio devices' + (pipewire?.message ? `: ${String(pipewire.message).slice(0, 200)}` : '') }; }
  }
  cache = { at: Date.now(), value };
  return value;
}
/** The chosen device for this direction, checked to be present now; '' is the system default. */
export async function chosenDevice(kind: 'input' | 'output'): Promise<string> {
  const id = selection[kind];
  if (!id) return '';
  const devices = await listAudioDevices(3000), found = (kind === 'input' ? devices.inputs : devices.outputs).some(device => device.id === id);
  if (!found) throw new Error(`The chosen ${kind === 'input' ? 'microphone' : 'speaker'} (${id.replace(/^(pw|alsa):/, '')}) is not connected. Choose another in Settings › Voice, or the system default.`);
  return id;
}
/** aplay arguments that send playback to a device. */
export function playbackArgs(id: string): string[] {
  if (!id) return [];
  return ['-D', id.startsWith('pw:') ? `pipewire:NODE=${id.slice(3)}` : id.slice(5)];
}
/** A recorder for a device: pw-record targets a PipeWire node; arecord takes an ALSA device. */
export function recorderArgs(tool: 'pw-record' | 'arecord', id: string): string[] {
  if (!id) return [];
  if (tool === 'pw-record') return id.startsWith('pw:') ? [`--target=${id.slice(3)}`] : [];
  return ['-D', id.startsWith('pw:') ? `pipewire:NODE=${id.slice(3)}` : id.slice(5)];
}
