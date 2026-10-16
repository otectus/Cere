import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

test('Q08 the send key is a validated setting that defaults to Enter and survives restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-send-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  assert.equal(core.settings.sendKey, 'enter', 'existing profiles keep Enter to send');
  for (const sendKey of ['ctrlEnter', 'button', 'enter'] as const) { await core.updateSettings({ sendKey }); assert.equal(core.settings.sendKey, sendKey); }
  await core.updateSettings({ sendKey: 'button' });
  const revision = core.store.get('settingsRevision', '0');
  for (const sendKey of ['Enter', 'shiftEnter', '', null, 1, {}]) await assert.rejects(core.updateSettings({ sendKey }), /Choose Enter, Ctrl\+Enter or the Send button/);
  assert.equal(core.settings.sendKey, 'button');
  assert.equal(core.store.get('settingsRevision', '0'), revision, 'a refused value changes nothing');
  await core.close();
  const reopened = new Store(dir);
  try { assert.equal(reopened.settings().sendKey, 'button'); } finally { reopened.close(); }
});
