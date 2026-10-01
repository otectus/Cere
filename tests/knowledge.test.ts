import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { chunks, embed, unitVector } from '../broker/memory.ts';
import { messageTokens, workingContext, ollamaModels } from '../broker/ollama.ts';
import type { OllamaMessage } from '../broker/ollama.ts';
import { WebSearch, loadWeb, parseResults, publicAddress, webUrl } from '../broker/web.ts';

const signal = () => new AbortController().signal;
const source = { title: 'Ollama documentation', url: 'https://docs.ollama.com/api/embed', snippet: 'Generate embeddings.' };
const html = '<html><body><div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.ollama.com%2Fapi%2Fembed">Ollama documentation</a></h2><a class="result__snippet">Generate embeddings.</a></div></body></html>';
function response(res: ServerResponse, content: string, calls?: any[]) { res.end(JSON.stringify({ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls.map(c => ({function:c})) } : {}) }, done: true })+'\n'); }
async function until(check: () => boolean) { const end=Date.now()+6000;while(!check()){if(Date.now()>end)throw new Error('Timed out');await new Promise(r=>setTimeout(r,5));} }
async function finished(core: Core, id: string) { await until(()=>['idle','error','interrupted'].includes(core.store.session(id).status));core.flush(); }
async function fixture(t: any) {
  const directory=await mkdtemp(join(tmpdir(),'cere-knowledge-'));
  const models=[{model:'chat',capabilities:['completion','tools'],digest:'chat-1'},{model:'plain',capabilities:['completion'],digest:'plain-1'},
    {model:'nomic-embed-text:latest',capabilities:['embedding'],digest:'embed-1'}, {model:'other:latest',capabilities:['embedding'],digest:'other-1'}];
  const requests:any[]=[],embeddings:any[]=[];
  const f={directory,models,requests,embeddings,failEmbed:false,dimensions:3,onEmbed:null as null|((body:any,res:ServerResponse)=>void),
    onChat:(_body:any,res:ServerResponse)=>response(res,'Answer'),core:null as unknown as Core,host:''};
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):{};
    if(req.url==='/api/tags')res.end(JSON.stringify({models:f.models}));
    else if(req.url==='/api/show')res.end(JSON.stringify(f.models.find(m=>m.model===body.model)||{error:'missing model'}));
    else if(req.url==='/api/embed'){
      embeddings.push(body);
      if(f.onEmbed){f.onEmbed(body,res);return;}
      if(f.failEmbed){res.statusCode=503;res.end('{"error":"embedding unavailable"}');return;}
      res.end(JSON.stringify({embeddings:body.input.map((text:string)=>{
        const vector=Array(f.dimensions).fill(0);vector[/coffee|espresso|caffeine|morning drink/i.test(text)?0:/banana|fruit/i.test(text)?1:2]=1;return vector;
      })}));
    }else if(req.url==='/api/chat'){requests.push(body);f.onChat(body,res);}
    else if(req.url?.startsWith('/search?'))res.end(JSON.stringify({results:[{...source,content:source.snippet}]}));
    else if(req.url==='/large')res.end('x'.repeat(2*1024*1024+1));
    else if(req.url==='/redirect'){res.statusCode=302;res.setHeader('Location','http://127.0.0.1/private');res.end();}
    else {res.statusCode=404;res.end('{}');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));f.host='http://127.0.0.1:'+(server.address() as any).port;
  const store=new Store(directory);store.set('settings',{ollama:{host:f.host,model:'chat'}});f.core=new Core(store);
  isolateVectorProjection(t, f.core);
  await f.core.refreshProviderModels('ollama');
  t.after(async()=>{await f.core.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});});
  return f;
}
function isolateVectorProjection(t: any, core: Core) {
  t.mock.method(core.memory.service, 'vectorRepo', async () => { throw new Error('No external vector projection in this fixture'); });
}
async function session(f: Awaited<ReturnType<typeof fixture>>, model='chat', cwd=f.directory) { return f.core.create({provider:'ollama',model,cwd}); }

