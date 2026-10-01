import { parentPort, workerData } from 'node:worker_threads';
import { TelemetryState } from './state.ts';
import { Files } from './files.ts';
import { Listener, telemetryDirectory } from './listener.ts';
import { canonical, matchRoot } from './paths.ts';
import type { Event, TelemetryConfig } from './protocol.ts';
const port=parentPort!;let config=workerData.config as TelemetryConfig,paused=workerData.paused===true,closed=false;
const state=new TelemetryState(config);let files:Files|undefined,listener:Listener|undefined;
let queue:{event:Event;at:number;generation:number}[]=[],draining=false,drops=0,error='';
async function drain(){if(draining)return;draining=true;try{while(queue.length&&!closed){const item=queue.shift()!;if(!paused&&item.generation===state.generation)await state.ingest(item.event,item.at);}}finally{draining=false;}}
function clear(){state.clear();queue=[];files?.clear();listener?.discardBuffers();}
function status(){return{enabled:config.enabled,paused,listener:listener?.state||'stopped',watcher:files?.status||'stopped',events:listener?.events||0,drops:drops+(listener?.drops||0)+(files?.drops||0)+state.drops,invalid:listener?.invalid||0,hookWarning:listener?.outdated||false,lastError:error||listener?.lastError||files?.lastError||'',sessions:state.sessions.size,watches:files?.watches.size||0,pending:queue.length+(files?.pending.size||0),cliInjection:'withheld: provider history is persistent'};}
async function start(){
  try{listener=new Listener(workerData.directory||telemetryDirectory(),()=>({...config,enabled:config.enabled&&!paused}), (event,at)=>{if(paused||closed)return;if(queue.length>=256){queue.shift();drops++;}queue.push({event,at,generation:state.generation});void drain();});await listener.start();
    if(listener.state==='listening'&&!paused){files=new Files(state);await files.start();}
  }catch{error='TELEMETRY_UNAVAILABLE';}port.postMessage({status:status()});
}
let controls=Promise.resolve(),queuedControls=0;
port.on('message',message=>{
  // Fence samples immediately, even when a preceding filesystem operation is pending.
  if(message.method==='clear'||message.method==='pause'&&message.paused===true){if(message.method==='pause')paused=true;clear();}
  if(queuedControls>=16){port.postMessage({id:message.id,error:'TELEMETRY_BUSY'});return;}
  queuedControls++;controls=controls.then(async()=>{
  try{let value:unknown=true;
    if(message.method==='report'){
      value='';if(config.enabled&&!paused&&!closed&&listener?.state==='listening'){
        const generation=state.generation;const path=await canonical(message.cwd);const root=matchRoot(config.roots,path);
        if(root){const branch=state.branches.get(root);if(!branch||state.now()-branch.at>60_000)await files?.branch(root);if(generation===state.generation&&!paused)value=state.report(root);}
      }
    }else if(message.method==='pause'){paused=message.paused;clear();if(paused){files?.stop();files=undefined;}else if(listener?.state==='listening'){files=new Files(state);await files.start();}}
    else if(message.method==='clear')clear();
    else if(message.method==='status')value=status();
    else if(message.method==='close'){closed=true;clearInterval(timer);clear();files?.stop();await listener?.stop();}
    port.postMessage({id:message.id,value});if(closed)port.close();
  }catch{port.postMessage({id:message.id,error:'TELEMETRY_OPERATION_FAILED'});}finally{queuedControls--;}
});});
let refreshing=false;
const timer=setInterval(()=>{if(!paused&&!refreshing){refreshing=true;void state.refreshProcesses().finally(()=>refreshing=false);}port.postMessage({status:status()});},1000);timer.unref();
controls=start();await controls;
