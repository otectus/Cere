import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transcription } from '../broker/transcription.ts';
import { Speech, defaultVoice } from '../broker/tts.ts';

async function fixture(t: test.TestContext, maximumMilliseconds = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-transcription-'));
  const runtime = join(directory, 'runtime'), log = join(directory, 'calls.jsonl'); await mkdir(runtime);
  const executable = async (name: string, source: string) => {
    const path = join(directory, name); await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 }); return path;
  };
  const recorder = await executable('recorder.mjs', `
    import {appendFileSync,writeFileSync} from 'node:fs';
    const output=process.argv.at(-1);appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'recorder',output})+'\\n');
    writeFileSync(output,Buffer.alloc(256,7));
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>process.exit(0));
    setInterval(()=>{},1000);`);
  const whisper = await executable('whisper-cli.mjs', `
    import {appendFileSync,writeFileSync} from 'node:fs';
    const args=process.argv.slice(2),prefix=args[args.indexOf('--output-file')+1];
    appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'whisper',args,pid:process.pid})+'\\n');
    if(process.env.TRANSCRIPTION_FAIL){console.error('fixture engine failure');process.exit(9)}
    if(process.env.TRANSCRIPTION_HOLD){for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>process.exit(0));setInterval(()=>{},1000)}
    else writeFileSync(prefix+'.txt',process.env.TRANSCRIPTION_TEXT||'Local transcript');`);
  const model = join(directory, 'model.bin'); await writeFile(model, 'fixture model');
  const settings = { executable: whisper, model }, env = { ...process.env };
  let changes = 0;
  const transcription = new Transcription({
    changed: () => { changes++; }, settings: () => settings, runtimeDirectory: runtime, env, maximumMilliseconds,
    recorder: output => ({ command: recorder, args: [output] }),
  });
  t.after(async () => { await transcription.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const temporary = async () => readdir(join(runtime, 'transcription')).catch(() => []);
  return { directory, runtime, log, recorder, whisper, model, settings, env, transcription, calls, temporary, get changes() { return changes; } };
}

async function until(predicate: () => Promise<boolean> | boolean) {
  for (let index = 0; index < 100; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for transcription fixture');
}

test('voice input has one explicit microphone owner and returns a session-bound editable result', async t => {
  const f = await fixture(t);
  const started = await f.transcription.start({ sessionId: 'session-a' });
  assert.equal(started.state, 'recording'); assert.equal(started.sessionId, 'session-a');
  await assert.rejects(f.transcription.start({ sessionId: 'session-b' }), /already recording/);
  await until(async () => (await f.calls()).some(call => call.tool === 'recorder'));
  const result = await f.transcription.finish();
  assert.deepEqual(result, { sessionId: 'session-a', revision: started.revision, text: 'Local transcript' });
  assert.equal(f.transcription.status().state, 'idle');
  assert.deepEqual(await f.temporary(), []);
  const calls = await f.calls(); assert.equal(calls.filter(call => call.tool === 'recorder').length, 1); assert.equal(calls.filter(call => call.tool === 'whisper').length, 1);
});

test('cancel deletes owned audio and never starts transcription', async t => {
  const f = await fixture(t);
  await f.transcription.start({ sessionId: 'session-a' });
  await f.transcription.cancel();
  assert.equal(f.transcription.status().state, 'idle');
  assert.deepEqual(await f.temporary(), []);
  assert.equal((await f.calls()).some(call => call.tool === 'whisper'), false);
});

test('missing configuration and failed local engines are visible and leave no recording', async t => {
  const f = await fixture(t);
  f.settings.executable = '';
  await assert.rejects(f.transcription.start({ sessionId: 'session-a' }), /absolute local whisper.cpp executable/);
  assert.equal(f.transcription.status().state, 'unavailable');
  f.settings.executable = f.whisper; f.env.TRANSCRIPTION_FAIL = '1';
  await f.transcription.start({ sessionId: 'session-a' });
  await until(async () => (await f.calls()).some(call => call.tool === 'recorder'));
  await assert.rejects(f.transcription.finish(), /fixture engine failure/);
  assert.equal(f.transcription.status().state, 'error'); assert.match(f.transcription.status().error, /fixture engine failure/);
  assert.deepEqual(await f.temporary(), []);
});

test('cancelled transcription results stay stale and cannot replace a later recording', async t => {
  const f = await fixture(t); f.env.TRANSCRIPTION_HOLD = '1';
  const first = await f.transcription.start({ sessionId: 'old-session' });
  await until(async () => (await f.calls()).some(call => call.tool === 'recorder'));
  const stale = f.transcription.finish();
  await until(async () => (await f.calls()).some(call => call.tool === 'whisper'));
  await f.transcription.cancel();
  await assert.rejects(stale, /cancelled/);
  delete f.env.TRANSCRIPTION_HOLD; f.env.TRANSCRIPTION_TEXT = 'Fresh transcript';
  const second = await f.transcription.start({ sessionId: 'new-session' });
  await until(async () => (await f.calls()).filter(call => call.tool === 'recorder').length === 2);
  const result = await f.transcription.finish();
  assert.equal(result.sessionId, 'new-session'); assert.equal(result.text, 'Fresh transcript'); assert.ok(second.revision > first.revision);
  assert.equal(f.transcription.status().state, 'idle'); assert.deepEqual(await f.temporary(), []);
});

test('the recording limit stops and removes a capture without invoking whisper.cpp', async t => {
  const f = await fixture(t, 25);
  await f.transcription.start({ sessionId: 'bounded' });
  await until(() => f.transcription.status().state === 'error');
  assert.match(f.transcription.status().error, /60-second recording limit/);
  assert.deepEqual(await f.temporary(), []);
  assert.equal((await f.calls()).some(call => call.tool === 'whisper'), false);
});

test('non-default speech rate uses Piper length_scale without changing default playback', async t => {
  const f = await fixture(t), voices = join(f.directory, 'voices'); await mkdir(voices);
  await writeFile(join(voices, defaultVoice + '.onnx'), 'voice');
  await writeFile(join(voices, defaultVoice + '.onnx.json'), JSON.stringify({ audio: { sample_rate: 16000 }, language: { code: 'en_US' } }));
  const piper = join(f.directory, 'rate-piper.mjs'), aplay = join(f.directory, 'rate-aplay.mjs');
  await writeFile(piper, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(f.log)},JSON.stringify({tool:'rate-piper',args:process.argv.slice(2)})+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(128)));`, { mode: 0o755 });
  await writeFile(aplay, `#!${process.execPath}\nprocess.stdin.resume();`, { mode: 0o755 });
  const settings = { voice: defaultVoice, speechEnabled: true, quiet: false, speechRate: 2 };
  const speech = new Speech(() => settings, () => {}, { ...process.env, CERE_TTS_DISABLED: '0', CERE_VOICES_DIR: voices, CERE_PIPER_BIN: piper, CERE_APLAY_BIN: aplay });
  t.after(() => speech.close());
  assert.equal(speech.speak('Faster local speech'), true); await speech.idle();
  const args = (await f.calls()).find(call => call.tool === 'rate-piper').args;
  assert.equal(args[args.indexOf('--length_scale') + 1], '0.5'); assert.equal(speech.state.backend, 'piper');
});
