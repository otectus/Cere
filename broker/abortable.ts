/**
 * Waits `ms`, or until `signal` aborts, whichever comes first. Either way the timer is cleared and
 * the abort listener removed, so a loop of short waits on one long-lived signal leaves nothing behind.
 * Rejects with the signal's own reason when it ends the wait, or at once if it was already aborted.
 * `unref` keeps the wait from holding the process open.
 */
export function abortableDelay(ms: number, signal?: AbortSignal, options: { unref?: boolean } = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let settled = false;
    const settle = (aborted: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(signal!.reason); else resolve();
    };
    const onAbort = () => settle(true);
    const timer = setTimeout(() => settle(false), ms);
    if (options.unref) timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
