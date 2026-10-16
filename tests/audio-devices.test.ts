import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chosenDevice, listAudioDevices, parseAlsa, parsePipeWire, playbackArgs, recorderArgs, selectAudio, useAudioRunner } from '../broker/audio-devices.ts';
import { defaultRecorder } from '../broker/transcription.ts';
import { Speech } from '../broker/tts.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { defaultSettings } from '../broker/types.ts';

// Shaped like real pw-dump output: nodes with media classes, plus the session's default metadata.
const node = (serial: number, kind: string, name: string, description: string, state = 'suspended') => ({ id: serial, type: 'PipeWire:Interface:Node', info: { state, props: { 'media.class': kind, 'node.name': name, 'node.description': description, 'object.serial': serial } } });
const pwDump = JSON.stringify([
  node(61, 'Audio/Sink', 'alsa_output.usb-Headset-00.analog-stereo', 'Headset Analog Stereo'),
  node(62, 'Audio/Source', 'alsa_input.usb-Headset-00.mono-fallback', 'Headset Mono', 'running'),
  node(68, 'Audio/Sink', 'alsa_output.pci-0000_00_1f.3.HiFi__Speaker__sink', 'Built-in Speaker'),
  node(69, 'Audio/Source', 'alsa_input.pci-0000_00_1f.3.HiFi__Mic1__source', 'Built-in Microphone'),
  node(70, 'Video/Source', 'v4l2_input.camera', 'Camera'),
  node(71, 'Audio/Sink', 'bad name; rm -rf /', 'Hostile name'),
  { id: 40, type: 'PipeWire:Interface:Metadata', props: { 'metadata.name': 'default' }, metadata: [
    { subject: 0, key: 'default.audio.sink', value: { name: 'alsa_output.usb-Headset-00.analog-stereo' } },
    { subject: 0, key: 'default.audio.source', value: { name: 'alsa_input.pci-0000_00_1f.3.HiFi__Mic1__source' } }] },
]);
const aplayL = 'null\n    Discard all samples\ndefault\n    Default ALSA Output\nlavrate\n    Rate Converter\nhw:CARD=PCH,DEV=0\n    HDA Intel PCH, ALC3246 Analog\n    Direct hardware device\nplughw:CARD=PCH,DEV=0\n    HDA Intel PCH, ALC3246 Analog\n';

test('M10 devices come from PipeWire, or ALSA without it; IDs say how to reach them and refuse hostile names', async t => {
  const pipewire = parsePipeWire(pwDump);
  assert.deepEqual(pipewire.outputs.map(device => [device.id, device.isDefault]), [['pw:alsa_output.usb-Headset-00.analog-stereo', true], ['pw:alsa_output.pci-0000_00_1f.3.HiFi__Speaker__sink', false]]);
  assert.deepEqual(pipewire.inputs.map(device => [device.label, device.isDefault, device.state]), [['Built-in Microphone', true, 'suspended'], ['Headset Mono', false, 'running']]);
  const alsa = parseAlsa(aplayL, aplayL);
  assert.deepEqual(alsa.outputs.map(device => [device.id, device.label]), [['alsa:default', 'Default ALSA Output (default)'], ['alsa:hw:CARD=PCH,DEV=0', 'HDA Intel PCH, ALC3246 Analog (hw:CARD=PCH,DEV=0)'], ['alsa:plughw:CARD=PCH,DEV=0', 'HDA Intel PCH, ALC3246 Analog (plughw:CARD=PCH,DEV=0)']]);
  t.after(() => { useAudioRunner(async () => { throw new Error('reset'); }); selectAudio({ input: '', output: '' }); });
  useAudioRunner(async command => { if (command === 'pw-dump') throw new Error('pw-dump: not found'); return aplayL; });
  assert.equal((await listAudioDevices()).backend, 'alsa');
  useAudioRunner(async () => { throw new Error('nothing'); });
  const none = await listAudioDevices();
  assert.deepEqual([none.backend, none.inputs.length], ['none', 0]); assert.match(none.error!, /Neither PipeWire nor ALSA/);
  assert.deepEqual(playbackArgs('pw:alsa_output.usb-Headset-00.analog-stereo'), ['-D', 'pipewire:NODE=alsa_output.usb-Headset-00.analog-stereo']);
  assert.deepEqual(playbackArgs('alsa:plughw:CARD=PCH,DEV=0'), ['-D', 'plughw:CARD=PCH,DEV=0']);
  assert.deepEqual(playbackArgs(''), []);
  assert.deepEqual(recorderArgs('pw-record', 'pw:alsa_input.usb-Headset-00.mono-fallback'), ['--target=alsa_input.usb-Headset-00.mono-fallback']);
  assert.deepEqual(recorderArgs('arecord', 'pw:alsa_input.usb-Headset-00.mono-fallback'), ['-D', 'pipewire:NODE=alsa_input.usb-Headset-00.mono-fallback']);
});

