import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign, createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';
import { canonical, digest, parsePairing, pairingUri, verified } from '../broker/remote/crypto.ts';
import { RemoteStore } from '../broker/remote/store.ts';
import { methods } from '../broker/remote/schemas.ts';
import type { Hooks } from '../broker/providers.ts';
import sharp from 'sharp';
import { mobilePage, mobilePart } from '../broker/remote/transcript.ts';
import { desktopAction } from '../broker/desktop.ts';
import { Canonical } from '../broker/graph-memory/canonical.ts';
import { availableOperations } from '../broker/remote/schemas.ts';

const keypair=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const pub=(pair:ReturnType<typeof keypair>)=>pair.publicKey.export({type:'spki',format:'der'}).toString('base64url');
const proof=(pair:ReturnType<typeof keypair>,value:unknown)=>sign('sha256',Buffer.from(canonical(value)),pair.privateKey).toString('base64url');
test('shared mobile canonical JSON, hash and P-256 signature fixtures conform',async()=>{
  const fixtures=JSON.parse(await readFile(new URL('../protocol/mobile/v1/signing-fixtures.json',import.meta.url),'utf8'));
  for(const item of fixtures.cases){assert.equal(canonical(item.value),item.canonical,item.name);assert.equal(digest(item.value),item.sha256,item.name);assert.equal(verified(fixtures.publicKey,item.value,item.signature),true,item.name);assert.equal(verified(fixtures.publicKey,{...item.value,changed:true},item.signature),false,item.name);}
});
async function port() {const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const p=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return p;}
async function fixture(t:any) {
  const directory=await mkdtemp(join(tmpdir(),'cere-mobile-test-'));let sends=0;const hooks=new Map<string,Hooks>();
  const core=new Core(new Store(directory),(session,h)=>{hooks.set(session.id,h);return {async send(_text,_images,options){sends++;h.policy?.(true);options?.beforeAccept?.();options?.onDispatched?.();options?.onAccepted?.();},async interrupt(){h.event({type:'interrupted'});},async close(){}};});
  const gateway=new MobileGateway(core);
  t.after(async()=>{await gateway.close();await core.close();await rm(directory,{recursive:true,force:true});});
  await gateway.start();assert.equal(gateway.servers.length,0);
  const pairing:any=await gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Test desktop',port:await port()});
  assert.equal(gateway.servers.length,0);assert.ok(pairing.uri.length<=2000);
  const offer=parsePairing(pairing.uri),connection=keypair(),action=keypair(),deviceId=randomUUID();
  const body={type:'response',v:1,desktopId:offer.desktopId,pairingId:offer.pairingId,offerDigest:digest(offer),nonce:offer.nonce,deviceId,name:'Fixture phone',keyVersion:1,connectionKey:pub(connection),actionKey:pub(action),deviceNonce:randomBytes(32).toString('base64url')};
  const transcript={domain:'cere.mobile.pair.response.v1',response:body};
  const response=pairingUri({...body,connectionProof:proof(connection,transcript),actionProof:proof(action,transcript)});
  const review:any=await gateway.local('remote.reviewPair',{response});
  assert.equal(review.sas.split(' ').length,6);
  await gateway.local('remote.confirmPair',{response,sas:review.sas,confirmed:true,projectPaths:[directory],caps:['chat.read','chat.write','providers.execute','approvals.answer','approvals.provider','desktop.control','settings.write'],categories:['audio','files','scripts'],scriptIds:[]});
  const device=gateway.registry.live(deviceId)!;
  return {directory,core,gateway,offer,connection,action,device,hooks,sends:()=>sends};
}
class Client {
  ws:WebSocket;queue:any[]=[];waiters:((v:any)=>void)[]=[];welcome:any;events:any[]=[];binary:Buffer[]=[];
  constructor(ws:WebSocket) {this.ws=ws;ws.on('message',(bytes,binary)=>{if(binary){this.binary.push(Buffer.from(bytes as any));return;}const m=JSON.parse(String(bytes));if(m.type==='event'){this.events.push(m);return;}const waiter=this.waiters.shift();if(waiter)waiter(m);else this.queue.push(m);});}
  next():Promise<any> {if(this.queue.length)return Promise.resolve(this.queue.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out waiting for wire response')),3000);this.waiters.push(v=>{clearTimeout(timer);resolve(v);});});}
  send(value:any){this.ws.send(JSON.stringify(value));}
  async request(method:string,params:any={},commandId?:string,actionProof?:any) {this.send({v:1,type:'request',id:randomUUID(),method,params,...(commandId?{commandId}:{}),...(actionProof?{proof:actionProof}:{})});return this.next();}
  async action(method:string,params:any,f:Awaited<ReturnType<typeof fixture>>,commandId=randomUUID(),signer=f.action) {
    const challenge=(await this.request('commands.challenge',{method,paramsDigest:digest(params),commandId})).result;
    const transcript={domain:'cere.mobile.action.v1',desktopId:f.offer.desktopId,deviceId:f.device.id,keyVersion:1,scopeVersion:f.device.scopeVersion,epoch:this.welcome.epoch,authSessionId:this.welcome.authSessionId,challengeId:challenge.challengeId,nonce:challenge.nonce,method,paramsDigest:digest(params),commandId};
    return this.request(method,params,commandId,{challengeId:challenge.challengeId,signature:proof(signer,transcript)});
  }
}
async function connect(t:any,f:Awaited<ReturnType<typeof fixture>>) {
  const ws=new WebSocket(f.offer.endpoints[0],'cere.mobile.v1',{ca:f.gateway.identity.material().cert});
  const client=new Client(ws);t.after(()=>ws.terminate());await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const hello={v:1,type:'hello',protocolMin:0,protocolMax:0,desktopId:f.offer.desktopId,deviceId:f.device.id,keyVersion:1,clientNonce:randomBytes(32).toString('base64url'),appVersion:'test'};
  client.send(hello);const {v,type,...challenge}=await client.next();
  const transcript={domain:'cere.mobile.auth.v1',helloDigest:digest(hello),challenge,desktopId:f.offer.desktopId,deviceId:f.device.id,keyVersion:1,epoch:challenge.epoch};
  client.send({v:1,type:'auth',challengeId:challenge.challengeId,signature:proof(f.connection,transcript)});
  client.welcome=await client.next();assert.equal(client.welcome.type,'welcome');assert.equal(client.welcome.sendAuthentication,'connection-key');return client;
}
test('mobile offline pairing opens no listener before confirmation, scopes snapshots and revokes the last connection',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  const mine=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});
  const outside=await mkdtemp(join(tmpdir(),'cere-other-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await f.core.create({provider:'codex',cwd:outside,trusted:true,title:'SECRET OUTSIDE PROJECT'});
  const snapshot=(await client.request('sync.open',{})).result;
  assert.deepEqual(snapshot.sessions.map((s:any)=>s.id),[mine.id]);assert.ok(!JSON.stringify(snapshot).includes('SECRET OUTSIDE PROJECT'));
  assert.equal(snapshot.settings.bypassCliPermissions,undefined);assert.equal(snapshot.settings.ollama,undefined);
  assert.equal(snapshot.sessions[0].nativeId,undefined);
  for(const method of ['mcp.call','action.run','settings.update','memory.graph','remote.confirmPair','session.link','ui.quit'])assert.equal((await client.request(method,{})).error.code,'INVALID_ARGUMENT');
  const closed=new Promise(r=>client.ws.once('close',r));await f.gateway.revoke(f.device.id);await closed;assert.equal(f.gateway.servers.length,0);
  const mode=(await stat(join(f.directory,'remote-identity','tls.pem'))).mode&0o777;assert.equal(mode,0o600);
});
test('remote Ollama and Claude sessions are creatable, sendable and advertise exact restrictions',async t=>{
  const f=await fixture(t),client=await connect(t,f),projectId=f.device.projects[0].id;
  const model={id:'fixture-model',displayName:'Fixture',description:'Local fixture',efforts:[],defaultEffort:'',isDefault:false,capabilities:['completion']};
  f.core.capabilities.ollama={available:true,modelsStatus:'ready',models:[model]};
  f.core.capabilities.claude={available:true,modelsStatus:'ready',models:[],remoteRestricted:true};
  const snapshot=(await client.request('sync.open',{})).result;
  assert.equal(snapshot.providers.ollama.remoteExecution,true);assert.equal(snapshot.providers.claude.remoteExecution,true);
  assert.equal(snapshot.providers.claude.remoteUnavailableReason,undefined);
  const ollama=(await client.action('sessions.create',{provider:'ollama',projectId,model:model.id,tools:false},f)).result;
  assert.equal(ollama.provider,'ollama');assert.equal(ollama.model,model.id);assert.equal(ollama.ollamaHost,'http://127.0.0.1:11434');assert.equal(ollama.canSend,true);
  const ollamaSent=await client.action('sessions.send',{sessionId:ollama.id,text:'Local request',attachments:[],webSearch:false,expectedDraftRevision:ollama.draftRevision,expectedConfigRevision:ollama.configRevision},f);
  assert.equal(ollamaSent.result.status,'accepted');
  const claude=(await client.action('sessions.create',{provider:'claude',projectId,tools:false},f)).result;
  assert.equal(claude.provider,'claude');assert.equal(claude.remoteRestricted,true);assert.equal(claude.canSend,true);
  const claudeSent=await client.action('sessions.send',{sessionId:claude.id,text:'Restricted request',attachments:[],webSearch:false,expectedDraftRevision:claude.draftRevision,expectedConfigRevision:claude.configRevision},f);
  assert.equal(claudeSent.result.status,'accepted');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.core.store.session(claude.id).effectivePolicy,'restricted');assert.equal(f.sends(),2);
});
test('connection-key send proofs are exact, single-use, and cannot authorize other positive actions',async t=>{
  const f=await fixture(t),client=await connect(t,f),projectId=f.device.projects[0].id;
  const createParams={provider:'codex',projectId,tools:false};
  const deniedCreate=await client.action('sessions.create',createParams,f,randomUUID(),f.connection);
  assert.equal(deniedCreate.error.code,'UNAUTHENTICATED');assert.equal(f.core.store.sessions().length,0);
  const session=(await client.action('sessions.create',createParams,f)).result;

  const settingsBefore=f.core.settings.personality,settingsParams={expectedRevision:f.core.store.get('settingsRevision','0'),personality:'Connection key must not change this'};
  const deniedSettings=await client.action('settings.patch',settingsParams,f,randomUUID(),f.connection);
  assert.equal(deniedSettings.error.code,'UNAUTHENTICATED');assert.equal(f.core.settings.personality,settingsBefore);

  const approvalSession=(await client.action('sessions.create',createParams,f)).result;
  const pending=f.core.approval(approvalSession.id,{kind:'provider',title:'Positive approval',detail:'Exact proposal',choices:['allow','deny']});
  const approval=(await client.request('approvals.list')).result[0];
  const approvalParams={approvalId:approval.id,revision:approval.revision,digest:approval.digest,choice:'allow',answers:{}};
  const deniedApproval=await client.action('approvals.answer',approvalParams,f,randomUUID(),f.connection);
  assert.equal(deniedApproval.error.code,'UNAUTHENTICATED');assert.equal(f.core.approvals.has(approval.id),true);
  f.core.answer({id:approval.id,choice:'deny',answers:{}});assert.equal((await pending).choice,'deny');

  const sendParams={sessionId:session.id,text:'Passwordless exact send',attachments:[],webSearch:false,expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision};
  const commandId=randomUUID(),challenge=(await client.request('commands.challenge',{method:'sessions.send',paramsDigest:digest(sendParams),commandId})).result;
  const transcript={domain:'cere.mobile.action.v1',desktopId:f.offer.desktopId,deviceId:f.device.id,keyVersion:1,scopeVersion:f.device.scopeVersion,epoch:client.welcome.epoch,authSessionId:client.welcome.authSessionId,challengeId:challenge.challengeId,nonce:challenge.nonce,method:'sessions.send',paramsDigest:digest(sendParams),commandId};
  const sendProof={challengeId:challenge.challengeId,signature:proof(f.connection,transcript)};
  assert.equal((await client.request('sessions.send',{...sendParams,text:'Mutated send'},commandId,sendProof)).error.code,'UNAUTHENTICATED');
  assert.equal((await client.request('sessions.send',sendParams,commandId,sendProof)).error.code,'UNAUTHENTICATED');assert.equal(f.sends(),0);
  const sent=await client.action('sessions.send',sendParams,f,commandId,f.connection);
  assert.equal(sent.result.status,'accepted');assert.equal(f.sends(),1);
});
test('Claude remote availability fails closed when the executable cannot prove restricted mode',async t=>{
  const f=await fixture(t),client=await connect(t,f),projectId=f.device.projects[0].id;
  f.core.capabilities.claude={available:true,modelsStatus:'ready',models:[],remoteRestricted:false};
  const snapshot=(await client.request('sync.open',{})).result;
  assert.equal(snapshot.providers.claude.remoteExecution,false);assert.match(snapshot.providers.claude.remoteUnavailableReason,/Update Claude Code/);
  const created=await client.action('sessions.create',{provider:'claude',projectId,tools:false},f);
  assert.equal(created.error.code,'PROVIDER_POLICY_UNSAFE');assert.equal(f.core.store.sessions().length,0);
});
test('remote Ollama creation pins and rechecks the granted host across catalog loading',async t=>{
  const f=await fixture(t),client=await connect(t,f),projectId=f.device.projects[0].id;
  let release!:(models:any[])=>void,seenHost='';const loading=new Promise<any[]>(resolve=>{release=resolve;});
  f.core.modelLoader=async(_provider,host)=>{seenHost=host||'';return loading;};
  const creating=client.action('sessions.create',{provider:'ollama',projectId,model:'fixture-model',tools:false},f);
  for(let n=0;n<100&&!seenHost;n++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(seenHost,'http://127.0.0.1:11434');
  f.core.settings.ollama={host:'http://127.0.0.1:11435',model:''};
  release([{id:'fixture-model',displayName:'Fixture',description:'Local fixture',efforts:[],defaultEffort:'',isDefault:false,capabilities:['completion']}]);
  const created=await creating;assert.equal(created.error.code,'SCOPE_DENIED');assert.equal(f.core.store.sessions().length,0);
});
test('remote Ollama model refresh recovers transient desktop availability without changing authorization',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  f.core.capabilities.ollama={available:false,modelsStatus:'error',models:[]};
  f.core.modelLoader=async(provider,host)=>{assert.equal(provider,'ollama');assert.equal(host,'http://127.0.0.1:11434');return [{id:'recovered',displayName:'Recovered',description:'Local fixture',efforts:[],defaultEffort:'',isDefault:false,capabilities:['completion']}];};
  const failed=(await client.request('sync.open',{})).result.providers.ollama;
  assert.equal(failed.available,false);assert.equal(failed.remoteExecution,true);assert.match(failed.remoteUnavailableReason,/Refresh models/);
  const models=(await client.request('providers.models',{provider:'ollama'})).result;assert.equal(models[0].id,'recovered');
  const snapshot=(await client.request('sync.open',{})).result,recovered=snapshot.providers.ollama;
  assert.equal(recovered.available,true);assert.equal(recovered.modelsStatus,'ready');assert.equal(recovered.remoteExecution,true);assert.equal(recovered.remoteUnavailableReason,undefined);
  f.device.ollamaHosts=['http://127.0.0.1:11434/'];
  const patched=await client.action('settings.patch',{expectedRevision:snapshot.settings.revision,defaultModel:'recovered'},f);assert.equal(patched.result.defaultModel,'recovered');
});
test('signed sends bind exact bytes, deduplicate after lost ACK, preserve CAS drafts, and ignore desktop bypasses',async t=>{
  const f=await fixture(t),client=await connect(t,f);await f.core.updateSettings({bypassCliPermissions:true,bypassComputerPermissions:true,profile:'manual',categories:[]});
  const created=await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f);assert.ok(created.result,JSON.stringify(created));
  let session=created.result;
  const draft=await client.request('drafts.put',{sessionId:session.id,text:'Original draft',expectedRevision:'0'},randomUUID());assert.equal(draft.result.revision,'1');
  const stale=await client.request('drafts.put',{sessionId:session.id,text:'Stale overwrite',expectedRevision:'0'},randomUUID());assert.equal(stale.error.code,'REVISION_CONFLICT');
  session=(await client.request('sessions.get',{sessionId:session.id})).result;
  const params={sessionId:session.id,text:'Unicode 🦊 漢字\n| a | b |\n|---|---|\n| 1 | 2 |',attachments:[],webSearch:false,expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision};
  const commandId=randomUUID(),sent=await client.action('sessions.send',params,f,commandId);assert.equal(sent.result.status,'accepted');
  await new Promise(r=>setTimeout(r,30));assert.equal(f.sends(),1);assert.equal(f.core.store.session(session.id).draft,'');assert.equal(f.core.store.messages(session.id).filter(m=>m.role==='user').length,1);
  const replay=await client.request('sessions.send',params,commandId);assert.equal(replay.result.turnId,sent.result.turnId);assert.equal(f.sends(),1);
  const mismatch=await client.request('sessions.send',{...params,text:'changed'},commandId);assert.equal(mismatch.error.code,'IDEMPOTENCY_CONFLICT');
  assert.equal(f.hooks.get(session.id)!.bypassCliPermissions!(),false);assert.equal(f.hooks.get(session.id)!.restrictive,true);
  await assert.rejects(f.core.action('audio.mute',{},session.id),/disabled/);
  const pending=f.core.approval(session.id,{kind:'provider',title:'Exact command',detail:'printf safe',choices:['allow','deny']});
  await f.core.updateSettings({bypassCliPermissions:true});assert.equal(f.core.approvals.size,1);
  const approval=(await client.request('approvals.list')).result[0];assert.equal(approval.canAnswer,true);
  const answered=await client.action('approvals.answer',{approvalId:approval.id,revision:approval.revision,digest:approval.digest,choice:'allow',answers:{}},f);assert.equal(answered.result,true);assert.equal((await pending).choice,'allow');
  const staleAnswer=await client.action('approvals.answer',{approvalId:approval.id,revision:approval.revision,digest:approval.digest,choice:'allow',answers:{}},f);assert.equal(staleAnswer.error.code,'APPROVAL_GONE');
  await client.request('sessions.stop',{sessionId:session.id},randomUUID());
});
test('send reports CAS failure before acceptance and preserves the authoritative draft',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  const session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  const saved=(await client.request('drafts.put',{sessionId:session.id,text:'Authoritative draft',expectedRevision:session.draftRevision},randomUUID())).result;
  const params={sessionId:session.id,text:'Stale signed text',attachments:[],webSearch:false,expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision};
  const commandId=randomUUID(),sent=await client.action('sessions.send',params,f,commandId);
  assert.equal(sent.error.code,'REVISION_CONFLICT');assert.equal(f.sends(),0);
  const current=f.core.store.session(session.id);assert.equal(current.draft,'Authoritative draft');assert.equal(current.draftRevision,saved.revision);assert.deepEqual(f.core.store.messages(session.id),[]);
  assert.equal(f.gateway.registry.status(f.device.id,commandId).status,'failed');
});
test('provider failure before acceptance preserves draft and creates no user transcript entry',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  f.core.factory=()=>({async send(_text,_images,options){options?.beforeAccept?.();throw new Error('Provider unavailable before acceptance');},async close(){},async interrupt(){}});
  const session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  const saved=(await client.request('drafts.put',{sessionId:session.id,text:'Keep this text',expectedRevision:session.draftRevision},randomUUID())).result;
  const commandId=randomUUID(),sent=await client.action('sessions.send',{sessionId:session.id,text:'Keep this text',attachments:[],webSearch:false,expectedDraftRevision:saved.revision,expectedConfigRevision:session.configRevision},f,commandId);
  assert.equal(sent.error.code,'INVALID_ARGUMENT');assert.equal(f.gateway.registry.status(f.device.id,commandId).status,'failed');
  assert.equal(f.core.store.session(session.id).draft,'Keep this text');assert.deepEqual(f.core.store.messages(session.id),[]);
});
test('provider dispatch without an acknowledgement is unknown and cannot be replayed',async t=>{
  const f=await fixture(t),client=await connect(t,f);let attempts=0;
  f.core.factory=()=>({async send(_text,_images,options){attempts++;options?.beforeAccept?.();options?.onDispatched?.();throw new Error('Provider disconnected before acknowledging');},async close(){},async interrupt(){}});
  const session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  const saved=(await client.request('drafts.put',{sessionId:session.id,text:'Keep after unknown',expectedRevision:session.draftRevision},randomUUID())).result;
  const commandId=randomUUID(),params={sessionId:session.id,text:'Keep after unknown',attachments:[],webSearch:false,expectedDraftRevision:saved.revision,expectedConfigRevision:session.configRevision};
  assert.equal((await client.action('sessions.send',params,f,commandId)).error.code,'OUTCOME_UNKNOWN');
  assert.equal(f.gateway.registry.status(f.device.id,commandId).status,'unknown');
  assert.equal(f.core.store.session(session.id).draft,'Keep after unknown');assert.deepEqual(f.core.store.messages(session.id),[]);
  assert.equal((await client.request('sessions.send',params,commandId)).result.status,'unknown');assert.equal(attempts,1);
});
test('a reply emitted before the provider acknowledgement still follows its user turn',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  f.core.factory=(_session,h)=>({async send(_text,_images,options){options?.beforeAccept?.();options?.onDispatched?.();h.event({type:'message',id:'fast',text:'Fast reply'});h.event({type:'complete'});options?.onAccepted?.();},async close(){},async interrupt(){}});
  const session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  const sent=await client.action('sessions.send',{sessionId:session.id,text:'First turn',attachments:[],webSearch:false,expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision},f);
  assert.equal(sent.result.status,'accepted');
  const messages=f.core.store.messages(session.id).sort((a,b)=>a.time-b.time);assert.deepEqual(messages.map(message=>message.role),['user','assistant']);
  assert.ok(messages[0].time<messages[1].time);
});
test('action signatures cannot be transplanted to different parameters or commands',async t=>{
  const f=await fixture(t),client=await connect(t,f),commandId=randomUUID();
  const params={provider:'codex',projectId:f.device.projects[0].id,tools:false};
  const challenge=(await client.request('commands.challenge',{method:'sessions.create',paramsDigest:digest(params),commandId})).result;
  const transcript={domain:'cere.mobile.action.v1',desktopId:f.offer.desktopId,deviceId:f.device.id,keyVersion:1,scopeVersion:'1',epoch:client.welcome.epoch,authSessionId:client.welcome.authSessionId,challengeId:challenge.challengeId,nonce:challenge.nonce,method:'sessions.create',paramsDigest:digest(params),commandId};
  const signature={challengeId:challenge.challengeId,signature:proof(f.action,transcript)};
  assert.equal((await client.request('sessions.create',{...params,title:'injected'},commandId,signature)).error.code,'UNAUTHENTICATED');
  assert.equal((await client.request('sessions.create',params,commandId,signature)).error.code,'UNAUTHENTICATED');
  assert.equal(f.core.store.sessions().length,0);
});
test('remote parser rejects extra fields and unsafe IDs; accepted operations become unknown after restart',async t=>{
  assert.throws(()=>methods['sessions.create'].parse({provider:'codex',projectId:randomUUID(),trusted:true,cwd:'/'}));
  assert.throws(()=>methods['desktop.execute'].parse({projectId:randomUUID(),action:'script.run',args:{},role:'ui'}));
  const directory=await mkdtemp(join(tmpdir(),'cere-mobile-ledger-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(directory),remote=new RemoteStore(store),device=randomUUID(),id=randomUUID();
  remote.accept(device,id,'desktop.execute',{action:'audio.mute'});store.close();
  const reopened=new Store(directory),registry=new RemoteStore(reopened);try{assert.equal(registry.status(device,id).status,'unknown');assert.throws(()=>registry.prior(device,id,'desktop.execute',{action:'other'}),/command ID/);}finally{reopened.close();}
});

test('oversized Unicode/control transcripts page and round-trip without oversized frames or full-history reads',async t=>{
  const f=await fixture(t),client=await connect(t,f),session=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});
  const text='\u0001🦊漢字\n'.repeat(100000),message={id:randomUUID(),sessionId:session.id,role:'assistant',kind:'tool',text,time:Date.now()};
  f.core.putMessage(message);
  f.core.store.messages=()=>{throw new Error('Unbounded history materialized');};
  const snapshot=await client.request('sync.open',{selectedSessionId:session.id});
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<1024*1024);
  assert.deepEqual(snapshot.result.messages,[]);
  const preview=(await client.request('activity.list',{sessionId:session.id,limit:100})).result[0];assert.equal(preview.contentTruncated,true);assert.equal(preview.contentChars,500000);
  let complete='';for(let part=0;part<preview.textParts.count;part++){
    const data=mobilePart(f.core.store,{sessionId:session.id,messageId:message.id,revision:preview.revision,part});
    assert.ok(Buffer.byteLength(JSON.stringify(data))<256*1024);complete+=data.content;
  }
  assert.equal(complete,text);assert.equal(mobilePage(f.core.store,session.id,undefined,100,true).items[0].id,message.id);
  assert.throws(()=>mobilePart(f.core.store,{sessionId:session.id,messageId:message.id,revision:'0',part:0}),/changed/);
});

