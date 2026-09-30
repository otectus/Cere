import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { messageTokens, OllamaAdapter, ollamaContext, ollamaHost, ollamaModels } from '../broker/ollama.ts';
import type { OllamaMessage } from '../broker/ollama.ts';
import type { Hooks } from '../broker/providers.ts';
import { defaultPersonality } from '../broker/personality.ts';

const model = (id: string, capabilities = ['completion','tools','vision','thinking']) => ({ model: id, name: id, capabilities, details: { parameter_size: '3B' } });
const catalog = [model('chat:latest'), model('plain:latest',['completion']), model('remote-cloud',['completion','tools']), model('embed:latest',['embedding'])];
function reply(res: ServerResponse, content: string, extra = {}) { res.end(JSON.stringify({message:{role:'assistant',content,...extra},done:true})+'\n'); }
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now()+timeout;
  while (!check()) { if (Date.now()>end) throw new Error('Condition timed out'); await new Promise(r=>setTimeout(r,5)); }
}
async function fixture(t: any, handle: (body: any, res: ServerResponse, index: number) => void = (_b,res)=>reply(res,'Hello'), models: any[] = structuredClone(catalog)) {
  const directory = await mkdtemp(join(tmpdir(),'cere-ollama-')), requests: any[] = [];
  const server = createServer(async (req,res) => {
    let text=''; for await(const chunk of req) text+=chunk;
    const body=text?JSON.parse(text):{};
    res.setHeader('Content-Type','application/x-ndjson');
    if(req.url==='/api/tags') res.end(JSON.stringify({models:models.map(({show,...entry})=>entry)}));
    else if(req.url==='/api/show') { const entry=models.find(m=>m.model===body.model);res.end(JSON.stringify(entry?.show||entry||{error:'model not found'})); }
    else if(req.url==='/api/chat') { requests.push(body); handle(body,res,requests.length-1); }
    else {res.statusCode=404;res.end('{}');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const host='http://127.0.0.1:'+(server.address() as any).port;
  const store=new Store(directory);store.set('settings',{ollama:{host,model:''}});
  const state={core:new Core(store),directory,host,requests,server};
  await state.core.refreshProviderModels('ollama');
  t.after(async()=>{await state.core.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});});
  return state;
}
async function session(f: Awaited<ReturnType<typeof fixture>>, tools=false) {return f.core.create({provider:'ollama',model:'chat:latest',cwd:f.directory,trusted:tools,tools});}
async function finished(core: Core,id: string){await until(()=>['idle','error','interrupted'].includes(core.store.session(id).status));core.flush();}

test('context capacity follows model metadata across architectures, not runtime defaults',()=>{
  for(const architecture of ['llama','gptoss','gemma4','nemotron_h_moe','nemotron-3-nano','future_arch','']) {
    for(const length of [2048,32768,131072,262144,1048576]) {
      for(const configured of [4096,2097152]) {
        const info={model_info:{'clip.context_length':77,'vision.context_length':512,'general.architecture':architecture,[architecture+'.context_length']:length},parameters:`num_ctx ${configured}`};
        assert.deepEqual(ollamaContext(info),{length,source:'model'},`${architecture}: ${length}`);
      }
    }
  }
  assert.deepEqual(ollamaContext({details:{context_length:'262144'},parameters:'num_ctx 2048'}),{length:262144,source:'model'});
  assert.deepEqual(ollamaContext({model_info:{'unfamiliar.context_length':65536}}),{length:65536,source:'model'});
  assert.deepEqual(ollamaContext({details:{family:'llama'},model_info:{'clip.context_length':77,'llama.context_length':32768}}),{length:32768,source:'model'});
});

test('context metadata validation and legacy fallbacks never invent a model capacity',()=>{
  for(const value of [null,true,false,0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'NaN','Infinity','-1','1.5','65536oops',[],{}]) {
    assert.deepEqual(ollamaContext({model_info:{'general.architecture':'test','test.context_length':value},details:{context_length:value},parameters:{num_ctx:value}}),{length:8192,source:'fallback'});
  }
  for(const parameters of ['num_ctx 32768','temperature 0.7\n  num_ctx\t32768  \r\nstop "hello"',{num_ctx:32768}]) {
    assert.deepEqual(ollamaContext({parameters}),{length:32768,source:'parameters'});
  }
  for(const info of [undefined,{}, {model_info:{'clip.context_length':77}}, {model_info:{'a.context_length':65536,'b.context_length':131072}},
    {model_info:{'general.architecture':'missing','vision.context_length':512}}, {parameters:'num_ctx 8192garbage'}]) {
    assert.deepEqual(ollamaContext(info),{length:8192,source:'fallback'});
  }
});

test('all catalog metadata shapes use their full window for long turns and every tool request',async t=>{
  const variants=[
    {...model('local'),parameters:'num_ctx 4096',model_info:{'general.architecture':'llama','llama.context_length':32768}},
    {...model('multimodal'),model_info:{'clip.context_length':77,'general.architecture':'gemma4','gemma4.context_length':32768}},
    {...model('cloud'),remote_host:'https://ollama.com',model_info:{'general.architecture':'','.context_length':32768}},
    {...model('tags-only'),details:{context_length:32768},show:{capabilities:['completion','tools','vision']}},
    {...model('show-only'),show:{capabilities:['completion','tools','vision'],model_info:{'new_arch.context_length':32768}}},
    {...model('configured-only'),parameters:'num_ctx 32768'},
    {...model('unavailable-embedding',['embedding']),show:{error:'embedding metadata unavailable'}},
  ];
  const f=await fixture(t,(_body,res,index)=>index%2===0?reply(res,'',{tool_calls:[{function:{name:'test_evidence',arguments:{}}}]}):reply(res,'Done'),variants);
  assert.equal(f.core.capabilities.ollama.models.length,6);
  const user='Long user text. '.repeat(1400),evidence='Detailed evidence. '.repeat(1100);
  for(const option of f.core.capabilities.ollama.models) {
    assert.equal(option.contextLength,32768);assert.match(option.description,/Context: 32,768 tokens/);
    const s=await f.core.create({provider:'ollama',model:option.id,cwd:f.directory});
    f.core.toolsFor=()=>[{type:'function',function:{name:'test_evidence',description:'Return evidence',parameters:{type:'object',properties:{}}}}];
    f.core.callTool=async()=>({evidence});
    await f.core.send({id:s.id,text:user});await finished(f.core,s.id);
    assert.equal(f.core.store.session(s.id).status,'idle',option.id+': '+f.core.store.session(s.id).error);
    const requests=f.requests.filter(r=>r.model===option.id);assert.equal(requests.length,2);
    for(const request of requests) {
      assert.equal(request.options.num_ctx,32768);assert.equal(request.messages.find((m:any)=>m.role==='user').content,user);
      assert.ok(request.messages.reduce((sum:number,m:OllamaMessage)=>sum+messageTokens(m),0)<32768);
    }
    assert.equal(JSON.parse(requests[1].messages.find((m:any)=>m.role==='tool').content).evidence,evidence);
  }
});

test('context is refreshed after model changes and restart; genuine overflow keeps full history',async t=>{
  const large={...model('large'),model_info:{'llama.context_length':32768}};
  const models=[large, {...model('small'),details:{context_length:4096},parameters:'num_ctx 131072'}];
  const f=await fixture(t,(_body,res)=>reply(res,'Answer'),models);
  const s=await f.core.create({provider:'ollama',model:'large',cwd:f.directory});
  const text='User text. '.repeat(1900);
  await f.core.send({id:s.id,text});await finished(f.core,s.id);assert.equal(f.core.store.session(s.id).status,'idle');
  await f.core.close();f.core=new Core(new Store(f.directory));
  await f.core.send({id:s.id,text:'Continue'});await finished(f.core,s.id);
  assert.equal(f.requests[1].options.num_ctx,32768);assert.equal(f.requests[1].messages[1].content,text);
  await f.core.configureSession({id:s.id,model:'small',tools:false});
  await f.core.send({id:s.id,text:'Short turn'});await finished(f.core,s.id);
  assert.equal(f.requests[2].options.num_ctx,4096);assert.ok(!f.requests[2].messages.some((m:any)=>m.content===text));
  await f.core.send({id:s.id,text});await finished(f.core,s.id);
  assert.equal(f.requests.length,3);assert.match(f.core.store.session(s.id).error!,/exceeds.*tokens; .*available for conversation/);
  assert.equal(f.core.store.get<OllamaMessage[]>('ollama:'+s.id,[]).filter(m=>m.content===text).length,2);
  await f.core.configureSession({id:s.id,model:'large',tools:false});
  large.model_info['llama.context_length']=65536;
  await f.core.send({id:s.id,text:'Continue with the larger model'});await finished(f.core,s.id);
  assert.equal(f.core.store.session(s.id).status,'idle');assert.equal(f.requests.at(-1).options.num_ctx,65536);
});

test('Ollama URLs are explicit, and catalogs exclude embeddings and identify cloud models',async t=>{
  assert.equal(ollamaHost('localhost:11434/'),'http://localhost:11434');
  assert.equal(ollamaHost('https://example.test/ollama/'),'https://example.test/ollama');
  for(const url of ['file:///tmp','https://user:password@host','https://host/?key=secret','https://host/#part',''])assert.throws(()=>ollamaHost(url));
  const f=await fixture(t),models=await ollamaModels(f.host);
  assert.deepEqual(models.map(m=>m.id),['chat:latest','plain:latest','remote-cloud']);
  assert.equal(models[2].cloud,true);assert.equal(models[0].capabilities?.includes('vision'),true);
});

test('remote Ollama distinguishes preflight failure, missing acknowledgement and explicit HTTP rejection',async t=>{
  const f=await fixture(t,(_body,res,index)=>{if(index===0)res.destroy();else{res.statusCode=503;res.end(JSON.stringify({error:'busy'}));}});
  const s=await session(f),events:any[]=[];let history:OllamaMessage[]=[];
  const adapter=new OllamaAdapter(s,{token:'fixture',event:event=>events.push(event),native(){},async approve(){return{choice:'deny'};}},{load:()=>structuredClone(history),save:messages=>{history=structuredClone(messages);},tools:()=>[],async call(){}});
  t.after(()=>adapter.close());
  const missing:string[]=[];
  await assert.rejects(adapter.send('No acknowledgement',[],{beforeAccept:()=>missing.push('authorized'),onDispatched:()=>missing.push('dispatched'),onAccepted:()=>missing.push('accepted'),onRejected:()=>missing.push('rejected')}),/Cannot reach Ollama/);
  assert.deepEqual(missing,['authorized','dispatched']);await until(()=>!adapter.task);
  const rejected:string[]=[];
  await assert.rejects(adapter.send('Rejected',[],{beforeAccept:()=>rejected.push('authorized'),onDispatched:()=>rejected.push('dispatched'),onAccepted:()=>rejected.push('accepted'),onRejected:()=>rejected.push('rejected')}),/Ollama \(503\): busy/);
  assert.deepEqual(rejected,['authorized','dispatched','rejected']);await until(()=>!adapter.task);
  const preflight:string[]=[];
  adapter.session={...s,model:'embed:latest'};
  await assert.rejects(adapter.send('Unsupported',[],{beforeAccept:()=>preflight.push('authorized'),onDispatched:()=>preflight.push('dispatched'),onAccepted:()=>preflight.push('accepted')}),/cannot chat/);
  assert.deepEqual(preflight,[]);await until(()=>!adapter.task);
});

test('default model persists, sessions pin it and their endpoint, and old settings gain Ollama defaults',async t=>{
  const f=await fixture(t);await assert.rejects(f.core.create({provider:'ollama'}),/Choose an Ollama model/);
  await f.core.updateSettings({ollama:{model:'chat:latest'}});
  const s=await f.core.create({provider:'ollama'});assert.equal(s.model,'chat:latest');assert.equal(s.ollama?.host,f.host);assert.equal(s.ollama?.tools,false);
  await f.core.updateSettings({ollama:{model:'plain:latest'}});assert.equal(f.core.store.session(s.id).model,'chat:latest');
  await assert.rejects(f.core.updateSettings({ollama:{model:'missing'}}),/available/);
  await f.core.close();f.core=new Core(new Store(f.directory));assert.equal(f.core.settings.ollama.model,'plain:latest');
  await f.core.updateSettings({ollama:{host:f.host+'/new'}});assert.equal(f.core.settings.ollama.model,'');assert.equal(f.core.store.session(s.id).ollama?.host,f.host);
  const legacy=new Store(join(f.directory,'legacy'));legacy.set('settings',{quiet:true});assert.equal(legacy.settings().quiet,true);assert.ok(legacy.settings().ollama.host);legacy.close();
});

test('streamed Unicode, thinking and conversation history survive disconnect and broker restart',async t=>{
  const f=await fixture(t,(_body,res,index)=>{
    const data=Buffer.from(JSON.stringify({message:{role:'assistant',content:index?'Welcome back':'Hello ✦',thinking:'private reasoning'},done:false})+'\n'+JSON.stringify({message:{content:'!'},done:true}));
    const split=data.indexOf(Buffer.from('✦'))+1;res.write(data.subarray(0,split));res.end(data.subarray(split));
  });
  const s=await session(f);await f.core.send({id:s.id,text:'Remember this'});await finished(f.core,s.id);
  assert.equal(f.core.store.messages(s.id).filter(m=>m.role==='assistant')[0].text,'Hello ✦!');
  assert.equal(f.requests[0].tools,undefined);
  await f.core.rpc('session.disconnect',{id:s.id});await f.core.send({id:s.id,text:'Second turn'});await finished(f.core,s.id);
  assert.equal(f.requests[1].messages.find((m:any)=>m.role==='assistant').thinking,'private reasoning');
  assert.equal(f.requests[1].messages.filter((m:any)=>m.role==='user').length,2);
  await f.core.close();f.core=new Core(new Store(f.directory));await f.core.send({id:s.id,text:'Third turn'});await finished(f.core,s.id);
  assert.equal(f.requests[2].messages.filter((m:any)=>m.role==='user').length,3);
  assert.equal(f.core.store.messages(s.id).length,6);
});

test('Ollama uses the saved personality on the next turn and never stores it in conversation history',async t=>{
  const f=await fixture(t),s=await session(f);
  for(const personality of [defaultPersonality,'Be calm and direct.','']){
    await f.core.updateSettings({personality});await f.core.send({id:s.id,text:'Hello'});await finished(f.core,s.id);
    assert.equal(f.core.store.session(s.id).status,'idle');
    const messages=f.requests.at(-1).messages,system=messages[0];
    assert.equal(system.role,'system');assert.equal(messages.filter((m:any)=>m.role==='system').length,1);
    assert.ok(personality?system.content.includes(personality):system.content.includes('neutral voice'));
    if(personality!==defaultPersonality)assert.ok(!system.content.includes(defaultPersonality));
    assert.match(system.content,/You cannot answer approvals yourself/);
    assert.match(system.content,/Desktop control and provider delegation are disabled/);
    assert.ok(f.core.store.get<OllamaMessage[]>('ollama:'+s.id,[]).every(m=>m.role!=='system'));
  }
  await f.core.updateSettings({personality:'Be gently humorous.'});await f.core.close();f.core=new Core(new Store(f.directory));
  await f.core.send({id:s.id,text:'After restart'});await finished(f.core,s.id);
  assert.match(f.requests.at(-1).messages[0].content,/Be gently humorous/);
});

test('a personality edit during an Ollama tool round waits until the next user turn',async t=>{
  const f=await fixture(t,(_b,res,index)=>{
    if(index===0){void f.core.updateSettings({personality:'New quiet voice'});reply(res,'',{tool_calls:[{function:{name:'timer_start',arguments:{minutes:60,label:'Test'}}}]});}
    else reply(res,'Finished');
  });
  const s=await session(f,true);await f.core.updateSettings({categories:['timers']});
  await f.core.send({id:s.id,text:'Set a timer'});await finished(f.core,s.id);
  assert.equal(f.requests.length,2);
  for(const request of f.requests)assert.ok(request.messages[0].content.includes(defaultPersonality));
  await f.core.send({id:s.id,text:'Thanks'});await finished(f.core,s.id);
  assert.match(f.requests[2].messages[0].content,/New quiet voice/);
});

test('tool calls round-trip with context and disabled tools cannot execute',async t=>{
  const f=await fixture(t,(_b,res,index)=>index%2===0?reply(res,'',{tool_calls:[{function:{name:'timer_start',arguments:{minutes:60,label:'Test'}}}]}):reply(res,'Finished'));
  const s=await session(f,true);await f.core.updateSettings({categories:['timers']});
  const phases:string[]=[];f.core.on('state',state=>{const activity=state.sessions.find((entry:any)=>entry.id===s.id)?.activity;if(activity)phases.push(activity);});
  await f.core.send({id:s.id,text:'Set a timer'});await finished(f.core,s.id);
  assert.equal(f.core.store.timers().length,1);
  assert.ok(f.requests[0].tools.some((t:any)=>t.function.name==='timer_start'));
  assert.ok(f.requests[1].messages.some((m:any)=>m.role==='tool'&&m.tool_name==='timer_start'&&m.content.includes('Test')));
  const working=phases.indexOf('working');assert.ok(working>=0);assert.equal(phases.slice(working+1).includes('thinking'),true);
  await f.core.updateSettings({paused:true});await f.core.send({id:s.id,text:'Another'});await finished(f.core,s.id);
  assert.equal(f.core.store.timers().length,1);assert.equal(f.requests[2].tools,undefined);
  assert.match(f.requests[3].messages.at(-1).content,/not offered/);
});

test('truncated streams and server errors become actionable errors without replay',async t=>{
  const f=await fixture(t,(_b,res,index)=>{if(index===0)res.end('{"message":{"content":"Partial"},"done":false}\n');else if(index===1){res.statusCode=503;res.end('{"error":"model unavailable"}');}else reply(res,'Recovered');});
  const s=await session(f);await f.core.send({id:s.id,text:'First'});await finished(f.core,s.id);assert.match(f.core.store.session(s.id).error||'',/disconnected/);
  await f.core.send({id:s.id,text:'Second'});await finished(f.core,s.id);assert.match(f.core.store.session(s.id).error||'',/503.*unavailable/);
  await f.core.send({id:s.id,text:'Third'});await finished(f.core,s.id);assert.equal(f.core.store.session(s.id).status,'idle');assert.equal(f.requests.length,3);
});

test('Stop aborts a streaming request and a later turn can proceed',async t=>{
  let responseClosed=false;
  const f=await fixture(t,(_b,res,index)=>{if(index){reply(res,'Next');return;}res.write('{"message":{"content":"Starting"},"done":false}\n');res.on('close',()=>responseClosed=true);});
  const s=await session(f);await f.core.send({id:s.id,text:'Long turn'});await until(()=>f.requests.length===1);
  await f.core.stop(s.id);assert.equal(f.core.store.session(s.id).status,'interrupted');await until(()=>responseClosed);
  await f.core.send({id:s.id,text:'Try again'});await finished(f.core,s.id);assert.equal(f.core.store.session(s.id).status,'idle');
});

test('approved images are encoded and persisted, unsupported models and non-images fail before chat',async t=>{
  const f=await fixture(t);const image=join(f.directory,'image.png'),secret=join(f.directory,'secret.txt');
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0]);await writeFile(image,bytes);await writeFile(secret,'not an image');
  const s=await session(f);await f.core.send({id:s.id,text:'Describe',images:[image]});await finished(f.core,s.id);
  assert.deepEqual(f.requests[0].messages.at(-1).images,[bytes.toString('base64')]);
  await assert.rejects(f.core.configureSession({id:s.id,model:'plain:latest',tools:false}),/contains images/);
  await f.core.send({id:s.id,text:'Secret',images:[secret]});await finished(f.core,s.id);assert.match(f.core.store.session(s.id).error||'',/PNG/);assert.equal(f.requests.length,1);
  const plain=await f.core.create({provider:'ollama',model:'plain:latest'});await f.core.send({id:plain.id,text:'Image',images:[image]});await finished(f.core,plain.id);assert.match(f.core.store.session(plain.id).error||'',/does not support images/);
});

