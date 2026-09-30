import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { LiveCollector, LiveObservation } from './contracts.ts';
import { LiveObservationFactory } from './live.ts';

const execFileAsync = promisify(execFile);

export interface KittyPaneSnapshot {
  osWindowId: string;
  tabId: string;
  paneId: string;
  osWindowFocused: boolean;
  tabActive: boolean;
  paneFocused: boolean;
  cwd?: string;
}

export function parseKittySnapshot(value: unknown, includeCwd = true): KittyPaneSnapshot[] {
  if (!Array.isArray(value)) throw new TypeError('Kitty snapshot must be an array');
  const panes: KittyPaneSnapshot[] = [];
  for (const osWindow of value) {
    if (!osWindow || typeof osWindow !== 'object' || !Array.isArray((osWindow as any).tabs)) continue;
    for (const tab of (osWindow as any).tabs) {
      if (!tab || typeof tab !== 'object' || !Array.isArray(tab.windows)) continue;
      for (const pane of tab.windows) {
        if (!pane || typeof pane !== 'object' || pane.id === undefined) continue;
        panes.push({
          osWindowId: String((osWindow as any).id), tabId: String(tab.id), paneId: String(pane.id),
          osWindowFocused: Boolean((osWindow as any).is_focused), tabActive: Boolean(tab.is_active), paneFocused: Boolean(pane.is_focused),
          ...(includeCwd && typeof pane.cwd === 'string' ? { cwd: pane.cwd } : {}),
        });
      }
    }
  }
  return panes;
}

function validEndpoint(value: string): string {
  if (!value.startsWith('unix:') || /[\0\r\n]/u.test(value)) throw new TypeError('Kitty inspection endpoint must be a Unix socket');
  return value;
}

export interface KittyCollectorConfig {
  endpoint: string;
  instanceId: string;
  executable?: string;
  ttlMs?: number;
  reconcileIntervalMs?: number;
  approvedCwdRoots?: string[];
}

export class KittyCollector implements LiveCollector {
  readonly config: KittyCollectorConfig;
  private factory: LiveObservationFactory;
  private emit?: (observation: LiveObservation) => void;
  private timer?: NodeJS.Timeout;
  private generations = new Map<string, string>();
  private endpoint: string;
  private roots: string[] = [];
  private stopped = false;
  constructor(config: KittyCollectorConfig) {
    this.config = config;
    this.endpoint = validEndpoint(config.endpoint);
    if (!config.instanceId) throw new TypeError('Kitty instance identity is required');
    this.factory = new LiveObservationFactory('kitty', config.ttlMs ?? 10_000);
  }

  async start(emit: (observation: LiveObservation) => void): Promise<void> {
    this.emit = emit;
    this.roots = await Promise.all((this.config.approvedCwdRoots ?? []).map(root => realpath(root)));
    await this.reconcile().catch(() => this.unknown('initial_reconcile_failed'));
    this.timer = setInterval(() => { void this.reconcile().catch(() => this.unknown('reconcile_failed')); }, this.config.reconcileIntervalMs ?? 5_000);
    this.timer.unref();
  }

  private async allowedCwd(cwd: string | undefined): Promise<string | undefined> {
    if (!cwd || !isAbsolute(cwd) || !this.roots.length) return undefined;
    try {
      const canonical = await realpath(resolve(cwd));
      return this.roots.some(root => { const child = relative(root, canonical); return child === '' || (!child.startsWith('..') && !isAbsolute(child)); }) ? canonical : undefined;
    } catch { return undefined; }
  }

  async reconcile(): Promise<void> {
    if (!this.emit) return;
    // Only the read-only `ls` action is ever sent. No Kitty titles, command lines, process environment, or terminal text survive parsing.
    const result = await execFileAsync(this.config.executable ?? 'kitten', ['@', '--to', this.endpoint, 'ls'], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 });
    const panes = parseKittySnapshot(JSON.parse(result.stdout), true), seen = new Set<string>();
    for (const pane of panes) {
      seen.add(pane.paneId);
      const generation = this.generations.get(pane.paneId) ?? randomUUID(); this.generations.set(pane.paneId, generation);
      const cwd = await this.allowedCwd(pane.cwd);
      // Reconciliation finishing after stop() must not reinsert revoked state.
      if (this.stopped || !this.emit) return;
      this.emit(this.factory.observation(`kitty:${this.config.instanceId}:pane:${pane.paneId}`, generation, 'TERMINAL_PANE', {
        instanceId: this.config.instanceId, osWindowId: pane.osWindowId, tabId: pane.tabId, paneId: pane.paneId,
        osWindowFocused: pane.osWindowFocused, tabActive: pane.tabActive, paneFocused: pane.paneFocused, ...(cwd ? { cwd } : {}),
      }));
    }
    if (this.stopped || !this.emit) return;
    for (const [paneId, generation] of this.generations) if (!seen.has(paneId)) {
      this.emit(this.factory.observation(`kitty:${this.config.instanceId}:pane:${paneId}`, generation, 'TERMINAL_PANE_CLOSED', { instanceId: this.config.instanceId, paneId }));
      this.generations.delete(paneId);
    }
  }

  private unknown(reason: string) { this.emit?.(this.factory.unknown(`kitty:${this.config.instanceId}`, this.factory.sourceEpoch, reason)); }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.unknown('collector_stopped'); this.emit = undefined; }
}
