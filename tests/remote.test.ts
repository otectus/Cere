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
  const directory=await mkdtemp(join(tmpdir(),'cere-mobile-test-'));let sends=0,sent:{text:string;images:string[]}|undefined;const hooks=new Map<string,Hooks>();
  const core=new Core(new Store(directory),(session,h)=>{hooks.set(session.id,h);return {async send(text,images,options){sends++;sent={text,images:images||[]};h.policy?.(true);options?.beforeAccept?.();options?.onDispatched?.();options?.onAccepted?.();},async interrupt(){h.event({type:'interrupted'});},async close(){}};});
  // One cleanup owner, released in reverse order: client sockets, then every gateway (a replacement
  // included), then Core and its store, then the directory. No gateway callback can outlive the store.
  const resources:(()=>unknown)[]=[];
  const own=(release:()=>unknown)=>{resources.push(release);};
  t.after(async()=>{for(const release of resources.reverse())await release();});
  own(()=>rm(directory,{recursive:true,force:true}));own(()=>core.close());
  const gateway=new MobileGateway(core);own(()=>gateway.close());
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
  return {directory,core,gateway,offer,connection,action,device,hooks,sends:()=>sends,sent:()=>sent,own};
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
  const client=new Client(ws);f.own(()=>ws.terminate());await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
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

