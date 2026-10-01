import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { Session } from '../broker/types.ts';

async function setup(t: any, provider: Session['provider'] = 'codex') {
  const path = await mkdtemp(join(tmpdir(), 'cere-interactions-'));
  const core = new Core(new Store(path), () => ({async send(){},async interrupt(){},async close(){}}));
  const session: Session = {id:crypto.randomUUID(),provider,nativeId:'root',title:'Questions',cwd:path,mode:'managed',status:'working',created:Date.now(),updated:Date.now(),draft:'',scroll:0,model:''};
  core.store.saveSession(session);
  t.after(async () => {core.cancelApprovals(session.id);await core.close();await rm(path,{recursive:true,force:true});});
  return {core,session};
}
const agent = (core:Core, session:Session, id:string, status:string) => core.event(session.id,{type:'agent',id,data:{name:'Researcher',task:'Inspect the source',status}});

test('native agents keep the parent busy through root completion and child progress',async t => {
  const {core,session} = await setup(t), notices:any[]=[];core.on('notice',n=>notices.push(n));
  agent(core,session,'child','running');core.event(session.id,{type:'complete'});
  assert.equal(core.store.session(session.id).status,'working');assert.equal(core.store.session(session.id).activity,'waitingForAgents');
  assert.equal(notices.length,0);
  core.event(session.id,{type:'status',text:'idle'});
  assert.equal(core.store.session(session.id).status,'working');
  agent(core,session,'child','completed');
  assert.equal(core.store.session(session.id).status,'idle');assert.equal(notices.filter(n=>n.kind==='complete').length,1);
  assert.equal(core.store.messages(session.id).filter(m=>m.kind==='agent').length,1);
  agent(core,session,'child','running');assert.equal(core.store.session(session.id).status,'idle','late child events cannot resurrect a terminal turn');
});

test('progress cannot displace a pending question and parallel requests retain waiting',async t => {
  const {core,session}=await setup(t);
  const question={kind:'question',title:'Question',detail:'',choices:['answer'],questions:[{id:'q',question:'Which?',options:[{label:'First',description:'The first option'}]}]};
  const one=core.approval(session.id,question),two=core.approval(session.id,question);
  agent(core,session,'child','running');core.event(session.id,{type:'status',text:'working'});core.event(session.id,{type:'tool',id:'progress',text:'Still working'});
  assert.equal(core.store.session(session.id).status,'waiting');assert.equal(core.store.session(session.id).activity,undefined);
  const [a,b]=core.snapshot().approvals;
  core.answer({id:a.id,choice:'answer',answers:{q:{answers:['A custom answer']}}});await one;
  assert.equal(core.store.session(session.id).status,'waiting');
  core.answer({id:b.id,choice:'answer',answers:{q:{answers:['First']}}});await two;
  assert.equal(core.store.session(session.id).status,'working');
});

test('invalid, blank, duplicate and extra answers leave a form pending for correction',async t => {
  const {core,session}=await setup(t);
  const pending=core.approval(session.id,{kind:'question',title:'Choose',detail:'',choices:['answer'],questions:[{id:'one',question:'One',allowOther:false,options:[{label:'Yes'}]},{id:'many',question:'Many',multiSelect:true},{id:'optional',question:'Optional',required:false}]});
  const id=core.snapshot().approvals[0].id;
  for(const answers of [{one:{answers:[]},many:{answers:['A']}},{one:{answers:[' ']},many:{answers:['A']}},{one:{answers:['No']},many:{answers:['A']}},{one:{answers:['Yes','Yes']},many:{answers:['A']}},{one:{answers:['Yes']},many:{answers:['A','A']}},{one:{answers:['Yes']},many:{answers:['A']},extra:{answers:['x']}}]) {
    assert.throws(()=>core.answer({id,choice:'answer',answers}));assert.equal(core.approvals.size,1);
  }
  core.answer({id,choice:'answer',answers:{one:{answers:['Yes']},many:{answers:['A','B']}}});
  assert.deepEqual((await pending).answers.many.answers,['A','B']);
});

test('typed optional elicitation fields validate without inventing omitted answers',async t => {
  const {core,session}=await setup(t);
  const pending=core.approval(session.id,{kind:'question',title:'Form',detail:'',choices:['answer'],questions:[{id:'count',question:'Count'},{id:'optional',question:'Optional',required:false}],fields:{count:{type:'integer',minimum:1,maximum:3},optional:{type:'boolean'}}});
  const id=core.snapshot().approvals[0].id;
  for(const value of ['0','1.5','NaN',' '])assert.throws(()=>core.answer({id,choice:'answer',answers:{count:{answers:[value]}}}));
  core.answer({id,choice:'answer',answers:{count:{answers:['2']}}});const result=await pending;assert.equal(Object.hasOwn(result.answers,'optional'),false);
});

