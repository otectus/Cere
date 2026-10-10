import { createServer } from 'node:https';
import type { Server } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { TextDecoder } from 'node:util';
import { open } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { Core } from '../core.ts';
import { remoteError, busy } from '../execution.ts';
import { RemoteStore } from './store.ts';
import type { Device } from './store.ts';
import { Identity, addresses } from './identity.ts';
import { Pairing } from './pairing.ts';
import { Router, safeError } from './router.ts';
import { digest, verified } from './crypto.ts';
import { helloSchema, requestSchema, methods, mutations, needsProof, availableOperations } from './schemas.ts';
import { mobileMessage } from './transcript.ts';

type Peer = {socket:WebSocket;device?:Device;hello?:any;challenge?:any;authSessionId?:string;expiresAt:number;subscribed:boolean;selected?:string;
  challenges:Map<string,any>;inFlight:number;timer:NodeJS.Timeout;alive:boolean;pingAt:number};
export class MobileGateway {
  core:Core;registry:RemoteStore;identity:Identity;pairing:Pairing;router:Router;
  servers:Server[]=[];wsServers:WebSocketServer[]=[];peers=new Set<Peer>();closed=false;
  heartbeat:NodeJS.Timeout;stateTimer?:NodeJS.Timeout;
  lifecycle=Promise.resolve();
  bindings=new Map<string,{server:Server;ws:WebSocketServer}>();
  networkError:string|undefined;
  availableAddresses=()=>Object.values(networkInterfaces()).flat().filter(Boolean).map(info=>info!.address);