test('model changes require an idle session, preserve defaults, and tool mode needs project trust',async t=>{
  const f=await fixture(t),s=await session(f);
  await assert.rejects(f.core.configureSession({id:s.id,model:'chat:latest',tools:true}),/trust/);
  await f.core.configureSession({id:s.id,model:'chat:latest',tools:true,trusted:true});assert.equal(f.core.store.session(s.id).ollama?.tools,true);
  await assert.rejects(f.core.configureSession({id:s.id,model:'plain:latest',tools:true}),/support tools/);
  await f.core.configureSession({id:s.id,model:'plain:latest',tools:false});assert.equal(f.core.store.session(s.id).model,'plain:latest');assert.equal(f.core.settings.ollama.model,'');
  f.core.updateSession(s.id,{status:'working'});await assert.rejects(f.core.configureSession({id:s.id,model:'chat:latest',tools:false}),/Stop/);f.core.updateSession(s.id,{status:'idle'});
});

test('delegation needs approval, creates visible owned sessions, and returns provider results',async t=>{
  let childId='';
  const f=await fixture(t,(body,res,index)=>{
    if(index===0)reply(res,'',{tool_calls:[{function:{name:'sessions_start',arguments:{provider:'codex',prompt:'Review the project'}}}]});
    else if(index===1){childId=JSON.parse(body.messages.at(-1).content).id;reply(res,'',{tool_calls:[{function:{name:'sessions_wait',arguments:{id:childId,seconds:1}}}]});}
    else reply(res,'Review complete');
  });
  const actual=f.core.factory,sent:any[]=[];
  f.core.factory=(s,h)=>s.provider==='ollama'?actual(s,h):{async send(text){sent.push({s,text});h.event({type:'message',text:'Provider result'});h.event({type:'complete'});},async interrupt(){h.event({type:'complete',text:'interrupted'});},async close(){}};
  const s=await session(f,true);await f.core.updateSettings({categories:['providers']});await f.core.send({id:s.id,text:'Delegate a review'});
  await until(()=>f.core.approvals.size===1);assert.equal(sent.length,0);
  const approval=f.core.snapshot().approvals[0];assert.match(approval.detail,/Review the project/);f.core.answer({id:approval.id,choice:'allow'});
  await finished(f.core,s.id);assert.equal(sent.length,1);assert.equal(f.core.store.session(childId).parentId,s.id);
  assert.match(f.requests[2].messages.at(-1).content,/Provider result/);
  const other=await f.core.create({provider:'claude',cwd:f.directory,trusted:true});
  await assert.rejects(f.core.callTool(s.id,'sessions_read',{id:other.id},new AbortController().signal),/own delegated/);
  await assert.rejects(f.core.callTool(s.id,'sessions_start',{provider:'ollama',prompt:'Recursive'},new AbortController().signal),/Invalid provider/);
});

