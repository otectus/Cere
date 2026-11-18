import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request } from './client.ts';
import { cliBypassArgs } from './permissions.ts';
import type { Provider } from './types.ts';
const [provider,...args]=process.argv.slice(2);
if(!['codex','claude'].includes(provider)){console.error('Usage: cere terminal codex|claude [CLI arguments]');process.exit(2);}
let address='';
try{
  const clients=await request('windows.list');let pid=process.ppid;
  for(let depth=0;depth<12&&pid>1;depth++){
    const client=clients.find((c:any)=>c.pid===pid);if(client){address=client.address;break;}
    const status=await readFile(`/proc/${pid}/status`,'utf8');pid=Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]||0);
  }
}catch{}
let id='';
try{const session=await request('session.link',{provider,cwd:process.cwd(),pid:process.pid,address});id=session.id;}catch(e:any){console.error('Cere link unavailable: '+e.message);}
let bypass = false;
// Do not require a potentially projected full desktop snapshot merely to read
// the one policy bit that controls this terminal launch.
try {
  bypass = (await request('settings.inspect')).bypassCliPermissions === true;
} catch (error) {
  // A terminal can be upgraded while the previous broker is still running.
  if (error instanceof Error && error.message === 'Unknown Cere method: settings.inspect') {
    try { bypass = (await request('state')).settings?.bypassCliPermissions === true; } catch {}
  }
}
const child=spawn(provider,[...(bypass ? cliBypassArgs(provider as Provider) : []), ...args],{stdio:'inherit'});
child.on('error',e=>console.error(e.message));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
child.on('close',async code=>{if(id)await request('session.linkEnded',{id}).catch(()=>{});process.exitCode=code??1;});