test('provider acceptance followed by lost acknowledgement is unknown and cannot repeat the command',async t=>{
  const f=await fixture(t),client=await connect(t,f);let accepted=0;
  f.core.factory=(_s,h)=>({async send(_text,_images,options){accepted++;h.policy?.(true);options?.beforeAccept?.();options?.onDispatched?.();options?.onAccepted?.();throw new Error('ACK was lost after provider accepted');},async close(){},async interrupt(){}});
  const session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id},f)).result;
  const commandId=randomUUID(),params={sessionId:session.id,text:'exactly one attempt',expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision};
  assert.equal((await client.action('sessions.send',params,f,commandId)).error.code,'OUTCOME_UNKNOWN');
  assert.equal(f.gateway.registry.status(f.device.id,commandId).status,'unknown');
  assert.equal((await client.request('sessions.send',params,commandId)).result.status,'unknown');assert.equal(accepted,1);
});

test('partially executed scripts are unknown, while authority denial prevents their launch',async t=>{
  const f=await fixture(t),marker=join(f.directory,'effect'),script={id:'fixture',name:'Fixture',executable:'/bin/sh',args:['-c','printf once > "$1"; exit 2','fixture',marker],cwd:f.directory,timeout:1000};
  const settings={...f.core.settings,scripts:[script]};
  await assert.rejects(desktopAction('script.run',{id:'fixture'},settings,undefined,()=>{throw new Error('revoked');}),/revoked/);
  await assert.rejects(stat(marker));
  await assert.rejects(desktopAction('script.run',{id:'fixture'},settings),{code:'OUTCOME_UNKNOWN'});
  assert.equal(await readFile(marker,'utf8'),'once');
});

