import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { nextOccurrence, validWhen } from '../broker/schedules.ts';

// Daylight-saving rules are checked in a zone that has them; the process zone is restored afterwards.
function inZone(t: any, zone: string) { const previous = process.env.TZ; process.env.TZ = zone; t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }); }
const local = (text: string) => new Date(text).getTime();

test('M14 occurrences are deterministic across days, weekdays and daylight-saving changes', t => {
  inZone(t, 'America/New_York');
  const daily = validWhen({ kind: 'daily', time: '02:30' });
  // 2026-03-08 has no 02:30 in New York: the run happens at the first moment after the gap.
  const spring = nextOccurrence(daily, local('2026-03-08T01:00:00'))!;
  assert.equal(new Date(spring).toString().slice(16, 21), '03:30');
  assert.equal(new Date(spring).getDate(), 8);
  // 2026-11-01 has 01:30 twice: it runs once, at the first one.
  const repeated = validWhen({ kind: 'daily', time: '01:30' });
  const first = nextOccurrence(repeated, local('2026-11-01T00:00:00'))!;
  assert.equal(nextOccurrence(repeated, first)! - first > 23 * 3600_000, true, 'the next run is the following day, not the repeated hour');
  const weekdays = validWhen({ kind: 'weekdays', time: '09:00' });
  assert.equal(new Date(nextOccurrence(weekdays, local('2026-10-16T10:00:00'))!).getDay(), 1, 'Friday after nine → Monday');
  const weekly = validWhen({ kind: 'weekly', time: '18:00', days: [3] });
  assert.equal(new Date(nextOccurrence(weekly, local('2026-10-15T19:00:00'))!).getDay(), 3);
  const once = validWhen({ kind: 'once', time: '12:00', date: '2026-10-20' });
  assert.equal(nextOccurrence(once, local('2026-10-21T00:00:00')), undefined);
  for (const [value, error] of [[{ kind: 'hourly', time: '01:00' }, /once, daily/], [{ kind: 'daily', time: '25:00' }, /HH:MM/], [{ kind: 'weekly', time: '01:00', days: [] }, /days of the week/], [{ kind: 'once', time: '01:00' }, /YYYY-MM-DD/]] as [unknown, RegExp][])
    assert.throws(() => validWhen(value), error);
});

async function broker(t: any, dir?: string) {
  dir ||= await mkdtemp(join(tmpdir(), 'cere-schedules-'));
  const sent: string[] = [];
  let hooks: any, finish = true;
  const core = new Core(new Store(join(dir, 'state')), (_session, h) => { hooks = h; return { async send(text: string) { sent.push(text); if (finish) setTimeout(() => h.event({ type: 'message', id: 'reply', text: 'Checked.' }), 5), setTimeout(() => h.event({ type: 'complete' }), 10); }, async interrupt() { hooks.event({ type: 'interrupted' }); }, async close() {} }; });
  t.after(async () => { await core.close(); });
  return { core, dir, sent, hold: () => { finish = false; } };
}
const prepared = async (core: Core, dir: string) => {
  const source = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  const preview: any = await core.workflows.dispatch('recipes.prepare', { sessionId: source.id, recipeId: 'review-plan', inputs: { plan: 'Ship on Friday' } });
  return { source, preview };
};

test('M14 a due schedule runs its reviewed prompt once, even across a restart, and its result reaches the inbox', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-schedules-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { core, sent } = await broker(t, dir);
  const { preview } = await prepared(core, dir);
  await assert.rejects(core.rpc('schedules.create', { previewToken: preview.token, label: 'Plan check', when: { kind: 'daily', time: '08:00' } }), /may run while you are away/);
  const schedule = await core.rpc('schedules.create', { previewToken: preview.token, label: 'Plan check', when: { kind: 'daily', time: '08:00' }, unattended: true });
  await assert.rejects(core.rpc('recipes.createDraft', { previewToken: preview.token, reviewed: true }), /expired/, 'the reviewed preview was consumed by the schedule');
  const due = schedule.next;
  await core.schedules.tick(due + 1000);
  for (let index = 0; index < 100 && sent.length < 1; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1); assert.equal(sent[0], preview.prompt);
  let saved = core.schedules.list()[0];
  assert.deepEqual([saved.lastRun!.outcome, saved.lastOccurrence, saved.next! > due], ['started', due, true]);
  for (let index = 0; index < 100 && !core.completions.some((item: any) => item.sessionId === saved.lastRun!.sessionId); index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(core.completions.some((item: any) => item.sessionId === saved.lastRun!.sessionId), 'the run’s result is in the inbox');
  // The same occurrence never runs again, before or after a restart.
  await core.schedules.tick(due + 2000);
  await core.close();
  const restarted = await broker(t, dir);
  await restarted.core.schedules.tick(due + 3000);
  assert.equal(sent.length + restarted.sent.length, 1);
  saved = restarted.core.schedules.list()[0];
  assert.equal(saved.lastRun!.outcome, 'started');
});

