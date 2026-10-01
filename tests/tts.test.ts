import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Speech, defaultVoice, listVoices, resolveVoice, speechText, validateVoice, ttsTestLine, playPiper } from '../broker/tts.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { defaultSettings } from '../broker/types.ts';
import type { Hooks } from '../broker/providers.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp } from 'node:fs/promises';

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-tts-'));
  const voices = join(directory, 'voices'); await mkdir(voices);
  const addVoice = async (id: string, rate = 22050, short = false) => {
    await writeFile(join(voices, id + '.onnx'), 'fixture model');
    await writeFile(join(voices, id + (short ? '.json' : '.onnx.json')), JSON.stringify({ audio: { sample_rate: rate }, language: { code: 'en_US' } }));
  };
  await addVoice(defaultVoice);
  const calls = join(directory, 'calls.jsonl');
  const executable = async (name: string, source: string) => {
    const path = join(directory, name);
    await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 }); return path;
  };
  const logger = `import {appendFileSync} from 'node:fs'; const log = data => appendFileSync(${JSON.stringify(calls)}, JSON.stringify(data)+'\\n');`;
  const piper = await executable('piper.mjs', `${logger}
    let text='';for await(const chunk of process.stdin)text+=chunk;
    log({tool:'piper',args:process.argv.slice(2),text,pid:process.pid});
    if(process.env.TTS_HOLD){process.on('SIGTERM',()=>{log({tool:'piper-stopped'});process.exit(0)});setInterval(()=>{},1000);}
    else process.stdout.write(Buffer.alloc(4400,12));`);
  const aplay = await executable('aplay.mjs', `${logger}
    log({tool:'aplay-start',args:process.argv.slice(2),pid:process.pid});
    process.on('SIGTERM',()=>{log({tool:'aplay-stopped'});process.exit(0)});
    let bytes=0;for await(const chunk of process.stdin)bytes+=chunk.length;log({tool:'aplay',bytes});`);
  const dispatcher = await executable('speechd.mjs', `${logger}
    let input='';for await(const chunk of process.stdin)input+=chunk;
    log({tool:'speechd',request:JSON.parse(input)});
    if(process.env.TTS_DISPATCHER==='ok')console.log('accepted');
    else if(process.env.TTS_DISPATCHER==='hang')setInterval(()=>{},1000);
    else if(process.env.TTS_DISPATCHER==='accepted-error'){console.log('accepted');process.exitCode=1;}
    else process.exitCode=69;`);
  const sox = await executable('sox.mjs', `${logger}
    log({tool:'sox',args:process.argv.slice(2)});
    process.on('SIGTERM',()=>{log({tool:'sox-stopped'});process.exit(0)});
    process.stdin.pipe(process.stdout);`);
  const settings = { ...defaultSettings };
  const env: NodeJS.ProcessEnv = { ...process.env, CERE_TTS_DISABLED: '0', CERE_VOICES_DIR: voices, CERE_PIPER_BIN: piper, CERE_APLAY_BIN: aplay, CERE_TTS_PYTHON: dispatcher, CERE_SOX_BIN: sox };
  const speech = new Speech(() => settings, () => {}, env);
  t.after(async () => { await speech.close(); await rm(directory, { recursive: true, force: true }); });
  const logs = async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, voices, addVoice, executable, settings, env, speech, logs };
}
async function until(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for speech fixture');
}

test('voice discovery accepts complete pairs, honors precedence and reads custom sample rates', async t => {
  const f = await fixture(t);
  await f.addVoice('custom', 16000, true);
  await writeFile(join(f.voices, 'incomplete.onnx'), 'model');
  await f.addVoice('broken'); await writeFile(join(f.voices, 'broken.onnx.json'), '{');
  assert.deepEqual((await listVoices([f.voices],null)).map(v => v.id), ['custom', defaultVoice]);
  assert.equal((await resolveVoice('custom', [f.voices])).sampleRate, 16000);
  for (const id of ['../escape', '--model', '/tmp/model', 'name.onnx', '$(touch BAD)', '', null]) assert.throws(() => validateVoice(id));
  await assert.rejects(resolveVoice('missing', [f.voices]), /not found/);
  await assert.rejects(resolveVoice('broken', [f.voices]), /companion file/);
  const override = join(f.directory, 'override'); await mkdir(override);
  await writeFile(join(override, defaultVoice + '.onnx'), 'override');
  await assert.rejects(resolveVoice(defaultVoice, [override, f.voices]), /companion file/);
});