test('memory read context never observes text; mutations reauthorize after awaits and return acknowledged commits',async t=>{
  const f=await fixture(t),session=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});
  await f.core.memory.ready;
  f.core.memory.active=()=>true;
  let observed=0,saved=0;
  const original=f.core.memory.service.call.bind(f.core.memory.service);
  f.core.memory.service.call=async(method:string,p?:any,signal?:AbortSignal)=>{if(method==='observe_text'){observed++;return {id:randomUUID()};}if(method==='save_text'){saved++;return {id:'saved',revision:2};}return original(method,p,signal);};
  f.core.memory.recall=async()=>({evidence:[],snapshot:{revision:1}} as any);
  await f.core.memory.context(session,'read only',new AbortController().signal,1000,undefined,false,()=>{});
  assert.equal(observed,0);
  f.core.memory.scope=async()=>randomUUID();
  await assert.rejects(f.core.memory.save(session,'forbidden',undefined,undefined,false,undefined,()=>{throw new Error('revoked');}),/revoked/);assert.equal(saved,0);
  f.core.memory.refresh=async()=>{throw new Error('Health unavailable after commit');};
  assert.deepEqual(await f.core.memory.save(session,'committed'),{id:'saved',revision:2});assert.equal(saved,1);
  assert.throws(()=>methods['memory.save'].parse({sessionId:session.id,id:randomUUID(),text:'stale edit'}));
});

