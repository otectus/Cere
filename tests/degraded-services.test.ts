/**
 * W14 (item 9): an absent optional service degrades only its own feature. With memory retrieval
 * failing, workspace awareness down, speech unavailable and none of the desktop-control programs on
 * PATH, a conversation still sends, streams and completes, and Health names what is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { healthReport } from '../broker/health.ts';
import type { Hooks } from '../broker/providers.ts';

test('chat completes while memory, workspace awareness, speech and desktop tools are all unavailable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-degraded-'));
  let hooks: Hooks | undefined, sends = 0;
  const core = new Core(new Store(directory), (_session, h) => { hooks = h; return { async send() { sends++; }, async interrupt() {}, async close() {} }; });
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  // No desktop-control program is reachable.
  const path = process.env.PATH; process.env.PATH = join(directory, 'empty-bin'); t.after(() => { process.env.PATH = path; });
  await core.updateSettings({ memory: { enabled: true }, speechEnabled: true });
  await core.memory.ready;
  // Memory answers nothing it is asked during a turn; workspace awareness reports its worker gone.
  const call = core.memory.service.call.bind(core.memory.service);
  core.memory.service.call = ((method: string, p?: any, signal?: AbortSignal) => ['retrieve', 'observe_text', 'capture'].includes(method) ? Promise.reject(new Error('projection unavailable')) : call(method, p, signal)) as typeof core.memory.service.call;
  core.memory.recallDeadlineMs = 200;
  core.telemetry.status = { ...core.telemetry.status, enabled: true, listener: 'error', watcher: 'degraded', lastError: 'WORKER_UNAVAILABLE' };
  const session = await core.create({ provider: 'codex', cwd: directory, trusted: true });
  const started = Date.now();
  await core.send({ id: session.id, text: 'Summarize the plan.' });
  assert.equal(sends, 1, 'the provider received the turn');
  assert.ok(Date.now() - started < 5000, 'memory did not hold the turn past its deadline');
  hooks!.event({ type: 'message', id: 'reply', text: 'Here is the plan.' });
  hooks!.event({ type: 'complete', text: '' });
  for (let n = 0; n < 200 && core.store.session(session.id).status !== 'idle'; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(core.store.session(session.id).status, 'idle');
  assert.ok(core.store.messages(session.id).some(message => message.role === 'assistant' && message.text === 'Here is the plan.'), 'the reply is in the transcript');
  const health = healthReport(core);
  for (const name of ['hyprctl', 'grim', 'satty', 'wpctl', 'busctl', 'gtk-launch', 'xdg-open']) assert.equal(health.dependencies.find(entry => entry.name === name)?.available, false, name + ' is reported missing');
  assert.ok(health.dependencies.find(entry => entry.name === 'grim')!.feature.length > 0);
  assert.equal(health.sessions.active, 0);
});
