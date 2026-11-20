/**
 * Durable operation records: image jobs, analysis runs, commands and extractions. A long job is never
 * only a chat message or an in-memory promise. Each record gets a local ID before any side effect, its
 * dispatch intent is persisted before submission, and every state change is a revisioned transition with
 * an event row. `unknown` means the request may have taken effect; it is not failure, and nothing in it
 * is resubmitted automatically.
 *
 *   prepared → awaiting_approval → queued → dispatching → running → completed | failed | cancel_requested
 *   dispatching → unknown; cancel_requested → cancelled | unknown
 *   and, before dispatch: cancelled, declined, expired; during local work: interrupted
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import type { ArtifactRef, ProcessingRoute } from '../tools/contracts.ts';

export type OperationState = 'prepared' | 'awaiting_approval' | 'queued' | 'dispatching' | 'running' | 'cancel_requested'
  | 'completed' | 'failed' | 'cancelled' | 'declined' | 'expired' | 'interrupted' | 'unknown';
export const terminalStates: OperationState[] = ['completed', 'failed', 'cancelled', 'declined', 'expired', 'interrupted', 'unknown'];
const transitions: Record<OperationState, OperationState[]> = {
  prepared: ['awaiting_approval', 'queued', 'declined', 'cancelled', 'expired', 'failed'],
  awaiting_approval: ['queued', 'declined', 'cancelled', 'expired', 'failed'],
  queued: ['dispatching', 'running', 'cancelled', 'failed', 'interrupted'],
  dispatching: ['running', 'completed', 'failed', 'unknown', 'cancel_requested', 'interrupted'],
  running: ['completed', 'failed', 'cancel_requested', 'unknown', 'interrupted'],
  cancel_requested: ['cancelled', 'unknown', 'completed', 'failed'],
  completed: [], failed: [], cancelled: [], declined: [], expired: [], interrupted: [], unknown: ['completed', 'failed'],
};
export type OperationKind = 'image.generate' | 'image.edit' | 'image.transform' | 'vision.analyze' | 'ocr' | 'extraction' | 'codelab.run' | 'command.run' | 'export';
export type Operation = {
  id: string; sessionId: string; turnId?: string; parentId?: string; groupId?: string;
  kind: OperationKind; origin: 'model' | 'user' | 'schedule'; label: string;
  state: OperationState; revision: number; created: number; updated: number; deadline?: number;
  /** Exact digest of the validated request; a second submission of the same prepared operation is refused. */
  payloadDigest: string;
  /** What authorized it: route, connection revision, folder policies and inputs as checked. */
  witness: Record<string, unknown>;
  inputs: ArtifactRef[];
  backend?: { connectionId: string; kind: string; model?: string; workflow?: string; revision: number; route: ProcessingRoute };
  /** The backend's job ID when it has one; it permits status queries, never resubmission. */
  remoteId?: string;
  /** Only what the backend reported; Cere never invents a percentage. */
  progress?: { value?: number; max?: number; note?: string; at: number };
  results: ArtifactRef[];
  partials?: ArtifactRef[];
  usage?: Record<string, number | string>;
  reservation?: { images?: number; calls?: number; state: 'held' | 'settled' | 'released' | 'unknown' };
  error?: { code: string; message: string };
  cancellation?: { requested: number; confirmed: boolean; note: string };
  /** Small, display-safe facts: prompt, parameters, run summary. */
  details?: Record<string, unknown>;
  recovery?: string;
};
export class OperationStore {
  store: Store;
  changed: (operation: Operation) => void = () => {};
  constructor(store: Store) { this.store = store; }
  static digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private save(operation: Operation, event: Record<string, unknown>) {
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision,updated=excluded.updated,data=excluded.data')
        .run(operation.id, operation.sessionId, operation.kind, operation.state, operation.revision, operation.created, operation.updated, JSON.stringify(operation));
      this.store.db.prepare('INSERT INTO operation_events(operation_id,time,data) VALUES (?,?,?)').run(operation.id, operation.updated, JSON.stringify(event));
    });
    this.changed(operation);
  }
  /** A new record with its local ID, before anything is sent anywhere. */
  create(p: Omit<Operation, 'id' | 'state' | 'revision' | 'created' | 'updated' | 'results'> & { state?: OperationState }): Operation {
    const time = Date.now();
    const operation: Operation = { ...p, id: randomUUID(), state: p.state || 'prepared', revision: 1, created: time, updated: time, results: [] };
    this.save(operation, { state: operation.state, note: 'created' });
    return operation;
  }
  get(id: unknown): Operation {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown operation');
    const row = this.store.db.prepare('SELECT data FROM operations WHERE id=?').get(id);
    if (!row) throw new Error('That operation no longer exists');
    return JSON.parse(String(row.data));
  }
  /** Applies a transition if the record is still at the expected revision; a stale or illegal one throws. */
  transition(id: string, state: OperationState, patch: Partial<Operation> = {}, expectedRevision?: number): Operation {
    const current = this.get(id);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw Object.assign(new Error('This operation changed; reload it'), { code: 'REVISION_CONFLICT' });
    if (state !== current.state && !transitions[current.state].includes(state)) throw new Error(`An operation cannot go from ${current.state} to ${state}`);
    const next: Operation = { ...current, ...patch, state, revision: current.revision + 1, updated: Date.now() };
    this.save(next, { state, from: current.state, ...(patch.error ? { error: patch.error.code } : {}), ...(patch.remoteId ? { remoteId: true } : {}) });
    return next;
  }
  /** Progress and partial results without a state change, coalesced by the caller. */
  update(id: string, patch: Partial<Pick<Operation, 'progress' | 'partials' | 'usage' | 'details' | 'remoteId'>>): Operation {
    const current = this.get(id), next: Operation = { ...current, ...patch, revision: current.revision + 1, updated: Date.now() };
    this.store.db.prepare('UPDATE operations SET revision=?,updated=?,data=? WHERE id=?').run(next.revision, next.updated, JSON.stringify(next), id);
    this.changed(next);
    return next;
  }
  list(sessionId: string, p: { active?: boolean; limit?: number; before?: number } = {}) {
    const limit = Math.min(p.limit || 50, 200);
    const rows = this.store.db.prepare(`SELECT data FROM operations WHERE session_id=? ${p.active ? `AND state NOT IN (${terminalStates.map(() => '?').join(',')})` : ''} AND (? IS NULL OR updated < ?) ORDER BY updated DESC LIMIT ?`)
      .all(sessionId, ...(p.active ? terminalStates : []), p.before ?? null, p.before ?? null, limit);
    return rows.map(row => JSON.parse(String(row.data)) as Operation);
  }
  active() { return this.store.db.prepare(`SELECT data FROM operations WHERE state NOT IN (${terminalStates.map(() => '?').join(',')})`).all(...terminalStates).map(row => JSON.parse(String(row.data)) as Operation); }
  events(id: string, limit = 50) { return this.store.db.prepare('SELECT time,data FROM operation_events WHERE operation_id=? ORDER BY id DESC LIMIT ?').all(id, limit).map(row => ({ time: Number(row.time), ...JSON.parse(String(row.data)) })); }
  /** A prepared request already accepted for this exact payload, so two clicks start one job. */
  findPrepared(sessionId: string, payloadDigest: string) {
    return this.store.db.prepare(`SELECT data FROM operations WHERE session_id=? AND json_extract(data,'$.payloadDigest')=? AND state NOT IN (${terminalStates.map(() => '?').join(',')})`).all(sessionId, payloadDigest, ...terminalStates).map(row => JSON.parse(String(row.data)) as Operation)[0];
  }
  /**
   * After a restart: nothing outstanding resumes by itself. Work that never left Cere is interrupted;
   * a dispatch whose answer was lost is unknown; a job with a backend ID that supports status queries is
   * marked for reconciliation by status, never by resubmission.
   */
  recover(queryable: (operation: Operation) => boolean) {
    const reconcile: Operation[] = [];
    for (const operation of this.active()) {
      if ((operation.state === 'running' || operation.state === 'dispatching' || operation.state === 'cancel_requested') && operation.remoteId && queryable(operation)) { reconcile.push(this.update(operation.id, { details: { ...operation.details, reconciling: true } })); continue; }
      if (operation.state === 'dispatching' || operation.state === 'cancel_requested' || (operation.state === 'running' && operation.backend && operation.backend.route !== 'local' && !['image.transform', 'codelab.run', 'command.run', 'extraction'].includes(operation.kind)))
        this.transition(operation.id, 'unknown', { recovery: 'Cere restarted before this request’s outcome was known. It may have completed and may have been billed; it was not sent again.' });
      else this.transition(operation.id, operation.state === 'running' ? 'interrupted' : operation.state === 'queued' ? 'interrupted' : 'cancelled', { recovery: operation.state === 'running' ? 'Cere restarted while this was running locally; nothing was sent again.' : 'Cere restarted before this was started; nothing was sent.' });
    }
    return reconcile;
  }
  removeSession(sessionId: string) {
    this.store.db.prepare('DELETE FROM operation_events WHERE operation_id IN (SELECT id FROM operations WHERE session_id=?)').run(sessionId);
    this.store.db.prepare('DELETE FROM budget_reservations WHERE operation_id IN (SELECT id FROM operations WHERE session_id=?)').run(sessionId);
    this.store.db.prepare('DELETE FROM usage_records WHERE session_id=?').run(sessionId);
    this.store.db.prepare('DELETE FROM operations WHERE session_id=?').run(sessionId);
  }
  /** Reported usage, kept apart from estimates. */
  recordUsage(operation: Operation, usage: Record<string, number | string>, source: string) {
    this.store.db.prepare('INSERT INTO usage_records VALUES (?,?,?,?,?)').run(randomUUID(), operation.sessionId, operation.id, Date.now(), JSON.stringify({ ...usage, source, kind: operation.kind, backend: operation.backend?.kind || '', model: operation.backend?.model || '' }));
  }
  usage(sessionId: string) { return this.store.db.prepare('SELECT data,time FROM usage_records WHERE session_id=? ORDER BY time DESC LIMIT 500').all(sessionId).map(row => ({ time: Number(row.time), ...JSON.parse(String(row.data)) })); }
  /** Reserves known budget before dispatch; settled or released only on known outcomes. */
  reserve(operation: Operation, p: { images?: number; calls?: number }) {
    this.store.db.prepare('INSERT INTO budget_reservations VALUES (?,?,?,?,?)').run(randomUUID(), operation.id, 'held', Date.now(), JSON.stringify(p));
  }
  settle(operationId: string, state: 'settled' | 'released' | 'unknown') { this.store.db.prepare("UPDATE budget_reservations SET state=? WHERE operation_id=? AND state='held'").run(state, operationId); }
  /** Images counted against today's budget: completed, held (in flight) and unknown outcomes all count. */
  imagesToday(connectionId: string) {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    let total = 0;
    for (const row of this.store.db.prepare("SELECT r.data AS reservation, r.state AS state, o.data AS operation FROM budget_reservations r JOIN operations o ON o.id=r.operation_id WHERE r.created>=? AND r.state IN ('held','settled','unknown')").all(since.getTime())) {
      const operation = JSON.parse(String(row.operation)) as Operation;
      if (operation.backend?.connectionId === connectionId) total += Number(JSON.parse(String(row.reservation)).images || 0);
    }
    return total;
  }
}