test('Kokoro voices appear only for a complete absolute runtime manifest', async t => {
  const f=await fixture(t),install=join(f.directory,'kokoro');await mkdir(install);
  const runtime=await f.executable('kokoro-python',`process.stdout.write(Buffer.alloc(4800,7));`);
  const model=join(install,'kokoro.onnx'),voiceData=join(install,'voices.bin'),manifest=join(install,'manifest.json');
  await writeFile(model,'model');await writeFile(voiceData,'voices');
  await writeFile(manifest,JSON.stringify({version:1,python:runtime,model,voiceData,voices:['af_heart','af_bella']}));
  const voices=await listVoices([f.voices],manifest);
  assert.deepEqual(voices.map(v=>v.id),[defaultVoice,'kokoro-af_heart','kokoro-af_bella']);
  const heart=await resolveVoice('kokoro-af_heart',[f.voices],manifest);
  assert.equal(heart.backend,'kokoro');assert.equal(heart.nativeVoice,'af_heart');assert.equal(heart.sampleRate,24000);
  await writeFile(manifest,JSON.stringify({version:1,python:'relative',model,voiceData,voices:['af_heart']}));
  await assert.rejects(resolveVoice('kokoro-af_heart',[f.voices],manifest),/absolute path/);
  assert.deepEqual((await listVoices([f.voices],manifest)).map(v=>v.id),[defaultVoice]);
});

test('speech prose omits code, URLs and markup without changing shell-like text into commands', () => {
  assert.equal(speechText('# Hello\n**friend**. [Read here](https://example.org/a)\n```sh\nrm -rf /\n```\nBye.'), 'Hello friend. Read here Bye.');
  assert.equal(speechText('~~~js\nsecret();'), '');
  assert.equal(speechText('A'.repeat(20000)).length, 8000);
});

test('malformed markdown does not stall the response thread', () => {
  const started = performance.now();
  assert.equal(speechText('`'.repeat(50000)), '');
  assert.equal(speechText('['.repeat(50000)).length, 8000);
  assert.ok(performance.now() - started < 500, 'Speech cleanup must stay bounded on malformed markup');
});

test('dispatcher playback is asynchronous and uses the selected local voice exactly once', async t => {
  const f = await fixture(t); f.env.TTS_DISPATCHER = 'ok';
  assert.equal(f.speech.speak('Hello there'), true);
  assert.equal((await f.logs()).length, 0);
  await f.speech.idle();
  assert.deepEqual(await f.logs(), [{ tool: 'speechd', request: { text: 'Hello there', voice: defaultVoice } }]);
  assert.equal(f.speech.state.backend, 'speech-dispatcher'); assert.equal(f.speech.state.state, 'idle');
});

test('unavailable dispatcher falls back to raw Piper PCM with safe arguments and voice sample rate', async t => {
  const f = await fixture(t); await f.addVoice('custom', 16000, true); f.settings.voice = 'custom';
  const text = "Leading --flag; $(touch /tmp/cere-tts-should-never-exist) 'quoted' & end";
  f.speech.speak(text); await f.speech.idle();
  const logs = await f.logs(), synth = logs.find(l => l.tool === 'piper'), player = logs.find(l => l.tool === 'aplay-start');
  assert.equal(synth.text, text + '\n');
  assert.deepEqual(synth.args, ['--model', join(f.voices, 'custom.onnx'), '--config', join(f.voices, 'custom.json'), '--output_raw']);
  assert.deepEqual(player.args, ['-q', '-t', 'raw', '-r', '16000', '-f', 'S16_LE', '-c', '1']);
  assert.equal(logs.find(l => l.tool === 'aplay').bytes, 4400);
  assert.equal(f.speech.state.backend, 'piper'); assert.equal(f.speech.state.error, '');
  assert.match(f.speech.state.fallback, /unavailable/);
});

