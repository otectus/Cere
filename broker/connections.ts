/**
 * Named chat connections (11.1): an Ollama host or an OpenAI-compatible endpoint the user keeps under a
 * name, so a local server, another machine and a gateway can coexist without rewriting Settings. A
 * conversation binds to a connection when it is created; changing which connection is the default affects
 * new conversations only. Keys stay in the credentials store, bound to each endpoint's origin; SQLite
 * holds names, addresses and declarations. Each edit bumps a revision that invalidates stale authority.
 *
 * The first load copies today's Ollama host and compatible endpoint into connections without changing
 * their destinations or copying any key.
 */
import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import type { CompatibleEndpoint, Session } from './types.ts';
import { endpointOrigin, validEndpoint } from './compatible-endpoint.ts';
import { ollamaHost } from './ollama.ts';

export type ChatConnection = {
  id: string; kind: 'ollama' | 'compatible'; name: string; revision: number; created: number; updated: number;
  ollama?: { host: string }; compatible?: CompatibleEndpoint; migrated?: boolean;
};
export const connectionLimits = { connections: 24, name: 60 };
const blankEndpoint: CompatibleEndpoint = { baseUrl: '', label: '', requiresKey: false, tools: false, images: false, streaming: true, usage: false, contextLength: 0, maxOutputTokens: 0 };

export class ChatConnections {
  core: Core;
  constructor(core: Core) { this.core = core; this.migrate(); }
  private rows(): ChatConnection[] { return this.core.store.db.prepare('SELECT data FROM provider_connections ORDER BY rowid').all().map(row => JSON.parse(String(row.data))); }
  list() { return this.rows(); }
  get(id: unknown, kind?: ChatConnection['kind']): ChatConnection {
    const found = this.rows().find(row => row.id === id);
    if (!found) throw new Error('That connection no longer exists. Choose another in Settings › Connections.');
    if (kind && found.kind !== kind) throw new Error(`That connection is ${found.kind === 'ollama' ? 'an Ollama host' : 'a compatible endpoint'}, not for this provider`);
    return found;
  }
  private write(connection: ChatConnection) {
    this.core.store.db.prepare('INSERT INTO provider_connections (id, kind, revision, data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, data=excluded.data')
      .run(connection.id, connection.kind, connection.revision, JSON.stringify(connection));
  }
  /** Copies the configured Ollama host and compatible endpoint once; destinations and keys are unchanged. */
  private migrate() {
    if (this.core.store.get('chatConnectionsMigrated', false)) return;
    const now = Date.now(), settings = this.core.settings;
    this.core.store.transaction(() => {
      if (settings.ollama?.host) this.write({ id: randomUUID(), kind: 'ollama', name: settings.ollama.host.includes('127.0.0.1') || settings.ollama.host.includes('localhost') ? 'Ollama on this computer' : `Ollama at ${new URL(settings.ollama.host).host}`, revision: 1, created: now, updated: now, ollama: { host: ollamaHost(settings.ollama.host) }, migrated: true });
      if (settings.compatible?.baseUrl) this.write({ id: randomUUID(), kind: 'compatible', name: settings.compatible.label || new URL(settings.compatible.baseUrl).host, revision: 1, created: now, updated: now, compatible: { ...settings.compatible }, migrated: true });
      this.core.store.set('chatConnectionsMigrated', true);
    });
  }
  /** Keeps the default connections (the Settings host and endpoint) in step with Settings. */
  syncDefault(kind: ChatConnection['kind'], settings: import('./types.ts').Settings) {
    const current = this.rows().find(row => row.kind === kind && row.migrated), now = Date.now();
    if (kind === 'ollama' && !settings.ollama?.host || kind === 'compatible' && !settings.compatible?.baseUrl) return;
    const value = kind === 'ollama' ? { ollama: { host: ollamaHost(settings.ollama.host) } } : { compatible: { ...settings.compatible } };
    this.write({ id: current?.id || randomUUID(), kind, name: current?.name || (kind === 'ollama' ? 'Ollama (Settings default)' : settings.compatible.label || new URL(settings.compatible.baseUrl).host), revision: (current?.revision || 0) + 1, created: current?.created || now, updated: now, ...value, migrated: true });
  }
  /** Adds or edits one connection; an edit needs the revision the person saw. */
  save(p: any): ChatConnection {
    if (!p || typeof p !== 'object') throw new Error('Invalid connection');
    const existing = p.id !== undefined ? this.get(p.id) : undefined;
    if (existing && p.expectedRevision !== existing.revision) throw new Error('This connection changed elsewhere. Review it again.');
    const kind = existing?.kind || p.kind;
    if (kind !== 'ollama' && kind !== 'compatible') throw new Error('A connection is an Ollama host or an OpenAI-compatible endpoint');
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > connectionLimits.name || /[\x00-\x1f\x7f]/.test(p.name)) throw new Error('Name the connection with 1–60 printable characters');
    if (!existing && this.rows().length >= connectionLimits.connections) throw new Error(`Keep at most ${connectionLimits.connections} connections`);
    const now = Date.now();
    const next: ChatConnection = { id: existing?.id || randomUUID(), kind, name: p.name.trim(), revision: (existing?.revision || 0) + 1, created: existing?.created || now, updated: now,
      ...(kind === 'ollama' ? { ollama: { host: ollamaHost(p.host ?? existing?.ollama?.host) } } : { compatible: validEndpoint({ ...(p.endpoint || {}), label: p.name.trim() }, existing?.compatible || blankEndpoint) }) };
    if (kind === 'compatible' && !next.compatible!.baseUrl) throw new Error('Enter the endpoint’s base URL');
    this.write(next);
    this.core.changed();
    return next;
  }
  /** A connection in use stays until its conversations move or are deleted. */
  remove(id: unknown) {
    const connection = this.get(id), bound = this.core.store.sessions().filter(session => session.connectionId === connection.id);
    if (bound.length) throw new Error(`${bound.length} conversation${bound.length === 1 ? ' uses' : 's use'} this connection. Move or delete ${bound.length === 1 ? 'it' : 'them'} first.`);
    this.core.store.db.prepare('DELETE FROM provider_connections WHERE id=?').run(connection.id);
    this.core.changed();
    return true;
  }
  /** The compatible endpoint a conversation uses: its connection's, or the one in Settings for older ones. */
  endpoint(session?: Session): CompatibleEndpoint {
    if (session?.connectionId && session.provider === 'compatible') {
      // A conversation never falls back to another destination when its own connection is gone.
      const connection = this.rows().find(row => row.id === session.connectionId && row.kind === 'compatible');
      if (!connection?.compatible) throw new Error('This conversation’s connection no longer exists. Move it to another connection in its model settings.');
      return connection.compatible;
    }
    return this.core.settings.compatible;
  }
  /** For the interface: no keys, only whether the endpoint's origin has one. */
  snapshot() {
    return this.rows().map(connection => ({ id: connection.id, kind: connection.kind, name: connection.name, revision: connection.revision, migrated: !!connection.migrated,
      ...(connection.ollama ? { host: connection.ollama.host } : {}),
      ...(connection.compatible ? { endpoint: { ...connection.compatible }, keySet: !!this.core.credentials.key('compatible', endpointOrigin(connection.compatible.baseUrl)) } : {}),
      conversations: this.core.store.sessions().filter(session => session.connectionId === connection.id).length }));
  }
}
