#!/usr/bin/env node
// Deterministic provider protocol fixture; never calls a model or executes a tool.
import { createInterface } from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-ui-fixture');process.exit(0)}
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const event = (method,params) => send({method,params});
let turn=0, pending=new Set(), decisions=[], actingTimers=[];
function complete() {
  event('item/completed',{item:{id:`reply-${turn}`,type:'agentMessage',text:decisions.length?'Decision: '+decisions.join(', '):'Only the reply belongs in chat.'}});
  event('turn/completed',{turn:{id:`turn-${turn}`,status:'completed'}});
}
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(!m.method){
    if(pending.delete(m.id)){decisions.push(m.result?.answers ? JSON.stringify(m.result.answers) : m.result?.decision||'decline');if(!pending.size)complete()}
    return;
  }
  const reply=result=>send({id:m.id,result});
  if(m.method==='initialize')reply({});
  if(m.method==='model/list')reply({data:[
    {id:'fixture-model',model:'fixture-model',displayName:'Fixture model',description:'UI test',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'},{reasoningEffort:'high',description:'High'}],defaultReasoningEffort:'high'},
    {id:'fixture-fast',model:'fixture-fast',displayName:'Fixture fast',description:'UI test',isDefault:false,supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'}],defaultReasoningEffort:'low'}
  ],nextCursor:null});
  if(m.method==='config/read')reply({config:{approval_policy:'on-request',sandbox_mode:'workspace-write'}});
  if(m.method==='thread/start'||m.method==='thread/resume')reply({thread:{id:'fixture-thread'},approvalPolicy:m.params.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[process.cwd()],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}});
  if(m.method==='turn/start'){
    for(const timer of actingTimers)clearTimeout(timer);actingTimers=[];
    turn++;decisions=[];pending.clear();reply({turn:{id:`turn-${turn}`}});
    event('turn/started',{turn:{id:`turn-${turn}`}});
    const prompt=m.params.input[0].text;
    if(prompt==='acting' || prompt==='acting-tender'){
      const tender=prompt==='acting-tender';
      actingTimers.push(setTimeout(()=>event('item/started',{item:{id:`tool-${turn}`,type:'commandExecution',command:'Fixture working state'}}),1400));
      actingTimers.push(setTimeout(()=>event('item/agentMessage/delta',{itemId:`reply-${turn}`,delta:tender?"I'm here. Take your time.":'You absolute menace. Let me explain.'}),2800));
      actingTimers.push(setTimeout(()=>event('turn/completed',{turn:{id:`turn-${turn}`,status:'completed'}}),5200));
    }else if(prompt==='acting-late-error'){
      actingTimers.push(setTimeout(()=>{
        event('turn/completed',{turn:{id:`turn-${turn}`,status:'completed'}});
        actingTimers.push(setTimeout(()=>event('error',{willRetry:false,error:{message:'Fixture adjacent connection fault'}}),100));
      },1400));
    }else if(prompt==='acting-error'){
      actingTimers.push(setTimeout(()=>event('turn/completed',{turn:{id:`turn-${turn}`,status:'failed',error:{message:'Fixture failure'}}}),1400));
    }else if(prompt==='questions'){
      const id=`question-${turn}`;pending.add(id);
      send({id,method:'item/tool/requestUserInput',params:{threadId:'fixture-thread',questions:[
        {id:'checks',header:'Checks',question:'Which checks should run?',multiSelect:true,options:[{label:'Build',description:'Compile the application'},{label:'Tests',description:'Exercise the user interface'}]},
        {id:'context',header:'Context',question:'What else should I know?',options:[]}
      ]}});
    }else if(prompt==='agents'){
      event('item/completed',{threadId:'fixture-thread',item:{id:`spawn-${turn}`,type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'fixture-thread',receiverThreadIds:['fixture-child'],prompt:'Inspect question handling',agentsStates:{'fixture-child':{status:'running'}}}});
      actingTimers.push(setTimeout(()=>{
        event('item/completed',{threadId:'fixture-thread',item:{id:`reply-${turn}`,type:'agentMessage',text:'The background review is still running.'}});
        event('turn/completed',{threadId:'fixture-thread',turn:{id:`turn-${turn}`,status:'completed'}});
      },500));
      actingTimers.push(setTimeout(()=>event('item/completed',{threadId:'fixture-child',item:{id:'child-reply',type:'agentMessage',text:'Reviewed the question UI.'}}),4000));
      actingTimers.push(setTimeout(()=>event('turn/completed',{threadId:'fixture-child',turn:{id:'child-turn',status:'completed'}}),8000));
    }else if(prompt.startsWith('completion-rich')){
      // UI review fixture: a long reply with fenced code, nested lists, a wide table, an image, long URLs and paths.
      const image=prompt.includes(':')?prompt.slice(prompt.indexOf(':')+1):'';
      const code=Array.from({length:60},(_,i)=>`export function reviewFixtureLine${i}(value: number): number { return value * ${i} + Math.round(Math.sqrt(${i} + 1)); } // trailing comment that widens the line`).join('\n');
      const table='| '+Array.from({length:12},(_,i)=>`Column ${i} heading`).join(' | ')+' |\n|'+' --- |'.repeat(12)+'\n'+Array.from({length:6},(_,r)=>'| '+Array.from({length:12},(_,c)=>`row ${r} cell ${c} with longer text`).join(' | ')+' |').join('\n');
      const lists=Array.from({length:4},(_,i)=>`- Level one item ${i}\n  - Level two item with a sentence that wraps across the available width of the message card.\n    - Level three item\n      1. Ordered inside unordered\n      2. Second ordered item`).join('\n');
      const text='# Review fixture: long reply\n\nThis reply exercises sustained reading in both surfaces.\n\n## Code\n\n```ts\n'+code+'\n```\n\n## Lists\n\n'+lists+'\n\n## Table\n\n'+table+'\n\n## Links and paths\n\nhttps://example.com/review/'+'segment-'.repeat(40)+'end\n\n/home/otectus/Projects/'+'very-long-directory-name/'.repeat(10)+'file.ts\n\n'+(image?'![Fixture image](file://'+image+')\n\n':'')+'Closing paragraph after the long content.';
      event('item/completed',{item:{id:`reply-${turn}`,type:'agentMessage',phase:'final_answer',text}});
      event('turn/completed',{turn:{id:`turn-${turn}`,status:'completed'}});
    }else if(prompt.startsWith('completion-')){
      event('item/completed',{item:{id:`comment-${turn}`,type:'agentMessage',phase:'commentary',text:'Still working.'}});
      event('item/completed',{item:{id:`tool-${turn}`,type:'commandExecution',aggregatedOutput:'A tool trace, not the final answer.'}});
      const text=prompt==='completion-long'?'# Final report\n\n'+('Completed work with a readable explanation.\n\n'.repeat(700)):'**'+prompt+' finished.**\n\nThe final reply belongs to this conversation.\n\n- Changes are ready.\n- Checks passed.';
      event('item/completed',{item:{id:`reply-${turn}`,type:'agentMessage',phase:'final_answer',text}});
      event('turn/completed',{turn:{id:`turn-${turn}`,status:'completed'}});
    }else if(prompt==='activity'){
      for(let i=0;i<3;i++){
        event('item/started',{item:{id:`tool-${turn}-${i}`,type:'commandExecution',command:'Test activity '+i}});
        event('item/completed',{item:{id:`tool-${turn}-${i}`,type:'commandExecution',aggregatedOutput:'Tool result '+i+'\n'+('Detailed output for scrolling.\n'.repeat(12))}});
      }
      complete();
    }else{
      for(let i=0;i<(prompt==='multiple'?2:1);i++){
        const id=`approval-${turn}-${i}`;pending.add(id);
        send({id,method:'item/commandExecution/requestApproval',params:{command:'printf test-'+i,cwd:process.cwd(),reason:'UI fixture permission request'}});
      }
    }
  }
  if(m.method==='turn/interrupt'){for(const timer of actingTimers)clearTimeout(timer);actingTimers=[];pending.clear();reply({});event('turn/completed',{turn:{id:`turn-${turn}`,status:'interrupted'}})}
});
