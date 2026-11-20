import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { workbenchFixture } from './fixtures/workbench.ts';

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });

test('11.1 the Settings host and endpoint become named connections once, with the same destinations and no keys in SQLite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-connections-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state'));
  store.set('settings', { ...store.settings(), ollama: { host: 'http://127.0.0.1:11434', model: '' }, compatible: { ...store.settings().compatible, baseUrl: 'http://127.0.0.1:1234/v1', label: 'LM Studio', requiresKey: true, processing: 'local' } });
  let core = new Core(store, idle);
  await core.rpc('provider.credentials', { provider: 'compatible', key: 'sk-local-endpoint' });
  const listed = await core.rpc('connections.list', {});
  assert.deepEqual(listed.map((c: any) => [c.kind, c.host || c.endpoint.baseUrl, c.migrated]), [['ollama', 'http://127.0.0.1:11434', true], ['compatible', 'http://127.0.0.1:1234/v1', true]]);
  assert.equal(listed[1].keySet, true);
  const raw = JSON.stringify(core.store.db.prepare('SELECT data FROM provider_connections').all());
  assert.doesNotMatch(raw, /sk-local-endpoint/, 'keys stay in the credentials store');
  await core.close();
  core = new Core(new Store(join(dir, 'state')), idle);
  t.after(() => core.close());
  assert.equal((await core.rpc('connections.list', {})).length, 2, 'migration runs once');
});

test('11.1 a conversation binds to its connection: another endpoint’s key and declarations, unaffected by later Settings edits; moving is reviewed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-connections-'));
  const core = new Core(new Store(join(dir, 'state')), idle);
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.updateSettings({ compatible: { baseUrl: 'http://127.0.0.1:1234/v1', label: 'Local', requiresKey: false, tools: false } });
  const gateway = await core.rpc('connections.save', { kind: 'compatible', name: 'Team gateway', endpoint: { baseUrl: 'https://gateway.example.com/v1', requiresKey: true, tools: true, processing: 'cloud' } });
  await assert.rejects(core.create({ provider: 'compatible', model: 'm', cwd: dir, connectionId: gateway.id, trusted: true }), /Add a key for/);
  await core.rpc('provider.credentials', { provider: 'compatible', key: 'sk-gateway', connectionId: gateway.id });
  const session = await core.create({ provider: 'compatible', model: 'm', cwd: dir, connectionId: gateway.id, trusted: true, tools: true });
  assert.equal(session.connectionId, gateway.id);
  const access = core.apiAccess('compatible', session.id);
  assert.equal(access.endpoint!().baseUrl, 'https://gateway.example.com/v1'); assert.equal(access.key(), 'sk-gateway');
  assert.equal(core.toolCalling(session), true, 'the gateway declares tools even though the Settings endpoint does not');
  await core.updateSettings({ compatible: { baseUrl: 'http://127.0.0.1:9999/v1' } });
  assert.equal(core.apiAccess('compatible', session.id).endpoint!().baseUrl, 'https://gateway.example.com/v1', 'changing the default affects new conversations only');
  assert.equal(core.chatConnections.list().find(c => c.migrated && c.kind === 'compatible')!.compatible!.baseUrl, 'http://127.0.0.1:9999/v1', 'editing Settings edits the default connection');
  await assert.rejects(core.rpc('connections.remove', { id: gateway.id }), /1 conversation uses this connection/);
  const local = core.chatConnections.list().find(c => c.migrated && c.kind === 'compatible')!;
  await assert.rejects(core.rpc('session.configure', { id: session.id, model: 'm', connectionId: local.id, expectedRevision: session.configRevision || '0' }), /Review the destination and confirm/);
  const moved = await core.rpc('session.configure', { id: session.id, model: 'm', tools: false, connectionId: local.id, destinationReviewed: true, expectedRevision: session.configRevision || '0' });
  assert.equal(moved.connectionId, local.id);
  assert.equal(core.apiAccess('compatible', session.id).endpoint!().baseUrl, 'http://127.0.0.1:9999/v1');
  assert.equal(await core.rpc('connections.remove', { id: gateway.id }), true);
});

test('11.1 an Ollama connection sets the conversation’s host and lists that host’s models', async t => {
  const f = await workbenchFixture(t);
  const second = await f.core.rpc('connections.save', { kind: 'ollama', name: 'Workstation', host: f.host });
  assert.ok((await f.core.rpc('connections.models', { id: second.id })).models.some((m: any) => m.id === 'chat:latest'));
  const session = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, connectionId: second.id });
  assert.equal(session.ollama!.host, f.host); assert.equal(session.connectionId, second.id);
  await assert.rejects(f.core.create({ provider: 'compatible', model: 'm', cwd: f.project, connectionId: second.id, trusted: true }), /an Ollama host, not for this provider/);
});

test('11.1 a restore keeps saved connections, and a conversation whose connection is gone is refused rather than redirected', async t => {
  const { activatePendingRecovery } = await import('../broker/recovery.ts');
  const dir = await mkdtemp(join(tmpdir(), 'cere-connections-'));
  let core = new Core(new Store(join(dir, 'state')), idle);
  let previous = '';
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); if (previous) await rm(previous, { recursive: true, force: true }); });
  await core.memory.ready;
  await core.updateSettings({ compatible: { baseUrl: 'http://127.0.0.1:1234/v1', label: 'Local', requiresKey: false } });
  const gateway = await core.rpc('connections.save', { kind: 'compatible', name: 'Gateway', endpoint: { baseUrl: 'https://gateway.example.com/v1', requiresKey: false, processing: 'cloud' } });
  const session = await core.create({ provider: 'compatible', model: 'm', cwd: dir, connectionId: gateway.id, trusted: true });
  const backup = await core.rpc('recovery.backup', { includeContent: true });
  const review = await core.rpc('recovery.preview', { directory: backup.directory, includeContent: true });
  previous = (await core.rpc('recovery.activate', { id: review.id, digest: review.digest })).previous;
  await core.close();
  assert.equal(activatePendingRecovery(join(dir, 'state')), true);
  core = new Core(new Store(join(dir, 'state')), idle);
  assert.equal(core.apiAccess('compatible', session.id).endpoint!().baseUrl, 'https://gateway.example.com/v1', 'the restored conversation keeps its own destination');
  core.store.db.prepare('DELETE FROM provider_connections WHERE id=?').run(gateway.id);
  assert.throws(() => core.apiAccess('compatible', session.id).endpoint!(), /connection no longer exists/);
  assert.equal(core.toolCalling(core.store.session(session.id)), false);
});
