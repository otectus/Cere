import { providerIds } from './provider-catalog.ts';
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,readFileSync,writeFileSync,renameSync,unlinkSync,lstatSync,chmodSync,rmSync,constants } from 'node:fs';
import { readFile,writeFile,mkdir,copyFile,stat,rm,readdir,lstat } from 'node:fs/promises';
import { join,dirname,basename,resolve } from 'node:path';
import { Store } from './store.ts';
import { privateDir } from './paths.ts';
import { RemoteStore } from './remote/store.ts';
import type { Settings } from './types.ts';
import type { Core } from './core.ts';
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const registry=(directory:string)=>readFileSync(join(directory,'graph-memory','erasure-registry.jsonl'));
const journalPath=(directory:string)=>join(dirname(directory),'.'+basename(directory)+'-recovery.json');
const privateFile=(path:string)=>{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw new Error('Recovery file must be owned by you and private');};
/** This machine's configuration, secrets and phone pairings; a backup never supplies them. */
const machineMeta=['indextts.voices','workflow:recipe-definitions','behaviorPresets','desktopProfilePrevious','memory-pending-erasure','graph-memory-migrated',
  'remoteConfig','remoteDesktopId','remoteSchema','remoteLineage','remoteCursorKey','chatConnectionsMigrated'];
const machineTables=[['remote_devices','id,data'],['remote_commands','device,id,digest,method,data,time'],['remote_audit','seq,time,data'],
  // What this computer has spent with paid image backends; a restore must not reset a daily limit.
  ['usage_records','id,session_id,operation_id,time,data'],
  // Saved chat connections are this computer's configuration, like its settings and keys.
  ['provider_connections','id,kind,revision,data']] as const;
/**
 * Artifacts travel with the conversations that own them (and their project shares). Workspace folder
 * access, change sets, durable runs and budget reservations are machine authority and never restored.
 */
