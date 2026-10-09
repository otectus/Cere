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
  const f=await fixture(t),client=await connect(t,f);await f.core.updateSettings({profile:'manual',categories:[]});const local=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});await f.core.power.start({sessionIds:[local.id],minutes:5,cli:true,computer:true});
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
  const otherLocal=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});await f.core.power.start({sessionIds:[otherLocal.id],minutes:5,cli:true,computer:false});assert.equal(f.core.approvals.size,1);
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
  assert.throws(()=>methods['sessions.organize'].parse({sessionId:randomUUID(),expectedRevision:'0'}));
  assert.throws(()=>methods['sessions.organize'].parse({sessionId:randomUUID(),expectedRevision:'0',pinned:true,folderId:randomUUID()}));
  assert.deepEqual((methods['sessions.configure'].parse({sessionId:randomUUID(),model:'codex-next',effort:'high',tools:false,expectedConfigRevision:'0'}) as any).effort,'high');
  assert.throws(()=>methods['desktop.execute'].parse({projectId:randomUUID(),action:'script.run',args:{},role:'ui'}));
  const directory=await mkdtemp(join(tmpdir(),'cere-mobile-ledger-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(directory),remote=new RemoteStore(store),device=randomUUID(),id=randomUUID();
  remote.accept(device,id,'desktop.execute',{action:'audio.mute'});store.close();
  const reopened=new Store(directory),registry=new RemoteStore(reopened);try{assert.equal(registry.status(device,id).status,'unknown');assert.throws(()=>registry.prior(device,id,'desktop.execute',{action:'other'}),/command ID/);}finally{reopened.close();}
});

test('session metadata is scoped, CAS-organized, and desktop draft attachments block mobile edits and sends',async t=>{
  const f=await fixture(t),client=await connect(t,f),session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  const folder=f.core.organization.dispatch('folders.save',{name:'Phone work'});
  const attachment={id:randomUUID(),path:join(f.directory,'desktop-draft.png'),name:'desktop-draft.png',mime:'image/png',kind:'image' as const,size:12,sha256:'fixture'};
  f.core.updateSession(session.id,{folderId:folder.id,unread:true,readAt:1234,draft:'Desktop draft',draftAttachments:[attachment]});
  let dto=(await client.request('sessions.get',{sessionId:session.id})).result;
  assert.deepEqual({pinned:dto.pinned,archived:dto.archived,unread:dto.unread,readAt:dto.readAt,folderName:dto.folderName,draftAttachmentCount:dto.draftAttachmentCount,canConfigure:dto.canConfigure},{pinned:false,archived:false,unread:true,readAt:1234,folderName:'Phone work',draftAttachmentCount:1,canConfigure:true});
  const noChange=await client.request('sessions.organize',{sessionId:session.id,expectedRevision:dto.revision,pinned:false},randomUUID());assert.equal(noChange.error.code,'INVALID_ARGUMENT');
  const organized=await client.request('sessions.organize',{sessionId:session.id,expectedRevision:dto.revision,pinned:true,archived:true},randomUUID());assert.equal(organized.result.pinned,true);assert.equal(organized.result.archived,true);
  const stale=await client.request('sessions.organize',{sessionId:session.id,expectedRevision:dto.revision,archived:false},randomUUID());assert.equal(stale.error.code,'REVISION_CONFLICT');
  dto=(await client.request('sessions.get',{sessionId:session.id})).result;
  const edit=await client.request('drafts.put',{sessionId:session.id,text:'Phone overwrite',expectedRevision:dto.draftRevision},randomUUID());assert.equal(edit.error.code,'REVISION_CONFLICT');
  const unchanged=await client.request('drafts.put',{sessionId:session.id,text:'Desktop draft',expectedRevision:dto.draftRevision},randomUUID());assert.equal(unchanged.result.text,'Desktop draft');
  dto=(await client.request('sessions.get',{sessionId:session.id})).result;
  const sent=await client.action('sessions.send',{sessionId:session.id,text:'Do not dispatch',attachments:[],webSearch:false,expectedDraftRevision:dto.draftRevision,expectedConfigRevision:dto.configRevision},f);
  assert.equal(sent.error.code,'REVISION_CONFLICT');assert.equal(f.sends(),0);assert.equal(f.core.store.session(session.id).status,'idle');assert.equal(f.core.store.session(session.id).draftAttachments?.length,1);
});

