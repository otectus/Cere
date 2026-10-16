import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workflows } from '../broker/workflows.ts';
import type { Core } from '../broker/core.ts';
import type { Message, Session } from '../broker/types.ts';

const session = (id:string,cwd:string,patch:Partial<Session>={}):Session=>({
  id,cwd,provider:'codex',nativeId:null,title:id,mode:'managed',status:'idle',created:1,updated:1,
  draft:'',scroll:0,model:'',revision:'1',draftRevision:'0',configRevision:'1',turnId:'turn-1',...patch,
});

class FakeStore {
  meta=new Map<string,unknown>();sessionsById=new Map<string,Session>();messagesById=new Map<string,Message>();
  get<T>(key:string,fallback:T):T{return structuredClone((this.meta.has(key)?this.meta.get(key):fallback) as T)}
  set(key:string,value:unknown){this.meta.set(key,structuredClone(value))}
  session(id:string){const value=this.sessionsById.get(id);if(!value)throw new Error('Session no longer exists');return structuredClone(value)}
  sessions(){return [...this.sessionsById.values()].map(value=>structuredClone(value))}
  messageById(id:string){const value=this.messagesById.get(id);return value?structuredClone(value):undefined}
}

async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'cere-workflows-')),project=join(root,'project'),other=join(root,'other');await mkdir(project);await mkdir(other);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new FakeStore(),created:string[]=[],drafted:{id:string;text:string}[]=[];let changed=0;
  store.sessionsById.set('source',session('source',project));store.sessionsById.set('other',session('other',other));
  const core={store,changed(){changed++},async create(p:any){const id='created-'+(created.length+1),value=session(id,p.cwd,{provider:p.provider,model:p.model,effort:p.effort,configRevision:'1',turnId:undefined});store.sessionsById.set(id,value);created.push(id);return structuredClone(value)},draft(id:string,text:string){const value=store.sessionsById.get(id)!;value.draft=text;value.draftRevision=String(BigInt(value.draftRevision||'0')+1n);store.sessionsById.set(id,value);drafted.push({id,text});return structuredClone(value)},async stopTurn(){return true}} as unknown as Core;
  const workflows=new Workflows(core);t.after(()=>workflows.close());
  return {root,project,other,store,core,workflows,created,drafted,get changed(){return changed}};
}

test('capsules are CAS scoped to an exact project and resume only into a reviewed draft',async t=>{
  const f=await fixture(t),message:Message={id:'m1',sessionId:'source',role:'assistant',text:'Consider keeping the API stable.',time:10};f.store.messagesById.set(message.id,message);
  const empty:any=await f.workflows.dispatch('capsules.get',{sessionId:'source'});assert.equal(empty.revision,'0');assert.equal(empty.cwd,f.project);
  const saved:any=await f.workflows.dispatch('capsules.save',{sessionId:'source',expectedRevision:'0',goal:'Ship safely',decisions:['Keep compatibility'],constraints:['No release commands'],questions:['Which version?'],nextSteps:['Run focused tests'],relevantSessionIds:['source'],sources:[{messageId:'m1',sessionId:'source',sourceRole:'model-suggestion'}]});
  assert.equal(saved.revision,'1');assert.equal(saved.sources[0].text,message.text);
  await assert.rejects(f.workflows.dispatch('capsules.save',{sessionId:'source',expectedRevision:'0',goal:'stale',sources:[]}),/changed/);
  await assert.rejects(f.workflows.dispatch('capsules.save',{sessionId:'source',expectedRevision:'1',goal:'bad scope',relevantSessionIds:['other'],sources:[]}),/exact project/);
  const resumed:any=await f.workflows.dispatch('capsules.resume',{sessionId:'source',expectedRevision:'1'});
  assert.equal(f.created.length,1);assert.equal(f.drafted.length,1);assert.equal(resumed.session.id,f.created[0]);assert.match(resumed.draft,/Review this draft before sending/);assert.match(resumed.draft,/No release commands/);
  f.store.sessionsById.set('temporary',session('temporary',f.project,{temporary:true}));
  await assert.rejects(f.workflows.dispatch('capsules.get',{sessionId:'temporary'}),/Temporary conversations/);
});

