import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { call, skipWithoutHelper, until, workbenchFixture } from './fixtures/workbench.ts';

const opts = { skip: skipWithoutHelper };
const result = (fixture: any, name: string) => fixture.toolResults().filter((entry: any) => entry.name === name).map((entry: any) => entry.value);
async function waitForChangeApproval(core: Core) {
  await until(() => [...core.approvals.values()].some(item => item.value.kind === 'changeset'));
  return [...core.approvals.values()].find(item => item.value.kind === 'changeset')!.value;
}

test('FS01 a tool-capable Ollama model lists, searches and reads a permitted project without any coding CLI', opts, async t => {
  const f = await workbenchFixture(t, [
    () => call('files_roots'),
    body => { const roots = JSON.parse(body.messages.at(-1).content).data.roots; return call('files_search', { rootId: roots[0].rootId, query: 'TODO' }); },
    () => call('files_read', { path: 'src/app.ts', startLine: 2, lineCount: 2 }),
    () => ({ content: 'The TODO is on line 2.' }),
  ]);
  await mkdir(join(f.project, 'src'));
  await writeFile(join(f.project, 'src/app.ts'), 'const a = 1;\n// TODO fix\nexport { a };\n');
  const { session } = await f.session({});
  assert.ok(!f.core.toolsFor(session.id).some(tool => tool.function.name.startsWith('files_')), 'before the model’s processing route is known, nothing is offered');
  await f.core.workbench.prepare(session.id, new AbortController().signal);
  const offered = f.core.toolsFor(session.id).map(tool => tool.function.name);
  assert.ok(['files_roots', 'files_list', 'files_search', 'files_read'].every(name => offered.includes(name)), 'core file tools are offered');
  assert.ok(!offered.includes('files_propose_changes'), 'a read-only folder offers no change tool');
  assert.ok(!offered.some(name => /^(desktop|sessions|script|screenshot|apps|windows)_/.test(name)), 'Files needs no desktop tools or delegation');
  await f.core.send({ id: session.id, text: 'Where is the TODO?' });
  assert.equal((await f.finished(session.id)).status, 'idle');
  const [search] = result(f, 'files_search'), [read] = result(f, 'files_read');
  assert.equal(search.status, 'completed'); assert.equal(search.data.files[0].path, 'src/app.ts'); assert.equal(search.data.files[0].matches[0].line, 2);
  assert.match(search.data.files[0].version, /^sha256:[0-9a-f]{64}$/);
  assert.equal(read.data.text, '2| // TODO fix\n3| export { a };'); assert.equal(read.data.version, search.data.files[0].version);
  assert.deepEqual(read.citations[0].locator, { startLine: 2, endLine: 3 });
});

test('FS02 traversal, absolute escape, linked file or parent, swapped parent and special files are refused without hanging', opts, async t => {
  const f = await workbenchFixture(t);
  const outside = join(f.directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'secret');
  await writeFile(join(f.project, 'ok.txt'), 'fine\n');
  await symlink(outside, join(f.project, 'linked-dir')); await symlink(join(outside, 'secret.txt'), join(f.project, 'linked-file.txt'));
  execFileSync('mkfifo', [join(f.project, 'pipe')]);
  const { session, root } = await f.session({ write: true, organize: true });
  const read = (path: string) => f.core.rpc('files.read', { sessionId: session.id, rootId: root.id, path });
  await assert.rejects(read('../outside/secret.txt'), /\.\./);
  await assert.rejects(read(join(outside, 'secret.txt')), /outside this workspace folder/);
  await assert.rejects(read('linked-dir/secret.txt'), /symbolic link/);
  await assert.rejects(read('linked-file.txt'), /symbolic link/);
  const started = Date.now();
  await assert.rejects(read('pipe'), /not a regular file/);
  assert.ok(Date.now() - started < 5000, 'a FIFO is refused without being opened for reading');
  // A parent swapped for a link after review cannot redirect the write.
  await mkdir(join(f.project, 'docs')); await writeFile(join(f.project, 'docs/readme.md'), 'v1\n');
  const review = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'create_text', rootId: root.id, path: 'docs/new.md', content: 'hello\n' }] });
  await rename(join(f.project, 'docs'), join(f.project, 'docs-real')); await symlink(outside, join(f.project, 'docs'));
  const applied = await f.core.rpc('changes.apply', { id: review.id, digest: review.digest });
  assert.equal(applied.status, 'failed'); assert.match(applied.results[0].outcome.message, /symbolic link/);
  assert.deepEqual((await readdir(outside)).sort(), ['secret.txt'], 'nothing was written outside the root');
  await assert.rejects(f.core.rpc('workspace.addRoot', { sessionId: session.id, path: '/' }), /whole filesystem/);
  await assert.rejects(f.core.rpc('workspace.addRoot', { sessionId: session.id, path: f.state }), /private state/);
});

