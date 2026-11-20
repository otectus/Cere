import { readFileSync,unlinkSync,readdirSync } from 'node:fs';
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
    // A task taken from an erased message goes with it; other tasks keep their state, scrubbed.
    const tasks=Array.isArray(capsule.tasks)?scrub(capsule.tasks.filter((task:any)=>!(task?.sources||[]).some((source:any)=>identified(source?.messageId,source?.turnId,source?.sourceEventId)))):undefined;
    const open=(tasks||[]).filter((task:any)=>task.state==='accepted'||task.state==='active').map((task:any)=>task.text);
    store.set(capsuleKey,sourceBound?{...capsule,goal:removedText,decisions:[],constraints:[],questions:[],nextSteps:tasks?open:[],...(tasks?{tasks}:{}),sources:capsule.sources.filter((source:any)=>!identified(source?.messageId,source?.turnId,source?.sourceEventId))}:{...scrub(capsule),...(tasks?{tasks,nextSteps:open}:{})});
  }
  const runKey='workflow-run:'+session.id,run=store.get<any>(runKey,null);if(run)store.set(runKey,{...scrub(run),...(identified(run.messageId,run.turnId,run.sourceEventId)?{prompt:removedText}:{})});
  store.set('workflow:results',store.get<any[]>('workflow:results',[]).flatMap(row=>row.sessionId===session.id?(identified(row.messageId,row.turnId,row.sourceEventId)?[]:[scrub(row)]):[row]));
  eraseArtifactCopies(store,session,matches,scrub);
}
/**
 * Text Cere keeps as files (extractions, OCR text, analysis output) is a working copy too: a file whose
 * text matches leaves this conversation and its project, and its bytes and thumbnails go once nothing
 * else holds it. Prompts recorded with an image are scrubbed; the image itself stays.
 */
function eraseArtifactCopies(store:Store,session:Session,matches:ErasureMatcher,scrub:(value:any)=>any){
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_refs'").get())return;
  const objects=join(store.directory,'artifacts','objects'),erased=new Set<string>();
  const held=store.db.prepare("SELECT DISTINCT artifact_id AS id FROM artifact_refs WHERE owner_kind='session' AND owner_id=?").all(session.id).map(row=>String(row.id));
  for(const id of held){
    let hit=false;
    for(const row of store.db.prepare('SELECT id,sha256,data FROM artifact_versions WHERE artifact_id=?').all(id)){
      const version=JSON.parse(String(row.data));
      if(version.provenance&&matches(JSON.stringify(version.provenance))){version.provenance=scrub(version.provenance);store.db.prepare('UPDATE artifact_versions SET data=? WHERE id=?').run(JSON.stringify(version),String(row.id));}
      if(hit||!/^(text\/|application\/(json|xml))/.test(version.mime||'')||version.bytes>16*1024*1024)continue;
      try{hit=matches(readFileSync(join(objects,String(row.sha256).slice(0,2),String(row.sha256)),'utf8'));}catch{}
    }
    if(hit)erased.add(id);
  }
  for(const id of erased){
    store.db.prepare("DELETE FROM artifact_refs WHERE artifact_id=? AND ((owner_kind='session' AND owner_id=?) OR (owner_kind='project' AND owner_id=?))").run(id,session.id,session.cwd);
    if(store.db.prepare('SELECT 1 FROM artifact_refs WHERE artifact_id=?').get(id))continue;
    const hashes=store.db.prepare('SELECT DISTINCT sha256 FROM artifact_versions WHERE artifact_id=?').all(id).map(row=>String(row.sha256));
    for(const version of store.db.prepare('SELECT id FROM artifact_versions WHERE artifact_id=?').all(id))store.db.prepare('DELETE FROM artifact_derivations WHERE source_version_id=? OR derived_version_id=?').run(String(version.id),String(version.id));
    store.db.prepare('DELETE FROM artifact_versions WHERE artifact_id=?').run(id);store.db.prepare('DELETE FROM artifacts WHERE id=?').run(id);
    // Like draft attachments: removing the bytes sooner is the privacy-preserving failure mode.
    for(const hash of hashes)if(/^[0-9a-f]{64}$/.test(hash)&&!store.db.prepare('SELECT 1 FROM artifact_versions WHERE sha256=?').get(hash)){
      try{unlinkSync(join(objects,hash.slice(0,2),hash));}catch{}
      try{for(const name of readdirSync(join(store.directory,'artifacts','thumbnails')))if(name.startsWith(hash))unlinkSync(join(store.directory,'artifacts','thumbnails',name));}catch{}
    }
  }
}
