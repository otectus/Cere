import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import type { Store } from './store.ts';
import { privateDir } from './paths.ts';
import { IndexEngine } from './indextts-engine.ts';
import { IndexError, indexError, indexPaths, indexChunks, validateEmotion, defaultEmotion, previewSamples, type IndexConfig, type IndexCapabilities, type VoiceProfile, type Emotion } from './indextts-config.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
type ModelState='not-installed'|'downloading'|'installed'|'loading'|'ready'|'error';
export class IndexTTS {
  state:ModelState='not-installed';message='Download IndexTTS to use voice cloning.';code='';recovery='';progress=0;
  caps?:IndexCapabilities;
  engine?:IndexEngine;
  private job?:ChildProcess;
  private jobDone?:Promise<void>;
  private busy=false;
  private active?:AbortController;
  private generation='';
  private disposed=false;
  private getConfig:()=>IndexConfig;
  private changed:()=>void;
  private store:Store;
  private env:NodeJS.ProcessEnv;
  constructor(store:Store,getConfig:()=>IndexConfig,changed=()=>{},env=process.env){this.store=store;this.getConfig=getConfig;this.changed=changed;this.env=env;}
  profiles(){return this.store.get<VoiceProfile[]>('indextts.voices',[]);}
  snapshot(){return {state:this.state,message:this.message,code:this.code,recovery:this.recovery,progress:this.progress,capabilities:this.caps||null,profiles:this.profiles(),busy:this.busy,workerPid:this.engine?.pid||null};}
  private update(state:ModelState,message:string){this.state=state;this.message=message;this.code='';this.recovery='';this.changed();console.info(`[indextts] state=${state}`);}
  private fail(error:unknown){const e=indexError(error);this.state='error';this.message=e.message;this.code=e.code;this.recovery=e.recovery;this.changed();console.info(`[indextts] state=error code=${e.code}`);return e;}
  private worker(){
    if(!this.engine)this.engine=new IndexEngine(this.getConfig(),()=>{
      if(!this.engine?.pid&&this.state==='ready')this.update('installed','Model unloaded; it will load for the next reply.');
    },this.env);
    return this.engine;
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy||this.disposed)throw new IndexError('BUSY');this.busy=true;this.changed();
    try{return await fn();}catch(e){
      if(e instanceof IndexError&&e.code==='CANCELLED'){this.update('installed','Speech stopped; model unloaded.');throw e;}
      throw this.fail(e);
    }finally{this.busy=false;this.changed();}
  }
  async refresh(){return this.exclusive(async()=>{
    try{await access(join(indexPaths(this.getConfig(),this.env).modelDir,'installation.json'));}catch{this.update('not-installed','Download IndexTTS to use voice cloning.');return this.snapshot();}
    this.caps=await this.worker().probe();
    if(this.state!=='ready')this.update('installed','Installed. Load the model or preview a voice.');
    // Probes do not leave a Python/CUDA context resident indefinitely.
    if(this.state!=='ready')await this.engine?.unload();
    return this.snapshot();
  });}
  async validateDirectory(config:IndexConfig){
    for(const p of [config.modelDir,config.runtimeDir])if(p){
      try{if(!isAbsolute(p))throw new Error();privateDir(p);await access(p,constants.W_OK);}catch{throw new IndexError('INVALID_PATH');}
    }
  }
  async reconfigure(){await this.stop();await this.engine?.unload();this.engine=undefined;this.caps=undefined;this.update('not-installed','Refresh the selected model installation.');}
  async load(){return this.exclusive(async()=>{
    this.update('loading','Loading IndexTTS…');this.caps=await this.worker().load(this.getConfig());
    this.update('ready',this.caps.device==='cpu'?'Ready on CPU. Synthesis may be very slow.':'IndexTTS is ready.');return this.snapshot();
  });}
  async unload(){await this.stop();await this.engine?.unload();if(this.state!=='not-installed')this.update('installed','Model unloaded.');}
  install(options:{acceptLicense?:boolean;emotion?:boolean;deepspeed?:boolean;verify?:boolean}){
    if(this.busy||this.disposed)throw new IndexError('BUSY');
    if(!options||Object.values(options).some(v=>typeof v!=='boolean'))throw new IndexError('INVALID_CONFIG');
    if(!options.verify&&!options.acceptLicense)throw new IndexError('LICENSE_REQUIRED');
    this.busy=true;this.progress=0;
    const config=this.getConfig(),paths=indexPaths(config,this.env);
    this.update(options.verify?'loading':'downloading',options.verify?'Verifying installation…':'Downloading pinned model files…');
    const args=['-B',join(root,'tools/setup-indextts.py'),'--version',config.version,'--model-dir',paths.modelDir,'--runtime-dir',paths.runtimeDir,
      ...(options.verify?['--verify']:['--accept-license']),...(options.emotion?['--emotion']:[]),...(options.deepspeed?['--deepspeed']:[])];
    this.jobDone=(async()=>{
      await this.engine?.unload();this.engine=undefined;
      if(this.disposed)return;
      await new Promise<void>((done)=>{
        const proc=this.job=spawn(this.env.CERE_INDEXTTS_SETUP_PYTHON||'python3',args,{env:this.env,detached:process.platform==='linux',stdio:['ignore','pipe','ignore']});
        let buffer='',failure:IndexError|undefined,complete=false;
        proc.stdout!.setEncoding('utf8');proc.stdout!.on('data',(part:string)=>{
          buffer+=part;if(buffer.length>65536){failure=new IndexError('IPC_ERROR');this.killJob();return;}
          let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{
            const event=JSON.parse(line);
            if(event.state==='error')failure=new IndexError(event.code);
            else if(event.state==='installed'){complete=true;this.progress=1;}
            else {if(Number.isFinite(event.progress))this.progress=Math.max(0,Math.min(1,event.progress));this.message=event.stage==='runtime'?'Installing pinned Python and Torch dependencies…':event.state==='verifying'?'Verifying model checksums…':'Downloading pinned model files…';this.changed();}
          }catch{failure=new IndexError('IPC_ERROR');}}
        });
        proc.on('error',()=>{failure=new IndexError('RUNTIME_MISSING');});
        proc.on('close',code=>{this.job=undefined;this.busy=false;if(failure||code!==0||!complete)this.fail(failure||new IndexError('DOWNLOAD_FAILED'));else this.update('installed','Installation verified. Refresh devices or load the model.');done();});
      });
    })().catch(e=>{this.busy=false;this.fail(e);});
    return {queued:true};
  }
  private killJob(){if(!this.job?.pid)return;try{if(process.platform==='linux')process.kill(-this.job.pid,'SIGTERM');else this.job.kill('SIGTERM');}catch{/* Already exited. */}}
  async cancelDownload(){const pid=this.job?.pid;this.killJob();const timer=setTimeout(()=>{try{if(pid)process.kill(process.platform==='linux'?-pid:pid,'SIGKILL');}catch{}},750);timer.unref();await this.jobDone;clearTimeout(timer);}
  async saveProfile(input:any){return this.exclusive(async()=>{
    const config=this.getConfig(),existing=input.id?this.profiles().find(p=>p.id===input.id):undefined;
    if(input.id&&!existing)throw new IndexError('PROFILE_MISSING');
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new IndexError('INVALID_CONFIG');
    const caps=this.caps||await this.worker().probe();this.caps=caps;
    if(!caps.languages.includes(input.language))throw new IndexError('UNSUPPORTED_LANGUAGE');
    const emotion=validateEmotion(input.emotion||existing?.emotion||defaultEmotion),duration=input.durationFactor??existing?.durationFactor??1;
    if(!Number.isFinite(duration)||duration<.5||duration>2||!caps.durationControl&&duration!==1)throw new IndexError('INVALID_DURATION');
    if(!caps.emotionModes.includes(emotion.source))throw new IndexError('EMOTION_MISSING');
    if(existing&&existing.version!==config.version&&!input.referencePath)throw new IndexError('REFERENCE_MISSING');
    const id=existing?.id||randomUUID(),base=indexPaths(config,this.env).voices;privateDir(base);
    const staging=join(base,'.'+randomUUID());await mkdir(staging,{mode:0o700});
    const directory=join(base,id);let reference=existing?.reference,original=existing?.original,emotionReference=existing?.emotionReference,emotionOriginal=existing?.emotionOriginal;
    const prepare=async(source:string,prefix:string,rate:number)=>{
      if(typeof source!=='string'||!isAbsolute(source))throw new IndexError('REFERENCE_MISSING');
      try{const info=await stat(source);if(!info.isFile()||info.size>64*1024*1024)throw new Error();}catch{throw new IndexError('REFERENCE_CORRUPT');}
      const raw=join(staging,prefix+'-original'),converted=join(staging,prefix+'.wav');await copyFile(source,raw);await chmod(raw,0o600);
      await this.worker().command('validate',{source:raw,target:converted,sampleRate:rate});
      return {raw,converted};
    };
    try{
      const speaker=input.referencePath?await prepare(input.referencePath,'speaker',caps.sampleRate):undefined;
      const emot=input.emotionReferencePath?await prepare(input.emotionReferencePath,'emotion',16000):undefined;
      if(!speaker&&!reference)throw new IndexError('REFERENCE_MISSING');
      if(emotion.source==='reference-audio'&&!emot&&!emotionReference)throw new IndexError('REFERENCE_MISSING');
      await mkdir(directory,{recursive:true,mode:0o700});
      // Unique names make updates transactional: old profile files stay valid until persistence.
      const move=async(p:{raw:string;converted:string},prefix:string)=>{
        const stamp=randomUUID(),a=join(directory,`${prefix}-${stamp}.original`),b=join(directory,`${prefix}-${stamp}.wav`);
        await rename(p.raw,a);await rename(p.converted,b);return [a,b];
      };
      if(speaker)[original,reference]=await move(speaker,'speaker');
      if(emot)[emotionOriginal,emotionReference]=await move(emot,'emotion');
      const profile:VoiceProfile={id,name:input.name.trim(),language:input.language,version:config.version,created:existing?.created||Date.now(),updated:Date.now(),original:original!,reference:reference!,emotionOriginal,emotionReference,emotion,durationFactor:duration};
      this.store.set('indextts.voices',[...this.profiles().filter(p=>p.id!==id),profile]);
      for(const path of [existing?.reference,existing?.original,existing?.emotionReference,existing?.emotionOriginal])if(path&&![reference,original,emotionReference,emotionOriginal].includes(path))await rm(path,{force:true});
      this.changed();return profile;
    }finally{await rm(staging,{recursive:true,force:true});if(this.state!=='ready')await this.engine?.unload();}
  });}
  async deleteProfile(id:string){if(this.busy)throw new IndexError('BUSY');const profile=this.profiles().find(p=>p.id===id);if(!profile)throw new IndexError('PROFILE_MISSING');await this.stop();this.store.set('indextts.voices',this.profiles().filter(p=>p.id!==id));await rm(dirname(profile.reference),{recursive:true,force:true});this.changed();return true;}
  previewText(profileId:string){const profile=this.profiles().find(p=>p.id===profileId);if(!profile)throw new IndexError('PROFILE_MISSING');return previewSamples[profile.language]||previewSamples.en;}
  async play(text:string,signal:AbortSignal,tuning:{pitch:number;volume:number},overrides:{profileId?:string;language?:string;emotion?:Emotion;durationFactor?:number}={},onAudio=()=>{}){
    return this.exclusive(async()=>{
      const config=this.getConfig(),profile=this.profiles().find(p=>p.id===(overrides.profileId||config.profileId));
      if(!profile||profile.version!==config.version)throw new IndexError('PROFILE_MISSING');
      const emotion=validateEmotion(overrides.emotion||profile.emotion),language=overrides.language||profile.language;
      const durationFactor=overrides.durationFactor??profile.durationFactor;
      if(!Number.isFinite(durationFactor)||durationFactor<.5||durationFactor>2||config.version==='2'&&durationFactor!==1)throw new IndexError('INVALID_DURATION');
      const controller=this.active=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      const id=this.generation=randomUUID();
      try{
        this.update('loading','Preparing the selected voice…');
        const caps=this.caps=await this.worker().load(config,{textEmotion:['synthesis-text','text-description'].includes(emotion.source),signal:combined});
        if(combined.aborted||this.generation!==id)throw new IndexError('CANCELLED');
        if(!caps.languages.includes(language))throw new IndexError('UNSUPPORTED_LANGUAGE');
        this.update('ready',caps.device==='cpu'?'Speaking on CPU · synthesis may be slow.':'Chunk-level pipelining · speaking.');
        const chunks=indexChunks(text,caps.lowVram?Math.min(config.chunkChars,40):config.chunkChars);
        const request={generationId:id,chunks,language,reference:profile.reference,emotion:{...emotion,reference:profile.emotionReference},durationFactor};
        await this.playChunks(this.worker().synthesize(request,combined),caps.sampleRate,combined,tuning,id,onAudio);
      }finally{this.active=undefined;}
    });
  }
  private async playChunks(chunks:AsyncIterable<{generationId:string;pcm:Buffer}>,sampleRate:number,signal:AbortSignal,tuning:{pitch:number;volume:number},id:string,onAudio:()=>void){
    const format=['-t','raw','-e','signed-integer','-b','16','-L','-c','1'];
    const filter=spawn(this.env.CERE_SOX_BIN||'sox',['-q','-D',...format,'-r',String(sampleRate),'-',...format,'-r','48000','-','rate','48000',...(tuning.pitch?['pitch',String(tuning.pitch*100)]:[]),'vol',String(tuning.volume)],{env:this.env,stdio:['pipe','pipe','ignore']});
    const player=spawn(this.env.CERE_APLAY_BIN||'aplay',['-q','-t','raw','-r','48000','-f','S16_LE','-c','1'],{env:this.env,stdio:['pipe','ignore','ignore']});
    let failure:IndexError|undefined,started=false;
    const terminate=()=>{filter.kill('SIGKILL');player.kill('SIGKILL');};
    const fail=()=>{failure=new IndexError('PLAYBACK_FAILED');terminate();};
    filter.stdin.on('error',fail);player.stdin.on('error',fail);filter.stdout.pipe(player.stdin);
    const exits=[filter,player].map(p=>new Promise<void>(done=>{p.on('error',fail);p.once('close',code=>{if(code&&!signal.aborted)failure||=new IndexError('PLAYBACK_FAILED');done();});}));
    signal.addEventListener('abort',terminate,{once:true});
    const timeout=setTimeout(()=>{failure=new IndexError('TIMEOUT');terminate();},15*60*1000);timeout.unref();
    try{
      for await(const chunk of chunks){
        if(signal.aborted||id!==this.generation)throw new IndexError('CANCELLED');
        if(failure)throw failure;
        if(chunk.generationId!==id)continue;
        if(!started){started=true;onAudio();}
        if(!filter.stdin.write(chunk.pcm))await Promise.race([once(filter.stdin,'drain'),...exits]);
      }
      filter.stdin.end();await Promise.all(exits);if(failure)throw failure;if(signal.aborted)throw new IndexError('CANCELLED');
    }finally{clearTimeout(timeout);signal.removeEventListener('abort',terminate);terminate();await Promise.all(exits);}
  }
  async stop(){this.generation='';this.active?.abort();await this.engine?.unload();}
  async close(){this.disposed=true;await this.cancelDownload();await this.stop();}
}
