/**
 * M14: a reviewed recipe version run at set times. Creating a schedule consumes a reviewed recipe
 * preview and records its exact prompt digest and an unattended permission envelope: the conversation
 * settings and the permission switches in force when the user reviewed it. When an occurrence is due
 * Cere checks all of it again; any change pauses the schedule until the user reviews it again. Runs
 * never approve anything themselves: permission questions wait for a person.
 *
 * Deterministic rules: times are local wall-clock times in the time zone recorded at creation (a
 * different system zone pauses the schedule); a time skipped by a daylight-saving change runs at the
 * first moment after it, and a repeated hour runs once. An occurrence is claimed in the store before it
 * runs, so a restart never repeats it. An occurrence missed by more than ten minutes (the computer was
 * off or asleep) is reported, not caught up. An occurrence that arrives while the previous run is
 * still working is skipped and reported.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Core } from './core.ts';

export type When = { kind: 'once' | 'daily' | 'weekdays' | 'weekly'; time: string; days?: number[]; date?: string };
export type Envelope = { cwd: string; provider: string; configRevision: string; model: string; effort: string; bypassCli: boolean; bypassComputer: boolean; profile: string; categories: string[] };
export type Schedule = {
  id: string; label: string; enabled: boolean; revision: string; created: number;
  recipeId: string; recipeVersion: number; recipeRevision: string; authorizationRevision: string;
  inputs: Record<string, string | number | boolean>; sourceSessionId: string; promptDigest: string;
  envelope: Envelope; when: When; timeZone: string;
  next?: number; lastOccurrence?: number;
  lastRun?: { at: number; outcome: 'started' | 'missed' | 'skipped' | 'paused' | 'failed'; reason?: string; sessionId?: string };
};
const storeKey = 'workflow:schedules';
export const scheduleLimits = { schedules: 20, missedGraceMs: 10 * 60_000, horizonDays: 400 };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function validWhen(value: unknown): When {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose when the recipe runs');
  const p = value as Record<string, unknown>;
  if (!['once', 'daily', 'weekdays', 'weekly'].includes(p.kind as string)) throw new Error('Run once, daily, on weekdays or on chosen days');
  if (typeof p.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) throw new Error('Give the time as HH:MM, such as 08:30');
  const when: When = { kind: p.kind as When['kind'], time: p.time };
  if (p.kind === 'weekly') {
    if (!Array.isArray(p.days) || !p.days.length || p.days.some(day => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)) throw new Error('Choose the days of the week (0 is Sunday)');
    when.days = [...new Set(p.days as number[])].sort();
  }
  if (p.kind === 'once') {
    if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || Number.isNaN(Date.parse(p.date + 'T00:00:00'))) throw new Error('Give the date as YYYY-MM-DD');
    when.date = p.date;
  }
  return when;
}

/**
 * The first occurrence strictly after `after`, in local time. The Date constructor resolves a time in a
 * daylight-saving gap to the next valid moment and a repeated hour to its first instance; a repeated
 * hour is therefore never run twice.
 */