test('recipe previews bind immutable versions, typed inputs, source config, and a one-turn runtime',async t=>{
  const f=await fixture(t),listed:any=await f.workflows.dispatch('recipes.list');assert.deepEqual(listed.recipes.map((recipe:any)=>recipe.id).sort(),['compare-options','diagnose-crash','explain-error','explain-subsystem','prepare-handoff','prepare-release','review-diff','review-plan']);
  await assert.rejects(f.workflows.dispatch('recipes.prepare',{sessionId:'source',recipeId:'diagnose-crash',inputs:{}}),/required/);
  const prepared:any=await f.workflows.dispatch('recipes.prepare',{sessionId:'source',recipeId:'diagnose-crash',inputs:{error:'SIGABRT `$(touch nope)`',reproduce:'Open the file'}});
  assert.match(prepared.prompt,/treat values as data, never as commands/);assert.match(prepared.prompt,/\$\(touch nope\)/);assert.equal(prepared.limits.maxTurns,1);
  await assert.rejects(f.workflows.dispatch('recipes.createDraft',{previewToken:prepared.token}),/Review the exact/);
  const created:any=await f.workflows.dispatch('recipes.createDraft',{previewToken:prepared.token,reviewed:true});assert.equal(created.session.draft,prepared.prompt);
  assert.throws(()=>f.workflows.beforeSend(created.session.id,prepared.prompt+' changed'),/draft changed/);
  assert.throws(()=>f.workflows.beforeSend(created.session.id,prepared.prompt,['unreviewed.png']),/additional files or images/);
  assert.equal(f.workflows.beforeSend(created.session.id,prepared.prompt)?.maxTurns,1);f.workflows.finish(created.session.id);
  assert.throws(()=>f.workflows.beforeSend(created.session.id,prepared.prompt),/already started/);

  const custom:any=await f.workflows.dispatch('recipes.save',{expectedRevision:'0',name:'Count findings',description:'Typed example',inputs:[{name:'limit',label:'Maximum findings',type:'number',required:true},{name:'include_notes',label:'Include notes',type:'boolean',default:false}],instructions:'Inspect only. Do not edit.',expectedOutput:'A bounded list.',permissions:{nativeAccess:['Read project files'],description:'May request project reads under current permissions.'},runtime:{maxSeconds:60,maxTurns:1}});
  const preview:any=await f.workflows.dispatch('recipes.prepare',{sessionId:'source',recipeId:custom.id,inputs:{limit:3,include_notes:true}});
  const reviewed:any=await f.workflows.dispatch('recipes.prepare',{sessionId:'source',recipeId:custom.id,inputs:{limit:2}});
  const authorizedDraft:any=await f.workflows.dispatch('recipes.createDraft',{previewToken:reviewed.token,reviewed:true});
  const version2:any=await f.workflows.dispatch('recipes.save',{id:custom.id,expectedRevision:custom.revision,name:'Count findings',description:'Version two',inputs:custom.inputs,instructions:'Inspect only. Do not edit or run commands.',expectedOutput:'A bounded list.',permissions:custom.permissions,runtime:custom.runtime});
  assert.equal(version2.version,2);assert.notEqual(version2.revision,custom.revision);
  assert.throws(()=>f.workflows.beforeSend(authorizedDraft.session.id,authorizedDraft.session.draft),/definition changed/);
  await assert.rejects(f.workflows.dispatch('recipes.createDraft',{previewToken:preview.token,reviewed:true}),/expired/);
  const versions:any=await f.workflows.dispatch('recipes.list');assert.equal(versions.versions.filter((recipe:any)=>recipe.id===custom.id).length,2);
  await assert.rejects(f.workflows.dispatch('recipes.save',{id:custom.id,expectedRevision:custom.revision,...version2}),/changed/);
});

