import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avatarCatalog, avatarFor, avatarIds, authoringAvatars, defaultAvatar, parseAvatarManifest, validateAvatar } from '../broker/avatars.ts';

test('the manifest owns every canonical ID, legacy alias, default and authoring selection', () => {
  assert.deepEqual(avatarIds, avatarCatalog.map(entry => entry.id));
  assert.equal(avatarFor(null).id, defaultAvatar);
  assert.equal(avatarFor('missing').id, defaultAvatar);
  assert.equal(validateAvatar('cere'), 'cere_default');
  assert.equal(validateAvatar(null), defaultAvatar);
  for (const entry of avatarCatalog) {
    assert.equal(validateAvatar(entry.id), entry.id);
    assert.equal(avatarFor(entry.id), entry);
    for (const alias of entry.aliases) assert.equal(validateAvatar(alias), entry.id);
    assert.deepEqual(authoringAvatars([entry.id]), [entry]);
  }
  assert.deepEqual(authoringAvatars([]), avatarCatalog);
  for (const invalid of ['', '../nova', 'unknown', {}, 1, undefined]) assert.throws(() => validateAvatar(invalid), /avatar/);
  assert.throws(() => authoringAvatars(['unknown']), /Unknown avatar source/);
});

test('a new conforming avatar needs one entry, with no ID allowlist or fixed count', () => {
  const next = { ...structuredClone(avatarCatalog[0]), id: 'future_companion', label: 'Future companion', default: false, aliases: ['old_future'] };
  const parsed = parseAvatarManifest([...avatarCatalog, next]);
  assert.equal(parsed.at(-1)!.id, next.id);
  // Reordering cannot silently change the default.
  assert.equal(parseAvatarManifest([...parsed].reverse()).find(entry => entry.default)!.id, defaultAvatar);
});

test('malformed manifests fail before consumers use unsafe or ambiguous entries', () => {
  const first = structuredClone(avatarCatalog[0]);
  const second = { ...first, id: 'second', default: false, aliases: [] };
  for (const value of [
    [], {}, [first, first], [{ ...first, default: false }], [first, { ...second, default: true }],
    [first, { ...second, aliases: [first.id] }], [first, { ...second, id: 'cere' }],
    [{ ...first, aliases: ['legacy', 'legacy'] }], [{ ...first, id: '../escape' }],
    [{ ...first, portrait: '../outside.png' }], [{ ...first, rig: '/outside.json' }],
    [{ ...first, label: '' }], [{ ...first, authoring: { ...first.authoring, cellOrder: { carry: [17] } } }],
    [{ ...first, palette: { ...first.palette, accent: 'red' } }], [{ ...first, palette: {} }],
  ]) assert.throws(() => parseAvatarManifest(value));
});

test('all manifest entries reference their shipped rig, portraits and connected gesture routes', () => {
  for (const entry of avatarCatalog) {
    const rig = JSON.parse(readFileSync(new URL('../assets/' + entry.rig, import.meta.url), 'utf8'));
    const portrait = readFileSync(new URL('../assets/' + entry.portrait, import.meta.url));
    assert.equal(portrait.subarray(1, 4).toString(), 'PNG', entry.id);
    assert.equal(rig.texture, `${entry.id}-surface.png`);
    assert.deepEqual(Object.keys(rig.surfaceSequences.routes), ['wave', 'thinking', 'present', 'celebrate', 'shy', 'carry']);
    assert.ok(rig.surfaceSequences.routes.carry.frames.length > 1);
  }
});
