import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { defaultPersonality, personalityInstructions, personalityPreview, validatePersonality } from '../broker/personality.ts';
import { presetLimit } from '../broker/behavior-presets.ts';

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
async function broker(t: any, directory?: string) {
  const dir = directory || await mkdtemp(join(tmpdir(), 'cere-presets-'));
  const core = new Core(new Store(dir), idle);
  t.after(async () => { if (!core.closed) await core.close(); if (!directory) await rm(dir, { recursive: true, force: true }); });
  return { core, dir };
}
/** Everything a preset or preview must leave untouched. */
const runtime = (core: Core) => ({ settings: structuredClone(core.settings), revision: core.store.get('settingsRevision', '0'), stored: core.store.get('settings', {}) });

test('Q01 saved styles never change runtime settings and reject stale or invalid edits', async t => {
  const { core } = await broker(t);
  await core.updateSettings({ assistantName: 'Nova', avatar: 'jade', voice: 'en_US-amy-medium', categories: [] });
  const before = runtime(core);
  const calm = await core.rpc('presets.save', { label: '  Calm troubleshooting  ', text: 'Be calm. Ask for logs first.', expectedRevision: '0' });
  assert.equal(calm.label, 'Calm troubleshooting');
  assert.equal(calm.revision, '1');
  const neutral = await core.rpc('presets.save', { label: 'Neutral', text: '', expectedRevision: core.presets.catalog().revision });
  assert.equal(neutral.text, '', 'an empty style is the neutral voice, as in the editor');
  assert.deepEqual(runtime(core), before, 'saving styles changes no setting or settings revision');
  // A stale catalog revision cannot add, and a stale item revision cannot replace or delete.
  await assert.rejects(core.rpc('presets.save', { label: 'Late', text: 'x', expectedRevision: '0' }), /changed in another window/);
  const updated = await core.rpc('presets.save', { id: calm.id, label: 'Calm troubleshooting', text: 'Be calm.', expectedItemRevision: '1' });
  assert.equal(updated.revision, '2');
  await assert.rejects(core.rpc('presets.save', { id: calm.id, label: 'Calm', text: 'Lost update', expectedItemRevision: '1' }), /changed in another window/);
  await assert.rejects(core.rpc('presets.delete', { id: calm.id, expectedItemRevision: '1' }), /changed in another window/);
  await assert.rejects(core.rpc('presets.save', { label: 'calm TROUBLESHOOTING', text: 'dup', expectedRevision: core.presets.catalog().revision }), /already has this name/);
  // Style text passes exactly the validation the personality setting uses.
  for (const text of ['x'.repeat(8001), 'bad\u0001text', 42, {}]) {
    let expected = ''; try { validatePersonality(text); } catch (error: any) { expected = error.message; }
    await assert.rejects(core.rpc('presets.save', { label: 'Invalid', text, expectedRevision: core.presets.catalog().revision }), { message: expected });
  }
  await assert.rejects(core.rpc('presets.save', { label: 'Reset', text: null, expectedRevision: core.presets.catalog().revision }), /cannot store a reset/);
  for (const label of ['', '   ', 'x'.repeat(81), 'two\nlines', 'tab\there', 5]) await assert.rejects(core.rpc('presets.save', { label, text: 'ok', expectedRevision: core.presets.catalog().revision }), /Name the style/);
  await assert.rejects(core.rpc('presets.save', { label: 'Extra', text: 'ok', expectedRevision: core.presets.catalog().revision, personality: 'smuggled' }), /Invalid style preset request/);
  // Deleting the style whose text matches the applied personality leaves the applied text alone.
  await core.updateSettings({ personality: 'Be calm.' });
  const applied = runtime(core);
  await core.rpc('presets.delete', { id: calm.id, expectedItemRevision: '2' });
  assert.deepEqual(runtime(core), applied);
  assert.deepEqual(core.presets.catalog().items.map(item => item.label), ['Neutral']);
  assert.deepEqual(core.snapshot().behaviorPresets, { revision: core.presets.catalog().revision, count: 1 }, 'snapshots carry only the revision and count');
});

