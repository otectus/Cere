import { randomUUID } from 'node:crypto';
import type { JsonValue, LiveFreshness, LiveObservation } from './contracts.ts';

export interface LiveClock {
  wallNow(): Date;
  monotonicNowMs(): number;
}

const systemClock: LiveClock = { wallNow: () => new Date(), monotonicNowMs: () => performance.now() };

export class LiveObservationFactory {
  readonly sourceEpoch: string;
  readonly source: LiveObservation['source'];
  readonly ttlMs: number;
  readonly clock: LiveClock;
  private sequence = 0;
  constructor(source: LiveObservation['source'], ttlMs = 10_000, clock: LiveClock = systemClock, epoch?: string) {
    this.source = source; this.ttlMs = ttlMs; this.clock = clock;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('Live observation TTL must be positive');
    this.sourceEpoch = epoch ?? randomUUID();
  }

  observation<T extends Record<string, JsonValue>>(entityId: string, entityGeneration: string, kind: string, properties: T, freshness: LiveFreshness = 'fresh'): LiveObservation<T> {
    const now = this.clock.wallNow(), observedMonotonicMs = this.clock.monotonicNowMs();
    return {
      source: this.source, sourceEpoch: this.sourceEpoch, sourceSequence: ++this.sequence, entityId, entityGeneration, kind,
      observedAt: now.toISOString(), observedMonotonicMs, lastVerifiedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(), freshness, properties,
    };
  }

  unknown(entityId: string, entityGeneration: string, reason: string): LiveObservation {
    return this.observation(entityId, entityGeneration, 'STATE_UNKNOWN', { reason }, 'unknown');
  }
}

export class LiveWorkspaceState {
  private observations = new Map<string, LiveObservation>();
  private latestSequence = new Map<string, number>();
  private generation = 0;
  private monotonicNowMs: () => number;
  constructor(monotonicNowMs: () => number = () => performance.now()) { this.monotonicNowMs = monotonicNowMs; }

  apply(observation: LiveObservation): boolean {
    const sequenceKey = `${observation.source}:${observation.sourceEpoch}`;
    const latest = this.latestSequence.get(sequenceKey) ?? 0;
    if (observation.sourceSequence <= latest) return false;
    this.latestSequence.set(sequenceKey, observation.sourceSequence);
    if(observation.freshness==='unknown')this.markSourceUnknown(observation.source,String(observation.properties.reason||'source_unknown'));
    if(this.observations.size>=2000&&!this.observations.has(`${observation.source}:${observation.entityId}`))this.observations.delete(this.observations.keys().next().value!);
    if(this.latestSequence.size>2048)this.latestSequence.delete(this.latestSequence.keys().next().value!);
    this.observations.set(`${observation.source}:${observation.entityId}`, structuredClone(observation));
    this.generation++;
    return true;
  }

  markSourceUnknown(source: LiveObservation['source'], reason: string): number {
    for (const [key, observation] of this.observations) if (observation.source === source) {
      this.observations.set(key, { ...observation, freshness: 'unknown', properties: { reason }, expiresAt: new Date().toISOString() });
      this.generation++;
    }
    return this.generation;
  }

  snapshot(): { generation: number; observations: LiveObservation[] } {
    const now = this.monotonicNowMs();
    const observations = [...this.observations.values()].map(observation => {
      const expiresIn = Date.parse(observation.expiresAt) - Date.parse(observation.observedAt);
      const elapsed = now - observation.observedMonotonicMs;
      return elapsed > expiresIn && observation.freshness === 'fresh' ? { ...observation, freshness: 'stale' as const } : structuredClone(observation);
    });
    return { generation: this.generation, observations };
  }
}