// W10: a capture started from the phone is an accepted job; its image is immutable once ready and
// reaches a conversation only when the phone attaches that exact image (by digest) and sends it.
test('a phone-started capture is previewed, attached by its exact digest, sent, and cancelled or discarded cleanly',async t=>{
  const f=await fixture(t);
  const bin=await mkdtemp(join(tmpdir(),'cere-capture-bin-')),png=join(bin,'display.png');t.after(()=>rm(bin,{recursive:true,force:true}));
  await sharp({create:{width:320,height:200,channels:3,background:{r:40,g:90,b:160}}}).png().toFile(png);
  const script=(name:string,body:string)=>writeFile(join(bin,name),'#!/bin/sh\n'+body+'\n',{mode:0o755});
  await script('hyprctl',`echo '[{"name":"FAKE-1","focused":true,"disabled":false}]'`);
  await script('grim',`cp "${png}" "$3"`);
  // Satty saves only when told to: closing it without saving cancels the capture.
  await script('satty',`[ "$1" = --version ] && { echo satty 0.0.0; exit 0; }; [ -f "${bin}/save" ] && cp "$2" "$4"; exit 0`);
  const path=process.env.PATH;process.env.PATH=bin+':'+path;t.after(()=>{process.env.PATH=path;});
  await f.core.updateSettings({categories:['capture']});
  const closed=new Promise(r=>f.gateway.peers.size?[...f.gateway.peers][0].socket.once('close',r):r(null));
  await f.gateway.local('remote.updateDevice',{id:f.device.id,projectPaths:[f.directory],caps:[...f.device.caps,'capture.preview','attachments.write'],categories:['capture'],scriptIds:[]});
  await closed;
  const device=f.gateway.registry.live(f.device.id)!,scoped={...f,device},client=await connect(t,scoped),projectId=device.projects[0].id;
  await client.request('sync.open',{}); // subscribed: events reach this phone
  const status=async(id:string,wanted:string)=>{for(let n=0;n<200;n++){const value=(await client.request('captures.status',{captureId:id})).result;if(value.state===wanted)return value;await new Promise(r=>setTimeout(r,20));}throw new Error('capture did not reach '+wanted);};
  const started=(await client.action('captures.start',{projectId,edit:false},scoped)).result;assert.equal(started.state,'capturing');
  const ready=await status(started.captureId,'ready');assert.equal(ready.width,320);assert.match(ready.imageDigest,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(client.events.some((event:any)=>event.name==='capture.updated'&&event.data.captureId===started.captureId),'the phone hears of the capture');
  const preview=(await client.request('captures.preview',{captureId:started.captureId})).result;assert.equal(preview.imageDigest,ready.imageDigest);
  const part=await client.request('attachments.read',{readId:preview.readId,offset:0,length:preview.size});assert.equal(part.result.bytes,preview.size);
  await new Promise(r=>setTimeout(r,20));assert.equal(client.binary.at(-1)!.subarray(24,26).toString('hex'),'ffd8','a JPEG preview arrives');
  const session=(await client.action('sessions.create',{provider:'codex',projectId,tools:false},scoped)).result;
  assert.equal((await client.action('captures.attach',{captureId:started.captureId,sessionId:session.id,imageDigest:'A'.repeat(43)},scoped)).error.code,'REVISION_CONFLICT','only the reviewed image can be attached');
  const attached=(await client.action('captures.attach',{captureId:started.captureId,sessionId:session.id,imageDigest:ready.imageDigest},scoped)).result;
  assert.equal(attached.status,'ready');assert.equal((await client.request('captures.status',{captureId:started.captureId})).result.state,'attached');
  const sent=await client.action('sessions.send',{sessionId:session.id,text:'What is on this screen?',attachments:[attached.attachmentId],webSearch:false,expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision},scoped);
  assert.equal(sent.result?.status,'accepted',JSON.stringify(sent.error));
  // Editing on the desktop: closing Satty without saving cancels; a ready capture can be discarded.
  const editing=(await client.action('captures.start',{projectId,edit:true},scoped)).result;
  assert.match((await status(editing.captureId,'cancelled')).message,/without saving/);
  await writeFile(join(bin,'save'),'');
  const edited=(await client.action('captures.start',{projectId,edit:true},scoped)).result;await status(edited.captureId,'ready');
  assert.equal((await client.request('captures.discard',{captureId:edited.captureId},randomUUID())).result,true);
  assert.equal((await client.request('captures.status',{captureId:edited.captureId})).error.code,'INVALID_ARGUMENT');
  // Without the capture category the phone cannot start one.
  await f.core.updateSettings({categories:[]});
  assert.equal((await client.action('captures.start',{projectId,edit:false},scoped)).error.code,'CATEGORY_DISABLED');
});

test('the phone reviews a desktop draft\'s attachments, keeps or removes them explicitly, and sends them by digest',async t=>{
  const f=await fixture(t);
  const closed=new Promise(r=>f.gateway.peers.size?[...f.gateway.peers][0].socket.once('close',r):r(null));
  await f.gateway.local('remote.updateDevice',{id:f.device.id,projectPaths:[f.directory],caps:[...f.device.caps,'capture.preview','attachments.write'],categories:[],scriptIds:[]});
  await closed;
  const device=f.gateway.registry.live(f.device.id)!,scoped={...f,device},client=await connect(t,scoped),projectId=device.projects[0].id;
  const session=(await client.action('sessions.create',{provider:'codex',projectId,tools:false},scoped)).result;
  // The desktop attaches an image and a text file to the draft.
  const files=await mkdtemp(join(tmpdir(),'cere-draft-files-'));t.after(()=>rm(files,{recursive:true,force:true}));
  await sharp({create:{width:64,height:48,channels:3,background:{r:200,g:30,b:30}}}).png().toFile(join(files,'chart.png'));
  await writeFile(join(files,'notes.txt'),'Quarterly notes\n');
  f.core.draft(session.id,'Desktop draft');
  const image=await f.core.attachments.import(session.id,join(files,'chart.png')),notes=await f.core.attachments.import(session.id,join(files,'notes.txt'));
  let dto=(await client.request('sessions.get',{sessionId:session.id})).result;
  assert.deepEqual(dto.draftAttachments.map((a:any)=>[a.name,a.kind,a.sha256]),[['chart.png','image',image.sha256],['notes.txt','text',notes.sha256]]);
  assert.ok(dto.draftAttachments.every((a:any)=>!('path' in a)),'no desktop path reaches the phone');
  assert.ok(!(await client.request('sessions.list',{})).result.items.find((s:any)=>s.id===session.id).draftAttachments.length,'only the open conversation carries them');
  // Review: the text file's opening, and a reduced copy of the image bound to the original's digest.
  const text=(await client.request('drafts.attachmentPreview',{sessionId:session.id,attachmentId:notes.id})).result;
  assert.deepEqual([text.kind,text.text,text.truncated],['text','Quarterly notes\n',false]);
  const preview=(await client.request('drafts.attachmentPreview',{sessionId:session.id,attachmentId:image.id})).result;
  assert.equal(preview.imageDigest,image.sha256);
  assert.equal((await client.request('attachments.read',{readId:preview.readId,offset:0,length:preview.size})).result.bytes,preview.size);
  await new Promise(r=>setTimeout(r,20));assert.equal(client.binary.at(-1)!.subarray(24,26).toString('hex'),'ffd8','a JPEG preview arrives');
  // A phone that names the attachments it keeps may edit the text; they stay in the draft.
  const kept=(await client.request('drafts.put',{sessionId:session.id,text:'Compare these',expectedRevision:dto.draftRevision,desktopAttachmentIds:[image.id,notes.id]},randomUUID())).result;
  assert.deepEqual(kept.draftAttachments.map((a:any)=>a.id),[image.id,notes.id]);assert.equal(f.core.store.session(session.id).draft,'Compare these');
  assert.equal((await client.request('drafts.put',{sessionId:session.id,text:'x',expectedRevision:kept.revision,desktopAttachmentIds:[randomUUID()]},randomUUID())).error.code,'REVISION_CONFLICT','an unknown attachment is refused');
  // Removing one is explicit; its private copy goes once nothing refers to it.
  const removed=(await client.request('drafts.put',{sessionId:session.id,text:'Compare these',expectedRevision:kept.revision,desktopAttachmentIds:[image.id]},randomUUID())).result;
  assert.deepEqual(removed.draftAttachments.map((a:any)=>a.id),[image.id]);
  await assert.rejects(stat(notes.path),/ENOENT/);
  dto=(await client.request('sessions.get',{sessionId:session.id})).result;
  const send=(desktopAttachments?:unknown)=>client.action('sessions.send',{sessionId:session.id,text:'Compare these',attachments:[],...(desktopAttachments?{desktopAttachments}:{}),webSearch:false,expectedDraftRevision:dto.draftRevision,expectedConfigRevision:dto.configRevision},scoped);
  assert.equal((await send()).error.code,'REVISION_CONFLICT','an unreviewed draft attachment is never dropped or sent');
  assert.equal((await send([{id:image.id,sha256:'0'.repeat(64)}])).error.code,'REVISION_CONFLICT','only the reviewed content is sent');
  assert.equal(f.sends(),0);
  const sent=await send([{id:image.id,sha256:image.sha256}]);
  assert.equal(sent.result?.status,'accepted',JSON.stringify(sent.error));
  assert.deepEqual(f.sent()!.images,[image.path],'the provider receives the exact desktop file');
  const after=f.core.store.session(session.id);assert.deepEqual([after.draft,after.draftAttachments],['',[]]);
  assert.ok(f.core.store.messages(session.id).some(m=>m.role==='user'&&m.text.startsWith('Compare these')&&m.text.includes('Attached files: chart.png')));
});

// W11: pinned replies are the desktop's bookmarks, shared both ways and limited to the phone's conversations.
test('the phone pins and unpins replies the desktop shows as bookmarks, within its own conversations',async t=>{
  const f=await fixture(t),client=await connect(t,f),projectId=f.device.projects[0].id;
  const session=(await client.action('sessions.create',{provider:'codex',projectId,title:'Pins',tools:false},f)).result;
  const elsewhere=await mkdtemp(join(tmpdir(),'cere-pins-outside-'));t.after(()=>rm(elsewhere,{recursive:true,force:true}));
  const outside=await f.core.create({provider:'codex',cwd:elsewhere,trusted:true});
  const reply={id:randomUUID(),sessionId:session.id,role:'assistant',kind:'text',text:'Use Ruff for formatting.',time:Date.now()} as any;
  const hidden={id:randomUUID(),sessionId:outside.id,role:'assistant',kind:'text',text:'Outside reply',time:Date.now()} as any;
  f.core.putMessage(reply);f.core.putMessage(hidden);
  await f.core.rpc('message.bookmark',{sessionId:outside.id,messageId:hidden.id,bookmarked:true});
  const pinned=(await client.request('messages.bookmark',{sessionId:session.id,messageId:reply.id,bookmarked:true},randomUUID())).result;
  assert.equal(pinned.bookmarked,true);assert.ok(f.core.store.bookmarks().some(b=>b.messageId===reply.id),'the desktop shows it as a bookmark');
  assert.equal((await client.request('sessions.messages',{sessionId:session.id,limit:10})).result.items.find((m:any)=>m.id===reply.id).bookmarked,true);
  const listed=(await client.request('messages.bookmarks',{})).result.items;
  assert.deepEqual(listed.map((m:any)=>[m.id,m.sessionTitle]),[[reply.id,'Pins']],'only pins in the phone\'s conversations are listed');
  assert.equal((await client.request('messages.bookmarks',{sessionId:outside.id})).error.code,'SCOPE_DENIED');
  assert.equal((await client.request('messages.bookmark',{sessionId:outside.id,messageId:hidden.id,bookmarked:false},randomUUID())).error.code,'SCOPE_DENIED');
  assert.equal((await client.request('messages.bookmark',{sessionId:session.id,messageId:hidden.id,bookmarked:true},randomUUID())).error!==undefined,true,'a message of another conversation is refused');
  const unpinned=(await client.request('messages.bookmark',{sessionId:session.id,messageId:reply.id,bookmarked:false},randomUUID())).result;
  assert.equal(unpinned.bookmarked,undefined);assert.ok(!f.core.store.bookmarks().some(b=>b.messageId===reply.id));
  assert.ok(f.core.store.bookmarks().some(b=>b.messageId===hidden.id),'the desktop\'s other pins are untouched');
});

// W11: the phone sees where a conversation's style is set, and its results and schedules, read-only;
// a schedule can be paused from the phone, never enabled or changed.
test('the phone reads a conversation\'s style source, results and schedules and can only pause a schedule',async t=>{
  const f=await fixture(t),client=await connect(t,f),projectId=f.device.projects[0].id;
  const session=(await client.action('sessions.create',{provider:'codex',projectId,tools:false},f)).result;
  assert.equal((await client.request('sessions.behavior',{sessionId:session.id})).result.source,'global','without a style the personality applies everywhere');
  const style=await f.core.rpc('presets.save',{label:'Reviewer',text:'Review carefully.',expectedRevision:'0'});
  await f.core.rpc('session.behavior',{id:session.id,profileId:style.id});
  const behavior=(await client.request('sessions.behavior',{sessionId:session.id})).result;
  assert.deepEqual([behavior.source,behavior.profile?.label,behavior.standingInstructions],['session','Reviewer',false]);
  const cwd=f.core.store.session(session.id).cwd,now=Date.now();
  f.core.store.set('workflow:results',[{id:session.id+':turn',sessionId:session.id,cwd,time:now,providerOutcome:'completed',verification:'not-run',observed:[]}]);
  const schedule=(id:string,sourceSessionId:string)=>({id,label:'Nightly check',enabled:true,revision:'3',created:now,recipeId:'recipe',recipeVersion:1,recipeRevision:'1',authorizationRevision:'1',inputs:{},sourceSessionId,promptDigest:'digest',envelope:{},when:{kind:'daily',time:'08:00'},timeZone:'UTC',next:now+3600000});
  const elsewhere=await mkdtemp(join(tmpdir(),'cere-schedules-outside-'));t.after(()=>rm(elsewhere,{recursive:true,force:true}));
  const outside=await f.core.create({provider:'codex',cwd:elsewhere,trusted:true});
  f.core.store.set('workflow:schedules',[schedule('mine',session.id),schedule('theirs',outside.id)]);
  const status=(await client.request('workflows.status',{sessionId:session.id})).result;
  assert.deepEqual(status.results.map((r:any)=>[r.providerOutcome,r.verification,r.gate]),[['completed','not-run','none']],'the provider\'s report and Cere\'s own verification stay distinct');
  assert.match(status.results[0].uncertainty,/verification/i);
  assert.deepEqual(status.schedules.map((x:any)=>[x.id,x.enabled]),[['mine',true]],'only this conversation\'s schedules');
  assert.ok(!JSON.stringify(status).includes(elsewhere),'nothing of the other project is shown');
  assert.equal((await client.request('workflows.pauseSchedule',{sessionId:session.id,scheduleId:'theirs',expectedRevision:'3'},randomUUID())).error.code,'SCOPE_DENIED');
  assert.equal((await client.request('workflows.pauseSchedule',{sessionId:session.id,scheduleId:'mine',expectedRevision:'2'},randomUUID())).error.code,'REVISION_CONFLICT');
  const paused=(await client.request('workflows.pauseSchedule',{sessionId:session.id,scheduleId:'mine',expectedRevision:'3'},randomUUID())).result;
  assert.deepEqual([paused.enabled,paused.revision],[false,'4']);
  assert.deepEqual(f.core.schedules.list().map(x=>[x.id,x.enabled]),[['mine',false],['theirs',true]]);
  assert.equal((await client.request('settings.get',{})).result.assistantName,f.core.settings.assistantName,'the phone uses the desktop\'s assistant name');
});

// W11: the plan's remaining phone promises: the static status portrait (F93), Open on desktop for a linked
// terminal (F11), the scoped workspace card (F80) and sanitized memory health (F77).
test('the phone gets the desktop portrait, opens a linked terminal, and reads scoped workspace and memory health',async t=>{
  const f=await fixture(t);
  await f.core.updateSettings({memory:{enabled:true},categories:['windows']});await f.core.memory.ready;
  const bin=await mkdtemp(join(tmpdir(),'cere-terminal-bin-'));t.after(()=>rm(bin,{recursive:true,force:true}));
  const log=join(bin,'calls.log');
  await writeFile(join(bin,'hyprctl'),`#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in\n  "-j clients") [ -f '${bin}/gone' ] && echo '[]' || echo '[{"address":"0xabc","title":"kitty","class":"kitty","workspace":{"id":1}}]';;\n  eval*) echo 'unsupported';;\n  dispatch*) echo ok;;\nesac\n`,{mode:0o755});
  const path=process.env.PATH;process.env.PATH=bin+':'+path;t.after(()=>{process.env.PATH=path;});
  const closed=new Promise(r=>f.gateway.peers.size?[...f.gateway.peers][0].socket.once('close',r):r(null));
  await f.gateway.local('remote.updateDevice',{id:f.device.id,projectPaths:[f.directory],caps:[...f.device.caps,'memory.read'],categories:['windows'],scriptIds:[]});
  await closed;
  const device=f.gateway.registry.live(f.device.id)!,scoped={...f,device},client=await connect(t,scoped),projectId=device.projects[0].id;
  // The portrait: a reduced sheet of expression cells and the desktop's colors for it.
  const portrait=(await client.request('desktop.portrait',{})).result;
  assert.deepEqual([portrait.avatarId,portrait.mime,portrait.cell,portrait.columns,portrait.frames.thinking],[f.core.settings.avatar,'image/webp',96,4,2]);
  const image=Buffer.from(portrait.data,'base64');assert.equal(image.subarray(8,12).toString('ascii'),'WEBP');assert.ok(image.length<200*1024);
  assert.match(portrait.palette.portraitAccent,/^#[0-9a-f]{6}/i);
  const again=(await client.request('desktop.portrait',{known:portrait.sha256})).result;
  assert.deepEqual([again.unchanged,'data' in again,again.sha256],[true,false,portrait.sha256],'a phone holding the sheet is not sent it again');
  // Open on desktop: a linked conversation's terminal window, focused through the windows category.
  const session=(await client.action('sessions.create',{provider:'codex',projectId,tools:false},scoped)).result;
  assert.equal((await client.action('sessions.focusTerminal',{sessionId:session.id},scoped)).error.code,'DESKTOP_UNAVAILABLE','a managed conversation has no terminal');
  f.core.updateSession(session.id,{mode:'linked'});f.core.store.set('link:'+session.id,{address:'0xabc'});
  const focused=await client.action('sessions.focusTerminal',{sessionId:session.id},scoped);
  assert.equal(focused.result?.message,'Window focused',JSON.stringify(focused.error));
  assert.match(await readFile(log,'utf8'),/dispatch focuswindow address:0xabc/);
  await writeFile(join(bin,'gone'),'');
  assert.equal((await client.action('sessions.focusTerminal',{sessionId:session.id},scoped)).error.code,'DESKTOP_UNAVAILABLE','a closed terminal is reported, not focused');
  await f.core.updateSettings({categories:[]});
  assert.equal((await client.action('sessions.focusTerminal',{sessionId:session.id},scoped)).error.code,'CATEGORY_DISABLED');
  // The workspace card: off until workspace awareness runs; then only this project's state.
  assert.equal((await client.request('desktop.workspace',{projectId})).result.state,'unavailable');
  f.core.telemetry.status.enabled=true;
  const call=f.core.memory.service.call.bind(f.core.memory.service);let workspace:any;
  f.core.memory.service.call=(async(method:string,params?:any,signal?:AbortSignal)=>method==='workspace'?workspace:call(method,params,signal)) as any;
  workspace={current:{freshness:'fresh',cwd:join(device.projects[0].path,'src'),checkout:{source:'repository'},window:{properties:{title:'secret window'}}},unknown:[]};
  assert.deepEqual((await client.request('desktop.workspace',{projectId})).result,{state:'in-project',freshness:'fresh',relativePath:'src',verifiedCheckout:true,unknown:[]});
  workspace={current:{freshness:'fresh',cwd:'/home/someone/elsewhere',window:{properties:{title:'secret window'}}},unknown:[]};
  const elsewhere=(await client.request('desktop.workspace',{projectId})).result;
  assert.deepEqual(elsewhere,{state:'elsewhere',freshness:'fresh',unknown:[]});assert.ok(!JSON.stringify(elsewhere).includes('elsewhere/'),'no outside path');
  workspace={current:{freshness:'unknown',cwd:null},unknown:['focused_window','working_directory']};
  assert.deepEqual((await client.request('desktop.workspace',{projectId})).result,{state:'unknown',freshness:'unknown',unknown:['focused_window','working_directory']});
  // Memory health, without endpoints or model names.
  f.core.memory.service.call=call as any;
  const health=(await client.request('memory.health',{sessionId:session.id})).result;
  assert.equal(health.enabled,true);assert.equal(typeof health.state,'string');assert.ok(['ok','failing','unknown'].includes(health.extraction));
  assert.ok(!/127\.0\.0\.1|11434|model/i.test(JSON.stringify(health)),'no endpoint or model name');
});

// W11: the phone operations the feature matrix found without a test of their own. Each works in the
// phone's scope and is refused outside it; nothing reaches the working desktop (fake hyprctl, a private
// applications directory, store-only timers).
test('phone operations without a dedicated test work in scope and are refused outside it',async t=>{
  const f=await fixture(t);
  await f.core.updateSettings({memory:{enabled:true},categories:['apps','windows','timers']});await f.core.memory.ready;
  const bin=await mkdtemp(join(tmpdir(),'cere-ops-bin-')),elsewhere=await mkdtemp(join(tmpdir(),'cere-ops-outside-'));
  t.after(()=>Promise.all([rm(bin,{recursive:true,force:true}),rm(elsewhere,{recursive:true,force:true})]));
  await writeFile(join(bin,'hyprctl'),`#!/bin/sh\necho '[{"address":"0x1","title":"Notes","class":"kitty","workspace":{"id":2},"pid":1}]'\n`,{mode:0o755});
  await mkdir(join(bin,'share','applications'),{recursive:true});
  await writeFile(join(bin,'share','applications','fixture.desktop'),'[Desktop Entry]\nType=Application\nName=Fixture app\n');
  const env={PATH:process.env.PATH,XDG_DATA_HOME:process.env.XDG_DATA_HOME,XDG_DATA_DIRS:process.env.XDG_DATA_DIRS};
  Object.assign(process.env,{PATH:bin+':'+env.PATH,XDG_DATA_HOME:join(bin,'share'),XDG_DATA_DIRS:join(bin,'none')});
  t.after(()=>{for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const closed=new Promise(r=>f.gateway.peers.size?[...f.gateway.peers][0].socket.once('close',r):r(null));
  await f.gateway.local('remote.updateDevice',{id:f.device.id,projectPaths:[f.directory],caps:[...f.device.caps,'memory.read','memory.write','attachments.write'],categories:['apps','windows','timers'],scriptIds:[]});
  await closed;
  const device=f.gateway.registry.live(f.device.id)!,scoped={...f,device},client=await connect(t,scoped),projectId=device.projects[0].id;
  const session=(await client.action('sessions.create',{provider:'codex',projectId,tools:false},scoped)).result;
  const outside=await f.core.create({provider:'codex',cwd:elsewhere,trusted:true});
  // Sync acknowledgement and the draft read.
  assert.equal((await client.request('sync.ack',{cursor:'opaque'})).result,true);
  f.core.draft(session.id,'Desktop words');
  assert.deepEqual((await client.request('drafts.get',{sessionId:session.id})).result,{text:'Desktop words',revision:f.core.store.session(session.id).draftRevision});
  assert.equal((await client.request('drafts.get',{sessionId:outside.id})).error.code,'SCOPE_DENIED');
  // Disconnecting an idle conversation's adapter.
  assert.equal((await client.request('sessions.disconnect',{sessionId:session.id},randomUUID())).result,true);
  assert.equal((await client.request('sessions.disconnect',{sessionId:outside.id},randomUUID())).error.code,'SCOPE_DENIED');
  // An upload's status, then its abort.
  const begun=(await client.action('attachments.begin',{sessionId:session.id,size:68,mime:'image/png',sha256:'A'.repeat(43)},scoped)).result;
  assert.equal((await client.request('attachments.status',{attachmentId:begun.attachmentId})).result.status,'uploading');
  assert.equal((await client.request('attachments.abort',{attachmentId:begun.attachmentId},randomUUID())).result,true);
  assert.equal((await client.request('attachments.status',{attachmentId:begun.attachmentId})).error.code,'ATTACHMENT_INVALID');
  // The desktop status lists the granted categories' actions and any program they still need.
  const status=(await client.request('desktop.status',{projectId})).result;
  assert.deepEqual([...new Set(status.actions.map((a:any)=>a.category))].sort(),['apps','timers','windows']);
  assert.ok(Array.isArray(status.missing),'missing programs are reported, possibly none');
  // The desktop's applications and windows, for granted categories only.
  assert.deepEqual((await client.request('desktop.apps',{projectId})).result.map((app:any)=>app.name),['Fixture app']);
  assert.deepEqual((await client.request('desktop.windows',{projectId})).result,[{address:'0x1',title:'Notes',app:'kitty',workspace:2}]);
  // A timer this project started can be cancelled; another one cannot.
  const mine={id:randomUUID(),label:'Tea',due:Date.now()+60000,remoteProjectId:projectId},theirs={id:randomUUID(),label:'Other',due:Date.now()+60000};
  f.core.store.timer(mine);f.core.store.timer(theirs);
  assert.equal((await client.action('timers.cancel',{projectId,timerId:theirs.id},scoped)).error.code,'SCOPE_DENIED');
  assert.equal((await client.action('timers.cancel',{projectId,timerId:mine.id},scoped)).result,true);
  assert.deepEqual(f.core.store.timers().map(timer=>timer.id),[theirs.id]);
  await f.core.updateSettings({categories:['apps','timers']});
  assert.equal((await client.request('desktop.windows',{projectId})).error.code,'CATEGORY_DISABLED');
  // Recall without the memory server address; clearing a project is confirmed and leaves a checkable job.
  assert.ok((await client.action('memory.save',{sessionId:session.id,text:'Atlas deploys on Fridays.'},scoped)).result);
  const recalled=(await client.request('memory.retrieve',{sessionId:session.id,query:'Atlas Fridays'})).result;
  assert.ok(recalled&&typeof recalled==='object'&&!('host' in recalled),'the memory server address stays on the desktop');
  // Forgetting one record: previewed, then bound to that preview's selection and revision.
  const note=(await client.action('memory.save',{sessionId:session.id,text:'Atlas uses Kitty.'},scoped)).result;
  const one=(await client.request('memory.forgetPreview',{sessionId:session.id,id:note.id})).result;
  assert.equal((await client.action('memory.forget',{sessionId:session.id,id:note.id,selection:'0'.repeat(64),expectedRevision:one.revision},scoped)).error!==undefined,true,'a changed selection is refused');
  assert.ok((await client.action('memory.forget',{sessionId:session.id,id:note.id,selection:one.selection,expectedRevision:one.revision},scoped)).result);
  assert.doesNotMatch(JSON.stringify((await client.request('memory.list',{sessionId:session.id,kind:'saved',offset:0,filter:''})).result),/Kitty/,'the forgotten record is gone at once');
  const preview=(await client.request('memory.forgetPreview',{sessionId:session.id})).result;
  assert.equal((await client.action('memory.clear',{sessionId:session.id,confirmProjectId:randomUUID(),selection:preview.selection,expectedRevision:preview.revision},scoped)).error.code,'INVALID_ARGUMENT','the project must be confirmed');
  const cleared=(await client.action('memory.clear',{sessionId:session.id,confirmProjectId:projectId,selection:preview.selection,expectedRevision:preview.revision},scoped));
  const jobId=cleared.result?.job_id||cleared.result?.id;assert.ok(jobId,JSON.stringify(cleared));
  const erasure=(await client.request('memory.erasureStatus',{sessionId:session.id,jobId})).result;
  assert.equal(typeof erasure.state,'string');assert.equal(typeof erasure.purgeComplete,'boolean');
  assert.equal((await client.request('memory.erasureStatus',{sessionId:session.id,jobId:randomUUID()})).error.code,'SCOPE_DENIED','another job is not visible');
  assert.doesNotMatch(JSON.stringify((await client.request('memory.list',{sessionId:session.id,kind:'saved',offset:0,filter:''})).result),/Fridays/,'cleared memory is gone at once');
  assert.ok((await client.action('memory.resolveConflict',{sessionId:session.id,id:randomUUID(),expectedRevision:'1',statement:'Keep the newer one.'},scoped)).error,'an unknown conflict is refused');
  // Importing desktop CLI history: a single-use ticket for one listed conversation.
  f.core.history=async()=>[{nativeId:'native-history-1',cwd:f.directory,title:'Earlier Codex work'}] as any;
  const history=(await client.request('sessions.history',{projectId})).result;assert.equal(history.items.length,1);
  const imported=await client.action('sessions.import',{historyId:history.items[0].id,externalWriterStopped:true},scoped);
  assert.equal(imported.result?.title,'Earlier Codex work',JSON.stringify(imported.error));assert.equal(f.core.store.session(imported.result.id).nativeId,'native-history-1');
  assert.equal((await client.action('sessions.import',{historyId:history.items[0].id,externalWriterStopped:true},scoped)).error.code,'REVISION_CONFLICT','a history ticket is single-use');
  // Claude Code history, as the desktop lists it, only where Claude's restricted mode is available.
  f.core.history=async(provider:string)=>provider==='claude'?[{nativeId:'claude-history-1',cwd:f.directory,title:'Earlier Claude work'}]:[] as any;
  f.core.capabilities.claude={...f.core.capabilities.claude,remoteRestricted:false} as any;
  assert.equal((await client.request('sessions.history',{projectId,provider:'claude'})).error.code,'PROVIDER_POLICY_UNSAFE');
  f.core.capabilities.claude={...f.core.capabilities.claude,remoteRestricted:true} as any;
  const claudeHistory=(await client.request('sessions.history',{projectId,provider:'claude'})).result;
  assert.deepEqual(claudeHistory.items.map((item:any)=>[item.title,item.provider]),[['Earlier Claude work','claude']]);
  const claude=(await client.action('sessions.import',{historyId:claudeHistory.items[0].id,externalWriterStopped:true},scoped)).result;
  assert.deepEqual([claude.provider,f.core.store.session(claude.id).nativeId,f.core.store.session(claude.id).effectivePolicy],['claude','claude-history-1','restricted']);
  // Pausing from the phone; then the phone revokes itself.
  assert.equal((await client.request('permissions.pause',{},randomUUID())).result,true);assert.equal(f.core.settings.paused,true);
  await f.core.updateSettings({paused:false});
  const gone=new Promise(r=>client.ws.once('close',r));
  assert.equal((await client.request('devices.selfRevoke',{},randomUUID())).result,true);
  await gone;assert.equal(f.gateway.registry.live(f.device.id),undefined,'the pairing is gone');
});

// W09: memory belongs to the conversation's project on its memory server, whichever provider it uses;
// the phone reaches it only while that server is granted to it.
test('project memory is shared across provider conversations on the phone and follows the granted memory server',async t=>{
  const f=await fixture(t);
  await f.core.updateSettings({memory:{enabled:true}});await f.core.memory.ready;
  let closed=new Promise(r=>f.gateway.peers.size?[...f.gateway.peers][0].socket.once('close',r):r(null));
  await f.gateway.local('remote.updateDevice',{id:f.device.id,projectPaths:[f.directory],caps:[...f.device.caps,'memory.read','memory.write'],categories:f.device.categories,scriptIds:[]});
  await closed;
  const device=f.gateway.registry.live(f.device.id)!,scoped={...f,device},client=await connect(t,scoped),projectId=device.projects[0].id;
  const codex=(await client.action('sessions.create',{provider:'codex',projectId,tools:false},scoped)).result;
  const saved=await client.action('memory.save',{sessionId:codex.id,text:'Atlas formats with Ruff.'},scoped);
  assert.ok(saved.result?.id,JSON.stringify(saved.error));
  const listed=(await client.request('memory.list',{sessionId:codex.id,kind:'saved',offset:0,filter:''})).result;
  assert.ok(JSON.stringify(listed).includes('Atlas formats with Ruff.'),'a Codex conversation reaches its project memory');
  // The same project and memory server: a desktop conversation of another provider sees the same memory.
  const other=await f.core.create({provider:'claude',cwd:f.directory,trusted:true});
  assert.ok(JSON.stringify((await client.request('memory.list',{sessionId:other.id,kind:'saved',offset:0,filter:''})).result).includes('Atlas formats with Ruff.'));
  // A memory server the phone was not granted is refused, with the reason.
  await f.core.updateSettings({ollama:{...f.core.settings.ollama,host:'http://127.0.0.2:11434'}});
  const refused=await client.request('memory.list',{sessionId:codex.id,kind:'saved',offset:0,filter:''});
  assert.equal(refused.error.code,'SCOPE_DENIED');assert.match(refused.error.message,/memory server/);
});

// W09: history, corrections and identity decisions from the phone are typed, bound to the reviewed
// revision and witnessed by the person's own statement.
test('the phone reviews an assertion history, corrects it at its revision and records identity decisions',async t=>{
  const f=await fixture(t);
  await f.core.updateSettings({memory:{enabled:true}});await f.core.memory.ready;
  const closed=new Promise(r=>f.gateway.peers.size?[...f.gateway.peers][0].socket.once('close',r):r(null));
  await f.gateway.local('remote.updateDevice',{id:f.device.id,projectPaths:[f.directory],caps:[...f.device.caps,'memory.read','memory.write'],categories:f.device.categories,scriptIds:[]});
  await closed;
  const device=f.gateway.registry.live(f.device.id)!,scoped={...f,device},client=await connect(t,scoped);
  const session=(await client.action('sessions.create',{provider:'codex',projectId:device.projects[0].id,tools:false},scoped)).result;
  const scope_id=await f.core.memory.scope(f.core.store.session(session.id));
  const observed=await f.core.memory.service.call('observe_text',{scope_id,text:'Atlas uses Kitty.',role:'user'});
  await f.core.memory.service.call('remember',{scope_id,claim:{subject:{type:'Project',name:'Atlas'},predicate:'USES_TOOL',object:{type:'Tool',name:'Kitty'}},witness:{observation_id:observed.id,quote:'Atlas uses Kitty.'}});
  const assertions=async()=>(await client.request('memory.list',{sessionId:session.id,kind:'assertions',offset:0,filter:''})).result.rows;
  const [record]=await assertions();assert.match(record?.text,/Atlas USES_TOOL Kitty/);
  const history=await client.request('memory.timeline',{sessionId:session.id,id:record.id});assert.ok(history.result,JSON.stringify(history.error));
  const stale=await client.action('memory.correct',{sessionId:session.id,id:record.id,expectedRevision:String(Number(record.revision)+5),statement:'Atlas now uses Ghostty.',change:{objectName:'Ghostty'}},scoped);
  assert.equal(stale.error.code,'REVISION_CONFLICT','a correction is bound to the revision the person reviewed');
  const corrected=await client.action('memory.correct',{sessionId:session.id,id:record.id,expectedRevision:String(record.revision),statement:'Atlas now uses Ghostty.',change:{objectName:'Ghostty'}},scoped);
  assert.ok(corrected.result,JSON.stringify(corrected.error));
  assert.ok((await assertions()).some((row:any)=>/Atlas USES_TOOL Ghostty/.test(row.text)),'the corrected claim is current');
  const entities=(await client.request('memory.list',{sessionId:session.id,kind:'entities',offset:0,filter:''})).result.rows;
  const [kitty,ghostty]=['Kitty','Ghostty'].map(name=>entities.find((row:any)=>row.text===name));
  const identity=await client.action('memory.identity',{sessionId:session.id,leftId:kitty.id,rightId:ghostty.id,decision:'not_same',statement:'Kitty and Ghostty are different terminals.'},scoped);
  assert.equal(identity.result?.decision,'not_same',JSON.stringify(identity.error));
  assert.equal((await client.action('memory.freezeEpisode',{sessionId:session.id,id:randomUUID()},scoped)).error?.code!==undefined,true,'an unknown episode is refused');
});

// W08: a hosted API provider may be billed, so a phone runs it only with the providers.api grant naming
// it; the compatible endpoint is bound to the origin granted. Without it the phone gets the reason.
test('hosted API providers run from a phone only with a per-provider grant bound to the granted endpoint',async t=>{
  const f=await fixture(t);let client=await connect(t,f);
  f.core.capabilities={...f.core.capabilities,openai:{available:true,modelsStatus:'ready',models:[]},compatible:{available:true,modelsStatus:'ready',models:[]},antigravity:{available:true,modelsStatus:'ready',models:[]}} as any;
  let providers=(await client.request('sync.open',{})).result.providers;
  assert.equal(providers.openai.remoteExecution,false);assert.match(providers.openai.remoteUnavailableReason,/not granted to this phone.*billed/);
  assert.equal(providers.openai.traits.billed,true);assert.equal(providers.antigravity.remoteExecution,false);assert.match(providers.antigravity.remoteUnavailableReason,/restricted execution/);
  const projectId=f.device.projects[0].id;
  assert.equal((await client.action('sessions.create',{provider:'openai',projectId,model:'gpt-fixture',tools:false},f)).error.code,'SCOPE_DENIED');
  // The owner grants OpenAI and the compatible endpoint on the desktop; the phone reconnects with the new scope.
  await f.core.rpc('provider.credentials',{provider:'openai',key:'fixture-key'});
  await f.core.updateSettings({compatible:{baseUrl:'http://127.0.0.1:9/v1',label:'Workstation',requiresKey:false}});
  const closed=new Promise(r=>client.ws.once('close',r));
  await f.gateway.local('remote.updateDevice',{id:f.device.id,projectPaths:[f.directory],caps:[...f.device.caps,'providers.api'],categories:f.device.categories,scriptIds:[],apiProviders:['openai','compatible']});
  await closed;
  const granted=f.gateway.registry.live(f.device.id)!;assert.deepEqual(granted.apiProviders,['openai','compatible']);assert.equal(granted.compatibleEndpoint,'http://127.0.0.1:9');
  const scoped={...f,device:granted};client=await connect(t,scoped);
  providers=(await client.request('sync.open',{})).result.providers;
  assert.equal(providers.openai.remoteExecution,true);assert.equal(providers.compatible.remoteExecution,true);assert.equal(providers.compatible.traits.label,'Workstation');
  const created=(await client.action('sessions.create',{provider:'openai',projectId,model:'gpt-fixture',tools:false},scoped)).result;
  assert.equal(created.canSend,true);assert.equal(f.core.store.session(created.id).effectivePolicy,'restricted');assert.deepEqual(f.core.store.session(created.id).remote?.apiProviders,['openai','compatible']);
  const sent=await client.action('sessions.send',{sessionId:created.id,text:'Hello API',attachments:[],webSearch:false,expectedDraftRevision:created.draftRevision,expectedConfigRevision:created.configRevision},scoped);
  assert.equal(sent.result?.status,'accepted',JSON.stringify(sent.error));
  // A changed endpoint is not the one the owner granted: the phone loses it until it is granted again.
  await f.core.updateSettings({compatible:{baseUrl:'http://127.0.0.2:9/v1',label:'Elsewhere',requiresKey:false}});
  providers=(await client.request('sync.open',{})).result.providers;
  assert.equal(providers.compatible.remoteExecution,false);assert.match(providers.compatible.remoteUnavailableReason,/endpoint changed/);
  assert.equal(providers.openai.remoteExecution,true,'other grants are unaffected');
});

// W05: one winner per request, and every other answer is told the authoritative outcome.
test('approval answers retire exactly once across the phone, the desktop, withdrawal, digests, retries and reconnects',async t=>{
  const f=await fixture(t);let client=await connect(t,f);
  const session=(await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,tools:false},f)).result;
  f.core.updateSession(session.id,{effectivePolicy:'restricted'});
  const answerParams=(approval:any,choice='allow')=>({approvalId:approval.id,revision:approval.revision,digest:approval.digest,choice,answers:{}});
  const resolutions:any[]=[];
  const raise=(title:string,kind='provider')=>{void f.core.approval(session.id,{kind,title,detail:'Exact proposal',choices:kind==='question'?['answer','cancel']:['allow','deny'],...(kind==='question'?{questions:[{id:'q',question:'Proceed?'}]}:{})} as any).then(value=>resolutions.push({title,...value}));};
  const listed=async(title:string)=>(await client.request('approvals.list')).result.find((a:any)=>a.title===title);
  // The desktop answers first: the phone's answer is refused as gone, and the provider hears once.
  raise('Desktop wins');let approval=await listed('Desktop wins');
  f.core.answer({id:approval.id,choice:'deny',answers:{}});
  assert.equal((await client.action('approvals.answer',answerParams(approval),f)).error.code,'APPROVAL_GONE');
  // The provider withdraws its request: answering it afterwards is refused as gone.
  raise('Withdrawn');approval=await listed('Withdrawn');f.core.cancelApprovals(session.id);
  assert.equal((await client.action('approvals.answer',answerParams(approval),f)).error.code,'APPROVAL_GONE');
  // A digest that is not the reviewed proposal is a conflict, and the request stays answerable.
  raise('Exact digest');approval=await listed('Exact digest');
  assert.equal((await client.action('approvals.answer',{...answerParams(approval),digest:'A'.repeat(43)},f)).error.code,'REVISION_CONFLICT');
  assert.ok(f.core.approvals.has(approval.id));
  // A retried command returns its first outcome without answering twice.
  const commandId=randomUUID(),first=await client.action('approvals.answer',answerParams(approval,'deny'),f,commandId);assert.equal(first.result,true);
  const retried=await client.request('approvals.answer',answerParams(approval,'deny'),commandId);assert.equal(retried.result,true);
  // A reconnecting phone's snapshot no longer lists any retired request.
  client.ws.terminate();client=await connect(t,f);
  assert.deepEqual((await client.request('sync.open',{selectedSessionId:session.id})).result.approvals.map((a:any)=>a.title),[]);
  // With the CLI bypass on for this device, provider requests are allowed but a question is never answered for the user.
  await f.core.updateSettings({bypassCliPermissions:true});f.core.updateSession(session.id,{remote:f.gateway.router.execution(f.device,f.device.projects[0])});
  raise('Question for a person','question');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok((await listed('Question for a person')),'the question waits for an answer');
  await f.core.updateSettings({bypassCliPermissions:false});
  assert.deepEqual(resolutions.map(r=>[r.title,r.choice]),[['Desktop wins','deny'],['Withdrawn','deny'],['Exact digest','deny']],'each request resolved exactly once');
  f.core.cancelApprovals(session.id);
});

// The CI failure's order (Core closed while a gateway still has a connected phone): the phone's late
// close must not reach the closed store. Before the fence this threw "database is not open" from the
// WebSocket close callback.
test('a phone that disconnects after Core closed does not reach the closed store',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  await f.core.close();
  const closed=new Promise(r=>client.ws.once('close',r));client.ws.terminate();await closed;
  await new Promise(r=>setTimeout(r,200)); // the server side sees the close a little later
  assert.equal(f.core.closed,true);
});

test('gateway close is idempotent, refuses new frames and lets running ones finish before Core closes',async t=>{
  const f=await fixture(t),client=await connect(t,f);
  let release!:()=>void;const held=new Promise<void>(r=>release=r);
  const dispatch=f.gateway.router.dispatch.bind(f.gateway.router);
  f.gateway.router.dispatch=(async(device:any,method:string,params:any,commandId?:string)=>{if(method==='projects.list'){await held;return [];}return dispatch(device,method,params,commandId);}) as any;
  client.send({v:1,type:'request',id:randomUUID(),method:'projects.list',params:{}});
  for(let n=0;n<100&&!f.gateway.work.size;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.gateway.work.size,1,'the frame is running');
  const first=f.gateway.close(),second=f.gateway.close();
  assert.equal(first,second,'every caller awaits the same close');
  let done=false;void first.then(()=>{done=true;});
  await new Promise(r=>setTimeout(r,150));
  assert.equal(done,false,'close waits for the running frame');
  await assert.rejects(f.gateway.frame({device:f.device} as any,{}),/shutting down/,'a new frame is refused');
  release();await first;
  assert.equal(f.gateway.work.size,0);assert.equal(f.gateway.unsettled,0);
  // A frame that never finishes is counted, not awaited forever.
  const g=new MobileGateway(f.core),drain=MobileGateway.closeDrainMs;MobileGateway.closeDrainMs=100;f.own(()=>{MobileGateway.closeDrainMs=drain;});
  void g.track(new Promise(()=>{}));
  await g.close();assert.equal(g.unsettled,1);
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
  const replacementGateway=new MobileGateway(f.core);f.gateway=replacementGateway;f.own(()=>replacementGateway.close());
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
test('phones clear Unread, receive scoped completion and timer notices, and see authored error text',async t=>{
  const f=await fixture(t),projectId=f.device.projects[0].id;
  // Timers notices follow the timers category, so grant it before the phone signs in.
  f.gateway.registry.saveDevice({...f.gateway.registry.live(f.device.id)!,categories:[...f.device.categories,'timers']});
  const client=await connect(t,f);
  const s=await f.core.create({provider:'codex',cwd:f.directory,trusted:true,title:'Notice fixture'});
  f.core.updateSession(s.id,{unread:true});
  await client.request('sync.open',{});
  const read=await client.request('sessions.read',{sessionId:s.id},randomUUID());
  assert.equal(read.result.unread,false);assert.equal(f.core.store.session(s.id).unread,false);
  const outside=await mkdtemp(join(tmpdir(),'cere-notice-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  const hidden=await f.core.create({provider:'codex',cwd:outside,trusted:true,title:'Hidden'});
  f.core.emit('notice',{kind:'complete',sessionId:hidden.id,text:'Task complete'});
  f.core.emit('notice',{kind:'error',sessionId:s.id,text:'/home/secret/path failed'});
  f.core.emit('notice',{kind:'approval',sessionId:s.id,text:'Allow?'});
  f.core.emit('notice',{kind:'timer',text:'Tea',timerId:'t1',remoteProjectId:projectId});
  f.core.emit('notice',{kind:'timer',text:'Desktop only',timerId:'t2'});
  for(let n=0;n<100&&client.events.filter(e=>e.name==='notice').length<2;n++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(client.events.filter(e=>e.name==='notice').map(e=>e.data),[{kind:'error',sessionId:s.id,title:'Notice fixture'},{kind:'timer',projectId,timerId:'t1',label:'Tea'}]);
  assert.ok(!JSON.stringify(client.events).includes('secret'));
  // Authored broker errors reach the phone verbatim; parser and other errors stay generic.
  const stale=await client.request('sessions.organize',{sessionId:s.id,expectedRevision:'999',pinned:true},randomUUID());
  assert.equal(stale.error.code,'REVISION_CONFLICT');assert.equal(stale.error.message,'Session changed. Review its organization.');
  const invalid=await client.request('sessions.read',{sessionId:'not-a-session'},randomUUID());
  assert.equal(invalid.error.code,'INVALID_ARGUMENT');assert.match(invalid.error.message,/could not be completed/);
  f.core.capabilities.claude={available:false,modelsStatus:'unavailable',models:[],remoteRestricted:false};
  const snapshot=(await client.request('sync.open',{})).result;
  assert.match(snapshot.providers.claude.remoteUnavailableReason,/not available on the desktop/);
});
test('a shared pairing response file is read only for its response URI',async t=>{
  const f=await fixture(t),file=join(f.directory,'response.txt');
  await writeFile(file,'Cere pairing response\ncere-pair://v1/abc_DEF-123\ntrailing words');
  assert.deepEqual(await f.gateway.local('remote.readPairResponse',{path:file}),{response:'cere-pair://v1/abc_DEF-123'});
  await writeFile(file,'no response here');
  await assert.rejects(f.gateway.local('remote.readPairResponse',{path:file}),/does not contain a Cere pairing response/);
});