test('M14 missed, overlapping and changed occurrences are reported and not run; a change pauses until reviewed again', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-schedules-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { core, sent, hold } = await broker(t, dir);
  const notices: any[] = []; core.on('notice', notice => notices.push(notice));
  let { preview } = await prepared(core, dir);
  let schedule = await core.rpc('schedules.create', { previewToken: preview.token, label: 'Plan check', when: { kind: 'daily', time: '08:00' }, unattended: true });
  // Missed: the computer was off at the time; nothing runs late.
  await core.schedules.tick(schedule.next + 11 * 60_000);
  assert.equal(sent.length, 0);
  assert.equal(core.schedules.list()[0].lastRun!.outcome, 'missed');
  assert.match(notices.at(-1).text, /Plan check: missed; it was not run late/);
  // Overlap: the previous run is still working, so this occurrence is skipped.
  hold();
  schedule = core.schedules.list()[0];
  await core.schedules.tick(schedule.next + 1000);
  for (let index = 0; index < 100 && sent.length < 1; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  schedule = core.schedules.list()[0];
  await core.schedules.tick(schedule.next + 1000);
  assert.equal(sent.length, 1);
  assert.deepEqual([core.schedules.list()[0].lastRun!.outcome, core.schedules.list()[0].lastRun!.reason], ['skipped', 'the previous run was still working']);
  await core.stop(core.schedules.list()[0].lastRun!.sessionId!);
  // A changed permission switch pauses the schedule; it cannot simply be turned back on.
  await core.updateSettings({ bypassCliPermissions: true });
  schedule = core.schedules.list()[0];
  await core.schedules.tick(schedule.next + 1000);
  assert.equal(sent.length, 1);
  const paused = core.schedules.list()[0];
  assert.deepEqual([paused.lastRun!.outcome, paused.enabled], ['paused', false]);
  assert.match(paused.lastRun!.reason!, /permission switches changed/);
  await assert.rejects(core.rpc('schedules.setEnabled', { id: paused.id, enabled: true }), /Review the recipe again/);
  await core.updateSettings({ bypassCliPermissions: false });
  // A new version of the recipe also pauses a schedule made from the old one.
  ({ preview } = await prepared(core, dir));
  const second = await core.rpc('schedules.create', { previewToken: preview.token, label: 'Second', when: { kind: 'daily', time: '09:00' }, unattended: true });
  // Turned off at once: no later tick may run or report it.
  await core.rpc('schedules.setEnabled', { id: second.id, enabled: false });
  const recipe: any = await core.workflows.dispatch('recipes.get', { id: 'review-plan' });
  await core.workflows.dispatch('recipes.save', { ...recipe, id: undefined, name: 'My plan review', expectedRevision: '0' });
  const custom: any = (await core.workflows.dispatch('recipes.list', {}) as any).recipes.find((item: any) => item.name === 'My plan review');
  const { source } = await prepared(core, dir);
  const customPreview: any = await core.workflows.dispatch('recipes.prepare', { sessionId: source.id, recipeId: custom.id, inputs: { plan: 'x' } });
  const third = await core.rpc('schedules.create', { previewToken: customPreview.token, label: 'Custom', when: { kind: 'daily', time: '10:00' }, unattended: true });
  await core.workflows.dispatch('recipes.save', { ...custom, instructions: custom.instructions + ' Also check the tests.', expectedRevision: custom.revision });
  await core.schedules.tick(third.next + 1000);
  assert.deepEqual([core.schedules.list().find(item => item.id === third.id)!.lastRun!.outcome, core.schedules.list().find(item => item.id === third.id)!.lastRun!.reason], ['paused', 'the recipe changed']);
  // Turning a schedule off stops its future runs; deleting removes it.
  await core.schedules.tick(second.next + 1000);
  assert.equal(core.schedules.list().find(item => item.id === second.id)!.lastRun, undefined);
  await core.rpc('schedules.delete', { id: second.id });
  assert.ok(!core.schedules.list().some(item => item.id === second.id));
});
