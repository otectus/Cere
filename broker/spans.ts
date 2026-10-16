/**
 * M16: opt-in responsiveness measurements. While the user has them on, Cere keeps the durations of
 * recent turns, time to first reply text, memory recall, tool calls, time to first speech audio and how
 * long Stop took, plus how late the broker's and the window's event loops ran. A span holds a kind, a
 * duration, an outcome and at most a provider or tool family: never text, paths, arguments or audio.
 * The store is a fixed ring in memory; when off, recording returns at once and nothing is sampled.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

export type SpanKind = 'turn' | 'first-token' | 'memory' | 'tool' | 'synthesis' | 'cancel';
export const spanKinds: SpanKind[] = ['turn', 'first-token', 'memory', 'tool', 'synthesis', 'cancel'];
type Span = { kind: SpanKind; ms: number; outcome: 'ok' | 'failed' | 'stopped'; detail: string; at: number };
type Lag = { p50: number; p90: number; max: number; samples: number };
export const spanLimits = { entries: 500, detailChars: 40 };
const round = (value: number) => Math.round(value * 10) / 10;
const quantile = (sorted: number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0;

export class Spans {
  private ring: Span[] = []; private histogram?: ReturnType<typeof monitorEventLoopDelay>; private since = 0; private ui?: Lag & { at: number };
  enabled = false;
  /** Turning measurements on starts the loop-delay sampler; turning them off stops it and forgets everything. */
  configure(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled; this.ring = []; this.ui = undefined;
    if (enabled) { this.since = Date.now(); this.histogram = monitorEventLoopDelay({ resolution: 20 }); this.histogram.enable(); }
    else { this.histogram?.disable(); this.histogram = undefined; this.since = 0; }
  }
  record(kind: SpanKind, ms: number, outcome: Span['outcome'] = 'ok', detail = '') {
    if (!this.enabled || !Number.isFinite(ms) || ms < 0) return;
    this.ring.push({ kind, ms: round(ms), outcome, detail: detail.replace(/[^a-z0-9_-]/gi, '').slice(0, spanLimits.detailChars), at: Date.now() });
    if (this.ring.length > spanLimits.entries) this.ring.splice(0, this.ring.length - spanLimits.entries);
  }
  /** A timer for one span; when off it costs a closure and nothing else. */
  start(kind: SpanKind, detail = '') {
    if (!this.enabled) return (_outcome?: Span['outcome']) => {};
    const started = performance.now();
    return (outcome: Span['outcome'] = 'ok') => this.record(kind, performance.now() - started, outcome, detail);
  }
  /** The window's own event-loop lateness, measured in the interface and sent as an aggregate. */
  uiLag(value: unknown) {
    if (!this.enabled) return false;
    const p = value as Record<string, unknown>, numbers = ['p50', 'p90', 'max', 'samples'].map(key => p?.[key]);
    if (!p || typeof p !== 'object' || numbers.some(number => typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 600_000)) throw new Error('Invalid interface timing');
    this.ui = { p50: round(p.p50 as number), p90: round(p.p90 as number), max: round(p.max as number), samples: Math.round(p.samples as number), at: Date.now() };
    return true;
  }
  clear() { this.ring = []; this.ui = undefined; this.histogram?.reset(); if (this.enabled) this.since = Date.now(); }
  /** Aggregates only: counts, medians, 90th percentiles and maxima in milliseconds. */
  summary() {
    if (!this.enabled) return { enabled: false as const };
    const kinds = Object.fromEntries(spanKinds.map(kind => {
      const spans = this.ring.filter(span => span.kind === kind), sorted = spans.map(span => span.ms).sort((a, b) => a - b);
      const details = [...new Set(spans.map(span => span.detail).filter(Boolean))].slice(0, 12);
      return [kind, { count: spans.length, p50: quantile(sorted, .5), p90: quantile(sorted, .9), max: sorted.at(-1) || 0, failed: spans.filter(span => span.outcome === 'failed').length,
        stopped: spans.filter(span => span.outcome === 'stopped').length, ...(details.length ? { details } : {}) }];
    }));
    const h = this.histogram, broker = h && h.count ? { p50: round(h.percentile(50) / 1e6), p90: round(h.percentile(90) / 1e6), max: round(h.max / 1e6), samples: h.count } : { p50: 0, p90: 0, max: 0, samples: 0 };
    return { enabled: true as const, since: new Date(this.since).toISOString(), spans: kinds, brokerLag: broker, uiLag: this.ui ? { p50: this.ui.p50, p90: this.ui.p90, max: this.ui.max, samples: this.ui.samples } : null,
      note: 'Durations in milliseconds. No conversation text, paths, arguments or audio are recorded.' };
  }
}