test('free provider parsers preserve titles and URLs, remove tracking and reject unsafe links',()=>{
  assert.deepEqual(parseResults('duckduckgo',html,'https://html.duckduckgo.com/html/'),[source]);
  const brave='<div data-type="web"><a href="https://docs.ollama.com/api/embed?utm_source=test"><div class="title">Ollama documentation</div></a><div class="snippet"><div class="content">Generate embeddings.</div></div></div>';
  assert.deepEqual(parseResults('brave',brave,'https://search.brave.com'),[source]);
  const mojeek='<ul class="results"><li><h2><a href="https://docs.ollama.com/api/embed">Ollama documentation</a></h2><p class="s">Generate embeddings.</p></li></ul>';
  assert.deepEqual(parseResults('mojeek',mojeek,'https://www.mojeek.com'),[source]);
  assert.equal(parseResults('duckduckgo',html+html,'https://html.duckduckgo.com').length,1);
  for(const url of ['javascript:alert(1)','file:///etc/passwd','http://127.0.0.1/','https://user:secret@example.org/'])
    assert.equal(parseResults('brave',brave.replace('https://docs.ollama.com/api/embed?utm_source=test',url),'https://search.brave.com').length,0);
});

test('automatic search falls back visibly, selected providers stay pinned, cancellation stops fallback',async()=>{
  const calls:string[]=[];
  const web=new WebSearch(async(url)=>{calls.push(url);if(url.includes('duckduckgo'))throw new Error('rate limited');return {url,status:200,contentType:'text/html',text:'<div data-type="web"><a href="https://example.org"><div class="title">Result</div></a></div>'};});
  const result=await web.search('A public query',{enabled:true,provider:'auto',searxngUrl:''},signal());assert.equal(result.provider,'brave');assert.equal(calls.length,2);assert.match(result.fallback![0],/rate limited/);
  calls.length=0;await assert.rejects(web.search('Query',{enabled:true,provider:'duckduckgo',searxngUrl:''},signal()),/rate limited/);assert.equal(calls.length,1);
  const controller=new AbortController();const stopped=new WebSearch(async()=>{controller.abort(new Error('Stopped'));throw new Error('offline');});
  await assert.rejects(stopped.search('Query',{enabled:true,provider:'auto',searxngUrl:''},controller.signal),/Stopped/);
  await assert.rejects(web.search('x'.repeat(501),{enabled:true,provider:'auto',searxngUrl:''},signal()),/500/);
});

test('page reading blocks local addresses, unsafe schemes, oversized content and server redirects',async t=>{
  const f=await fixture(t);
  for(const url of ['file:///etc/passwd','http://localhost/','http://127.1/','http://2130706433/','http://[::1]/','http://[::ffff:127.0.0.1]/','http://user:pass@example.org/','http://printer.local/'])assert.throws(()=>webUrl(url));
  for(const ip of ['10.0.0.1','172.16.1.1','169.254.169.254','192.168.1.1','100.64.0.1','::1','fc00::1','2001:db8::1'])assert.equal(publicAddress(ip),false);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  await assert.rejects(loadWeb(f.host,signal()),/public/);
  await assert.rejects(loadWeb(f.host+'/large',signal(),{trustedServer:true}),/2 MB/);
  await assert.rejects(loadWeb(f.host+'/redirect',signal(),{trustedServer:true}),/redirected/);
  const result=await new WebSearch().search('embeddings',{enabled:true,provider:'searxng',searxngUrl:f.host},signal());assert.deepEqual(result.results,[source]);
  const web=new WebSearch(async url=>({url,status:200,contentType:'text/html',text:'<html><head><title>Page</title></head><body><nav>Navigation</nav><main>Useful text<script>malicious()</script></main></body></html>'}));
  const page=await web.read('https://example.org',signal());assert.equal(page.text,'Useful text');
});