test('native remote session configuration is explicit, revision-bound, and reauthorized',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  f.core.capabilities.codex={available:true,modelsStatus:'ready',remoteRestricted:true,models:[{id:'codex-next',displayName:'Codex Next',description:'Fixture',efforts:[{id:'high',displayName:'High'}],defaultEffort:'high',isDefault:false}]};
  const local=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});let localDto=(await client.request('sessions.get',{sessionId:local.id})).result;
  assert.equal(localDto.canConfigure,false);
  const localDenied=await client.action('sessions.configure',{sessionId:local.id,model:'codex-next',effort:'high',tools:false,expectedConfigRevision:localDto.configRevision},f);
  assert.equal(localDenied.error.code,'PROVIDER_POLICY_UNSAFE');assert.equal(f.core.store.session(local.id).model,'');
  const session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  assert.equal(session.canConfigure,true);
  const other=await f.core.create({provider:'codex',cwd:f.directory,trusted:true},undefined,{remote:{...f.core.store.session(session.id).remote!,deviceId:randomUUID()},effectivePolicy:'unknown'}),otherDto=(await client.request('sessions.get',{sessionId:other.id})).result;
  assert.equal(otherDto.canConfigure,false);
  const otherDenied=await client.action('sessions.configure',{sessionId:other.id,model:'codex-next',effort:'high',tools:false,expectedConfigRevision:otherDto.configRevision},f);
  assert.equal(otherDenied.error.code,'PROVIDER_POLICY_UNSAFE');assert.equal(f.core.store.session(other.id).model,'');
  await assert.rejects(f.core.configureSession({id:session.id,model:'codex-next',effort:'high',tools:false,expectedConfigRevision:session.configRevision}),/Detach this conversation/);
  const configured=await client.action('sessions.configure',{sessionId:session.id,model:'codex-next',effort:'high',tools:false,expectedConfigRevision:session.configRevision},f);
  assert.equal(configured.result.model,'codex-next');assert.equal(configured.result.effort,'high');assert.equal(configured.result.canConfigure,true);
  const stale=await client.action('sessions.configure',{sessionId:session.id,model:'',tools:false,expectedConfigRevision:session.configRevision},f);assert.equal(stale.error.code,'REVISION_CONFLICT');
  f.core.updateSession(session.id,{status:'working'});const active=(await client.request('sessions.get',{sessionId:session.id})).result;assert.equal(active.canConfigure,false);
  for(const status of ['error','interrupted','disconnected'] as const){
    f.core.updateSession(session.id,{status});assert.equal((await client.request('sessions.get',{sessionId:session.id})).result.canConfigure,true);
  }
  f.core.updateSession(session.id,{status:'idle',agents:[{id:randomUUID(),name:'Active worker',status:'running',updated:Date.now()}]});
  assert.equal((await client.request('sessions.get',{sessionId:session.id})).result.canConfigure,false);
  f.core.updateSession(session.id,{agents:[]});
  f.core.updateSession(session.id,{status:'idle'});const current=f.core.store.session(session.id);let loading=false,release!:(models:any[])=>void;
  f.core.capabilities.codex={...f.core.capabilities.codex,modelsStatus:'loading'};
  f.core.modelLoader=async()=>{loading=true;return new Promise(resolve=>{release=resolve;});};
  const changing=client.action('sessions.configure',{sessionId:session.id,model:'codex-later',effort:'',tools:false,expectedConfigRevision:current.configRevision},f);
  for(let n=0;n<100&&!loading;n++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(loading,true);
  f.gateway.registry.saveDevice({...f.device,scopeVersion:'2'});release([{id:'codex-later',displayName:'Codex Later',description:'Fixture',efforts:[],defaultEffort:'',isDefault:false}]);
  const revoked=await changing;assert.equal(revoked.error.code,'SCOPE_CHANGED');assert.equal(f.core.store.session(session.id).model,'codex-next');
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

test('changed capture approvals stay reviewable while ended approvals report gone',async t=>{
  const f=await fixture(t);f.device.caps.push('capture.preview');f.gateway.registry.saveDevice(f.device);
  const client=await connect(t,f),session=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});
  const capture=join(f.directory,'capture.png');
  await writeFile(capture,await sharp({create:{width:8,height:8,channels:3,background:'#5dd8ff'}}).png().toBuffer());
  const pending=f.core.approval(session.id,{kind:'image',title:'Share capture',detail:'Original capture',image:capture,choices:['allow','deny']});
  const approval=(await client.request('approvals.list')).result[0];
  const params={approvalId:approval.id,revision:approval.revision,digest:approval.digest};
  const preview=(await client.request('approvals.preview',params)).result;assert.ok(preview?.readId);
  f.core.approvals.get(approval.id)!.value.detail='Updated capture';
  assert.equal((await client.request('approvals.preview',params)).error.code,'REVISION_CONFLICT');
  assert.equal((await client.request('attachments.read',{readId:preview.readId,offset:0,length:100})).error.code,'REVISION_CONFLICT');
  const current=(await client.request('approvals.get',{approvalId:approval.id})).result;
  assert.equal(current.id,approval.id);assert.notEqual(current.digest,approval.digest);
  const fresh=(await client.request('approvals.preview',{...params,digest:current.digest})).result;assert.ok(fresh?.readId);
  f.core.answer({id:approval.id,choice:'deny'});assert.equal((await pending).choice,'deny');
  assert.equal((await client.request('approvals.preview',{...params,digest:current.digest})).error.code,'APPROVAL_GONE');
  assert.equal((await client.request('attachments.read',{readId:fresh.readId,offset:0,length:100})).error.code,'APPROVAL_GONE');
  assert.deepEqual((await client.request('approvals.list')).result,[]);
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
test('mobile permission reduction is revision-bound, subset-only and immediately revokes prior authority',async t=>{
  const f=await fixture(t),client=await connect(t,f),original=f.gateway.registry.live(f.device.id)!;
  assert.ok((await client.request('devices.self',{})).result.projects.length);
  const expansion=await client.request('permissions.reduce',{expectedScopeVersion:original.scopeVersion,caps:[...original.caps,'unknown.capability']},randomUUID());assert.equal(expansion.error.code,'SCOPE_DENIED');
  const stale=await client.request('permissions.reduce',{expectedScopeVersion:'0',caps:[]},randomUUID());assert.equal(stale.error.code,'REVISION_CONFLICT');
  const result=await client.request('permissions.reduce',{expectedScopeVersion:original.scopeVersion,caps:['chat.read'],categories:[],scriptIds:[],projectIds:[],ollamaHosts:[]},randomUUID());
  assert.equal(result.result.reconnectRequired,true);assert.notEqual(result.result.scopeVersion,original.scopeVersion);
  assert.deepEqual(f.gateway.registry.live(f.device.id)!.caps,['chat.read']);assert.equal(f.gateway.registry.live(f.device.id)!.projects.length,0);
  assert.throws(()=>f.gateway.router.current(original),/changed/i);
});

test('network loss waits without disabling remote authority and restores the listener',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  const session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  await client.action('sessions.send',{sessionId:session.id,text:'Retain accepted work',attachments:[],webSearch:false,expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision},f);
  const before=f.core.store.session(session.id).status;
  f.gateway.availableAddresses=()=>[];
  await f.gateway.maintain();
  assert.equal(f.gateway.registry.config().enabled,true);
  assert.equal(f.gateway.servers.length,0);
  assert.equal((f.core.remoteStatus as any).waitingForNetwork,true);
  assert.equal(f.core.store.session(session.id).status,before);
  f.gateway.availableAddresses=()=>['127.0.0.1'];
  await f.gateway.maintain();
  const reconnected=await connect(t,f);
  assert.equal((f.core.remoteStatus as any).waitingForNetwork,false);
  assert.equal((await reconnected.request('sessions.get',{sessionId:session.id})).result.id,session.id);
  await f.gateway.disable();await f.gateway.maintain();
  assert.equal(f.gateway.registry.config().enabled,false);assert.equal(f.gateway.servers.length,0);
});

