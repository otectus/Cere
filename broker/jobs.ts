/**
 * A04: background work in one place. Model downloads, collection indexing and file transcription each
 * keep their own single-flight rules, deadlines and cancellation; this registry lists them together so
 * the window can show and cancel them, lets indexing step aside while a reply is being generated, and
 * cancels everything at shutdown. Nothing here retries or replays a job: a cancelled or failed job is
 * started again only by the user.
 */
import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import { abortableDelay } from './abortable.ts';

export type JobKind = 'model-pull' | 'collection-index' | 'transcription';
type Job = { id: string; kind: JobKind; label: string; started: number; cancel: () => void; progress?: () => { done: number; total: number } | undefined };
export const jobLimits = { foregroundWaitMs: 120_000, pollMs: 250 };

export class BackgroundJobs {
  core: Core; private jobs = new Map<string, Job>();
  constructor(core: Core) { this.core = core; }
  /** Registers running work; the returned function removes it when the work ends, however it ends. */
  add(kind: JobKind, label: string, cancel: () => void, progress?: Job['progress']) {
    const id = randomUUID();
    this.jobs.set(id, { id, kind, label: label.slice(0, 200), started: Date.now(), cancel, progress });
    this.core.changed();
    return () => { if (this.jobs.delete(id) && !this.core.closed) this.core.changed(); };
  }
  snapshot() {
    return [...this.jobs.values()].map(job => ({ id: job.id, kind: job.kind, label: job.label, started: job.started, ...(job.progress?.() ? { progress: job.progress!() } : {}) }));
  }
  cancel(id: unknown) {
    const job = [...this.jobs.values()].find(item => item.id === id);
    if (!job) throw new Error('This background task already ended');
    job.cancel(); return true;
  }
  /** A reply is being generated in some conversation: interactive work comes first. */
  foregroundActive() { return this.core.store.sessions().some(session => session.status === 'starting' || session.status === 'working'); }
  /**
   * Waits while a reply is being generated, up to a bounded time so background work cannot starve.
   * Returns how long it waited; cancellation ends the wait at once with the signal's reason. Each poll
   * removes its abort listener when it ends, so a long wait leaves none behind on the job's signal.
   */
  async yieldToForeground(signal: AbortSignal, maxWaitMs = jobLimits.foregroundWaitMs) {
    const started = Date.now();
    signal.throwIfAborted();
    while (this.foregroundActive() && Date.now() - started < maxWaitMs) await abortableDelay(jobLimits.pollMs, signal, { unref: true });
    signal.throwIfAborted();
    return Date.now() - started;
  }
  cancelAll() { for (const job of this.jobs.values()) try { job.cancel(); } catch { /* Shutdown continues. */ } }
}