test('FS03/FS04 a change to the base makes a proposal stale; two proposals on one base apply at most once', opts, async t => {
  const f = await workbenchFixture(t);
  await writeFile(join(f.project, 'a.txt'), 'one\ntwo\n');
  const { session, root } = await f.session();
  const propose = (newText: string) => f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'patch_text', rootId: root.id, path: 'a.txt', edits: [{ oldText: 'two', newText }] }] });
  const first = await propose('TWO'), second = await propose('deux');
  assert.equal((await f.core.rpc('changes.apply', { id: first.id, digest: first.digest })).status, 'applied');
  const conflict = await f.core.rpc('changes.apply', { id: second.id, digest: second.digest });
  assert.equal(conflict.status, 'failed'); assert.match(conflict.results[0].outcome.message, /changed since review/);
  assert.equal(await readFile(join(f.project, 'a.txt'), 'utf8'), 'one\nTWO\n');
  const third = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'patch_text', rootId: root.id, path: 'a.txt', edits: [{ oldText: 'TWO', newText: '2' }] }] });
  await writeFile(join(f.project, 'a.txt'), 'external edit\n');
  const stale = await f.core.rpc('changes.apply', { id: third.id, digest: third.digest });
  assert.equal(stale.status, 'failed'); assert.equal(await readFile(join(f.project, 'a.txt'), 'utf8'), 'external edit\n', 'the external content is preserved');
  await assert.rejects(f.core.rpc('changes.apply', { id: third.id, digest: third.digest }), /failed; nothing was applied/, 'a change set applies once');
  await writeFile(join(f.project, 'b.txt'), 'b\n');
  const fresh = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'patch_text', rootId: root.id, path: 'b.txt', content: 'B\n' }] });
  await assert.rejects(f.core.rpc('changes.apply', { id: fresh.id, digest: 'not-the-reviewed-digest' }), /does not match the reviewed one/);
  assert.equal(await readFile(join(f.project, 'b.txt'), 'utf8'), 'b\n');
});

test('FS05 revoking a folder while its review waits retires the review and commits nothing; Stop and expiry resolve cleanly', opts, async t => {
  const f = await workbenchFixture(t, [
    () => call('files_propose_changes', { operations: [{ kind: 'create_text', path: 'new.txt', content: 'x\n' }], reason: 'Add a file' }),
    () => ({ content: 'ok' }),
  ]);
  const { session, root } = await f.session();
  await f.core.send({ id: session.id, text: 'Make a file' });
  const approval = await waitForChangeApproval(f.core);
  assert.equal(f.core.store.session(session.id).status, 'waiting');
  await f.core.rpc('workspace.updateRoot', { sessionId: session.id, rootId: root.id, policy: { write: false } });
  await f.finished(session.id);
  assert.ok(!f.core.approvals.has(approval.id));
  const [proposal] = result(f, 'files_propose_changes');
  assert.equal(proposal.status, 'declined'); assert.match(proposal.summary, /permissions changed/);
  await assert.rejects(stat(join(f.project, 'new.txt')), /ENOENT/);
  assert.equal(f.core.workbench.changes.get(proposal.data.changeSetId).status, 'revoked');
  // Stop while a review waits: the call resolves as declined, nothing is written.
  await f.core.rpc('workspace.updateRoot', { sessionId: session.id, rootId: root.id, policy: { write: true } });
  f.requests.length = 0;
  await f.core.send({ id: session.id, text: 'Again' });
  await waitForChangeApproval(f.core);
  await f.core.stop(session.id); await f.finished(session.id);
  const sets = f.core.workbench.changes.list(session.id);
  assert.equal(sets[0].status, 'declined'); await assert.rejects(stat(join(f.project, 'new.txt')), /ENOENT/);
});

