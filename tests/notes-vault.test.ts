import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { NotesVault, frontMatter, privateNote, readNote } from '../broker/notes-vault.ts';
import { confinedPath, lineDiff } from '../broker/file-proposals.ts';

test('M07 front matter privacy fails closed', () => {
  assert.deepEqual(frontMatter('---\ntitle: Plan\ntags: [work, q4]\naliases:\n  - roadmap\n---\nBody'), { title: 'Plan', tags: ['work', 'q4'], aliases: ['roadmap'] });
  assert.equal(frontMatter('No front matter'), undefined);
  assert.equal(frontMatter('---\nnested:\n  key: value\n---'), null, 'structures Cere cannot read are unreadable');
  for (const meta of [{ private: true }, { cere: false }, { cere: 'private' }, { visibility: 'team' }, { privacy: 'confidential' }, null]) assert.equal(privateNote(meta as any), true, JSON.stringify(meta));
  for (const meta of [{ visibility: 'public' }, { title: 'x' }, undefined]) assert.equal(privateNote(meta as any), false, JSON.stringify(meta));
});

test('RC-01 privacy fails closed however a note was saved', () => {
  const privateCases = {
    crlf: '---\r\nprivate: true\r\n---\r\nbody', cr: '---\rprivate: true\r---\rbody', bom: '﻿---\nprivate: true\n---\nbody',
    trailingSpaceFence: '--- \nprivate: true\n---\nbody', yes: '---\nprivate: yes\n---\nbody', on: '---\nprivate: on\n---\nbody',
    one: '---\nprivate: 1\n---\nbody', quotedTrue: '---\nprivate: "true"\n---\nbody', upperKey: '---\nPrivate: True\n---\nbody',
    dotsEnd: '---\nprivate: true\n...\nbody', spacedDotsEnd: '---\nprivate: true\n... \nbody', empty: '---\nprivate:\n---\nbody',
    unknownCere: '---\ncere: maybe\n---\nbody', upperVisibility: '---\nVisibility: Team\n---\nbody',
  };
  for (const [name, text] of Object.entries(privateCases)) assert.equal(privateNote(frontMatter(text)), true, name);
  for (const text of ['---\ndate created: 2026-01-01\nprivate: true\n---\nbody', '---\nmeta:\n  owner: me\n---\nbody', '---\r\nprivate: true\r\nbody']) assert.equal(frontMatter(text), null, JSON.stringify(text));
  for (const value of ['false', 'no', 'off', 'No', '"false"']) assert.equal(privateNote(frontMatter(`---\nprivate: ${value}\n---\nbody`)), false, value);
  for (const value of ['true', 'yes', 'include']) assert.equal(privateNote(frontMatter(`---\ncere: ${value}\n---\nbody`)), false, value);
  const crlf = readNote('﻿---\r\ntitle: Plan\r\ntags: [work]\r\n---\r\n# Plan\r\nBody text');
  assert.deepEqual(crlf, { meta: { title: 'Plan', tags: ['work'] }, body: '\n# Plan\nBody text' }, 'front matter never reaches the body');
  assert.deepEqual(readNote('---\ntags: [a]\n---\n# T\nx'), { meta: { tags: ['a'] }, body: '\n# T\nx' }, 'LF notes read as before');
  assert.deepEqual(readNote('# No front matter\nx'), { meta: undefined, body: '# No front matter\nx' });
  assert.deepEqual(readNote('---\n---\nx'), { meta: {}, body: '\nx' }, 'empty front matter is no privacy metadata');
});

