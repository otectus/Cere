import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { privateDir } from './paths.ts';
import type { Core } from './core.ts';

/** Diagnostic exports use an allowlist. Transcripts, paths, argv and raw errors never enter it. */
export function healthReport(core:Core) {
  const classify=(error:string)=>/auth|login|sign.in|credential|unauthorized|401/i.test(error)?'authentication':/protocol|schema|unsupported|unknown method|incompatible/i.test(error)?'protocol':/network|connect|timeout|fetch|ECONN|503/i.test(error)?'network':'provider';
  const providers=Object.entries(core.capabilities).map(([id,value])=>{
    const p=value as any,error=String(p.modelsError||p.error||'');
    return {id,available:p.available===true,version:String(p.version||'').match(/\b\d+\.\d+(?:\.\d+)?\b/)?.[0]||null,modelsStatus:p.modelsStatus||'unknown',
      authentication:'not-verified',problem:error?classify(error):null,repair:'Refresh provider catalog; sign in through the provider’s own application if authentication fails.'};
  });
  const memory=core.memory.summary(),speech=core.speech.snapshot();
  return {schema:1,time:new Date().toISOString(),node:process.version,providers,
    memory:{enabled:core.settings.memory.enabled,state:core.memory.status.state,pending:core.memory.status.pending,coverage:core.memory.status.warning?'degraded':'not-measured'},
    speech:{enabled:core.settings.speechEnabled,state:speech.state,backend:speech.backend,problem:speech.error?'speech':null},
    sessions:{count:core.store.sessionCount(),active:core.store.sessions().filter(s=>['starting','working','waiting','stopping'].includes(s.status)).length},
    permissions:{paused:core.settings.paused,activePowerSessions:core.power.snapshot().filter(p=>p.state==='active').length},
    privacy:'Excludes conversation text, drafts, project paths, saved commands, credentials, device identities and raw provider errors.'};
}
export class Diagnostics {
  core:Core;previews=new Map<string,{digest:string;text:string;expires:number}>();
  constructor(core:Core){this.core=core;}
  preview(){
    const text=JSON.stringify(healthReport(this.core),null,2),id=randomUUID(),digest=createHash('sha256').update(text).digest('hex');
    this.previews.clear();this.previews.set(id,{digest,text,expires:Date.now()+300000});return{id,digest,text};
  }
  async export(id:string,digest:string){
    const preview=this.previews.get(id);if(!preview||preview.digest!==digest||preview.expires<Date.now())throw new Error('Review a fresh diagnostic export');
    this.previews.delete(id);const directory=privateDir(join(this.core.store.directory,'diagnostics')),path=join(directory,'cere-'+id+'.json');
    await writeFile(path,preview.text,{mode:0o600,flag:'wx'});return{path};
  }
}
