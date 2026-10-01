import { transportMessage } from './transcript.ts';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { Core } from './core.ts';
import type { Session } from './types.ts';
import { busy, remoteError, type RemoteExecution } from './execution.ts';

type Entry = { params: any; execution?: RemoteExecution; configRevision: string; provenance?: RemoteExecution; messageId: string; text: string };

/** Accepted follow-ups are durable; provider turns still have one owner at a time. */
export class SendQueue {
  private admissions = new Map<string, Promise<unknown>>();
  private draining = new Set<string>();
  private epochs = new Map<string, number>();
  private core: Core;
  constructor(core: Core) { this.core = core; }
  entries(id: string): Entry[] { return this.core.store.get('sendQueue:'+id, []); }
  shouldQueue(session: Session) {
    return session.provider === 'ollama' && session.mode === 'managed'
      && (busy(session) || this.core.sending.has(session.id) || this.admissions.has(session.id) || this.entries(session.id).length > 0);
  }
  add(p: any, execution?: RemoteExecution, check?:()=>void, accepted?:()=>void): Promise<{queued:true;turnId:string}> {
    const id=p.id, epoch=this.epochs.get(id)||0;
    const pending=(this.admissions.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const validate=()=>{
        if(this.core.closed || this.core.recovery.pending || (this.epochs.get(id)||0)!==epoch)throw new Error('Sending was cancelled. Your draft is retained.');
        const s=this.core.store.session(id), settings=this.core.settingsFor(id);
        if(s.provider!=='ollama'||s.mode!=='managed'||s.status==='stopping'||this.core.stopping.has(id))throw remoteError('SESSION_BUSY','This conversation cannot queue a message now.');
        if(p.expectedDraftRevision!==undefined&&p.expectedDraftRevision!==(s.draftRevision||'0'))throw remoteError('REVISION_CONFLICT','Draft changed. Review before sending.');
        if(execution) {
          if((s.configRevision||'0')!==p.expectedConfigRevision)throw remoteError('REVISION_CONFLICT','Conversation settings changed.');
          if(!s.remote && busy(s))throw remoteError('SESSION_BUSY','This desktop turn must finish before mobile can take ownership. Your draft is retained.');
          if(!this.core.remoteAuthority?.(execution,s)||execution.expiresAt<=Date.now()||!execution.caps.includes('chat.write')||s.remote&&s.remote.deviceId!==execution.deviceId)throw remoteError('AUTH_REVOKED','Device access changed before queueing.');
          if(s.draftAttachments?.length)throw remoteError('REVISION_CONFLICT','Review the desktop draft attachments first.');
        }
        if(typeof p.text!=='string'||!p.text.trim()||p.text.length>100000)throw new Error('Enter a message of up to 100,000 characters');
        if(p.webSearch!==undefined&&typeof p.webSearch!=='boolean')throw new Error('Invalid web search choice');
        if(p.webSearch&&(!settings.webSearch.enabled||settings.paused||p.text.length>500||execution&&!execution.caps.includes('web')))throw new Error('Web search is unavailable for this message');
        if(this.entries(id).length>=20)throw new Error('Twenty messages are already queued. Wait for a turn or stop before sending more.');
        check?.();return s;
      };
      validate();
      const attached=await this.core.attachments.content(id,p.attachmentIds||[]);
      if(p.text.length+attached.text.length>100000)throw new Error('Message and attachments exceed 100,000 characters');
      if(p.images!==undefined&&(!Array.isArray(p.images)||!p.images.every((v:unknown)=>typeof v==='string')))throw new Error('Invalid image attachments');
      const images:string[]=[];
      for(const path of p.images||[]) { const resolved=await realpath(path);if(!(await stat(resolved)).isFile())throw new Error('Attachment is not a file');images.push(resolved); }
      if(images.length+attached.images.length>4)throw new Error('Attach at most four images');
      const session=validate(), messageId=randomUUID(), turnId=p.turnId||randomUUID();
      const text=p.text+(attached.assets.length?'\n\nAttached files: '+attached.assets.map(a=>a.name).join(', '):'')+(images.length?'\n\nAttached: '+images.join(', '):'');
      const entry:Entry={params:{id,text:p.text,attachmentIds:attached.assets.map(a=>a.id),images,webSearch:p.webSearch,turnId,queuedMessageId:messageId,expectedConfigRevision:session.configRevision||'0'},
        execution:execution?structuredClone(execution):undefined,provenance:session.remote?structuredClone(session.remote):undefined,configRevision:session.configRevision||'0',messageId,text};
      const queue=[...this.entries(id),entry];
      // Persist the queue, transcript row and draft consumption as one acceptance.
      const db=this.core.store.sessionDatabase(id);db.exec('BEGIN');
      try {
        this.core.store.set('sendQueue:'+id,queue);
        this.core.store.message({id:messageId,sessionId:id,role:'user',kind:'queued',text:'Queued for the next turn:\n\n'+text,time:Date.now(),turnId});
        this.core.store.saveSession({...session,draft:'',draftAttachments:[],view:undefined,queuedCount:queue.length,
          updated:Date.now()});
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK');throw error; }
      accepted?.();this.core.emit('message',transportMessage(this.core.store.messageById(messageId)!));this.core.changed();
      return {queued:true as const,turnId};
    });
    this.admissions.set(id,pending);
    void pending.finally(()=>{if(this.admissions.get(id)===pending)this.admissions.delete(id);this.kick(id);}).catch(()=>{});
    return pending;
  }
  recover(id:string) {
    const pending=this.core.store.get<Entry|null>('sendQueueDispatch:'+id,null);
    if(pending) {
      this.core.store.set('sendQueue:'+id,this.entries(id).filter(entry=>entry.messageId!==pending.messageId));
      this.mark(pending,'Delivery uncertain after restart; review before resending');
      this.core.store.set('sendQueueDispatch:'+id,null);
      this.core.updateSession(id,{queuedCount:this.entries(id).length});
    }
    this.cancel(id,'Cere restarted; copy this message to send it again');
    if(this.core.store.session(id).queuedCount)this.core.updateSession(id,{queuedCount:0});
  }
  cancel(id:string, reason:string) {
    this.epochs.set(id,(this.epochs.get(id)||0)+1);
    const queue=this.entries(id);if(!queue.length)return;
    this.core.store.set('sendQueue:'+id,[]);
    for(const entry of queue)this.mark(entry,'Not sent — '+reason);
    this.core.updateSession(id,{queuedCount:0});
  }
  private mark(entry:Entry, label?:string) {
    const message=this.core.store.messageById(entry.messageId);if(!message)return;
    this.core.putMessage({...message,kind:label?'queue-cancelled':'text',text:label?label+'\n\n'+entry.text:entry.text});
  }
  kick(id:string) {
    // Let the adapter's terminal callback and Core's acceptance cleanup unwind first.
    setImmediate(()=>{void this.drain(id).catch(()=>{});});
  }
  private async drain(id:string) {
    const core=this.core;
    if(core.closed||this.draining.has(id)||this.admissions.has(id)||core.sending.has(id)||core.stopping.has(id))return;
    const session=core.store.session(id),queue=this.entries(id);
    if(!queue.length||busy(session))return;
    if(session.status!=='idle'){this.cancel(id,'The previous turn did not finish; copy this message to send it again');return;}
    const [entry,...remaining]=queue,epoch=this.epochs.get(id)||0;
    const authorize=()=>{
      if(core.closed||(this.epochs.get(id)||0)!==epoch)throw new Error('Queued delivery was cancelled');
      const current=core.store.session(id);core.settingsFor(id);
      if((current.configRevision||'0')!==entry.configRevision)throw new Error('Conversation settings changed before sending');
      if(!entry.execution&&JSON.stringify(current.remote)!==JSON.stringify(entry.provenance))throw new Error('Conversation authority changed before sending');
      if(entry.execution&&(!core.remoteAuthority?.(entry.execution,current)||entry.execution.expiresAt<=Date.now()))throw new Error('Device access expired before sending');
    };
    this.draining.add(id);
    try {
      authorize();
      // Persist a separate dispatch record before removing the pending entry.
      // Recovery exposes an uncertain outcome instead of replaying it after a crash.
      core.store.set('sendQueueDispatch:'+id,entry);
      core.store.set('sendQueue:'+id,remaining);core.updateSession(id,{queuedCount:remaining.length});
      if(entry.execution)await core.sendRemote(entry.params,entry.execution,authorize,undefined,()=>{});
      else {
        core.sending.add(id);
        try { await core.sendTurn(entry.params,authorize); }
        finally { core.sending.delete(id); }
      }
      this.mark(entry);
    } catch(error) {
      this.cancel(id,'A queued message could not be delivered');
      this.mark(entry,'Delivery failed; review before resending: '+(error instanceof Error?error.message:String(error)));
      core.updateSession(id,{queuedCount:0});
    } finally { if(!core.closed)core.store.set('sendQueueDispatch:'+id,null);this.draining.delete(id); }
    this.kick(id);
  }
}