test('new settings migrate cleanly and reject invalid choices without partial writes',async t=>{
  const f=await fixture(t);assert.equal(f.core.settings.memory.model,'nomic-embed-text');assert.equal(f.core.settings.webSearch.enabled,false);
  for(const patch of [{memory:{enabled:'yes'}},{memory:{model:'bad\nmodel'}},{webSearch:{provider:'unknown'}},{webSearch:{enabled:true,provider:'searxng'}},{webSearch:{searxngUrl:'file:///tmp'}}])await assert.rejects(f.core.updateSettings(patch));
  assert.equal(f.core.settings.webSearch.enabled,false);
  const models=await ollamaModels(f.host,'embedding');assert.deepEqual(models.map(m=>m.id),['nomic-embed-text:latest','other:latest']);
});

test('nomic uses retrieval prefixes, validates vectors and never silently truncates',async t=>{
  const f=await fixture(t);
  await embed(f.host,'nomic-embed-text',['coffee'],'query',signal());assert.equal(f.embeddings[0].input[0],'search_query: coffee');assert.equal(f.embeddings[0].truncate,false);
  await embed(f.host,'nomic-embed-text:latest',['espresso'],'document',signal());assert.equal(f.embeddings[1].input[0],'search_document: espresso');
  const long='☕'.repeat(1800);const vector=await embed(f.host,'nomic-embed-text',[long],'document',signal());assert.equal(vector.length,1);
  assert.equal(f.embeddings[2].input.map((s:string)=>s.replace('search_document: ','')).join(''),long);
  assert.ok(f.embeddings[2].input.every((s:string)=>Array.from(s).length<510));
  for(const value of [[],[0,0],[Infinity,1],[1,'2'],[NaN]])assert.throws(()=>unitVector(value));
  f.onEmbed=(_b,res)=>res.end('{"embeddings":[[1,0],[0,1,0]]}');await assert.rejects(embed(f.host,'other',['a','b'],'query',signal()),/inconsistent/);
  const pieces=chunks('😄'.repeat(3000));assert.equal(Array.from(pieces[0]).length,1400);assert.ok(pieces.every(p=>!p.includes('\ufffd')));
});

test('semantic graph memory survives restart, crosses conversations, and stays within project and server',async t=>{
  const f=await fixture(t),s=await session(f);await f.core.updateSettings({memory:{enabled:true}});
  await f.core.memory.capture(s,'I like espresso in the morning.','Your preferred coffee is espresso.');
  const saved=await f.core.memory.save(s,'Coffee should be served without sugar.');
  await f.core.memory.save(s,'Bananas are ripe fruit.');
  let result=await f.core.memory.recall(s,'Which caffeine drink do I prefer?',signal());assert.equal(result.mode,'semantic');assert.ok(result.results.some((r:any)=>r.text.includes('espresso')));assert.ok(!result.results.some((r:any)=>r.text.includes('Bananas')));
  await f.core.close();f.core=new Core(new Store(f.directory));isolateVectorProjection(t, f.core);const next=await session(f);
  result=await f.core.memory.recall(next,'My morning drink',signal());assert.ok(result.results.some((r:any)=>r.id===saved.id));
  await mkdir(join(f.directory,'other'));const other=await session(f,'chat',join(f.directory,'other'));
  assert.equal((await f.core.memory.recall(other,'coffee',signal())).results.length,0);
  assert.equal((await f.core.memory.list({...s,ollama:{host:f.host+'/other',tools:false}})).total,0);
  await assert.rejects(f.core.memory.save(other,'changed',saved.id),/no longer exists/);await assert.rejects(f.core.memory.forget(other,saved.id),/scope/);
});