test('media binary upload validates content and scope; revoke purges submitted files',async t=>{
  const f=await fixture(t);f.device.caps.push('attachments.write','capture.preview');f.gateway.registry.saveDevice(f.device);
  const client=await connect(t,f),session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id},f)).result;
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#5dd8ff'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('base64url');
  const media=(await client.action('attachments.begin',{sessionId:session.id,size:bytes.length,mime:'image/png',sha256},f)).result;
  const header=Buffer.alloc(24);Buffer.from(media.uploadId.replaceAll('-',''),'hex').copy(header);client.ws.send(Buffer.concat([header,bytes]));
  for(let n=0;n<100&&!client.events.some(e=>e.name==='attachment.progress');n++)await new Promise(r=>setTimeout(r,5));
  assert.equal(client.events.find(e=>e.name==='attachment.progress').data.offset,bytes.length);
  const committed=await client.action('attachments.commit',{attachmentId:media.attachmentId},f);assert.equal(committed.result.status,'ready');
  const other=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});assert.throws(()=>f.gateway.router.media.resolve(f.device,other.id,[media.attachmentId]),/scope/);
  const paths=f.gateway.router.media.resolve(f.device,session.id,[media.attachmentId]);f.gateway.router.media.submitted(f.device,[media.attachmentId]);
  await f.gateway.revoke(f.device.id);await assert.rejects(stat(paths[0]));assert.equal(f.gateway.router.media.all().length,0);
});