test('FS06 a destination that appears during review is never clobbered; FS11 encodings, CRLF and odd names survive', opts, async t => {
  const f = await workbenchFixture(t);
  const { session, root } = await f.session();
  const created = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'create_text', rootId: root.id, path: 'report.md', content: 'mine\n' }] });
  await writeFile(join(f.project, 'report.md'), 'theirs\n');
  const outcome = await f.core.rpc('changes.apply', { id: created.id, digest: created.digest });
  assert.equal(outcome.status, 'failed'); assert.match(outcome.results[0].outcome.message, /already exists/);
  assert.equal(await readFile(join(f.project, 'report.md'), 'utf8'), 'theirs\n');
  const name = 'naïve résumé — ünïcode [1] $(touch x) `id`.txt';
  await writeFile(join(f.project, name), 'línea uno\r\nlínea dos\r\nfin', 'utf8');
  const read = await f.core.rpc('files.read', { sessionId: session.id, rootId: root.id, path: name });
  assert.equal(read.newline, 'crlf'); assert.equal(read.endsWithNewline, false); assert.equal(read.text, '1| línea uno\n2| línea dos\n3| fin');
  const patch = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'patch_text', rootId: root.id, path: name, baseVersion: read.version, edits: [{ oldText: 'línea dos\nfin', newText: 'línea 2\nfin' }] }] });
  assert.equal((await f.core.rpc('changes.apply', { id: patch.id, digest: patch.digest })).status, 'applied');
  assert.equal(await readFile(join(f.project, name), 'utf8'), 'línea uno\r\nlínea 2\r\nfin', 'CRLF and the missing final newline are preserved');
  await assert.rejects(stat(join(f.project, 'x')), /ENOENT/, 'a name is never interpreted as a command');
  await writeFile(join(f.project, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
  const binary = await f.core.rpc('files.read', { sessionId: session.id, rootId: root.id, path: 'blob.bin' });
  assert.equal(binary.binary, true); assert.equal(binary.text, undefined);
});

test('FS07 a restart during a multi-file change records per-file outcomes and replays nothing', opts, async t => {
  const f = await workbenchFixture(t);
  const { session, root } = await f.session();
  const review = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [
    { kind: 'create_text', rootId: root.id, path: 'one.txt', content: '1\n' }, { kind: 'create_text', rootId: root.id, path: 'two.txt', content: '2\n' } ] });
  // Simulate a crash after the first commit and during the second.
  const store = f.core.store;
  store.db.prepare("UPDATE change_sets SET status='applying', data=json_set(data,'$.status','applying') WHERE id=?").run(review.id);
  store.db.prepare("UPDATE change_operations SET outcome='{\"state\":\"committed\"}' WHERE change_set_id=? AND idx=0").run(review.id);
  store.db.prepare("UPDATE change_operations SET outcome='{\"state\":\"committing\"}' WHERE change_set_id=? AND idx=1").run(review.id);
  await f.core.close();
  const reopened = new Core(new Store(f.state));
  t.after(() => reopened.close());
  const after = reopened.workbench.changes.review(review.id);
  assert.equal(after.status, 'unknown');
  assert.deepEqual(after.operations.map((op: any) => op.outcome.state), ['committed', 'unknown']);
  assert.match(after.operations[1].outcome.message!, /nothing is retried/);
  await assert.rejects(stat(join(f.project, 'two.txt')), /ENOENT/, 'the interrupted operation is not replayed');
});