test('results retain observed metadata and hydrate current message text without copying responses',async t=>{
  const f=await fixture(t),reply:Message={id:'reply',sessionId:'source',role:'assistant',text:'Sensitive provider response',time:20,turnId:'turn-1'};f.store.messagesById.set(reply.id,reply);
  f.workflows.observeAction('source','tests.run',{target:'focused'},{exitCode:0,outputPaths:[join(f.project,'report.xml')]});
  f.workflows.observeResult(f.store.session('source'),reply,'completed');
  let rows=(await f.workflows.dispatch('results.list',{sessionId:'source'})) as any[];assert.equal(rows.length,1);assert.equal(rows[0].providerOutcome,'completed');assert.equal(rows[0].verification,'not-run');assert.equal(rows[0].source.text,reply.text);assert.deepEqual(rows[0].artifacts,[join(f.project,'report.xml')]);
  const reviewed:any=await f.workflows.dispatch('results.reviewVerification',{sessionId:'source',name:'tests.run',label:'Focused tests',args:{target:'focused'},reviewed:true});
  f.workflows.observeAction('source','tests.run',{target:'focused'},{exitCode:0,verificationToken:reviewed.token});rows=(await f.workflows.dispatch('results.list',{sessionId:'source'})) as any[];assert.equal(rows[0].verification,'passed');assert.equal(rows[0].observed.at(-1).verification,'reviewed-check');
  assert.doesNotMatch(JSON.stringify(f.store.get('workflow:results',[])),/Sensitive provider response/);
  f.store.messagesById.set(reply.id,{...reply,text:'[Content removed by memory erasure]'});rows=(await f.workflows.dispatch('results.list',{sessionId:'source'})) as any[];assert.equal(rows[0].source.text,'[Content removed by memory erasure]');
  assert.throws(()=>f.workflows.observeAction('source','claimed.check',{}, {passed:true}),/Only broker-observed/);
  f.workflows.observeAction('source','tests.run',{target:'focused'},{exitCode:2,paths:[]});rows=(await f.workflows.dispatch('results.list',{sessionId:'source'})) as any[];assert.equal(rows[0].verification,'passed');
  const failed:any=await f.workflows.dispatch('results.reviewVerification',{sessionId:'source',name:'tests.run',label:'Focused tests',args:{target:'focused'},reviewed:true});f.workflows.observeAction('source','tests.run',{target:'focused'},{exitCode:2,verificationToken:failed.token});rows=(await f.workflows.dispatch('results.list',{sessionId:'source'})) as any[];assert.equal(rows[0].verification,'failed');
});

test('Q02 recipe starters are pinned one-turn definitions whose preview never creates or sends anything',async t=>{
  const f=await fixture(t);
  const listed:any=await f.workflows.dispatch('recipes.list',{});
  const ids=listed.recipes.map((recipe:any)=>recipe.id);
  for(const id of ['review-diff','diagnose-crash','prepare-release','explain-error','compare-options','review-plan','prepare-handoff','explain-subsystem'])assert.ok(ids.includes(id),id);
  assert.equal(new Set(ids).size,ids.length,'starter ids are unique');
  for(const id of ['compare-options','review-plan','prepare-handoff','explain-subsystem']){
    const recipe=listed.recipes.find((item:any)=>item.id===id);
    assert.equal(recipe.version,1);assert.equal(recipe.builtin,true);assert.equal(recipe.runtime.maxTurns,1);
    assert.ok(recipe.runtime.maxSeconds>=30&&recipe.runtime.maxSeconds<=600);
    assert.ok(recipe.permissions.description.length>0&&recipe.expectedOutput.length>0);
    assert.match(recipe.instructions,/Do not edit files/);
    assert.doesNotMatch(recipe.permissions.description,/grants? (?!no)[a-z]+ access/i,'a starter never claims to grant access');
  }
  // Preparing returns an exact preview only; no conversation, draft or provider work exists yet.
  const preview:any=await f.workflows.dispatch('recipes.prepare',{sessionId:'source',recipeId:'compare-options',inputs:{goal:'Cache web search results',options:'In-memory LRU\nSQLite table'}});
  assert.match(preview.prompt,/Pinned recipe: Compare implementation options \(version 1\)/);
  assert.match(preview.prompt,/"options":"In-memory LRU\\nSQLite table"/);
  assert.deepEqual(f.created,[]);assert.deepEqual(f.drafted,[]);
  await assert.rejects(f.workflows.dispatch('recipes.prepare',{sessionId:'source',recipeId:'explain-subsystem',inputs:{}}),/Subsystem, module or feature is required/);
  // A reviewed preview becomes a draft in a new conversation, which still has to be sent by the user.
  const draft:any=await f.workflows.dispatch('recipes.createDraft',{previewToken:preview.token,reviewed:true});
  assert.equal(draft.session.draft,preview.prompt);assert.equal(f.created.length,1);
  assert.equal(f.store.get<any>('workflow-run:'+draft.session.id,null).state,'draft');
});