test('a transient bind failure retries without poisoning gateway lifecycle',async t=>{
  const f=await fixture(t);await f.gateway.stopListeners();
  const occupied=net.createServer();
  await new Promise<void>(resolve=>occupied.listen(f.gateway.registry.config().port,'127.0.0.1',resolve));
  try {
    await f.gateway.start();
    assert.equal(f.gateway.registry.config().enabled,true);assert.equal(f.gateway.servers.length,0);
    assert.ok((f.core.remoteStatus as any).networkError);
  } finally {await new Promise<void>(resolve=>occupied.close(()=>resolve()));}
  await f.gateway.start();assert.equal(f.gateway.servers.length,1);
  await connect(t,f);
});

test('trusted replacement is desktop-selected, retains scopes and ownership, and still requires exact action signatures',async t=>{
  const f=await fixture(t),oldClient=await connect(t,f);
  assert.equal(oldClient.welcome.actionAuthentication,'biometric');
  const session=(await oldClient.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  await oldClient.action('sessions.send',{sessionId:session.id,text:'Active replacement',attachments:[],webSearch:false,expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision},f);
  assert.ok(['starting','working','waiting'].includes(f.core.store.session(session.id).status));
  const prepared:any=await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],port:f.gateway.registry.config().port,name:'Replacement',actionAuthentication:'trusted-device',replacesDeviceId:f.device.id});
  const offer=parsePairing(prepared.uri);assert.equal(offer.actionAuthentication,'trusted-device');assert.equal(offer.replacesDeviceId,f.device.id);
  assert.ok(Buffer.byteLength(prepared.uri)<=2000);
  const connection=keypair(),action=keypair();
  const body={type:'response',v:1,desktopId:offer.desktopId,pairingId:offer.pairingId,offerDigest:digest(offer),nonce:offer.nonce,deviceId:randomUUID(),name:'Trusted phone',keyVersion:1,connectionKey:pub(connection),actionKey:pub(action),deviceNonce:randomBytes(32).toString('base64url')};
  const transcript={domain:'cere.mobile.pair.response.v1',response:body};
  const response=pairingUri({...body,connectionProof:proof(connection,transcript),actionProof:proof(action,transcript)});
  const review:any=await f.gateway.local('remote.reviewPair',{response});assert.equal(review.actionAuthentication,'trusted-device');
  const params={response,sas:review.sas,confirmed:true,projectPaths:[f.directory],caps:f.device.caps,categories:f.device.categories};
  await assert.rejects(()=>f.gateway.local('remote.confirmPair',{...params,actionAuthentication:'biometric'}));
  // Inject a crash boundary after the durable confirm transaction but before
  // in-memory session transfer. A fresh gateway must finish from the stored marker.
  const committed=f.gateway.pairing.confirm(params);
  assert.equal(committed.replacementPending,true);
  assert.equal(f.core.store.session(session.id).remote?.deviceId,f.device.id);
  assert.throws(()=>f.gateway.router.current(committed),/recovering/);
  await f.gateway.close();
  f.gateway=new MobileGateway(f.core);t.after(()=>f.gateway.close());
  await f.gateway.start();
  assert.equal(f.gateway.registry.live(committed.id)?.replacementPending,false);
  assert.equal(f.gateway.registry.live(f.device.id),undefined);
  const device=f.gateway.registry.live(body.deviceId)!;assert.equal(device.actionAuthentication,'trusted-device');
  assert.equal(device.projects[0].id,f.device.projects[0].id);
  assert.equal(f.core.store.session(session.id).remote?.deviceId,device.id);
  assert.ok(!['starting','working','waiting','stopping'].includes(f.core.store.session(session.id).status));
  const replacement={...f,offer,connection,action,device},client=await connect(t,replacement);
  assert.equal(client.welcome.actionAuthentication,'trusted-device');
  assert.equal((await client.request('devices.self')).result.actionAuthentication,'trusted-device');
  const settings={expectedRevision:f.core.store.get('settingsRevision','0'),personality:'Trusted exact action'};
  assert.equal((await client.action('settings.patch',settings,replacement,randomUUID(),connection)).error.code,'UNAUTHENTICATED');
  assert.ok((await client.action('settings.patch',settings,replacement)).result);
  await f.gateway.revoke(device.id);assert.equal(f.gateway.registry.live(device.id),undefined);
});