test('FS08 a move to another filesystem that cannot remove the original reports both copies', { skip: skipWithoutHelper || (process.getuid?.() === 0 ? 'permission bits do not bind root' : false) }, async t => {
  const f = await workbenchFixture(t);
  const devices = new Map<number, string>();
  // Only private locations: never the real home folder outside the isolated test desktop.
  for (const candidate of [f.directory, tmpdir(), '/dev/shm', ...(process.env.CERE_VIRTUAL_DESKTOP === '1' ? [homedir()] : [])]) { try { const info = statSync(candidate); if (!devices.has(info.dev)) devices.set(info.dev, candidate); } catch { /* absent */ } }
  const other = [...devices.entries()].find(([dev]) => dev !== statSync(f.project).dev);
  if (!other) return t.skip('no second filesystem is available here');
  const second = await (await import('node:fs/promises')).mkdtemp(join(other[1], 'cere-xdev-'));
  t.after(() => rm(second, { recursive: true, force: true }));
  const { session, root } = await f.session();
  const target = await f.core.rpc('workspace.addRoot', { sessionId: session.id, path: second, policy: { write: true, organize: true } });
  await mkdir(join(f.project, 'locked')); await writeFile(join(f.project, 'locked/data.txt'), 'payload\n');
  const review = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'move', rootId: root.id, from: 'locked/data.txt', toRootId: target.id, to: 'data.txt' }] });
  await chmod(join(f.project, 'locked'), 0o555);
  const outcome = await f.core.rpc('changes.apply', { id: review.id, digest: review.digest }).finally(() => chmod(join(f.project, 'locked'), 0o755));
  assert.equal(outcome.status, 'partial'); assert.equal(outcome.results[0].outcome.state, 'partial');
  assert.match(outcome.results[0].outcome.message, /Both copies exist/);
  assert.equal(await readFile(join(second, 'data.txt'), 'utf8'), 'payload\n'); assert.equal(await readFile(join(f.project, 'locked/data.txt'), 'utf8'), 'payload\n');
});

test('FS09 undo restores Cere’s exact output, and offers a copy instead of overwriting a newer external edit', opts, async t => {
  const f = await workbenchFixture(t);
  await writeFile(join(f.project, 'notes.txt'), 'original\n'); await writeFile(join(f.project, 'keep.txt'), 'keep\n');
  const { session, root } = await f.session();
  const review = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [
    { kind: 'patch_text', rootId: root.id, path: 'notes.txt', content: 'edited by Cere\n' }, { kind: 'trash', rootId: root.id, path: 'keep.txt' }, { kind: 'create_text', rootId: root.id, path: 'sub/new.txt', content: 'n\n' } ] });
  assert.deepEqual(review.operations.map((op: any) => op.kind), ['patch_text', 'trash', 'mkdir', 'create_text'], 'a missing parent folder becomes an explicit operation');
  assert.equal((await f.core.rpc('changes.apply', { id: review.id, digest: review.digest })).status, 'applied');
  await assert.rejects(stat(join(f.project, 'keep.txt')), /ENOENT/);
  assert.equal((await f.core.rpc('changes.trash', { sessionId: session.id })).length, 1, 'the trashed file is kept privately');
  await writeFile(join(f.project, 'notes.txt'), 'edited by Cere, then by someone else\n');
  const undo = await f.core.rpc('changes.undo', { id: review.id });
  assert.deepEqual(undo.operations.map((op: any) => [op.kind, op.path]), [['trash', 'sub/new.txt'], ['remove_folder', 'sub'], ['restore', 'keep.txt'], ['create_text', 'notes (restored).txt']]);
  assert.match(undo.operations[3].review.notes[0], /restored beside it/, 'the newer external edit is not overwritten');
  assert.deepEqual(undo.operations[1].dependsOn, [0]);
  const applied = await f.core.rpc('changes.apply', { id: undo.id, digest: undo.digest });
  assert.equal(applied.status, 'applied');
  assert.equal(await readFile(join(f.project, 'keep.txt'), 'utf8'), 'keep\n');
  await assert.rejects(stat(join(f.project, 'sub')), /ENOENT/);
  assert.equal(await readFile(join(f.project, 'notes.txt'), 'utf8'), 'edited by Cere, then by someone else\n');
  assert.equal(await readFile(join(f.project, 'notes (restored).txt'), 'utf8'), 'original\n');
  await assert.rejects(f.core.rpc('changes.undo', { id: review.id }), /Nothing|safely|left/, 'undo never replays over newer state');
});

