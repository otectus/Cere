import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import type { Session } from './types.ts';

export type PowerLeaseState = 'active' | 'ending' | 'ended' | 'unconfirmed';
export type PowerLease = {
  id: string;
  cwd: string;
  sessionIds: string[];
  cli: boolean;
  computer: boolean;
  createdAt: number;
  expiresAt: number;
  revision: number;
  state: PowerLeaseState;
  reason?: string;
};
export type PowerStart = { sessionIds: string[]; minutes: number; cli: boolean; computer: boolean };
export type PowerEffective = { cli: boolean; computer: boolean; leaseId?: string; revision?: number; expiresAt?: number };
export type PowerHooks = {
  sessions(): Session[];
  /** Stop the turn and close any provider adapter that could retain unrestricted authority. */
  stop(sessionId: string): Promise<void>;
  changed(): void;
  now?: () => number;
};

const maximumMinutes = 120;
/**
 * Process-local, project-bound permission leases. Nothing in this class is
 * persisted: a broker restart always invalidates every lease.
 *
 * This controls authority granted through Cere and its provider launch flags.
 * It is not operating-system containment for processes outside Cere.
 */
export class PowerSessions {
  readonly hooks: PowerHooks;
  readonly leases = new Map<string, PowerLease>();
  private readonly ending = new Map<string, Promise<PowerLease>>();
  private readonly startingSessions = new Set<string>();
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(hooks: PowerHooks) { this.hooks = hooks; }

  async start(input: PowerStart): Promise<PowerLease> {
    if (this.closed) throw new Error('Power sessions are closed');
    if (!input || !Array.isArray(input.sessionIds) || input.sessionIds.length === 0) throw new Error('Select at least one session');
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > maximumMinutes) throw new Error(`Power duration must be between 1 and ${maximumMinutes} minutes`);
    if (input.cli !== true && input.computer !== true) throw new Error('Select CLI access, computer control, or both');
    if (typeof input.cli !== 'boolean' || typeof input.computer !== 'boolean') throw new Error('Power access choices must be explicit');
    const ids = [...new Set(input.sessionIds)];
    if (ids.length !== input.sessionIds.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid session selection');

    // Revoke expired authority before checking conflicts. start() never extends
    // or edits an existing lease as an accidental side effect.
    await this.tick();
    const validate = () => {
      const sessions = new Map(this.hooks.sessions().map(session => [session.id, session]));
      const selected = ids.map(id => sessions.get(id));
      if (selected.some(session => !session)) throw new Error('A selected session no longer exists');
      for (const session of selected as Session[]) {
        if (session.mode !== 'managed') throw new Error('Power mode only supports managed sessions');
        if (session.temporary) throw new Error('Power mode is unavailable for temporary sessions');
        if (session.remote) throw new Error('Power mode is unavailable for remote sessions');
        if (session.status !== 'idle') throw new Error('Stop the selected session before enabling power mode');
        if (this.blockingLeaseFor(session.id)) throw new Error('A selected session has an active or unconfirmed power lease');
        if (this.startingSessions.has(session.id)) throw new Error('Power mode is already starting for a selected session');
      }
      return selected as Session[];
    };
    let selected = validate();
    for (const id of ids) this.startingSessions.add(id);
    try {
      const roots: string[] = [];
      for (const candidate of selected) {
        roots.push(await this.projectRoot(candidate.cwd));
        // Recheck all live inputs after every filesystem await. The reservation
        // prevents another concurrent start from passing this same boundary.
        selected = this.validateReserved(ids);
      }
      if (roots.some(root => root !== roots[0])) throw new Error('Selected sessions must use the same project folder');
      for (const live of selected) {
        const root = await this.projectRoot(live.cwd);
        selected = this.validateReserved(ids);
        if (root !== roots[0]) throw new Error('A selected session changed projects while power mode was starting');
      }
      // No awaits follow this final validation and precede publication.
      selected = this.validateReserved(ids);
      const createdAt = this.now();
      const lease: PowerLease = {
        id: randomUUID(), cwd: roots[0], sessionIds: ids, cli: input.cli, computer: input.computer,
        createdAt, expiresAt: createdAt + input.minutes * 60_000, revision: 1, state: 'active',
      };
      this.leases.set(lease.id, lease);
      this.schedule();
      this.hooks.changed();
      return this.copy(lease);
    } finally {
      for (const id of ids) this.startingSessions.delete(id);
    }
  }

  async end(id: string, reason = 'ended_by_user'): Promise<PowerLease> {
    const lease = this.leases.get(id);
    if (!lease) throw new Error('Unknown power lease');
    if (lease.state === 'active' || lease.state === 'unconfirmed') return this.copy(await this.beginEnd(lease, reason));
    const pending = this.ending.get(id);
    return pending ? this.copy(await pending) : this.copy(lease);
  }

  effective(session: Session): PowerEffective {
    // The state transition happens synchronously. Provider dispatch must not
    // retain authority while expiry cleanup is still awaiting I/O.
    this.expireDue();
    if (session.mode !== 'managed' || session.remote) return { cli: false, computer: false };
    const lease = this.activeLeaseFor(session.id);
    if (!lease || this.canonicalNow(session.cwd) !== lease.cwd) return { cli: false, computer: false };
    return { cli: lease.cli, computer: lease.computer, leaseId: lease.id, revision: lease.revision, expiresAt: lease.expiresAt };
  }