test('grant changes redact prior command recovery and catalogs without losing deduplication',async t=>{
  const f=await fixture(t),client=await connect(t,f),commandId=randomUUID(),params={provider:'codex',projectId:f.device.projects[0].id,title:'private old project'};
  const created=await client.action('sessions.create',params,f,commandId);assert.equal(created.result.title,params.title);
  const changed={...f.device,scopeVersion:'2',projects:[],caps:['chat.read'],ollamaHosts:[]};f.gateway.registry.saveDevice(changed);f.device=changed;client.ws.terminate();
  f.core.capabilities={codex:{available:true,models:[{id:'private-native-catalog'}]},ollama:{available:true,models:[{id:'private-new-host-model'}]}};
  const fresh=await connect(t,f),snapshot=(await fresh.request('sync.open',{selectedSessionId:created.result.id})).result;
  assert.deepEqual(snapshot.sessionIds,[]);assert.deepEqual(snapshot.providers.codex.models,[]);assert.deepEqual(snapshot.providers.ollama.models,[]);assert.equal(snapshot.providers.ollama.remoteExecution,false);assert.equal(snapshot.settings.defaultModel,'');
  const status=(await fresh.request('commands.status',{commandId})).result;assert.equal(status.status,'completed');assert.equal(status.redacted,true);assert.equal(status.result,undefined);
  const old=await fresh.request('sessions.create',params,commandId);assert.equal(old.result.redacted,true);assert.ok(!JSON.stringify(old).includes(params.title));assert.equal(f.core.store.sessions().length,1);
});

