/** Isolated broker streaming, concurrent-turn and memory-worker contention baseline. */
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
const directory=await mkdtemp(join(tmpdir(),'cere-companion-benchmark-'));
const core=new Core(new Store(directory),()=>({async send(){},async interrupt(){},async close(){}}));
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return{p50:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)],max:values.at(-1)}};
try{
 await core.memory.ready;
 const a=await core.create({provider:'codex',cwd:directory,trusted:true}),b=await core.create({provider:'claude',cwd:directory,trusted:true});
 for(let i=0;i<5000;i++)core.store.saveSession({...a,id:'history-'+i,updated:i});
 for(let i=0;i<10000;i++)core.store.message({id:'message-'+i,sessionId:a.id,role:i%2?'assistant':'user',text:'A prior turn '.repeat(120),time:i});
 await Promise.all([core.send({id:a.id,text:'A benchmark turn'}),core.send({id:b.id,text:'Another benchmark turn'})]);
 const observations=[] as Promise<unknown>[];for(let i=0;i<100;i++)observations.push(core.memory.service.call('observe_text',{scope_id:await core.memory.scope(a),role:'user',text:'Benchmark event '+i,session_id:a.id,source_event_id:'bench-'+i}));
 const cold=[] as number[],stream=[] as number[];let bytes=0;
 for(let i=0;i<100;i++){
  const start=performance.now();core.event(i%2?a.id:b.id,{type:'delta',id:'stream',text:'Additional streamed text. '});core.flush();stream.push(performance.now()-start);
  const snapshotStart=performance.now();core.updateSession(a.id,{updated:Date.now()});bytes=Buffer.byteLength(JSON.stringify(core.snapshot()));cold.push(performance.now()-snapshotStart);
 }
 await Promise.all(observations);
 core.stopDeadlineMs=20;core.forceCloseMs=20;const stopStart=performance.now();await core.stop(a.id);const stopMs=performance.now()-stopStart;
 console.log(JSON.stringify({kind:'isolated-broker-workloads',sessions:5002,messages:10000,concurrentTurns:2,memoryObservations:100,streamEventMs:summary(stream),snapshotAfterMutationMs:summary(cold),snapshotBytes:bytes,cancellationRequestMs:stopMs,limitations:'Mock providers and deterministic canonical writes. Does not measure rendering, model latency, real indexing servers or hardware accessibility.'},null,2));
}finally{await core.close();await rm(directory,{recursive:true,force:true});}