test('RC-01 the vault never searches, reads or edits a private note, whatever its line endings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cere-vault-privacy-')), vault = join(root, 'vault');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(vault);
  const notes: Record<string, string> = {
    'crlf.md': '---\r\nprivate: true\r\n---\r\ntangerines in a CRLF diary', 'bom.md': '﻿---\nprivate: true\n---\ntangerines after a mark',
    'fence.md': '--- \nprivate: true\n---\ntangerines behind a spaced fence', 'yes.md': '---\nprivate: yes\n---\ntangerines said yes',
    'quoted.md': '---\nprivate: "true"\n---\ntangerines in quotes', 'dots.md': '---\nprivate: true\n...\ntangerines after dots',
    'spaced.md': '---\ndate created: 2026-01-01\n---\ntangerines with a spaced key', 'nested.md': '---\nmeta:\n  owner: me\n---\ntangerines nested',
    'groceries.md': '---\r\ntitle: Groceries\r\nsecretword: zebra\r\n---\r\n# Groceries\r\n\r\nBuy kumquats on Friday.',
  };
  for (const [name, text] of Object.entries(notes)) await writeFile(join(vault, name), text);
  const vaultNotes = new NotesVault(() => vault);
  assert.deepEqual(await vaultNotes.scan().then(status => [status.notes, status.private, status.unreadable]), [1, 6, 2]);
  assert.deepEqual((await vaultNotes.search('tangerines')).results, []);
  const found = await vaultNotes.search('kumquats');
  assert.equal(found.results[0].path, 'groceries.md'); assert.doesNotMatch(found.results[0].excerpt, /secretword|zebra/);
  assert.deepEqual((await vaultNotes.search('zebra')).results, [], 'front matter is not indexed as text');
  const read = await vaultNotes.read('Groceries');
  assert.equal(read.title, 'Groceries'); assert.doesNotMatch(read.text, /secretword|---/); assert.match(read.text, /Buy kumquats/);
  for (const name of Object.keys(notes).filter(name => name !== 'groceries.md')) {
    await assert.rejects(vaultNotes.read(name), /Private notes are not available/, name);
    await assert.rejects(vaultNotes.editable(name), /Private notes cannot be edited/, name);
  }
  assert.equal(await vaultNotes.editable('groceries.md'), 'groceries.md');
});

test('M07 file proposals stay confined and show a readable diff', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cere-confined-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'notes')); await writeFile(join(root, 'outside.md'), 'x');
  await symlink(join(root, 'outside.md'), join(root, 'notes', 'link.md'));
  for (const bad of ['../outside.md', '.hidden/a.md', 'link.md', '']) await assert.rejects(confinedPath(join(root, 'notes'), bad), new RegExp('Choose|Linked'));
  assert.equal((await confinedPath(join(root, 'notes'), 'sub/new.md')).rel, 'sub/new.md');
  const diff = lineDiff('a\nb\nc', 'a\nB\nc', 'n.md');
  assert.equal(diff, '--- n.md\n+++ n.md\n a\n-b\n+B\n c');
});

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'cere-vault-')), vault = join(root, 'vault');
  await mkdir(join(vault, 'projects'), { recursive: true }); await mkdir(join(vault, '.obsidian'), { recursive: true }); await mkdir(join(vault, 'archive', '.secret'), { recursive: true });
  await writeFile(join(vault, 'projects', 'orchid.md'), '---\ntags: [project]\naliases: [Orchid app]\n---\n# Orchid\n\nThe orchid launch is on Tuesday. See [[Release checklist]].');
  await writeFile(join(vault, 'Release checklist.md'), '# Release checklist\n\n- Tag the build #release\n- Mention [[Orchid app|the app]]');
  await writeFile(join(vault, 'diary.md'), '---\nprivate: true\n---\nmy private diary about tangerines');
  await writeFile(join(vault, 'odd.md'), '---\nmeta:\n  nested: true\n---\nunreadable front matter about tangerines');
  await writeFile(join(vault, 'archive', '.secret', 'hidden.md'), 'hidden tangerines');
  await writeFile(join(vault, '.obsidian', 'config.md'), 'app config tangerines');
  await writeFile(join(root, 'outside.md'), 'outside tangerines');
  await symlink(join(root, 'outside.md'), join(vault, 'linked.md'));
  const state = join(root, 'state');
  const core = new Core(new Store(state), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  return { root, vault, state, core };
}

