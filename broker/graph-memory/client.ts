import { Worker } from "node:worker_threads";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { MemoryError } from "./contracts.ts";

/**
 * Time budgets in milliseconds. A budgeted call stops at its next checkpoint once its budget is
 * spent, never inside a transaction: forget previews, the source lookup that precedes an erasure,
 * and expiry. An accepted erasure has no budget; its preview already ran within one, and a replay
 * at startup must be able to finish.
 */
export const memoryBudgets: Readonly<Record<string, number>> = {
  forget_preview: 30000,
  forget_sources: 30000,
  mobile_forget_preview: 30000,
  mobile_forget_sources: 30000,
  maintenance: 60000,
  expire: 60000,
};
/**
 * How long one call may run before the watchdog ends the worker and starts another. An erasure or
 * expiry that has begun committing may outlast its budget while it finishes; backup, restore,
 * rebuild, compaction, re-adjudication (which backs up first) and legacy import are never ended.
 */
export function watchdogLimit(method: string) {
  if (["backup", "restore", "rebuild", "compact", "readjudicate", "import_legacy", "close"].includes(method)) return Infinity;
  if (["forget", "mobile_forget", "maintenance", "expire"].includes(method)) return 600000;
  return (memoryBudgets[method] ?? 0) + 60000;
}
export type GraphMemoryOptions = {
  /** The worker module; tests substitute one that misbehaves. */
  workerUrl?: URL;
  watchdogMs?: number;
  limit?: (method: string) => number;
};
/** Worker-owned SQLite keeps all database calls off the broker/UI event loop. */
export class GraphMemory {
  worker!: Worker;
  ready!: Promise<void>;
  pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  /** Methods of calls posted to the current worker and not yet answered, cancelled ones included. */
  calls = new Map<string, string>();
  /** The call the worker is running, timed from its start notice. */
  active?: { id: string; method: string; started: number };
  closed = false;
  /** Terminal worker failure; every later call rejects with it instead of waiting. */
  failure?: MemoryError;
  notify: (event: any) => void;
  directory: string;
  workerUrl: URL;
  limit: (method: string) => number;
  watchdog: NodeJS.Timeout;
  /** Workers the watchdog replaced. */
  restarts = 0;
  constructor(directory: string, notify: (event: any) => void = () => {}, options: GraphMemoryOptions = {}) {
    this.notify = notify;
    this.directory = directory;
    this.workerUrl = options.workerUrl ?? new URL("./worker.ts", import.meta.url);
    this.limit = options.limit ?? watchdogLimit;
    this.spawn();
    this.watchdog = setInterval(() => this.inspect(), options.watchdogMs ?? 5000);
    this.watchdog.unref();
  }
  /** Starts a worker. Messages, errors and exits from a replaced worker are ignored. */
  spawn() {
    const worker = new Worker(this.workerUrl, {
      workerData: { directory: join(this.directory, "graph-memory"), backups: join(this.directory, "memory-backups") },
    });
    this.worker = worker;
    let resolve!: () => void, reject!: (e: any) => void;
    this.ready = new Promise<void>((a, b) => {
      resolve = a;
      reject = b;
    });
    this.ready.catch(() => {});
    const current = () => this.worker === worker;
    const failed = (error: MemoryError) => {
      if (!current()) return;
      this.failure ??= error;
      reject(this.failure);
      for (const r of this.pending.values()) r.reject(this.failure);
      this.pending.clear();
      this.calls.clear();
      this.active = undefined;
    };
    worker.on("message", (m) => {
      if (!current()) return;
      if (m.ready) {
        resolve();
        return;
      }
      if (m.fatal) {
        failed(new MemoryError(m.fatal.code, m.fatal.message));
        return;
      }
      if (m.event) {
        this.notify(m.event);
        return;
      }
      if (m.started) {
        this.active = { id: m.started, method: this.calls.get(m.started) ?? "", started: Date.now() };
        return;
      }
      this.calls.delete(m.id);
      if (this.active?.id === m.id) this.active = undefined;
      const request = this.pending.get(m.id);
      if (!request) return;
      this.pending.delete(m.id);
      m.error
        ? request.reject(new MemoryError(m.error.code, m.error.message))
        : request.resolve(m.result);
    });
    worker.on("error", (e: any) =>
      failed(new MemoryError("BACKEND_UNAVAILABLE", `Memory worker failed: ${e?.message || e}`)),
    );
    worker.on("exit", (code) => {
      if (!this.closed)
        failed(new MemoryError("BACKEND_UNAVAILABLE", `Memory worker exited (${code})`));
    });
  }
  /**
   * Ends a worker whose current call has run past its limit. That call fails as an unknown outcome
   * and queued calls fail outright; its open transaction rolls back, and a new worker serves the
   * next call after replaying any recorded erasure that never committed.
   */
  inspect() {
    const active = this.active;
    if (this.closed || this.failure || !active || Date.now() - active.started <= this.limit(active.method)) return;
    const previous = this.worker,
      pending = [...this.pending.values()],
      error = new MemoryError("BACKEND_UNAVAILABLE", "Memory stopped a request that ran too long and restarted");
    this.restarts++;
    this.pending.clear();
    this.calls.clear();
    this.active = undefined;
    this.spawn();
    void previous.terminate();
    for (const r of pending) r.reject(error);
    this.notify({ type: "worker_restarted", method: active.method });
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    await this.ready;
    signal?.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.closed)
      throw new MemoryError("BACKEND_UNAVAILABLE", "Memory worker is closed");
    const id = randomUUID(),
      worker = this.worker;
    // Slot 0 is the claim handshake: the worker claims a queued call (0 to 2) before running it, and
    // a cancellation that wins the race (0 to 1) skips it; a claimed call's outcome is unknown.
    // Slot 1 asks a running call to stop at its next checkpoint.
    const cancellation = new Int32Array(new SharedArrayBuffer(8));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        Atomics.store(cancellation, 1, 1);
        const previous=Atomics.compareExchange(cancellation,0,0,1);
        reject(previous===2 ? new MemoryError('OUTCOME_UNKNOWN','Memory work may have completed before cancellation.') : signal!.reason);
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", abort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", abort);
          reject(e?.code==='BACKEND_UNAVAILABLE'&&Atomics.load(cancellation,0)===2 ? new MemoryError('OUTCOME_UNKNOWN','The memory worker stopped after accepting this operation.') : e);
        },
      });
      this.calls.set(id, method);
      try {
        worker.postMessage({ id, method, params, cancellation, budgetMs: memoryBudgets[method] ?? 0 });
      } catch (error: any) {
        this.pending.delete(id);
        this.calls.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(new MemoryError("BACKEND_UNAVAILABLE", `Memory request could not be sent: ${error?.message || error}`));
      }
    });
  }
  /**
   * Idempotent. A failed worker is terminated without requesting an impossible acknowledgement, and a
   * worker still busy after five seconds is ended; its open transaction rolls back.
   */
  closing?: Promise<void>;
  close() {
    this.closing ??= (async () => {
      try {
        if (!this.failure) {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            this.call("close").catch(() => {}),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
          ]);
          clearTimeout(timer);
        }
      } finally {
        this.closed = true;
        clearInterval(this.watchdog);
        await this.worker.terminate();
        // Calls the ended worker never answered fail instead of waiting forever.
        const error = new MemoryError("BACKEND_UNAVAILABLE", "Memory worker is closed");
        for (const r of this.pending.values()) r.reject(error);
        this.pending.clear();
        this.calls.clear();
        this.active = undefined;
      }
    })();
    return this.closing;
  }
}
/** RFC 4122 UUIDv5 for immutable vector publication identity, never raw content. */
export function pointId(
  artifact: string,
  revision: number,
  fingerprint: string,
  generation: number,
) {
  const hash = createHash("sha1")
    .update(
      "cere-memory-vector-v1\0" +
        JSON.stringify([artifact, revision, fingerprint, generation]),
    )
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  const s = hash.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
