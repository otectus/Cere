import { parentPort, workerData } from "node:worker_threads";
import { Canonical } from "./canonical.ts";
const port = parentPort!;
let store: Canonical;
try {
  store = new Canonical(workerData.directory);
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
    try {
      if(m.cancellation && Atomics.compareExchange(m.cancellation,0,0,2)!==0)throw Object.assign(new Error('Memory request cancelled before execution'),{code:'SOURCE_CHANGED'});
      if (m.method === "close") {
        store.close();
        port.postMessage({ id: m.id, result: true });
        port.close();
        return;
      }
      const result = await store.call(m.method, m.params);
      for (const event of store.events.splice(0)) port.postMessage({ event });
      port.postMessage({ id: m.id, result });
    } catch (e: any) {
      port.postMessage({
        id: m.id,
        error: {
          code: e.code || "INVALID_ARGUMENT",
          message: e.code ? e.message : "Memory operation failed validation",
        },
      });
    } finally {
      depth--;
    }
  });
});
