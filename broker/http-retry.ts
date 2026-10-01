import { setTimeout as delay } from 'node:timers/promises';

export const transientHttpStatuses = new Set([429, 500, 502, 503, 504]);
export class HttpStatusError extends Error {
  status: number; retryAfter?: string | null;
  constructor(status: number, message: string, retryAfter?: string | null) {
    super(message); this.name = 'HttpStatusError'; this.status = status; this.retryAfter = retryAfter;
  }
}
export type RetryNotice = { status: number; attempt: number; maxRetries: number; delayMs: number };
export type RetryOptions = {
  signal?: AbortSignal;
  maxRetries?: number;
  initialDelayMs?: number;
  multiplier?: number;
  jitter?: number;
  maxDelayMs?: number;
  label?: string;
  onRetry?: (notice: RetryNotice) => void;
  log?: (message: string) => void;
  /** Injectable clock and sleep keep tests deterministic without real backoff waits. */
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};
function header(headers: any): unknown { return typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after']; }
function serverDelay(value: unknown, now: number) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  // Only HTTP dates, not numbers that Date.parse interprets as calendar years.
  const date = /[a-z]/i.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(date) ? Math.max(0, date-now) : 0;
}

/** Wrap one HTTP attempt, not stream consumption or a tool loop. Supports SDK errors
 * with status or response.status; fetch callers should throw HttpStatusError for !ok.
 * Unknown transport outcomes, cancellation and every unlisted status fail immediately. */
export async function withHttpRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { signal, maxRetries=3, initialDelayMs=1000, multiplier=2, jitter=.25, maxDelayMs=60000,
    random=Math.random, now=Date.now, sleep=(ms, signal)=>delay(ms,undefined,{signal}),
    log=message=>console.warn(message), label='HTTP' } = options;
  if (!Number.isInteger(maxRetries) || maxRetries<0 || maxRetries>20 || !Number.isFinite(initialDelayMs) || initialDelayMs<0 ||
      !Number.isFinite(multiplier) || multiplier<1 || !Number.isFinite(jitter) || jitter<0 || jitter>1 || !Number.isFinite(maxDelayMs) || maxDelayMs<initialDelayMs)
    throw new Error('Invalid HTTP retry options');
  for (let attempt=0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(attempt); }
    catch (error: any) {
      signal?.throwIfAborted();
      const status = error?.status ?? error?.response?.status;
      if (['AbortError','TimeoutError'].includes(error?.name) || !transientHttpStatuses.has(status) || attempt>=maxRetries) throw error;
      const hinted=serverDelay(error?.retryAfter ?? header(error?.headers) ?? header(error?.response?.headers),now());
      // Never violate a server's minimum wait to squeeze a retry into our limit.
      if(hinted>maxDelayMs)throw error;
      const base=Math.min(maxDelayMs,initialDelayMs*multiplier**attempt);
      const sample=random(); if(!Number.isFinite(sample)||sample<0||sample>1)throw new Error('Invalid HTTP retry jitter source');
      const delayMs=Math.ceil(Math.min(maxDelayMs,Math.max(base,hinted)+base*jitter*sample));
      const notice={status,attempt:attempt+1,maxRetries,delayMs};
      // No URLs, headers, prompts or exception messages enter retry logs.
      log(`[${label}] HTTP ${status}; retry ${notice.attempt}/${maxRetries} in ${delayMs}ms`);
      options.onRetry?.(notice);
      signal?.throwIfAborted();
      try { await sleep(delayMs,signal); } catch(error) { signal?.throwIfAborted(); throw error; }
    }
  }
}
