import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GraphMemory, memoryBudgets, watchdogLimit, type GraphMemoryOptions } from '../broker/graph-memory/client.ts';

// A stand-in worker that speaks the real protocol: it claims each call, announces it, then answers
// "hang" never, "spin" only once the call is cancelled, and anything else at once with what it got.
const stub = `
import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ ready: true });
parentPort.on('message', m => {
  if (Atomics.compareExchange(m.cancellation, 0, 0, 2) !== 0) { parentPort.postMessage({ id: m.id, error: { code: 'SOURCE_CHANGED', message: 'Cancelled before execution' } }); return; }
  if (m.method === 'close') { parentPort.postMessage({ id: m.id, result: true }); parentPort.close(); return; }
  parentPort.postMessage({ started: m.id });
  if (m.method === 'hang') for (;;) {}
  if (m.method === 'spin') { while (Atomics.load(m.cancellation, 1) !== 1) {} parentPort.postMessage({ id: m.id, error: { code: 'CANCELLED', message: 'Stopped' } }); return; }
  parentPort.postMessage({ id: m.id, result: { method: m.method, budgetMs: m.budgetMs } });
});
`;
async function harness(t: TestContext, options: GraphMemoryOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-memory-worker-')), file = join(directory, 'stub-worker.mjs');
  await writeFile(file, stub);
  const events: any[] = [];
  const memory = new GraphMemory(directory, event => events.push(event), { workerUrl: pathToFileURL(file), watchdogMs: 20, ...options });
  t.after(async () => { await memory.close(); await rm(directory, { recursive: true, force: true }); });
  await memory.ready;
  return { memory, events };
}

test('the watchdog replaces a worker whose call runs past its limit, and the next call is served', async t => {
  const { memory, events } = await harness(t, { limit: method => method === 'hang' ? 100 : Infinity });
  const hung = memory.call('hang'), queued = memory.call('health');
  await assert.rejects(hung, { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(queued, { code: 'BACKEND_UNAVAILABLE', message: /ran too long/ });
  assert.equal(memory.restarts, 1);
  assert.deepEqual(events, [{ type: 'worker_restarted', method: 'hang' }]);
  assert.deepEqual(await memory.call('ping'), { method: 'ping', budgetMs: 0 });
  assert.equal(memory.pending.size, 0);
  assert.equal(memory.failure, undefined);
});

test('cancelling a running call asks it to stop at its next checkpoint', async t => {
  const { memory } = await harness(t);
  const controller = new AbortController(), spinning = memory.call('spin', {}, controller.signal);
  const end = Date.now() + 5000;
  while (memory.active?.method !== 'spin') { assert.ok(Date.now() < end, 'the call started'); await new Promise(resolve => setTimeout(resolve, 5)); }
  controller.abort(new Error('Stopped by the user'));
  await assert.rejects(spinning, { code: 'OUTCOME_UNKNOWN' });
  // The worker left its loop: it serves the next call without a restart.
  assert.deepEqual(await memory.call('ping'), { method: 'ping', budgetMs: 0 });
  assert.equal(memory.restarts, 0);
});

test('erasure previews and expiry carry time budgets; accepted erasures, backups and compaction are never cut short', async t => {
  const { memory } = await harness(t);
  assert.deepEqual(await memory.call('forget_sources'), { method: 'forget_sources', budgetMs: memoryBudgets.forget_sources });
  // An accepted erasure runs to completion, including its replay at startup.
  assert.deepEqual(await memory.call('forget'), { method: 'forget', budgetMs: 0 });
  assert.deepEqual(await memory.call('maintenance'), { method: 'maintenance', budgetMs: 60000 });
  assert.equal(watchdogLimit('forget_preview'), 90000);
  assert.equal(watchdogLimit('health'), 60000);
  assert.equal(watchdogLimit('forget'), 600000);
  for (const method of ['backup', 'restore', 'rebuild', 'compact']) assert.equal(watchdogLimit(method), Infinity);
});

test('closing gives a busy worker five seconds, then ends it', async t => {
  const { memory } = await harness(t, { limit: () => Infinity });
  const hung = memory.call('hang');
  const started = Date.now();
  await memory.close();
  assert.ok(Date.now() - started < 8000);
  await assert.rejects(hung);
});
