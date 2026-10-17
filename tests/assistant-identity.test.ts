import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { avatarIds, defaultPersonality, personalityInstructions, validateAssistantName } from '../broker/personality.ts';
import { voiceTestLine } from '../broker/tts.ts';

test('identity migrates old profiles, persists independently, and rejects invalid changes atomically', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-identity-'));
  const store = new Store(directory);
  store.set('settings', { personality: 'Keep my voice', quiet: true });
  const core = new Core(store);
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(core.settings.assistantName, 'Cere');
  assert.equal(core.settings.avatar, 'cere');
  const before = structuredClone(core.settings);
  await core.updateSettings({ avatar: 'daemona' });
  assert.deepEqual(core.settings, { ...before, avatar: 'daemona' });
  for (const avatar of avatarIds) {
    await core.updateSettings({ avatar });
    assert.deepEqual(core.settings, { ...before, avatar });
    const persisted = new Store(directory);
    try { assert.deepEqual(persisted.settings(), core.settings); } finally { persisted.close(); }
  }
  await core.updateSettings({ avatar: 'daemona' });
  await core.updateSettings({ assistantName: '  Étoile ✦  ' });
  assert.equal(core.settings.assistantName, 'Étoile ✦');
  assert.equal(core.settings.avatar, 'daemona');
  const saved = structuredClone(core.settings), revision = core.store.get('settingsRevision', '0');
  for (const assistantName of [12, false, {}, [], 'a'.repeat(65), 'bad\nname', '\tName', '\0Name', 'Name\u202e', 'Name\u200b', '\ud800']) {
    await assert.rejects(core.updateSettings({ assistantName, personality: 'Must not save', avatar: 'cere' }), /name/);
    assert.deepEqual(core.settings, saved);
    assert.equal(core.store.get('settingsRevision', '0'), revision);
  }
  for (const avatar of ['missing', '', '../reference/daemona.png', 0, false, {}, []]) {
    await assert.rejects(core.updateSettings({ avatar, assistantName: 'Must not save' }), /avatar/);
    assert.deepEqual(core.settings, saved);
  }
  await assert.rejects(core.updateSettings({ avatar: 'cere', assistantName: 'Lost update', expectedRevision: '0' }), /changed on another client/);
  const reopened = new Store(directory);
  try { assert.deepEqual(reopened.settings(), saved); } finally { reopened.close(); }
  await core.updateSettings({ assistantName: '   ' });
  assert.equal(core.settings.assistantName, 'Cere');
  assert.equal(core.settings.avatar, 'daemona');
  await core.updateSettings({ assistantName: null, avatar: null });
  assert.equal(core.settings.avatar, 'cere');
  assert.equal(core.settings.personality, 'Keep my voice');
  store.set('settings', { ...saved, avatar: 'unavailable', assistantName: 'bad\nname' });
  assert.equal(store.settings().avatar, 'cere');
  assert.equal(store.settings().assistantName, 'Cere');
});

test('names remain literal data in instructions and voice previews without rewriting custom personality', () => {
  assert.equal(validateAssistantName('🜁 Étoile'), '🜁 Étoile');
  assert.equal(validateAssistantName('x'.repeat(64)), 'x'.repeat(64));
  for (const name of ['Daemona', '$&', 'Nova "the bright"', '<b>Nova</b>']) {
    const instructions = personalityInstructions(defaultPersonality, name);
    assert.ok(instructions.includes(`You are ${name},`));
    assert.ok(instructions.includes(JSON.stringify(name)));
    assert.ok(!instructions.includes('You are Cere,'));
    assert.ok(voiceTestLine(name).startsWith(`Hello, I'm ${name}.`));
  }
  const custom = 'You are Cere. Keep the Cere project well documented.';
  assert.ok(personalityInstructions(custom, 'Daemona').includes(custom));
  assert.match(personalityInstructions(custom, 'Daemona'), /supersedes any earlier self-name/);
  assert.match(personalityInstructions('', 'Daemona'), /neutral voice/);
  assert.match(personalityInstructions('', 'Daemona'), /"Daemona"/);
  assert.match(personalityInstructions('', 'Cere'), /"Cere"/);
});

test('identity saves tolerate unrelated snapshot lag but reject stale identity and mixed settings patches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-identity-race-'));
  const core = new Core(new Store(directory));
  t.after(async () => { await core.close(); await rm(directory, {recursive:true, force:true}); });
  const expectedIdentity = {personality:core.settings.personality, assistantName:'Cere', avatar:'cere'};
  const expectedRevision = core.store.get('settingsRevision', '0');
  await core.updateSettings({quiet:true});
  await core.updateSettings({assistantName:'Daemona', avatar:'daemona', expectedIdentity, expectedRevision});
  assert.equal(core.settings.assistantName, 'Daemona');
  assert.equal(core.settings.quiet, true);
  for (const expected of [expectedIdentity, {}, null, [], { ...expectedIdentity, assistantName:'Daemona', avatar:'daemona', extra:true }])
    await assert.rejects(core.updateSettings({assistantName:'Lost update', expectedIdentity:expected}), /changed on another client/);
  const current = {personality:core.settings.personality, assistantName:'Daemona', avatar:'daemona'};
  await assert.rejects(core.updateSettings({assistantName:'Lost update', quiet:false, expectedIdentity:current}), /identity draft/);
  assert.equal(core.settings.assistantName, 'Daemona');
  assert.equal(core.settings.quiet, true);
});

