import { readFileSync,unlinkSync } from 'node:fs';
import { resolve,join } from 'node:path';
import type { Store } from './store.ts';
import type { Session } from './types.ts';
export type ErasureMatcher = ((text:string)=>boolean)&{identifies?:(id:unknown)=>boolean};
const removedText='[Content removed by memory erasure]';
/** Called inside the transcript transaction. Derived working copies must not retain erased passages. */
export function eraseWorkingCopies(store:Store,session:Session,matches:ErasureMatcher){
  const scrub=(value:any):any=>typeof value==='string'?(matches(value)?removedText:value):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrub(v)])):value;
  const identified=(...ids:unknown[])=>!!matches.identifies&&ids.some(id=>matches.identifies!(id));
  const apiHistory=store.get<any[]>('api:'+session.id,[]);
  // Signed/encrypted provider blocks cannot be edited safely. Discard an affected
  // working history so erased text (including opaque reasoning) cannot be replayed.
  if(apiHistory.length)store.set('api:'+session.id,[]);
  let changed=false;
  if(matches(session.draft)){session.draft=removedText;changed=true;}
  if(matches(session.title)){session.title='Conversation';changed=true;}
  const removed=new Set<string>();
  for(const row of store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'attachment:%'").all()){
    const entry=JSON.parse(String(row.value));if(entry.sessionId!==session.id||entry.asset.kind!=='text')continue;
    const path=resolve(entry.asset.path);if(!path.startsWith(resolve(join(store.directory,'draft-attachments'))+'/'))continue;
    let text='';try{text=readFileSync(path,'utf8');}catch{continue;}
    if(!matches(text))continue;
    // Files cannot roll back with SQLite; removing sooner is the privacy-preserving failure mode.
    unlinkSync(path);removed.add(entry.asset.id);store.db.prepare('DELETE FROM meta WHERE key=?').run(String(row.key));
  }
  if(removed.size){session.draftAttachments=(session.draftAttachments||[]).filter(a=>!removed.has(a.id));changed=true;}
  if(changed)store.saveSession(session);
  const submission=store.get<any>('submission:'+session.id,null);if(submission)store.set('submission:'+session.id,{...scrub(submission),...(identified(submission.messageId,submission.turnId,submission.sourceEventId)?{text:removedText}:{}),attachmentIds:(submission.attachmentIds||[]).filter((id:string)=>!removed.has(id))});
  const capsuleKey='capsule:'+session.cwd,capsule=store.get<any>(capsuleKey,null);
  if(capsule){
    const sourceBound=Array.isArray(capsule.sources)&&capsule.sources.some((source:any)=>identified(source?.messageId,source?.turnId,source?.sourceEventId));
    store.set(capsuleKey,sourceBound?{...capsule,goal:removedText,decisions:[],constraints:[],questions:[],nextSteps:[],sources:capsule.sources.filter((source:any)=>!identified(source?.messageId,source?.turnId,source?.sourceEventId))}:scrub(capsule));
  }
  const runKey='workflow-run:'+session.id,run=store.get<any>(runKey,null);if(run)store.set(runKey,{...scrub(run),...(identified(run.messageId,run.turnId,run.sourceEventId)?{prompt:removedText}:{})});
  store.set('workflow:results',store.get<any[]>('workflow:results',[]).flatMap(row=>row.sessionId===session.id?(identified(row.messageId,row.turnId,row.sourceEventId)?[]:[scrub(row)]):[row]));
}
