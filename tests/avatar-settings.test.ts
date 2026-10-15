import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
test('retired 3D appearance settings are stripped without changing the 2D avatar or partial updates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-avatar-settings-cleanup-'));
  const store = new Store(directory);
  // Simulate a profile written before the 3D renderer was removed.
  store.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('settings', JSON.stringify({
    avatar:'nova', quiet:true, avatarRenderer:'3d', avatarModel:'cere-classic-v1', avatarQuality:'high',
  }));
  const core = new Core(store);
  t.after(async () => { await core.close(); await rm(directory, { recursive:true, force:true }); });
  assert.equal(core.settings.avatar, 'nova');
  assert.equal(core.settings.quiet, true);
  for (const key of ['avatarRenderer','avatarModel','avatarQuality']) assert.equal(key in core.settings, false);

  // Old mobile partial patches remain harmless and persist only supported fields.
  await core.updateSettings({ avatarRenderer:'3d', avatarModel:'cere-classic-v1', avatarQuality:'high', quiet:false });
  assert.equal(core.settings.avatar, 'nova');
  assert.equal(core.settings.quiet, false);
  const persisted = store.get<Record<string, unknown>>('settings', {});
  for (const key of ['avatarRenderer','avatarModel','avatarQuality']) assert.equal(key in persisted, false);
});
