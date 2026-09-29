// Explicit live check: uses normal Ollama/CLI usage in a private temporary workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from '../broker/client.ts';

const model=process.argv[2],delegate=process.argv[3],delegationOnly=process.argv.includes('--delegate-only');
if(!model || (delegate&&!['codex','claude'].includes(delegate)))throw new Error('Usage: node tools/check-ollama.ts MODEL [codex|claude]');
const directory=await mkdtemp(join(tmpdir(),'cere-ollama-live-')),cwd=join(directory,'project');
await mkdir(cwd);process.env.CERE_STATE_DIR=join(directory,'state');process.env.CERE_RUNTIME_DIR=join(directory,'runtime');
const log=await import('node:fs').then(fs=>fs.openSync(join(directory,'broker.log'),'w',0o600));
const broker=spawn(process.execPath,['broker/main.ts'],{stdio:['ignore',log,log]});
const call=(method:string,params:any={})=>request(method,params,120000);
const delegationPrompt='Reply with CERE_DELEGATE_OK. Do not use tools.';
const report:any={model,delegate:delegate||null,directory,checks:[]};
async function wait(id:string){
  let approvals=0;
  for(let n=0;n<900;n++){
    const state=await call('state');
    for(const approval of state.approvals){
      const script=approval.sessionId===id&&approval.kind==='desktop'&&approval.title==='Run saved script'&&JSON.parse(approval.detail).id==='ollama-smoke';
      const delegation=approval.sessionId===id&&approval.kind==='provider'&&approval.title===`Send this task to ${delegate==='codex'?'Codex':'Claude'}?`&&approval.detail.endsWith(delegationPrompt);
      await call('approval.answer',{id:approval.id,choice:script||delegation?'allow':'deny'});
      if(!script&&!delegation)throw new Error('Unexpected approval during live check: '+approval.title);
      approvals++;
    }
    const session=state.sessions.find((s:any)=>s.id===id);
    if(!['starting','working','waiting','stopping'].includes(session.status)){
      assert.equal(session.status,'idle',session.error);
      return {session,approvals,messages:await call('session.messages',{id})};
    }
    await delay(200);
  }
  await call('session.stop',{id});throw new Error('Live Ollama turn timed out');
}
try{
  for(let n=0;n<100;n++){try{await call('state');break;}catch{await delay(100);}}
  const models=await call('provider.models',{provider:'ollama'});assert.ok(models.some((m:any)=>m.id===model),'Requested model is unavailable');
  await call('settings.update',{ollama:{model},onboarding:false,categories:['scripts','providers'],scripts:[{id:'ollama-smoke',name:'Ollama live test',executable:'/usr/bin/printf',args:['CERE_OLLAMA_SCRIPT_OK'],cwd,timeout:10000}]});
  if(!delegationOnly){
  const chat=await call('session.create',{provider:'ollama',cwd});assert.equal(chat.model,model);
  await call('session.send',{id:chat.id,text:'Remember the exact marker CERE_MEMORY_67419 for our next turn. Reply with just that marker.'});
  const first=await wait(chat.id);assert.match(first.messages.at(-1).text,/CERE_MEMORY_67419/);
  await call('session.disconnect',{id:chat.id});
  await call('session.send',{id:chat.id,text:'What exact marker did I ask you to remember? Reply with just the marker.'});
  const resumed=await wait(chat.id);assert.match(resumed.messages.at(-1).text,/CERE_MEMORY_67419/);
  report.checks.push({name:'conversation and disconnect/resume',passed:true,sessionId:chat.id});console.log('PASS conversation and disconnect/resume');
  const assistant=await call('session.create',{provider:'ollama',cwd,tools:true,trusted:true});
  await call('session.send',{id:assistant.id,text:'Use script_run exactly once with id "ollama-smoke". It runs a saved harmless printf command. Report the actual returned output. Do not use any other tools.'});
  const script=await wait(assistant.id);assert.equal(script.approvals,1);assert.ok(script.messages.some((m:any)=>m.role==='tool'&&m.text.includes('CERE_OLLAMA_SCRIPT_OK')));assert.match(script.messages.at(-1).text,/CERE_OLLAMA_SCRIPT_OK/);
  report.checks.push({name:'approved saved CLI command',passed:true,sessionId:assistant.id});console.log('PASS approved saved CLI command');
  }
  if(delegate){
    await call('provider.models',{provider:delegate});
    const orchestrator=await call('session.create',{provider:'ollama',cwd,tools:true,trusted:true});
    await call('session.send',{id:orchestrator.id,text:`Call sessions_start with exactly these JSON arguments, preserving the entire prompt string: ${JSON.stringify({provider:delegate,prompt:delegationPrompt})}. After it returns, call sessions_wait for that session ID and report the exact returned marker. Do not change the delegated prompt and do not use any other tools.`});
    const result=await wait(orchestrator.id);assert.equal(result.approvals,1);assert.match(result.messages.at(-1).text,/CERE_DELEGATE_OK/);
    const child=(await call('state')).sessions.find((s:any)=>s.parentId===orchestrator.id);assert.equal(child.provider,delegate);assert.equal(child.status,'idle');
    report.checks.push({name:'live '+delegate+' delegation',passed:true,sessionId:orchestrator.id,childId:child.id});console.log('PASS live '+delegate+' delegation');
  }
}catch(error:any){report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{
  if(broker.exitCode===null&&broker.signalCode===null){const exited=new Promise<void>(resolve=>broker.once('exit',()=>resolve()));broker.kill('SIGTERM');await exited;}
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log('Evidence: '+directory);
}