test('every selectable avatar ships transparent artwork, usable cutouts, and a complete portrait grid', async () => {
  const entries = JSON.parse(await readFile('assets/avatars.json', 'utf8'));
  const base = JSON.parse(await readFile('assets/cere-rig.json', 'utf8'));
  assert.deepEqual(entries.map((entry: any) => entry.id), [...avatarIds]);
  assert.deepEqual(entries.map((entry: any) => entry.label), ['Cere', 'Daemona', 'Jade', 'Nova', 'Soap', 'Brandy', 'Archy', 'Ghost', 'Violet', 'Leafy', 'Cachy', 'Usagi', 'Cynthia', 'Genga', 'Kippy', 'Pomni', 'Rem', 'Sarah', 'Sylva', 'Witty']);
  for (const entry of entries) {
    const rig = { ...base, ...(entry.rig ? JSON.parse(await readFile(join('assets', entry.rig), 'utf8')) : {}) };
    const { data, info } = await sharp(join('assets', rig.texture)).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    assert.equal(data[3], 0, `${entry.id}: transparent background`);
    for (const part of rig.parts) {
      const [x, y, width, height] = part.sourceRect;
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= info.width && y + height <= info.height, `${entry.id}: ${part.name} bounds`);
      let visible = 0;
      for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++)
        if (data[(row * info.width + col) * 4 + 3] > 200) visible++;
      assert.ok(visible > width * height * .05, `${entry.id}: ${part.name} is painted`);
    }
    const portrait = await sharp(join('assets', entry.portrait)).raw().toBuffer({ resolveWithObject: true });
    assert.equal(portrait.info.channels, 4);
    assert.equal(portrait.info.width / 4, portrait.info.height / 3);
    const size = portrait.info.width / 4;
    for (let face = 0; face < 12; face++) {
      let visible = 0, transparent = 0, clipped = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const alpha = portrait.data[((Math.floor(face / 4) * size + y) * portrait.info.width + (face % 4) * size + x) * 4 + 3];
        if (alpha > 200) visible++;
        if (alpha === 0) transparent++;
        if (alpha > 12 && (y === 0 || x === 0 || x === size - 1)) clipped++;
      }
      assert.ok(visible > size * size * .3 && transparent > size * size * .03, `${entry.id}: portrait ${face} has artwork and transparency`);
      if (['cynthia', 'genga', 'kippy', 'pomni', 'rem', 'sarah', 'sylva', 'witty'].includes(entry.id))
        assert.equal(clipped, 0, `${entry.id}: portrait ${face} preserves the head silhouette without gutter bleed`);
    }
  }
});

test('Cere canonical surface preserves source pixels and confines neutral blinking to the eyes', async () => {
  const source = await sharp('reference/cere.png').extract({ left: 0, top: 170, width: 430, height: 760 }).ensureAlpha().raw().toBuffer();
  const rig = JSON.parse(await readFile('assets/cere-surface-rig.json', 'utf8'));
  const part = rig.parts.find((candidate: any) => candidate.surfaceMotion);
  assert.ok(part, 'Cere has a connected surface part');
  const [openX, openY, width, height] = part.sourceRect;
  const [closedX, closedY, closedWidth, closedHeight] = part.blinkSourceRect;
  assert.equal(height, 840);
  const topInset = height - 760;
  assert.deepEqual([closedWidth, closedHeight], [width, height]);
  assert.ok(width >= 430 && (width - 430) % 2 === 0, 'neutral surface symmetrically pads the original reference crop');
  const inset = (width - 430) / 2;
  const { data, info } = await sharp('assets/cere-surface.png').raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  assert.ok(openX >= 0 && openY >= 0 && openX + width <= info.width && openY + height <= info.height);
  assert.ok(closedX >= 0 && closedY >= 0 && closedX + width <= info.width && closedY + height <= info.height);
  let eyeChanges = 0, opaque = 0;
  for (let y = 0; y < 760; y++) for (let x = 0; x < 430; x++) {
    const original = (y * 430 + x) * 4;
    const open = ((openY + topInset + y) * info.width + openX + inset + x) * 4;
    const closed = ((closedY + topInset + y) * info.width + closedX + inset + x) * 4;
    for (let c = 0; c < 3; c++) assert.equal(data[open + c], source[original + c], `original color at ${x},${y}`);
    assert.equal(data[open + 3], data[closed + 3], 'blinking preserves silhouette');
    const changed = [0, 1, 2].some(c => data[open + c] !== data[closed + c]);
    if (changed) {
      assert.ok((x >= 128 && x < 212 && y >= 223 && y < 287) || (x >= 233 && x < 322 && y >= 222 && y < 288), 'only registered eye patches may change');
      eyeChanges++;
    }
    if (data[open + 3] > 240) opaque++;
  }
  assert.ok(eyeChanges > 2000, 'closed eyelids must actually replace the eyes');
  assert.ok(opaque > 190000 && opaque < 220000, 'foreground remains complete without the studio background');
  for (const [x, y] of [[0, 0], [200, 0], [220, 630], [10, 750], [420, 740]])
    assert.equal(data[((openY + topInset + y) * info.width + openX + inset + x) * 4 + 3], 0, 'background and leg gap remain transparent');
});