test('M07 the vault index skips private, hidden, linked and unreadable notes and follows external edits', async t => {
  const { vault } = await fixture(t);
  const notes = new NotesVault(() => vault);
  const status = await notes.scan();
  assert.deepEqual([status.notes, status.private, status.unreadable], [2, 1, 1]);
  assert.deepEqual((await notes.search('tangerines')).results, [], 'nothing private, hidden or linked is searchable');
  const found = await notes.search('orchid launch');
  assert.equal(found.results[0].path, 'projects/orchid.md');
  const read = await notes.read('Orchid app');
  assert.deepEqual(read.tags, ['project']); assert.deepEqual(read.backlinks, [{ path: 'Release checklist.md', title: 'Release checklist' }]);
  assert.deepEqual((await notes.read('Release checklist')).backlinks, [{ path: 'projects/orchid.md', title: 'Orchid' }]);
  await assert.rejects(notes.read('diary'), /Private notes are not available/);
  // The folder stays the source of truth: an external edit is picked up by size and time.
  await writeFile(join(vault, 'projects', 'orchid.md'), '# Orchid\n\nThe launch moved to Friday.');
  await utimes(join(vault, 'projects', 'orchid.md'), new Date(), new Date(Date.now() + 5000));
  assert.match((await notes.read('projects/orchid.md')).text, /moved to Friday/);
});

test('M07 tools follow the cloud gate, and a model edit needs a person, refuses a stale base and keeps a backup', async t => {
  const { root, vault, state, core } = await fixture(t);
  for (const path of [root.replace(/\/[^/]+$/, ''), join(vault, '.obsidian'), state]) await assert.rejects(core.updateSettings({ notesVault: { path, enabled: true } }), /notes folder itself|Hidden folders|own state/);
  await core.updateSettings({ notesVault: { path: vault, enabled: true }, bypassComputerPermissions: true, bypassCliPermissions: true });
  const codex = await core.create({ provider: 'codex', cwd: root, trusted: true });
  assert.deepEqual(core.notesToolsFor(codex.id), [], 'a CLI is a cloud consumer: no notes until the vault allows cloud models');
  await core.updateSettings({ notesVault: { allowCloud: true } });
  assert.deepEqual(core.notesToolsFor(codex.id).map(tool => tool.name), ['notes.search', 'notes.read', 'notes.propose_edit']);
  const signal = new AbortController().signal;
  assert.equal((await core.callTool(codex.id, 'notes_search', { query: 'orchid' }, signal)).results[0].path, 'projects/orchid.md');
  await assert.rejects(core.callTool(codex.id, 'notes_read', { path: 'diary' }, signal), /Private notes/);
  await assert.rejects(core.callTool(codex.id, 'notes_propose_edit', { path: 'diary.md', content: 'x' }, signal), /Private notes cannot be edited/);
  // Even with both bypass switches on, a note edit waits for a person.
  const edit = core.callTool(codex.id, 'notes_propose_edit', { path: 'projects/orchid.md', content: '# Orchid\n\nThe orchid launch is on Wednesday.', reason: 'Date changed' }, signal);
  for (let index = 0; index < 100 && !core.approvals.size; index++) await new Promise(resolve => setTimeout(resolve, 5));
  const [approval] = [...core.approvals.values()].map(a => a.value);
  assert.equal(approval.kind, 'file'); assert.match(approval.detail, /Reason: Date changed\n\n--- projects\/orchid\.md/); assert.match(approval.detail, /\+The orchid launch is on Wednesday\./);
  core.answer({ id: approval.id, choice: 'allow' });
  assert.deepEqual((await edit).applied, true);
  assert.equal(await readFile(join(vault, 'projects', 'orchid.md'), 'utf8'), '# Orchid\n\nThe orchid launch is on Wednesday.');
  assert.equal((await readdir(join(state, 'vault-backups'))).length, 1, 'the previous text was kept privately');
  // An external edit after the proposal: the reviewed edit refuses and nothing is lost.
  const stale = core.callTool(codex.id, 'notes_propose_edit', { path: 'projects/orchid.md', content: 'model text' }, signal);
  for (let index = 0; index < 100 && !core.approvals.size; index++) await new Promise(resolve => setTimeout(resolve, 5));
  await writeFile(join(vault, 'projects', 'orchid.md'), 'edited in another editor');
  core.answer({ id: [...core.approvals.values()][0].value.id, choice: 'allow' });
  await assert.rejects(stale, /changed since this edit was proposed/);
  assert.equal(await readFile(join(vault, 'projects', 'orchid.md'), 'utf8'), 'edited in another editor');
  // Declining changes nothing; turning the vault off removes the tools.
  const declined = core.callTool(codex.id, 'notes_propose_edit', { path: 'new note.md', content: 'hello' }, signal);
  for (let index = 0; index < 100 && !core.approvals.size; index++) await new Promise(resolve => setTimeout(resolve, 5));
  core.answer({ id: [...core.approvals.values()][0].value.id, choice: 'deny' });
  assert.equal((await declined).applied, false);
  await assert.rejects(readFile(join(vault, 'new note.md')), /ENOENT/);
  await core.updateSettings({ notesVault: { enabled: false } });
  assert.deepEqual(core.notesToolsFor(codex.id), []);
  await core.rpc('notes.clearBackups', {});
  await assert.rejects(readdir(join(state, 'vault-backups')), /ENOENT/);
});