  constructor(core:Core) {
    this.core=core;this.registry=new RemoteStore(core.store);this.identity=new Identity(this.registry);this.pairing=new Pairing(this.registry,this.identity);
    this.router=new Router(core,this.registry,id=>this.revoke(id));
    this.router.scopeReduced=id=>{void this.reduced(id).catch(()=>{});};
    core.remoteAuthority=(execution,session)=> {
      const device=this.registry.live(execution.deviceId);
      return !!device&&this.registry.config().enabled&&device.scopeVersion===execution.scopeVersion&&device.projects.some(p=>p.id===execution.projectId&&p.path===session.cwd)&&this.router.inScope(device,session);
    };
    core.on('state',this.onState);core.on('message',this.onMessage);core.on('notice',this.onNotice);
    this.heartbeat=setInterval(()=>{void this.maintain();},20000);this.heartbeat.unref();this.presence();
  }
  onState=()=> {
    this.router.recheckActions();
    if(this.core.settings.paused)for(const session of this.core.store.sessions())if(session.remote){this.core.abortActions(session.id,remoteError('POLICY_PAUSED','Desktop actions are paused.'));if(session.provider!=='ollama'&&busy(session)&&!this.core.stopping.has(session.id))void this.core.stop(session.id).catch(()=>{});}
    if(this.closed||this.stateTimer)return;
    this.stateTimer=setTimeout(()=>{this.stateTimer=undefined;for(const peer of this.peers)if(peer.subscribed&&peer.device)this.event(peer,'snapshot.changed',{});},250);this.stateTimer.unref();
  };
  onMessage=(message:any)=> {
    for(const peer of this.peers)if(peer.subscribed&&peer.device) {
      try{this.router.session(peer.device,message.sessionId);this.event(peer,'message.upsert',mobileMessage(this.core.store,message.sessionId,message.id));}catch{}
    }
  };
  // Completion, failure and stop notices for in-scope sessions, plus timers this phone's projects set,
  // so the phone can raise its own alerts. Text stays generic: provider error detail remains in Activity.
  onNotice=(notice:any)=> {
    for(const peer of this.peers)if(peer.subscribed&&peer.device) {
      const device=peer.device;
      try {
        if(['complete','error','interrupted'].includes(notice?.kind)&&typeof notice.sessionId==='string') {
          const session=this.router.session(device,notice.sessionId);
          this.event(peer,'notice',{kind:notice.kind,sessionId:session.id,title:String(session.title||'').slice(0,100)});
        } else if(notice?.kind==='timer'&&typeof notice.remoteProjectId==='string') {
          const project=device.projects.find(p=>p.id===notice.remoteProjectId);
          if(!project||!device.caps.includes('desktop.control')||!device.categories.includes('timers'))continue;
          this.event(peer,'notice',{kind:'timer',projectId:project.id,timerId:String(notice.timerId||''),label:String(notice.text||'Timer').slice(0,200)});
        }
      } catch {}
    }
  };
  event(peer:Peer,name:string,data:any) {
    if(!peer.device)return;
    try{this.router.current(peer.device);}catch(error){peer.socket.close(4003,(error as any)?.code||'AUTH_REVOKED');return;}
    this.registry.journal(peer.device.id,{name,...(name==='message.upsert'?{messageId:data.id}:{} )});
    this.send(peer,{v:1,type:'event',eventId:randomUUID(),cursor:this.router.cursor(peer.device),name,resourceRevision:data.revision||'1',data});
  }
  send(peer:Peer,value:unknown) {
    if(peer.socket.readyState!==WebSocket.OPEN)return;
    const data=JSON.stringify(value);
    if(Buffer.byteLength(data)>1024*1024){peer.socket.close(4009,'LIMIT_EXCEEDED');return;}
    if(peer.socket.bufferedAmount+Buffer.byteLength(data)>8*1024*1024){peer.socket.close(4008,'SLOW_CONSUMER');return;}
    peer.socket.send(data);
  }
  presence() {
    this.core.remoteStatus={enabled:this.registry.config().enabled,listening:this.servers.length>0,listeningAddresses:[...this.bindings.keys()],waitingForNetwork:this.registry.config().enabled&&!this.servers.length,networkError:this.networkError,connected:[...new Map([...this.peers].filter(p=>p.device).map(p=>[p.device!.id,{id:p.device!.id,name:p.device!.name}])).values()],
      activeTurns:this.core.store.sessions().filter(s=>s.remote&&busy(s)).map(s=>({sessionId:s.id,deviceId:s.remote!.deviceId,project:s.cwd}))};
    if(!this.closed)this.core.changed();
  }
  async start() {this.lifecycle=this.lifecycle.catch(()=>{}).then(()=>this.refresh());return this.lifecycle;}
  async refresh() {
    if(this.closed)return;
    await this.completeReplacements();
    const config=this.registry.config();
    if(!config.enabled||!this.registry.devices().some(d=>this.registry.live(d.id))) {await this.stopListeners();this.presence();return;}
    const available=this.availableAddresses(),wanted=config.addresses.filter(address=>available.includes(address));
    for(const address of [...this.bindings.keys()])if(!wanted.includes(address))await this.stopBinding(address);
    this.networkError=undefined;
    if(!wanted.length){this.presence();return;}
    try {await this.identity.ensure(config);} catch(error) {this.networkError=(error as Error).message;this.presence();return;}
    const material=this.identity.material();
    for(const address of wanted) {
      if(this.bindings.has(address))continue;
      try {
        const https=createServer({key:material.key,cert:material.cert,minVersion:'TLSv1.2',maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000},(_req,res)=>{res.writeHead(404);res.end();});
        const ws=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:1024*1024,handleProtocols:protocols=>protocols.has('cere.mobile.v1')?'cere.mobile.v1':false});
        https.on('upgrade',(request,socket,head)=>{
          const allowed=this.registry.config().enabled&&request.url==='/mobile/v1'&&!request.headers.origin&&request.headers['sec-websocket-protocol']==='cere.mobile.v1'&&this.peers.size<10;
          if(!allowed){socket.destroy();return;}
          ws.handleUpgrade(request,socket,head,client=>this.connection(client));
        });
        this.bindings.set(address,{server:https,ws});this.servers.push(https);this.wsServers.push(ws);
        await new Promise<void>((resolve,reject)=>{https.once('error',reject);https.listen(config.port,address,()=>{https.off('error',reject);https.on('error',error=>{if(this.bindings.get(address)?.server!==https)return;this.networkError=error.message;void this.stopBinding(address,https).then(()=>this.presence());});resolve();});});
        if(this.closed||!this.registry.config().enabled)await this.stopBinding(address);
      } catch(error){await this.stopBinding(address);this.networkError=(error as Error).message;}
    }
    this.presence();
  }
  connection(socket:WebSocket) {
    const peer:Peer={socket,expiresAt:0,subscribed:false,challenges:new Map(),inFlight:0,alive:true,pingAt:Date.now(),timer:setTimeout(()=>socket.close(4001,'UNAUTHENTICATED'),10000)};
    peer.timer.unref();this.peers.add(peer);
    socket.on('error',()=>{});socket.on('pong',()=>{peer.alive=true;});
    socket.on('close',()=>{clearTimeout(peer.timer);peer.challenges.clear();this.peers.delete(peer);if(!this.closed)this.presence();});
    socket.on('message',(data,isBinary)=> {
      if(peer.device&&peer.expiresAt<Date.now()){socket.close(4001,'AUTH_EXPIRED');return;}
      const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.from(data as any);
      if(bytes.length>(peer.device?1024*1024:8192)||peer.inFlight>=8){socket.close(4009,'LIMIT_EXCEEDED');return;}
      if(isBinary) {
        if(!peer.device){socket.close(4001,'UNAUTHENTICATED');return;}
        peer.inFlight++;
        void this.core.withMutation(()=>this.router.media.chunk(peer.device!,bytes)).then(progress=>this.event(peer,'attachment.progress',progress)).catch(()=>socket.close(4009,'ATTACHMENT_INVALID')).finally(()=>peer.inFlight--);return;
      }
      let frame:any;
      try{frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{socket.close(4000,'INVALID_ARGUMENT');return;}
      peer.inFlight++;
      void this.frame(peer,frame).catch(error=>{
        if(!peer.device){if(!this.core.recovery.pending)this.registry.audit({operation:'auth.failed',decision:'denied'});socket.close(4001,'UNAUTHENTICATED');}
        else this.send(peer,{v:1,type:'response',id:frame?.id||null,error:safeError(error)});
      }).finally(()=>peer.inFlight--);
    });
  }
  async frame(peer:Peer,frame:any) {
    return this.core.withMutation(()=>this.frameInner(peer,frame));
  }
  private async frameInner(peer:Peer,frame:any) {
    if(!peer.device) {
      if(frame.type==='hello'&&!peer.hello) {
        const hello=helloSchema.parse(frame),device=this.registry.live(hello.deviceId);
        if(!device||device.replacementPending||hello.desktopId!==this.identity.id||hello.protocolMin>0||hello.protocolMax<0||[...this.peers].filter(p=>p.device?.id===device.id).length>=2)throw remoteError('UNAUTHENTICATED','Authentication failed.');
        peer.hello=hello;peer.challenge={challengeId:randomUUID(),serverNonce:randomBytes(32).toString('base64url'),epoch:this.registry.epoch,audience:this.identity.id,expiresAt:Date.now()+30000};
        this.send(peer,{v:1,type:'auth.challenge',...peer.challenge});return;
      }
      const reply=z.strictObject({v:z.literal(1),type:z.literal('auth'),challengeId:z.uuid(),signature:z.string().max(100)}).parse(frame);
      const hello=peer.hello,challenge=peer.challenge;peer.challenge=undefined;
      const device=hello?this.registry.live(hello.deviceId):undefined;
      const transcript={domain:'cere.mobile.auth.v1',helloDigest:hello?digest(hello):'',challenge,desktopId:this.identity.id,deviceId:device?.id,keyVersion:1,epoch:this.registry.epoch};
      if(!device||device.replacementPending||!challenge||challenge.expiresAt<Date.now()||reply.challengeId!==challenge.challengeId||!verified(device.connectionKey,transcript,reply.signature)||!this.registry.config().enabled||[...this.peers].filter(p=>p.device?.id===device.id).length>=2)throw remoteError('UNAUTHENTICATED','Authentication failed.');
      peer.device=device;peer.authSessionId=randomUUID();peer.expiresAt=Date.now()+15*60000;clearTimeout(peer.timer);
      device.lastSeen=Date.now();this.registry.saveDevice(device);
      this.send(peer,{v:1,type:'welcome',desktopId:this.identity.id,brokerBuild:'0.1.0/mobile-v1',authSessionId:peer.authSessionId,expiresAt:peer.expiresAt,epoch:this.registry.epoch,scopeVersion:device.scopeVersion,protocol:{major:1,minor:0},operations:availableOperations(device.caps),sendAuthentication:'connection-key',actionAuthentication:device.actionAuthentication||'biometric',limits:{maxFrameBytes:1024*1024,maxMessageLength:100000,maxAttachments:4}});
      this.registry.audit({deviceId:device.id,operation:'auth',decision:'connected'});this.presence();return;
    }
    const request=requestSchema.parse(frame),device=this.router.current(peer.device);
    if(peer.expiresAt<Date.now()){peer.socket.close(4001,'AUTH_EXPIRED');return;}
    const schema=methods[request.method];if(!schema)throw remoteError('INVALID_ARGUMENT','Unknown mobile operation.');
    const params:any=schema.parse(request.params),method=request.method,now=Date.now();
    if(method==='commands.challenge') {
      if(!mutations.has(params.method))throw remoteError('INVALID_ARGUMENT','Only a supported mutation can be authenticated.');
      for(const[id,c]of peer.challenges)if(c.expiresAt<now)peer.challenges.delete(id);
      if(peer.challenges.size>=4)throw remoteError('LIMIT_EXCEEDED','Too many pending action challenges.');
      const challenge={challengeId:randomUUID(),nonce:randomBytes(32).toString('base64url'),expiresAt:now+30000};peer.challenges.set(challenge.challengeId,{...challenge,...params});
      this.send(peer,{v:1,type:'response',id:request.id,result:challenge});return;
    }
    if(mutations.has(method)) {
      if(!request.commandId)throw remoteError('INVALID_ARGUMENT','A mutation requires a command ID.');
      const prior=this.registry.prior(device.id,request.commandId,method,request.params);
      if(prior){this.send(peer,{v:1,type:'response',id:request.id,...(prior.status==='failed'?{error:prior.error}:{result:prior.result??prior})});return;}
      if(needsProof(method,params)) {
        const proof=request.proof,challenge=proof?peer.challenges.get(proof.challengeId):undefined;
        if(proof)peer.challenges.delete(proof.challengeId);
        const transcript={domain:'cere.mobile.action.v1',desktopId:this.identity.id,deviceId:device.id,keyVersion:device.keyVersion,scopeVersion:device.scopeVersion,epoch:this.registry.epoch,authSessionId:peer.authSessionId,challengeId:challenge?.challengeId,nonce:challenge?.nonce,method,paramsDigest:digest(request.params),commandId:request.commandId};
        const signatureValid=!!proof&&(verified(device.actionKey,transcript,proof.signature)||(method==='sessions.send'&&verified(device.connectionKey,transcript,proof.signature)));
        if(!challenge||challenge.expiresAt<now||challenge.method!==method||challenge.paramsDigest!==digest(request.params)||challenge.commandId!==request.commandId||!signatureValid)throw remoteError('UNAUTHENTICATED','Review and authenticate the exact operation again.');
      }
      this.registry.accept(device.id,request.commandId,method,request.params);
      this.registry.audit({deviceId:device.id,authSessionId:peer.authSessionId,commandId:request.commandId,operation:method,argsDigest:digest(request.params),decision:'authorized',scopeVersion:device.scopeVersion,policyRevision:this.core.store.get('settingsRevision','0'),sessionId:params.sessionId,projectId:params.projectId});
    }
    try {
      const result=await this.router.dispatch(device,method,params,request.commandId);
      if(!mutations.has(method))this.router.current(device);
      if(method==='sync.open'){peer.subscribed=true;peer.selected=params.selectedSessionId;}
      if(mutations.has(method)&&method!=='sessions.send')this.registry.finish(device.id,request.commandId!,{status:'completed',result});
      if(mutations.has(method))this.registry.audit({deviceId:device.id,commandId:request.commandId,operation:method,decision:'completed'});
      if(Buffer.isBuffer(result)) {
        if(peer.socket.bufferedAmount+result.length>8*1024*1024){peer.socket.close(4008,'SLOW_CONSUMER');return;}
        peer.socket.send(result,{binary:true});this.send(peer,{v:1,type:'response',id:request.id,result:{bytes:result.length-24}});
      } else this.send(peer,{v:1,type:'response',id:request.id,result});
    } catch(error) {
      if(mutations.has(method)){this.registry.finish(device.id,request.commandId!,{status:(error as any)?.code==='OUTCOME_UNKNOWN'?'unknown':'failed',error:safeError(error)});this.registry.audit({deviceId:device.id,commandId:request.commandId,operation:method,decision:(error as any)?.code==='OUTCOME_UNKNOWN'?'unknown':'failed'});}
      throw error;
    }
  }
  async maintain() {
    if(this.closed||this.core.recovery.pending)return;
    for(const peer of this.peers) {
      if(peer.device&&(!this.registry.live(peer.device.id)||peer.expiresAt<Date.now())){peer.socket.close(4003,'AUTH_EXPIRED');continue;}
      if(!peer.alive&&Date.now()-peer.pingAt>=20000){peer.socket.terminate();continue;}
      if(peer.alive&&Date.now()-peer.pingAt>=60000){peer.alive=false;peer.pingAt=Date.now();peer.socket.ping();}
    }
    this.registry.prune();
    await this.router.media.purge();
    const config=this.registry.config();
    if(config.enabled) {
      await this.start();
      for(const device of this.registry.devices())if(!device.revokedAt&&device.expiresAt<=Date.now())await this.revoke(device.id);
      if(!this.registry.devices().some(d=>this.registry.live(d.id)))await this.stopListeners();
    }
  }
  async stopOwned(deviceId?:string) {
    const sessions=this.core.store.sessions().filter(s=>s.remote&&(!deviceId||s.remote.deviceId===deviceId));
    await Promise.allSettled(sessions.map(async s=>{await this.core.stop(s.id);this.core.generations.set(s.id,(this.core.generations.get(s.id)||0)+1);const adapter=this.core.adapters.get(s.id);this.core.adapters.delete(s.id);for(const[token,id]of this.core.tokens)if(id===s.id)this.core.tokens.delete(token);let timer:NodeJS.Timeout|undefined;await Promise.race([adapter?.close(),new Promise<void>(resolve=>{timer=setTimeout(resolve,3000);})]).finally(()=>clearTimeout(timer));if(busy(this.core.store.session(s.id)))this.core.updateSession(s.id,{status:'interrupted'});}));
  }
  async stopBinding(address:string,expected?:Server) {
    const binding=this.bindings.get(address);if(!binding||(expected&&binding.server!==expected))return;
    this.bindings.delete(address);
    this.servers=this.servers.filter(server=>server!==binding.server);this.wsServers=this.wsServers.filter(ws=>ws!==binding.ws);
    for(const socket of binding.ws.clients)socket.terminate();
    await new Promise<void>(resolve=>{binding.server.close(()=>resolve());binding.server.closeAllConnections();});
    binding.ws.close();
  }
  async stopListeners() {
    for(const peer of this.peers)peer.socket.terminate();
    await Promise.all([...this.bindings.keys()].map(address=>this.stopBinding(address)));
  }
  async disable() {
    this.registry.configure({...this.registry.config(),enabled:false});
    this.router.abortActions();
    for(const peer of this.peers)this.send(peer,{v:1,type:'event',eventId:randomUUID(),cursor:'',resourceRevision:'1',name:'remote.disabled',data:{}});
    await this.stopListeners();await this.stopOwned();this.registry.audit({operation:'remote.disable',decision:'disabled'});this.presence();
  }
  async reduced(id:string){
    for(const peer of this.peers)if(peer.device?.id===id)peer.socket.close(4003,'SCOPE_CHANGED');
    await this.stopOwned(id);await this.router.media.purge(id);this.presence();
  }
  async revoke(id:string) {
    const device=this.registry.device(id);if(!device)throw new Error('Device not found');
    device.revokedAt=Date.now();device.scopeVersion=String(BigInt(device.scopeVersion)+1n);this.registry.saveDevice(device);
    this.router.abortActions(id);
    for(const peer of this.peers)if(peer.device?.id===id){this.send(peer,{v:1,type:'event',eventId:randomUUID(),cursor:'',resourceRevision:'1',name:'device.revoked',data:{}});peer.socket.close(4003,'AUTH_REVOKED');}
    await this.stopOwned(id);await this.router.media.purge(id);this.registry.audit({deviceId:id,operation:'device.revoke',decision:'revoked'});
    if(!this.registry.devices().some(d=>this.registry.live(d.id)))await this.stopListeners();this.presence();
  }
  // The pairing transaction writes this marker together with old-key revocation.
  // Repeated startup/maintenance completes any interrupted ownership migration before
  // the new device can authenticate. Each stopped-session update is idempotent.
  async completeReplacements() {
    for(const device of this.registry.devices()) {
      if(!device.replacementPending||!device.replacesDeviceId||!this.registry.live(device.id))continue;
      this.router.abortActions(device.replacesDeviceId);
      for(const peer of this.peers)if(peer.device?.id===device.replacesDeviceId)peer.socket.close(4003,'PAIRING_REPLACED');
      await this.stopOwned(device.replacesDeviceId);
      for(const session of this.core.store.sessions())if(session.remote?.deviceId===device.replacesDeviceId) {
        const project=device.projects.find(project=>project.path===session.cwd);
        if(project)this.core.updateSession(session.id,{remote:this.router.execution(device,project)});
      }
      const current=this.registry.live(device.id);
      if(current){current.replacementPending=false;this.registry.saveDevice(current);}
    }
  }
  async local(method:string,params:any={}) {
    switch(method) {
      case 'remote.status':return {...this.core.remoteStatus as object,config:this.registry.config(),desktopId:this.identity.id,devices:this.registry.devices().map(({connectionKey,actionKey,...d})=>({...d,fingerprint:digest({connectionKey,actionKey})}))};
      case 'remote.preparePair':return this.pairing.prepare(params);
      // A phone can share its public signed response as a text file; read only the response URI from it.
      case 'remote.readPairResponse': {
        const path=z.string().min(1).max(4096).parse(params.path),file=await open(path,'r');
        let text='';try{const buffer=Buffer.alloc(16384);const {bytesRead}=await file.read(buffer,0,buffer.length,0);text=buffer.subarray(0,bytesRead).toString('utf8');}finally{await file.close();}
        const response=text.match(/cere-pair:\/\/v1\/[A-Za-z0-9_-]+/)?.[0];
        if(!response)throw new Error('This file does not contain a Cere pairing response.');
        return {response};
      }
      case 'remote.reviewPair': {const {response,sas,fingerprint,offer}=this.pairing.review(params.response);return {sas,fingerprint,name:response.name,actionAuthentication:offer.actionAuthentication||'biometric',replacesDeviceId:offer.replacesDeviceId};}
      case 'remote.confirmPair': {
        const device=this.pairing.confirm(params);
        await this.start();return {id:device.id,name:device.name};
      }
      case 'remote.configureEndpoints': {
        const p=z.strictObject({addresses:z.array(z.string()),port:z.number().int().min(1024).max(65535).default(8443),confirmed:z.literal(true)}).parse(params);
        const config={...this.registry.config(),addresses:addresses(p.addresses),port:p.port};
        await this.identity.renewCertificate(config);
        this.registry.configure(config);this.registry.store.db.exec('DELETE FROM remote_pair_offers');
        await this.stopListeners();await this.start();
        this.registry.audit({operation:'identity.endpoints',decision:'updated',argsDigest:digest(config.addresses)});
        return true;
      }
      case 'remote.enable':this.registry.configure({...this.registry.config(),enabled:true});await this.start();return true;
      case 'remote.off':await this.disable();return true;
      case 'remote.resetIdentity': {
        if(params.confirmed!==true)throw new Error('Confirm locally: reset revokes every phone and requires new offline pairing.');
        await this.disable();for(const device of this.registry.devices())if(this.registry.live(device.id))await this.revoke(device.id);
        this.identity.reset();this.registry.audit({operation:'identity.reset',decision:'reset'});this.presence();return true;
      }
      case 'remote.revoke':await this.revoke(z.uuid().parse(params.id));return true;
      case 'remote.updateDevice': {
        const device=this.pairing.updateScopes(params);this.router.abortActions(device.id);
        for(const peer of this.peers)if(peer.device?.id===device.id)peer.socket.close(4003,'SCOPE_CHANGED');
        await this.stopOwned(device.id);await this.router.media.purge(device.id);this.presence();return true;
      }
      case 'remote.renewDevice': {
        const device=this.registry.live(z.uuid().parse(params.id));if(!device||params.confirmed!==true)throw new Error('Re-pair an expired device or confirm renewal locally.');
        device.expiresAt=Date.now()+90*86400000;this.registry.saveDevice(device);this.registry.audit({deviceId:device.id,operation:'device.renew',decision:'renewed'});return true;
      }
      case 'remote.purgeMedia': {const id=z.uuid().parse(params.id);if(params.confirmed!==true)throw new Error('Confirm clearing this device’s retained images.');await this.stopOwned(id);await this.router.media.purge(id);return true;}
      default:throw new Error('Unknown remote management method');
    }
  }
  async close() {this.closed=true;this.router.abortActions();clearInterval(this.heartbeat);if(this.stateTimer)clearTimeout(this.stateTimer);this.core.off('state',this.onState);this.core.off('message',this.onMessage);this.core.off('notice',this.onNotice);await this.stopListeners();}
}
