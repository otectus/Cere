import { request } from './client.ts';
const command=process.argv[2]||'state';
try {
  const value=await request(command==='toggle'?'ui.toggle':command==='show'?'ui.expand':command,{});
  if(command==='state')console.log(JSON.stringify(value,null,2));
}catch(e:any){console.error(e.message);process.exitCode=1;}
