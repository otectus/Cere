import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiAdapter, apiModels, consumeSse } from '../broker/api-providers.ts';
import { ProviderCredentials } from '../broker/credentials.ts';
import { apiProviders, type ApiProvider } from '../broker/provider-catalog.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { eraseWorkingCopies } from '../broker/working-erasure.ts';
import type { OllamaMessage, OllamaTool } from '../broker/ollama.ts';
import type { Session } from '../broker/types.ts';

const session=(provider:ApiProvider):Session=>({id:'api-test',provider,nativeId:null,title:'Test',cwd:tmpdir(),mode:'managed',status:'idle',created:0,updated:0,draft:'',scroll:0,model:'test-model',api:{tools:true}});
const tool:OllamaTool={type:'function',function:{name:'check',description:'Check a value',parameters:{type:'object',properties:{value:{type:'string'}}}}};
function sse(events: any[]) { return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''),{headers:{'Content-Type':'text/event-stream'}}); }
function events(provider:ApiProvider, tools=false):any[] {
  if(provider==='openai')return tools?[
    {type:'response.completed',response:{status:'completed',output:[{type:'reasoning',id:'reason',encrypted_content:'opaque-reasoning'},{type:'function_call',call_id:'call-1',name:'check',arguments:'{"value":"yes"}'}]}},
  ]:[{type:'response.output_text.delta',delta:'Hello 🌙'}, {type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Hello 🌙'}]}]}}];
  if(provider==='anthropic')return tools?[
    {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call-1',name:'check',input:{}}},
    {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"value":'}},
    {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'"yes"}'}},
    {type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'},
  ]:[{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello 🌙'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}];
  return [{candidates:[{content:{role:'model',parts:tools?[{functionCall:{id:'call-1',name:'check',args:{value:'yes'}},thoughtSignature:'keep-this-signature'}]:[{text:'Hello 🌙'}]},finishReason:'STOP'}]}];
}
async function fixture(t:any,provider:ApiProvider,fetcher?:typeof fetch){
  const directory=await mkdtemp(join(tmpdir(),'cere-api-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const output:any[]=[],requests:{url:string;init:any;body:any}[]=[],calls:any[]=[];let history:OllamaMessage[]=[];
  const adapter=new ApiAdapter(session(provider),{token:'test',native(){},event:e=>output.push(e),approve:async()=>({choice:'deny'}),personality:()=> 'Helpful'}, {
    load:()=>structuredClone(history),save:messages=>{history=structuredClone(messages);},tools:()=>[tool],call:async(name,args)=>{calls.push({name,args});return {ok:true};},
  },{key:()=> 'test-secret',fetch:fetcher|| (async(url,init)=>{requests.push({url:String(url),init,body:JSON.parse(String(init?.body))});return sse(events(provider,requests.length===1));})});
  t.after(()=>adapter.close());return{adapter,output,requests,calls,directory,history:()=>history};
}
for(const provider of apiProviders)test(`${provider}: stream, tool result, image, opaque continuation, and local history`,async t=>{
  const f=await fixture(t,provider), image=join(f.directory,'image.png');await writeFile(image,Buffer.from([137,80,78,71,13,10,26,10]));
  await f.adapter.send('Check this',[image]);await f.adapter.task;
  assert.equal(f.output.at(-1).type,'complete');assert.deepEqual(f.calls,[{name:'check',args:{value:'yes'}}]);
  assert.equal(f.requests.length,2);assert.equal(f.output.filter(e=>e.type==='message').length,1);
  assert.equal(f.history().at(-1)?.content,'Hello 🌙');
  const first=f.requests[0],second=JSON.stringify(f.requests[1].body);
  assert.equal(first.init.redirect,'error');assert.ok(!first.url.includes('test-secret'));assert.ok(JSON.stringify(first.body).includes('image'));
  assert.ok(second.includes('call-1'));assert.ok(second.includes('ok'));
  if(provider==='openai'){assert.equal(first.body.store,false);assert.equal(first.init.headers.Authorization,'Bearer test-secret');assert.ok(second.includes('opaque-reasoning'));}
  if(provider==='anthropic')assert.equal(first.init.headers['anthropic-version'],'2023-06-01');
  if(provider==='google'){assert.equal(first.init.headers['x-goog-api-key'],'test-secret');assert.ok(second.includes('keep-this-signature'));}
  await f.adapter.send('What did you say?');await f.adapter.task;
  assert.ok(JSON.stringify(f.requests.at(-1)?.body).includes('Hello 🌙'));
});
test('SSE tolerates arbitrary byte boundaries, UTF-8, CRLF, comments and multiline data',async()=>{
  const bytes=new TextEncoder().encode(': ping\r\ndata: {"text":\r\ndata: "🌙"}\r\n\r\ndata: [DONE]\n\n');
  const output:any[]=[];await consumeSse(new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}})),v=>output.push(v));
  assert.deepEqual(output,[{text:'🌙'}]);
});
for(const provider of apiProviders)test(`${provider}: truncated stream never completes or executes a tool`,async t=>{
  let requests=0;const f=await fixture(t,provider,async()=>{requests++;return sse(provider==='openai'?[{type:'response.output_text.delta',delta:'partial'}]:[]);});
  await f.adapter.send('Hi');await f.adapter.task;
  assert.equal(f.output.at(-1).type,'error');assert.match(f.output.at(-1).text,/disconnected/);assert.equal(f.calls.length,0);assert.equal(requests,1);
});
const outputLimitEvents=(provider:ApiProvider):any[]=>provider==='openai'?[
  {type:'response.output_text.delta',delta:'Partial answer'},
  {type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Partial answer'}]},{type:'function_call',call_id:'cut',name:'check',arguments:'{"val'}]}},
]:provider==='anthropic'?[
  {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
  {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Working it out'}},
  {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'sig-kept'}},
  {type:'content_block_start',index:1,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Partial answer'}},
  {type:'content_block_start',index:2,content_block:{type:'tool_use',id:'cut',name:'check',input:{}}},
  {type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"val'}},
  {type:'message_delta',delta:{stop_reason:'max_tokens'}},{type:'message_stop'},
]:[{candidates:[{content:{role:'model',parts:[{text:'Partial answer'}]}}]},{candidates:[{content:{role:'model',parts:[{functionCall:{id:'cut',name:'check',args:{}}}]},finishReason:'MAX_TOKENS'}]}];
for(const provider of apiProviders)test(`${provider}: a reply cut at the output limit stays in the transcript and model history and runs no tool`,async t=>{
  const bodies:any[]=[];const f=await fixture(t,provider,async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return sse(outputLimitEvents(provider));});
  await f.adapter.send('Write a long answer');await f.adapter.task;
  assert.equal(f.output.at(-1).type,'complete');assert.equal(f.calls.length,0);assert.equal(bodies.length,1);
  const message=f.output.find(e=>e.type==='message');assert.match(message.text,/^Partial answer/);assert.match(message.text,/output limit/);
  const reply=f.history().at(-1)!;assert.equal(reply.role,'assistant');assert.equal(reply.content,'Partial answer');assert.equal(reply.tool_calls,undefined);
  assert.doesNotMatch(JSON.stringify(reply.providerData),/"cut"/);
  if(provider==='anthropic'){assert.equal(bodies[0].max_tokens,4096);assert.match(JSON.stringify(reply.providerData),/sig-kept/);}
});
test('Claude API requests use the catalog output ceiling and context window',async t=>{
  const models=await apiModels('anthropic',{key:()=> 'private',fetch:async()=>Response.json({data:[{id:'claude-test',display_name:'Claude Test',max_input_tokens:1000000,max_tokens:128000}],has_more:false})});
  assert.equal(models[0].contextLength,1000000);assert.equal(models[0].maxOutputTokens,128000);
  const bodies:any[]=[];let history:OllamaMessage[]=[];
  const adapter=new ApiAdapter(session('anthropic'),{token:'test',native(){},event(){},approve:async()=>({choice:'deny'}),personality:()=> 'Helpful'},
    {load:()=>structuredClone(history),save:messages=>{history=structuredClone(messages);},tools:()=>[],call:async()=>({})},
    {key:()=> 'private',fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return sse(events('anthropic'));}},{contextLength:models[0].contextLength,maxOutputTokens:models[0].maxOutputTokens});
  t.after(()=>adapter.close());
  await adapter.send('Hi');await adapter.task;
  assert.equal(bodies[0].max_tokens,128000);assert.equal(adapter.contextLength,1000000);assert.equal(history.at(-1)?.content,'Hello 🌙');
});
for(const provider of apiProviders)test(`${provider}: transient failures retry only the HTTP attempt and never repeat completed tools`,async t=>{
  const bodies:string[]=[],waits:number[]=[];let attempt=0;
  const f=await fixture(t,provider,async(_url,init)=>{
    bodies.push(String(init?.body));attempt++;
    if(attempt===1||attempt===3)return new Response('private error',{status:attempt===1?503:429,headers:{'Retry-After':'2'}});
    return sse(events(provider,attempt===2));
  });
  f.adapter.access.retry={random:()=>0,log:()=>{},sleep:async ms=>{waits.push(ms);}};
  await f.adapter.send('Check this');await f.adapter.task;
  assert.equal(attempt,4);assert.deepEqual(waits,[2000,2000]);assert.equal(bodies[0],bodies[1]);assert.equal(bodies[2],bodies[3]);
  assert.equal(f.calls.length,1);assert.equal(f.output.at(-1).type,'complete');
  assert.equal(f.output.filter(e=>e.type==='message').length,1);
  const retries=f.output.filter(e=>e.type==='tool'&&e.text.includes('Retry 1/3'));
  assert.equal(retries.length,2);assert.ok(!JSON.stringify(f.output).includes('private error'));
});
test('API catalogs use retries and still return the successful catalog',async()=>{
  let requests=0;const models=await apiModels('openai',{key:()=> 'secret',retry:{sleep:async()=>{},log:()=>{}},fetch:async()=>++requests===1?new Response('',{status:502}):Response.json({data:[{id:'gpt-fixture'}]})});
  assert.equal(requests,2);assert.equal(models[0].id,'gpt-fixture');
});
test('Stop during API backoff produces an interruption, without another request',async t=>{
  let requests=0,waiting!:()=>void;const ready=new Promise<void>(resolve=>waiting=resolve);
  const f=await fixture(t,'anthropic',async()=>{requests++;return new Response('',{status:503});});
  f.adapter.access.retry={initialDelayMs:10000,log:()=>{},onRetry:waiting};
  await f.adapter.send('Hello');await ready;await f.adapter.interrupt();
  assert.equal(requests,1);assert.equal(f.output.at(-1).type,'interrupted');assert.equal(f.calls.length,0);
});
test('HTTP failures expose an actionable status without echoing secrets or retrying',async t=>{
  let sent=0;const f=await fixture(t,'openai',async()=>{sent++;return new Response('test-secret',{status:401});});
  await f.adapter.send('Hello');await f.adapter.task;
  assert.equal(sent,1);assert.match(f.output.at(-1).text,/401/);assert.ok(!JSON.stringify(f.output).includes('test-secret'));
  await assert.rejects(()=>consumeSse(new Response('data: test-secret\n\n'),()=>{}),error=>error instanceof Error&&!error.message.includes('test-secret')&&error.message.includes('invalid stream'));
  await assert.rejects(()=>apiModels('openai',{key:()=> 'test-secret',fetch:async()=>new Response('test-secret')}),error=>error instanceof Error&&!error.message.includes('test-secret')&&error.message.includes('invalid model catalog'));
});
test('Stop aborts the active API request and cannot finish successfully',async t=>{
  let started!:()=>void;const pending=new Promise<void>(resolve=>{started=resolve;});
  const f=await fixture(t,'google',async(_url,init)=>{started();return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}));});
  await f.adapter.send('Hello');await pending;await f.adapter.interrupt();
  assert.equal(f.output.at(-1).type,'interrupted');assert.equal(f.calls.length,0);
});
test('API catalogs paginate, filter non-chat Google models and do not leak keys in URLs',async()=>{
  let requests=0;const models=await apiModels('google',{key:()=> 'private',fetch:async(url,init)=>{
    requests++;assert.ok(!String(url).includes('private'));assert.equal((init?.headers as any)['x-goog-api-key'],'private');
    return Response.json(requests===1?{models:[{name:'models/gemini-chat',displayName:'Chat',supportedGenerationMethods:['generateContent'],inputTokenLimit:100000},{name:'models/embed',supportedGenerationMethods:['embedContent']}],nextPageToken:'next'}:{models:[{name:'models/gemini-next',supportedGenerationMethods:['generateContent']}]});
  }});assert.deepEqual(models.map(m=>m.id),['gemini-chat','gemini-next']);assert.equal(requests,2);
});
test('credentials are private, replaceable, removable, and absent from broker snapshots and SQLite',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-api-core-'));const core=new Core(new Store(directory));
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  await core.rpc('provider.credentials',{provider:'openai',key:'fixture-super-secret'});
  const file=join(directory,'credentials/provider-credentials.json');assert.equal((await stat(file)).mode&0o777,0o600);
  assert.ok(!JSON.stringify(core.snapshot()).includes('fixture-super-secret'));assert.ok(!JSON.stringify(core.store.db.prepare('SELECT * FROM meta').all()).includes('fixture-super-secret'));
  const created=await core.create({provider:'openai',model:'custom-model'});assert.equal(created.provider,'openai');assert.equal(created.nativeId,null);
  const adapter=core.factory(created,{token:'test',event(){},native(){},approve:async()=>({choice:'deny'})});
  assert.ok(adapter instanceof ApiAdapter);await adapter.close();
  core.settings.memory.enabled=true;core.memory.active=()=>true;
  assert.ok(!core.toolsFor(created.id).some(t=>t.function.name.startsWith('memory_')));
  core.settings.memory.allowCloudMemory=true;assert.ok(core.toolsFor(created.id).some(t=>t.function.name==='memory_search'));
  await assert.rejects(()=>core.create({provider:'openai',model:'custom-model',nativeId:'cli-history',handoffConfirmed:true}),/stored by Cere/);
  core.store.set('api:'+created.id,[{role:'user',content:'erase this'}]);eraseWorkingCopies(core.store,created,text=>text.includes('erase this'));
  assert.ok(!JSON.stringify(core.store.get('api:'+created.id,[])).includes('erase this'));
  await core.rpc('provider.credentials',{provider:'openai',key:''});assert.ok(!(await readFile(file,'utf8')).includes('fixture-super-secret'));assert.equal(core.store.session(created.id).status,'idle');
});
test('credentials honor standard environment variables and reject invalid keys',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-keys-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const previous=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='environment-key';t.after(()=>{if(previous===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previous;});
  const credentials=new ProviderCredentials(directory);assert.equal(credentials.key('google'),'environment-key');
  credentials.update('google','saved-key');assert.equal(credentials.key('google'),'saved-key');credentials.update('google','');assert.equal(credentials.key('google'),'environment-key');
  assert.throws(()=>credentials.update('google','bad\nkey'),/whitespace/);
});
test('Core dispatches all API providers and resumes saved history after disconnect without CLI state',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-api-dispatch-')), core=new Core(new Store(directory));
  const original=globalThis.fetch,requests:any[]=[];
  globalThis.fetch=async(url,init)=>{
    const target=String(url),provider=target.includes('api.openai.com')?'openai':target.includes('api.anthropic.com')?'anthropic':'google';
    requests.push({provider,body:JSON.parse(String(init?.body))});return sse(events(provider));
  };
  t.after(async()=>{await core.close();globalThis.fetch=original;await rm(directory,{recursive:true,force:true});});
  for(const provider of apiProviders){
    await core.rpc('provider.credentials',{provider,key:'fixture-key'});
    const s=await core.create({provider,model:'fixture-model'});
    await core.send({id:s.id,text:'Remember this turn'});await (core.adapters.get(s.id) as ApiAdapter).task;core.flush();
    assert.equal(core.store.session(s.id).status,'idle');assert.equal(core.store.messages(s.id).at(-1)?.text,'Hello 🌙');
    assert.equal(core.store.session(s.id).nativeId,null);await core.disconnect(s.id);
    await core.send({id:s.id,text:'Continue'});await (core.adapters.get(s.id) as ApiAdapter).task;
    assert.ok(JSON.stringify(requests.at(-1).body).includes('Remember this turn'));assert.equal(core.store.session(s.id).status,'idle');
  }
  assert.equal(requests.length,6);
});
test('switching API models continues the same conversation with portable history and no tool replay',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-api-switch-')),core=new Core(new Store(directory));
  const original=globalThis.fetch,requests:any[]=[];let attempt=0,calls=0;
  globalThis.fetch=async(url,init)=>{
    const target=String(url),provider=target.includes('api.openai.com')?'openai':target.includes('api.anthropic.com')?'anthropic':'google';
    requests.push({url:target,body:JSON.parse(String(init?.body))});return sse(events(provider,++attempt===1));
  };
  core.toolsFor=()=>[tool];core.callTool=async()=>{calls++;return {evidence:'tool-result-evidence'};};
  t.after(async()=>{await core.close();globalThis.fetch=original;await rm(directory,{recursive:true,force:true});});
  for(const provider of apiProviders){
    attempt=0;calls=0;await core.rpc('provider.credentials',{provider,key:'fixture-key'});
    const s=await core.create({provider,model:'first-model',cwd:directory,tools:true,trusted:true});
    await core.send({id:s.id,text:'Remember this request'});await (core.adapters.get(s.id) as ApiAdapter).task;core.flush();
    const transcript=structuredClone(core.store.messages(s.id));assert.equal(calls,1);
    await core.configureSession({id:s.id,model:'second-model'});
    assert.deepEqual(core.store.messages(s.id),transcript);
    await core.send({id:s.id,text:'Continue using the recorded result'});await (core.adapters.get(s.id) as ApiAdapter).task;core.flush();
    const request=requests.at(-1),body=JSON.stringify(request.body);
    assert.equal(provider==='google'?request.url.includes('models/second-model:'):request.body.model==='second-model',true);
    assert.ok(body.includes('Remember this request'));assert.ok(body.includes('tool-result-evidence'));assert.ok(body.includes('Hello 🌙'));
    assert.ok(!body.includes('opaque-reasoning'));assert.ok(!body.includes('keep-this-signature'));
    assert.equal(calls,1);assert.equal(core.store.session(s.id).status,'idle');assert.equal(core.store.session(s.id).model,'second-model');
  }
});
