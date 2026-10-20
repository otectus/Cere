import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Canonical } from '../broker/graph-memory/canonical.ts';
import { migrations } from '../broker/graph-memory/schema.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { healthReport } from '../broker/health.ts';

/** A store written by code that knew only migrations 1–4, holding a note and an assertion; `root` mirrors the state directory. */
function storeAtFour(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'cere-premigration-')), directory = join(root, 'graph-memory'), backups = join(root, 'memory-backups');
  t.after(() => { try { chmodSync(join(root, 'locked'), 0o700); } catch {} rmSync(root, { recursive: true, force: true }); });
  const five = migrations.pop()!;
  let scope = '', note = '', assertion = '';
  try {
    const c = new Canonical(directory);
    scope = c.registerScope({ key: 'fixture', label: 'Fixture' }).id;
    note = c.saveText({ scope_id: scope, text: 'Atlas uses Ruff for formatting.' }).id;
    const observed = c.observeText({ scope_id: scope, text: 'Atlas uses Kitty.', role: 'user' });
    const version = c.remember({ scope_id: scope, claim: { subject: { type: 'Project', name: 'Atlas' }, predicate: 'USES_TOOL', object: { type: 'Tool', name: 'Kitty' } }, witness: { observation_id: observed.id, quote: 'Atlas uses Kitty.' } }).id;
    assertion = c.one('SELECT logical_id FROM assertion_versions WHERE version_id=?', version).logical_id;
    c.close();
  } finally { migrations.push(five); }
  return { root, directory, backups, scope, note, assertion };
}
const version = (directory: string) => {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try { return [(db.prepare('SELECT MAX(id) AS n FROM schema_migrations').get() as any).n, !!db.prepare("SELECT name FROM sqlite_master WHERE name='retention_pins'").get()]; }
  finally { db.close(); }
};
const backupFiles = (backups: string) => existsSync(backups) ? readdirSync(backups).sort() : [];

test('S4 an existing store is copied and checked before it migrates; new and current stores are not', t => {
  const { directory, backups, scope, note } = storeAtFour(t);
  assert.deepEqual(version(directory), [4, false]);
  const c = new Canonical(directory, { backups });
  try {
    assert.deepEqual(version(directory), [5, true]);
    const date = new Date().toISOString().slice(0, 10), name = `before-migration-4-to-5-${date}.sqlite`;
    assert.deepEqual(backupFiles(backups), [name, name + '.manifest.json']);
    assert.equal(statSync(backups).mode & 0o777, 0o700); assert.equal(statSync(join(backups, name)).mode & 0o777, 0o600);
    const manifest = JSON.parse(readFileSync(join(backups, name + '.manifest.json'), 'utf8'));
    assert.deepEqual([manifest.kind, manifest.from, manifest.to, manifest.integrity, manifest.erasure_registry_required], ['before_migration', 4, 5, 'ok', true]);
    const copy = new DatabaseSync(join(backups, name), { readOnly: true });
    try {
      assert.deepEqual(copy.prepare('PRAGMA integrity_check').all().map((row: any) => row.integrity_check), ['ok']);
      assert.equal((copy.prepare('SELECT MAX(id) AS n FROM schema_migrations').get() as any).n, 4, 'the copy is the store before the migration');
    } finally { copy.close(); }
    assert.equal(c.health().migration_backups.length, 1);
    assert.equal(c.forgetPreview({ scope_id: scope, id: note }).migration_backups.length, 1, 'forgetting names the backup that still holds the text');
  } finally { c.close(); }
  new Canonical(directory, { backups }).close();
  assert.equal(backupFiles(backups).length, 2, 'a current store is not copied again');
  const fresh = mkdtempSync(join(tmpdir(), 'cere-premigration-fresh-'));
  try { new Canonical(join(fresh, 'graph-memory'), { backups: join(fresh, 'memory-backups') }).close(); assert.deepEqual(backupFiles(join(fresh, 'memory-backups')), []); }
  finally { rmSync(fresh, { recursive: true, force: true }); }
});