  snapshot(): PowerLease[] {
    this.expireDue();
    return [...this.leases.values()].map(lease => this.copy(lease)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async tick(): Promise<void> {
    const pending = this.expireDue();
    const settling = [...new Set([...pending, ...this.ending.values()])];
    if (settling.length) await Promise.all(settling);
  }

  async attachChild(parent: string | Session, child: string | Session): Promise<boolean> {
    if (this.closed) return false;
    this.expireDue();
    const sessions = new Map(this.hooks.sessions().map(session => [session.id, session]));
    const parentSession = typeof parent === 'string' ? sessions.get(parent) : sessions.get(parent.id);
    const childSession = typeof child === 'string' ? sessions.get(child) : sessions.get(child.id);
    if (!parentSession || !childSession || parentSession.mode !== 'managed' || childSession.mode !== 'managed' || parentSession.remote || childSession.remote) return false;
    if (childSession.parentId !== parentSession.id) return false;
    const parentRoot = await this.projectRoot(parentSession.cwd).catch(() => '');
    this.expireDue();
    const childRoot = await this.projectRoot(childSession.cwd).catch(() => '');
    this.expireDue();
    if (!parentRoot || parentRoot !== childRoot) return false;
    const live = new Map(this.hooks.sessions().map(session => [session.id, session]));
    const liveParent = live.get(parentSession.id), liveChild = live.get(childSession.id);
    if (!liveParent || !liveChild || liveParent.mode !== 'managed' || liveChild.mode !== 'managed' || liveParent.remote || liveChild.remote || liveChild.parentId !== liveParent.id) return false;
    if (this.canonicalNow(liveParent.cwd) !== parentRoot || this.canonicalNow(liveChild.cwd) !== parentRoot) return false;
    const lease = this.activeLeaseFor(liveParent.id);
    if (!lease || lease.cwd !== parentRoot || lease.sessionIds.includes(childSession.id)) return !!lease && lease.cwd === parentRoot;
    if (this.activeLeaseFor(childSession.id)) return false;
    lease.sessionIds.push(childSession.id);
    lease.revision++;
    this.hooks.changed();
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.all([...this.leases.values()].filter(lease => lease.state === 'active').map(lease => this.beginEnd(lease, 'broker_closed')));
  }

  private now() { return this.hooks.now?.() ?? Date.now(); }
  private copy(lease: PowerLease): PowerLease { return { ...lease, sessionIds: [...lease.sessionIds] }; }
  private activeLeaseFor(sessionId: string) { return [...this.leases.values()].find(lease => lease.state === 'active' && lease.sessionIds.includes(sessionId)); }
  private blockingLeaseFor(sessionId: string) { return [...this.leases.values()].find(lease => lease.state !== 'ended' && lease.sessionIds.includes(sessionId)); }
  private validateReserved(ids: string[]) {
    const sessions = new Map(this.hooks.sessions().map(session => [session.id, session]));
    return ids.map(id => {
      const session = sessions.get(id);
      if (!session || session.mode !== 'managed' || session.temporary || session.remote || session.status !== 'idle') throw new Error('A selected session changed while power mode was starting');
      if (!this.startingSessions.has(id) || this.blockingLeaseFor(id)) throw new Error('A selected session has an active or unconfirmed power lease');
      return session;
    });
  }
  private async projectRoot(cwd: string) {
    if (typeof cwd !== 'string' || !cwd) throw new Error('Project folder is required');
    const canonical = await realpath(cwd);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Project must be a folder');
    return canonical;
  }
  private canonicalNow(cwd: string) { try { return realpathSync(cwd); } catch { return ''; } }

  private expireDue(): Promise<PowerLease>[] {
    const now = this.now(), pending: Promise<PowerLease>[] = [];
    for (const lease of this.leases.values()) if (lease.state === 'active' && lease.expiresAt <= now) pending.push(this.beginEnd(lease, 'expired'));
    this.schedule();
    return pending;
  }

  private beginEnd(lease: PowerLease, reason: string): Promise<PowerLease> {
    const existing = this.ending.get(lease.id);
    if (existing) return existing;
    lease.state = 'ending';
    lease.reason = reason;
    lease.revision++;
    this.schedule();
    this.hooks.changed();
    const present = new Set(this.hooks.sessions().map(session => session.id));
    const pending = Promise.allSettled(lease.sessionIds.filter(id => present.has(id)).map(id => this.hooks.stop(id))).then(results => {
      lease.state = results.some(result => result.status === 'rejected') ? 'unconfirmed' : 'ended';
      lease.revision++;
      this.ending.delete(lease.id);
      this.hooks.changed();
      return lease;
    });
    this.ending.set(lease.id, pending);
    return pending;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.hooks.now) return;
    const expiries = [...this.leases.values()].filter(lease => lease.state === 'active').map(lease => lease.expiresAt);
    if (!expiries.length) return;
    this.timer = setTimeout(() => { void this.tick(); }, Math.max(0, Math.min(...expiries) - this.now()));
    this.timer.unref();
  }
}