test('revoking orchestration during approval prevents sending, and Stop cancels pending delegation',async t=>{
  const f=await fixture(t,(_b,res,index)=>index===0?reply(res,'',{tool_calls:[{function:{name:'sessions_start',arguments:{provider:'claude',prompt:'Task'}}}]}):reply(res,'Declined'));
  const s=await session(f,true);await f.core.updateSettings({categories:['providers']});await f.core.send({id:s.id,text:'Delegate'});await until(()=>f.core.approvals.size===1);
  await f.core.updateSettings({paused:true});f.core.answer({id:f.core.snapshot().approvals[0].id,choice:'allow'});await finished(f.core,s.id);
  assert.equal(f.core.store.sessions().length,1);assert.match(f.requests[1].messages.at(-1).content,/disabled/);
  await f.core.updateSettings({paused:false});
  const controller=new AbortController(),pending=f.core.callTool(s.id,'sessions_start',{provider:'claude',prompt:'Task'},controller.signal);
  await until(()=>f.core.approvals.size===1);controller.abort();f.core.cancelApprovals(s.id);await assert.rejects(pending,/declined/);assert.equal(f.core.store.sessions().length,1);
});

test('stopping an orchestrator also stops its active delegated turn and clears approvals',async t=>{
  const f=await fixture(t,(body,res,index)=>{
    if(index===0)reply(res,'',{tool_calls:[{function:{name:'sessions_start',arguments:{provider:'codex',prompt:'Long task'}}}]});
    else reply(res,'',{tool_calls:[{function:{name:'sessions_wait',arguments:{id:JSON.parse(body.messages.at(-1).content).id}}}]});
  });
  const actual=f.core.factory;let childHooks:Hooks|undefined;
  f.core.factory=(s,h)=>s.provider==='ollama'?actual(s,h):{async send(){childHooks=h;},async interrupt(){h.event({type:'complete',text:'interrupted'});},async close(){}};
  const s=await session(f,true);await f.core.updateSettings({categories:['providers']});await f.core.send({id:s.id,text:'Delegate'});await until(()=>f.core.approvals.size===1);f.core.answer({id:f.core.snapshot().approvals[0].id,choice:'allow'});
  await until(()=>f.requests.length===2&&!!childHooks);
  await f.core.stop(s.id);assert.equal(f.core.store.session(s.id).status,'interrupted');assert.equal(f.core.store.sessions().find(c=>c.parentId===s.id)?.status,'interrupted');assert.equal(f.core.approvals.size,0);
});

