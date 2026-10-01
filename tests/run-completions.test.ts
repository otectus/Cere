import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

async function setup(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-completions-'));
  const core = new Core(new Store(directory), () => ({async send() {}, async interrupt() {}, async close() {}}));
  t.after(async () => { await core.close(); await rm(directory, {recursive:true, force:true}); });
  const session = await core.create({provider:'codex', cwd:directory, trusted:true});
  return {core, session, directory};
}

test('completion contains the final reconciled assistant message after tool output', async t => {
  const {core, session} = await setup(t);
  await core.send({id:session.id, text:'Work'});
  core.event(session.id, {type:'message', id:'comment', text:'Checking.', data:{phase:'commentary'}});
  core.event(session.id, {type:'delta', id:'final', text:'Partial'});
  core.event(session.id, {type:'message', id:'final', text:'**Finished.**\nThe final answer. 🌟'});
  core.event(session.id, {type:'tool', id:'tool', text:'Private tool trace'});
  core.event(session.id, {type:'complete'});
  const completion = core.snapshot().completions[0];
  assert.equal(completion.sessionId, session.id);
  assert.equal(completion.message.text, '**Finished.**\nThe final answer. 🌟');
  assert.equal(core.store.messageById(completion.message.id)?.text, completion.message.text);
  core.event(session.id, {type:'complete'});
  assert.equal(core.completions.length, 1, 'duplicate terminal events must not duplicate bubbles');
  await core.send({id:session.id, text:'Next'});
  core.event(session.id, {type:'complete'});
  assert.equal(core.completions[1].message.text, 'This run finished without a final message.');
  assert.notEqual(core.completions[1].turnId, completion.turnId);
});

test('parallel runs keep separate replies and dismissal is shared and idempotent', async t => {
  const {core, session, directory} = await setup(t);
  const other = await core.create({provider:'claude', cwd:directory, trusted:true, title:'Second conversation'});
  await core.send({id:session.id, text:'First'});
  await core.send({id:other.id, text:'Second'});
  core.event(session.id, {type:'delta', id:'answer', text:'First answer'});
  core.event(other.id, {type:'delta', id:'answer', text:'Second answer'});
  core.event(other.id, {type:'complete'});
  core.event(session.id, {type:'complete'});
  assert.deepEqual(core.completions.map(c => c.message.text), ['Second answer', 'First answer']);
  assert.equal(core.completions[0].provider, 'claude');
  const id = core.completions[0].id;
  await core.rpc('completion.dismiss', {id});
  await core.rpc('completion.dismiss', {id});
  assert.equal(core.snapshot().completions.length, 1);
  assert.equal(core.completions[0].sessionId, session.id);
});

test('failures, interruption, and late errors do not leave success bubbles', async t => {
  const {core, session} = await setup(t);
  for (const type of ['error', 'interrupted']) {
    await core.send({id:session.id, text:'Try'});
    core.event(session.id, {type:'message', id:type, text:'Unfinished answer'});
    core.event(session.id, {type, text:type});
    assert.equal(core.completions.length, 0);
  }
  await core.send({id:session.id, text:'Try again'});
  core.event(session.id, {type:'complete'});
  assert.equal(core.completions.length, 1);
  core.event(session.id, {type:'error', text:'Late provider fault'});
  assert.equal(core.completions.length, 0);
});

test('completion waits for active agents and does not create child bubbles', async t => {
  const {core, session, directory} = await setup(t);
  await core.send({id:session.id, text:'Review'});
  core.event(session.id, {type:'agent', id:'child', data:{name:'Reviewer', status:'running'}});
  core.event(session.id, {type:'message', id:'final', text:'Review summary'});
  core.event(session.id, {type:'complete'});
  assert.equal(core.completions.length, 0);
  core.event(session.id, {type:'agent', id:'child', data:{status:'completed'}});
  assert.equal(core.completions[0].message.text, 'Review summary');
  const child = await core.create({provider:'codex', cwd:directory, trusted:true});
  core.updateSession(child.id, {parentId:session.id});
  await core.send({id:child.id, text:'Child work'});
  core.event(child.id, {type:'complete'});
  assert.equal(core.completions.length, 1);
});

test('long responses and queues are bounded without losing the stored reply', async t => {
  const {core, session} = await setup(t);
  const text = 'x'.repeat(15999) + '🌟' + 'Long answer. '.repeat(3000);
  await core.send({id:session.id, text:'Long reply'});
  core.event(session.id, {type:'message', id:'long', text});
  core.event(session.id, {type:'complete'});
  const message = core.completions[0].message;
  assert.equal(message.truncated, true);
  assert.equal(message.text.slice(0, 16001), 'x'.repeat(15999) + '\n\n');
  assert.equal((await core.rpc('session.messageText', {id:session.id, messageId:message.id})).text, text);
  for (let n = 0; n < 24; n++) {
    await core.send({id:session.id, text:'Another turn'});
    core.event(session.id, {type:'complete'});
  }
  assert.equal(core.completions.length, 25);
  assert.equal(core.store.get<any[]>('completionInbox',[]).length,25);
  assert.ok(!JSON.stringify(core.store.get('completionInbox',[])).includes('Long answer'));
});