test('FS10 a large tree and pathological searches stay bounded and say they were bounded', opts, async t => {
  const f = await workbenchFixture(t);
  for (let d = 0; d < 26; d++) { await mkdir(join(f.project, `d${d}`)); await Promise.all(Array.from({ length: 400 }, (_, i) => writeFile(join(f.project, `d${d}`, `f${i}.txt`), i % 97 ? 'plain\n' : 'needle\n'))); }
  await mkdir(join(f.project, 'node_modules')); await writeFile(join(f.project, 'node_modules/x.txt'), 'needle\n');
  const { session, root } = await f.session({});
  const started = Date.now();
  const found = await f.core.rpc('files.search', { sessionId: session.id, rootId: root.id, query: 'needle' });
  assert.equal(found.complete, false); assert.match(found.stoppedBecause, /traversal limit|match limit/); assert.ok(found.nextCursor);
  assert.ok(!found.files.some((file: any) => file.path.startsWith('node_modules/')), 'dependency caches are skipped');
  const next = await f.core.rpc('files.search', { sessionId: session.id, rootId: root.id, query: 'needle', cursor: found.nextCursor });
  assert.ok(!next.files.some((file: any) => found.files.some((seen: any) => seen.path === file.path)), 'a cursor continues without repeating');
  const regex = await f.core.rpc('files.search', { sessionId: session.id, rootId: root.id, query: '(a+)+$', mode: 'regex' }).catch((error: Error) => ({ error: error.message }));
  assert.ok(!('error' in regex) || /ripgrep/.test((regex as any).error));
  assert.ok(Date.now() - started < 30_000, 'bounded in time');
  const page = await f.core.rpc('files.list', { sessionId: session.id, rootId: root.id, path: 'd0', limit: 50 });
  assert.equal(page.entries.length, 50); assert.ok(page.nextCursor);
});

test('FS12 ordinary hidden configuration is readable when named; credential files and VCS internals never are', opts, async t => {
  const f = await workbenchFixture(t, [() => call('files_read', { path: '.env' }), () => call('files_read', { path: '.gitignore' }), () => call('files_read', { path: '.git/config' }), () => ({ content: 'ok' })]);
  await writeFile(join(f.project, '.gitignore'), 'dist/\n'); await writeFile(join(f.project, '.env'), 'TOKEN=abc\n');
  await mkdir(join(f.project, '.git')); await writeFile(join(f.project, '.git/config'), '[remote "origin"]\nurl = https://token@example.com/x\n');
  const { session, root } = await f.session({});
  const listing = await f.core.rpc('files.list', { sessionId: session.id, rootId: root.id });
  assert.ok(!listing.entries.some((entry: any) => entry.name.startsWith('.')), 'hidden files are not listed unless the folder allows them'); assert.ok(listing.hiddenSkipped >= 3);
  await f.core.send({ id: session.id, text: 'look' }); await f.finished(session.id);
  const reads = result(f, 'files_read');
  assert.equal(reads[0].status, 'failed'); assert.equal(reads[0].error.code, 'credential');
  assert.equal(reads[1].status, 'completed'); assert.equal(reads[1].data.text, '1| dist/');
  assert.equal(reads[2].status, 'failed'); assert.equal(reads[2].error.code, 'vcs-internal');
  assert.doesNotMatch(JSON.stringify(f.requests), /TOKEN=abc|token@example/);
  const found = await f.core.rpc('files.search', { sessionId: session.id, rootId: root.id, query: 'TOKEN' });
  assert.deepEqual(found.files, []);
});

