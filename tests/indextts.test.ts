import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IndexEngine } from '../broker/indextts-engine.ts';
import { defaultIndexConfig, defaultEmotion, indexChunks, indexPrefix, IndexError, indexError, validateIndexConfig, validateEmotion } from '../broker/indextts-config.ts';
import { Store } from '../broker/store.ts';
import { Speech } from '../broker/tts.ts';
import { defaultSettings } from '../broker/types.ts';
import { IndexTTS } from '../broker/indextts.ts';
import { Core } from '../broker/core.ts';

function engine(t:any,version:'2'|'2.5'='2.5'){
  const e=new IndexEngine({...defaultIndexConfig,version,device:'cpu'},()=>{},process.env,{command:process.execPath,args:[resolve('tests/fixtures/indextts-worker.mjs')]});
  t.after(()=>e.unload());return e;
}
test('IndexTTS chunks CJK sentences and keeps annotations atomic',()=>{
  const annotation='<非常长的名字|CH ANG2 M ING2 Z I4>';
  const text='你好世界。こんにちは！مرحبا؟ '+annotation+' Good morning. Another sentence with several words.';
  const chunks=indexChunks(text,20);
  assert.equal(chunks.filter(c=>c.includes(annotation)).length,1);
  assert.equal(chunks.join('').replace(/\s/g,''),text.replace(/\s/g,''));
  assert.ok(chunks.every(c=>c.length<=20||c===annotation));
  assert.ok(chunks.some(c=>c.includes('。')));
  assert.deepEqual(indexChunks('   ',20),[]);
  assert.deepEqual(indexChunks('one two three four five six',12),['one two','three four','five six']);
  assert.equal(indexPrefix('Hello <Cere|S IH R>!',12),'Hello ');
  assert.throws(()=>indexChunks('a',0),IndexError);
});
test('version, precision, emotion and numeric ranges fail closed',()=>{
  assert.throws(()=>validateIndexConfig({version:'2',precision:'bf16'}),{code:'UNSUPPORTED_HARDWARE'});
  assert.throws(()=>validateIndexConfig({version:'2.5',precision:'fp16'}),{code:'UNSUPPORTED_HARDWARE'});
  for(const patch of [{idleMinutes:0},{chunkChars:1},{deepspeed:'yes'},{device:'mps'},{modelDir:'relative'}])assert.throws(()=>validateIndexConfig(patch),IndexError);
  for(const patch of [{alpha:NaN},{vector:[1]},{vector:[2,0,0,0,0,0,0,0]},{source:'text-description',text:''},{source:'made-up'}])assert.throws(()=>validateEmotion({...defaultEmotion,...patch}),{code:'INVALID_EMOTION'});
  assert.equal(validateEmotion({...defaultEmotion,source:'synthesis-text',alpha:.6}).alpha,.6);
  assert.equal(validateEmotion({source:'synthesis-text'}).alpha,.6);
  assert.equal(indexError(new Error('secret synthesis text')).message,'IndexTTS could not synthesize this request.');
});
test('capabilities come from the worker and gate duration on v2',async t=>{
  const e=engine(t,'2');const c=await e.load();assert.equal(c.durationControl,false);assert.deepEqual(c.languages,['zh','en']);assert.deepEqual(c.devices[0].precisions,['fp32']);
});
test('ordered chunks discard stale generation results',async t=>{
  const e=engine(t);await e.load();const output=[];
  for await(const chunk of e.synthesize({generationId:'new',mode:'stale'}))output.push(chunk);
  assert.deepEqual(output.map(c=>c.seq),[0,1,2]);assert.ok(output.every(c=>c.generationId==='new'));
});
test('out-of-order audio fails before playback and kills worker',async t=>{
  const e=engine(t);await e.load();let yielded=false;
  await assert.rejects(async()=>{for await(const _ of e.synthesize({generationId:'x',mode:'out-of-order'}))yielded=true;},{code:'IPC_ERROR'});
  assert.equal(yielded,false);assert.equal(e.pid,undefined);
});
test('cancel terminates in-flight worker and releases its process',async t=>{
  const e=engine(t);await e.load();const pid=e.pid!,signal=new AbortController();
  const task=(async()=>{for await(const _ of e.synthesize({generationId:'x',mode:'hold'},signal.signal))assert.fail('cancelled result');})();
  const rejection=assert.rejects(task,{code:'CANCELLED'});await new Promise(r=>setTimeout(r,50));signal.abort();await rejection;
  assert.equal(e.pid,undefined);assert.throws(()=>process.kill(pid,0));
  assert.ok(await e.load());
});
test('early consumer exit terminates generator waiting for acknowledgment',async t=>{
  const e=engine(t);await e.load();for await(const _ of e.synthesize({generationId:'x'}))break;
  assert.equal(e.pid,undefined);assert.ok(await e.load());
});
test('idle unload exits the worker instead of merely clearing a model reference',async t=>{
  const e=engine(t);e.config={...e.config,idleMinutes:.001};await e.load();const pid=e.pid!;
  await new Promise(r=>setTimeout(r,150));assert.equal(e.pid,undefined);assert.throws(()=>process.kill(pid,0));
});
test('worker crashes, malformed IPC and OOM have stable error codes',async t=>{
  for(const [mode,code] of [['crash','WORKER_CRASH'],['invalid','IPC_ERROR'],['oom','OUT_OF_MEMORY']]){
    const e=engine(t);await e.load();await assert.rejects(async()=>{for await(const _ of e.synthesize({generationId:'x',mode})){}},{code});assert.equal(e.pid,undefined);
  }
});
test('provider configuration survives SQLite reopen with nested defaults',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-index-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let store=new Store(dir);store.set('settings',{ttsProvider:'indextts',indextts:{version:'2',device:'cpu'}});store.close();store=new Store(dir);t.after(()=>store.close());
  const s=store.settings();assert.equal(s.ttsProvider,'indextts');assert.equal(s.indextts.version,'2');assert.equal(s.indextts.idleMinutes,10);
});
test('existing speech queue preserves IndexTTS annotations and cancellation',async t=>{
  const settings={...defaultSettings,ttsProvider:'indextts' as const};const speech=new Speech(()=>settings,()=>{},{...process.env,CERE_TTS_DISABLED:'0'});t.after(()=>speech.close());
  const spoken:string[]=[];
  speech.indextts={play:async(text:string,signal:AbortSignal)=>{spoken.push(text);await new Promise<void>(done=>signal.addEventListener('abort',()=>done(),{once:true}));}} as any;
  speech.speak('Say <Cere|S IH R> today.');speech.speak('pending');await new Promise(r=>setTimeout(r,20));speech.stop();await speech.idle();
  assert.deepEqual(spoken,['Say <Cere|S IH R> today.']);assert.equal(speech.snapshot().queued,0);
});
test('reference validation and emotion mapping use no models or GPU',async()=>{
  const result=await promisify(execFile)('python3',['-B','tests/indextts-worker-test.py']);assert.match(result.stdout,/passed/);
});
test('voice profiles copy private originals, persist edits, and delete all files',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-index-voices-')),store=new Store(join(dir,'state'));
  const service=new IndexTTS(store,()=>defaultIndexConfig,()=>{},{...process.env,XDG_DATA_HOME:dir});service.engine=engine(t);
  t.after(async()=>{await service.close();store.close();await rm(dir,{recursive:true,force:true});});
  const input=join(dir,'recording.wav');await writeFile(input,'synthetic fixture bytes');
  const profile=await service.saveProfile({name:'Private voice',language:'en',referencePath:input});
  assert.equal(await readFile(profile.original,'utf8'),'synthetic fixture bytes');assert.equal((await stat(profile.original)).mode&0o777,0o600);
  assert.equal((await stat(resolve(profile.reference,'..'))).mode&0o777,0o700);
  const edited=await service.saveProfile({id:profile.id,name:'Renamed',language:'zh'});assert.equal(edited.original,profile.original);assert.equal(edited.created,profile.created);assert.equal(store.get<any[]>('indextts.voices',[])[0].name,'Renamed');
  await assert.rejects(service.saveProfile({id:profile.id,name:'Bad',language:'xx'}),{code:'UNSUPPORTED_LANGUAGE'});
  assert.equal(service.profiles()[0].name,'Renamed');await service.deleteProfile(profile.id);assert.deepEqual(service.profiles(),[]);await assert.rejects(access(profile.reference));await assert.rejects(access(profile.original));
});
test('switching provider during inference clears pending replies and exits the worker',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-index-switch-')),store=new Store(directory);
  const core=new Core(store);await core.speech.close();
  const env={...process.env,CERE_TTS_DISABLED:'0',CERE_FAKE_INDEX_HOLD:'1',CERE_APLAY_BIN:resolve('tests/fixtures/audio-sink.mjs'),XDG_DATA_HOME:directory};
  core.indextts=new IndexTTS(store,()=>core.settings.indextts,()=>{},env);
  const e=engine(t);e.env=env;core.indextts.engine=e;
  core.speech=new Speech(()=>core.settings,()=>{},env);core.speech.indextts=core.indextts;
  core.settings={...core.settings,ttsProvider:'indextts',indextts:{...defaultIndexConfig,profileId:'fixture'}};
  store.set('indextts.voices',[{id:'fixture',version:'2.5',language:'en',reference:'fixture.wav',emotion:defaultEmotion,durationFactor:1}]);
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  core.speech.speak('First reply.');core.speech.speak('Pending reply.');
  for(let i=0;i<100&&core.indextts.snapshot().state!=='ready';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(core.indextts.snapshot().state,'ready');const pid=e.pid!;
  await core.rpc('settings.update',{ttsProvider:'local'});
  assert.equal(core.settings.ttsProvider,'local');assert.equal(core.speech.snapshot().queued,0);assert.equal(e.pid,undefined);assert.throws(()=>process.kill(pid,0));
});
