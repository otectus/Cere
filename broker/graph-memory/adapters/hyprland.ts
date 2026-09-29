import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JsonValue, LiveCollector, LiveObservation } from './contracts.ts';
import { LiveObservationFactory } from './live.ts';

const execFileAsync = promisify(execFile);

export type HyprlandEvent =
  | { type: 'focus'; address: string | null }
  | { type: 'open'; address: string; workspace: string; appClass: string; title: string }
  | { type: 'close'; address: string }
  | { type: 'title'; address: string; title: string }
  | { type: 'workspace'; id: string; name: string }
  | { type: 'unknown'; name: string };

function fields(payload: string, leading: number): string[] {
  const result: string[] = [];
  let rest = payload;
  for (let index = 0; index < leading; index++) {
    const separator = rest.indexOf(',');
    if (separator < 0) return [];
    result.push(rest.slice(0, separator)); rest = rest.slice(separator + 1);
  }
  result.push(rest);
  return result;
}

export function parseHyprlandEvent(line: string): HyprlandEvent {
  const separator = line.indexOf('>>');
  if (separator < 1) return { type: 'unknown', name: '' };
  const name = line.slice(0, separator), payload = line.slice(separator + 2).replace(/\r$/u, '');
  if (name === 'activewindowv2') return { type: 'focus', address: payload ? payload.replace(/^0x/u, '') : null };
  if (name === 'openwindow') {
    const values = fields(payload, 3);
    if (values.length !== 4 || !values[0]) return { type: 'unknown', name };
    return { type: 'open', address: values[0].replace(/^0x/u, ''), workspace: values[1], appClass: values[2], title: values[3] };
  }
  if (name === 'closewindow') return payload ? { type: 'close', address: payload.replace(/^0x/u, '') } : { type: 'unknown', name };
  if (name === 'windowtitlev2') {
    const values = fields(payload, 1);
    return values.length === 2 && values[0] ? { type: 'title', address: values[0].replace(/^0x/u, ''), title: values[1] } : { type: 'unknown', name };
  }
  if (name === 'workspacev2') {
    const values = fields(payload, 1);
    return values.length === 2 ? { type: 'workspace', id: values[0], name: values[1] } : { type: 'unknown', name };
  }
  return { type: 'unknown', name };
}

export interface HyprlandCollectorConfig {
  runtimeDirectory?: string;
  instanceSignature?: string;
  hyprctl?: string;
  ttlMs?: number;
  captureTitles?: boolean;
  titleApplicationAllowlist?: string[];
  reconcileIntervalMs?: number;
}

export class HyprlandCollector implements LiveCollector {
  readonly config: HyprlandCollectorConfig;
  private socket?: Socket;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private titleTimers = new Map<string, NodeJS.Timeout>();
  private stopped = true;
  private emit?: (observation: LiveObservation) => void;
  private buffer = '';
  private windows = new Map<string, { generation: string; appClass: string; workspace: string }>();
  private factory: LiveObservationFactory;
  private sessionId: string;
  constructor(config: HyprlandCollectorConfig = {}) {
    this.config = config;
    this.factory = new LiveObservationFactory('hyprland', config.ttlMs ?? 10_000);
    this.sessionId = `${config.instanceSignature ?? process.env.HYPRLAND_INSTANCE_SIGNATURE ?? 'unknown'}:${this.factory.sourceEpoch}`;
  }

  private socketPath(): string {
    const signature = this.config.instanceSignature ?? process.env.HYPRLAND_INSTANCE_SIGNATURE;
    const runtime = this.config.runtimeDirectory ?? process.env.XDG_RUNTIME_DIR;
    if (!signature || !runtime || /[\0/]/u.test(signature)) throw new Error('Hyprland instance signature and XDG runtime directory are required');
    return join(runtime, 'hypr', signature, '.socket2.sock');
  }

  async start(emit: (observation: LiveObservation) => void): Promise<void> {
    this.emit = emit; this.stopped = false;
    await this.reconcile().catch(() => this.unknown('initial_reconcile_failed'));
    this.connect();
    this.timer = setInterval(() => this.scheduleReconcile(), this.config.reconcileIntervalMs ?? 5_000);
    this.timer.unref();
  }