const artifactTables={artifacts:'id,session_id,project,updated,data',artifact_versions:'id,artifact_id,sha256,created,data',artifact_refs:'id,artifact_id,version_id,owner_kind,owner_id,created,data',artifact_derivations:'id,source_version_id,derived_version_id,kind,created,data'} as const;
type ArtifactTable=keyof typeof artifactTables;
const uuidPattern=/^[0-9a-f-]{36}$/,hashPattern=/^[0-9a-f]{64}$/;
async function backupArtifacts(store:Store,directory:string,sessionIds:Set<string>,withBytes:boolean){
  const all=(table:ArtifactTable)=>store.db.prepare(`SELECT ${artifactTables[table]} FROM ${table}`).all() as any[];
  const refs=all('artifact_refs').filter(r=>r.owner_kind==='session'?sessionIds.has(String(r.owner_id)):r.owner_kind==='project');
  const ids=new Set(refs.map(r=>String(r.artifact_id)));
  const versions=all('artifact_versions').filter(r=>ids.has(String(r.artifact_id))),versionIds=new Set(versions.map(r=>String(r.id)));
  const rows={artifacts:all('artifacts').filter(r=>ids.has(String(r.id))),artifact_versions:versions,artifact_refs:refs,
    artifact_derivations:all('artifact_derivations').filter(r=>versionIds.has(String(r.source_version_id))&&(r.derived_version_id===null||versionIds.has(String(r.derived_version_id))))};
  const objects:string[]=[];let missing=0;
  if(withBytes){
    privateDir(join(directory,'artifacts'));
    for(const hash of new Set(versions.map(r=>String(r.sha256)))){
      // Absent or altered bytes are recorded as missing; the restore review reports them.
      const bytes=hashPattern.test(hash)?await readFile(join(store.directory,'artifacts','objects',hash.slice(0,2),hash)).catch(()=>null):null;
      if(!bytes||digest(bytes)!==hash){missing++;continue;}
      await writeFile(join(directory,'artifacts',hash),bytes,{mode:0o600,flag:'wx'});objects.push(hash);
    }
  }
  return{withBytes,rows,objects,missingAtBackup:missing};
}
/** The backed-up objects whose bytes still match their names; anything else counts as missing. */
async function verifiedArtifactObjects(directory:string,backup:any){
  const verified=new Set<string>();
  if(!backup)return verified;
  if(typeof backup!=='object'||!backup.rows||typeof backup.rows!=='object'||!Array.isArray(backup.objects)||backup.objects.length>1000000||!(Object.keys(artifactTables) as ArtifactTable[]).every(t=>Array.isArray(backup.rows[t])&&backup.rows[t].length<=1000000))throw new Error('Invalid artifact backup');
  for(const hash of backup.objects){
    if(typeof hash!=='string'||!hashPattern.test(hash))throw new Error('Invalid artifact backup');
    const path=join(directory,'artifacts',hash);try{privateFile(path);}catch{continue;}
    if(digest(await readFile(path))===hash)verified.add(hash);
  }
  return verified;
}
function artifactSummary(backup:any,verified:Set<string>){
  const versions:any[]=backup?.rows?.artifact_versions||[];
  return{artifacts:(backup?.rows?.artifacts||[]).length,versions:versions.length,missingBytes:versions.filter(v=>!verified.has(String(v.sha256))).length,bytesIncluded:backup?.withBytes===true};
}
/** Validates every row before inserting it, then installs only bytes whose hash still matches. */
async function restoreArtifacts(target:Store,stage:string,directory:string,backup:any,sessionIds:Set<string>,verified:Set<string>){
  if(!backup)return;
  const json=(value:unknown)=>{if(typeof value!=='string'||value.length>4*1024*1024)throw new Error('Invalid artifact backup');const parsed=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid artifact backup');return parsed;};
  const rows=backup.rows,ids=new Set<string>(),versionIds=new Set<string>();
  for(const r of rows.artifacts){if(typeof r.id!=='string'||!uuidPattern.test(r.id)||typeof r.session_id!=='string'||typeof r.project!=='string'||!Number.isFinite(r.updated)||json(r.data).id!==r.id)throw new Error('Invalid artifact backup');ids.add(r.id);}
  for(const r of rows.artifact_refs)if(typeof r.id!=='string'||!uuidPattern.test(r.id)||!ids.has(r.artifact_id)||!(r.owner_kind==='session'?sessionIds.has(r.owner_id):r.owner_kind==='project'&&typeof r.owner_id==='string')||(r.version_id!==null&&typeof r.version_id!=='string')||!Number.isFinite(r.created))throw new Error('Invalid artifact backup');
  for(const r of rows.artifact_versions){const data=json(r.data);if(typeof r.id!=='string'||!uuidPattern.test(r.id)||!ids.has(r.artifact_id)||typeof r.sha256!=='string'||!hashPattern.test(r.sha256)||data.sha256!==r.sha256||data.versionId!==r.id||data.artifactId!==r.artifact_id||!Number.isFinite(r.created))throw new Error('Invalid artifact backup');versionIds.add(r.id);}
  for(const r of rows.artifact_derivations)if(typeof r.id!=='string'||!uuidPattern.test(r.id)||!versionIds.has(r.source_version_id)||(r.derived_version_id!==null&&!versionIds.has(r.derived_version_id))||typeof r.kind!=='string'||r.kind.length>40||!Number.isFinite(r.created))throw new Error('Invalid artifact backup');
  for(const ref of rows.artifact_refs)ids.delete(ref.artifact_id);
  if(ids.size)throw new Error('Invalid artifact backup: an artifact has no owner');
  target.transaction(()=>{for(const table of Object.keys(artifactTables) as ArtifactTable[]){
    const columns=artifactTables[table].split(','),insert=target.db.prepare(`INSERT INTO ${table}(${artifactTables[table]}) VALUES (${columns.map(()=>'?').join(',')})`);
    for(const row of rows[table])insert.run(...columns.map(column=>row[column]??null));
  }});
  for(const hash of new Set<string>(rows.artifact_versions.map((v:any)=>v.sha256))){
    if(!verified.has(hash))continue;
    const folder=privateDir(join(stage,'artifacts','objects',hash.slice(0,2))),path=join(folder,hash);
    await copyFile(join(directory,'artifacts',hash),path,constants.COPYFILE_EXCL);chmodSync(path,0o600);
    // The copy is checked too: what the restored profile serves is exactly what the review verified.
    if(digest(await readFile(path))!==hash){await rm(path,{force:true});verified.delete(hash);}
  }
}
/** Copies regular, owner-private files only; links and foreign files stay behind. */
async function carryPrivateFiles(from:string,to:string,names?:string[]){
  let entries:string[];try{entries=names||await readdir(from);}catch(error:any){if(error.code==='ENOENT')return;throw error;}
  for(const name of entries){
    const source=join(from,name);let info;try{info=await lstat(source);}catch(error:any){if(error.code==='ENOENT')continue;throw error;}
    if(!info.isFile()||info.uid!==process.getuid?.())continue;
    privateDir(to);const target=join(to,name);await copyFile(source,target,constants.COPYFILE_EXCL);chmodSync(target,0o600);
  }
}
/** Run only after verifying no broker owns the socket, before opening any database. */
export function activatePendingRecovery(directory:string){
  directory=resolve(directory);const journal=journalPath(directory);if(!existsSync(journal))return false;
  privateFile(journal);const intent=JSON.parse(readFileSync(journal,'utf8'));
  const valid=(path:unknown,prefix:string)=>typeof path==='string'&&dirname(path)===dirname(directory)&&basename(path).startsWith(basename(directory)+prefix)&&/^[a-f0-9-]{36}$/.test(basename(path).slice((basename(directory)+prefix).length));
  if(!valid(intent.stage,'-restore-')||!valid(intent.previous,'-previous-'))throw new Error('Invalid recovery activation paths');
  if(existsSync(intent.stage)){
    privateDir(intent.stage);
    if(existsSync(directory)){
      if(existsSync(intent.previous))throw new Error('Recovery requires manual inspection: both serving and previous profiles exist');
      if(digest(registry(directory))!==intent.registryDigest){
        // Keep the serving profile authoritative and allow the broker to start.
        renameSync(journal,journal+'.rejected-'+randomUUID());
        rmSync(intent.stage,{recursive:true,force:true});
        writeFileSync(join(directory,'recovery-warning.json'),JSON.stringify({message:'Restore was cancelled because forgetting records changed. The current profile is intact; review the backup again.'}),{mode:0o600});
        return false;
      }
      renameSync(directory,intent.previous);
    }
    renameSync(intent.stage,directory);
  }else if(!existsSync(directory)||!existsSync(intent.previous))throw new Error('Recovery staging is missing');
  unlinkSync(journal);return true;
}

type Review={id:string;directory:string;manifest:any;digest:string;registryDigest:string;expires:number;includeContent:boolean;contentAllowed:boolean};
export class Recovery {
  core:Core;reviews=new Map<string,Review>();pending=false;staging=false;warning='';restartTimer?:NodeJS.Timeout;
  constructor(core:Core){this.core=core;try{this.warning=JSON.parse(readFileSync(join(core.store.directory,'recovery-warning.json'),'utf8')).message||'';}catch{}}
  async dispatch(method:string,p:any):Promise<any>{
    if(method==='recovery.status')return{pending:this.pending,activationWarning:this.warning,defaultExclusions:['provider credentials','device keys and pairing','active grants and power sessions','saved executable actions','temporary conversations','workspace folder access, pending file changes and image or analysis runs'],warning:'Conversation and memory content may contain secrets you typed. Backups are private files, not encrypted archives.'};
    if(method==='recovery.dismissWarning'){this.warning='';if(existsSync(join(this.core.store.directory,'recovery-warning.json')))unlinkSync(join(this.core.store.directory,'recovery-warning.json'));this.core.changed();return true;}
    if(method==='recovery.backup'){
      await this.core.memory.ready;
      const directory=join(this.core.store.directory,'backups',randomUUID());privateDir(directory);
      const forgetting=registry(this.core.store.directory),registryDigest=digest(forgetting);
      try{
      const includeContent=p.includeContent===true;
      const sessions=includeContent?this.core.store.db.prepare('SELECT data FROM sessions').all().map(r=>JSON.parse(String(r.data))):[];
      const messages=includeContent?this.core.store.db.prepare('SELECT data FROM messages').all().map(r=>JSON.parse(String(r.data))):[];
      const data={version:1,created:Date.now(),includeContent,folders:this.core.store.folders(),sessions,messages,notes:includeContent?this.core.store.get('utilityEntries',[]):[],capsules:includeContent?this.core.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'capsule:%'").all().map(r=>({key:r.key,value:JSON.parse(String(r.value))})):[],settings:{interfaceScale:this.core.settings.interfaceScale,scale:this.core.settings.scale,reducedMotion:this.core.settings.reducedMotion,homePositions:this.core.settings.homePositions},attachments:[] as any[],artifacts:undefined as Awaited<ReturnType<typeof backupArtifacts>>|undefined};
      if(includeContent){
        privateDir(join(directory,'attachments'));
        for(const session of sessions)for(const asset of session.draftAttachments||[]){const bytes=await readFile(asset.path);if(digest(bytes)!==asset.sha256)throw new Error('A draft attachment changed; repair it before backup');await writeFile(join(directory,'attachments',asset.id),bytes,{mode:0o600,flag:'wx'});data.attachments.push({...asset,sessionId:session.id,path:undefined});}
        await this.core.memory.graph(undefined,'backup',{output:join(directory,'memory.sqlite')});
        // Files the conversations made or imported; their bytes are optional so a backup can stay small.
        data.artifacts=await backupArtifacts(this.core.store,directory,new Set(sessions.map((s:any)=>String(s.id))),p.includeArtifactBytes!==false);
      }
      // The registry is required even when memory payloads are excluded.
      await writeFile(join(directory,'erasure-registry.jsonl'),forgetting,{mode:0o600,flag:'wx'});
      const text=JSON.stringify(data);await writeFile(join(directory,'profile.json'),text,{mode:0o600,flag:'wx'});
      const manifest={version:1,created:data.created,includeContent,profileDigest:digest(text),registryDigest:digest(forgetting),...(includeContent?{memoryDigest:digest(await readFile(join(directory,'memory.sqlite')))}:{}),sessions:sessions.length,messages:messages.length,attachments:data.attachments.length,...(data.artifacts?{artifacts:data.artifacts.rows.artifact_versions.length,artifactBytes:data.artifacts.withBytes,artifactBytesMissing:data.artifacts.missingAtBackup}:{})};
      await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest),{mode:0o600,flag:'wx'});
      if(digest(registry(this.core.store.directory))!==registryDigest)throw new Error('Forgetting records changed during backup. No backup was retained; retry.');
      return{directory,manifest,exclusions:(await this.dispatch('recovery.status',{})).defaultExclusions};
      }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
    }
    if(method==='recovery.preview'){
      const directory=resolve(String(p.directory||''));privateFile(join(directory,'manifest.json'));
      const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
      if(manifest.version!==1||typeof manifest.includeContent!=='boolean')throw new Error('Unsupported backup format');
      const profile=join(directory,'profile.json');if((await stat(profile)).size>128*1024*1024)throw new Error('Backup exceeds the review limit');
      const bytes=await readFile(profile);if(digest(bytes)!==manifest.profileDigest)throw new Error('Backup contents changed');
      const data=JSON.parse(bytes.toString());if(data.version!==1||!Array.isArray(data.sessions)||!Array.isArray(data.messages)||data.sessions.length>100000||data.messages.length>1000000)throw new Error('Invalid profile backup');
      await this.core.memory.ready;const registryDigest=digest(registry(this.core.store.directory));
      const contentAllowed=registryDigest===manifest.registryDigest;
      const review:Review={id:randomUUID(),directory,manifest,digest:digest(JSON.stringify(manifest)),registryDigest,expires:Date.now()+300000,includeContent:p.includeContent===true&&manifest.includeContent,contentAllowed};
      // Artifact bytes are hashed now, so the review states exactly which files would come back without them.
      const artifacts=review.includeContent&&contentAllowed&&data.artifacts?artifactSummary(data.artifacts,await verifiedArtifactObjects(directory,data.artifacts)):null;
      this.reviews.clear();this.reviews.set(review.id,review);
      return{id:review.id,digest:review.digest,folders:data.folders.length,artifacts,sessions:review.includeContent&&contentAllowed?data.sessions.length:0,messages:review.includeContent&&contentAllowed?data.messages.length:0,memory:review.includeContent,contentAllowed,warning:contentAllowed?'Restored sessions stay interrupted and tools stay paused.':'Forgetting records differ: conversation text, drafts, attachments, files and notes will be omitted. Memory restore applies the current forgetting registry.',
        kept:'This computer keeps its connections, API keys, paired phones, voice profiles, personality and other preferences. Tools stay paused and project grants are cleared until you resume them.',
        replaced:review.includeContent&&contentAllowed?'Conversations, drafts, notes, project capsules, conversation files and memory come from the backup. Workspace folders must be chosen again.':review.includeContent?'Memory comes from the backup with current forgetting applied; conversations, drafts, files and notes are omitted.':'This restore includes no conversations, drafts or notes, so the restored profile starts without them. Current memory is kept.',restartRequired:true};
    }
    if(method==='recovery.cancel'){
      if(this.restartTimer)clearTimeout(this.restartTimer);this.restartTimer=undefined;
      if(this.staging)throw new Error('Recovery is still staging. Wait for it to finish before cancelling.');
      const file=journalPath(this.core.store.directory);if(existsSync(file)){privateFile(file);const intent=JSON.parse(readFileSync(file,'utf8'));if(typeof intent.stage==='string'&&dirname(intent.stage)===dirname(this.core.store.directory)&&basename(intent.stage).startsWith(basename(this.core.store.directory)+'-restore-'))await rm(intent.stage,{recursive:true,force:true});unlinkSync(file);}this.pending=false;await this.core.memory.service.resumeAfterRecovery();this.core.changed();return true;
    }
    if(method==='recovery.activate'){
      if(this.pending)throw new Error('Recovery is already in progress');
      const review=this.reviews.get(p.id);if(!review||review.digest!==p.digest||review.expires<Date.now())throw new Error('Review the backup again');
      if(this.core.activeMutations||this.core.memoryCaptures.size||this.core.sending.size||this.core.checkingTimers)throw new Error('Wait for current changes to finish before restoring');
      if(this.core.store.sessions().some(s=>['working','starting','waiting','stopping'].includes(s.status))||this.core.approvals.size||this.core.actionControllers.size)throw new Error('Stop provider work and active desktop actions before restoring');
      if(this.core.memory.service.busy)throw new Error('Wait for memory maintenance to finish before restoring');
      if(this.core.power.snapshot().some((l:any)=>l.state!=='ended'))throw new Error('End power sessions before restoring');
      if(digest(registry(this.core.store.directory))!==review.registryDigest)throw new Error('Forgetting records changed. Review again.');
      this.pending=true;this.staging=true;this.core.changed();
      const directory=this.core.store.directory,stage=directory+'-restore-'+randomUUID();
      try{
        await this.core.memory.service.freezeForRecovery();
        const bytes=await readFile(join(review.directory,'profile.json'));if(digest(bytes)!==review.manifest.profileDigest)throw new Error('Backup changed after review');
        const data=JSON.parse(bytes.toString());privateDir(stage);
        if(review.includeContent){const source=join(review.directory,'memory.sqlite');if(digest(await readFile(source))!==review.manifest.memoryDigest)throw new Error('Memory backup changed');await this.core.memory.graph(undefined,'restore',{input:source,staging:join(stage,'graph-memory')});}
        else {privateDir(join(stage,'graph-memory'));await this.core.memory.graph(undefined,'backup',{output:join(stage,'graph-memory','memory.sqlite')});await copyFile(join(directory,'graph-memory','erasure-registry.jsonl'),join(stage,'graph-memory','erasure-registry.jsonl'));chmodSync(join(stage,'graph-memory','erasure-registry.jsonl'),0o600);}
        const store=new Store(stage);let restoredArtifacts:ReturnType<typeof artifactSummary>|null=null;
        try{
          for(const folder of data.folders){if(typeof folder.id!=='string'||typeof folder.name!=='string'||folder.name.length>80)throw new Error('Invalid folder backup');store.saveFolder(folder);}
          if(review.includeContent&&review.contentAllowed){
            const ids=new Set<string>();for(const s of data.sessions){if(typeof s.id!=='string'||typeof s.cwd!=='string'||!(providerIds as readonly string[]).includes(s.provider)||s.temporary)throw new Error('Invalid session backup');delete s.remote;delete s.effectivePolicy;delete s.nativeId;s.nativeId=null;s.mode='managed';s.status='interrupted';s.error='Restored from backup. Review the draft before starting a new provider conversation.';s.draftAttachments=[];delete s.activity;delete s.agents;store.saveSession(s);ids.add(s.id);}
            for(const m of data.messages){if(!ids.has(m.sessionId)||typeof m.id!=='string'||typeof m.text!=='string'||m.text.length>32*1024*1024)throw new Error('Invalid transcript backup');store.message(m);}
            for(const a of data.attachments){if(!ids.has(a.sessionId)||!/^[a-f0-9-]{36}$/.test(a.id))throw new Error('Invalid attachment backup');const bytes=await readFile(join(review.directory,'attachments',a.id));if(digest(bytes)!==a.sha256)throw new Error('Attachment backup changed');privateDir(join(stage,'draft-attachments'));const path=join(directory,'draft-attachments',a.id);await writeFile(join(stage,'draft-attachments',a.id),bytes,{mode:0o600,flag:'wx'});const asset={...a,path};delete asset.sessionId;store.set('attachment:'+a.id,{sessionId:a.sessionId,asset});const s=store.session(a.sessionId);s.draftAttachments=[...s.draftAttachments||[],asset];store.saveSession(s);}
            store.set('utilityEntries',data.notes||[]);for(const capsule of data.capsules||[]){if(typeof capsule.key!=='string'||!capsule.key.startsWith('capsule:'))throw new Error('Invalid capsule backup');store.set(capsule.key,capsule.value);}
            if(data.artifacts){const verified=await verifiedArtifactObjects(review.directory,data.artifacts);await restoreArtifacts(store,stage,review.directory,data.artifacts,ids,verified);restoredArtifacts=artifactSummary(data.artifacts,verified);}
          }
          // A backup supplies only display preferences. Everything else is this machine's saved
          // configuration, so connections and preferences survive; tools stay paused and grants end.
          const settings:Partial<Settings>={...structuredClone(this.core.store.get<Partial<Settings>>('settings',{})),paused:true,grants:[]};
          if(Number.isFinite(data.settings?.interfaceScale)&&data.settings.interfaceScale>=.8&&data.settings.interfaceScale<=1.5)settings.interfaceScale=data.settings.interfaceScale;
          if(Number.isFinite(data.settings?.scale)&&data.settings.scale>=.5&&data.settings.scale<=3)settings.scale=data.settings.scale;
          if(typeof data.settings?.reducedMotion==='boolean')settings.reducedMotion=data.settings.reducedMotion;
          const homes=data.settings?.homePositions;if(homes&&typeof homes==='object'&&!Array.isArray(homes)&&Object.keys(homes).length<=32&&Object.entries(homes).every(([key,value]:[string,any])=>key.length<=200&&value&&[value.x,value.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)))settings.homePositions=homes;
          store.set('settings',settings);store.set('settingsRevision',String(BigInt(this.core.store.get('settingsRevision','0'))+1n));
          for(const key of machineMeta){const value=this.core.store.get<unknown>(key,undefined);if(value!==undefined)store.set(key,value);}
          new RemoteStore(store);
          for(const [table,columns] of machineTables){
            if(!this.core.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
            const insert=store.db.prepare(`INSERT OR REPLACE INTO ${table}(${columns}) VALUES (${columns.split(',').map(()=>'?').join(',')})`);
            for(const row of this.core.store.db.prepare(`SELECT ${columns} FROM ${table}`).all())insert.run(...columns.split(',').map(column=>row[column] as any));
          }
          // Phones replace their cached transcripts: the conversations now come from the backup.
          store.set('transcriptEpoch',randomUUID());
          store.set('recoverySource',{created:review.manifest.created,restored:Date.now(),historyOmitted:!review.contentAllowed,...(restoredArtifacts?{artifacts:restoredArtifacts}:{})});
        }finally{store.close();}
        await carryPrivateFiles(join(directory,'credentials'),join(stage,'credentials'),['provider-credentials.json','image-connection-secrets.json']);
        await carryPrivateFiles(join(directory,'remote-identity'),join(stage,'remote-identity'));
        if(digest(registry(directory))!==review.registryDigest)throw new Error('Forgetting records changed while staging; review again');
        const intent={stage,previous:directory+'-previous-'+randomUUID(),registryDigest:review.registryDigest};writeFileSync(journalPath(directory),JSON.stringify(intent),{mode:0o600,flag:'wx'});
        this.reviews.delete(review.id);this.staging=false;
        this.restartTimer=setTimeout(()=>{if(this.pending)this.core.emit('restart');},100);this.restartTimer.unref();return{restarting:true,previous:intent.previous};
      }catch(error){this.pending=false;this.staging=false;await rm(stage,{recursive:true,force:true});await this.core.memory.service.resumeAfterRecovery();this.core.changed();throw error;}
    }
    throw new Error('Unknown recovery operation');
  }
}