test('FS13 replacing a hard-linked file never changes the other link', opts, async t => {
  const f = await workbenchFixture(t);
  const outside = join(f.directory, 'alias.txt');
  await writeFile(join(f.project, 'shared.txt'), 'same\n'); await link(join(f.project, 'shared.txt'), outside);
  const { session, root } = await f.session();
  const info = await f.core.rpc('files.stat', { sessionId: session.id, rootId: root.id, path: 'shared.txt' });
  assert.match(info.linkNote, /other links keep the old content/);
  const review = await f.core.rpc('changes.propose', { sessionId: session.id, operations: [{ kind: 'patch_text', rootId: root.id, path: 'shared.txt', content: 'changed\n' }] });
  assert.ok(review.operations[0].review.notes.some((note: string) => /hard links/.test(note)));
  assert.equal((await f.core.rpc('changes.apply', { id: review.id, digest: review.digest })).status, 'applied');
  assert.equal(await readFile(join(f.project, 'shared.txt'), 'utf8'), 'changed\n'); assert.equal(await readFile(outside, 'utf8'), 'same\n');
});

test('FS14 a model cannot reach apply, grant or root RPCs, and only a user decision applies its proposal', opts, async t => {
  const f = await workbenchFixture(t, [
    () => call('changes_apply', { id: 'x' }), () => call('workspace_grantEdits', {}), () => call('workspace_addRoot', { path: '/' }),
    () => call('files_propose_changes', { operations: [{ kind: 'create_text', path: 'a.txt', content: 'a\n' }], reason: 'Add a' }), () => ({ content: 'ok' }),
  ]);
  const { session } = await f.session();
  await f.core.send({ id: session.id, text: 'go' });
  const approval = await waitForChangeApproval(f.core);
  assert.throws(() => f.core.answer({ id: approval.id, choice: 'allow', digest: 'forged' }), /changed/);
  await f.core.rpc('changes.apply', { id: approval.fields!.changeSetId, digest: approval.fields!.digest });
  await f.finished(session.id);
  const results = f.toolResults();
  for (const name of ['changes_apply', 'workspace_grantEdits', 'workspace_addRoot']) assert.match(JSON.stringify(results.find((r: any) => r.name === name)?.value), /not offered|disabled/, name);
  const [proposal] = result(f, 'files_propose_changes');
  assert.equal(proposal.data.status, 'applied'); assert.equal(proposal.data.decidedBy, 'user');
  assert.equal(await readFile(join(f.project, 'a.txt'), 'utf8'), 'a\n');
});

test('a bounded edit grant applies small text edits in its scope, and nothing else', opts, async t => {
  const f = await workbenchFixture(t, [
    () => call('files_propose_changes', { operations: [{ kind: 'create_text', path: 'docs/a.md', content: 'a\n' }], reason: 'Doc' }),
    () => call('files_propose_changes', { operations: [{ kind: 'create_text', path: 'src/b.ts', content: 'b\n' }], reason: 'Code' }),
    () => ({ content: 'ok' }),
  ]);
  await mkdir(join(f.project, 'docs')); await mkdir(join(f.project, 'src'));
  const { session, root } = await f.session();
  const grant = await f.core.rpc('workspace.grantEdits', { sessionId: session.id, rootId: root.id, paths: ['docs'], minutes: 5, maxOperations: 3 });
  await f.core.send({ id: session.id, text: 'go' });
  const approval = await waitForChangeApproval(f.core);
  assert.deepEqual(approval.fields?.operations, 1, 'only the out-of-scope proposal waits for review');
  await f.core.rpc('changes.decline', { id: approval.fields!.changeSetId });
  await f.finished(session.id);
  const [granted, outside] = result(f, 'files_propose_changes');
  assert.equal(granted.data.decidedBy, 'grant'); assert.equal(outside.status, 'declined');
  assert.equal(await readFile(join(f.project, 'docs/a.md'), 'utf8'), 'a\n'); await assert.rejects(stat(join(f.project, 'src/b.ts')), /ENOENT/);
  assert.ok(f.core.workbench.revokeGrant(grant.id));
});

