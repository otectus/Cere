import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

async function setup(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-pinned-'));
  const core = new Core(new Store(directory), () => ({async send() {}, async interrupt() {}, async close() {}}));
  t.after(async () => { await core.close(); await rm(directory, {recursive:true,force:true}); });
  const spoken: {text:string;sessionId?:string}[] = [], stopped: string[] = [];
  core.speech.speak = (text, _test, sessionId) => { spoken.push({text,sessionId}); return true; };
  core.speech.stopSession = id => { stopped.push(id); };
  const session = await core.create({provider:'codex',cwd:directory,trusted:true});
  await core.rpc('session.organize',{id:session.id,pinned:true});
  return {core,session,directory,spoken,stopped};
}

test('pinned background conversations publish each finished message once, including commentary, without activities', async t => {
  const {core,session,directory,spoken} = await setup(t);
  const other = await core.create({provider:'claude',cwd:directory,trusted:true});
  core.panels.ui = true; core.attention.ui.sessionId = other.id;
  await core.send({id:session.id,text:'Work'});
  core.event(session.id,{type:'delta',id:'update',text:'Checking'});
  core.flush();
  core.event(session.id,{type:'activity',text:'thinking'});
  core.event(session.id,{type:'tool',id:'tool',text:'Private trace'});
  assert.equal(core.companionReplies.length,0); assert.equal(spoken.length,0);
  core.event(session.id,{type:'message',id:'update',text:'Checking now.',data:{phase:'commentary'}});
  core.event(session.id,{type:'message',id:'update',text:'Checking now.',data:{phase:'commentary'}});
  assert.deepEqual(spoken,[{text:'Checking now.',sessionId:session.id}]);
  core.event(session.id,{type:'message',id:'answer',text:'All done.'});
  core.event(session.id,{type:'tool',id:'late-tool',text:'More trace'});
  core.event(session.id,{type:'complete'}); core.event(session.id,{type:'complete'});
  assert.deepEqual(core.snapshot().companionReplies.map(r=>r.message.text),['Checking now.','All done.']);
  assert.deepEqual(spoken.map(s=>s.text),['Checking now.','All done.']);
  assert.equal(core.completions[0].companion,true,'the inbox result must not become a duplicate desktop bubble');
  assert.equal(core.attention.ui.sessionId,other.id);
  const reply=core.companionReplies[0];
  assert.equal(core.store.messageById(reply.message.id)?.text,'Checking now.');
  await core.rpc('companion.dismiss',{id:reply.id}); await core.rpc('companion.dismiss',{id:reply.id});
  core.snapshot(); await core.rpc('session.messages',{id:session.id});
  assert.equal(core.companionReplies.length,1); assert.equal(spoken.length,2);
});

test('pinning does not replay settled messages or history, and unpinning cancels only that subscription', async t => {
  const {core,session,spoken,stopped} = await setup(t);
  await core.rpc('session.organize',{id:session.id,pinned:false});
  await core.send({id:session.id,text:'Work'});
  core.event(session.id,{type:'message',id:'old',text:'Already seen'});
  await core.rpc('session.organize',{id:session.id,pinned:true});
  core.event(session.id,{type:'complete'});
  assert.equal(core.companionReplies.length,0); assert.equal(spoken.length,0);
  await core.send({id:session.id,text:'Next'});
  core.event(session.id,{type:'message',id:'next',text:'New reply'});
  assert.equal(core.companionReplies.length,1);
  await core.rpc('session.organize',{id:session.id,pinned:false});
  assert.equal(core.companionReplies.length,0); assert.equal(stopped.at(-1),session.id);
  core.event(session.id,{type:'complete'});
  assert.deepEqual(spoken.map(s=>s.text),['New reply'],'unpinning must not cause a second final reading');
  await core.rpc('session.organize',{id:session.id,pinned:true});
  assert.equal(core.companionReplies.length,0);
  assert.equal(core.store.get<any[]>('completionInbox',[]).every(r=>r.companion),true);
});

test('stream-only final replies settle on completion; interrupted fragments and child activity stay silent', async t => {
  const {core,session,spoken,stopped} = await setup(t);
  await core.send({id:session.id,text:'Work'});
  core.event(session.id,{type:'delta',id:'partial',text:'Unfinished'});
  core.event(session.id,{type:'interrupted'});
  assert.equal(spoken.length,0); assert.equal(core.companionReplies.length,0);
  assert.ok(stopped.includes(session.id));
  await core.send({id:session.id,text:'Try again'});
  core.event(session.id,{type:'agent',id:'child',data:{status:'running',name:'Reviewer',detail:'Agent chatter'}});
  core.event(session.id,{type:'delta',id:'final',text:'Hello '});
  core.event(session.id,{type:'delta',id:'final',text:'again.'});
  core.event(session.id,{type:'complete'});
  assert.equal(spoken.length,0);
  core.event(session.id,{type:'agent',id:'child',data:{status:'completed'}});
  assert.deepEqual(spoken.map(s=>s.text),['Hello again.']);
  await core.send({id:session.id,text:'Tools only'});
  core.event(session.id,{type:'tool',id:'trace',text:'Activity'});
  core.event(session.id,{type:'complete'});
  assert.equal(core.companionReplies.length,1);
  assert.equal(core.completions.at(-1)?.companion,true);
});

