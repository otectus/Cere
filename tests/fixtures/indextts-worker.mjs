import readline from 'node:readline';
import { copyFileSync } from 'node:fs';
const lines=readline.createInterface({input:process.stdin});
let current,frames=[];
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const caps=version=>({version,languages:version==='2'?['zh','en']:['zh','en','ja','es','ar'],sampleRate:22050,durationControl:version!=='2',devices:[{id:'cpu',label:'CPU',precisions:['fp32']}],emotionModes:['same-as-speaker','reference-audio','vector'],emotionInstalled:false,emotionBytes:0,cudaKernel:false,deepspeed:false,streaming:true,streamingGranularity:'segment',tokenStreaming:false});
function next(){if(frames.length)send(frames.shift());else{send({id:current.id,event:'done'});current=undefined;}}
lines.on('line',line=>{
  const request=JSON.parse(line);
  if(request.ack){next();return;}
  if(request.op==='probe'||request.op==='load'){send({id:request.id,event:'done',capabilities:caps(request.config.version)});return;}
  if(request.op==='validate'){copyFileSync(request.source,request.target);send({id:request.id,event:'done',sampleRate:request.sampleRate,duration:4});return;}
  if(request.op==='synthesize'){
    current=request;
    if(request.mode==='hold'||process.env.CERE_FAKE_INDEX_HOLD==='1'){process.on('SIGTERM',()=>{});return;}
    if(request.mode==='crash'){process.exit(1);return;}
    if(request.mode==='oom'){send({id:request.id,event:'error',code:'OUT_OF_MEMORY'});process.exit(2);return;}
    if(request.mode==='invalid'){process.stdout.write('not json\n');return;}
    frames=[0,1,2].map(seq=>({id:request.id,event:'chunk',generationId:request.generationId,seq,sampleRate:22050,pcm:Buffer.alloc(440,seq+1).toString('base64')}));
    if(request.mode==='out-of-order')frames[0].seq=2;
    if(request.mode==='stale')frames.unshift({...frames[0],generationId:'old'});
    next();return;
  }
  send({id:request.id,event:'done'});
});
