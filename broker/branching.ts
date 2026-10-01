import type { Session } from './types.ts';
import { RpcProcess } from './wire.ts';
import { providerExecutable } from './providers.ts';
/** A genuine provider-owned history fork. Never falls back to copying selected text. */
export async function forkCodex(session:Session){
  if(session.provider!=='codex'||!session.nativeId||session.temporary||session.remote||['working','starting','waiting','stopping'].includes(session.status))throw new Error('A native fork needs an idle, saved, local Codex conversation with provider history');
  const process=new RpcProcess(providerExecutable('codex'),['app-server'],session.cwd);process.on('fault',()=>{});
  try{
    await process.request('initialize',{clientInfo:{name:'cere-fork',version:'0.1.0'},capabilities:{experimentalApi:true}});process.write({method:'initialized',params:{}});
    const result=await process.request('thread/fork',{threadId:session.nativeId,cwd:session.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'read-only'});
    const nativeId=result?.thread?.id;if(typeof nativeId!=='string'||!nativeId||nativeId===session.nativeId)throw new Error('The provider did not confirm a new native session');return nativeId;
  }finally{await process.close();}
}