  private connect() {
    if (this.stopped) return;
    this.socket = createConnection(this.socketPath());
    this.socket.setEncoding('utf8');
    this.socket.on('data', chunk => this.consume(String(chunk)));
    this.socket.on('error', () => this.unknown('socket_error'));
    this.socket.on('close', () => {
      this.unknown('socket_closed');
      if (!this.stopped && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.reconcile().catch(() => this.unknown('reconcile_failed')).finally(() => this.connect());
        }, 1_000);
        this.reconnectTimer.unref();
      }
    });
  }

  private scheduleReconcile() {
    if (this.reconcileTimer || this.stopped) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.reconcile().catch(() => this.unknown('reconcile_failed'));
    }, 250);
    this.reconcileTimer.unref();
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const end = this.buffer.indexOf('\n'), line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      this.handle(parseHyprlandEvent(line));
    }
    if (this.buffer.length > 64 * 1024) { this.buffer = ''; this.scheduleReconcile(); }
  }

  private titleAllowed(appClass: string): boolean { return Boolean(this.config.captureTitles && this.config.titleApplicationAllowlist?.includes(appClass)); }
  private handle(event: HyprlandEvent) {
    if (!this.emit) return;
    if (event.type === 'unknown') { this.scheduleReconcile(); return; }
    if (event.type === 'open') {
      const generation = randomUUID(); this.windows.set(event.address, { generation, appClass: event.appClass, workspace: event.workspace });
      this.emit(this.factory.observation(`window:${this.sessionId}:${event.address}`, generation, 'WINDOW_OPENED', {
        address: event.address, workspace: event.workspace, appClass: event.appClass, ...(this.titleAllowed(event.appClass) ? { title: event.title } : {}),
      }));
    } else if (event.type === 'close') {
      const window = this.windows.get(event.address); this.windows.delete(event.address);
      this.emit(this.factory.observation(`window:${this.sessionId}:${event.address}`, window?.generation ?? randomUUID(), 'WINDOW_CLOSED', { address: event.address }));
    } else if (event.type === 'focus') {
      this.emit(this.factory.observation(`desktop:${this.sessionId}`, this.factory.sourceEpoch, 'WINDOW_FOCUS', { address: event.address }));
    } else if (event.type === 'title') {
      const window = this.windows.get(event.address);
      if (window && this.titleAllowed(window.appClass)) {
        const pending = this.titleTimers.get(event.address); if (pending) clearTimeout(pending);
        const timer = setTimeout(() => {
          this.titleTimers.delete(event.address);
          if (this.windows.get(event.address)?.generation === window.generation) this.emit?.(this.factory.observation(`window:${this.sessionId}:${event.address}`, window.generation, 'WINDOW_TITLE', { address: event.address, title: event.title }));
        }, 250);
        timer.unref(); this.titleTimers.set(event.address, timer);
      }
    } else this.emit(this.factory.observation(`workspace:${this.sessionId}:${event.id}`, this.factory.sourceEpoch, 'WORKSPACE_ACTIVE', { workspaceId: event.id, name: event.name }));
  }

  async reconcile(): Promise<void> {
    if (!this.emit) return;
    const executable = this.config.hyprctl ?? 'hyprctl';
    const [clientsResult, activeResult] = await Promise.all([
      execFileAsync(executable, ['-j', 'clients'], { timeout: 2_000, maxBuffer: 2 * 1024 * 1024 }),
      execFileAsync(executable, ['-j', 'activewindow'], { timeout: 2_000, maxBuffer: 256 * 1024 }),
    ]);
    const clients = JSON.parse(clientsResult.stdout) as any[], active = JSON.parse(activeResult.stdout) as any;
    if (!Array.isArray(clients) || !active || typeof active !== 'object') throw new Error('hyprctl returned an invalid structured snapshot');
    const seen = new Set<string>();
    for (const client of clients) {
      const address = String(client.address ?? '').replace(/^0x/u, ''); if (!address) continue; seen.add(address);
      let window = this.windows.get(address);
      if (!window) { window = { generation: randomUUID(), appClass: String(client.class ?? ''), workspace: String(client.workspace?.id ?? '') }; this.windows.set(address, window); }
      const properties: Record<string, JsonValue> = { address, workspace: window.workspace, appClass: window.appClass, focused: address === String(active.address ?? '').replace(/^0x/u, '') };
      if (this.titleAllowed(window.appClass)) properties.title = String(client.title ?? '');
      this.emit(this.factory.observation(`window:${this.sessionId}:${address}`, window.generation, 'WINDOW_SNAPSHOT', properties));
    }
    for (const [address, window] of this.windows) if (!seen.has(address)) {
      this.emit(this.factory.observation(`window:${this.sessionId}:${address}`, window.generation, 'WINDOW_CLOSED', { address })); this.windows.delete(address);
    }
    this.emit(this.factory.observation(`desktop:${this.sessionId}`, this.factory.sourceEpoch, 'WINDOW_FOCUS', { address: active.address ? String(active.address).replace(/^0x/u, '') : null }));
  }

  private unknown(reason: string) { this.emit?.(this.factory.unknown(`desktop:${this.sessionId}`, this.factory.sourceEpoch, reason)); }
  markUnavailable(reason: 'locked' | 'suspended' | 'disconnected') { this.unknown(reason); }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    for (const timer of this.titleTimers.values()) clearTimeout(timer);
    this.titleTimers.clear(); this.socket?.destroy(); this.unknown('collector_stopped');
  }
}
