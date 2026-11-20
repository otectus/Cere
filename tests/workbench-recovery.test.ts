import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../broker/store.ts';
import { activatePendingRecovery } from '../broker/recovery.ts';
import { ArtifactStore } from '../broker/artifacts/store.ts';
import { skipWithoutHelper, workbenchFixture } from './fixtures/workbench.ts';
import { png } from './fixtures/image-backends.ts';

/** Imports a picture and a note into a conversation, with a workspace root and a pending change. */
async function populated(t: any) {
  const f = await workbenchFixture(t);
  const { session, root } = await f.session();
  await writeFile(join(f.directory, 'picture.png'), await png(64, 48));
  await writeFile(join(f.directory, 'note.txt'), 'Quarterly numbers, kept private.\n');
  const picture = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.directory, 'picture.png') });
  const note = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.directory, 'note.txt') });
  const edited = await f.core.rpc('images.transform', { sessionId: session.id, artifactId: picture.artifactId, versionId: picture.versionId, steps: [{ op: 'resize', width: 32, height: 24, fit: 'fill' }] });
  await f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'create_text', rootId: root.id, path: 'later.txt', content: 'not yet\n' }] });
  return { f, session, root, picture, note, edited };
}

test('DA13 backups carry conversation files with verified bytes; folder access, changes and runs stay behind', { skip: skipWithoutHelper }, async t => {
  const { f, session, picture, note, edited } = await populated(t);
  const backup = await f.core.rpc('recovery.backup', { includeContent: true });
  assert.equal(backup.manifest.artifacts, 3, 'two imports and one edited version');
  assert.equal(backup.manifest.artifactBytes, true);
  const objects = await readdir(join(backup.directory, 'artifacts'));
  assert.equal(objects.length, 3);
  for (const name of objects) assert.equal((await import('node:fs')).statSync(join(backup.directory, 'artifacts', name)).mode & 0o777, 0o600);
  assert.ok(backup.exclusions.some((entry: string) => /workspace folder access/.test(entry)));
  const profile = JSON.parse(await readFile(join(backup.directory, 'profile.json'), 'utf8'));
  assert.equal(profile.artifacts.rows.artifact_refs.every((r: any) => r.owner_kind === 'session' ? r.owner_id === session.id : true), true);
  assert.doesNotMatch(JSON.stringify(profile), /workspace_roots|change_sets|later\.txt/, 'roots and change sets are machine authority');

  // A tampered object is reported as missing, never installed.
  const tampered = join(backup.directory, 'artifacts', (await f.core.workbench.artifacts.version(session.id, note.artifactId, note.versionId)).sha256);
  await chmod(tampered, 0o600); await writeFile(tampered, 'something else');
  const review = await f.core.rpc('recovery.preview', { directory: backup.directory, includeContent: true });
  assert.deepEqual(review.artifacts, { artifacts: 2, versions: 3, missingBytes: 1, bytesIncluded: true });
  assert.match(review.replaced, /conversation files/);
  const activation = await f.core.rpc('recovery.activate', { id: review.id, digest: review.digest });
  t.after(() => rm(activation.previous, { recursive: true, force: true }));
  await f.core.close();
  assert.equal(activatePendingRecovery(f.state), true);
  const restored = new Store(f.state);
  try {
    const artifacts = new ArtifactStore(restored);
    assert.deepEqual(artifacts.list(session.id).artifacts.map(a => a.name).sort(), ['note.txt', 'picture.png']);
    assert.equal((await artifacts.bytes(session.id, picture.artifactId, picture.versionId)).data.length > 0, true);
    assert.equal((await artifacts.bytes(session.id, edited.artifactId, edited.versionId)).version.parents[0].versionId, picture.versionId, 'derivations survive');
    await assert.rejects(artifacts.bytes(session.id, note.artifactId, note.versionId), /missing/, 'the tampered bytes were not installed');
    assert.deepEqual(restored.get<any>('recoverySource', {}).artifacts, { artifacts: 2, versions: 3, missingBytes: 1, bytesIncluded: true });
    for (const table of ['workspace_roots', 'change_sets', 'operations', 'budget_reservations']) assert.equal(Number((restored.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n), 0, table);
    assert.equal(restored.settings().paused, true, 'tools stay paused after a restore');
  } finally { restored.close(); }
});

test('DA13 a backup made before forgetting brings back no conversation files', { skip: skipWithoutHelper }, async t => {
  const { f, session } = await populated(t);
  const backup = await f.core.rpc('recovery.backup', { includeContent: true });
  // Forgetting after the backup changes the registry: the backup's content (files included) is withheld.
  await f.core.updateSettings({ memory: { enabled: true } });
  const saved = await f.core.memory.save(session, 'The launch code name is Bluebird.');
  await f.core.memory.forget(session, saved.id);
  const review = await f.core.rpc('recovery.preview', { directory: backup.directory, includeContent: true });
  assert.equal(review.contentAllowed, false); assert.equal(review.artifacts, null); assert.match(review.warning, /files/);
});

test('a backup can leave artifact bytes out; the review says how many would come back without them', { skip: skipWithoutHelper }, async t => {
  const { f } = await populated(t);
  const backup = await f.core.rpc('recovery.backup', { includeContent: true, includeArtifactBytes: false });
  assert.equal(existsSync(join(backup.directory, 'artifacts')), false);
  const review = await f.core.rpc('recovery.preview', { directory: backup.directory, includeContent: true });
  assert.deepEqual(review.artifacts, { artifacts: 2, versions: 3, missingBytes: 3, bytesIncluded: false });
});

test('removing a file can take what was made from it; the default keeps derived files', { skip: skipWithoutHelper }, async t => {
  const { f, session, note, picture } = await populated(t);
  const extracted = await f.core.rpc('artifacts.extract', { sessionId: session.id, artifactId: note.artifactId });
  const derivedId = extracted.extractionArtifact.artifactId;
  assert.ok(derivedId, JSON.stringify(extracted).slice(0, 200));
  assert.deepEqual((await f.core.rpc('artifacts.derived', { sessionId: session.id, artifactId: note.artifactId })).derived.map((d: any) => d.id), [derivedId]);
  const object = f.core.workbench.artifacts.objectPath(f.core.workbench.artifacts.version(session.id, note.artifactId, note.versionId).sha256);
  const removed = await f.core.rpc('artifacts.remove', { sessionId: session.id, artifactId: note.artifactId, scope: 'derived' });
  assert.deepEqual(removed.removed.sort(), [note.artifactId, derivedId].sort());
  assert.equal(existsSync(object), false, 'unreferenced bytes are deleted');
  assert.deepEqual(f.core.workbench.artifacts.list(session.id).artifacts.map(a => a.name), ['picture.png']);
  // The default scope removes only the file itself.
  const thumb = await f.core.rpc('artifacts.thumbnail', { sessionId: session.id, artifactId: picture.artifactId, size: 64 });
  assert.match(thumb.data, /^data:image\/png/);
  await f.core.rpc('artifacts.extract', { sessionId: session.id, artifactId: picture.artifactId });
  await f.core.rpc('artifacts.remove', { sessionId: session.id, artifactId: picture.artifactId });
  assert.deepEqual(f.core.workbench.artifacts.list(session.id).artifacts.map(a => a.name), ['picture (extracted).json'], 'all versions of the picture go; what was made from it stays');
});

test('forgetting a memory removes files whose text holds it and scrubs prompts recorded with images', { skip: skipWithoutHelper }, async t => {
  const { f, session, picture } = await populated(t);
  await writeFile(join(f.directory, 'plan.txt'), 'Notes: The launch code name is Bluebird. Ship in May.\n');
  const plan = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.directory, 'plan.txt') });
  const extraction = (await f.core.rpc('artifacts.extract', { sessionId: session.id, artifactId: plan.artifactId })).extractionArtifact;
  const store = f.core.workbench.artifacts;
  const generated = await store.install({ sessionId: session.id, bytes: await png(16, 16), name: 'poster.png', source: 'model-generation', provenance: { kind: 'generation', prompt: 'A poster saying The launch code name is Bluebird.' } });
  const planBytes = store.objectPath(store.version(session.id, plan.artifactId).sha256);
  await f.core.updateSettings({ memory: { enabled: true } });
  const saved = await f.core.memory.save(session, 'The launch code name is Bluebird.');
  await f.core.memory.forget(session, saved.id);
  const names = store.list(session.id).artifacts.map(a => a.name).sort();
  assert.deepEqual(names, ['note.txt', 'picture.png', 'poster.png'], 'the plan and its extraction are gone');
  assert.equal(existsSync(planBytes), false);
  assert.throws(() => store.artifact(extraction.artifactId), /no longer exists/);
  assert.doesNotMatch(JSON.stringify(store.version(session.id, generated.artifactId).provenance), /Bluebird/);
  assert.ok(store.version(session.id, picture.artifactId));
});