test('DA14 upgrading with broad bypasses and old tool-enabled conversations grants no Workbench power', opts, async t => {
  const f = await workbenchFixture(t);
  const legacy = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, tools: true, trusted: true });
  await f.core.updateSettings({ bypassCliPermissions: true, bypassComputerPermissions: true, profile: 'broad', categories: ['apps', 'windows'] });
  await f.core.close();
  const core = new Core(new Store(f.state)); t.after(() => core.close());
  const session = core.store.session(legacy.id);
  assert.equal(session.capabilities, undefined);
  const offered = core.toolsFor(session.id).map(tool => tool.function.name);
  assert.ok(offered.includes('files_open'), 'the old desktop tools stay as they were');
  assert.deepEqual(offered.filter(name => core.workbench.registry.has(name)), [], 'no Workbench tool is offered');
  assert.equal(core.automaticallyApprove(session.id, { kind: 'changeset', choices: ['allow', 'deny'] }), false, 'no older bypass answers a change set');
  assert.ok(core.store.get('schema-before-workbench', null), 'the schema the migration started from is recorded');
  for (const table of ['workspace_roots', 'change_sets', 'artifacts', 'operations', 'provider_connections', 'usage_records']) assert.ok(core.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table), table);
  assert.equal(Number(core.store.db.prepare('SELECT count(*) AS n FROM workspace_roots').get()!.n), 0);
});

test('switching a conversation to a cloud model withholds earlier file content from folders limited to local models', opts, async t => {
  const f = await workbenchFixture(t, [() => call('files_read', { path: 'private.txt' }), () => ({ content: 'read it' }), () => ({ content: 'cloud reply' })]);
  await writeFile(join(f.project, 'private.txt'), 'private-marker-7731\n');
  const { session } = await f.session({});
  await f.core.send({ id: session.id, text: 'read it' }); await f.finished(session.id);
  assert.match(JSON.stringify(f.requests.at(-1)), /private-marker-7731/);
  await f.core.configureSession({ id: session.id, model: 'cloudy:cloud', tools: false });
  await f.core.send({ id: session.id, text: 'summarize' }); await f.finished(session.id);
  const last = JSON.stringify(f.requests.at(-1));
  assert.doesNotMatch(last, /private-marker-7731/); assert.match(last, /withheld/);
  assert.ok(!f.core.toolsFor(session.id).some(tool => tool.function.name === 'files_read'), 'a local-only folder offers no read tool to a cloud model');
});