test('M08 project tasks move only by explicit choices, and done needs observed evidence or a user decision',async t=>{
  const f=await fixture(t);
  f.store.messagesById.set('suggest',{id:'suggest',sessionId:'source',role:'assistant',text:'Next, add a regression test for draft continuity.',time:10});
  f.store.messagesById.set('asked',{id:'asked',sessionId:'source',role:'user',text:'Remember to profile the inspector.',time:11});
  const proposed:any=await f.workflows.dispatch('capsules.proposeTask',{sessionId:'source',messageId:'suggest'});
  let capsule=proposed.capsule,task=capsule.tasks.find((item:any)=>item.id===proposed.task);
  assert.deepEqual([task.state,task.origin,task.sources[0].sourceRole],['proposed','model-suggestion','model-suggestion']);
  assert.equal(task.sources[0].text,'Next, add a regression test for draft continuity.');
  assert.deepEqual(capsule.nextSteps,[],'a proposal is not yet a next step');
  const change=(patch:any)=>f.workflows.dispatch('capsules.task',{sessionId:'source',expectedRevision:capsule.revision,...patch});
  await assert.rejects(change({op:'transition',taskId:task.id,state:'done',completion:{kind:'user-decision',note:'x'}}),/A proposed task cannot become done/);
  await assert.rejects(f.workflows.dispatch('capsules.task',{sessionId:'source',expectedRevision:'0',op:'transition',taskId:task.id,state:'accepted'}),/capsule changed/);
  capsule=(await change({op:'transition',taskId:task.id,state:'accepted'}) as any).capsule;
  assert.deepEqual(capsule.nextSteps,['Next, add a regression test for draft continuity.']);
  task=capsule.tasks.find((item:any)=>item.id===task.id);assert.equal(task.revision,'2');
  await assert.rejects(change({op:'transition',taskId:task.id,state:'active',expectedTaskRevision:'1'}),/task changed/);
  capsule=(await change({op:'transition',taskId:task.id,state:'active'}) as any).capsule;
  await assert.rejects(change({op:'transition',taskId:task.id,state:'done'}),/needs a passing check or your decision/);
  // A result without a passing reviewed check cannot complete a task.
  f.workflows.observeAction('source','Provider-reported command',{command:'npm test'},{exitCode:0});
  const unreviewed=f.store.get<any[]>('workflow:results',[])[0];
  await assert.rejects(change({op:'transition',taskId:task.id,state:'done',completion:{kind:'observed-check',resultId:unreviewed.id}}),/Only a passing broker-observed check/);
  const review:any=await f.workflows.dispatch('results.reviewVerification',{sessionId:'source',name:'script.run',args:{id:'check'},label:'Unit tests',reviewed:true});
  f.workflows.observeAction('source','script.run',{id:'check'},{exitCode:0,verificationToken:review.token});
  const passed=f.store.get<any[]>('workflow:results',[]).find(row=>row.verification==='passed');
  capsule=(await change({op:'transition',taskId:task.id,state:'done',completion:{kind:'observed-check',resultId:passed.id}}) as any).capsule;
  task=capsule.tasks.find((item:any)=>item.id===task.id);
  assert.deepEqual([task.state,task.completion.kind,task.completion.verification],['done','observed-check','passed']);
  assert.deepEqual(capsule.nextSteps,[]);
  // The user's own decision completes a task when it carries a reason.
  const added:any=await change({op:'add',text:'Profile the graph inspector',sources:[{messageId:'asked',sessionId:'source',sourceRole:'observed'}],files:[f.project]});
  capsule=added.capsule;
  await assert.rejects(change({op:'transition',taskId:added.task,state:'done',completion:{kind:'user-decision',note:'  '}}),/Say why the task is done/);
  capsule=(await change({op:'transition',taskId:added.task,state:'done',completion:{kind:'user-decision',note:'Measured: 40 ms on a 100k store.'}}) as any).capsule;
  assert.equal(capsule.tasks.find((item:any)=>item.id===added.task).completion.note,'Measured: 40 ms on a 100k store.');
  // Linked files stay inside the project folder.
  await assert.rejects(change({op:'add',text:'Outside',files:[f.other]}),/inside this project folder/);
  await assert.rejects(change({op:'add',text:'Missing',files:[join(f.project,'missing.txt')]}),/no longer exists/);
  // A client that still edits next steps as lines can add tasks but never remove or reset one.
  const saved:any=await f.workflows.dispatch('capsules.save',{sessionId:'source',expectedRevision:capsule.revision,goal:'Ship',nextSteps:['Write release notes'],sources:[]});
  assert.equal(saved.tasks.length,3);assert.deepEqual(saved.nextSteps,['Write release notes']);
  assert.ok(saved.tasks.filter((item:any)=>item.state==='done').length===2,'saving never changes task state');
  // Resume drafts separate proposals from accepted work and cite how done tasks were completed.
  await f.workflows.dispatch('capsules.proposeTask',{sessionId:'source',messageId:'suggest',text:'Consider a fuzz test'});
  const resumed:any=await f.workflows.dispatch('capsules.resume',{sessionId:'source'});
  assert.match(resumed.draft,/Next steps:\n- Write release notes/);
  assert.match(resumed.draft,/Proposed and not yet accepted \(confirm with the user before acting\):\n- Consider a fuzz test/);
  assert.match(resumed.draft,/a reviewed check passed/);assert.match(resumed.draft,/the user decided: Measured: 40 ms/);
});

