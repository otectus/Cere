/**
 * W08: the desktop offers providers in the broker's order, described by the broker's traits. The state
 * reaches QML as a map with sorted keys, so the order travels as a list of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { providerIds } from '../broker/provider-catalog.ts';

test('the snapshot names every provider with its traits, in the order the desktop offers them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-traits-'));
  const core = new Core(new Store(directory), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  const snapshot = core.snapshot();
  assert.deepEqual(snapshot.providerOrder, [...providerIds]);
  assert.deepEqual(Object.keys(snapshot.providerTraits).sort(), [...providerIds].sort());
  assert.equal(snapshot.providerTraits.compatible.kind, 'api');
  // The new-conversation dialog takes its order from that list, never from the map's keys.
  const dialog = await readFile(new URL('../qml/NewSession.qml', import.meta.url), 'utf8');
  assert.match(dialog, /App\.state\.providerOrder/);
  assert.doesNotMatch(dialog, /Object\.keys\(traits\)/);
});