test('M1 exit: a tool-capable Ollama model and an API adapter complete the identical file task without a coding CLI', opts, async t => {
  // The task: read the file, propose an exact edit against the version read, then report the outcome.
  const plan = (last: any, index: number): { name: string; args: Record<string, unknown> } | { content: string } =>
    index === 0 ? { name: 'files_read', args: { path: 'src/app.ts' } }
    : index === 1 ? { name: 'files_propose_changes', args: { operations: [{ kind: 'patch_text', path: 'src/app.ts', baseVersion: last.data.version, edits: [{ oldText: '// TODO fix', newText: '// fixed' }] }], reason: 'Resolve the TODO' } }
    : { content: `Change set ${last.data.status}.` };
  const lastResult = (messages: any[]) => { const tool = [...messages].reverse().find((m: any) => m.role === 'tool'); return tool ? JSON.parse(tool.content) : null; };
  const approveWhenAsked = async (core: Core) => { const approval = await waitForChangeApproval(core); await core.rpc('changes.apply', { id: approval.fields!.changeSetId, digest: approval.fields!.digest }); };
  const outcomes: string[] = [];
  // Ollama.
  const f = await workbenchFixture(t, [0, 1, 2].map(index => (body: any) => { const step = plan(lastResult(body.messages), index); return 'content' in step ? { content: step.content } : call(step.name, step.args); }));
  await mkdir(join(f.project, 'src')); await writeFile(join(f.project, 'src/app.ts'), 'const a = 1;\n// TODO fix\n');
  const { session } = await f.session({ write: true });
  await f.core.send({ id: session.id, text: 'Fix the TODO' }); await approveWhenAsked(f.core);
  assert.equal((await f.finished(session.id)).status, 'idle');
  outcomes.push(await readFile(join(f.project, 'src/app.ts'), 'utf8'));
  // The compatible-endpoint API dialect (OpenAI chat completions), declared to process on the user's own server.
  const requests: any[] = [];
  const { createServer } = await import('node:http');
  const http = createServer((req, res) => {
    let text = ''; req.on('data', data => text += data);
    req.on('end', () => {
      const body = text ? JSON.parse(text) : {}; requests.push(body);
      res.setHeader('Content-Type', 'application/json');
      if (!req.url?.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
      const index = requests.filter(r => r.messages).length - 1, step = plan(lastResult(body.messages), Math.min(index, 2));
      const message = 'content' in step ? { role: 'assistant', content: step.content } : { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + index, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
      res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: 'content' in step ? 'stop' : 'tool_calls' }] }));
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  await f.core.updateSettings({ compatible: { baseUrl: `http://127.0.0.1:${(http.address() as any).port}/v1`, label: 'Fixture', requiresKey: false, tools: true, streaming: false, processing: 'remote' } });
  await writeFile(join(f.project, 'src/app.ts'), 'const a = 1;\n// TODO fix\n');
  const api = await f.core.create({ provider: 'compatible', model: 'fixture-model', cwd: f.project, capabilities: { files: true } });
  await f.core.rpc('workspace.addRoot', { sessionId: api.id, path: f.project, policy: { write: true, destinations: { remote: true } } });
  await f.core.send({ id: api.id, text: 'Fix the TODO' }); await approveWhenAsked(f.core);
  assert.equal((await f.finished(api.id)).status, 'idle', f.core.store.session(api.id).error);
  outcomes.push(await readFile(join(f.project, 'src/app.ts'), 'utf8'));
  assert.deepEqual(outcomes, ['const a = 1;\n// fixed\n', 'const a = 1;\n// fixed\n']);
  const sent = requests.filter(r => r.messages);
  assert.ok(sent[0].tools.some((tool: any) => tool.function.name === 'files_read'), 'the API request carried the file tools');
  assert.match(sent.at(-1).messages.at(-1).content, /"status":"applied"/);
});

test('a call refused as never retryable is not run again in the same turn; the model is told to stop', { skip: skipWithoutHelper }, async t => {
  const trash = { operations: [{ kind: 'trash', rootId: '', path: 'notes.txt' }], reason: 'Replace the file' };
  const f = await workbenchFixture(t, [() => call('files_propose_changes', trash), () => call('files_propose_changes', trash), () => ({ content: 'I need the Organize permission.' })]);
  await writeFile(join(f.project, 'notes.txt'), 'Status: draft\n');
  const { session, root } = await f.session({ write: true });
  trash.operations[0].rootId = root.id;
  await f.core.send({ id: session.id, text: 'Change the status' }); await f.finished(session.id);
  const [first, second] = f.toolResults().filter((r: any) => r.name === 'files_propose_changes').map((r: any) => r.value);
  assert.equal(first.error.code, 'denied'); assert.match(first.summary, /propose a patch_text operation/, 'a write-enabled folder points to the edit that is allowed');
  assert.equal(second.error.code, 'repeated_refusal'); assert.match(second.summary, /stop calling it/);
});

test('11.2 files_replace_text gives small models one focused edit that goes through the same review', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t, [() => call('files_replace_text', { path: 'notes.txt', oldText: 'Status: draft', newText: 'Status: final', reason: 'Mark it final' }), () => ({ content: 'Proposed.' })]);
  await writeFile(join(f.project, 'notes.txt'), 'Status: draft\nOwner: me\n');
  const { session } = await f.session({ write: true });
  await f.core.send({ id: session.id, text: 'Mark it final' });
  await until(() => [...f.core.approvals.values()].some(entry => entry.value.kind === 'changeset'));
  const approval = [...f.core.approvals.values()].map(entry => entry.value).find(value => value.kind === 'changeset')!;
  const review = await f.core.rpc('changes.review', { id: approval.fields!.changeSetId });
  assert.deepEqual(review.operations.map((op: any) => [op.kind, op.path]), [['patch_text', 'notes.txt']]);
  assert.equal(await readFile(join(f.project, 'notes.txt'), 'utf8'), 'Status: draft\nOwner: me\n', 'nothing changes before the review');
  f.core.answer({ id: approval.id, choice: 'allow', operations: review.operations.map((_op: any, index: number) => index), digest: review.digest, reviewComplete: true } as any);
  await f.finished(session.id);
  assert.equal(await readFile(join(f.project, 'notes.txt'), 'utf8'), 'Status: final\nOwner: me\n');
});