test('selected Kokoro voice bypasses Dispatcher and Piper while preserving rate and owned playback', async t => {
  const f=await fixture(t),install=join(f.directory,'kokoro');await mkdir(install);
  const runtime=await f.executable('kokoro-python',`${`import {appendFileSync} from 'node:fs'; const log=data=>appendFileSync(${JSON.stringify(join(f.directory,'calls.jsonl'))},JSON.stringify(data)+'\\n');`}
    let input='';for await(const chunk of process.stdin)input+=chunk;log({tool:'kokoro',args:process.argv.slice(2),request:JSON.parse(input),pid:process.pid});
    if(process.env.KOKORO_HOLD){process.on('SIGTERM',()=>{log({tool:'kokoro-stopped'});process.exit(0)});setInterval(()=>{},1000)}else process.stdout.write(Buffer.alloc(4800,7));`);
  const model=join(install,'kokoro.onnx'),voiceData=join(install,'voices.bin'),manifest=join(install,'manifest.json');
  await writeFile(model,'model');await writeFile(voiceData,'voices');await writeFile(manifest,JSON.stringify({version:1,python:runtime,model,voiceData,voices:['af_heart']}));
  f.env.CERE_KOKORO_MANIFEST=manifest;f.settings.voice='kokoro-af_heart';f.settings.speechRate=.9;
  assert.equal(f.speech.speak('A warmer local voice.'),true);await f.speech.idle();
  const logs=await f.logs(),synth=logs.find(row=>row.tool==='kokoro'),player=logs.find(row=>row.tool==='aplay-start');
  assert.deepEqual(synth.request,{text:'A warmer local voice.'});assert.ok(synth.args.includes('af_heart'));assert.equal(synth.args.at(-1),'0.9');
  assert.deepEqual(player.args,['-q','-t','raw','-r','24000','-f','S16_LE','-c','1']);
  assert.equal(logs.find(row=>row.tool==='aplay').bytes,4800);assert.equal(logs.some(row=>['piper','speechd'].includes(row.tool)),false);
  assert.equal(f.speech.state.backend,'kokoro');assert.equal(f.speech.state.state,'idle');

  f.settings.speechPitch=1.5;f.settings.speechVolume=.65;
  f.speech.speak('Tuned Kokoro');await f.speech.idle();
  const effect=(await f.logs()).find(row=>row.tool==='sox');
  assert.deepEqual(effect.args.slice(-4),['pitch','150','vol','0.65']);
  assert.equal(effect.args[effect.args.indexOf('-r')+1],'24000');

  f.env.KOKORO_HOLD='1';f.speech.speak('Stop Kokoro');await until(async()=>(await f.logs()).filter(row=>row.tool==='kokoro').length===3);f.speech.stop();await f.speech.idle();
  assert.equal(f.speech.state.state,'idle');assert.ok((await f.logs()).some(row=>row.tool==='kokoro-stopped'));
});

test('missing Python falls back, but an accepted dispatcher message is never replayed', async t => {
  const f = await fixture(t); f.env.TTS_DISPATCHER = 'accepted-error';
  f.speech.speak('Only once'); await f.speech.idle();
  assert.equal(f.speech.state.state, 'error'); assert.equal((await f.logs()).length, 1);
  f.env.CERE_TTS_PYTHON = join(f.directory, 'missing');
  f.speech.speak('Fallback'); await f.speech.idle();
  assert.equal(f.speech.state.state, 'idle'); assert.equal(f.speech.state.backend, 'piper');
});

test('a stalled dispatcher times out and falls back without holding the response pipeline', async t => {
  const f = await fixture(t); f.env.TTS_DISPATCHER = 'hang';
  const started = Date.now(); assert.equal(f.speech.speak('Keep going'), true);
  assert.ok(Date.now() - started < 200);
  await f.speech.idle();
  assert.equal(f.speech.state.backend, 'piper'); assert.equal(f.speech.state.state, 'idle');
  assert.match(f.speech.state.fallback, /did not connect/);
});

