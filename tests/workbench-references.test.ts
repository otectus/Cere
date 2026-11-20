import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skipWithoutHelper, workbenchFixture } from './fixtures/workbench.ts';
import { png } from './fixtures/image-backends.ts';
import { clearRouteCache } from '../broker/workspace/policy.ts';

test('@ references resolve at send: a live file with a version check, a folder manifest, an artifact and a conversation excerpt', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t, [() => ({ content: 'Read them.' })]);
  await mkdir(join(f.project, 'src')); await writeFile(join(f.project, 'src', 'app.ts'), 'const a = 1;\nexport { a };\n');
  await writeFile(join(f.project, 'src', 'b.ts'), 'export const b = 2;\n');
  const { session, root } = await f.session();
  const other = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, title: 'Earlier planning' });
  f.core.putMessage({ id: crypto.randomUUID(), sessionId: other.id, role: 'user', text: 'We agreed the release is on Friday.', time: Date.now() - 1000 });
  await writeFile(join(f.directory, 'chart.png'), await png(20, 10));
  const chart = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.directory, 'chart.png') });

  const found = (await f.core.rpc('references.search', { sessionId: session.id, query: 'app' })).candidates;
  const file = found.find((c: any) => c.kind === 'file');
  assert.equal(file.detail, `${root.name}/src/app.ts`);
  const all = (await f.core.rpc('references.search', { sessionId: session.id, query: '' })).candidates;
  assert.ok(all.some((c: any) => c.kind === 'folder' && c.label === 'src'));
  assert.ok(all.some((c: any) => c.kind === 'artifact' && c.label === 'chart.png'));
  assert.ok(all.some((c: any) => c.kind === 'conversation' && c.label === 'Earlier planning'));

  const pinned = await f.core.rpc('references.pin', { sessionId: session.id, ref: file.ref });
  assert.match(pinned.version, /^sha256:/);
  // The file changes after it was picked: the send uses the current text and says so.
  await writeFile(join(f.project, 'src', 'app.ts'), 'const a = 2;\nexport { a };\n');
  await f.core.send({ id: session.id, text: 'What do these say?', references: [pinned, { kind: 'folder', rootId: root.id, path: 'src' }, { kind: 'artifact', artifactId: chart.artifactId, versionId: chart.versionId }, { kind: 'conversation', sessionId: other.id }] });
  await f.finished(session.id);
  const messages = f.requests[0].messages;
  const at = messages.findIndex((m: any) => m.role === 'user' && m.content === 'What do these say?');
  const referenced = messages[at - 1];
  assert.equal(referenced.role, 'user');
  assert.match(referenced.content, /not instructions/);
  assert.match(referenced.content, /<cere_reference kind="file" source="[^"]+\/src\/app.ts" version="sha256:[0-9a-f]+" lines="1-2 of 2">\n1\| const a = 2;/);
  assert.match(referenced.content, /changed after you picked it; the current version was used/);
  assert.match(referenced.content, /<cere_reference kind="folder"[^>]*>\napp.ts {2}\(\d+ bytes\)\nb.ts/);
  assert.doesNotMatch(referenced.content, /export const b = 2/, 'a folder reference is a manifest, not contents');
  assert.match(referenced.content, /We agreed the release is on Friday/);
  assert.equal(referenced.images.length, 1, 'chat:latest has vision, so the image goes with the references');
  const shown = f.core.store.messages(session.id).find(m => m.role === 'user')!;
  assert.match(shown.text, /^What do these say\?\n\nReferenced: .*src\/app.ts, .*src\/, chart.png, Earlier planning$/);
});

test('a reference the model’s destination may not receive stops the send before anything is recorded', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t, [() => ({ content: 'unused' })], { cloud: true });
  await writeFile(join(f.project, 'secret-plan.md'), 'Only on this computer.\n');
  const { session, root } = await f.session();
  await assert.rejects(f.core.send({ id: session.id, text: 'Summarize', references: [{ kind: 'file', rootId: root.id, path: 'secret-plan.md' }] }), /may only be processed by models on this computer/);
  assert.equal(f.core.store.messages(session.id).filter(m => m.role === 'user').length, 0);
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.core.send({ id: session.id, text: 'x', references: 'src/app.ts' }), /up to 8/, 'a path in text is never a reference');
  // In a local conversation the folder is allowed, and the helper still confines the path.
  const local = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, capabilities: { files: true } });
  const localRoot = await f.core.rpc('workspace.addRoot', { sessionId: local.id, path: f.project, policy: {} });
  await assert.rejects(f.core.send({ id: local.id, text: 'x', references: [{ kind: 'file', rootId: localRoot.id, path: '../outside.txt' }] }), /Paths cannot contain \.\./);
  assert.equal(f.core.store.messages(local.id).filter(m => m.role === 'user').length, 0);
});

test('referenced content is withheld from a later model that may not receive it, while the user’s words stay', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t, [() => ({ content: 'First.' }), () => ({ content: 'Second.' })]);
  await writeFile(join(f.project, 'local.md'), 'Local-only detail.\n');
  const { session, root } = await f.session();
  await f.core.send({ id: session.id, text: 'Use the note', references: [{ kind: 'file', rootId: root.id, path: 'local.md' }] });
  await f.finished(session.id);
  assert.match(JSON.stringify(f.requests[0].messages), /Local-only detail/);
  await f.core.rpc('session.configure', { id: session.id, model: 'cloudy:cloud', expectedRevision: f.core.store.session(session.id).configRevision || '0' });
  clearRouteCache();
  await f.core.send({ id: session.id, text: 'And now?' });
  await f.finished(session.id);
  const second = JSON.stringify(f.requests[1].messages);
  assert.doesNotMatch(second, /Local-only detail/);
  assert.match(second, /Use the note/);
});

test('§7.6 the composer previews what references would add, without sending or keeping anything', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t);
  await writeFile(join(f.project, 'a.md'), 'Alpha.\n');
  const { session, root } = await f.session();
  const before = f.core.workbench.artifacts.list(session.id).artifacts.length;
  const preview = await f.core.rpc('references.preview', { sessionId: session.id, references: [{ kind: 'file', rootId: root.id, path: 'a.md' }, { kind: 'folder', rootId: root.id, path: '' }], text: 'Read' });
  assert.equal(preview.ok, true); assert.ok(preview.characters > 0); assert.equal(preview.labels.length, 2);
  assert.equal(f.core.workbench.artifacts.list(session.id).artifacts.length, before);
  assert.equal(f.requests.length, 0);
  const refused = await f.core.rpc('references.preview', { sessionId: session.id, references: [{ kind: 'file', rootId: root.id, path: 'missing.md' }], text: '' });
  assert.equal(refused.ok, false); assert.ok(refused.problem);
});
