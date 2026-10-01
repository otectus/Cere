import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type EmotionSource = 'same-as-speaker'|'reference-audio'|'vector'|'synthesis-text'|'text-description';
export type Emotion = {source:EmotionSource;alpha:number;random:boolean;vector:number[];text:string};
export type IndexConfig = {version:'2.5'|'2';modelDir:string;runtimeDir:string;device:string;precision:'auto'|'fp32'|'bf16'|'fp16';cudaKernel:boolean;deepspeed:boolean;idleMinutes:number;chunkChars:number;profileId:string};
export type VoiceProfile = {id:string;name:string;language:string;version:'2.5'|'2';created:number;updated:number;reference:string;original:string;emotionReference?:string;emotionOriginal?:string;emotion:Emotion;durationFactor:number};
export type IndexCapabilities = {version:string;languages:string[];sampleRate:number;durationControl:boolean;devices:{id:string;label:string;precisions:string[];memory?:number}[];emotionModes:EmotionSource[];emotionInstalled:boolean;emotionBytes:number;cudaKernel:boolean;deepspeed:boolean;streaming:boolean;streamingGranularity:'segment';tokenStreaming:false;lowVram?:boolean;device?:string;precision?:string;textEmotionLoaded?:boolean;referenceDevice?:string};
export const defaultIndexConfig:IndexConfig = {version:'2.5',modelDir:'',runtimeDir:'',device:'auto',precision:'auto',cudaKernel:false,deepspeed:false,idleMinutes:10,chunkChars:160,profileId:''};
export const defaultEmotion:Emotion = {source:'same-as-speaker',alpha:1,random:false,vector:[0,0,0,0,0,0,0,0],text:''};
export const indexCommit = 'd9e41aac89fd00b3d71497fddb287b7f24613712';
export function indexPaths(config:IndexConfig,env:NodeJS.ProcessEnv=process.env) {
  const data=join(env.XDG_DATA_HOME||join(homedir(),'.local/share'),'cere');
  return {modelDir:config.modelDir||join(data,'models/indextts',config.version),runtimeDir:config.runtimeDir||join(data,'runtimes/indextts',indexCommit),voices:join(data,'voices/indextts')};
}
export const indexErrors:Record<string,[string,string]> = {
  CANCELLED:['Speech stopped.','Start a new preview or reply.'], BUSY:['IndexTTS is busy.','Wait for the current operation or stop it.'],
  UV_MISSING:['uv is not installed.','Install uv and retry the download.'], RUNTIME_MISSING:['The IndexTTS runtime is missing.','Install or repair IndexTTS.'],
  MODEL_MISSING:['IndexTTS model files are missing.','Download the selected model or verify its installation.'], MODEL_NOT_LOADED:['IndexTTS is not loaded.','Load the selected model.'],
  DEPENDENCY_MISSING:['An IndexTTS dependency is missing.','Repair the runtime; install the experimental extra before enabling DeepSpeed.'],
  DEPENDENCY_MISMATCH:['The runtime does not match the pinned versions.','Repair the IndexTTS runtime.'],
  DEPENDENCY_INSTALL_FAILED:['Could not install the pinned Python dependencies.','Check disk space, uv and access to the package and CUDA wheel indexes; then retry.'],
  DOWNLOAD_FAILED:['The IndexTTS download failed.','Check your connection or HF_ENDPOINT mirror, then resume the download.'],
  CHECKSUM_MISMATCH:['IndexTTS installation verification failed.','Repair the installation to restore pinned files.'],
  DISK_SPACE:['Not enough disk space for IndexTTS.','Free space or choose another model directory.'], INVALID_PATH:['The model directory is invalid or not writable.','Choose an absolute directory you own.'],
  INVALID_ENDPOINT:['The model mirror URL is invalid.','Set HF_ENDPOINT to an HTTPS mirror.'], LICENSE_REQUIRED:['Review the model license before downloading.','Read the license notice and accept it to continue.'],
  UNSUPPORTED_HARDWARE:['The selected device or precision is unavailable.','Refresh devices and choose an available option.'], COMPILER_MISSING:['CUDA compilation tools are unavailable.','Disable CUDA kernels or install CUDA Toolkit 12.8+, a C++ compiler and Ninja.'],
  OUT_OF_MEMORY:['IndexTTS ran out of memory.','Use lower precision, shorter chunks, or disable text emotion. The worker has been unloaded.'],
  REFERENCE_MISSING:['A voice reference is required.','Add a reference recording to the voice profile.'], REFERENCE_DURATION:['Reference audio must be 3–15 seconds long.','Trim or replace the recording.'],
  REFERENCE_SILENCE:['The reference recording is silent or too quiet.','Use a clear recording of continuous speech.'], REFERENCE_CLIPPING:['The reference recording is clipped.','Use a clean recording with lower recording gain.'],
  REFERENCE_CORRUPT:['The reference recording cannot be decoded.','Choose a valid WAV, FLAC or OGG recording.'],
  PROFILE_MISSING:['No validated IndexTTS voice is selected.','Add a voice for the selected model and set it as default.'],
  INVALID_EMOTION:['The emotion settings are invalid.','Use eight values between 0 and 1, and provide the selected emotion source.'],
  EMOTION_MISSING:['Text emotion is not installed.','Download the optional Qwen emotion component.'],
  INVALID_DURATION:['This duration factor is unavailable.','Use 0.5–2.0 on IndexTTS-2.5; duration control is unavailable on IndexTTS-2.'],
  UNSUPPORTED_LANGUAGE:['The selected model does not support this language.','Choose a language listed for the loaded model.'],
  IPC_ERROR:['The speech worker returned an invalid response.','Unload and reload IndexTTS.'], WORKER_CRASH:['The speech worker exited unexpectedly.','Reload IndexTTS; reduce memory use if it happens again.'],
  TIMEOUT:['The speech operation timed out.','Try shorter text or use a faster device.'], INFERENCE_FAILED:['IndexTTS could not synthesize this request.','Check the reference and settings, then retry.'],
  NETWORK_DISABLED:['The offline worker attempted network access.','Verify or repair the installation; runtime downloads are disabled.'],
  PLAYBACK_FAILED:['Audio playback failed.','Check aplay, SoX and the system audio output.'], INVALID_CONFIG:['Invalid IndexTTS settings.','Check the selected values.'],
};
export class IndexError extends Error {
  code:string; recovery:string;
  constructor(code:string) {const safe=code in indexErrors?code:'INFERENCE_FAILED';super(indexErrors[safe][0]);this.code=safe;this.recovery=indexErrors[safe][1];}
}
export function indexError(error:unknown):IndexError {return error instanceof IndexError?error:new IndexError('INFERENCE_FAILED');}
export function validateIndexConfig(value:unknown, previous=defaultIndexConfig):IndexConfig {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!(k in defaultIndexConfig)))throw new IndexError('INVALID_CONFIG');
  const c={...previous,...value} as IndexConfig;
  if(!['2.5','2'].includes(c.version)||!['auto','fp32','bf16','fp16'].includes(c.precision)||!/^auto$|^cpu$|^cuda:\d+$/.test(c.device))throw new IndexError('INVALID_CONFIG');
  if(c.version==='2'&&c.precision==='bf16'||c.version==='2.5'&&c.precision==='fp16'||c.device==='cpu'&&!['auto','fp32'].includes(c.precision))throw new IndexError('UNSUPPORTED_HARDWARE');
  if(typeof c.cudaKernel!=='boolean'||typeof c.deepspeed!=='boolean'||!Number.isInteger(c.idleMinutes)||c.idleMinutes<1||c.idleMinutes>120||!Number.isInteger(c.chunkChars)||c.chunkChars<20||c.chunkChars>1000)throw new IndexError('INVALID_CONFIG');
  for(const p of [c.modelDir,c.runtimeDir])if(typeof p!=='string'||p.length>4096||p.includes('\0')||p&&!isAbsolute(p))throw new IndexError('INVALID_PATH');
  if(typeof c.profileId!=='string'||c.profileId.length>100)throw new IndexError('PROFILE_MISSING');
  return c;
}
export function validateEmotion(value:unknown):Emotion {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new IndexError('INVALID_EMOTION');
  const e={...defaultEmotion,...value} as Emotion;
  if(!('alpha' in value))e.alpha=['synthesis-text','text-description'].includes(e.source) ? .6 : 1;
  if(!['same-as-speaker','reference-audio','vector','synthesis-text','text-description'].includes(e.source)||!Number.isFinite(e.alpha)||e.alpha<0||e.alpha>1||typeof e.random!=='boolean'||typeof e.text!=='string'||e.text.length>2000||!Array.isArray(e.vector)||e.vector.length!==8||e.vector.some(x=>!Number.isFinite(x)||x<0||x>1)||e.source==='text-description'&&!e.text.trim())throw new IndexError('INVALID_EMOTION');
  return e;
}