test('M22 a proposal is used once, a folder change during approval refuses, and every applied edit is attributable', async t => {
  const { root, vault, state, core } = await fixture(t);
  const { propose, apply } = await import('../broker/file-proposals.ts');
  const proposal = await propose({ root: vault, path: 'once.md', content: 'first', sessionId: 's' });
  await apply(proposal, join(root, 'backups'));
  await assert.rejects(apply(proposal, join(root, 'backups')), /already used/);
  await core.updateSettings({ notesVault: { path: vault, enabled: true, allowCloud: true }, bypassComputerPermissions: true });
  const codex = await core.create({ provider: 'codex', cwd: root, trusted: true });
  const signal = new AbortController().signal;
  const waitApproval = async () => { for (let index = 0; index < 100 && !core.approvals.size; index++) await new Promise(resolve => setTimeout(resolve, 5)); return [...core.approvals.values()][0].value; };
  // The vault moves to another folder while the question is open: nothing is written anywhere.
  const other = join(root, 'other-vault'); await mkdir(other); await writeFile(join(other, 'orchid.md'), 'other orchid');
  const moving = core.callTool(codex.id, 'notes_propose_edit', { path: 'projects/orchid.md', content: 'moved content' }, signal);
  const asked = await waitApproval();
  await core.updateSettings({ notesVault: { path: other } });
  core.answer({ id: asked.id, choice: 'allow' });
  await assert.rejects(moving, /notes folder changed/);
  assert.doesNotMatch(await readFile(join(vault, 'projects', 'orchid.md'), 'utf8'), /moved content/);
  assert.equal(await readFile(join(other, 'orchid.md'), 'utf8'), 'other orchid');
  // An applied edit names its conversation, note and content hash, and shows as a result artifact.
  await core.updateSettings({ notesVault: { path: vault } });
  const editing = core.callTool(codex.id, 'notes_propose_edit', { path: 'projects/orchid.md', content: '# Orchid\n\nAttributed edit.' }, signal);
  core.answer({ id: (await waitApproval()).id, choice: 'allow' });
  assert.equal((await editing as any).applied, true);
  const record: any = core.store.activities().find((entry: any) => entry.action === 'notes.edit');
  assert.deepEqual([record.sessionId, record.path, record.sha256.length], [codex.id, 'projects/orchid.md', 64]);
  const results: any[] = await core.workflows.dispatch('results.list', { sessionId: codex.id }) as any;
  assert.ok(results[0].artifacts.includes(join(vault, 'projects', 'orchid.md')));
  assert.ok(results[0].observed.some((action: any) => action.name === 'notes.edit'));
  void state;
});
