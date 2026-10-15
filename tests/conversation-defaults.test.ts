import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { ModelOption } from '../broker/types.ts';

// "Save as my defaults" in the new-conversation dialog stores settings.conversationDefaults. Only that
// dialog reads them: projects keep their own defaults, and no other way of starting a conversation does.
const models: ModelOption[] = [{ id: 'tools-model', displayName: 'Tools model', description: '', efforts: [], defaultEffort: '', isDefault: true, capabilities: ['tools'] }];
async function setup(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-conversation-defaults-'));
  const core = new Core(new Store(join(directory, 'state')), () => ({ async send() {}, async interrupt() {}, async close() {} }), async () => models);
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  const cwd = join(directory, 'project'); await mkdir(cwd);
  return { core, directory, cwd };
}
const saved = { provider: 'claude', model: 'general-model', effort: 'high', tools: false, temporary: false };

test('general conversation defaults start unset, validate strictly and survive a restart', async t => {
  const { core, directory } = await setup(t);
  assert.equal(core.settings.conversationDefaults, null);
  assert.equal(core.snapshot().settings.conversationDefaults, null);
  // A database written before the setting existed reads it as unset.
  core.store.set('settings', { quiet: true });
  assert.equal(core.store.settings().conversationDefaults, null);
  const revision = core.store.get('settingsRevision', '0');
  for (const value of ['x', 1, [], {}, { ...saved, trusted: true }, { provider: 'claude', model: '', effort: '', tools: false },
    { ...saved, provider: 'nope' }, { ...saved, tools: 'false' }, { ...saved, temporary: 1 }, { ...saved, model: 'm'.repeat(513) },
    { ...saved, model: 'bad\u0001' }, { ...saved, effort: 'e'.repeat(33) }, { ...saved, tools: true },
    { provider: 'ollama', model: '', effort: 'high', tools: false, temporary: false },
    { provider: 'openai', model: '  ', effort: '', tools: false, temporary: false },
    { provider: 'ollama', model: '', effort: '', tools: true, temporary: true }])
    await assert.rejects(core.updateSettings({ conversationDefaults: value }), Error, JSON.stringify(value));
  // A rejected patch changes nothing at all.
  assert.equal(core.settings.conversationDefaults, null);
  assert.equal(core.store.get('settingsRevision', '0'), revision);
  await core.updateSettings({ conversationDefaults: { ...saved, model: '  general-model  ' } });
  assert.deepEqual(core.settings.conversationDefaults, saved);
  const restarted = new Core(new Store(join(directory, 'state')));
  try { assert.deepEqual(restarted.settings.conversationDefaults, saved); } finally { await restarted.close(); }
  // An Ollama default with no model follows the Connections default, which stays as it was.
  const ollama = core.settings.ollama.model;
  await core.updateSettings({ conversationDefaults: { provider: 'ollama', model: '', effort: '', tools: true, temporary: false } });
  assert.equal(core.settings.ollama.model, ollama);
  await core.updateSettings({ conversationDefaults: null });
  assert.equal(core.settings.conversationDefaults, null);
});

test('saved general defaults never reach project, delegated or explicitly configured conversations', async t => {
  const { core, cwd } = await setup(t);
  const projectDefaults = { provider: 'codex', model: 'project-model', effort: 'low', tools: false, trusted: true, temporary: false };
  const project = await core.rpc('projects.save', { cwd, name: 'Project', favorite: false, expectedRevision: '0', defaults: projectDefaults });
  const before = core.store.db.prepare('SELECT data FROM projects WHERE cwd=?').get(cwd)?.data;
  await core.updateSettings({ conversationDefaults: saved });
  // The project's own defaults are untouched and still decide its sessions.
  assert.equal(core.store.db.prepare('SELECT data FROM projects WHERE cwd=?').get(cwd)?.data, before);
  assert.deepEqual((await core.rpc('projects.list')).projects[0].defaults, projectDefaults);
  const fromProject = await core.rpc('projects.createSession', { cwd, expectedRevision: project.revision, title: 'Project task' });
  assert.deepEqual([fromProject.provider, fromProject.model, fromProject.effort], ['codex', 'project-model', 'low']);
  // The broker never fills in the dialog's defaults: a request keeps exactly what it asked for.
  const explicit = await core.rpc('session.create', { provider: 'codex', cwd, trusted: true });
  assert.deepEqual([explicit.provider, explicit.model, explicit.effort], ['codex', '', '']);
  // A delegated session uses the model and effort its parent chose, or the CLI's own.
  await core.updateSettings({ bypassCliPermissions: true });
  const parent = await core.create({ provider: 'ollama', model: 'tools-model', tools: true, cwd, trusted: true });
  const child: any = await core.callTool(parent.id, 'sessions_start', { provider: 'codex', prompt: 'Review the project' }, new AbortController().signal);
  const delegated = core.store.session(child.id);
  assert.equal(delegated.parentId, parent.id);
  assert.deepEqual([delegated.provider, delegated.model, delegated.effort], ['codex', '', '']);
  assert.deepEqual(core.settings.conversationDefaults, saved);
});