test('questions are conversational, permission prompts are not, and archiving clears pinned presentation', async t => {
  const {core,session,spoken,stopped} = await setup(t);
  await core.send({id:session.id,text:'Ask'});
  const question=core.approval(session.id,{kind:'question',title:'Which direction?',detail:'Choose a direction',questions:[{id:'direction',header:'Direction',question:'Left or right?',options:[]}],choices:['answer','deny']});
  assert.equal(spoken.length,1); assert.match(spoken[0].text,/Left or right/);
  core.answer({id:[...core.approvals.keys()][0],choice:'deny'}); await question;
  const permission=core.approval(session.id,{kind:'provider',title:'Execute a command?',detail:'Permission fixture',choices:['allow','deny']});
  assert.equal(spoken.length,1);
  core.answer({id:[...core.approvals.keys()][0],choice:'deny'}); await permission;
  await core.rpc('session.organize',{id:session.id,archived:true});
  assert.equal(core.companionReplies.length,0); assert.equal(stopped.at(-1),session.id);
  core.event(session.id,{type:'message',id:'later',text:'Archived response'});
  core.event(session.id,{type:'complete'});
  assert.equal(spoken.length,1);
});

test('long pinned replies retain full transcripts, ephemeral previews are bounded and never persisted', async t => {
  const {core,session,spoken} = await setup(t);
  await core.send({id:session.id,text:'Report'});
  const text='x'.repeat(15999)+'🌟'+' more'.repeat(500);
  core.event(session.id,{type:'message',id:'long',text});
  assert.equal(core.companionReplies[0].message.truncated,true);
  assert.ok(core.companionReplies[0].message.text.startsWith('x'.repeat(15999)+'\n\n'));
  assert.equal(core.store.messageById(core.companionReplies[0].message.id)?.text,text);
  for(let n=0;n<110;n++)core.event(session.id,{type:'message',id:'reply-'+n,text:'Reply '+n});
  assert.equal(core.companionReplies.length,100); assert.equal(spoken.length,111);
  assert.equal(core.store.get('companionReplies',null),null);
  for(let n=0;n<20;n++)core.event(session.id,{type:'message',id:'escaped-'+n,text:'\0"\\'.repeat(6000)});
  assert.ok(Buffer.byteLength(JSON.stringify(core.companionReplies))<520*1024);
  assert.equal(core.companionReplies.at(-1)?.message.id,session.id+':escaped-19');
});

test('broker restart restores the inbox without replaying pinned speech or avatar replies', async () => {
  const directory=await mkdtemp(join(tmpdir(),'cere-pinned-restart-'));
  let core=new Core(new Store(directory),()=>({async send(){},async interrupt(){},async close(){}}));
  try {
    core.speech.speak=()=>true;
    const session=await core.create({provider:'codex',cwd:directory,trusted:true});
    await core.rpc('session.organize',{id:session.id,pinned:true});
    await core.send({id:session.id,text:'Work'});
    core.event(session.id,{type:'message',id:'answer',text:'Finished yesterday'});
    core.event(session.id,{type:'complete'});
    assert.equal(core.companionReplies.length,1);
    await core.close();core=new Core(new Store(directory));
    assert.equal(core.companionReplies.length,0);
    assert.equal(core.completions[0].companion,true);
    assert.equal(core.speech.queue.length,0);assert.equal(core.speech.state.state,'idle');
    await core.rpc('session.messages',{id:session.id});
    assert.equal(core.companionReplies.length,0);
  } finally {await core.close();await rm(directory,{recursive:true,force:true});}
});

test('provider speech switches suppress pinned and ordinary speech while retaining bubbles',async t=>{
  const {core,session,directory,spoken}=await setup(t);
  await core.updateSettings({speechProviders:{codex:false}});
  await core.send({id:session.id,text:'Muted pinned turn'});
  core.event(session.id,{type:'message',id:'muted-pinned',text:'Still visible.'});core.event(session.id,{type:'complete'});
  assert.equal(spoken.length,0);assert.equal(core.companionReplies.at(-1)?.message.text,'Still visible.');
  await core.rpc('session.organize',{id:session.id,pinned:false});await core.send({id:session.id,text:'Muted ordinary turn'});
  core.event(session.id,{type:'message',id:'muted-ordinary',text:'Still readable.'});core.event(session.id,{type:'complete'});assert.equal(spoken.length,0);
  const other=await core.create({provider:'claude',cwd:directory,trusted:true});await core.send({id:other.id,text:'Enabled turn'});
  core.event(other.id,{type:'message',id:'allowed',text:'Allowed speech.'});core.event(other.id,{type:'complete'});assert.deepEqual(spoken.map(s=>s.text),['Allowed speech.']);
  await core.updateSettings({speechProviders:{codex:true}});await core.send({id:session.id,text:'Enabled again'});
  core.event(session.id,{type:'message',id:'reenabled',text:'New speech.'});core.event(session.id,{type:'complete'});assert.equal(spoken.at(-1)?.text,'New speech.');
});
