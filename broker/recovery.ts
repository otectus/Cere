import { providerIds } from './provider-catalog.ts';
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,readFileSync,writeFileSync,renameSync,unlinkSync,lstatSync,chmodSync,rmSync } from 'node:fs';
import { readFile,writeFile,mkdir,copyFile,stat,rm } from 'node:fs/promises';
import { join,dirname,basename,resolve } from 'node:path';
import { Store } from './store.ts';
import { privateDir } from './paths.ts';
import { defaultSettings } from './types.ts';
import type { Core } from './core.ts';
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const registry=(directory:string)=>readFileSync(join(directory,'graph-memory','erasure-registry.jsonl'));
const journalPath=(directory:string)=>join(dirname(directory),'.'+basename(directory)+'-recovery.json');
const privateFile=(path:string)=>{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw new Error('Recovery file must be owned by you and private');};
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
    if(method==='recovery.status')return{pending:this.pending,activationWarning:this.warning,defaultExclusions:['provider credentials','device keys and pairing','active grants and power sessions','saved executable actions','temporary conversations'],warning:'Conversation and memory content may contain secrets you typed. Backups are private files, not encrypted archives.'};
    if(method==='recovery.dismissWarning'){this.warning='';if(existsSync(join(this.core.store.directory,'recovery-warning.json')))unlinkSync(join(this.core.store.directory,'recovery-warning.json'));this.core.changed();return true;}
    if(method==='recovery.backup'){
      await this.core.memory.ready;
      const directory=join(this.core.store.directory,'backups',randomUUID());privateDir(directory);
      const forgetting=registry(this.core.store.directory),registryDigest=digest(forgetting);
      try{
      const includeContent=p.includeContent===true;
      const sessions=includeContent?this.core.store.db.prepare('SELECT data FROM sessions').all().map(r=>JSON.parse(String(r.data))):[];
      const messages=includeContent?this.core.store.db.prepare('SELECT data FROM messages').all().map(r=>JSON.parse(String(r.data))):[];
      const data={version:1,created:Date.now(),includeContent,folders:this.core.store.folders(),sessions,messages,notes:includeContent?this.core.store.get('utilityEntries',[]):[],capsules:includeContent?this.core.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'capsule:%'").all().map(r=>({key:r.key,value:JSON.parse(String(r.value))})):[],settings:{interfaceScale:this.core.settings.interfaceScale,scale:this.core.settings.scale,reducedMotion:this.core.settings.reducedMotion,homePositions:this.core.settings.homePositions},attachments:[] as any[]};
      if(includeContent){
        privateDir(join(directory,'attachments'));
        for(const session of sessions)for(const asset of session.draftAttachments||[]){const bytes=await readFile(asset.path);if(digest(bytes)!==asset.sha256)throw new Error('A draft attachment changed; repair it before backup');await writeFile(join(directory,'attachments',asset.id),bytes,{mode:0o600,flag:'wx'});data.attachments.push({...asset,sessionId:session.id,path:undefined});}
        await this.core.memory.graph(undefined,'backup',{output:join(directory,'memory.sqlite')});
      }
      // The registry is required even when memory payloads are excluded.
      await writeFile(join(directory,'erasure-registry.jsonl'),forgetting,{mode:0o600,flag:'wx'});
      const text=JSON.stringify(data);await writeFile(join(directory,'profile.json'),text,{mode:0o600,flag:'wx'});
      const manifest={version:1,created:data.created,includeContent,profileDigest:digest(text),registryDigest:digest(forgetting),...(includeContent?{memoryDigest:digest(await readFile(join(directory,'memory.sqlite')))}:{}),sessions:sessions.length,messages:messages.length,attachments:data.attachments.length};
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
      this.reviews.clear();this.reviews.set(review.id,review);
      return{id:review.id,digest:review.digest,folders:data.folders.length,sessions:review.includeContent&&contentAllowed?data.sessions.length:0,messages:review.includeContent&&contentAllowed?data.messages.length:0,memory:review.includeContent,contentAllowed,warning:contentAllowed?'Restored sessions stay interrupted and tools stay paused.':'Forgetting records differ: conversation text, drafts, attachments and notes will be omitted. Memory restore applies the current forgetting registry.',restartRequired:true};
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
        const store=new Store(stage);
        try{
          for(const folder of data.folders){if(typeof folder.id!=='string'||typeof folder.name!=='string'||folder.name.length>80)throw new Error('Invalid folder backup');store.saveFolder(folder);}
          if(review.includeContent&&review.contentAllowed){
            const ids=new Set<string>();for(const s of data.sessions){if(typeof s.id!=='string'||typeof s.cwd!=='string'||!(providerIds as readonly string[]).includes(s.provider)||s.temporary)throw new Error('Invalid session backup');delete s.remote;delete s.effectivePolicy;delete s.nativeId;s.nativeId=null;s.mode='managed';s.status='interrupted';s.error='Restored from backup. Review the draft before starting a new provider conversation.';s.draftAttachments=[];delete s.activity;delete s.agents;store.saveSession(s);ids.add(s.id);}
            for(const m of data.messages){if(!ids.has(m.sessionId)||typeof m.id!=='string'||typeof m.text!=='string'||m.text.length>32*1024*1024)throw new Error('Invalid transcript backup');store.message(m);}
            for(const a of data.attachments){if(!ids.has(a.sessionId)||!/^[a-f0-9-]{36}$/.test(a.id))throw new Error('Invalid attachment backup');const bytes=await readFile(join(review.directory,'attachments',a.id));if(digest(bytes)!==a.sha256)throw new Error('Attachment backup changed');privateDir(join(stage,'draft-attachments'));const path=join(directory,'draft-attachments',a.id);await writeFile(join(stage,'draft-attachments',a.id),bytes,{mode:0o600,flag:'wx'});const asset={...a,path};delete asset.sessionId;store.set('attachment:'+a.id,{sessionId:a.sessionId,asset});const s=store.session(a.sessionId);s.draftAttachments=[...s.draftAttachments||[],asset];store.saveSession(s);}
            store.set('utilityEntries',data.notes||[]);for(const capsule of data.capsules||[]){if(typeof capsule.key!=='string'||!capsule.key.startsWith('capsule:'))throw new Error('Invalid capsule backup');store.set(capsule.key,capsule.value);}
          }
          // Restore only display preferences. Credential-bearing and executable settings are excluded.
          const settings={...structuredClone(defaultSettings),paused:true,profile:'manual',categories:[],grants:[],speechEnabled:false,memory:{...defaultSettings.memory,enabled:false}};
          if(Number.isFinite(data.settings?.interfaceScale)&&data.settings.interfaceScale>=.8&&data.settings.interfaceScale<=1.5)settings.interfaceScale=data.settings.interfaceScale;
          if(Number.isFinite(data.settings?.scale)&&data.settings.scale>=.5&&data.settings.scale<=3)settings.scale=data.settings.scale;
          if(typeof data.settings?.reducedMotion==='boolean')settings.reducedMotion=data.settings.reducedMotion;
          const homes=data.settings?.homePositions;if(homes&&typeof homes==='object'&&!Array.isArray(homes)&&Object.keys(homes).length<=32&&Object.entries(homes).every(([key,value]:[string,any])=>key.length<=200&&value&&[value.x,value.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)))settings.homePositions=homes;
          store.set('settings',settings);store.set('recoverySource',{created:review.manifest.created,restored:Date.now(),historyOmitted:!review.contentAllowed});
        }finally{store.close();}
        if(digest(registry(directory))!==review.registryDigest)throw new Error('Forgetting records changed while staging; review again');
        const intent={stage,previous:directory+'-previous-'+randomUUID(),registryDigest:review.registryDigest};writeFileSync(journalPath(directory),JSON.stringify(intent),{mode:0o600,flag:'wx'});
        this.reviews.delete(review.id);this.staging=false;
        this.restartTimer=setTimeout(()=>{if(this.pending)this.core.emit('restart');},100);this.restartTimer.unref();return{restarting:true,previous:intent.previous};
      }catch(error){this.pending=false;this.staging=false;await rm(stage,{recursive:true,force:true});await this.core.memory.service.resumeAfterRecovery();this.core.changed();throw error;}
    }
    throw new Error('Unknown recovery operation');
  }
}