test('a recovered tool request is marked unknown and never automatically re-executed',async t=>{
  const f=await fixture(t),s=await session(f,true);
  const history:OllamaMessage[]=[{role:'user',content:'Old task'},{role:'assistant',content:'',tool_calls:[{function:{name:'timer_start',arguments:{minutes:1,label:'Old'}}}]}];
  f.core.store.set('ollama:'+s.id,history);await f.core.updateSettings({categories:['timers']});await f.core.send({id:s.id,text:'Continue'});await finished(f.core,s.id);
  assert.equal(f.core.store.timers().length,0);assert.match(f.requests[0].messages.find((m:any)=>m.role==='tool').content,/Outcome unknown/);
});


test('new turns cannot race with a delegated child still acknowledging Stop',async t=>{
  const f=await fixture(t),s=await session(f,true),child=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});
  let release!:()=>void;
  f.core.adapters.set(s.id,{async send(){},async interrupt(){f.core.event(s.id,{type:'complete',text:'interrupted'});},async close(){}});
  f.core.adapters.set(child.id,{async send(){},async interrupt(){await new Promise<void>(r=>release=r);f.core.event(child.id,{type:'complete',text:'interrupted'});},async close(){}});
  f.core.updateSession(s.id,{status:'working'});f.core.updateSession(child.id,{status:'working'});f.core.delegations.set(s.id,new Set([child.id]));
  const stopping=f.core.stop(s.id);await until(()=>!!release);
  await assert.rejects(f.core.send({id:s.id,text:'Too early'}),/busy/);
  release();await stopping;assert.equal(f.core.stopping.size,0);assert.equal(f.core.delegations.size,0);
});

