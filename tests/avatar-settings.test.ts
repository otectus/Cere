import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('avatar and theme selection lives in Companion with its own authoritative draft', () => {
  const qml = new URL('../qml/', import.meta.url);
  const companion = readFileSync(new URL('CompanionSettings.qml', qml), 'utf8');
  const personality = readFileSync(new URL('PersonalitySettings.qml', qml), 'utf8');
  assert.equal((companion.match(/objectName:"avatarSelection"/g) || []).length, 1);
  assert.doesNotMatch(personality, /objectName:"avatarSelection"|draftAvatar|avatarPreview_/);
  assert.match(companion, /model:App\.avatars/);
  assert.match(companion, /modelData\.themeLabel/);
  assert.match(companion, /objectName:"avatarSave"/);
  assert.match(companion, /objectName:"avatarDiscard"/);
  assert.match(companion, /objectName:"avatarConflict"/);
  assert.match(companion, /avatar:companion\.draftAvatar/);
  assert.match(companion, /expectedIdentity:\{personality:companion\.savedPersonality,assistantName:companion\.savedName,avatar:companion\.savedAvatar\}/);
  assert.match(personality, /objectName:"assistantName"/);
  assert.match(personality, /objectName:"personalityText"/);
  assert.match(personality, /expectedIdentity:\{personality:personality\.savedBaseline,assistantName:personality\.savedName,avatar:personality\.savedAvatar\}/);
  assert.doesNotMatch(personality, /avatar:personality\.draftAvatar/);
});
