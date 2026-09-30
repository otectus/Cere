import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../broker/store.ts';
import { mobilePage } from '../broker/remote/transcript.ts';

test('mobile chat pages remain useful through long runs of tool activity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-mobile-transcript-'));
  const store = new Store(directory);
  store.saveSession({ id: 'session', provider: 'ollama', nativeId: null, title: 'Fixture', cwd: directory,
    mode: 'managed', status: 'idle', created: Date.now(), updated: Date.now(), draft: '', scroll: 0, model: 'fixture', effort: '' });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const put = (id: string, role: string, kind?: string) => store.message({ id, sessionId: 'session', role, kind, text: id, time: Date.now() });
  put('question', 'user');
  put('answer-one', 'assistant', 'text');
  for (let i = 0; i < 250; i++) put(`tool-${i}`, 'tool', 'tool');
  put('reasoning', 'assistant', 'thinking');
  put('status', 'system');
  put('answer-two', 'assistant', 'text');

  const latest = mobilePage(store, 'session', undefined, 2);
  assert.deepEqual(latest.items.map(item => item.id), ['answer-one', 'answer-two']);
  assert.equal(latest.before, 'answer-one');
  assert.deepEqual(mobilePage(store, 'session', latest.before!, 2).items.map(item => item.id), ['question']);
  const activity = mobilePage(store, 'session', undefined, 100, true);
  assert.equal(activity.items.length, 100);
  assert.deepEqual(activity.items.slice(-2).map(item => item.id), ['reasoning', 'status']);
  assert.ok(activity.items.every(item => !['question', 'answer-one', 'answer-two'].includes(item.id)));
});
