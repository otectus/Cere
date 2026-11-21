/**
 * Regressions for the Cere Mobile compatibility audit (MOB-001, MOB-003, MOB-004, MOB-005) and the
 * network-return pairing flow, exercised through the signed gateway like a phone would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';
import { canonical, digest, parsePairing, pairingUri } from '../broker/remote/crypto.ts';
import { sessionCapabilities } from '../broker/tools/contracts.ts';

const keypair=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const pub=(pair:ReturnType<typeof keypair>)=>pair.publicKey.export({type:'spki',format:'der'}).toString('base64url');
const proof=(pair:ReturnType<typeof keypair>,value:unknown)=>sign('sha256',Buffer.from(canonical(value)),pair.privateKey).toString('base64url');
const words:string[]=JSON.parse(await readFile(new URL('../protocol/mobile/v1/sas-words.json',import.meta.url),'utf8'));
async function freePort() {const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const p=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return p;}

type Fixture=Awaited<ReturnType<typeof setup>>;
/** real: the desktop's own provider adapters (they reach the fixture endpoints); otherwise a recording fake. */
async function setup(t:any,{real=false}={}) {
  const directory=await mkdtemp(join(tmpdir(),'cere-mobile-compat-'));
  const sends:{sessionId:string;text:string}[]=[];
  const core=real?new Core(new Store(directory)):new Core(new Store(directory),(session,h)=>({async send(text,_images,options){h.policy?.(true);options?.beforeAccept?.();sends.push({sessionId:session.id,text});options?.onDispatched?.();options?.onAccepted?.();setImmediate(()=>h.event({type:'complete'}));},async interrupt(){h.event({type:'interrupted'});},async close(){}}));
  const resources:(()=>unknown)[]=[];const own=(release:()=>unknown)=>{resources.push(release);};
  t.after(async()=>{for(const release of resources.reverse())await release();});
  own(()=>rm(directory,{recursive:true,force:true}));own(()=>core.close());
  const gateway=new MobileGateway(core);own(()=>gateway.close());
  await gateway.start();
  return {directory,core,gateway,sends,own,port:await freePort()};
}
/** The phone's half of pairing: fresh keys and the signed answer to an offer. */
function answer(offerUri:string,name='Fixture phone') {
  const offer=parsePairing(offerUri) as any,connection=keypair(),action=keypair(),deviceId=randomUUID();
  const body={type:'response',v:1,desktopId:offer.desktopId,pairingId:offer.pairingId,offerDigest:digest(offer),nonce:offer.nonce,deviceId,name,keyVersion:1,connectionKey:pub(connection),actionKey:pub(action),deviceNonce:randomBytes(32).toString('base64url')};
  const transcript={domain:'cere.mobile.pair.response.v1',response:body};
  const response={...body,connectionProof:proof(connection,transcript),actionProof:proof(action,transcript)};
  // The six words, as the phone computes them on its own.
  const sas=[...createHash('sha256').update(digest(offer)+'.'+digest(response)).digest().subarray(0,6)].map(v=>words[v]).join(' ');
  return {offer,uri:pairingUri(response),connection,action,deviceId,sas};
}
async function pair(f:Fixture,caps:string[],grants:Record<string,unknown>={}) {
  const prepared:any=await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Test desktop',port:f.port});
  const phone=answer(prepared.uri),review:any=await f.gateway.local('remote.reviewPair',{response:phone.uri});
  await f.gateway.local('remote.confirmPair',{response:phone.uri,sas:review.sas,confirmed:true,projectPaths:[f.directory],caps,categories:[],scriptIds:[],...grants});
  return {...phone,device:f.gateway.registry.live(phone.deviceId)!};
}
type Phone=Awaited<ReturnType<typeof pair>>;
class Client {
  ws:WebSocket;queue:any[]=[];waiters:((v:any)=>void)[]=[];welcome:any;events:any[]=[];closed:Promise<{code:number;reason:string}>;
  constructor(ws:WebSocket) {
    this.ws=ws;ws.on('message',bytes=>{const m=JSON.parse(String(bytes));if(m.type==='event'){this.events.push(m);return;}const waiter=this.waiters.shift();if(waiter)waiter(m);else this.queue.push(m);});
    this.closed=new Promise(resolve=>ws.once('close',(code,reason)=>resolve({code,reason:String(reason)})));
  }
  next(ms=5000):Promise<any> {if(this.queue.length)return Promise.resolve(this.queue.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out waiting for a frame')),ms);this.waiters.push(v=>{clearTimeout(timer);resolve(v);});});}
  send(value:any){this.ws.send(JSON.stringify(value));}
  async request(method:string,params:any={},commandId?:string,actionProof?:any) {this.send({v:1,type:'request',id:randomUUID(),method,params,...(commandId?{commandId}:{}),...(actionProof?{proof:actionProof}:{})});return this.next(20000);}
  async action(method:string,params:any,phone:Phone,commandId=randomUUID()) {
    const challenge=(await this.request('commands.challenge',{method,paramsDigest:digest(params),commandId})).result;
    const transcript={domain:'cere.mobile.action.v1',desktopId:phone.offer.desktopId,deviceId:phone.device.id,keyVersion:1,scopeVersion:phone.device.scopeVersion,epoch:this.welcome.epoch,authSessionId:this.welcome.authSessionId,challengeId:challenge.challengeId,nonce:challenge.nonce,method,paramsDigest:digest(params),commandId};
    return this.request(method,params,commandId,{challengeId:challenge.challengeId,signature:proof(phone.action,transcript)});
  }
}
async function socket(f:Fixture) {
  const ws=new WebSocket(`wss://127.0.0.1:${f.port}/mobile/v1`,'cere.mobile.v1',{ca:f.gateway.identity.material().cert});
  const client=new Client(ws);f.own(()=>ws.terminate());
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});return client;
}
async function connect(f:Fixture,phone:Phone) {
  const client=await socket(f),device=f.gateway.registry.live(phone.device.id)!;phone.device=device;
  const hello={v:1,type:'hello',protocolMin:0,protocolMax:0,desktopId:phone.offer.desktopId,deviceId:device.id,keyVersion:1,clientNonce:randomBytes(32).toString('base64url'),appVersion:'test'};
  client.send(hello);const {v:_v,type:_type,...challenge}=await client.next();
  const transcript={domain:'cere.mobile.auth.v1',helloDigest:digest(hello),challenge,desktopId:phone.offer.desktopId,deviceId:device.id,keyVersion:1,epoch:challenge.epoch};
  client.send({v:1,type:'auth',challengeId:challenge.challengeId,signature:proof(phone.connection,transcript)});
  client.welcome=await client.next();assert.equal(client.welcome.type,'welcome');return client;
}
/** An OpenAI-compatible fixture server that counts what reaches it. */
async function endpoint(t:any,{listModels=true}={}) {
  const requests:{method:string;path:string}[]=[];
  const server=http.createServer((req,res)=>{
    requests.push({method:req.method!,path:req.url!});
    if(req.method==='GET'&&req.url!.endsWith('/models')) {
      if(!listModels){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'listed-model'}]}));return;
    }
    if(req.method==='POST'&&req.url!.endsWith('/chat/completions')) {
      req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"FIXTURE_REPLY"}}]}\n\n');res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');res.end('data: [DONE]\n\n');});return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {origin:`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,requests,chats:()=>requests.filter(r=>r.method==='POST').length};
}
const session=(snapshot:any,id:string)=>snapshot.sessions.find((s:any)=>s.id===id);
const sendParams=(s:any,extra:any={})=>({sessionId:s.id,text:'Hello from the phone',attachments:[],webSearch:false,expectedDraftRevision:s.draftRevision,expectedConfigRevision:s.configRevision,...extra});
async function idle(f:Fixture,id:string) {for(let i=0;i<200;i++){const s=f.core.store.session(id);if(!['starting','working','waiting','stopping'].includes(s.status))return s;await new Promise(r=>setTimeout(r,25));}throw new Error('Turn did not finish');}

// MOB-001: a phone granted one compatible origin reaches only conversations whose own route has
// that origin and its key. Two real fixture origins and the desktop's real API adapter.
test('a phone reaches a named compatible connection only when its own route is the granted origin',async t=>{
  const f=await setup(t,{real:true}),granted=await endpoint(t),other=await endpoint(t);
  await f.core.updateSettings({compatible:{baseUrl:granted.origin+'/v1',label:'Granted',requiresKey:false,tools:false,images:false}});
  const named=async(name:string,baseUrl:string,flags:any={})=>f.core.rpc('connections.save',{kind:'compatible',name,endpoint:{baseUrl,requiresKey:false,tools:false,images:false,...flags}}) as Promise<any>;
  const elsewhere=await named('Elsewhere',other.origin+'/v1',{tools:true,images:true});
  const sameOrigin=await named('Same origin',granted.origin+'/alt/v1',{tools:true,images:true});
  const moving=await named('Moving',granted.origin+'/moving/v1');
  const keyed=await named('Keyed',granted.origin+'/keyed/v1');
  const gone=await named('Gone',granted.origin+'/gone/v1');
  const create=(connectionId:string,model='fixture-model')=>f.core.create({provider:'compatible',connectionId,cwd:f.directory,model,trusted:true});
  const onElsewhere=await create(elsewhere.id),onSame=await create(sameOrigin.id),onMoving=await create(moving.id),onKeyed=await create(keyed.id),onGone=await create(gone.id);
  const phone=await pair(f,['chat.read','chat.write','providers.api'],{apiProviders:['compatible']});
  assert.equal(phone.device.compatibleEndpoint,granted.origin);
  let client=await connect(f,phone);
  let snapshot=(await client.request('sync.open',{})).result;
  // B is visible as the project scope permits, but nothing may run, configure or list models on it.
  const b=session(snapshot,onElsewhere.id);
  assert.equal(b.canSend,false);assert.equal(b.canConfigure,false);assert.equal(b.connectionName,'Elsewhere');assert.match(b.routeRevision,/^connection:/);
  const refused=await client.action('sessions.send',sendParams(b),phone);
  assert.equal(refused.error.code,'SCOPE_DENIED');assert.match(refused.error.message,/“Elsewhere”, which this phone is not granted/);
  assert.equal((await client.request('providers.models',{provider:'compatible',sessionId:b.id})).error.code,'SCOPE_DENIED');
  assert.equal(other.requests.length,0,'the ungranted origin receives nothing');
  // A same-origin connection is covered by the origin grant; its catalog and declarations are its own.
  const same=session(snapshot,onSame.id);assert.equal(same.canSend,true);assert.equal(same.imagesAvailable,true);assert.equal(same.toolsAvailable,true);
  const catalog=(await client.request('providers.models',{provider:'compatible',sessionId:same.id,listing:true})).result;
  assert.deepEqual(catalog.items.map((m:any)=>[m.id,m.capabilities]),[['listed-model',['tools','vision']]]);assert.equal(catalog.unlisted,false);
  assert.ok(granted.requests.some(r=>r.method==='GET'&&r.path==='/alt/v1/models'),'the catalog came from the conversation’s own path');
  const defaultCatalog=(await client.request('providers.models',{provider:'compatible',listing:true})).result;
  assert.deepEqual(defaultCatalog.items.map((m:any)=>m.capabilities),[[]],'the default route declares neither tools nor images');
  // A connection edited to another origin while the phone's turn prepares: the request never leaves.
  const restrict=f.core.workbench.restrict.bind(f.core.workbench);let edited=false;
  f.core.workbench.restrict=async(id:string,messages:any,signal:AbortSignal)=>{if(id===onMoving.id&&!edited){edited=true;await f.core.rpc('connections.save',{id:moving.id,expectedRevision:moving.revision,name:'Moving',endpoint:{baseUrl:other.origin+'/v1'}});}return restrict(id,messages,signal);};
  const movingDto=session(snapshot,onMoving.id),before=granted.chats();
  const conflict=await client.action('sessions.send',sendParams(movingDto,{expectedRouteRevision:movingDto.routeRevision}),phone);
  assert.ok(['REVISION_CONFLICT','OUTCOME_UNKNOWN'].includes(conflict.error?.code),JSON.stringify(conflict));assert.equal(edited,true);
  await idle(f,onMoving.id);
  assert.equal(other.chats(),0,'the newly unreviewed destination received no request');assert.equal(granted.chats(),before);
  snapshot=(await client.request('sync.open',{})).result;
  assert.equal(session(snapshot,onMoving.id).canSend,false);assert.notEqual(session(snapshot,onMoving.id).routeRevision,movingDto.routeRevision);
  // A stale reviewed route is refused before anything is accepted.
  const fresh=session(snapshot,onSame.id);
  assert.equal((await client.action('sessions.send',sendParams(fresh,{expectedRouteRevision:'connection:'+sameOrigin.id+':999'}),phone)).error.code,'REVISION_CONFLICT');
  // The authorized route runs, through the real adapter, to its own path only.
  const sent=await client.action('sessions.send',sendParams(fresh,{expectedRouteRevision:fresh.routeRevision}),phone);
  assert.equal(sent.result?.status,'accepted',JSON.stringify(sent.error));
  await idle(f,onSame.id);
  assert.ok(granted.requests.some(r=>r.method==='POST'&&r.path==='/alt/v1/chat/completions'));assert.equal(other.chats(),0);
  assert.ok(f.core.store.messages(onSame.id).some((m:any)=>m.role==='assistant'&&m.text.includes('FIXTURE_REPLY')));
  // Missing key and deleted connection fail without falling back to another destination.
  await f.core.rpc('connections.save',{id:keyed.id,expectedRevision:keyed.revision,name:'Keyed',endpoint:{requiresKey:true}});
  f.core.store.db.prepare('DELETE FROM provider_connections WHERE id=?').run(gone.id);
  snapshot=(await client.request('sync.open',{})).result;
  assert.equal(session(snapshot,onKeyed.id).canSend,false);
  assert.equal((await client.action('sessions.send',sendParams(session(snapshot,onKeyed.id)),phone)).error.message,'The connection “Keyed” has no key on the desktop.');
  assert.match((await client.request('providers.models',{provider:'compatible',sessionId:onGone.id})).error.message,/no longer exists/);
  // Changing the default endpoint ends unbound access but leaves a named same-origin conversation alone.
  await f.core.updateSettings({compatible:{baseUrl:other.origin+'/v1',label:'Moved default',requiresKey:false}});
  snapshot=(await client.request('sync.open',{})).result;
  assert.equal(snapshot.providers.compatible.remoteExecution,false);assert.equal(session(snapshot,onSame.id).canSend,true);
  // A grant reduced while a turn prepares: the device's authority is rechecked before the request.
  const reduce=f.core.workbench.restrict;let reduced=false;
  f.core.workbench.restrict=async(id:string,messages:any,signal:AbortSignal)=>{if(id===onSame.id&&!reduced){reduced=true;const d=f.gateway.registry.live(phone.device.id)!;f.gateway.registry.saveDevice({...d,apiProviders:[],scopeVersion:String(BigInt(d.scopeVersion)+1n)});}return reduce(id,messages,signal);};
  const chatsBefore=granted.chats(),again=session(snapshot,onSame.id);
  const revoked=await client.action('sessions.send',sendParams(again),phone);
  assert.ok(revoked.error,'the reduced grant refuses the turn');assert.equal(reduced,true);
  await idle(f,onSame.id);assert.equal(granted.chats(),chatsBefore,'no request after the grant was reduced');assert.equal(other.chats(),0);
  client.ws.terminate();
});

// MOB-003 and MOB-004: the phone sees the stored tools choice for every API provider, a model change
// alone keeps it, explicit changes apply only where the route allows, and model IDs may be typed.
test('API conversations keep their tools choice across snapshots and model-only edits, and take typed model IDs',async t=>{
  const f=await setup(t),unlisted=await endpoint(t,{listModels:false});
  for(const provider of ['openai','anthropic','google'])await f.core.rpc('provider.credentials',{provider,key:'fixture-key'});
  await f.core.updateSettings({compatible:{baseUrl:unlisted.origin+'/v1',label:'Workstation',requiresKey:false,tools:false,images:false}});
  // As detection would report an Ollama server that is not running.
  f.core.capabilities.ollama={available:false,models:[],modelsStatus:'error'};
  const phone=await pair(f,['chat.read','chat.write','providers.api'],{apiProviders:['openai','anthropic','google','compatible']});
  let client=await connect(f,phone);
  const projectId=phone.device.projects[0].id;
  let snapshot=(await client.request('sync.open',{})).result;
  assert.equal(snapshot.providers.openai.traits.customModel,true);assert.equal(snapshot.providers.openai.traits.toolCalling,'yes');
  assert.equal(snapshot.providers.compatible.traits.toolCalling,'no');assert.equal(snapshot.providers.ollama.traits.toolCalling,'per-model');assert.equal(snapshot.providers.ollama.traits.customModel,false);
  // An endpoint without a model list is reported as such, not as an error; a typed ID still works.
  const listing=(await client.request('providers.models',{provider:'compatible',listing:true})).result;
  assert.deepEqual(listing,{items:[],unlisted:true});
  assert.ok(Array.isArray((await client.request('providers.models',{provider:'compatible'})).result),'an older phone still gets a bare list');
  const created:Record<string,any>={};
  for(const provider of ['openai','anthropic','google'])for(const tools of [true,false]) {
    const result=await client.action('sessions.create',{provider,projectId,model:`typed-${provider}-model`,tools},phone);
    assert.ok(result.result,JSON.stringify(result.error));created[`${provider}:${tools}`]=result.result;
    assert.equal(result.result.tools,tools);assert.equal(result.result.toolsAvailable,true);assert.equal(f.core.store.session(result.result.id).api?.tools,tools);
  }
  const compatible=(await client.action('sessions.create',{provider:'compatible',projectId,model:'unlisted-model-id',tools:false},phone)).result;
  assert.equal(compatible.model,'unlisted-model-id');assert.equal(compatible.toolsAvailable,false);assert.match(compatible.toolsUnavailableReason,/not declared to support tools/);
  assert.match((await client.action('sessions.create',{provider:'compatible',projectId,model:'x',tools:true},phone)).error.message,/not declared to support tools/);
  // Invalid typed IDs: the broker stays authoritative.
  assert.equal((await client.action('sessions.create',{provider:'openai',projectId,model:'bad\u0007id',tools:false},phone)).error.code,'INVALID_ARGUMENT');
  assert.equal((await client.action('sessions.create',{provider:'openai',projectId,model:'x'.repeat(513),tools:false},phone)).error.code,'INVALID_ARGUMENT');
  // Phone-owned conversations: reconnect, then change only the model.
  for(const [key,value] of Object.entries(created)) {
    const sent=await client.action('sessions.send',sendParams(value),phone);assert.equal(sent.result?.status,'accepted',JSON.stringify(sent.error));
    created[key]=(await client.request('sessions.get',{sessionId:value.id})).result;
  }
  client.ws.terminate();client=await connect(f,phone);snapshot=(await client.request('sync.open',{})).result;
  for(const [key,value] of Object.entries(created)) {
    const tools=key.endsWith(':true'),current=(await client.request('sessions.get',{sessionId:value.id})).result;
    assert.equal(current.tools,tools,`${key} after reconnect`);assert.equal(current.canConfigure,true,key);
    const changed=await client.action('sessions.configure',{sessionId:current.id,model:'another-typed-model',expectedConfigRevision:current.configRevision},phone);
    assert.ok(changed.result,JSON.stringify(changed.error));assert.equal(changed.result.model,'another-typed-model');assert.equal(changed.result.tools,tools,`${key}: a model-only change keeps tools`);
    const flipped=await client.action('sessions.configure',{sessionId:current.id,model:'another-typed-model',tools:!tools,expectedConfigRevision:changed.result.configRevision},phone);
    assert.equal(flipped.result?.tools,!tools,`${key}: an explicit change applies`);
  }
  // The compatible route without declared tools refuses an explicit enable with its reason, and keeps its choice.
  await client.action('sessions.send',sendParams(compatible),phone);
  const current=(await client.request('sessions.get',{sessionId:compatible.id})).result;
  assert.match((await client.action('sessions.configure',{sessionId:current.id,model:'unlisted-model-id',tools:true,expectedConfigRevision:current.configRevision},phone)).error.message,/not declared to support tools/);
  const renamed=await client.action('sessions.configure',{sessionId:current.id,model:'another-unlisted-id',expectedConfigRevision:current.configRevision},phone);
  assert.equal(renamed.result?.model,'another-unlisted-id');assert.equal(renamed.result.tools,false);
  client.ws.terminate();
});

// MOB-005: Files, Images and Analysis pause under phone control. Taking over needs the phone to name
// exactly what pauses; an older phone is told why; the desktop's selections survive and return.
test('taking over a Workbench conversation from the phone is explicit, revision-bound and reversible',async t=>{
  const f=await setup(t);await f.core.rpc('provider.credentials',{provider:'openai',key:'fixture-key'});
  const phone=await pair(f,['chat.read','chat.write','providers.api'],{apiProviders:['openai']});
  const desktop=await f.core.create({provider:'openai',cwd:f.directory,model:'gpt-fixture',trusted:true,capabilities:{files:true,images:true,analysis:true}});
  f.core.draft(desktop.id,'Desktop draft stays');
  f.core.putMessage({id:desktop.id+':changes:fixture',sessionId:desktop.id,role:'workbench',kind:'changes',text:'Proposed changes (2): src/secret-path.ts, docs/private.md\nReview',time:Date.now()} as any);
  assert.deepEqual(sessionCapabilities(f.core.store.session(desktop.id)),{files:true,images:true,analysis:true});
  const client=await connect(f,phone);
  const snapshot=(await client.request('sync.open',{selectedSessionId:desktop.id})).result,dto=session(snapshot,desktop.id);
  assert.deepEqual(dto.workbenchFamilies,['files','images','analysis']);assert.equal(dto.workbenchTakeover,'acknowledge');assert.match(dto.workbenchNote,/Files, Images and Analysis/);
  // The result card is a desktop-only reference: what it is, never its paths.
  const card=snapshot.messages.find((m:any)=>m.role==='workbench');
  assert.deepEqual(card.desktopOnly,{kind:'changes',label:'Proposed file changes'});assert.ok(!JSON.stringify(snapshot.messages).includes('secret-path'));
  // An older phone (no acknowledgement) and a stale acknowledgement are refused; nothing changes.
  const old=await client.action('sessions.send',sendParams(dto),phone);
  assert.equal(old.error.code,'PROVIDER_POLICY_UNSAFE');assert.match(old.error.message,/Update Cere Mobile to continue it here without them/);
  assert.equal((await client.action('sessions.send',sendParams(dto,{workbenchAcknowledged:['files']}),phone)).error.code,'REVISION_CONFLICT');
  assert.equal(f.core.store.session(desktop.id).remote,undefined);assert.equal(f.sends.length,0);
  // The acknowledged takeover runs without the families; their stored selection is kept.
  const sent=await client.action('sessions.send',sendParams(dto,{workbenchAcknowledged:['analysis','files','images']}),phone);
  assert.equal(sent.result?.status,'accepted',JSON.stringify(sent.error));
  const owned=f.core.store.session(desktop.id);
  assert.equal(owned.remote?.deviceId,phone.device.id);assert.deepEqual(owned.capabilities,{files:true,images:true,analysis:true});
  assert.deepEqual(sessionCapabilities(owned),{files:false,images:false,analysis:false});
  const after=(await client.request('sessions.get',{sessionId:desktop.id})).result;assert.equal(after.workbenchTakeover,null);assert.match(after.workbenchNote,/paused while this phone controls/);
  // The desktop takes it back: the families return; history and the card remain.
  await f.core.rpc('session.detachRemote',{id:desktop.id});
  const back=f.core.store.session(desktop.id);
  assert.deepEqual(sessionCapabilities(back),{files:true,images:true,analysis:true});
  assert.ok(f.core.store.messages(desktop.id).some((m:any)=>m.role==='user'&&m.text==='Hello from the phone'));
  assert.ok(f.core.store.messages(desktop.id).some((m:any)=>m.role==='workbench'));
  client.ws.terminate();
});

// Pairing: the phone sends its signed answer over pinned TLS during the offer's window; the desktop
// shows the same six words and confirms; the phone learns it on the same socket.
test('network-return pairing: listener only for the offer, words shown on the desktop, phone told on confirm',async t=>{
  const f=await setup(t);
  // An offline offer opens nothing, as before.
  await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Test desktop',port:f.port});
  assert.equal(f.gateway.servers.length,0);
  const prepared:any=await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Test desktop',port:f.port,networkReturn:true});
  assert.equal(prepared.networkReturn,true);assert.equal((parsePairing(prepared.uri) as any).responseReturn,'network');
  assert.equal(f.gateway.servers.length,1,'the window opens the listener');
  // Before an answer arrives: no device can sign in, and other frames are refused.
  const stray=await socket(f);stray.send({v:1,type:'auth',challengeId:randomUUID(),signature:'x'});assert.equal((await stray.closed).code,4001);
  const phone=answer(prepared.uri);
  const waiting=await socket(f);waiting.send({v:1,type:'pair.response',response:phone.uri});
  const received=await waiting.next();assert.equal(received.type,'pair.received');assert.equal(received.pairingId,prepared.pairingId);
  const status:any=(f.core.remoteStatus as any).pairing;
  assert.equal(status.received.sas,phone.sas,'the desktop shows the words the phone computed');assert.equal(status.received.name,'Fixture phone');
  // The same answer again (after a lost connection) is accepted; a frame after it is not.
  const retry=await socket(f);retry.send({v:1,type:'pair.response',response:phone.uri});assert.equal((await retry.next()).type,'pair.received');
  retry.send({v:1,type:'hello'});assert.equal((await retry.closed).code,4001);
  const device:any=await f.gateway.local('remote.confirmPair',{pairingId:prepared.pairingId,sas:phone.sas,confirmed:true,projectPaths:[f.directory],caps:['chat.read']});
  assert.equal(device.id,phone.deviceId);
  assert.equal((await waiting.next()).type,'pair.confirmed');assert.equal((await waiting.closed).code,1000);
  // The phone then signs in as the new device; checking its answer again says it was confirmed.
  const client=await connect(f,{...phone,device:f.gateway.registry.live(phone.deviceId)!});
  assert.ok((await client.request('sync.open',{})).result.cursor);
  const check=await socket(f);check.send({v:1,type:'pair.response',response:phone.uri});assert.equal((await check.next()).type,'pair.confirmed');
  assert.equal((f.core.remoteStatus as any).pairing,undefined,'nothing is pending after confirmation');
  client.ws.terminate();
});

test('network-return pairing: a second answer voids the offer, and cancel and expiry tell the waiting phone',async t=>{
  const f=await setup(t);
  let prepared:any=await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Test desktop',port:f.port,networkReturn:true});
  const first=answer(prepared.uri,'First phone'),second=answer(prepared.uri,'Second phone');
  const one=await socket(f);one.send({v:1,type:'pair.response',response:first.uri});assert.equal((await one.next()).type,'pair.received');
  const two=await socket(f);two.send({v:1,type:'pair.response',response:second.uri});
  const refused=await two.next();assert.equal(refused.type,'pair.closed');assert.match(refused.message,/Another phone answered/);
  assert.deepEqual(await one.next(),{v:1,type:'pair.closed',reason:'contested'});
  assert.equal((f.core.remoteStatus as any).pairing?.contested,true,'the desktop says why nothing was paired');
  await assert.rejects(f.gateway.local('remote.confirmPair',{pairingId:prepared.pairingId,sas:first.sas,confirmed:true,projectPaths:[f.directory]}));
  await assert.rejects(f.gateway.local('remote.confirmPair',{response:first.uri,sas:first.sas,confirmed:true,projectPaths:[f.directory]}),'the pasted answer cannot confirm a voided offer either');
  assert.equal(f.gateway.registry.devices().length,0);
  // Cancelled on the desktop.
  prepared=await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Test desktop',port:f.port,networkReturn:true});
  const cancelled=await socket(f);cancelled.send({v:1,type:'pair.response',response:answer(prepared.uri).uri});assert.equal((await cancelled.next()).type,'pair.received');
  await f.gateway.local('remote.cancelPair',{});
  assert.deepEqual(await cancelled.next(),{v:1,type:'pair.closed',reason:'cancelled'});
  assert.equal(f.gateway.servers.length,0,'without a paired phone the listener closes with the offer');
  // Expired: maintenance ends the offer, tells the phone and closes the listener.
  prepared=await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Test desktop',port:f.port,networkReturn:true});
  const expiring=await socket(f);expiring.send({v:1,type:'pair.response',response:answer(prepared.uri).uri});assert.equal((await expiring.next()).type,'pair.received');
  f.gateway.registry.store.db.prepare('UPDATE remote_pair_offers SET expires=? WHERE id=?').run(Date.now()-1,prepared.pairingId);
  for(const entry of f.gateway.pairing.received.values())entry.expiresAt=Date.now()-1;
  await f.gateway.maintain();
  assert.deepEqual(await expiring.next(),{v:1,type:'pair.closed',reason:'expired'});
  assert.equal(f.gateway.servers.length,0);
  // An offline offer never takes an answer over the network, even while another phone keeps the gateway open.
  const paired=await pair(f,['chat.read']);assert.ok(paired.device);
  const offline:any=await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Test desktop',port:f.port});
  const manual=await socket(f);manual.send({v:1,type:'pair.response',response:answer(offline.uri).uri});
  const closed=await manual.next();assert.equal(closed.type,'pair.closed');assert.match(closed.message,/takes its answer on the desktop/);
});

test('the desktop pairing status lists this computer’s addresses, known projects and compatible connections without keys',async t=>{
  const f=await setup(t);
  await f.core.updateSettings({compatible:{baseUrl:'http://127.0.0.1:9/v1',label:'Workstation',requiresKey:false}});
  await f.core.create({provider:'codex',cwd:f.directory,trusted:true});
  const status:any=await f.gateway.local('remote.status',{});
  assert.ok(Array.isArray(status.addressCandidates));
  for(const candidate of status.addressCandidates){assert.ok(['tailscale','wireguard','lan','other','virtual'].includes(candidate.kind));assert.ok(!candidate.address.startsWith('127.'));}
  assert.ok(status.knownProjects.some((project:any)=>project.path===f.directory));
  assert.deepEqual(status.compatibleConnections.map((c:any)=>[c.origin,c.settingsDefault]),[['http://127.0.0.1:9',true]]);
  assert.ok(!JSON.stringify(status).includes('fixture-key'));
});
