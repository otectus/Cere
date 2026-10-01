import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,stat,writeFile } from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {ElevenLabs,defaultElevenConfig,validateElevenConfig} from '../broker/elevenlabs.ts';
import {ProviderCredentials} from '../broker/credentials.ts';
import {Core} from '../broker/core.ts';import {Store} from '../broker/store.ts';
const config={...defaultElevenConfig,allowCloud:true,voiceId:'voice-1'};
const signal=()=>new AbortController().signal;
const json=(value:any)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const pcm=(body:any=Buffer.alloc(4800))=>new Response(body,{headers:{'content-type':'audio/pcm'}});
async function collect(engine:ElevenLabs,abort=signal()){const parts=[];for await(const p of engine.audio('Hello there.',abort))parts.push(p);return Buffer.concat(parts);}
test('ElevenLabs paginates voices, filters models and never follows redirects',async()=>{
  const calls:any[]=[];const e=new ElevenLabs(()=>config,()=> 'private-key',()=>{},{fetch:async(url,init)=>{calls.push({url:String(url),init});return String(url).includes('/models')?json([{model_id:'tts',name:'TTS',can_do_text_to_speech:true,maximum_text_length_per_request:400},{model_id:'other',can_do_text_to_speech:false}]):String(url).includes('next_page_token')?json({voices:[{voice_id:'two',name:'Two'}],has_more:false}):json({voices:[{voice_id:'one',name:'One'}],has_more:true,next_page_token:'a/b'});}});
  await e.refresh();assert.deepEqual(e.voices.map(v=>v.id),['one','two']);assert.deepEqual(e.models.map(m=>m.id),['tts']);assert.equal(e.models[0].limit,400);assert.match(calls[1].url,/a%2Fb/);assert.ok(calls.every(c=>c.init.redirect==='error'&&c.init.headers['xi-api-key']==='private-key'));assert.ok(!JSON.stringify(e.snapshot()).includes('private-key'));
});
test('ElevenLabs requires cloud permission, key and voice before sending text',async()=>{
  let calls=0;let c={...config,allowCloud:false};let key='';const e=new ElevenLabs(()=>c,()=>key,()=>{},{fetch:async()=>{calls++;return pcm();}});
  await assert.rejects(collect(e),{code:'ELEVENLABS_CLOUD'});c.allowCloud=true;await assert.rejects(collect(e),{code:'ELEVENLABS_KEY'});key='key';c.voiceId='';await assert.rejects(collect(e),{code:'ELEVENLABS_VOICE'});assert.equal(calls,0);
  assert.throws(()=>validateElevenConfig({voiceId:'../leak'}));assert.throws(()=>validateElevenConfig({apiKey:'secret'}));assert.throws(()=>validateElevenConfig({allowCloud:'true'}));
});
test('ElevenLabs streams before completion and joins odd PCM boundaries without duplication',async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>;let body:any;
  const e=new ElevenLabs(()=>config,()=> 'key',()=>{},{fetch:async(url,init)=>{assert.match(String(url),/output_format=pcm_24000/);body=JSON.parse(String(init?.body));return pcm(new ReadableStream({start(c){stream=c;c.enqueue(new Uint8Array([1,2,3]));}}));}});
  const iterator=e.audio('Hello there.',signal());assert.deepEqual((await iterator.next()).value,Buffer.from([1,2]));stream.enqueue(new Uint8Array([4,5,6]));stream.close();assert.deepEqual((await iterator.next()).value,Buffer.from([3,4,5,6]));assert.equal((await iterator.next()).done,true);assert.deepEqual(body,{text:'Hello there.',model_id:'eleven_flash_v2_5'});
});
test('ElevenLabs retries HTTP attempts, redacts failures and never retries a broken audio stream',async()=>{
  let count=0;const logs:string[]=[];const e=new ElevenLabs(()=>config,()=> 'private-key',()=>{},{fetch:async()=>++count===1?new Response('sensitive',{status:503}):pcm(),retry:{sleep:async()=>{},log:m=>logs.push(m)}});
  assert.equal((await collect(e)).length,4800);assert.equal(count,2);assert.match(logs[0],/503/);assert.ok(!logs.join('').includes('private'));
  for(const [status,code] of [[401,'AUTH'],[403,'FORBIDDEN'],[404,'NOT_FOUND'],[402,'QUOTA'],[429,'RATE_LIMIT']] as const){const broken=new ElevenLabs(()=>config,()=> 'key',()=>{},{fetch:async()=>new Response('private-key and secret text',{status}),retry:{maxRetries:0}});await assert.rejects(collect(broken),(error:any)=>error.code==='ELEVENLABS_'+code&&!error.message.includes('secret'));}
  count=0;const bad=new ElevenLabs(()=>config,()=> 'key',()=>{},{fetch:async()=>{count++;return pcm(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));},pull(c){c.error(Error('secret text'));}}));}});await assert.rejects(collect(bad),{code:'ELEVENLABS_STREAM'});assert.equal(count,1);
});
test('ElevenLabs aborts a pending HTTP request and clears stale catalog results',async()=>{
  let started!:()=>void;const ready=new Promise<void>(r=>started=r);let aborted=false;
  const e=new ElevenLabs(()=>config,()=> 'key',()=>{},{fetch:async(_url,init)=>new Promise((_resolve,reject)=>{started();init?.signal?.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));});})});
  const controller=new AbortController(),request=collect(e,controller.signal);await ready;controller.abort();await assert.rejects(request);assert.equal(aborted,true);
  const refresh=e.refresh();e.reset();await assert.rejects(refresh);assert.deepEqual(e.voices,[]);assert.equal(e.loading,false);
});
test('ElevenLabs plays streamed PCM through tuning and releases playback on stop',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-eleven-'));t.after(()=>rm(dir,{recursive:true,force:true}));const log=join(dir,'audio.jsonl');
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  let hold=false;const e=new ElevenLabs(()=>config,()=> 'key',()=>{},{env:{...process.env,CERE_APLAY_BIN:resolve('tests/fixtures/audio-sink.mjs'),CERE_AUDIO_SINK_LOG:log},fetch:async()=>hold?pcm(new ReadableStream({start(c){controller=c;c.enqueue(new Uint8Array(48000));},cancel(){}})):pcm(Buffer.alloc(48000))});
  let started=0;await e.play('Hello.',signal(),{rate:1.1,pitch:.5,volume:.8},()=>started++);assert.equal(started,1);assert.ok(JSON.parse((await readFile(log,'utf8')).trim()).bytes>0);
  hold=true;const abort=new AbortController();const pending=e.play('Hello.',abort.signal,{rate:1,pitch:0,volume:1},()=>abort.abort());await assert.rejects(pending);assert.ok(controller);
});
test('ElevenLabs credentials stay private and settings persist through Core without replacing local voices',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-eleven-core-'));let core=new Core(new Store(dir));t.after(async()=>{await core.close();await rm(dir,{recursive:true,force:true});});
  await core.rpc('elevenlabs.credentials',{key:'eleven-secret'});await core.rpc('provider.credentials',{provider:'openai',key:'openai-secret'});
  assert.equal(core.credentials.key('elevenlabs'),'eleven-secret');const file=join(dir,'credentials/provider-credentials.json');assert.equal((await stat(file)).mode&0o777,0o600);
  await core.updateSettings({elevenlabs:config,ttsProvider:'elevenlabs'});assert.ok(!JSON.stringify(core.snapshot()).includes('eleven-secret'));const local=core.settings.voice;
  await core.close();core=new Core(new Store(dir));assert.deepEqual(core.settings.elevenlabs,config);assert.equal(core.settings.ttsProvider,'elevenlabs');assert.equal(core.settings.voice,local);
  await core.rpc('elevenlabs.credentials',{key:''});assert.equal(core.credentials.key('elevenlabs'),'');assert.equal(core.credentials.key('openai'),'openai-secret');
});
test('switching away from ElevenLabs aborts the request and drops queued cloud speech',async t=>{
  const {Speech}=await import('../broker/tts.ts');const dir=await mkdtemp(join(tmpdir(),'cere-eleven-switch-'));const core=new Core(new Store(dir));t.after(async()=>{await core.close();await rm(dir,{recursive:true,force:true});});
  await core.speech.close();core.speech=new Speech(()=>core.settings,()=>{},{...process.env,CERE_TTS_DISABLED:'0'});core.speech.indextts=core.indextts;
  let started!:()=>void;const ready=new Promise<void>(r=>started=r);let stopped=false;
  core.speech.elevenlabs={async play(_text:string,signal:AbortSignal){started();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{stopped=true;resolve();},{once:true}));}} as unknown as ElevenLabs;
  await core.updateSettings({ttsProvider:'elevenlabs',elevenlabs:config,speechEnabled:true,quiet:false});
  assert.equal(core.speech.speak('First reply.'),true);await ready;core.speech.speak('Queued reply.');await core.updateSettings({ttsProvider:'local'});assert.equal(stopped,true);assert.equal(core.speech.queue.length,0);assert.equal(core.speech.snapshot().state,'idle');
});