for (const stage of ['initialize', 'query'] as const) {
  test(`canonical semantic recall survives a vector projection ${stage} timeout`, async t => {
    const f = await fixture(t), s = await session(f);
    await f.core.updateSettings({ memory: { enabled: true } });
    const saved = await f.core.memory.save(s, 'Espresso is my preferred drink.');
    let reached = false;
    const stall = async (guard: AbortSignal) => {
      reached = true;
      guard.throwIfAborted();
      await new Promise((_, reject) => {
        guard.addEventListener('abort', () => reject(guard.reason), { once: true });
        // AbortSignal.timeout does not keep the event loop alive.
        const timer = setTimeout(() => reject(new Error('Projection did not receive a deadline')), 2000);
        guard.addEventListener('abort', () => clearTimeout(timer), { once: true });
      });
    };
    t.mock.method(f.core.memory.service, 'vectorRepo', async (_fingerprint: string, _dimension: number, guard: AbortSignal) => {
      if (stage === 'initialize') await stall(guard);
      return { query: async (request: any) => { await stall(request.deadline); return []; } };
    });
    // No query words occur in the saved text: keyword fallback cannot satisfy this assertion.
    const result = await f.core.memory.recall(s, 'caffeine', signal());
    assert.ok(reached, 'the optional projection was attempted');
    assert.equal(result.mode, 'semantic');
    assert.ok(result.results.some((r: any) => r.id === saved.id));
    assert.ok(result.coverage.includes('semantic_projection_unavailable'));
    assert.ok(result.coverage.includes('deadline_partial'));
  });
}

test('an empty projection preserves local hits, but erasure during projection lookup removes them', async t => {
  const f = await fixture(t), s = await session(f);
  await f.core.updateSettings({ memory: { enabled: true } });
  const saved = await f.core.memory.save(s, 'Espresso is my preferred drink.');
  let erase = false;
  t.mock.method(f.core.memory.service, 'vectorRepo', async () => ({
    query: async () => {
      if (erase) await f.core.memory.forget(s, saved.id);
      return [];
    },
  }));
  const result = await f.core.memory.recall(s, 'caffeine', signal());
  assert.equal(result.mode, 'semantic');
  assert.ok(result.results.some((r: any) => r.id === saved.id));
  erase = true;
  const forgotten = await f.core.memory.recall(s, 'caffeine', signal());
  assert.equal(forgotten.results.length, 0);
  assert.equal(forgotten.evidence.length, 0);
});

test('embedding outages preserve canonical memory; model and digest changes use separate spaces',async t=>{
  const f=await fixture(t),s=await session(f);await f.core.updateSettings({memory:{enabled:true}});
  const saved=await f.core.memory.save(s,'Coffee preference: espresso.');f.failEmbed=true;
  let result=await f.core.memory.recall(s,'coffee',signal());assert.equal(result.mode,'keyword');assert.match(result.warning,/degraded/);assert.equal(result.results[0].id,saved.id);
  f.failEmbed=false;result=await f.core.memory.recall(s,'coffee',signal());assert.equal(result.mode,'semantic');
  f.models[2].digest='embed-2';f.dimensions=4;result=await f.core.memory.recall(s,'coffee',signal());assert.equal(result.mode,'semantic');
  await f.core.updateSettings({memory:{model:'other'}});await f.core.memory.recall(s,'coffee',signal());assert.equal((await f.core.memory.list(s)).total,1);
  await f.core.memory.save(s,'Coffee preference: latte.',saved.id);assert.equal((await f.core.memory.list(s)).rows[0].text,'Coffee preference: latte.');
  const current=await f.core.memory.recall(s,'coffee',signal());assert.ok(!current.results.some((r:any)=>r.text.includes('espresso')));
});

