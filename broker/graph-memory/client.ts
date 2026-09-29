import { Worker } from "node:worker_threads";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { MemoryError } from "./contracts.ts";

/** Worker-owned SQLite keeps all database calls off the broker/UI event loop. */
export class GraphMemory {
  worker: Worker;
  ready: Promise<void>;
  pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  closed = false;
  notify: (event: any) => void;
  constructor(directory: string, notify: (event: any) => void = () => {}) {
    this.notify = notify;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { directory: join(directory, "graph-memory") },
    });
    let resolve!: () => void, reject!: (e: any) => void;
    this.ready = new Promise<void>((a, b) => {
      resolve = a;
      reject = b;
    });
    this.worker.on("message", (m) => {
      if (m.ready) {
        resolve();
        return;
      }
      if (m.fatal) {
        reject(new MemoryError(m.fatal.code, m.fatal.message));
        return;
      }
      if (m.event) {
        this.notify(m.event);
        return;
      }
      const request = this.pending.get(m.id);
      if (!request) return;
      this.pending.delete(m.id);
      m.error
        ? request.reject(new MemoryError(m.error.code, m.error.message))
        : request.resolve(m.result);
    });
    this.worker.on("error", (e) => {
      reject(e);
      for (const r of this.pending.values()) r.reject(e);
      this.pending.clear();
    });
    this.worker.on("exit", (code) => {
      if (!this.closed) {
        const e = new MemoryError(
          "BACKEND_UNAVAILABLE",
          `Memory worker exited (${code})`,
        );
        reject(e);
        for (const r of this.pending.values()) r.reject(e);
        this.pending.clear();
      }
    });
    this.ready.catch(() => {});
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    await this.ready;
    signal?.throwIfAborted();
    if (this.closed)
      throw new MemoryError("BACKEND_UNAVAILABLE", "Memory worker is closed");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(signal!.reason);
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", abort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", abort);
          reject(e);
        },
      });
      this.worker.postMessage({ id, method, params });
    });
  }
  async close() {
    if (this.closed) return;
    try {
      await this.call("close");
    } finally {
      this.closed = true;
      await this.worker.terminate();
    }
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
