import { parentPort, workerData } from "node:worker_threads";
import { Canonical } from "./canonical.ts";
const port = parentPort!;
let store: Canonical;
try {
  store = new Canonical(workerData.directory, { backups: workerData.backups });
  port.postMessage({ ready: true });
} catch (e: any) {
  port.postMessage({
    fatal: { code: e.code || "BACKEND_UNAVAILABLE", message: e.message },
  });
  throw e;
}
let queue = Promise.resolve(),
  depth = 0;
port.on("message", (m) => {
  if (depth >= 1000) {
    port.postMessage({
      id: m.id,
      error: {
        code: "BACKEND_UNAVAILABLE",
        message: "Memory queue is full; retry this request",
      },
    });
    return;
  }
  depth++;
  queue = queue.then(async () => {
    let reply: Record<string, unknown>;
    try {
      if(m.cancellation && Atomics.compareExchange(m.cancellation,0,0,2)!==0)throw Object.assign(new Error('Memory request cancelled before execution'),{code:'SOURCE_CHANGED'});
      if (m.method === "close") {
        store.close();
        port.postMessage({ id: m.id, result: true });
        port.close();
        return;
      }
      // The broker's watchdog times the call from this notice. Long walks stop at their next
      // checkpoint once the caller cancels (second cancellation slot) or the call's budget is spent.
      port.postMessage({ started: m.id });
      store.deadline = m.budgetMs > 0 ? Date.now() + m.budgetMs : Infinity;
      const cancellation: Int32Array | undefined = m.cancellation instanceof Int32Array && m.cancellation.length > 1 ? m.cancellation : undefined;
      store.cancelled = cancellation ? () => Atomics.load(cancellation, 1) === 1 : undefined;
      reply = { id: m.id, result: await store.call(m.method, m.params) };
    } catch (e: any) {
      reply = {
        id: m.id,
        error: {
          code: e.code || "INVALID_ARGUMENT",
          message: e.code ? e.message : "Memory operation failed validation",
        },
      };
    } finally {
      depth--;
      store.deadline = Infinity;
      store.cancelled = undefined;
    }
    // Events from work that committed, including part of a call that then stopped, precede its reply.
    for (const event of store.events.splice(0)) port.postMessage({ event });
    port.postMessage(reply);
  });
});
