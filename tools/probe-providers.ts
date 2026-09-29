import { Core } from '../broker/core.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const cwd=join(process.env.CERE_STATE_DIR || '/tmp/cere-provider-probe','project');
await mkdir(cwd,{recursive:true});
const core=new Core();
try{
  for(const provider of process.argv.slice(2).length?process.argv.slice(2):['codex','claude']){
    const session=await core.create({provider,cwd,trusted:true});
    let resolveDone:()=>void=()=>{};
    const finished=new Promise<void>(r=>resolveDone=r);
    const notice=(n:any)=>{if(n.sessionId===session.id&&['complete','error'].includes(n.kind))resolveDone();};
    core.on('notice',notice);
    const state=()=>{for(const a of core.snapshot().approvals)core.answer({id:a.id,choice:a.choices.includes('deny')?'deny':a.choices[0],answers:{}});};
    core.on('state',state);
    const timer=setTimeout(()=>{console.log(provider+': timeout');resolveDone()},90000);
    await core.send({id:session.id,text:'This is a desktop integration smoke test. Reply with exactly CERE_READY. Do not call tools or change any files.'});
    await finished;clearTimeout(timer);core.off('notice',notice);core.off('state',state);
    const s=core.store.session(session.id);console.log(JSON.stringify({provider,status:s.status,error:s.error,messages:core.store.messages(s.id).filter(m=>m.role==='assistant').map(m=>m.text)}));
    if(s.status==='working'||s.status==='starting')await core.stop(s.id);
  }
}finally{await core.close();}