/** Sentence-aware targets, treating pronunciation annotations as atomic units. */
export function indexChunks(text:string,limit=160):string[] {
  if(!Number.isInteger(limit)||limit<1)throw new IndexError('INVALID_CONFIG');
  const atoms=text.match(/<[^|>\n]+\|[^>\n]+>|[^]/gu)||[];
  const result:string[]=[];let current='';
  for(const atom of atoms){
    if(current.length+atom.length>limit&&current.trim()){
      let sentence=0,word=0,offset=0;
      for(const unit of current.match(/<[^|>\n]+\|[^>\n]+>|[^]/gu)||[]){
        offset+=unit.length;
        if(!unit.startsWith('<')&&/[。！？!?；;\n.؟]/u.test(unit))sentence=offset;
        if(/\s/u.test(unit)&&!unit.startsWith('<'))word=offset;
      }
      const cut=sentence||word||current.length;
      result.push(current.slice(0,cut).trim());current=current.slice(cut);
      if(current.length+atom.length>limit&&current.trim()){result.push(current.trim());current='';}
    }
    current+=atom;
  }
  if(current.trim())result.push(current.trim());
  return result.filter(Boolean);
}

export function indexPrefix(text:string,limit:number):string {
  for(const match of text.matchAll(/<[^|>\n]+\|[^>\n]+>/gu)){
    if(match.index<limit&&match.index+match[0].length>limit)return text.slice(0,match.index);
  }
  return text.slice(0,limit);
}

export const previewSamples:Record<string,string> = {
  en:"Hello, I'm Cere. Let's make something wonderful together.",zh:'你好，我是 Cere。让我们一起创造美好的事物。',ja:'こんにちは、Cereです。一緒に素敵なものを作りましょう。',es:'Hola, soy Cere. Vamos a crear algo maravilloso juntos.',ar:'مرحباً، أنا سيري. لنصنع شيئاً رائعاً معاً.',
};
