import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import { join, dirname, relative, resolve, matchesGlob } from 'node:path';
import { canonical, matchRoot, ancestor } from './paths.ts';
import { linuxNative, type LinuxNative, type FileEvent } from './native.ts';
import { TelemetryState } from './state.ts';
const excluded=new Set(['.git','node_modules','.venv','venv','vendor','target','build','dist','.cache','__pycache__','.next','.gradle','.idea','.local-deps','coverage']);
export class Files {
  state:TelemetryState;native:LinuxNative;handle?:unknown;watches=new Map<number,string>(); directories=new Map<string,number>();heads=new Map<string,string>();
  pending=new Map<string,{root:string;path:string;at:number;ts:string;type:string;generation:number}>();queue:FileEvent[]=[];running=false;generation=0;stopped=false;
  status='stopped';lastError='';drops=0;timer?:NodeJS.Timeout;gitIgnores=new Map<string,string[]>();
  constructor(state:TelemetryState,native=linuxNative()){this.state=state;this.native=native;}
  ignore(root:string,path:string){const r=relative(root,path);return r.split('/').some(p=>excluded.has(p))||/(?:~|\.sw[opx]|\.tmp|\.temp|\.bak)$/.test(r)||/(^|\/)\.#/.test(r)||[...this.state.config.ignores,...this.gitIgnores.get(root)||[]].some(p=>matchesGlob(r,p)||matchesGlob(r+'/',p)||matchesGlob(r,p+'/**')||(!p.includes('/')&&r.split('/').some(c=>matchesGlob(c,p))));}
  degraded(code:string){this.status='degraded';this.lastError=code;}
  async start(){
    this.status='watching';this.handle=this.native.start(events=>{for(const event of events){if(this.queue.length>=256){this.queue.shift();this.drops++;this.degraded('FILE_QUEUE_OVERFLOW');}this.queue.push({...event,at:this.state.now(),ts:new Date().toISOString(),generation:this.generation});}void this.drain();});
    for(const root of this.state.config.roots){
      try{const file=join(root,'.gitignore');const stat=await lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=32768){const patterns=(await readFile(file,'utf8')).split(/\r?\n/).filter(s=>s&&!s.startsWith('#')&&!s.startsWith('!')).map(s=>s.replace(/^\//,'').replace(/\/$/,''));this.gitIgnores.set(root,patterns.slice(0,256));}}catch{}
      await this.walk(root,root);await this.git(root);
    }
    this.timer=setInterval(()=>void this.flush(),50);this.timer.unref();
  }
  watch(path:string){if(this.directories.has(path)||this.stopped)return;if(this.watches.size>=8192){this.degraded('WATCH_BUDGET');return;}
    try{const wd=this.native.add(this.handle,path);this.watches.set(wd,path);this.directories.set(path,wd);}catch(e:any){this.degraded(e.message==='WATCH_LIMIT'?'WATCH_LIMIT':'WATCH_UNAVAILABLE');}}
  async walk(root:string,path:string){
    if(this.stopped||this.ignore(root,path))return;
    try{const st=await lstat(path);if(st.isSymbolicLink()||!st.isDirectory())return;const resolved=await realpath(path);if(resolved!==path||!ancestor(root,resolved))return;
      if(this.stopped)return;this.watch(path);if(this.watches.size>=8192)return;
      const entries=await opendir(path);for await(const entry of entries){if(this.stopped)return;if(entry.isDirectory()&&!entry.isSymbolicLink()&&!this.ignore(root,join(path,entry.name)))await this.walk(root,join(path,entry.name));}
    }catch{if(!this.stopped)this.degraded('DIRECTORY_UNAVAILABLE');}
  }
  async git(root:string){
    try{const marker=join(root,'.git');const info=await lstat(marker);if(info.isSymbolicLink())return;let directory=marker;
      if(info.isFile()){if(info.size>4096)return;const text=await readFile(marker,'utf8');const match=/^gitdir: ([^\r\n]+)\s*$/.exec(text);if(!match)return;directory=await realpath(resolve(root,match[1]));}
      else if(!info.isDirectory())return;
      if(this.stopped)return;this.heads.set(root,directory);this.watch(directory);await this.branch(root);
    }catch{}
  }
  async branch(root:string){const directory=this.heads.get(root);if(!directory){await this.git(root);return;}const generation=this.generation;
    try{const path=join(directory,'HEAD');const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw 0;const text=(await readFile(path,'utf8')).trim();
      const value=text.startsWith('ref: refs/heads/')?text.slice(16):/^[0-9a-f]{40,64}$/i.test(text)?text.slice(0,8):'';
      if(!this.stopped&&generation===this.generation){if(value)this.state.branches.set(root,{value,at:this.state.now()});else this.state.branches.delete(root);}
    }catch{if(generation===this.generation)this.state.branches.delete(root);}
  }
  async drain(){if(this.running)return;this.running=true;try{while(this.queue.length&&!this.stopped)await this.event(this.queue.shift()!);}finally{this.running=false;}}
  async event(e:FileEvent){
    if(e.generation!==undefined&&e.generation!==this.generation)return;
    if(e.mask&0x4000){this.degraded('IN_Q_OVERFLOW');return;}
    const directory=this.watches.get(e.wd);if(!directory)return;
    if(e.mask&(0x400|0x800)&&this.state.config.roots.includes(directory)){this.degraded('WORKSPACE_UNAVAILABLE');this.state.edits.delete(directory);this.state.branches.delete(directory);}
    if(e.mask&0x8000){this.watches.delete(e.wd);this.directories.delete(directory);return;}
    for(const [root,head]of this.heads)if(directory===head){if(e.name==='HEAD')await this.branch(root);return;}
    if(!e.name||e.name.includes('/'))return;const path=join(directory,e.name),root=matchRoot(this.state.config.roots,path);if(!root||this.ignore(root,path))return;
    const generation=this.generation;
    if(e.mask&0x40000000){
      if(e.mask&(0x100|0x80))await this.walk(root,path);
      if(e.mask&(0x200|0x40)){for(const [dir,wd]of this.directories)if(ancestor(path,dir)){this.native.remove(this.handle,wd);this.directories.delete(dir);this.watches.delete(wd);}for(const [key,p]of this.pending)if(ancestor(path,key))this.pending.delete(key);this.state.edits.set(root,(this.state.edits.get(root)||[]).filter(v=>!ancestor(path,join(root,v.path))));}return;
    }
    if(e.mask&(0x200|0x40)){this.pending.delete(path);this.state.edit(root,relative(root,path),'delete');return;}
    if(!(e.mask&(0x8|0x80)))return;
    let resolved:string;try{resolved=await canonical(path);const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())return;}catch{return;}
    const owner=matchRoot(this.state.config.roots,resolved);if(!owner||this.ignore(owner,resolved)||this.stopped||generation!==this.generation)return;
    if(this.pending.size>=1024&&!this.pending.has(resolved)){this.pending.delete(this.pending.keys().next().value!);this.drops++;this.degraded('DEBOUNCE_BUDGET');}
    this.pending.set(resolved,{root:owner,path:relative(owner,resolved),at:e.at??this.state.now(),ts:e.ts??new Date().toISOString(),type:e.mask&0x80?'moved-to':'close-write',generation});
  }
  async flush(){const now=this.state.now();for(const [path,event]of this.pending)if(now-event.at>=500){this.pending.delete(path);if(event.generation===this.generation&&!this.stopped)this.state.edit(event.root,event.path,event.type,event.at,event.ts);}}
  clear(){this.generation++;this.pending.clear();this.queue=[];}
  stop(){this.stopped=true;this.clear();if(this.timer)clearInterval(this.timer);if(this.handle!==undefined){this.native.stop(this.handle);this.handle=undefined;}this.watches.clear();this.directories.clear();this.status='stopped';}
}