test('clear and disable invalidate in-flight embeddings without resurrecting memories',async t=>{
  const f=await fixture(t),s=await session(f);await f.core.updateSettings({memory:{enabled:true}});await f.core.memory.save(s,'Coffee espresso');
  let reached=false;f.onEmbed=()=>{reached=true;};
  const pending=f.core.memory.recall(s,'coffee',signal());await until(()=>reached);await f.core.memory.clear(s);const result=await pending;
  assert.equal(result.results.length,0);assert.equal(f.core.memory.summary().total,0);
  reached=false;await f.core.memory.save(s,'Coffee espresso');const disabled=f.core.memory.recall(s,'coffee',signal());await until(()=>reached);await f.core.updateSettings({memory:{enabled:false}});await disabled;
  assert.equal((await f.core.memory.recall(s,'coffee',signal())).mode,'disabled');assert.equal((await f.core.memory.list(s)).total,1);
});

test('bounded context preserves complete tool cycles and rejects oversized current turns',()=>{
  const messages:OllamaMessage[]=[{role:'user',content:'Old '.repeat(1000)},{role:'assistant',content:'Old reply'},{role:'user',content:'Recent'},
    {role:'assistant',content:'',tool_calls:[{function:{name:'web_search',arguments:{query:'test'}}}]},{role:'tool',tool_name:'web_search',content:'Evidence'},{role:'assistant',content:'Answer'}];
  const budget=messages.slice(2).reduce((sum,m)=>sum+messageTokens(m),0);
  const selected=workingContext(messages,budget);assert.deepEqual(selected.messages,messages.slice(2));assert.equal(selected.omitted,2);
  assert.throws(()=>workingContext(messages,1),/exceeds/);
  const large:OllamaMessage[]=[{role:'user',content:'Research this'},messages[3],{role:'tool',content:'x'.repeat(20000),tool_name:'web_search'}];
  const bounded=workingContext(large,1600);assert.equal(bounded.messages.length,3);assert.equal(bounded.shortened,true);assert.ok(bounded.messages.reduce((sum,m)=>sum+messageTokens(m),0)<=1600);assert.equal(large[2].content.length,20000);
});

test('editing or deleting a fact while it is embedding cannot restore stale content',async t=>{
  const f=await fixture(t),s=await session(f);await f.core.updateSettings({memory:{enabled:true}});
  const fact=await f.core.memory.save(s,'Coffee: espresso');
  let release: (()=>void)|undefined;
  f.onEmbed=(body,res)=>{
    if(body.input[0].startsWith('search_document:'))release=()=>res.end(JSON.stringify({embeddings:body.input.map(()=>[1,0,0])}));
    else res.end('{"embeddings":[[1,0,0]]}');
  };
  const pending=f.core.memory.recall(s,'coffee',signal());await until(()=>!!release);
  await f.core.memory.save(s,'Coffee: latte',fact.id);release!();await pending;
  assert.equal((await f.core.memory.list(s)).rows[0].text,'Coffee: latte');
});

test('Ollama can use search and memory without desktop access, with persisted source links',async t=>{
  const f=await fixture(t),s=await session(f);await f.core.updateSettings({webSearch:{enabled:true},memory:{enabled:true},profile:'manual'});
  f.core.web=new WebSearch(async url=>({url,status:200,contentType:'text/html',text:html}));
  f.onChat=(body,res)=>{
    const n=f.requests.length;
    if(n===1)response(res,'',[{name:'web_search',arguments:{query:'Ollama embeddings'}}]);
    else if(n===2)response(res,'',[{name:'memory_save',arguments:{text:'My morning drink is espresso.'}}]);
    else response(res,'Here is the answer [Ollama](https://docs.ollama.com/api/embed).');
  };
  await f.core.send({id:s.id,text:'Search online, and remember that I drink espresso.'});await finished(f.core,s.id);
  assert.equal(f.core.store.session(s.id).status,'idle',f.core.store.session(s.id).error);assert.ok(f.requests[0].tools.some((t:any)=>t.function.name==='web_search'));assert.ok(!f.requests[0].tools.some((t:any)=>t.function.name==='script_run'));
  assert.equal((await f.core.memory.list(s)).total,1);assert.equal(f.core.store.messages(s.id).at(-1)?.sources?.[0].url,source.url);
  assert.ok(f.core.memory.summary().total>=3);
  const next=await session(f);await f.core.send({id:next.id,text:'What is my morning drink?'});await finished(f.core,next.id);assert.match(JSON.stringify(f.requests.at(-1).messages),/espresso/);
});

