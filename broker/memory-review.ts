import { randomUUID,createHash } from 'node:crypto';
import type { Core } from './core.ts';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Proposal={id:string;sessionId:string;messageId:string;role:string;kind:'decision'|'constraint';created:number;revision:string};
export class MemoryReview {
  core:Core;constructor(core:Core){this.core=core;}
  async dispatch(method:string,p:any):Promise<any>{
    const session=this.core.store.session(p.sessionId);if(session.temporary)throw new Error('Memory review is unavailable in temporary conversations');
    const scope=await this.core.memory.scope(session),key='memory-review:'+scope;
    const proposals=this.core.store.get<Proposal[]>(key,[]);
    if(method==='memoryReview.propose'){
      const message=this.core.store.messageById(p.messageId);if(!message||message.sessionId!==session.id)throw new Error('Message no longer exists in this conversation');
      if(!['decision','constraint'].includes(p.kind))throw new Error('Choose decision or constraint');
      if(proposals.length>=200)throw new Error('Review existing proposals first');
      const proposal:Proposal={id:randomUUID(),sessionId:session.id,messageId:message.id,role:message.role,kind:p.kind,created:Date.now(),revision:hash([message.id,message.revision,message.text])};
      this.core.store.set(key,[proposal,...proposals]);return proposal;
    }
    if(method==='memoryReview.list'){
      const rows=proposals.flatMap(proposal=>{const message=this.core.store.messageById(proposal.messageId);return message?[{...proposal,text:message.text.slice(0,2000),sourceText:message.text,sourceLabel:proposal.role==='assistant'?'Model suggestion':proposal.role==='user'?'Observed user statement':'Observed tool or document statement',currentRevision:hash([message.id,message.revision,message.text])}]:[]});
      const assertions=await this.core.memory.list(session,'assertions',p.offset||0);
      const notes=await this.core.memory.list(session,'saved',p.offset||0);
      return{rows,assertions:assertions.rows.filter((r:any)=>r.status!=='accepted'),totalAssertions:assertions.total,olderNotes:notes.rows.filter((r:any)=>r.updated&&r.updated<Date.now()-90*86400000),totalNotes:notes.total,scope:session.cwd};
    }
    if(method==='memoryReview.resolve'){
      const proposal=proposals.find(row=>row.id===p.id);if(!proposal)throw new Error('Proposal no longer exists');
      const message=this.core.store.messageById(proposal.messageId);
      if(!message||p.expectedRevision!==hash([message.id,message.revision,message.text]))throw new Error('Supporting passage changed. Review again.');
      if(!['confirm','correct','local','forget'].includes(p.choice))throw new Error('Choose a review action');
      if(p.choice==='forget'){this.core.store.set(key,proposals.filter(row=>row.id!==p.id));return{removed:true,notice:'Proposal removed. The conversation remains; use memory forgetting to erase stored evidence.'};}
      if(typeof p.text!=='string'||!p.text.trim()||p.text.length>2000)throw new Error('Review 1–2,000 characters before confirming');
      // A user's confirmation creates a user-authored note; it never upgrades a model assertion silently.
      const result=p.choice==='local'?await this.core.memory.service.call('observe_text',{scope_id:scope,text:p.text,role:'user',session_id:session.id,source_event_id:'review:'+proposal.id,kind:'saved',sensitivity:'local_only'}):await this.core.memory.save(session,p.text);
      this.core.store.set(key,proposals.filter(row=>row.id!==p.id));
      let capsuleNotice='';
      if(p.choice!=='local'){try{const capsule:any=await this.core.workflows.dispatch('capsules.get',{sessionId:session.id});await this.core.workflows.dispatch('capsules.save',{...capsule,sessionId:session.id,expectedRevision:capsule.revision,[proposal.kind==='decision'?'decisions':'constraints']:[...capsule[proposal.kind==='decision'?'decisions':'constraints'],p.text],sources:[...capsule.sources,{sessionId:proposal.sessionId,messageId:proposal.messageId,sourceRole:'user-confirmed'}]});capsuleNotice=' Added to the reviewed project capsule.';}catch{capsuleNotice=' Memory saved; the capsule changed and needs a separate review.';}}
      await this.core.memory.refreshAfterCommit();return{...result,sourceLabel:'User-confirmed fact',notice:p.choice==='local'?'Confirmed for local model recall only.':'Confirmed as a project memory note.'+capsuleNotice};
    }
    if(method==='memoryReview.recalled'){
      const record=this.core.store.get<any>('recalled:'+session.id,{ids:[],time:0}),rows=[];
      for(const id of record.ids.slice(0,12)){try{const evidence=await this.core.memory.graph(session,'inspect',{id});rows.push({id,evidence});}catch{/* Erased and unavailable evidence must not be resurrected from cached text. */}}
      return{time:record.time,rows,reason:'These records were selected by project scope, retrieval relevance, policy and the token budget for the most recent prepared turn. Selection does not prove the provider used each record.'};
    }
    throw new Error('Unknown memory review operation');
  }
}