test('M10 a chosen device that is missing fails visibly before any recorder or player starts', async t => {
  t.after(() => { useAudioRunner(async () => { throw new Error('reset'); }); selectAudio({ input: '', output: '' }); });
  let listed = pwDump;
  useAudioRunner(async () => listed);
  selectAudio({ input: 'pw:alsa_input.usb-Headset-00.mono-fallback', output: 'pw:alsa_output.usb-Headset-00.analog-stereo' });
  assert.equal(await chosenDevice('input'), 'pw:alsa_input.usb-Headset-00.mono-fallback');
  // The headset is unplugged.
  listed = JSON.stringify(JSON.parse(pwDump).filter((object: any) => !String(object.info?.props?.['node.name'] || '').includes('Headset')));
  selectAudio({ input: 'pw:alsa_input.usb-Headset-00.mono-fallback', output: 'pw:alsa_output.usb-Headset-00.analog-stereo' });
  await assert.rejects(defaultRecorder('/tmp/never-written.wav'), /chosen microphone \(alsa_input\.usb-Headset-00\.mono-fallback\) is not connected/);
  // Speech reports the missing speaker instead of playing elsewhere; nothing is spawned for it.
  const states: any[] = [];
  const speech = new Speech(() => ({ ...defaultSettings, speechEnabled: true }), () => states.push(speech.snapshot()), { PATH: '/nonexistent' } as any);
  assert.equal(speech.speak('Hello there', true), true);
  await speech.idle();
  assert.equal(speech.snapshot().state, 'error');
  assert.match(speech.snapshot().error, /chosen speaker \(alsa_output\.usb-Headset-00\.analog-stereo\) is not connected/);
  await speech.close();
  // With no choice, the system default is used and nothing is checked.
  selectAudio({ input: '', output: '' });
  assert.equal(await chosenDevice('output'), '');
});

test('M10 device settings accept only listed-style IDs, and a new speaker stops speech without replaying it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-audio-'));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); selectAudio({ input: '', output: '' }); });
  for (const value of ['hw:0', 'pw:name; rm -rf /', 'alsa:$(id)', 'pw:'] as string[]) await assert.rejects(core.updateSettings({ audio: { input: value } }), /Choose an audio device from the list/, value);
  await assert.rejects(core.updateSettings({ audio: { speaker: 'x' } }), /Invalid audio device settings/);
  let stopped = 0; const stop = core.speech.stop.bind(core.speech); core.speech.stop = () => { stopped++; stop(); };
  await core.updateSettings({ audio: { input: 'pw:alsa_input.usb-Headset-00.mono-fallback' } });
  assert.equal(stopped, 0, 'a new microphone does not touch speech');
  await core.updateSettings({ audio: { output: 'alsa:plughw:CARD=PCH,DEV=0' } });
  assert.equal(stopped, 1);
  assert.deepEqual(core.settings.audio, { input: 'pw:alsa_input.usb-Headset-00.mono-fallback', output: 'alsa:plughw:CARD=PCH,DEV=0' });
  const restarted = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(() => restarted.close());
  assert.deepEqual(restarted.settings.audio, core.settings.audio, 'the choice is kept across restarts');
});
