import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PowerSessions } from '../broker/power.ts';
import type { Session } from '../broker/types.ts';

const session = (id: string, cwd: string, patch: Partial<Session> = {}): Session => ({
  id, cwd, provider: 'codex', nativeId: null, title: id, mode: 'managed', status: 'idle',
  created: 1, updated: 1, draft: '', scroll: 0, model: '', ...patch,
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-power-'));
  const one = join(directory, 'one'), two = join(directory, 'two');
  await mkdir(one); await mkdir(two);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1_000_000, rows: Session[] = [], changes = 0;
  const stopped: string[] = [], failures = new Set<string>();
  const power = new PowerSessions({
    sessions: () => rows,
    stop: async id => { stopped.push(id); if (failures.has(id)) throw new Error('stop failed'); },
    changed: () => { changes++; },
    now: () => now,
  });
  t.after(() => power.close());
  return { directory, one, two, power, stopped, failures, get changes() { return changes; }, setRows(value: Session[]) { rows = value; }, advance(ms: number) { now += ms; } };
}

test('power leases require explicit idle, local, managed session selections', async t => {
  const f = await fixture(t);
  const idle = session('idle', f.one);
  for (const invalid of [
    session('linked', f.one, { mode: 'linked' }),
    session('historical', f.one, { mode: 'historical' }),
    session('remote', f.one, { remote: { deviceId: 'd', projectId: 'p' } as any }),
    session('temporary', f.one, { temporary: true }),
    session('working', f.one, { status: 'working' }),
  ]) {
    f.setRows([invalid]);
    await assert.rejects(f.power.start({ sessionIds: [invalid.id], minutes: 5, cli: true, computer: false }));
  }
  f.setRows([idle]);
  await assert.rejects(f.power.start({ sessionIds: ['idle'], minutes: 0, cli: true, computer: false }), /between 1 and 120/);
  await assert.rejects(f.power.start({ sessionIds: ['idle'], minutes: 121, cli: true, computer: false }), /between 1 and 120/);
  await assert.rejects(f.power.start({ sessionIds: ['idle'], minutes: 5, cli: false, computer: false }), /Select CLI access/);
  await assert.rejects(f.power.start({ sessionIds: ['idle', 'idle'], minutes: 5, cli: true, computer: false }), /Invalid session/);
});

test('canonical project roots allow symlink aliases but isolate different projects', async t => {
  const f = await fixture(t), alias = join(f.directory, 'alias');
  await symlink(f.one, alias);
  const first = session('first', f.one), second = session('second', alias), outside = session('outside', f.two);
  f.setRows([first, second, outside]);
  const lease = await f.power.start({ sessionIds: ['first', 'second'], minutes: 5, cli: true, computer: false });
  assert.equal(lease.cwd, f.one);
  assert.deepEqual(f.power.effective(second), { cli: true, computer: false, leaseId: lease.id, revision: 1, expiresAt: lease.expiresAt });
  await assert.rejects(f.power.start({ sessionIds: ['outside', 'first'], minutes: 5, cli: false, computer: true }), /active or unconfirmed|same project/);
  await f.power.end(lease.id);
  await assert.rejects(f.power.start({ sessionIds: ['first', 'outside'], minutes: 5, cli: false, computer: true }), /same project/);
});

test('effective authority is selected-session-only and checks expiry synchronously', async t => {
  const f = await fixture(t), covered = session('covered', f.one), future = session('future', f.one);
  f.setRows([covered]);
  const lease = await f.power.start({ sessionIds: ['covered'], minutes: 1, cli: true, computer: true });
  assert.equal(f.power.effective(covered).leaseId, lease.id);
  f.setRows([covered, future]);
  assert.deepEqual(f.power.effective(future), { cli: false, computer: false });
  covered.status = 'working';
  f.advance(60_000);
  assert.deepEqual(f.power.effective(covered), { cli: false, computer: false });
  assert.equal(f.power.snapshot()[0].state, 'ending');
  await f.power.tick();
  assert.deepEqual(f.stopped, ['covered']);
  assert.equal(f.power.snapshot()[0].state, 'ended');
  assert.equal(f.power.snapshot()[0].reason, 'expired');
});

test('ending closes covered idle adapters and a stop failure remains unconfirmed', async t => {
  const f = await fixture(t), good = session('good', f.one), failed = session('failed', f.one);
  f.setRows([good, failed]); f.failures.add('failed');
  const lease = await f.power.start({ sessionIds: ['good', 'failed'], minutes: 10, cli: false, computer: true });
  const ending = f.power.end(lease.id, 'revoked');
  assert.deepEqual(f.power.effective(good), { cli: false, computer: false });
  assert.equal(f.power.snapshot()[0].state, 'ending');
  const result = await ending;
  assert.equal(result.state, 'unconfirmed');
  assert.equal(result.reason, 'revoked');
  assert.deepEqual(f.stopped.sort(), ['failed', 'good']);
  await assert.rejects(f.power.start({ sessionIds: ['failed'], minutes: 5, cli: true, computer: false }), /active or unconfirmed/);
  f.failures.clear();
  assert.equal((await f.power.end(lease.id, 'retry_confirmed')).state, 'ended');
  assert.equal((await f.power.start({ sessionIds: ['failed'], minutes: 5, cli: true, computer: false })).state, 'active');
});

test('delegate inheritance is explicit and limited to local managed children in the same project', async t => {
  const f = await fixture(t);
  const parent = session('parent', f.one), child = session('child', f.one, { parentId: 'parent', status: 'working' });
  const other = session('other', f.two, { parentId: 'parent' });
  const unbound = session('unbound', f.one);
  const remote = session('remote-child', f.one, { parentId: 'parent', remote: { deviceId: 'd', projectId: 'p' } as any });
  f.setRows([parent]);
  const lease = await f.power.start({ sessionIds: ['parent'], minutes: 10, cli: true, computer: false });
  f.setRows([parent, child, other, remote, unbound]);
  assert.equal(await f.power.attachChild('parent', 'child'), true);
  assert.equal(f.power.effective(child).leaseId, lease.id);
  assert.equal(await f.power.attachChild(parent, other), false);
  assert.equal(await f.power.attachChild(parent, remote), false);
  assert.equal(await f.power.attachChild(parent, unbound), false);
  assert.deepEqual(f.power.snapshot()[0].sessionIds, ['parent', 'child']);
  assert.equal(f.power.snapshot()[0].revision, 2);
});

test('concurrent starts cannot publish overlapping leases', async t => {
  const f = await fixture(t), selected = session('selected', f.one);
  f.setRows([selected]);
  const results = await Promise.allSettled([
    f.power.start({ sessionIds: ['selected'], minutes: 5, cli: true, computer: false }),
    f.power.start({ sessionIds: ['selected'], minutes: 5, cli: false, computer: true }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.power.snapshot().filter(lease => lease.state === 'active').length, 1);
});

test('leases are process-local and never appear in a replacement engine', async t => {
  const f = await fixture(t), selected = session('selected', f.one);
  f.setRows([selected]);
  await f.power.start({ sessionIds: ['selected'], minutes: 10, cli: true, computer: false });
  const replacement = new PowerSessions({ sessions: () => [selected], stop: async () => {}, changed: () => {}, now: () => 1_000_000 });
  assert.deepEqual(replacement.snapshot(), []);
  assert.deepEqual(replacement.effective(selected), { cli: false, computer: false });
  await replacement.close();
});
