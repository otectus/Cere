import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IndexError, indexPaths, type IndexConfig, type IndexCapabilities } from './indextts-config.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export type AudioChunk={generationId:string;seq:number;sampleRate:number;pcm:Buffer};
export class IndexEngine {
  private worker?:ChildProcessWithoutNullStreams;
  private closed?:Promise<void>;
  private active?:{id:string;messages:any[];wake:()=>void;error?:IndexError};
  private tail:Promise<void>=Promise.resolve();
  private loaded='';
  private caps?:IndexCapabilities;
  private generation='';
  private idleTimer?:NodeJS.Timeout;
  config:IndexConfig;
  env:NodeJS.ProcessEnv;
  changed:()=>void;
  private launch?:{command:string;args:string[]};
  constructor(config:IndexConfig,changed=()=>{},env=process.env,launch?:{command:string;args:string[]}){this.config=config;this.env=env;this.changed=changed;this.launch=launch;}
  get pid(){return this.worker?.pid;}
  capabilities(){return this.caps;}
  private async start(){
    if(this.worker)return;
    if(this.closed)await this.closed;
    const paths=indexPaths(this.config,this.env), python=join(paths.runtimeDir,'source/.venv/bin/python');
    if(!this.launch)try{await access(python,constants.X_OK);await access(join(paths.modelDir,'installation.json'));}catch{throw new IndexError('MODEL_MISSING');}
    const child=spawn(this.launch?.command||python,this.launch?.args||['-B',join(root,'broker/indextts-worker.py')],{env:{...this.env,PYTHONUNBUFFERED:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},stdio:['pipe','pipe','pipe']});
    this.worker=child;child.stderr.resume();child.stdin.on('error',()=>{});
    let buffer='';child.stdout.setEncoding('utf8');
    const invalid=()=>{if(this.active){this.active.error=new IndexError('IPC_ERROR');this.active.wake();}void this.unload();};
    child.stdout.on('data',(part:string)=>{
      buffer+=part;if(buffer.length>2*1024*1024){invalid();return;}
      let end:number;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{
        const message=JSON.parse(line),active=this.active;
        if(!active||message.id!==active.id)continue;
        if(active.messages.length>8){invalid();return;}
        active.messages.push(message);active.wake();
      }catch{invalid();return;}}
    });
    child.on('error',()=>{if(this.active){this.active.error=new IndexError('RUNTIME_MISSING');this.active.wake();}});
    this.closed=new Promise<void>(done=>child.once('close',()=>{
      if(this.worker===child){this.worker=undefined;this.loaded='';this.caps=undefined;}
      if(this.active){this.active.error||=new IndexError('WORKER_CRASH');this.active.wake();}
      this.changed();done();
    }));
  }
  async *messages(op:string,payload:Record<string,unknown>={},signal?:AbortSignal):AsyncGenerator<any>{
    let release!:()=>void;const previous=this.tail;this.tail=new Promise<void>(r=>release=r);await previous;
    let timer:NodeJS.Timeout|undefined;
    const aborted=()=>{if(this.active){this.active.error=new IndexError('CANCELLED');this.active.wake();}void this.unload();};
    try{
      if(signal?.aborted)throw new IndexError('CANCELLED');
      await this.start();
      const active=this.active={id:randomUUID(),messages:[],wake:()=>{}} as NonNullable<IndexEngine['active']>;
      signal?.addEventListener('abort',aborted,{once:true});
      if(signal?.aborted){aborted();throw new IndexError('CANCELLED');}
      timer=setTimeout(()=>{active.error=new IndexError('TIMEOUT');active.wake();void this.unload();},15*60*1000);timer.unref();
      this.worker!.stdin.write(JSON.stringify({id:active.id,op,...payload})+'\n');
      for(;;){
        if(active.error&&!active.messages.length)throw active.error;
        if(!active.messages.length){await new Promise<void>(r=>active.wake=r);continue;}
        const message=active.messages.shift();
        if(message.event==='error')throw new IndexError(message.code);
        yield message;
        if(message.event==='done')break;
        if(message.event==='chunk')this.worker?.stdin.write(JSON.stringify({ack:active.id,seq:message.seq})+'\n');
      }
    }finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',aborted);this.active=undefined;release();}
  }
  async command(op:string,payload:Record<string,unknown>={},signal?:AbortSignal){let result:any;for await(const m of this.messages(op,payload,signal))result=m;return result;}
  async probe(signal?:AbortSignal){if(this.loaded&&this.caps)return this.caps;const result=await this.command('probe',{config:{...this.config,...indexPaths(this.config,this.env)}},signal);this.caps=result.capabilities;return this.caps!;}
  async load(config:IndexConfig=this.config,options:{textEmotion?:boolean;signal?:AbortSignal}={}){
    const {textEmotion=false,signal}=options;
    this.config=config;
    if(this.idleTimer)clearTimeout(this.idleTimer);
    const key=JSON.stringify({...this.config,textEmotion});
    if(this.loaded===key&&this.caps)return this.caps;
    if(this.loaded)await this.unload();
    const caps=await this.probe(signal);
    const device=this.config.device==='auto'?(caps.devices.find(d=>d.id.startsWith('cuda:'))||caps.devices[0]):caps.devices.find(d=>d.id===this.config.device);
    if(!device)throw new IndexError('UNSUPPORTED_HARDWARE');
    const precision=this.config.precision==='auto'?device.precisions[0]:this.config.precision;
    try{
      const result=await this.command('load',{config:{...this.config,...indexPaths(this.config,this.env),device:device.id,precision,textEmotion}},signal);
      this.loaded=key;this.caps=result.capabilities;this.armIdle();return this.caps!;
    }catch(error){await this.unload();throw error;}
  }
  private armIdle(){if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=setTimeout(()=>void this.unload(),this.config.idleMinutes*60000);this.idleTimer.unref();}
  async *synthesize(request:Record<string,any>,signal?:AbortSignal):AsyncGenerator<AudioChunk>{
    const id=request.generationId;this.generation=id;if(this.idleTimer)clearTimeout(this.idleTimer);
    let expected=0,finished=false;
    try{
      for await(const m of this.messages('synthesize',request,signal)){
        if(m.event!=='chunk')continue;
        if(this.generation!==id||m.generationId!==id||signal?.aborted)continue;
        if(m.seq!==expected++||!Number.isInteger(m.sampleRate)||m.sampleRate!==this.caps?.sampleRate||typeof m.pcm!=='string'||m.pcm.length>1024*1024)throw new IndexError('IPC_ERROR');
        const pcm=Buffer.from(m.pcm,'base64');if(!pcm.length||pcm.length%2)throw new IndexError('IPC_ERROR');
        yield {generationId:id,seq:m.seq,sampleRate:m.sampleRate,pcm};
      }
      if(!expected)throw new IndexError('INFERENCE_FAILED');
      finished=true;
    }catch(error){await this.unload();throw error;}finally{if(!finished)await this.unload();else this.armIdle();}
  }
  async cancel(generationId:string){if(this.generation!==generationId)return;this.generation='';await this.unload();}
  async unload(){
    if(this.idleTimer)clearTimeout(this.idleTimer);this.loaded='';this.generation='';
    const child=this.worker;if(!child){if(this.closed)await this.closed;return;}
    if(this.active){this.active.error||=new IndexError('CANCELLED');this.active.wake();}
    child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),250);timer.unref();
    await this.closed;clearTimeout(timer);
  }
}