/** Every row of every table, read without changing the store: a failed migration must leave this identical. */
const contents = (directory: string) => {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[]).map(row => row.name);
    return Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
};
const refusedMigration = (pattern: RegExp) => (error: any) => error.code === 'MIGRATION_BACKUP_FAILED' && /schema update \(4 to 5\) and was left unchanged/.test(error.message) && pattern.test(error.message);
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// Root bypasses directory permission bits, so this fixture only proves anything for an ordinary user;
// CI runs the suite as one. The failures below go through the filesystem for any user.
test('S4 without a writable backup directory, the store is left unmigrated with the reason', { skip: runningAsRoot ? 'needs an unprivileged user: root ignores the read-only directory mode' : false }, t => {
  const { root: state, directory } = storeAtFour(t);
  const before = contents(directory);
  const locked = join(state, 'locked'); mkdirSync(locked); chmodSync(locked, 0o500);
  assert.throws(() => new Canonical(directory, { backups: join(locked, 'memory-backups') }), refusedMigration(/EACCES|permission denied/i));
  assert.deepEqual(version(directory), [4, false]);
  assert.deepEqual(contents(directory), before, 'the refused migration changed no data');
});

test('S4 a backup directory that cannot be created, a disk that fills mid-copy, or a copy that is not a database leaves the store unchanged', t => {
  const { root: state, directory } = storeAtFour(t);
  const before = contents(directory);
  // A path below a regular file fails for every user, root included.
  const file = join(state, 'not-a-directory'); writeFileSync(file, 'x');
  assert.throws(() => new Canonical(directory, { backups: join(file, 'memory-backups') }), refusedMigration(/ENOTDIR|not a directory/i));
  assert.deepEqual(version(directory), [4, false]);
  const backups = join(state, 'memory-backups'), copy = Canonical.copyStore;
  t.after(() => { Canonical.copyStore = copy; });
  Canonical.copyStore = (_db, path) => { writeFileSync(path, 'half a copy'); throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
  assert.throws(() => new Canonical(directory, { backups }), refusedMigration(/ENOSPC/));
  assert.deepEqual(backupFiles(backups), [], 'the partial copy is removed');
  Canonical.copyStore = (_db, path) => { writeFileSync(path, 'x'.repeat(4096)); };
  assert.throws(() => new Canonical(directory, { backups }), refusedMigration(/not a database|integrity|malformed/i));
  assert.deepEqual(backupFiles(backups), [], 'a copy that fails its check is removed');
  assert.deepEqual(version(directory), [4, false]);
  assert.deepEqual(contents(directory), before, 'no failed attempt changed the store');
  Canonical.copyStore = copy;
  new Canonical(directory, { backups }).close();
  assert.deepEqual(version(directory), [5, true], 'once the copy can be written, the next open migrates');
});

test('S4 without enough room for the copy, the store is left unmigrated with the reason', t => {
  const { root, directory } = storeAtFour(t);
  const free = Canonical.freeBytes;
  Canonical.freeBytes = () => 1024;
  try { assert.throws(() => new Canonical(directory, { backups: join(root, 'memory-backups') }), /needs .* MiB free and 0\.0 MiB is available/); }
  finally { Canonical.freeBytes = free; }
  assert.deepEqual(version(directory), [4, false]);
  assert.deepEqual(backupFiles(join(root, 'memory-backups')).filter(name => name.includes('partial')), [], 'no partial copy is left behind');
  new Canonical(directory, { backups: join(root, 'memory-backups') }).close();
  assert.deepEqual(version(directory), [5, true], 'with room, the next open migrates');
});

test('S4 the newest two pre-migration backups are kept, and none for longer than 14 days', t => {
  const { directory, backups } = storeAtFour(t);
  const c = new Canonical(directory, { backups });
  t.after(() => c.close());
  const day = 86_400_000_000, now = Date.now() * 1000;
  const fake = (name: string, age: number) => { writeFileSync(join(backups, name), 'x'); writeFileSync(join(backups, name + '.manifest.json'), JSON.stringify({ created_us: now - age, from: 1, to: 2 })); };
  fake('before-migration-1-to-2-2026-10-01.sqlite', 3 * day); fake('before-migration-2-to-3-2026-10-02.sqlite', 2 * day);
  c.pruneMigrationBackups();
  assert.deepEqual(c.migrationBackups().map(backup => backup.name), [`before-migration-4-to-5-${new Date().toISOString().slice(0, 10)}.sqlite`, 'before-migration-2-to-3-2026-10-02.sqlite'], 'the third-newest is removed');
  assert.equal(existsSync(join(backups, 'before-migration-1-to-2-2026-10-01.sqlite.manifest.json')), false);
  fake('before-migration-3-to-4-2026-09-20.sqlite', 15 * day);
  writeFileSync(join(backups, 'before-migration-4-to-5-' + new Date().toISOString().slice(0, 10) + '.sqlite.manifest.json'), JSON.stringify({ created_us: now - 15 * day, from: 4, to: 5 }));
  c.maintenance();
  assert.deepEqual(c.migrationBackups().map(backup => backup.name), ['before-migration-2-to-3-2026-10-02.sqlite'], 'maintenance removes backups older than 14 days');
  assert.deepEqual(c.deleteMigrationBackups(), { deleted: 1 });
  assert.deepEqual(c.health().migration_backups, []);
});

test('S4 restoring a pre-migration backup does not bring back what was forgotten after it', async t => {
  const { root, directory, backups, scope, note, assertion } = storeAtFour(t);
  const c = new Canonical(directory, { backups });
  try {
    const [backup] = c.migrationBackups(), copy = new DatabaseSync(backup.path, { readOnly: true });
    try { for (const text of ['Ruff', 'Atlas uses Kitty']) assert.ok(copy.prepare('SELECT * FROM payloads').all().some(row => JSON.stringify(row).includes(text)), `the backup holds ${text}`); }
    finally { copy.close(); }
    assert.equal(c.retrieve({ scope_id: scope, text: 'Atlas Kitty' }).assertions.length, 1);
    c.forget({ scope_id: scope, id: note }); c.forget({ scope_id: scope, id: assertion });
    await c.restore({ input: backup.path, staging: join(root, 'restored') });
  } finally { c.close(); }
  const restored = new Canonical(join(root, 'restored'));
  try {
    assert.equal(restored.retrieve({ scope_id: scope, text: 'Ruff formatting' }).results.length, 0);
    assert.deepEqual(restored.retrieve({ scope_id: scope, text: 'Atlas Kitty' }).assertions, [], 'the forgotten assertion stays forgotten');
    for (const table of ['payloads', 'evidence', 'retrieval_documents', 'assertion_versions', 'artifacts'])
      for (const row of restored.all(`SELECT * FROM ${table}`)) for (const text of ['Ruff', 'Atlas uses Kitty']) assert.ok(!JSON.stringify(row).includes(text), `${table} holds forgotten text`);
  } finally { restored.close(); }
});

test('S4 Health lists the backup, and clearing memory deletes it', async t => {
  const state = mkdtempSync(join(tmpdir(), 'cere-premigration-core-')), backups = join(state, 'memory-backups');
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, 'before-migration-4-to-5-2026-10-15.sqlite'), 'x');
  writeFileSync(join(backups, 'before-migration-4-to-5-2026-10-15.sqlite.manifest.json'), JSON.stringify({ created_us: Date.now() * 1000, from: 4, to: 5 }));
  const core = new Core(new Store(state), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); rmSync(state, { recursive: true, force: true }); });
  await core.updateSettings({ memory: { enabled: true }, ollama: { host: 'http://127.0.0.1:9' } });
  await core.memory.ready; await core.memory.refresh();
  assert.deepEqual(healthReport(core).memory.backups.map((backup: any) => [backup.from, backup.to]), [[4, 5]]);
  const session = await core.create({ provider: 'codex', cwd: state, trusted: true });
  await core.memory.clear(core.store.session(session.id));
  assert.deepEqual(backupFiles(backups), []);
  assert.deepEqual(healthReport(core).memory.backups, []);
});