test('Q01 the catalog persists across restarts, is bounded, and refuses a newer schema rather than rewriting it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-presets-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  {
    const { core } = await broker(t, dir);
    for (let index = 0; index < presetLimit; index++) await core.rpc('presets.save', { label: 'Style ' + index, text: 'Text ' + index, expectedRevision: core.presets.catalog().revision });
    await assert.rejects(core.rpc('presets.save', { label: 'One too many', text: 'x', expectedRevision: core.presets.catalog().revision }), /at most 50/);
    await core.close();
  }
  {
    const { core } = await broker(t, dir);
    assert.equal(core.presets.catalog().items.length, presetLimit);
    assert.equal(core.presets.catalog().items[7].text, 'Text 7');
    core.store.set('behaviorPresets', { schema: 9, revision: '9', items: [], traits: {} });
    await assert.rejects(core.rpc('presets.list', {}), /newer version of Cere/);
    await assert.rejects(core.rpc('presets.save', { label: 'x', text: 'y', expectedRevision: '9' }), /newer version of Cere/);
    assert.deepEqual(core.store.get('behaviorPresets', {}), { schema: 9, revision: '9', items: [], traits: {} }, 'a newer catalog is never rewritten');
    assert.deepEqual(core.snapshot().behaviorPresets, { revision: 'unsupported', count: 0 });
    await core.close();
  }
});

test('Q03 the preview renders with the runtime renderer, validates like a save and writes nothing', async t => {
  const { core } = await broker(t);
  const original = globalThis.fetch; let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error('no network'); }) as any;
  t.after(() => { globalThis.fetch = original; });
  const before = runtime(core), calls: string[] = [];
  const service = core.memory.service.call.bind(core.memory.service);
  core.memory.service.call = (async (method: string, ...rest: any[]) => { calls.push(method); return (service as any)(method, ...rest); }) as any;
  const cases: [string, string][] = [[defaultPersonality, 'Cere'], [defaultPersonality, 'Étoile ✦'], ['Be concise.\nAvoid jargon.', 'Nova'], ['', 'Cere'], ['Ünïcødé 漢字 🜁 text', '"Quoted"']];
  for (const [personality, assistantName] of cases) {
    const preview = await core.rpc('personality.preview', { personality, assistantName });
    assert.equal(preview.draft, personalityInstructions(personality, assistantName));
    assert.equal(preview.saved, personalityInstructions(core.settings.personality, core.settings.assistantName));
    assert.equal(preview.scope, 'cere-personality-block');
    assert.equal(preview.settingsRevision, core.store.get('settingsRevision', '0'));
    assert.equal(preview.matchesSaved, personality === core.settings.personality && assistantName === core.settings.assistantName);
    assert.match(preview.note, /Provider and project instructions may add other context/);
  }
  // Fields left out keep their saved value; a name is trimmed exactly as a save trims it.
  assert.equal((await core.rpc('personality.preview', { assistantName: '  Cere  ' })).matchesSaved, true);
  // Identical validation failures to settings.update, with nothing changed by either.
  for (const patch of [{ personality: 'x'.repeat(8001) }, { personality: 'bad\u0001' }, { assistantName: 'two\nlines' }, { assistantName: 'x'.repeat(65) }]) {
    let saveError = ''; try { await core.updateSettings(patch); } catch (error: any) { saveError = error.message; }
    assert.ok(saveError);
    await assert.rejects(core.rpc('personality.preview', patch), { message: saveError });
  }
  await assert.rejects(core.rpc('personality.preview', { personality: 'x', avatar: 'nova' }), /only the name and personality/);
  assert.deepEqual(runtime(core), before, 'previews change no setting or settings revision');
  assert.deepEqual(calls, [], 'previews never call the memory worker');
  assert.equal(fetches, 0, 'previews never reach a provider or the network');
  assert.equal(core.adapters.size, 0, 'previews never start a provider');
  // The pure function needs no broker at all.
  assert.equal(personalityPreview({}, { personality: 'Saved', assistantName: 'Cere', revision: '4' }).matchesSaved, true);
});
