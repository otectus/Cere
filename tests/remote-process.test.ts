import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { WebSocket } from 'ws';
import { Store } from '../broker/store.ts';
import { request } from '../broker/client.ts';
import { canonical, digest, parsePairing, pairingUri } from '../broker/remote/crypto.ts';

const key=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const publicKey=(pair:ReturnType<typeof key>)=>pair.publicKey.export({type:'spki',format:'der'}).toString('base64url');
const signature=(pair:ReturnType<typeof key>,value:unknown)=>sign('sha256',Buffer.from(canonical(value)),pair.privateKey).toString('base64url');
async function until(check:()=>Promise<boolean>,timeout=10000){const end=Date.now()+timeout;while(!await check()){if(Date.now()>end)throw new Error('Timed out waiting for isolated broker');await new Promise(r=>setTimeout(r,25));}}
async function freePort(){const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return port;}

test('real broker process: peer credentials, offline pair, provider approval reconnect, crash ledger, revoke and listener shutdown', {timeout:45000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-mobile-process-')),state=join(directory,'state'),runtime=join(directory,'runtime'),project=join(directory,'project');
  await mkdir(project);const marker=join(project,'effect-started');
  const oldState=process.env.CERE_STATE_DIR,oldRuntime=process.env.CERE_RUNTIME_DIR;
  process.env.CERE_STATE_DIR=state;process.env.CERE_RUNTIME_DIR=runtime;
  const script={id:'crash-fixture',name:'Crash boundary fixture',executable:'/bin/sh',args:['-c','printf accepted > "$1"; sleep 30','fixture',marker],cwd:project,timeout:35000};
  const store=new Store(state);store.set('settings',{profile:'scoped',categories:['scripts'],scripts:[script],memory:{enabled:false}});store.close();
  const env={...process.env,CERE_CODEX_BIN:resolve('tests/fixtures/ui-codex.mjs'),CERE_CLAUDE_BIN:join(directory,'absent-claude'),CERE_OLLAMA_HOST:'http://127.0.0.1:9'};
  let broker:ChildProcess|undefined,log='',socket:WebSocket|undefined;
  async function start(){broker=spawn(process.execPath,['broker/main.ts'],{cwd:resolve('.'),env,detached:true,stdio:['ignore','pipe','pipe']});broker.stdout!.on('data',b=>log+=String(b));broker.stderr!.on('data',b=>log+=String(b));await until(async()=>{try{return !!await request('remote.status',{},500);}catch{return false;}});}
  async function stop(signal:NodeJS.Signals='SIGTERM') {if(!broker||broker.exitCode!==null||broker.signalCode)return;const ended=new Promise<void>(r=>broker!.once('exit',()=>r()));process.kill(-broker.pid!,signal);await ended;}
  t.after(async()=>{socket?.terminate();await stop('SIGKILL');await writeFile('/tmp/cere-mobile-process.log',log);if(oldState===undefined)delete process.env.CERE_STATE_DIR;else process.env.CERE_STATE_DIR=oldState;if(oldRuntime===undefined)delete process.env.CERE_RUNTIME_DIR;else process.env.CERE_RUNTIME_DIR=oldRuntime;await rm(directory,{recursive:true,force:true});});
  await start();assert.equal((await request('remote.status')).listening,false);
  const port=await freePort(),offer=parsePairing((await request('remote.preparePair',{addresses:['127.0.0.1'],port,name:'Process fixture'})).uri);
  assert.equal((await request('remote.status')).listening,false);
  const connection=key(),action=key(),deviceId=randomUUID();
  const body={type:'response',v:1,desktopId:offer.desktopId,pairingId:offer.pairingId,offerDigest:digest(offer),nonce:offer.nonce,deviceId,name:'Process phone',keyVersion:1,connectionKey:publicKey(connection),actionKey:publicKey(action),deviceNonce:randomBytes(32).toString('base64url')};
  const transcript={domain:'cere.mobile.pair.response.v1',response:body};
  const response=pairingUri({...body,connectionProof:signature(connection,transcript),actionProof:signature(action,transcript)}),review=await request('remote.reviewPair',{response});
  await request('remote.confirmPair',{response,sas:review.sas,confirmed:true,projectPaths:[project],caps:['chat.read','chat.write','providers.execute','approvals.answer','approvals.provider','desktop.control'],categories:['scripts'],scriptIds:[script.id]});
  const certificate=await readFile(join(state,'remote-identity','tls.crt'));
  let welcome:any,queue:any[]=[],waiting:((v:any)=>void)[]=[];
  const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Wire response timeout')),5000);waiting.push(v=>{clearTimeout(timer);resolve(v);});});
  const send=(value:any)=>socket!.send(JSON.stringify(value));
  async function rpc(method:string,params:any={},commandId?:string,proof?:any){send({v:1,type:'request',id:randomUUID(),method,params,...(commandId?{commandId}:{}),...(proof?{proof}:{})});return next();}
  async function proofFor(method:string,params:any,commandId:string){const challenge=(await rpc('commands.challenge',{method,paramsDigest:digest(params),commandId})).result;return {challengeId:challenge.challengeId,signature:signature(action,{domain:'cere.mobile.action.v1',desktopId:offer.desktopId,deviceId,keyVersion:1,scopeVersion:welcome.scopeVersion,epoch:welcome.epoch,authSessionId:welcome.authSessionId,challengeId:challenge.challengeId,nonce:challenge.nonce,method,paramsDigest:digest(params),commandId})};}
  async function signedRpc(method:string,params:any,commandId=randomUUID()){return rpc(method,params,commandId,await proofFor(method,params,commandId));}
  async function connect(){queue=[];waiting=[];socket=new WebSocket(offer.endpoints[0],'cere.mobile.v1',{ca:certificate});socket.on('message',b=>{const m=JSON.parse(String(b));if(m.type==='event')return;const waiter=waiting.shift();if(waiter)waiter(m);else queue.push(m);});await new Promise<void>((r,j)=>{socket!.once('open',r);socket!.once('error',j);});const hello={v:1,type:'hello',protocolMin:0,protocolMax:0,desktopId:offer.desktopId,deviceId,keyVersion:1,clientNonce:randomBytes(32).toString('base64url'),appVersion:'process-test'};send(hello);const {v,type,...challenge}=await next();send({v:1,type:'auth',challengeId:challenge.challengeId,signature:signature(connection,{domain:'cere.mobile.auth.v1',helloDigest:digest(hello),challenge,desktopId:offer.desktopId,deviceId,keyVersion:1,epoch:challenge.epoch})});welcome=await next();assert.equal(welcome.type,'welcome');}
  await connect();const snapshot=(await rpc('sync.open')).result,projectId=snapshot.projects[0].id;
  const session=(await signedRpc('sessions.create',{provider:'codex',projectId})).result;assert.ok(session?.id);
  const sent=await signedRpc('sessions.send',{sessionId:session.id,text:'Unicode 🦊 漢字\n| a | b |\n|---|---|\n|1|2|',expectedDraftRevision:session.draftRevision,expectedConfigRevision:session.configRevision});assert.equal(sent.result.status,'accepted');
  socket!.terminate();await until(async()=>!!(await request('subscribe')).approvals.length);
  const pending=(await request('subscribe')).approvals[0];await request('approval.answer',{id:pending.id,choice:'deny'});
  await until(async()=>!(await request('subscribe')).sessions.some((s:any)=>s.id===session.id&&['working','waiting','starting'].includes(s.status)));
  await connect();const resumed=(await rpc('sync.open',{selectedSessionId:session.id})).result;assert.equal(resumed.approvals.length,0);assert.ok(resumed.messages.some((m:any)=>m.text.includes('Decision: decline')));
  const commandId=randomUUID(),params={projectId,action:'script.run',args:{id:script.id},definitionDigest:digest(script)},proof=await proofFor('desktop.execute',params,commandId);
  send({v:1,type:'request',id:randomUUID(),method:'desktop.execute',params,commandId,proof});
  await until(async()=>{try{await access(marker);return true;}catch{return false;}});socket!.terminate();await stop('SIGKILL');
  await start();await connect();assert.equal((await rpc('commands.status',{commandId})).result.status,'unknown');
  assert.equal((await rpc('desktop.execute',params,commandId)).result.status,'unknown');assert.equal(await readFile(marker,'utf8'),'accepted');
  await request('remote.revoke',{id:deviceId});assert.equal((await request('remote.status')).listening,false);await request('remote.off');assert.equal((await request('remote.status')).enabled,false);
  log+='\nPASS: same-user IPC, offline pairing, real fixture provider, reconnect, process crash unknown ledger, revoke, no listener.\n';
});