test('M08 older capsules keep their next steps as accepted tasks the user wrote',async t=>{
  const f=await fixture(t);
  f.store.set('capsule:'+f.project,{cwd:f.project,revision:'3',updated:5,goal:'Old goal',decisions:[],constraints:[],questions:[],nextSteps:['First','Second'],relevantSessionIds:[],sources:[]});
  const capsule:any=await f.workflows.dispatch('capsules.get',{sessionId:'source'});
  assert.deepEqual(capsule.tasks.map((task:any)=>[task.text,task.state,task.origin]),[['First','accepted','user'],['Second','accepted','user']]);
  assert.equal(capsule.tasks[0].id,(await f.workflows.dispatch('capsules.get',{sessionId:'source'}) as any).tasks[0].id,'synthesized ids are stable');
  const moved:any=await f.workflows.dispatch('capsules.task',{sessionId:'source',expectedRevision:'3',op:'transition',taskId:capsule.tasks[1].id,state:'active'});
  assert.deepEqual(moved.capsule.tasks.map((task:any)=>task.state),['accepted','active']);
});

test('M08 forgetting a source message removes the tasks taken from it and scrubs the rest',async t=>{
  const { Store } = await import('../broker/store.ts');
  const { eraseWorkingCopies } = await import('../broker/working-erasure.ts');
  const dir=await mkdtemp(join(tmpdir(),'cere-task-erasure-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new Store(dir);t.after(()=>store.close());
  const task=(id:string,text:string,state:string,messageId?:string)=>({id,text,state,origin:messageId?'model-suggestion':'user',sources:messageId?[{messageId,sessionId:'s',sourceRole:'model-suggestion'}]:[],files:[],revision:'1',created:1,updated:1});
  store.set('capsule:'+dir,{cwd:dir,revision:'4',updated:1,goal:'Goal',decisions:[],constraints:[],questions:[],nextSteps:['Keep this','Mention the tangerine code'],relevantSessionIds:[],sources:[],
    tasks:[task('a','Use the tangerine code from the reply','accepted','erased-message'),task('b','Keep this','accepted'),task('c','Mention the tangerine code','active')]});
  const matcher=Object.assign((text:string)=>text.includes('tangerine code'),{identifies:(id:unknown)=>id==='erased-message'});
  eraseWorkingCopies(store,{id:'s',cwd:dir,provider:'codex',draft:'',title:'t'} as any,matcher);
  const capsule=store.get<any>('capsule:'+dir,null);
  assert.deepEqual(capsule.tasks.map((item:any)=>[item.id,item.text,item.state]),[['b','Keep this','accepted'],['c','[Content removed by memory erasure]','active']]);
  assert.deepEqual(capsule.nextSteps,['Keep this','[Content removed by memory erasure]']);
  assert.doesNotMatch(JSON.stringify(capsule),/tangerine/);
});

test('M08 a utility-shelf task moves into the project tasks instead of being copied',async t=>{
  const f=await fixture(t);
  f.store.set('utilityEntries',[{id:'u1',kind:'task',title:'Rotate the API key',text:'before Monday',done:false,revision:'2',updated:1},{id:'u2',kind:'note',title:'A note',text:'',done:false,revision:'1',updated:1}]);
  await assert.rejects(f.workflows.dispatch('capsules.adoptUtilityTask',{sessionId:'source',entryId:'u1',expectedRevision:'1'}),/entry changed/);
  await assert.rejects(f.workflows.dispatch('capsules.adoptUtilityTask',{sessionId:'source',entryId:'u2',expectedRevision:'1'}),/no longer on the utility shelf/);
  const moved:any=await f.workflows.dispatch('capsules.adoptUtilityTask',{sessionId:'source',entryId:'u1',expectedRevision:'2'});
  assert.deepEqual(moved.capsule.tasks.map((task:any)=>[task.text,task.state,task.origin]),[['Rotate the API key — before Monday','accepted','user']]);
  assert.deepEqual(f.store.get<any[]>('utilityEntries',[]).map(entry=>entry.id),['u2'],'one task identity: the shelf entry is gone');
});

test('M17 output sections are checked as headings outside code and never rewrite the reply',async()=>{
  const { checkSections, contractFor, validSections } = await import('../broker/output-contracts.ts');
  const reply='## Findings\nA bug.\n\n**Open questions:** none\n\nNext steps: ship it\n```md\n# Verification\n```';
  assert.deepEqual(checkSections(reply,['Findings','Open questions','Next steps','Verification']).map(item=>item.present),[true,true,true,false],'a heading inside a code block does not count');
  assert.deepEqual(checkSections('# findings',['Findings'])[0].present,true,'case does not matter');
  // RC-03: numbered, qualified, listed, bold and bare headings all count; a prose mention is present but labelled.
  for (const line of ['## 1. Findings','## Findings and evidence','1. **Findings**','Findings','**Findings:**','## Findings','> ### Findings','- _Findings_','`Findings`: none','# findings_and_more'])
    assert.deepEqual(checkSections(line+'\nText.',['Findings'])[0],{name:'Findings',present:true,how:'heading'},line);
  assert.deepEqual(checkSections('### Risks (high level)\nNone.',['Risks'])[0].how,'heading');
  assert.deepEqual(checkSections('## Riskscore\nThe riskscore is 4.',['Risk'])[0],{name:'Risk',present:false},'Riskscore does not satisfy Risk');
  assert.deepEqual(checkSections('Below are the open questions we found.',['Open questions'])[0],{name:'Open questions',present:true,how:'mentioned'});
  assert.deepEqual(checkSections('```\n## Findings\n```\nnothing else',['Findings'])[0].present,false,'neither a heading nor a mention inside code counts');
  assert.equal(contractFor({id:'r',version:1,outputSections:['Findings','Open questions']},'## Findings\nWe list open questions later.')!.status,'met');
  assert.equal(validSections([]),undefined);
  assert.throws(()=>validSections(['# Bad']),/without # or \*/);
  assert.throws(()=>validSections(['A','a']),/different names/);
});

test('M17 required checks gate a result: only current, observed passes count; cancelled, failed, stale and newer turns do not',async t=>{
  const f=await fixture(t);
  const scripts:any[]=[{id:'unit',name:'Unit tests',command:'/usr/bin/true',args:[],cwd:f.project,timeout:60000},{id:'lint',name:'Lint',command:'/usr/bin/true',args:[],cwd:f.project,timeout:60000},{id:'elsewhere',name:'Other',command:'/usr/bin/true',args:[],cwd:f.other,timeout:60000}];
  let next:(signal:AbortSignal)=>Promise<any>=async()=>({exitCode:0});
  Object.assign(f.core as any,{settings:{scripts},sending:new Set(),action:async(_name:string,_args:any,_session:any,signal:AbortSignal)=>next(signal)});
  let capsule:any=await f.workflows.dispatch('capsules.get',{sessionId:'source'});
  await assert.rejects(f.workflows.dispatch('capsules.setRequiredChecks',{sessionId:'source',expectedRevision:capsule.revision,scriptIds:['elsewhere']}),/run in this project folder/);
  await assert.rejects(f.workflows.dispatch('capsules.setRequiredChecks',{sessionId:'source',expectedRevision:capsule.revision,scriptIds:['missing']}),/saved script/);
  capsule=await f.workflows.dispatch('capsules.setRequiredChecks',{sessionId:'source',expectedRevision:capsule.revision,scriptIds:['unit','lint']});
  capsule=await f.workflows.dispatch('capsules.save',{sessionId:'source',expectedRevision:capsule.revision,goal:'Ship',sources:[]});
  assert.deepEqual(capsule.requiredChecks.map((check:any)=>check.scriptId),['unit','lint'],'saving the capsule keeps its required checks');
  const task:any=await f.workflows.dispatch('capsules.task',{sessionId:'source',expectedRevision:capsule.revision,op:'add',text:'Fix the parser'});
  capsule=task.capsule;
  f.store.messagesById.set('reply',{id:'reply',sessionId:'source',role:'assistant',text:'Fixed.',time:20,turnId:'turn-1'} as any);
  const result:any=f.workflows.observeResult(f.store.session('source'),f.store.messageById('reply'),'completed');
  assert.deepEqual([result.gate,result.checklist.map((row:any)=>row.status)],['incomplete',['not-run','not-run']]);
  const run=(scriptId:string)=>f.workflows.dispatch('results.runVerification',{sessionId:'source',resultId:result.id,scriptId,expectedScript:scripts.find(script=>script.id===scriptId),reviewed:true});
  const view=async()=>((await f.workflows.dispatch('results.list',{sessionId:'source'})) as any[])[0];
  await run('unit');
  let current=await view();
  assert.equal(current.checklist[0].status,'passed');assert.ok(Number.isInteger(current.checklist[0].durationMs));
  assert.deepEqual([current.verification,current.gate],['passed','incomplete'],'one passing check is not the gate');
  const complete=()=>f.workflows.dispatch('capsules.task',{sessionId:'source',expectedRevision:capsule.revision,op:'transition',taskId:task.task,state:'done',completion:{kind:'observed-check',resultId:result.id}});
  await assert.rejects(complete(),/Every required check must pass/);
  // A cancelled run records no exit and replaces nothing with a pass.
  next=signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Script cancelled')),{once:true}));
  const cancelled=run('lint');await new Promise(resolve=>setTimeout(resolve,10));
  await f.workflows.dispatch('results.cancelVerification',{sessionId:'source'});
  await assert.rejects(cancelled,/cancelled/);
  assert.equal((await view()).checklist[1].status,'cancelled');
  next=async()=>{throw Object.assign(new Error('exit 1'),{observedExitCode:1})};
  await run('lint');current=await view();
  assert.deepEqual([current.checklist[1].status,current.checklist[1].exitCode,current.gate],['failed',1,'failed']);
  next=async()=>({exitCode:0});
  await run('lint');assert.equal((await view()).gate,'passed');
  capsule=(await complete() as any).capsule;
  assert.equal(capsule.tasks.find((item:any)=>item.id===task.task).state,'done');
  // Changing a check's definition makes its earlier pass stale.
  scripts[1]={...scripts[1],args:['--strict']};
  current=await view();assert.deepEqual([current.checklist[1].status,current.gate],['stale','incomplete']);
  // A newer turn is a new result: earlier checks do not satisfy it.
  const moved=f.store.sessionsById.get('source')!;moved.turnId='turn-2';f.store.sessionsById.set('source',moved);
  const newer:any=f.workflows.observeResult(f.store.session('source'),undefined,'completed');
  assert.deepEqual([newer.gate,newer.checklist.map((row:any)=>row.status)],['incomplete',['not-run','not-run']]);
});

test('M17 a recipe reply missing its sections is flagged on the result, and the reply stays as written',async t=>{
  const f=await fixture(t);
  const saved:any=await f.workflows.dispatch('recipes.save',{name:'Audit',description:'',inputs:[],instructions:'Audit the docs.',expectedOutput:'Findings and open questions.',outputSections:['Findings','Open questions'],permissions:{nativeAccess:[],description:'Reads only.'},runtime:{maxSeconds:60,maxTurns:1}});
  const plain:any=await f.workflows.dispatch('recipes.save',{name:'Plain',description:'',inputs:[],instructions:'Do it.',expectedOutput:'Anything.',permissions:{nativeAccess:[],description:'Reads only.'},runtime:{maxSeconds:60,maxTurns:1}});
  assert.equal(plain.outputSections,undefined,'a recipe without sections stores none');
  const preview:any=await f.workflows.dispatch('recipes.prepare',{sessionId:'source',recipeId:saved.id});
  assert.match(preview.prompt,/Use these section headings, in this order: Findings; Open questions\./);
  assert.doesNotMatch(((await f.workflows.dispatch('recipes.prepare',{sessionId:'source',recipeId:plain.id})) as any).prompt,/section headings/);
  const draft:any=await f.workflows.dispatch('recipes.createDraft',{previewToken:preview.token,reviewed:true});
  const id=draft.session.id;f.workflows.beforeSend(id,preview.prompt);
  const text='## Findings\nThe install guide is stale.';
  f.store.messagesById.set('answer',{id:'answer',sessionId:id,role:'assistant',text,time:30} as any);
  const result:any=f.workflows.observeResult(f.store.session(id),f.store.messageById('answer'),'completed');
  assert.deepEqual(result.contract,{definitionId:saved.id,version:1,sections:[{name:'Findings',present:true,how:'heading'},{name:'Open questions',present:false}],status:'missing'});
  assert.equal(f.store.messageById('answer')!.text,text);
  // The sections travel with the recipe and are part of its revision.
  const exported=f.workflows.exportRecipes([saved.id]);assert.deepEqual(exported[0].outputSections,['Findings','Open questions']);
  assert.notEqual(saved.revision,plain.revision);
});

test('RC-04 a passing check is out of date once files change after it, wherever the edit was observed',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-16T12:00:00Z')});
  const f=await fixture(t);
  const scripts:any[]=[{id:'unit',name:'Unit tests',command:'/usr/bin/true',args:[],cwd:f.project,timeout:60000}];
  const telemetry={config:{enabled:true,roots:[f.root]},paused:false};
  Object.assign(f.core as any,{settings:{scripts},sending:new Set(),action:async()=>({exitCode:0}),telemetry});
  let capsule:any=await f.workflows.dispatch('capsules.get',{sessionId:'source'});
  const task:any=await f.workflows.dispatch('capsules.task',{sessionId:'source',expectedRevision:capsule.revision,op:'add',text:'Fix the parser'});
  capsule=task.capsule;
  f.store.messagesById.set('reply',{id:'reply',sessionId:'source',role:'assistant',text:'Fixed.',time:20,turnId:'turn-1'} as any);
  const result:any=f.workflows.observeResult(f.store.session('source'),f.store.messageById('reply'),'completed');
  const run=()=>f.workflows.dispatch('results.runVerification',{sessionId:'source',resultId:result.id,scriptId:'unit',expectedScript:scripts[0],reviewed:true});
  const view=async()=>((await f.workflows.dispatch('results.list',{sessionId:'source'})) as any[])[0];
  const later=(ms=10_000)=>t.mock.timers.tick(ms),edit=(path:string,source:'telemetry'|'notes'='telemetry')=>f.workflows.observeEdit(join(f.project,path),Date.now(),source);
  // An edit, then a pass: the pass is current.
  edit('src/parser.ts');later();await run();
  let current=await view();
  assert.deepEqual([current.verification,current.editedSinceCheck,current.edits.observable],['passed',false,true]);
  // A pass, then an edit: out of date, and it cannot complete a task.
  later();edit('src/parser.ts');
  current=await view();
  assert.deepEqual([current.editedSinceCheck,current.edits.lastEditSource],[true,'telemetry']);
  const complete=()=>f.workflows.dispatch('capsules.task',{sessionId:'source',expectedRevision:capsule.revision,op:'transition',taskId:task.task,state:'done',completion:{kind:'observed-check',resultId:result.id}});
  await assert.rejects(complete(),/changed after that check passed/);
  // As a required check, the row says why, and the gate is not passed.
  capsule=await f.workflows.dispatch('capsules.setRequiredChecks',{sessionId:'source',expectedRevision:capsule.revision,scriptIds:['unit']});
  current=await view();
  assert.deepEqual([current.checklist[0].status,current.checklist[0].reason,current.gate],['stale','files changed after this check','incomplete']);
  // Running it again makes it current; an applied note edit in the project then makes it stale again.
  later();await run();
  assert.deepEqual([(await view()).checklist[0].status,(await view()).gate],['passed','passed']);
  later();edit('notes/todo.md','notes');
  current=await view();
  assert.deepEqual([current.checklist[0].status,current.edits.lastEditSource],['stale','notes']);
  // An edit just as the check ends is taken as its own late write.
  later();await run();edit('src/parser.ts');
  assert.equal((await view()).checklist[0].status,'passed');
  // The record survives a restart.
  later();edit('src/parser.ts');f.workflows.close();
  assert.equal(f.workflows.timers.size,0,'closing saves pending edits and leaves no timer to fire later');
  const restarted=new Workflows(f.core as any);t.after(()=>restarted.close());
  assert.equal(restarted.editEvidence(f.project).last?.at,Date.now());
  // Without telemetry on this folder, later edits are not observable, and the result says so.
  telemetry.config.roots=[f.other];
  assert.equal(restarted.editEvidence(f.project).observable,false);
  delete (f.core as any).telemetry;
  assert.equal(restarted.editEvidence(f.project).observable,false);
});
