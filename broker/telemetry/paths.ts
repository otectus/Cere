import { realpath, lstat } from 'node:fs/promises';
import { dirname, basename, join, relative, isAbsolute } from 'node:path';
import { telemetryDefaults, type TelemetryConfig } from './protocol.ts';
export function ancestor(root:string,path:string) {const r=relative(root,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('../'));}
export function matchRoot(roots:string[],path:string) {return roots.filter(r=>ancestor(r,path)).sort((a,b)=>b.length-a.length)[0];}
export async function canonical(path:string):Promise<string> {
  try{return await realpath(path);}catch(error:any){
    if(error.code!=='ENOENT')throw new Error('PATH_UNAVAILABLE');
    // A dangling symlink is not a deleted ordinary path: never guess its target.
    try{if((await lstat(path)).isSymbolicLink())throw new Error('PATH_UNAVAILABLE');}catch(e:any){if(e.code!=='ENOENT')throw e;}
    const parent=dirname(path);if(parent===path)throw new Error('PATH_UNAVAILABLE');
    return join(await canonical(parent),basename(path));
  }
}
export async function configuration(value:unknown, prior:TelemetryConfig=telemetryDefaults):Promise<TelemetryConfig> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid telemetry settings');
  const p=value as Record<string,unknown>;
  if(Object.keys(p).some(k=>!['enabled','roots','ignores','commands','output'].includes(k)))throw new Error('Invalid telemetry setting');
  for(const k of ['enabled','commands','output'])if(k in p&&typeof p[k]!=='boolean')throw new Error('Invalid telemetry capture setting');
  for(const k of ['roots','ignores'])if(k in p&&(!Array.isArray(p[k])||(p[k] as unknown[]).length>64||(p[k] as unknown[]).some(v=>typeof v!=='string'||!v||v.length>4096||v.includes('\0'))))throw new Error('Invalid telemetry paths or patterns');
  const next={...prior,...p} as TelemetryConfig;
  try{next.roots=[...new Set(await Promise.all(next.roots.map(async p=>{const r=await realpath(p);if(!(await lstat(r)).isDirectory())throw 0;return r;})))];}catch{throw new Error('Telemetry workspace must be an existing directory');}
  return next;
}