test('Claude AskUserQuestion round-trips multi-select and free text even under bypass',async t => {
  const {core,session}=await setup(t,'claude');core.updateSession(session.id,{status:'idle'});await core.power.start({sessionIds:[session.id],minutes:5,cli:true,computer:false});core.tokens.set('test-token',session.id);
  const questions=[{question:'Which checks?',header:'Checks',multiSelect:true,options:[{label:'Build',description:'Compile'},{label:'Tests',description:'Exercise behavior'}]},{question:'Additional context?',header:'Context',options:[]}];
  const pending=core.rpc('mcp.call',{token:'test-token',name:'approve',args:{tool_name:'AskUserQuestion',input:{questions}}});
  const request=core.snapshot().approvals[0];assert.equal(request.kind,'question');assert.equal(request.questions![0].multiSelect,true);
  core.answer({id:request.id,choice:'answer',answers:{'question-0':{answers:['Build','Tests']},'question-1':{answers:['Keep the existing work.\nThen validate.']}}});
  assert.deepEqual(await pending,{behavior:'allow',updatedInput:{questions,answers:{'Which checks?':'Build, Tests','Additional context?':'Keep the existing work.\nThen validate.'}}});
  const transcript=core.store.messages(session.id);assert.equal(transcript.filter(m=>m.kind==='question').length,1);assert.match(transcript.find(m=>m.kind==='answer')!.text,/Build, Tests/);
});

test('private answers are delivered but never recorded in transcript; denial stays a denial',async t=>{
  const {core,session}=await setup(t);
  const pending=core.approval(session.id,{kind:'question',title:'Private',detail:'',choices:['answer'],questions:[{id:'secret',question:'Secret?',isSecret:true}]});
  core.answer({id:core.snapshot().approvals[0].id,choice:'answer',answers:{secret:{answers:['sensitive-test-value']}}});
  assert.equal((await pending).answers.secret.answers[0],'sensitive-test-value');assert.ok(!JSON.stringify(core.store.messages(session.id)).includes('sensitive-test-value'));
  session.provider='claude';core.store.saveSession(session);core.tokens.set('test-token',session.id);
  const declined=core.rpc('mcp.call',{token:'test-token',name:'approve',args:{tool_name:'AskUserQuestion',input:{questions:[{question:'Proceed?',options:[]}]}}});
  core.answer({id:core.snapshot().approvals[0].id,choice:'deny'});assert.equal((await declined).behavior,'deny');
});

test('externally resolved requests are matched by child thread as well as request ID',async t=>{
  const {core,session}=await setup(t);
  const one=core.approval(session.id,{nativeRequestId:1,nativeThreadId:'one',kind:'question',title:'One',detail:'',choices:['answer']});
  const two=core.approval(session.id,{nativeRequestId:1,nativeThreadId:'two',kind:'question',title:'Two',detail:'',choices:['answer']});
  core.event(session.id,{type:'approvalResolved',data:{requestId:1,threadId:'one'}});
  assert.equal((await one).resolved,true);assert.equal(core.approvals.size,1);assert.equal(core.store.session(session.id).status,'waiting');
  core.cancelApprovals(session.id);assert.equal((await two).cancelled,true);
});

test('failure and restart end live child indicators without claiming child success',async t=>{
  const {core,session}=await setup(t);
  agent(core,session,'child','running');core.event(session.id,{type:'complete'});core.event(session.id,{type:'error',text:'Disconnected'});
  assert.equal(core.store.session(session.id).status,'error');assert.equal(core.store.session(session.id).agents![0].status,'interrupted');assert.equal(core.pendingCompletions.size,0);
  assert.match(core.store.messages(session.id).find(m=>m.kind==='agent')!.text,/interrupted/);
  const restarted:Session={...session,status:'working',agents:[{id:'new-child',name:'Work',status:'running',updated:Date.now()}]};core.store.saveSession(restarted);
  const second=new Core(new Store(core.store.directory));assert.equal(second.store.session(session.id).agents![0].status,'interrupted');await second.close();
});

test('agent history remains scoped to its original turn when a child is reused',async t=>{
  const {core,session}=await setup(t);
  core.updateSession(session.id,{turnId:'first'});agent(core,session,'child','running');agent(core,session,'child','completed');core.event(session.id,{type:'complete'});
  await core.send({id:session.id,text:'Follow up'});agent(core,session,'child','running');core.flush();
  const rows=core.store.messages(session.id).filter(m=>m.kind==='agent');assert.equal(rows.length,2);assert.match(rows[0].text,/completed/);assert.match(rows[1].text,/running/);
});

test('MCP multi-select respects array bounds and an empty enumeration never accepts free text',async t=>{
  const {core,session}=await setup(t);
  const pending=core.approval(session.id,{kind:'question',title:'Form',detail:'',choices:['answer'],questions:[{id:'checks',question:'Checks',multiSelect:true,allowOther:false,options:[{label:'A'},{label:'B'},{label:'C'}]}],fields:{checks:{type:'array',items:{type:'string',enum:['A','B','C']},minItems:2,maxItems:2}}});
  const id=core.snapshot().approvals[0].id;
  for(const values of [['A'],['A','B','C'],['A','Other']])assert.throws(()=>core.answer({id,choice:'answer',answers:{checks:{answers:values}}}));
  core.answer({id,choice:'answer',answers:{checks:{answers:['A','B']}}});assert.deepEqual((await pending).answers.checks.answers,['A','B']);
  const empty=core.approval(session.id,{kind:'question',title:'Empty',detail:'',choices:['answer'],questions:[{id:'empty',question:'Empty',options:[],allowOther:false}]});
  assert.throws(()=>core.answer({id:core.snapshot().approvals[0].id,choice:'answer',answers:{empty:{answers:['Anything']}}}));core.cancelApprovals(session.id);await empty;
});