test('a connection change during creation cannot redirect the new session to another host',async t=>{
  const f=await fixture(t),models=f.core.capabilities.ollama.models;
  f.core.capabilities.ollama.modelsStatus='error';
  const pending:{host?:string;resolve:(models:any)=>void}[]=[];
  f.core.modelLoader=(_provider,host)=>new Promise(resolve=>pending.push({host,resolve}));
  const opening=f.core.create({provider:'ollama',model:'chat:latest'});await until(()=>pending.length===1);
  await f.core.updateSettings({ollama:{host:f.host+'/changed'}});assert.equal(pending.length,2);
  pending[0].resolve(models);const s=await opening;assert.equal(s.ollama?.host,f.host);assert.equal(pending[0].host,f.host);
  pending[1].resolve([]);await until(()=>f.core.capabilities.ollama.modelsStatus==='ready');
});

test('CLI bypass enables delegation without desktop bypass or standing grants', async t => {
  const f = await fixture(t), parent = await session(f, true), sent: any[] = [];
  f.core.factory = (s, h) => ({ async send(text) { sent.push({ text, bypass: h.bypassCliPermissions?.() }); h.event({ type: 'complete' }); }, async interrupt() {}, async close() {} });
  await f.core.updateSettings({ profile: 'manual', bypassComputerPermissions: true });
  assert.ok(!f.core.toolsFor(parent.id).some(t => t.function.name === 'sessions_start'));
  await f.core.updateSettings({ bypassComputerPermissions: false, bypassCliPermissions: true });
  assert.ok(f.core.toolsFor(parent.id).some(t => t.function.name === 'sessions_start'));
  assert.ok(!f.core.toolsFor(parent.id).some(t => t.function.name === 'timer_start'));
  const child = await f.core.callTool(parent.id, 'sessions_start', { provider: 'codex', prompt: 'Review only' }, new AbortController().signal);
  await until(() => sent.length === 1);
  assert.equal(f.core.store.session(child.id).parentId, parent.id);
  assert.deepEqual(sent, [{ text: 'Review only', bypass: true }]);
  assert.equal(f.core.approvals.size, 0);
  await f.core.updateSettings({ bypassCliPermissions: false });
  await assert.rejects(f.core.callTool(parent.id, 'sessions_start', { provider: 'codex', prompt: 'Do not send' }, new AbortController().signal), /disabled/);
});