test('Python speechd bridge selects local Piper and cancels only its own connection', async t => {
  const f = await fixture(t);
  const pythonCalls = join(f.directory, 'speechd-python.jsonl');
  await writeFile(join(f.directory, 'speechd.py'), `
import json, os
def log(*data):
    with open(${JSON.stringify(pythonCalls)}, 'a') as stream: stream.write(json.dumps(data)+'\\n')
class PunctuationMode: NONE='none'
class CallbackType: END='end'; CANCEL='cancel'
class SSIPClient:
    def __init__(self, name, component, address): log('connect',name,component,address)
    def set_output_module(self, value): log('module',value)
    def list_synthesis_voices(self): return [('en_US-amy-medium','en','FEMALE1')]
    def set_synthesis_voice(self, value): log('voice',value)
    def set_punctuation(self, value): pass
    def speak(self, text, callback):
        log('speak',text)
        if not os.environ.get('TTS_HOLD'): callback(CallbackType.END)
    def cancel(self, scope='self'): log('cancel',scope)
    def close(self): log('close')
`);
  f.env.CERE_TTS_PYTHON = 'python3'; f.env.PYTHONPATH = f.directory; f.env.SPEECHD_ADDRESS = 'unix:/tmp/cere-tts-fixture.sock';
  f.speech.speak('The bridge works'); await f.speech.idle();
  assert.equal(f.speech.state.backend, 'speech-dispatcher'); assert.equal(f.speech.state.state, 'idle');
  f.env.TTS_HOLD = '1'; f.speech.speak('Stop this');
  await until(async () => f.speech.state.state === 'speaking'); f.speech.stop(); await f.speech.idle();
  const calls = (await readFile(pythonCalls, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(calls.some(c => c[0] === 'connect' && c[3] === 'unix_socket:/tmp/cere-tts-fixture.sock'));
  assert.ok(calls.some(c => c[0] === 'module' && c[1] === 'cere-piper'));
  assert.ok(calls.filter(c => c[0] === 'cancel').length >= 2);
  assert.ok(calls.filter(c => c[0] === 'cancel').every(c => c[1] === 'self'));
  assert.equal((await f.logs()).length, 0);
  delete f.env.TTS_HOLD; f.env.SPEECHD_ADDRESS = 'inet_socket:example.org:6560';
  f.speech.speak('Keep this local'); await f.speech.idle(); assert.equal(f.speech.state.backend, 'piper');
});

test('missing Piper/audio devices report errors without rejecting the response or hanging', async t => {
  const f = await fixture(t); f.env.CERE_APLAY_BIN = join(f.directory, 'missing');
  assert.equal(f.speech.speak('No device'), true); await f.speech.idle();
  assert.equal(f.speech.state.state, 'error'); assert.match(f.speech.state.error, /aplay/);
  f.env.CERE_PIPER_BIN = join(f.directory, 'missing-piper');
  f.speech.speak('No runtime'); await f.speech.idle();
  assert.equal(f.speech.state.state, 'error');
});

test('quiet/disabled settings suppress automatic speech while explicit test is available', async t => {
  const f = await fixture(t); f.settings.quiet = true;
  assert.equal(f.speech.speak('Silent'), false);
  assert.equal(f.speech.speak('Pinned but quiet', false, 'pinned'), false);
  f.settings.quiet = false; f.settings.speechEnabled = false;
  assert.equal(f.speech.speak('Silent'), false);
  assert.equal(f.speech.speak('Pinned but muted', false, 'pinned'), false);
  assert.equal(f.speech.speak(ttsTestLine, true), true); await f.speech.idle();
  assert.equal((await f.logs()).filter(l => l.tool === 'piper').length, 1);
  f.env.CERE_TTS_DISABLED = '1'; assert.equal(f.speech.speak(ttsTestLine, true), false);
});

test('pinned speech survives ordinary queue eviction and cancellation is scoped to its conversation', async t => {
  const f = await fixture(t); f.env.TTS_HOLD = '1';
  f.speech.speak('Hold this conversation', false, 'first', 'first-reply');
  await until(async () => (await f.logs()).some(row => row.tool === 'piper'));
  assert.equal(f.speech.snapshot().replyId,'first-reply');
  for(let n=0;n<6;n++)f.speech.speak('Pinned '+n, false, 'second');
  for(let n=0;n<6;n++)f.speech.speak('Ordinary '+n);
  f.speech.speak('Cancel this queued reply', false, 'first');
  assert.equal(f.speech.queue.filter(item=>item.sessionId==='second').length,6);
  delete f.env.TTS_HOLD;
  f.speech.stopSession('first'); await f.speech.idle();
  const readings=(await f.logs()).filter(row=>row.tool==='piper').map(row=>row.text.trim());
  assert.deepEqual(readings,['Hold this conversation',...Array.from({length:6},(_,n)=>'Pinned '+n),'Ordinary 3','Ordinary 4','Ordinary 5']);
  assert.ok((await f.logs()).some(row=>row.tool==='piper-stopped'));
  assert.equal(f.speech.state.state,'idle');
  assert.equal(f.speech.snapshot().replyId,undefined);
});

test('stop kills the owned Piper/player, clears bounded backlog and allows the next utterance', async t => {
  const f = await fixture(t); f.env.TTS_HOLD = '1';
  f.speech.speak('Hold');
  await until(async () => (await f.logs()).some(l => l.tool === 'piper'));
  for (let i = 0; i < 6; i++) f.speech.speak('Queued ' + i);
  assert.equal(f.speech.queue.length, 3);
  assert.equal(f.speech.queue[0].text, 'Queued 3');
  f.speech.stop(); await f.speech.idle();
  assert.equal(f.speech.queue.length, 0); assert.equal(f.speech.state.state, 'idle');
  for (const call of (await f.logs()).filter(l => l.pid)) assert.throws(() => process.kill(call.pid, 0), /ESRCH/);
  delete f.env.TTS_HOLD;
  f.speech.speak('Next'); await f.speech.idle(); assert.equal(f.speech.state.state, 'idle');
});

test('tuned Piper bypasses dispatcher, snapshots each queued adjustment and reaps the filter on stop', async t => {
  const f=await fixture(t);f.env.TTS_DISPATCHER='ok';f.env.TTS_HOLD='1';
  f.settings.speechPitch=-2;f.settings.speechVolume=.8;f.settings.speechRate=1.25;
  f.speech.speak('Active tuned speech',false,'pinned');
  await until(async()=>{const logs=await f.logs();return ['sox','piper','aplay-start'].every(tool=>logs.some(row=>row.tool===tool));});
  let logs=await f.logs();
  assert.equal(logs.some(row=>row.tool==='speechd'),false);
  assert.deepEqual(logs.find(row=>row.tool==='sox').args.slice(-4),['pitch','-200','vol','0.8']);
  assert.ok(logs.find(row=>row.tool==='piper').args.includes('0.8'));
  f.settings.speechPitch=3;f.settings.speechVolume=.4;f.settings.speechRate=.9;
  f.speech.speak('Queued tuning',false,'other');
  f.settings.speechPitch=0;f.settings.speechVolume=1;f.settings.speechRate=1;
  assert.deepEqual([f.speech.queue[0].pitch,f.speech.queue[0].volume,f.speech.queue[0].rate],[3,.4,.9]);
  delete f.env.TTS_HOLD;
  f.speech.stopSession('pinned');await f.speech.idle();
  logs=await f.logs();
  assert.ok(logs.some(row=>row.tool==='sox-stopped'));
  assert.deepEqual(logs.filter(row=>row.tool==='sox').at(-1).args.slice(-4),['pitch','300','vol','0.4']);
  assert.equal(f.speech.state.state,'idle');
});

test('missing or failed tuning reports an error without silently playing an unadjusted voice', async t => {
  const f=await fixture(t);f.env.TTS_DISPATCHER='ok';f.settings.speechPitch=2;
  f.env.CERE_SOX_BIN=join(f.directory,'missing-sox');
  f.speech.speak('Missing tuning');await f.speech.idle();
  assert.equal(f.speech.state.state,'error');assert.match(f.speech.state.error,/SoX/);
  assert.equal((await f.logs()).some(row=>row.tool==='speechd'),false);
  f.env.CERE_SOX_BIN=await f.executable('broken-sox.mjs',"process.stderr.write('Fixture processing fault');process.exit(1)");
  f.speech.speak('Failed tuning');await f.speech.idle();
  assert.equal(f.speech.state.state,'error');
  assert.equal((await f.logs()).some(row=>row.tool==='speechd'),false);
  f.settings.speechPitch=0;
  f.speech.speak('Reset tuning');await f.speech.idle();assert.equal(f.speech.state.backend,'speech-dispatcher');
});

test('voice tuning settings migrate, validate atomically, persist and volume zero stops playback', async t => {
  const f=await fixture(t),core=new Core(new Store(join(f.directory,'tuning-state')));
  t.after(()=>core.close());
  core.store.set('settings',{voice:defaultVoice,speechRate:.9});
  assert.equal(core.store.settings().speechPitch,0);assert.equal(core.store.settings().speechVolume,1);
  await core.updateSettings({speechPitch:2.5,speechRate:1.1,speechVolume:.7});
  const saved=core.store.settings();assert.equal(saved.speechPitch,2.5);assert.equal(saved.speechRate,1.1);assert.equal(saved.speechVolume,.7);
  for(const [key,values] of Object.entries({speechPitch:[-6.1,6.1,'2',null,NaN,Infinity],speechVolume:[-.01,1.01,'0.5',null,NaN,Infinity],speechRate:[0,2.1,'1',NaN]})){
    for(const value of values)await assert.rejects(core.updateSettings({voice:'must-not-save',[key]:value}));
  }
  assert.equal(core.settings.voice,defaultVoice);assert.equal(core.store.settings().speechPitch,2.5);
  let stopped=0;core.speech.stop=()=>{stopped++;};
  await core.updateSettings({speechVolume:0});assert.equal(stopped,1);
  f.settings.speechVolume=0;assert.equal(f.speech.speak('Muted preview',true),false);assert.equal(f.speech.speak('Muted pinned reply',false,'pinned'),false);
  await core.updateSettings({speechPitch:0,speechRate:1,speechVolume:1});
  assert.equal(core.settings.voice,defaultVoice);
});

test('real SoX raises and lowers pitch without changing duration, and attenuates volume', async t => {
  try { await promisify(execFile)('sox',['--version']); } catch { t.skip('Install SoX to validate real audio processing');return; }
  const f=await fixture(t),output=join(f.directory,'tuned.pcm');
  f.env.CERE_SOX_BIN='sox';
  f.env.CERE_PIPER_BIN=await f.executable('tone.mjs',`for await(const chunk of process.stdin){};const pcm=Buffer.alloc(22050*2);for(let i=0;i<22050;i++)pcm.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*440*i/22050)),i*2);process.stdout.write(pcm);`);
  f.env.CERE_APLAY_BIN=await f.executable('capture.mjs',`import {writeFileSync} from 'node:fs';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);writeFileSync(${JSON.stringify(output)},Buffer.concat(chunks));`);
  const voice=await resolveVoice(defaultVoice,[f.voices]);
  const measure=async(pitch:number,volume:number)=>{
    await playPiper('Test tone',voice,new AbortController().signal,f.env,1,{pitch,volume});
    const pcm=await readFile(output),start=2205,end=pcm.length/2-2205;
    let crossings=0,energy=0;
    for(let i=start;i<end;i++){
      const sample=pcm.readInt16LE(i*2);energy+=sample*sample;
      if(sample>=0&&pcm.readInt16LE((i-1)*2)<0)crossings++;
    }
    return {seconds:pcm.length/2/22050,frequency:crossings*22050/(end-start),rms:Math.sqrt(energy/(end-start))};
  };
  const plain=await measure(0,1);
  for(const pitch of [-3,3]){
    const tuned=await measure(pitch,.4);
    assert.ok(Math.abs(tuned.seconds-plain.seconds)<.02,JSON.stringify(tuned));
    assert.ok(Math.abs(tuned.frequency-440*Math.pow(2,pitch/12))<3,JSON.stringify(tuned));
    assert.ok(Math.abs(tuned.rms/plain.rms-.4)<.04,JSON.stringify(tuned));
  }
});

test('completion hook speaks only final successful top-level local replies, never streaming or old history', async t => {
  const f = await fixture(t); let hooks!: Hooks;
  const core = new Core(new Store(join(f.directory, 'state')), (_s, h) => { hooks = h; return { async send() {}, async interrupt() {}, async close() {} }; });
  t.after(() => core.close());
  const spoken: string[] = []; core.speech.speak = text => { spoken.push(text); return true; };
  const s = await core.create({ provider: 'codex', cwd: f.directory, trusted: true });
  await core.send({ id: s.id, text: 'First' });
  hooks.event({ type: 'message', id: 'progress', text: 'Working', data: { phase: 'commentary' } });
  hooks.event({ type: 'delta', id: 'answer', text: 'Final ' }); hooks.event({ type: 'delta', id: 'answer', text: 'answer' });
  assert.deepEqual(spoken, []);
  hooks.event({ type: 'message', id: 'answer', text: 'Final answer' });
  hooks.event({ type: 'complete' }); hooks.event({ type: 'complete' }); assert.deepEqual(spoken, ['Final answer']);
  await core.send({ id: s.id, text: 'Second' }); hooks.event({ type: 'complete' }); assert.equal(spoken.length, 1);
  for (const event of ['error', 'interrupted', 'cancelled']) {
    await core.send({ id: s.id, text: 'Failure' }); hooks.event({ type: 'message', text: 'Partial' }); hooks.event({ type: event });
  }
  await core.send({ id: s.id, text: 'Commentary only' }); hooks.event({ type: 'message', text: 'Working', data: { phase: 'commentary' } }); hooks.event({ type: 'complete' });
  await core.send({ id: s.id, text: 'Child' });
  const parent = await core.create({ provider: 'codex', cwd: f.directory, trusted: true }); core.updateSession(s.id, { parentId: parent.id });
  hooks.event({ type: 'message', text: 'Child answer' }); hooks.event({ type: 'complete' });
  assert.deepEqual(spoken, ['Final answer']);
});

test('voice settings migrate/persist atomically and slash/debug tests bypass the provider', async t => {
  const f = await fixture(t); let sends = 0;
  const core = new Core(new Store(join(f.directory, 'state')), () => ({ async send() { sends++; }, async interrupt() {}, async close() {} }));
  t.after(() => core.close());
  core.store.set('settings', { quiet: true }); assert.equal(core.store.settings().voice, defaultVoice);
  assert.equal(core.store.settings().speechEnabled, true);
  await core.updateSettings({ voice: 'custom', speechEnabled: false });
  assert.equal(core.store.settings().voice, 'custom'); assert.equal(core.store.settings().speechEnabled, false);
  await assert.rejects(core.updateSettings({ voice: '../bad', quiet: true })); assert.equal(core.settings.quiet, false);
  await assert.rejects(core.updateSettings({ speechEnabled: 'true', voice: 'other' })); assert.equal(core.settings.voice, 'custom');
  const spoken: unknown[] = []; core.speech.speak = (text, force) => { spoken.push([text, force]); return true; };
  const s = await core.create({ provider: 'codex', cwd: f.directory, trusted: true });
  await core.send({ id: s.id, text: '/tts-test' }); await core.rpc('tts.test');
  assert.equal(sends, 0); assert.deepEqual(spoken, [[ttsTestLine, true], [ttsTestLine, true]]);
  assert.deepEqual(await core.rpc('tts.status'), core.speech.snapshot());
});

test('dispatcher setup preserves existing configuration and voice files and registers custom pairs idempotently', async t => {
  const f = await fixture(t), project = join(f.directory, "project with 'quotes"), config = join(f.directory, 'speech-dispatcher');
  await mkdir(join(project, 'tools'), { recursive: true }); await mkdir(join(project, 'broker')); await mkdir(join(project, 'tts/voices'), { recursive: true });
  await mkdir(join(project, 'tts/licenses')); await mkdir(config);
  for (const name of ['broker/tts.ts', 'broker/paths.ts', 'tools/setup-speech.ts']) await cp(new URL('../' + name, import.meta.url), join(project, name));
  await cp(f.voices, join(project, 'tts/voices'), { recursive: true });
  for (const name of ['tts/voices/MODEL_CARD', 'tts/NOTICES.md', 'tts/licenses/MIMIC3-CC-BY-SA-4.0.txt']) await writeFile(join(project, name), 'fixture attribution');
  await f.addVoice('custom', 48000, true);
  await writeFile(join(f.voices, defaultVoice + '.onnx'), 'user voice, do not overwrite');
  const original = 'DefaultModule "existing"\nBeginClient "screen-reader:*"\nDefaultModule "existing"\nEndClient\n';
  await writeFile(join(config, 'speechd.conf'), original);
  const run = () => promisify(execFile)(process.execPath, [join(project, 'tools/setup-speech.ts'), '--config-dir', config, '--voices-dir', f.voices]);
  await run(); const first = await readFile(join(config, 'speechd.conf'), 'utf8'); await run();
  assert.equal(await readFile(join(config, 'speechd.conf'), 'utf8'), first);
  assert.ok(first.endsWith(original)); assert.equal(first.match(/AddModule "cere-piper"/g)?.length, 1);
  assert.equal(await readFile(join(f.voices, defaultVoice + '.onnx'), 'utf8'), 'user voice, do not overwrite');
  const module = await readFile(join(config, 'modules/cere-piper.conf'), 'utf8');
  assert.match(module, /AddVoice "en-us" "FEMALE1" "custom"/);
  assert.doesNotMatch(module,/kokoro-/);
  assert.match(module, /GenericExecuteSynth/); assert.match(module, /project with/);
});

test('provider speech switches migrate, merge and persist with atomic validation',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-speech-providers-'));let core=new Core(new Store(directory));t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  assert.ok(Object.values(core.settings.speechProviders).every(Boolean));
  await core.updateSettings({speechProviders:{codex:false,openai:false}});await core.updateSettings({speechProviders:{google:false}});
  const saved=structuredClone(core.settings.speechProviders);assert.equal(saved.codex,false);assert.equal(saved.claude,true);
  for(const value of [null,[],{unknown:true},{ollama:'false'}])await assert.rejects(core.updateSettings({speechProviders:value}));
  assert.deepEqual(core.settings.speechProviders,saved);await core.close();core=new Core(new Store(directory));assert.deepEqual(core.settings.speechProviders,saved);
});

test('provider mute cancels only matching active and queued speech, with explicit tests exempt',async t=>{
  const f=await fixture(t);f.settings.ttsProvider='elevenlabs';f.settings.speechProviders={...f.settings.speechProviders,codex:false};
  const started:string[]=[];const stopped:string[]=[];
  f.speech.elevenlabs={async play(text:string,signal:AbortSignal){started.push(text);await new Promise<void>(r=>signal.addEventListener('abort',()=>{stopped.push(text);r();},{once:true}));}} as any;
  assert.equal(f.speech.speak('Muted',false,undefined,undefined,undefined,'codex'),false);
  assert.equal(f.speech.speak('Preview',true),true);await until(async()=>started.includes('Preview'));f.speech.stop();await f.speech.idle();
  f.settings.speechProviders={...f.settings.speechProviders,codex:true};
  f.speech.speak('Codex active',false,undefined,undefined,undefined,'codex');await until(async()=>started.includes('Codex active'));
  f.speech.speak('Claude queued',false,undefined,undefined,undefined,'claude');f.speech.speak('Codex queued',false,undefined,undefined,undefined,'codex');
  f.speech.stopProviders(['codex']);assert.deepEqual(f.speech.queue.map(q=>q.text),['Claude queued']);
  await until(async()=>started.includes('Claude queued'));assert.ok(stopped.includes('Codex active'));assert.ok(!started.includes('Codex queued'));
  f.speech.stopProviders(['codex']);assert.ok(!stopped.includes('Claude queued'));
});
