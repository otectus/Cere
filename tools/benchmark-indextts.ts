// Explicit local benchmark. No text, reference bytes or emotion descriptions in logs.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IndexEngine } from '../broker/indextts-engine.ts';
import { defaultIndexConfig, indexChunks } from '../broker/indextts-config.ts';

const reference=process.env.CERE_INDEXTTS_REFERENCE;
if(!reference)throw new Error('Set CERE_INDEXTTS_REFERENCE to a 3–15 second authorized recording.');
const directory=resolve(process.env.CERE_INDEXTTS_EVIDENCE||'/tmp/cere-indextts-evidence');await mkdir(directory,{recursive:true,mode:0o700});
const run=promisify(execFile);
async function memory(){try{return Number((await run('nvidia-smi',['--query-gpu=memory.used','--format=csv,noheader,nounits'])).stdout.trim().split('\n')[0]);}catch{return null;}}
const results:any[]=[];
async function record(row:any){results.push(row);await writeFile(join(directory,'measurements.json'),JSON.stringify(results,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(row));}
for(const precision of ['bf16','fp32'] as const){
  const engine=new IndexEngine({...defaultIndexConfig,device:'cuda:0',precision});
  const before=await memory(),start=performance.now();let peak=before||0;
  const timer=setInterval(()=>void memory().then(n=>peak=Math.max(peak,n||0)),100);timer.unref();
  try{
    const caps=await engine.load();await record({device:'cuda:0',precision,loadSeconds:(performance.now()-start)/1000,vramMiB:await memory(),peakVramMiB:peak});
    const input='Hello, I am Cere. Today we are testing a local voice that can speak clearly and naturally. I will read this short passage, pause between its sentences, and then finish with a warm goodbye. See you soon! '.padEnd(200,'.').slice(0,200);
    const began=performance.now();let bytes=0,first=0;
    for await(const chunk of engine.synthesize({generationId:'gpu-benchmark',chunks:indexChunks(input,caps.lowVram?40:160),language:'en',reference,emotion:{source:'same-as-speaker'},durationFactor:1})){
      if(!first)first=(performance.now()-began)/1000;bytes+=chunk.pcm.length;
    }
    const seconds=(performance.now()-began)/1000,duration=bytes/2/caps.sampleRate;
    await record({device:'cuda:0',precision,characters:input.length,firstAudioSeconds:first,synthesisSeconds:seconds,audioSeconds:duration,rtf:seconds/duration,sampleRate:caps.sampleRate,peakVramMiB:peak});
    const controller=new AbortController(),stream=engine.synthesize({generationId:'gpu-stop',chunks:[input],language:'en',reference,emotion:{source:'same-as-speaker'}},controller.signal);
    const pending=stream.next().catch(()=>null);await new Promise(r=>setTimeout(r,500));const stopped=performance.now();controller.abort();await pending;await stream.return(undefined);
    await record({device:'cuda:0',precision,stopSeconds:(performance.now()-stopped)/1000,workerExited:!engine.pid});
  }
  catch(error:any){await record({device:'cuda:0',precision,loadSeconds:(performance.now()-start)/1000,code:error.code,peakVramMiB:peak});}
  finally{clearInterval(timer);await engine.unload();await record({device:'cuda:0',precision,workerExited:!engine.pid,memoryAfterUnloadMiB:await memory(),baselineMiB:before});}
}
if(process.env.CERE_INDEXTTS_BENCHMARK_CPU!=='0'){
const engine=new IndexEngine({...defaultIndexConfig,device:'cpu',precision:'fp32'});
try{
  const start=performance.now(),caps=await engine.load();await record({device:'cpu',precision:'fp32',loadSeconds:(performance.now()-start)/1000,capabilities:caps});
  await record({offlineProbe:await engine.command('offline-test')});
  const text='Hello, I am Cere. Today we are testing a local voice that can speak clearly and naturally. I will read this short passage, pause between its sentences, and then finish with a warm goodbye. See you soon!';
  const input=(text+' ').padEnd(200,'.').slice(0,200);let bytes=0,first=0;
  const began=performance.now();
  for await(const chunk of engine.synthesize({generationId:'benchmark',chunks:indexChunks(input,160),language:'en',reference,emotion:{source:'same-as-speaker'},durationFactor:1})){
    if(!first)first=(performance.now()-began)/1000;bytes+=chunk.pcm.length;
  }
  const seconds=(performance.now()-began)/1000,duration=bytes/2/caps.sampleRate;
  await record({device:'cpu',characters:input.length,firstAudioSeconds:first,synthesisSeconds:seconds,audioSeconds:duration,rtf:seconds/duration,sampleRate:caps.sampleRate});
  const controller=new AbortController();
  const stopping=engine.synthesize({generationId:'stop',chunks:[input],language:'en',reference,emotion:{source:'same-as-speaker'}},controller.signal);
  const pending=stopping.next().catch(()=>null);await new Promise(r=>setTimeout(r,1000));const stopped=performance.now();controller.abort();await pending;await stopping.return(undefined);
  await record({stopSeconds:(performance.now()-stopped)/1000,workerExited:!engine.pid,memoryAfterUnloadMiB:await memory()});
}catch(error:any){await record({device:'cpu',code:error.code||'BENCHMARK_FAILED'});process.exitCode=1;}finally{await engine.unload();}
}
