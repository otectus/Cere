import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { healthReport } from '../broker/health.ts';
import { writeFileSync } from 'node:fs';

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
async function broker(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'cere-shutdown-'));
  const core = new Core(new Store(join(root, 'state')), idle);
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  return { root, core };
}

test('W04 shutdown refuses new changes, lets a running one finish and closes the store last', async t => {
  const { core } = await broker(t);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let touchedStoreAfter = false;
  const running = core.withMutation(async () => { await held; touchedStoreAfter = !!core.store.sessions(); return 'finished'; });
  core.refuseMutations();
  await assert.rejects(core.withMutation(async () => 'late'), /shutting down/, 'a change that starts after shutdown began is refused');
  await assert.rejects(core.rpc('settings.update', { quiet: true }), /shutting down/);
  const closing = core.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  release();
  assert.equal(await running, 'finished');
  await closing;
  assert.equal(touchedStoreAfter, true, 'the running change still had its store');
  assert.equal(core.activeMutations, 0);
  assert.equal(core.close(), closing, 'closing again awaits the same close');
});

test('W04 a change that never settles cannot hold shutdown open forever', { timeout: 20000 }, async t => {
  const { core } = await broker(t);
  void core.withMutation(() => new Promise(() => {})).catch(() => {});
  const started = Date.now();
  await core.close();
  assert.ok(Date.now() - started < 15000, 'closing is bounded');
});

test('W04 Health shows a previous shutdown that could not confirm its work finished', async t => {
  const { core } = await broker(t);
  assert.equal(healthReport(core).previousShutdown, null);
  writeFileSync(join(core.store.directory, 'last-shutdown.json'), JSON.stringify({ at: 1, confirmed: false, problems: ['1 phone operation was still running; its outcome was not confirmed.'] }));
  assert.deepEqual(healthReport(core).previousShutdown, { at: 1, confirmed: false, problems: ['1 phone operation was still running; its outcome was not confirmed.'] });
  writeFileSync(join(core.store.directory, 'last-shutdown.json'), JSON.stringify({ at: 2, confirmed: true, problems: [] }));
  assert.equal(healthReport(core).previousShutdown?.confirmed, true);
});