test('locally confirmed endpoint renewal preserves identity and invalidates obsolete pairing offers',async t=>{
  const f=await fixture(t),original=f.gateway.identity.material();
  const prepared:any=await f.gateway.local('remote.preparePair',{addresses:['127.0.0.1'],port:f.gateway.registry.config().port});
  await assert.rejects(()=>f.gateway.local('remote.configureEndpoints',{addresses:['127.0.0.1'],confirmed:false}));
  await f.gateway.local('remote.configureEndpoints',{addresses:['127.0.0.1'],port:f.gateway.registry.config().port,confirmed:true});
  assert.equal(f.gateway.identity.id,f.offer.desktopId);assert.equal(f.gateway.identity.material().spki,original.spki);
  assert.equal(f.gateway.identity.material().identityKey,original.identityKey);
  assert.equal(f.gateway.registry.store.db.prepare('SELECT count(*) AS n FROM remote_pair_offers').get()!.n,0);
  assert.ok(prepared.uri);assert.equal(f.gateway.registry.live(f.device.id)?.id,f.device.id);
});

 test('a retired listener error cannot close its replacement on the same address',async t=>{
  const f=await fixture(t),retired=f.gateway.servers[0];
  await f.gateway.stopListeners();await f.gateway.start();
  const replacement=f.gateway.servers[0];assert.notEqual(replacement,retired);
  retired.emit('error',new Error('Late error from a retired listener'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.gateway.servers[0],replacement);assert.equal(replacement.listening,true);
  await connect(t,f);
});

test('mobile Ollama follow-ups queue with signed deduplication, keep draft CAS, and include delegated approval ancestry',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  // This fixture device must explicitly grant the configured Ollama host.
  f.core.capabilities.ollama={available:true,modelsStatus:'ready',models:[{id:'fixture',displayName:'Fixture',description:'',efforts:[],defaultEffort:'',isDefault:true}]};
  f.device.ollamaHosts=[f.core.settings.ollama.host];f.gateway.registry.saveDevice(f.device);
  const created=await client.action('sessions.create',{provider:'ollama',projectId:f.device.projects[0].id,tools:false,model:'fixture'},f);
  assert.ok(created.result,JSON.stringify(created));let session=created.result;
  const params=()=>({sessionId:session.id,text:'message '+f.sends(),attachments:[],webSearch:false,expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision});
  const first=await client.action('sessions.send',params(),f);assert.equal(first.result.status,'accepted');
  session=(await client.request('sessions.get',{sessionId:session.id})).result;assert.equal(session.canQueue,true);
  const input=params(),commandId=randomUUID();const queued=await client.action('sessions.send',input,f,commandId);assert.equal(queued.result.status,'queued');assert.equal(f.sends(),1);
  const replay=await client.request('sessions.send',input,commandId);assert.deepEqual(replay.result,queued.result);
  const child=await f.core.create({provider:'codex',cwd:f.directory,trusted:true});f.core.updateSession(child.id,{parentId:session.id,remote:f.core.store.session(session.id).remote,effectivePolicy:'restricted'});
  const waiting=f.core.approval(child.id,{kind:'question',title:'Child needs a choice',detail:'',choices:['answer'],questions:[{id:'q',question:'Proceed?',allowOther:true}]});
  const approvals=(await client.request('approvals.list')).result;const approval=approvals.find((a:any)=>a.sessionId===child.id);
  assert.deepEqual(approval.parentSessionIds,[session.id]);assert.equal(approval.canAnswer,true);
  const answer=await client.action('approvals.answer',{approvalId:approval.id,revision:approval.revision,digest:approval.digest,choice:'answer',answers:{q:{answers:['yes']}}},f);assert.equal(answer.result,true);await waiting;f.core.event(child.id,{type:'complete'});
  f.hooks.get(session.id)!.event({type:'complete'});await new Promise(r=>setTimeout(r,60));assert.equal(f.sends(),2);
  assert.equal(f.core.store.messages(session.id).filter(m=>m.role==='user').length,2);
  await client.request('sessions.stop',{sessionId:session.id},randomUUID());
});
test('mobile rename follows the desktop title rule',async t=>{
  const f=await fixture(t);const s=await f.core.create({provider:'codex',cwd:f.directory,trusted:true,title:'Original'});
  const renamed=await f.gateway.router.dispatch(f.device,'sessions.rename',{sessionId:s.id,title:'  Spaced title  ',expectedRevision:f.core.store.session(s.id).revision});
  assert.equal(renamed.title,'Spaced title');
  const blank=await f.gateway.router.dispatch(f.device,'sessions.rename',{sessionId:s.id,title:'   ',expectedRevision:f.core.store.session(s.id).revision});
  assert.equal(blank.title,'Untitled session');
});