test('handoff creates a reviewed draft only and detects a changed source; history stops on pause',async t=>{
  const f=await fixture(t),client=await connect(t,f),source=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});
  f.core.putMessage({id:randomUUID(),sessionId:source.id,role:'user',kind:'text',text:'Keep the 🦊 details',time:Date.now()});
  const preview=(await client.request('sessions.handoffPreview',{sessionId:source.id})).result;assert.match(preview.draft,/🦊/);
  const params={sourceSessionId:source.id,sourceDigest:preview.sourceDigest,draft:preview.draft,projectId:f.device.projects[0].id,provider:'codex',tools:false};
  const target=(await client.action('sessions.handoffCreate',params,f)).result;assert.equal(target.draft,preview.draft);assert.equal(target.remoteRestricted,true);assert.equal(f.sends(),0);
  f.core.putMessage({id:randomUUID(),sessionId:source.id,role:'assistant',kind:'text',text:'Source changed',time:Date.now()});
  assert.equal((await client.action('sessions.handoffCreate',params,f)).error.code,'REVISION_CONFLICT');
  let abortObserved=false;
  f.core.history=async(_provider,signal)=>{await f.core.updateSettings({paused:true});abortObserved=!!signal?.aborted;return [{nativeId:'private-history',cwd:f.directory,title:'Hidden after pause'}];};
  await assert.rejects(f.gateway.router.dispatch(f.device,'sessions.history',{projectId:f.device.projects[0].id}));assert.equal(abortObserved,true);assert.equal(f.gateway.router.parity.history.size,0);
});

