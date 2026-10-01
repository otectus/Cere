import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { TelemetryService } from '../broker/telemetry/service.ts';
import { telemetryDefaults } from '../broker/telemetry/protocol.ts';
const exec=promisify(execFile),sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const parent=await mkdtemp(join(tmpdir(),'cere-telemetry-load-')),root=join(parent,'project'),runtime=join(parent,'runtime');
const service=new TelemetryService(()=>{},runtime);
const git=(...args:string[])=>exec('git',['-c','core.hooksPath=/dev/null','-c','user.name=Telemetry Test','-c','user.email=telemetry@example.invalid',...args],{cwd:root,timeout:60000,maxBuffer:1024*1024});
async function files(value:string){for(let directory=0;directory<128;directory++){const path=join(root,'src',String(directory));await mkdir(path,{recursive:true});await Promise.all(Array.from({length:32},(_,n)=>writeFile(join(path,`${n}.txt`),value)));}}
try{
  await mkdir(root);await git('init','-b','first');await files('first');await git('add','.');await git('commit','-qm','first fixture');await git('checkout','-qb','second');await files('second');await git('commit','-qam','second fixture');
  await mkdir(join(root,'node_modules','excluded'),{recursive:true});
  await service.configure({...telemetryDefaults,enabled:true,roots:[root],commands:true});
  while(service.status.listener!=='listening'){if(service.status.lastError)throw new Error(service.status.lastError);await sleep(50);}
  const cpu=process.cpuUsage(),idleStart=performance.now();await sleep(5000);const usage=process.cpuUsage(cpu),idleSeconds=(performance.now()-idleStart)/1000;
  const idle={seconds:idleSeconds,cpuPercent:(usage.user+usage.system)/1e6/idleSeconds*100,rssMiB:process.memoryUsage().rss/1048576};
  const delay=monitorEventLoopDelay({resolution:10});delay.enable();const samples:number[]=[];const sampler=setInterval(()=>samples.push(process.memoryUsage().rss/1048576),100);const session=randomUUID();let sequence=0;
  const socket=net.createConnection(join(runtime,'telemetry.sock'));socket.on('data',()=>{});socket.on('error',()=>{});await new Promise<void>(r=>socket.once('connect',r));
  const flood=setInterval(()=>{for(let n=0;n<100;n++){const event={v:1,type:'command',session,seq:++sequence,pid:process.pid,hook_version:1,ts:new Date().toISOString(),cwd:root,status:0,cmd:'printf fixture'};if(!socket.destroyed&&socket.writableLength<1024*1024)socket.write(JSON.stringify(event)+'\n');}},10);
  const start=performance.now();for(let n=0;n<6;n++){await git('checkout','-q',n%2?'second':'first');await Promise.all(Array.from({length:1000},(_,i)=>writeFile(join(root,'node_modules','excluded',String(i)),'ignored')));}
  while(performance.now()-start<15000)await sleep(100);
  clearInterval(flood);socket.end();clearInterval(sampler);delay.disable();await sleep(1000);
  console.log(JSON.stringify({idle,sustained:{seconds:(performance.now()-start)/1000,sent:sequence,peakRssMiB:Math.max(...samples),endingRssMiB:process.memoryUsage().rss/1048576,eventLoopP99Ms:delay.percentile(99)/1e6,eventLoopMaxMs:delay.max/1e6,firstHalfPeakMiB:Math.max(...samples.slice(0,samples.length/2)),secondHalfPeakMiB:Math.max(...samples.slice(samples.length/2))},checkout:{files:4096,changes:6,ignoredWrites:6000},status:service.status},null,2));
}finally{await service.close();await rm(parent,{recursive:true,force:true});}
