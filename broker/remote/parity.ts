import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { Router } from './router.ts';
import type { Device } from './store.ts';
import { mobileMessage } from './transcript.ts';
import { digest } from './crypto.ts';
import { remoteError } from '../execution.ts';

/** Named, scoped parity operations; no generic Core RPC or graph method forwarding. */
export class Parity {
  router:Router;
  history=new Map<string,{deviceId:string;projectId:string;provider:'codex'|'claude';nativeId:string;title:string;expiresAt:number}>();
  constructor(router:Router){this.router=router;}
  handoff(device:Device,id:string) {
    const r=this.router,session=r.session(device,id);
    const rows=r.core.store.db.prepare("SELECT id FROM messages WHERE session_id=? AND json_extract(data,'$.role')!='tool' AND COALESCE(json_extract(data,'$.kind'),'')!='tool' ORDER BY rowid DESC LIMIT 8").all(id);
    const messages=rows.reverse().map(row=>mobileMessage(r.core.store,id,String(row.id)));
    const content=messages.map(m=>`${m.role}: ${m.text}${m.contentTruncated?'\n[Source message shortened; review the complete transcript on desktop.]':''}`).join('\n\n');
    const draft=('Continue this conversation:\n\n'+content).slice(0,99000);
    return {sourceSessionId:id,sourceDigest:digest({id,revision:session.configRevision,messages:messages.map(m=>[m.id,m.revision])}),draft,shortened:content.length>98900||messages.some(m=>m.contentTruncated)};
  }
  async dispatch(device:Device,method:string,p:any) {
    const r=this.router;
    if(method==='sessions.handoffPreview')return this.handoff(device,p.sessionId);
    if(method==='sessions.handoffCreate') {
      r.require(device,'chat.write');
      if(this.handoff(device,p.sourceSessionId).sourceDigest!==p.sourceDigest)throw remoteError('REVISION_CONFLICT','The source conversation changed. Review the handoff again.');
      return r.dispatch(device,'sessions.create',{...p,handoffDraft:p.draft});
    }
    if(method==='sessions.history') {
      r.require(device,'providers.execute');r.require(device,'chat.read');const project=r.project(device,p.projectId),provider:'codex'|'claude'=p.provider;
      // A Claude conversation continues from a phone only in Claude's restricted mode, as a new one does.
      if(provider==='claude'&&r.core.capabilities.claude?.remoteRestricted!==true)throw remoteError('PROVIDER_POLICY_UNSAFE','This Claude Code version cannot enforce Cere restricted mode. Update Claude Code on the desktop.');
      const controller=new AbortController(),executionId=randomUUID(),check=()=>{r.current(device);controller.signal.throwIfAborted();if(r.core.settings.paused)throw remoteError('POLICY_PAUSED','Native provider access is paused.');};check();
      if([...r.actions.values()].some(a=>a.deviceId===device.id))throw remoteError('SESSION_BUSY','Wait for this device’s active desktop operation.');
      r.actions.set(executionId,{deviceId:device.id,controller,check});
      try {
      const rows=await r.core.history(provider,controller.signal);check();
      for(const [id,value]of this.history)if(value.expiresAt<Date.now()||value.deviceId===device.id)this.history.delete(id);
      const items=[];
      for(const row of rows.slice(0,100))if(await realpath(row.cwd).catch(()=>null)===project.path) {
        check();if(r.core.store.sessions().some(s=>s.provider===provider&&s.nativeId===row.nativeId))continue;
        const id=randomUUID(),title=String(row.title).slice(0,100);this.history.set(id,{deviceId:device.id,projectId:p.projectId,provider,nativeId:row.nativeId,title,expiresAt:Date.now()+300000});items.push({id,title,provider,projectId:p.projectId});
      }
      check();return {items,provider,transcriptImported:false};
      } finally {r.actions.delete(executionId);}
    }
    if(method==='sessions.import') {
      r.require(device,'providers.execute');r.require(device,'chat.write');const ticket=this.history.get(p.historyId);
      if(!ticket||ticket.deviceId!==device.id||ticket.expiresAt<Date.now())throw remoteError('REVISION_CONFLICT','Refresh the desktop history before importing.');
      const project=r.project(device,ticket.projectId);
      const check=()=>{r.current(device);if(r.core.settings.paused)throw remoteError('POLICY_PAUSED','Native provider access is paused.');if(ticket.provider==='claude'&&r.core.capabilities.claude?.remoteRestricted!==true)throw remoteError('PROVIDER_POLICY_UNSAFE','This Claude Code version cannot enforce Cere restricted mode. Update Claude Code on the desktop.');};check();
      this.history.delete(p.historyId); // Single-use ownership claim before the first asynchronous boundary.
      const session=await r.core.create({provider:ticket.provider,nativeId:ticket.nativeId,cwd:project.path,title:ticket.title,trusted:true,handoffConfirmed:p.externalWriterStopped},check,{remote:r.execution(device,project),effectivePolicy:ticket.provider==='claude'?'restricted':'unknown'});
      return r.sessionDto(device,session);
    }
    if(['memory.inspect','memory.forgetPreview','memory.forget','memory.clear','memory.erasureStatus','memory.timeline','memory.correct','memory.resolveConflict','memory.identity','memory.freezeEpisode'].includes(method)) {
      const write=['memory.forget','memory.clear','memory.forgetPreview','memory.correct','memory.resolveConflict','memory.identity','memory.freezeEpisode'].includes(method);r.require(device,write?'memory.write':'memory.read');const session=r.memorySession(device,p.sessionId);
      const controller=new AbortController(),executionId=randomUUID(),check=()=>{r.current(device);controller.signal.throwIfAborted();if(!r.core.settings.memory.enabled||r.core.settings.paused)throw remoteError('POLICY_PAUSED','Memory is disabled or paused.');};check();
      if([...r.actions.values()].some(a=>a.deviceId===device.id))throw remoteError('SESSION_BUSY','Wait for this device’s active desktop operation.');
      r.actions.set(executionId,{deviceId:device.id,controller,check});
      try {
        if(method==='memory.erasureStatus') {
          const owned=r.core.store.get<any>('mobileErasure:'+device.id+':'+p.jobId,null);
          if(!owned||owned.sessionId!==session.id)throw remoteError('SCOPE_DENIED','Erasure job is not available in this scope.');
          const result=await r.core.memory.graph(session,'erasure_status',{job_id:p.jobId},controller.signal,check);check();return {id:p.jobId,state:result.state,purgeComplete:result.purge_complete===true};
        }
        if(method==='memory.timeline') {
          const result=await r.core.memory.userGraph(session,'timeline',{id:p.id},controller.signal,check);check();
          if(Buffer.byteLength(JSON.stringify(result))>256*1024)throw remoteError('LIMIT_EXCEEDED','This history is too long for the phone. Review it on the desktop.');return result;
        }
        if(method==='memory.correct')return await r.core.memory.userGraph(session,'correct',{id:p.id,expected_revision:Number(p.expectedRevision),statement:p.statement,
          change:{...(p.change.objectName!==undefined?{object:{name:p.change.objectName}}:{}),...(p.change.value!==undefined?{value:p.change.value}:{}),...(p.change.polarity?{polarity:p.change.polarity}:{}),
            ...(p.change.validMode?{valid_mode:p.change.validMode}:{}),...(p.change.validFromUs!==undefined?{valid_from_us:p.change.validFromUs}:{}),...(p.change.validToUs!==undefined?{valid_to_us:p.change.validToUs}:{})}},controller.signal,check);
        if(method==='memory.resolveConflict')return await r.core.memory.userGraph(session,'resolve_conflict',{id:p.id,expected_revision:Number(p.expectedRevision),statement:p.statement},controller.signal,check);
        if(method==='memory.identity')return await r.core.memory.userGraph(session,'identity',{left_id:p.leftId,right_id:p.rightId,decision:p.decision,statement:p.statement},controller.signal,check);
        if(method==='memory.freezeEpisode')return await r.core.memory.userGraph(session,'freeze_episode',{id:p.id},controller.signal,check);
        if(method==='memory.inspect'||method==='memory.forgetPreview') {
          const result=await r.core.memory.mobileGraph(session,method==='memory.inspect'?'inspect':'forget_preview',p.id?{id:p.id}:{},controller.signal,check);check();
          if(method==='memory.forgetPreview')return {count:result.count,selection:result.selection,revision:String(result.revision),sourcePolicy:result.source_policy};
          if(Buffer.byteLength(JSON.stringify(result))>512*1024)throw remoteError('LIMIT_EXCEEDED','Inspect this large memory record on the desktop.');return result;
        }
        if(method==='memory.clear'&&p.confirmProjectId!==r.sessionDto(device,session).projectId)throw remoteError('INVALID_ARGUMENT','Confirm the selected memory project.');
        const result=await r.core.memory.erase(session,{...(p.id?{id:p.id}:{}),selection:p.selection,expected_revision:Number(p.expectedRevision)},controller.signal,check,true);
        const jobId=result.job_id||result.id;if(jobId)r.core.store.set('mobileErasure:'+device.id+':'+jobId,{sessionId:session.id});
        return result;
      } finally {r.actions.delete(executionId);}
    }
    throw remoteError('INVALID_ARGUMENT','Unknown mobile operation.');
  }
}