test('explicit search works for plain chat models; disabled tools and Stop remain effective',async t=>{
  const f=await fixture(t),s=await session(f,'plain');await f.core.updateSettings({webSearch:{enabled:true}});
  f.core.web=new WebSearch(async url=>({url,status:200,contentType:'text/html',text:html}));
  await f.core.send({id:s.id,text:'Find Ollama embeddings',webSearch:true});await finished(f.core,s.id);assert.equal(f.requests[0].tools,undefined);assert.match(f.requests[0].messages.at(-1).content,/docs\.ollama/);
  await f.core.updateSettings({webSearch:{enabled:false}});await assert.rejects(f.core.callTool(s.id,'web_search',{query:'test'},signal()),/disabled/);
  await f.core.updateSettings({webSearch:{enabled:true}});
  let reached=false;f.core.web=new WebSearch(async(_url,guard)=>{reached=true;return await new Promise((_resolve,reject)=>guard.addEventListener('abort',()=>reject(guard.reason),{once:true}));});
  await f.core.send({id:s.id,text:'Find more',webSearch:true});await until(()=>reached);await f.core.stop(s.id);assert.equal(f.core.store.session(s.id).status,'interrupted');assert.equal(f.requests.length,1);
});

test('extraction model defaults, persists, and switches the model dispatched by the memory service', async t => {
  const f = await fixture(t), core = f.core, service = core.memory.service;
  clearInterval(service.timer);
  await core.memory.ready;
  assert.equal(core.settings.memory.extractionModel, 'nemotron-3-super');
  assert.equal(service.configuration.extraction_model, 'nemotron-3-super');
  for (const name of ['nemotron-3-super', 'nemotron-3-ultra', 'glm-5.3-flash']) {
    f.models.push({ model: name + ':cloud', capabilities: ['completion'], digest: 'a'.repeat(64), remote_host: 'https://ollama.com' } as any);
  }
  f.onChat = (_body, res) => res.end(JSON.stringify({ message: { content: '{"entities":[],"assertions":[]}' } }));
  const results: any[] = [], original = service.canonical.call.bind(service.canonical);
  t.mock.method(service.canonical, 'call', async (method: string, params: any = {}) => {
    if (method === 'extraction_next') return { id: 'run', observation_id: 'source', source_revision: 1, role: 'user', sensitivity: 'cloud_allowed', text: 'Use Ruff.' };
    if (method === 'extraction_result') { results.push(params); return {}; }
    if (method === 'apply_extraction') return {};
    return original(method, params);
  });
  await service.extraction();
  for (const model of ['nemotron-3-ultra:cloud', 'glm-5.3-flash']) {
    await core.updateSettings({ memory: { extractionModel: model } });
    await until(() => service.configuration.extraction_model === model);
    assert.equal(service.extractor, undefined, 'changing the model discards the previous adapter');
    await service.extraction();
  }
  assert.deepEqual(results.map(result => result.identity?.model), ['nemotron-3-super:cloud', 'nemotron-3-ultra:cloud', 'glm-5.3-flash:cloud']);
  assert.deepEqual(f.requests.map(body => body.model), ['nemotron-3-super:cloud', 'nemotron-3-super:cloud', 'nemotron-3-ultra:cloud', 'nemotron-3-ultra:cloud', 'glm-5.3-flash:cloud', 'glm-5.3-flash:cloud']);
  const reopened = new Store(f.directory);
  try { assert.equal(reopened.settings().memory.extractionModel, 'glm-5.3-flash'); }
  finally { reopened.close(); }
  await assert.rejects(core.updateSettings({ memory: { extractionModel: '' } }), /extraction model/);
  assert.equal(core.settings.memory.extractionModel, 'glm-5.3-flash');
});
