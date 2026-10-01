import { Worker } from 'node:worker_threads';
import type { TelemetryConfig } from './protocol.ts';
export class TelemetryService {
  worker?:Worker;seq=0;epoch=0;paused=false;closed=false;pending=new Map<number,{resolve:(value:any)=>void;timer:NodeJS.Timeout}>();
  changed:()=>void;config?:TelemetryConfig;directory?:string;
  status:any={enabled:false,paused:false,listener:'stopped',watcher:'stopped',events:0,drops:0,invalid:0,hookWarning:false,lastError:'',cliInjection:'withheld: provider history is persistent'};
  constructor(changed:()=>void,directory?:string){this.changed=changed;this.directory=directory;}
  async configure(config:TelemetryConfig){
    if(JSON.stringify(config)===JSON.stringify(this.config))return;
    await this.stop();this.config=structuredClone(config);this.closed=false;this.status={...this.status,enabled:config.enabled,listener:'stopped',watcher:'stopped',lastError:''};
    if(!config.enabled){this.changed();return;}
    const worker=this.worker=new Worker(new URL('./worker.ts',import.meta.url),{workerData:{config,directory:this.directory,paused:this.paused}});
    worker.on('message',message=>{if(this.worker!==worker)return;if(message.status){this.status=message.status;this.changed();return;}const p=this.pending.get(message.id);if(p){clearTimeout(p.timer);this.pending.delete(message.id);p.resolve(message.error?undefined:message.value);}});
    const failed=()=>{if(this.worker!==worker)return;this.worker=undefined;this.status={...this.status,listener:'error',watcher:'degraded',lastError:'WORKER_UNAVAILABLE'};this.epoch++;for(const p of this.pending.values()){clearTimeout(p.timer);p.resolve(undefined);}this.pending.clear();this.changed();};
    worker.on('error',failed);worker.on('exit',failed);
  }
  call(method:string,args:Record<string,unknown>={}){const worker=this.worker;if(!worker||this.pending.size>=(['report','status'].includes(method)?12:16))return Promise.resolve(undefined);const id=++this.seq;return new Promise<any>(resolve=>{const timer=setTimeout(()=>{this.pending.delete(id);resolve(undefined);},['report','status'].includes(method)?1500:5000);this.pending.set(id,{resolve,timer});worker.postMessage({id,method,...args});});}
  async report(cwd:string){if(!this.config?.enabled||this.paused||this.closed)return '';const epoch=this.epoch;const value=await this.call('report',{cwd});return epoch===this.epoch&&!this.paused&&typeof value==='string'?value:'';}
  async pause(paused:boolean){this.epoch++;this.paused=paused;const result=await this.call('pause',{paused});this.status={...this.status,paused};this.changed();if(this.worker&&result!==true)throw new Error('Telemetry pause was not acknowledged');return true;}
  async clear(){this.epoch++;const result=await this.call('clear');this.changed();if(this.worker&&result!==true)throw new Error('Telemetry clear was not acknowledged');return true;}
  async stop(){this.epoch++;const worker=this.worker;if(worker){await this.call('close');this.worker=undefined;await worker.terminate();}for(const p of this.pending.values()){clearTimeout(p.timer);p.resolve(undefined);}this.pending.clear();}
  async close(){this.closed=true;await this.stop();}
}
