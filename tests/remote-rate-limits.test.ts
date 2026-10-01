import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';
import { canonical, digest, parsePairing, pairingUri } from '../broker/remote/crypto.ts';
import type { Hooks } from '../broker/providers.ts';

const keypair=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const pub=(pair:ReturnType<typeof keypair>)=>pair.publicKey.export({type:'spki',format:'der'}).toString('base64url');
const proof=(pair:ReturnType<typeof keypair>,value:unknown)=>sign('sha256',Buffer.from(canonical(value)),pair.privateKey).toString('base64url');

async function port() {
  const server=net.createServer();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const value=(server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  return value;
}

async function fixture(t:test.TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'cere-remote-unlimited-'));
  const core=new Core(new Store(directory),(_session,h:Hooks)=>({async send(_text,_images,options){h.policy?.(true);options?.beforeAccept?.();options?.onDispatched?.();options?.onAccepted?.();},async interrupt(){h.event({type:'interrupted'});},async close(){}}));
  const gateway=new MobileGateway(core);
  t.after(async()=>{await gateway.close();await core.close();await rm(directory,{recursive:true,force:true});});
  const pairing:any=await gateway.local('remote.preparePair',{addresses:['127.0.0.1'],name:'Rate limit test',port:await port()});
  const offer=parsePairing(pairing.uri),connection=keypair(),action=keypair(),deviceId=randomUUID();
  const body={type:'response',v:1,desktopId:offer.desktopId,pairingId:offer.pairingId,offerDigest:digest(offer),nonce:offer.nonce,deviceId,name:'Fixture phone',keyVersion:1,connectionKey:pub(connection),actionKey:pub(action),deviceNonce:randomBytes(32).toString('base64url')};
  const transcript={domain:'cere.mobile.pair.response.v1',response:body};
  const response=pairingUri({...body,connectionProof:proof(connection,transcript),actionProof:proof(action,transcript)});
  const review:any=await gateway.local('remote.reviewPair',{response});
  await gateway.local('remote.confirmPair',{response,sas:review.sas,confirmed:true,projectPaths:[directory],caps:['chat.read','chat.write','providers.execute','memory.read','memory.write'],categories:[],scriptIds:[]});
  return {directory,core,gateway,offer,connection,action,device:gateway.registry.live(deviceId)!};
}

class Client {
  ws:WebSocket;queue:any[]=[];waiters:Array<(value:any)=>void>=[];welcome:any;
  constructor(ws:WebSocket) {this.ws=ws;ws.on('message',bytes=>{const value=JSON.parse(String(bytes)),waiter=this.waiters.shift();if(waiter)waiter(value);else this.queue.push(value);});}
  next():Promise<any> {if(this.queue.length)return Promise.resolve(this.queue.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out waiting for remote response')),3000);this.waiters.push(value=>{clearTimeout(timer);resolve(value);});});}
  send(value:any) {this.ws.send(JSON.stringify(value));}
  async request(method:string,params:any={},commandId?:string,actionProof?:any) {this.send({v:1,type:'request',id:randomUUID(),method,params,...(commandId?{commandId}:{}),...(actionProof?{proof:actionProof}:{})});return this.next();}
  async action(method:string,params:any,f:Awaited<ReturnType<typeof fixture>>) {
    const commandId=randomUUID(),challenge=(await this.request('commands.challenge',{method,paramsDigest:digest(params),commandId})).result;
    assert.ok(challenge?.challengeId);
    const transcript={domain:'cere.mobile.action.v1',desktopId:f.offer.desktopId,deviceId:f.device.id,keyVersion:1,scopeVersion:f.device.scopeVersion,epoch:this.welcome.epoch,authSessionId:this.welcome.authSessionId,challengeId:challenge.challengeId,nonce:challenge.nonce,method,paramsDigest:digest(params),commandId};
    return this.request(method,params,commandId,{challengeId:challenge.challengeId,signature:proof(f.action,transcript)});
  }
  async close() {if(this.ws.readyState===WebSocket.CLOSED)return;const closed=new Promise<void>(resolve=>this.ws.once('close',()=>resolve()));this.ws.close();await closed;}
}

async function connect(f:Awaited<ReturnType<typeof fixture>>) {
  const ws=new WebSocket(f.offer.endpoints[0],'cere.mobile.v1',{ca:f.gateway.identity.material().cert});
  const client=new Client(ws);
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const hello={v:1,type:'hello',protocolMin:0,protocolMax:0,desktopId:f.offer.desktopId,deviceId:f.device.id,keyVersion:1,clientNonce:randomBytes(32).toString('base64url'),appVersion:'test'};
  client.send(hello);const {v,type,...challenge}=await client.next();
  const transcript={domain:'cere.mobile.auth.v1',helloDigest:digest(hello),challenge,desktopId:f.offer.desktopId,deviceId:f.device.id,keyVersion:1,epoch:challenge.epoch};
  client.send({v:1,type:'auth',challengeId:challenge.challengeId,signature:proof(f.connection,transcript)});
  client.welcome=await client.next();assert.equal(client.welcome.type,'welcome');return client;
}

test('authenticated reads and reviewed actions have no time-based broker budget',async t=>{
  const f=await fixture(t),client=await connect(f);t.after(()=>client.close());
  for(let n=0;n<50;n++)assert.ok((await client.request('sessions.list',{offset:0})).result,`read ${n+1}`);
  for(let n=0;n<12;n++) {
    const created=await client.action('sessions.create',{provider:'codex',projectId:f.device.projects[0].id,title:`Created ${n+1}`,tools:false},f);
    assert.equal(created.result?.title,`Created ${n+1}`,`action ${n+1}`);
  }
});

test('rapid authenticated reconnects are accepted without an address time window',async t=>{
  const f=await fixture(t);
  for(let n=0;n<7;n++) {
    const client=await connect(f);assert.equal(client.welcome.type,'welcome',`connection ${n+1}`);await client.close();
    while(f.gateway.peers.size)await new Promise(resolve=>setImmediate(resolve));
  }
});

test('history and memory operations can repeat after completion without cooldowns',async t=>{
  const f=await fixture(t),project=f.device.projects[0];
  let historyCalls=0;(f.core as any).history=async()=>{historyCalls++;return [];};
  await f.gateway.router.dispatch(f.device,'sessions.history',{projectId:project.id});
  await f.gateway.router.dispatch(f.device,'sessions.history',{projectId:project.id});
  assert.equal(historyCalls,2);

  f.core.settings.memory.enabled=true;
  f.core.capabilities.ollama={modelsStatus:'ready',models:[{id:'fixture',displayName:'Fixture',description:'',efforts:[],defaultEffort:'',isDefault:true}]};
  const session=await f.core.create({provider:'ollama',cwd:f.directory,trusted:true,model:'fixture',ollamaHost:f.core.settings.ollama.host},undefined,{remote:f.gateway.router.execution(f.device,project),effectivePolicy:'restricted'});
  let memoryCalls=0;(f.core.memory as any).mobileGraph=async()=>{memoryCalls++;return {id:randomUUID()};};
  await f.gateway.router.dispatch(f.device,'memory.inspect',{sessionId:session.id,id:randomUUID()});
  await f.gateway.router.dispatch(f.device,'memory.inspect',{sessionId:session.id,id:randomUUID()});
  assert.equal(memoryCalls,2);
});
