import { request } from './client.ts';
const command=process.argv[2]||'state';
try {
  const method=command==='tts-test'?'tts.test':command==='tts-stop'?'tts.stop':command==='remote'?'remote.'+(process.argv[3]||'status'):command==='toggle'?'ui.toggle':command==='show'?'ui.expand':command;
  if(command==='remote'&&!['remote.status','remote.off'].includes(method))throw new Error('Use cere remote status or cere remote off. Pairing stays in local Settings.');
  const value=await request(method,{});
  if(command==='state'||command==='remote'||method.startsWith('tts.'))console.log(JSON.stringify(value,null,2));
}catch(e:any){console.error(e.message);process.exitCode=1;}
