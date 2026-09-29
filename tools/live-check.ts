import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from '../broker/client.ts';
const root=process.env.CERE_STATE_DIR || '/tmp/cere-live-check';
const cwd=join(root,'project');await mkdir(cwd,{recursive:true});
const broker=spawn(process.execPath,['broker/main.ts'],{stdio:['ignore','ignore','inherit']});
async function call(method:string,params:any={}){return request(method,params,120000)}
async function wait(id:string){
  const until=Date.now()+120000;let approvals=0;
  while(Date.now()<until){
    const state=await call('state');
    for(const a of state.approvals.filter((a:any)=>a.sessionId===id)){
      console.log(JSON.stringify({approval:a.kind,title:a.title,detail:a.detail,questions:a.questions}));
      if(a.kind==='desktop'&&a.title==='Run saved script'){approvals++;await call('approval.answer',{id:a.id,choice:'allow'});}
      else if(a.kind==='provider'&&(/smoke/.test(a.detail)||(a.title==='MCP · cere'&&a.detail==='Allow the cere MCP server to run tool "script_run"?'))){await call('approval.answer',{id:a.id,choice:'allow'});}
      else if(a.kind==='question'&&JSON.stringify(a.questions).includes('smoke')){
        const answers:any={};for(const q of a.questions)answers[q.id]={answers:[q.options.find((o:any)=>/accept|allow|approve/i.test(o.label))?.label||'Accept']};
        await call('approval.answer',{id:a.id,choice:'answer',answers});
      }
      else await call('approval.answer',{id:a.id,choice:'deny'});
    }
    const s=state.sessions.find((s:any)=>s.id===id);
    if(!['starting','working','waiting','stopping'].includes(s.status))return{status:s.status,error:s.error,approvals};
    await delay(300);
  }
  await call('session.stop',{id});throw new Error('Turn timed out');
}
try{
  for(let n=0;n<50;n++){try{await call('state');break}catch{await delay(100)}}
  await call('settings.update',{onboarding:false,categories:['timers','scripts'],scripts:[{id:'smoke',name:'Integration test',executable:'/usr/bin/printf',args:['CERE_APPROVED'],cwd,timeout:10000}]});
  for(const provider of ['codex','claude']){
    const s=await call('session.create',{provider,cwd,trusted:true,title:provider+' integration check'});
    await call('session.send',{id:s.id,text:'Integration test. Use ONLY the Cere MCP tool script_run with id "smoke" (it runs printf to print CERE_APPROVED). Request user approval through Cere if needed. Do not use Bash or other tools. Then report its output.'});
    const first=await wait(s.id);
    await call('session.send',{id:s.id,text:'Without using any tools, repeat the exact string returned by the script in the previous turn.'});
    const second=await wait(s.id);
    await call('session.disconnect',{id:s.id});
    await call('session.send',{id:s.id,text:'This process was disconnected and resumed. Without using tools, repeat the exact script output from this conversation.'});
    const resumed=await wait(s.id);
    const messages=await call('session.messages',{id:s.id});
    console.log(JSON.stringify({provider,first,second,resumed,replies:messages.filter((m:any)=>m.role==='assistant').map((m:any)=>m.text),tools:messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.text.slice(0,150))}));
    if(first.status!=='idle'||first.approvals<1||second.status!=='idle'||resumed.status!=='idle')process.exitCode=1;
  }
}finally{broker.kill('SIGTERM');await new Promise<void>(r=>broker.once('exit',()=>r()));}