test('erasure epoch also removes retained command content and memory revision inputs never round',async t=>{
  const f=await fixture(t),id=randomUUID();f.gateway.registry.accept(f.device.id,id,'memory.save',{text:'erased evidence'});f.gateway.registry.finish(f.device.id,id,{status:'completed',result:{text:'erased evidence'}});
  const before=f.core.store.get('transcriptEpoch','');f.core.memory.invalidateTranscript();assert.notEqual(f.core.store.get('transcriptEpoch',''),before);assert.ok(!JSON.stringify(f.gateway.registry.status(f.device.id,id)).includes('erased evidence'));
  assert.throws(()=>methods['memory.save'].parse({sessionId:randomUUID(),id:randomUUID(),text:'edit',expectedRevision:'9007199254740993'}));
  assert.equal(availableOperations(['memory.read']).includes('memory.forgetPreview'),false);assert.equal(availableOperations(['memory.write']).includes('memory.forgetPreview'),true);
});

test('remote graph work is bounded inside the canonical worker before inspection or erasure',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-mobile-graph-')),c=new Canonical(directory);t.after(async()=>{c.close();await rm(directory,{recursive:true,force:true});});
  const scope=c.registerScope({key:'mobile-test',label:'Fixture'}).id,preview=await c.call('mobile_forget_preview',{scope_id:scope});assert.equal(preview.count,0);
  c.db.exec('BEGIN');for(let n=0;n<2049;n++)c.run('INSERT INTO lineage VALUES (?,?,?,?)','derived-'+n,'root','test',1);c.db.exec('COMMIT');
  await assert.rejects(c.call('mobile_forget_preview',{scope_id:scope}),{code:'LIMIT_EXCEEDED'});await assert.rejects(c.call('mobile_inspect',{scope_id:scope,id:randomUUID()}),{code:'LIMIT_EXCEEDED'});
});
