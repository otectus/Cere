import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { withHttpRetry, HttpStatusError, type RetryOptions } from './http-retry.ts';
import { indexChunks } from './indextts-config.ts';

export type ElevenConfig={voiceId:string;modelId:string;allowCloud:boolean};
export const defaultElevenConfig:ElevenConfig={voiceId:'',modelId:'eleven_flash_v2_5',allowCloud:false};
const validId=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);
export function validateElevenConfig(patch:any,current:ElevenConfig=defaultElevenConfig):ElevenConfig{
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['voiceId','modelId','allowCloud'].includes(k)))throw new ElevenError('CONFIG');
  const c={...current,...patch};if(typeof c.allowCloud!=='boolean'||c.voiceId!==''&&!validId(c.voiceId)||!validId(c.modelId))throw new ElevenError('CONFIG');return c;
}
const messages:Record<string,string>={
  CONFIG:'Choose valid ElevenLabs voice and model IDs.',KEY:'Add an ElevenLabs API key in Voice settings.',
  CLOUD:'Enable sending spoken text to ElevenLabs in Voice settings.',VOICE:'Select an ElevenLabs voice first.',
  AUTH:'ElevenLabs rejected the API key. Replace it in Voice settings.',FORBIDDEN:'ElevenLabs denied access. Check the key permissions and account plan.',
  QUOTA:'ElevenLabs credits are exhausted. Check your account usage or choose a local voice.',
  RATE_LIMIT:'ElevenLabs is busy or rate limited. Wait briefly and try again.',NOT_FOUND:'The ElevenLabs voice or model is unavailable. Refresh the catalog or check its ID.',
  REQUEST:'ElevenLabs rejected the speech request. Check the selected voice, model and account permissions.',
  NETWORK:'Could not reach ElevenLabs. Check your connection and try again.',SERVICE:'ElevenLabs is temporarily unavailable. Try again later.',
  STREAM:'The ElevenLabs audio stream ended incorrectly. It was not replayed.',
  PLAYBACK:'ElevenLabs playback failed. Check SoX, aplay and the audio device.',CATALOG:'Could not read the ElevenLabs catalog. Try refreshing it.',
};
export class ElevenError extends Error{code:string;constructor(code:string){super(messages[code]||messages.SERVICE);this.code='ELEVENLABS_'+code;}}
type Voice={id:string;name:string};type Model=Voice&{limit:number};
export class ElevenLabs{
  voices:Voice[]=[];models:Model[]=[];loading=false;error='';private catalog?:AbortController;
  private settings:()=>ElevenConfig;private key:()=>string;private changed:()=>void;
  private options:{fetch?:typeof fetch;env?:NodeJS.ProcessEnv;retry?:RetryOptions};
  constructor(settings:()=>ElevenConfig,key:()=>string,changed=()=>{},options:{fetch?:typeof fetch;env?:NodeJS.ProcessEnv;retry?:RetryOptions}={}){this.settings=settings;this.key=key;this.changed=changed;this.options=options;}
  snapshot(){return {voices:this.voices,models:this.models,loading:this.loading,error:this.error};}
  reset(){this.catalog?.abort();this.catalog=undefined;this.loading=false;this.voices=[];this.models=[];this.error='';this.changed();}
  private async request(path:string,signal:AbortSignal,body?:unknown){
    const key=this.key();if(!key)throw new ElevenError('KEY');
    try{return await withHttpRetry(async()=>{
      const response=await (this.options.fetch||fetch)('https://api.elevenlabs.io'+path,{method:body===undefined?'GET':'POST',headers:{'xi-api-key':key,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal,redirect:'error'});
      if(!response.ok){await response.body?.cancel();throw new HttpStatusError(response.status,'ElevenLabs request failed',response.headers.get('retry-after'));}return response;
    },{...this.options.retry,signal,label:'ElevenLabs'});}catch(e){signal.throwIfAborted();if(e instanceof ElevenError)throw e;
      if(e instanceof HttpStatusError)throw new ElevenError(e.status===401?'AUTH':e.status===402?'QUOTA':e.status===403?'FORBIDDEN':e.status===404?'NOT_FOUND':e.status===429?'RATE_LIMIT':e.status>=500?'SERVICE':'REQUEST');throw new ElevenError('NETWORK');}
  }
  private async json(path:string,signal:AbortSignal){
    const r=await this.request(path,signal);let bytes=0;const parts:Uint8Array[]=[];
    if(!r.body)throw new ElevenError('CATALOG');
    try{for await(const part of r.body as any){bytes+=part.length;if(bytes>4*1024*1024)throw new ElevenError('CATALOG');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString());}
    catch{throw new ElevenError('CATALOG');}
  }
  async refresh(){
    this.catalog?.abort();const controller=this.catalog=new AbortController();this.loading=true;this.error='';this.changed();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(60000)]);
    try{
      const voices:Voice[]=[];let token='';const seen=new Set<string>();
      for(let page=0;page<100;page++){
        const data=await this.json('/v2/voices?page_size=100&include_total_count=false'+(token?'&next_page_token='+encodeURIComponent(token):''),signal);
        if(!Array.isArray(data.voices))throw new ElevenError('CATALOG');
        for(const v of data.voices)if(validId(v.voice_id))voices.push({id:v.voice_id,name:String(v.name||v.voice_id).slice(0,120)});
        if(!data.has_more)break;
        if(typeof data.next_page_token!=='string'||data.next_page_token.length>4096||!data.next_page_token||seen.has(data.next_page_token)||page===99)throw new ElevenError('CATALOG');
        token=data.next_page_token;seen.add(token);
      }
      const data=await this.json('/v1/models',signal);if(!Array.isArray(data))throw new ElevenError('CATALOG');
      const models=data.filter(m=>m.can_do_text_to_speech&&validId(m.model_id)).map(m=>({id:m.model_id,name:String(m.name||m.model_id).slice(0,120),limit:Number.isInteger(m.maximum_text_length_per_request)&&m.maximum_text_length_per_request>0?m.maximum_text_length_per_request:1000}));
      signal.throwIfAborted();this.voices=[...new Map(voices.map(v=>[v.id,v])).values()];this.models=models;return this.snapshot();
    }catch(e){if(!controller.signal.aborted)this.error=e instanceof ElevenError?e.message:messages.CATALOG;throw new ElevenError(e instanceof ElevenError?e.code.replace('ELEVENLABS_',''):'CATALOG');}
    finally{if(this.catalog===controller){this.loading=false;this.catalog=undefined;this.changed();}}
  }
  async *audio(text:string,signal:AbortSignal):AsyncGenerator<Buffer>{
    const c=validateElevenConfig(this.settings());if(!c.allowCloud)throw new ElevenError('CLOUD');if(!c.voiceId)throw new ElevenError('VOICE');
    const limit=Math.min(1000,this.models.find(m=>m.id===c.modelId)?.limit||1000);
    for(const chunk of indexChunks(text,limit)){
      if(chunk.length>limit)throw new ElevenError('REQUEST');
      signal.throwIfAborted();const response=await this.request('/v1/text-to-speech/'+encodeURIComponent(c.voiceId)+'/stream?output_format=pcm_24000',signal,{text:chunk,model_id:c.modelId});
      if(!response.body||! /^(audio\/|application\/octet-stream)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new ElevenError('STREAM');}
      let pending=Buffer.alloc(0),bytes=0;
      try{for await(const part of response.body as any){signal.throwIfAborted();bytes+=part.length;if(bytes>64*1024*1024)throw new ElevenError('STREAM');const data=Buffer.concat([pending,part]);const end=data.length-data.length%2;pending=data.subarray(end);if(end)yield data.subarray(0,end);}if(!bytes||pending.length)throw new ElevenError('STREAM');}
      catch{signal.throwIfAborted();throw new ElevenError('STREAM');}
    }
  }
  async play(text:string,signal:AbortSignal,tuning:{rate:number;pitch:number;volume:number},onAudio:()=>void){
    const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(5*60*1000)]),env=this.options.env||process.env;
    combined.throwIfAborted();
    const format=['-t','raw','-e','signed-integer','-b','16','-L','-c','1','-r','24000'];
    const filter=spawn(env.CERE_SOX_BIN||'sox',['-q','-D',...format,'-',...format,'-',...(tuning.rate!==1?['tempo',String(tuning.rate)]:[]),...(tuning.pitch?['pitch',String(tuning.pitch*100)]:[]),'vol',String(tuning.volume)],{env,stdio:['pipe','pipe','ignore']});
    const player=spawn(env.CERE_APLAY_BIN||'aplay',['-q','-t','raw','-r','24000','-f','S16_LE','-c','1'],{env,stdio:['pipe','ignore','ignore']});
    const children=[filter,player];let failure:Error|undefined;
    const stop=()=>{for(const c of children)c.kill('SIGKILL');};
    const fail=()=>{failure||=new ElevenError('PLAYBACK');controller.abort();};
    const closed=children.map(child=>new Promise<void>(done=>{child.once('error',fail);child.once('close',code=>{if(code!==0&&!combined.aborted)fail();done();});}));
    combined.addEventListener('abort',stop,{once:true});if(combined.aborted)stop();
    let started=false;
    const meter=new Transform({transform(chunk,_encoding,done){if(!started){started=true;onAudio();}done(null,chunk);}});
    try{
      await Promise.all([pipeline(Readable.from(this.audio(text,combined)),filter.stdin,{signal:combined}),pipeline(filter.stdout,meter,player.stdin,{signal:combined})]);
      await Promise.all(closed);if(failure)throw failure;if(!started)throw new ElevenError('STREAM');
    }catch(e){controller.abort();await Promise.all(closed);signal.throwIfAborted();throw failure||(e instanceof ElevenError?e:new ElevenError('STREAM'));}
    finally{combined.removeEventListener('abort',stop);stop();await Promise.all(closed);}
  }
}