export function nextOccurrence(when: When, after: number): number | undefined {
  const [hour, minute] = when.time.split(':').map(Number), start = new Date(after);
  for (let offset = 0; offset <= scheduleLimits.horizonDays; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
    if (at.getTime() <= after) continue;
    const weekday = day.getDay();
    if (when.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (when.kind === 'weekly' && !when.days!.includes(weekday)) continue;
    if (when.kind === 'once') {
      const [year, month, date] = when.date!.split('-').map(Number);
      if (day.getFullYear() !== year || day.getMonth() !== month - 1 || day.getDate() !== date) continue;
    }
    return at.getTime();
  }
  return undefined;
}

export class Schedules {
  core: Core; private checking = false;
  constructor(core: Core) { this.core = core; }
  list(): Schedule[] { return this.core.store.get<Schedule[]>(storeKey, []); }
  private save(rows: Schedule[]) { this.core.store.set(storeKey, rows); this.core.changed(); }
  private update(id: string, patch: Partial<Schedule>) {
    const rows = this.list(), index = rows.findIndex(row => row.id === id);
    if (index < 0) return undefined;
    rows[index] = { ...rows[index], ...patch, revision: String(BigInt(rows[index].revision) + 1n) };
    this.save(rows); return rows[index];
  }
  /** The permission state a run would execute under, for the session the recipe runs with. */
  envelope(sessionId: string): Envelope {
    const session = this.core.store.session(sessionId), settings = this.core.settings;
    return { cwd: session.cwd, provider: session.provider, configRevision: session.configRevision || '0', model: session.model || '', effort: session.effort || '',
      bypassCli: settings.bypassCliPermissions, bypassComputer: settings.bypassComputerPermissions, profile: settings.profile, categories: [...settings.categories].sort() };
  }
  /** Creates a schedule from a reviewed preview, which it consumes; the user confirms unattended runs explicitly. */
  create(p: any) {
    if (p?.unattended !== true) throw new Error('Confirm that this recipe may run while you are away; its permission questions will wait for you');
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.trim().length > 80) throw new Error('Name the schedule with 1–80 characters');
    const when = validWhen(p.when);
    if (this.list().length >= scheduleLimits.schedules) throw new Error(`Keep at most ${scheduleLimits.schedules} schedules`);
    const preview = this.core.workflows.takePreview(p.previewToken);
    const now = Date.now(), next = nextOccurrence(when, now);
    if (next === undefined) throw new Error('That time has already passed');
    const schedule: Schedule = { id: randomUUID(), label: p.label.trim(), enabled: true, revision: '1', created: now,
      recipeId: preview.definitionId, recipeVersion: preview.definitionVersion, recipeRevision: preview.definitionRevision, authorizationRevision: preview.authorizationRevision,
      inputs: preview.inputs, sourceSessionId: preview.sourceSessionId, promptDigest: digest(preview.prompt), envelope: this.envelope(preview.sourceSessionId),
      when, timeZone: systemTimeZone(), next };
    this.save([...this.list(), schedule]);
    this.core.store.activity({ action: 'schedule.created', schedule: schedule.label, status: 'completed' });
    return schedule;
  }
  setEnabled(p: any) {
    const current = this.list().find(row => row.id === p?.id);
    if (!current) throw new Error('This schedule no longer exists');
    if (typeof p.enabled !== 'boolean') throw new Error('Choose whether the schedule is on');
    // Turning a paused schedule back on needs a fresh review: create it again from a new preview.
    if (p.enabled && current.lastRun?.outcome === 'paused') throw new Error('Something this schedule depends on changed. Review the recipe again and create a new schedule.');
    return this.update(current.id, { enabled: p.enabled, ...(p.enabled ? { next: nextOccurrence(current.when, Date.now()) } : {}) });
  }
  remove(p: any) {
    const rows = this.list();
    if (!rows.some(row => row.id === p?.id)) throw new Error('This schedule no longer exists');
    this.save(rows.filter(row => row.id !== p.id)); return true;
  }
  private notice(schedule: Schedule, text: string) {
    this.core.store.activity({ action: 'schedule.run', schedule: schedule.label, status: schedule.lastRun?.outcome || 'unknown' });
    this.core.emit('notice', { kind: 'schedule', text: `${schedule.label}: ${text}` });
  }
  /** What changed since the user reviewed this schedule, if anything. */
  private changed(schedule: Schedule): string | undefined {
    if (schedule.timeZone !== systemTimeZone()) return `the time zone changed from ${schedule.timeZone} to ${systemTimeZone()}`;
    let session; try { session = this.core.store.session(schedule.sourceSessionId); } catch { return 'its conversation was deleted'; }
    if (session.remote) return 'its conversation is controlled from a phone';
    if (JSON.stringify(this.envelope(session.id)) !== JSON.stringify(schedule.envelope)) return 'the conversation settings or permission switches changed';
    try {
      const preview = this.core.workflows.previewFor(schedule.recipeId, schedule.recipeVersion, schedule.inputs, session.id, false);
      if (preview.definitionRevision !== schedule.recipeRevision || preview.authorizationRevision !== schedule.authorizationRevision || digest(preview.prompt) !== schedule.promptDigest) return 'the recipe changed';
    } catch (error: any) { return 'the recipe can no longer be prepared: ' + String(error?.message || error).slice(0, 200); }
    return undefined;
  }
  /** Runs due occurrences. Each is claimed before anything else happens, so it runs at most once. */
  async tick(now = Date.now()) {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const schedule of this.list()) {
        if (!schedule.enabled || schedule.next === undefined || schedule.next > now) continue;
        const occurrence = schedule.next, following = schedule.when.kind === 'once' ? undefined : nextOccurrence(schedule.when, Math.max(now, occurrence));
        const claimed = this.update(schedule.id, { lastOccurrence: occurrence, next: following, ...(following === undefined ? { enabled: false } : {}) })!;
        const record = (outcome: NonNullable<Schedule['lastRun']>['outcome'], reason?: string, sessionId?: string, disable = false) => {
          const updated = this.update(claimed.id, { lastRun: { at: now, outcome, ...(reason ? { reason } : {}), ...(sessionId ? { sessionId } : {}) }, ...(disable ? { enabled: false } : {}) })!;
          return updated;
        };
        if (now - occurrence > scheduleLimits.missedGraceMs) { this.notice(record('missed', 'Cere was not running at the scheduled time'), 'missed; it was not run late'); continue; }
        const previous = claimed.lastRun?.sessionId ? this.core.store.sessions().find(item => item.id === claimed.lastRun!.sessionId) : undefined;
        if (previous && ['starting', 'working', 'waiting', 'stopping'].includes(previous.status)) { this.notice(record('skipped', 'the previous run was still working', previous.id), 'skipped; the previous run is still working'); continue; }
        const reason = this.changed(claimed);
        if (reason) { this.notice(record('paused', reason, undefined, true), `paused because ${reason}. Review the recipe again to schedule it.`); continue; }
        try {
          const preview = this.core.workflows.previewFor(claimed.recipeId, claimed.recipeVersion, claimed.inputs, claimed.sourceSessionId);
          const run: any = await this.core.workflows.dispatch('recipes.createDraft', { previewToken: preview.token, reviewed: true });
          await this.core.send({ id: run.session.id, text: preview.prompt });
          this.notice(record('started', undefined, run.session.id), 'started. Its result will appear in the inbox; permission questions wait for you.');
        } catch (error: any) { this.notice(record('failed', String(error?.message || error).slice(0, 300)), 'could not start: ' + String(error?.message || error).slice(0, 200)); }
      }
    } finally { this.checking = false; }
  }
}
