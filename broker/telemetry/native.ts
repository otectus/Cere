import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export type FileEvent={wd:number;mask:number;cookie:number;name:string;at?:number;ts?:string;generation?:number};
export type LinuxNative={start(callback:(events:FileEvent[])=>void):unknown;add(handle:unknown,path:string):number;remove(handle:unknown,wd:number):void;stop(handle:unknown):void;lock(path:string):number;unlock(fd:number):void};
export function linuxNative():LinuxNative {
  const file=['../../native/cere-telemetry.node','../../build/cere-telemetry.node'].map(p=>fileURLToPath(new URL(p,import.meta.url))).find(existsSync);
  if(!file)throw new Error('NATIVE_HELPER_MISSING');return createRequire(import.meta.url)(file);
}
