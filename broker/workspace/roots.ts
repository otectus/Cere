/**
 * Workspace roots: the folders a conversation may work in. A root is a folder the user chose, or a
 * private Cere-owned conversation workspace. Each has a stable ID independent of its name, the canonical
 * location and device/inode identity recorded when it was chosen, and a revisioned policy: which
 * operations it permits and where its contents may be processed. Only the user adds, changes or removes
 * roots; a model names a root by ID and a relative path and can never add one.
 *
 * Changing or removing a root bumps its revision. Proposals, approvals and cached authorization made
 * under an older revision are retired, never silently retargeted.
 */
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { privateDir } from '../paths.ts';
import type { Store } from '../store.ts';
import { localOnly, workspaceLimits, type DestinationPolicy } from '../tools/contracts.ts';
import { run, WorkspaceError, type RootHandle } from './fsclient.ts';
import { forbiddenRoot } from './policy.ts';

export type RootPolicy = {
  /** Create and edit text files, always through a reviewed change set or a bounded edit grant. */
  write: boolean;
  /** Make folders, copy, move and trash, each through a reviewed change set. */
  organize: boolean;
  /** Include hidden files in listings and search (credential files and Cere's state stay excluded). */
  hidden: boolean;
  /** Run approved commands with this folder as the working directory (Analysis). */
  execute: boolean;
  /** Where this folder's contents may be processed by a model or helper. Local is always allowed. */
  destinations: DestinationPolicy;
};
export type WorkspaceRoot = {
  id: string; sessionId: string; kind: 'folder' | 'conversation'; path: string; dev: string; ino: string; name: string;
  primary: boolean; created: number; updated: number; revision: number; policy: RootPolicy; removed?: number;
};
export const defaultRootPolicy: RootPolicy = { write: false, organize: false, hidden: false, execute: false, destinations: { ...localOnly } };

export function validPolicy(value: unknown, base: RootPolicy = defaultRootPolicy): RootPolicy {
  if (value === undefined) return structuredClone(base);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid folder permissions');
  const v = value as Record<string, unknown>, next = structuredClone(base);
  for (const key of Object.keys(v)) if (!['write', 'organize', 'hidden', 'execute', 'destinations'].includes(key)) throw new Error('Unknown folder permission: ' + key);
  for (const key of ['write', 'organize', 'hidden', 'execute'] as const) if (key in v) { if (typeof v[key] !== 'boolean') throw new Error('Invalid folder permission: ' + key); next[key] = v[key] as boolean; }
  if ('destinations' in v) {
    const d = v.destinations as Record<string, unknown>;
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(key => !['remote', 'cloud'].includes(key)) || Object.values(d).some(flag => typeof flag !== 'boolean')) throw new Error('Invalid processing destinations');
    next.destinations = { remote: d.remote === true || (d.remote === undefined && base.destinations.remote), cloud: d.cloud === true || (d.cloud === undefined && base.destinations.cloud) };
  }
  return next;
}

export class WorkspaceRoots {
  store: Store; changed: (root: WorkspaceRoot, reason: string) => void;
  constructor(store: Store, changed: (root: WorkspaceRoot, reason: string) => void) { this.store = store; this.changed = changed; }
  private save(root: WorkspaceRoot) { this.store.db.prepare('INSERT INTO workspace_roots VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(root.id, root.sessionId, JSON.stringify(root)); }
  private recordPolicy(root: WorkspaceRoot) { this.store.db.prepare('INSERT OR REPLACE INTO workspace_policies VALUES (?,?,?,?)').run(root.id, root.revision, Date.now(), JSON.stringify({ policy: root.policy, removed: !!root.removed })); }
  /** Active roots of a conversation, primary first. */
  list(sessionId: string): WorkspaceRoot[] {
    return this.store.db.prepare('SELECT data FROM workspace_roots WHERE session_id=?').all(sessionId).map(row => JSON.parse(String(row.data)) as WorkspaceRoot)
      .filter(root => !root.removed).sort((a, b) => Number(b.primary) - Number(a.primary) || a.created - b.created);
  }
  /** A conversation's root by ID; a removed or foreign root is refused. */
  get(sessionId: string, rootId: unknown): WorkspaceRoot {
    if (typeof rootId !== 'string' || !/^[0-9a-f-]{36}$/.test(rootId)) throw new WorkspaceError('unknown-root', 'Name a workspace folder by its ID from files_roots');
    const row = this.store.db.prepare('SELECT data FROM workspace_roots WHERE id=? AND session_id=?').get(rootId, sessionId);
    const root = row ? JSON.parse(String(row.data)) as WorkspaceRoot : undefined;
    if (!root || root.removed) throw new WorkspaceError('unknown-root', 'That workspace folder is not available to this conversation');
    return root;
  }
  primary(sessionId: string) { return this.list(sessionId)[0]; }
  handle(root: WorkspaceRoot): RootHandle { return { path: root.path, dev: root.dev, ino: root.ino }; }
  /** Whether the root is still the same folder, without revealing anything about a missing one. */
  async status(root: WorkspaceRoot): Promise<'available' | 'missing' | 'replaced'> {
    try { const identity = await run(['identity', root.path], { timeoutMs: 5000 }); return identity.dev === root.dev && identity.ino === root.ino ? 'available' : 'replaced'; }
    catch (error: any) { return error?.code === 'missing' || error?.code === 'root-missing' ? 'missing' : error?.code === 'unavailable' ? 'available' : 'missing'; }
  }
  /** Adds a folder the user chose. Only the interface calls this; a model cannot add a root. */
  async add(sessionId: string, path: unknown, policy?: unknown, primary?: unknown): Promise<WorkspaceRoot> {
    const session = this.store.session(sessionId);
    if (session.temporary) throw new Error('Temporary conversations stay text-only; save the conversation to use workspace folders');
    if (session.remote) throw new Error('Workspace folders are chosen on the desktop');
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > workspaceLimits.pathChars) throw new Error('Choose a folder');
    const canonical = await realpath(path).catch(() => { throw new Error('That folder does not exist'); });
    if (!(await stat(canonical)).isDirectory()) throw new Error('Choose a folder, not a file');
    const forbidden = forbiddenRoot(canonical); if (forbidden) throw new Error(forbidden);
    return this.insert(sessionId, 'folder', canonical, basename(canonical) || canonical, validPolicy(policy), primary === true);
  }
  /** A private working folder owned by Cere for this conversation; outputs can be exported later. */
  async conversationRoot(sessionId: string, policy?: unknown): Promise<WorkspaceRoot> {
    const session = this.store.session(sessionId);
    if (session.temporary) throw new Error('Temporary conversations stay text-only; save the conversation to use a workspace');
    const existing = this.list(sessionId).find(root => root.kind === 'conversation');
    if (existing) return existing;
    const directory = privateDir(join(this.store.directory, 'workspaces', sessionId));
    return this.insert(sessionId, 'conversation', directory, 'Conversation workspace', validPolicy(policy, { ...defaultRootPolicy, write: true, organize: true }), !this.list(sessionId).length);
  }
  private async insert(sessionId: string, kind: WorkspaceRoot['kind'], path: string, name: string, policy: RootPolicy, primary: boolean) {
    const roots = this.list(sessionId);
    if (roots.some(root => root.path === path)) throw new Error('That folder is already in this conversation’s workspace');
    if (roots.length >= workspaceLimits.rootsPerSession) throw new Error(`A conversation can use up to ${workspaceLimits.rootsPerSession} workspace folders`);
    const identity = await run(['identity', path], { timeoutMs: 5000 });
    if (identity.type !== 'directory') throw new Error('Choose a folder');
    const time = Date.now();
    const root: WorkspaceRoot = { id: randomUUID(), sessionId, kind, path, dev: String(identity.dev), ino: String(identity.ino), name: name.slice(0, 120), primary: primary || !roots.length, created: time, updated: time, revision: 1, policy };
    this.store.transaction(() => {
      if (root.primary) for (const other of roots.filter(item => item.primary)) { other.primary = false; other.updated = time; this.save(other); }
      this.save(root); this.recordPolicy(root);
    });
    this.changed(root, 'added');
    return root;
  }
  /** Replaces a root's policy; an older revision in the request is refused. */
  update(sessionId: string, rootId: unknown, policy: unknown, expectedRevision?: unknown, primary?: unknown): WorkspaceRoot {
    const root = this.get(sessionId, rootId);
    if (expectedRevision !== undefined && expectedRevision !== root.revision) throw Object.assign(new Error('These folder permissions changed. Review them again.'), { code: 'REVISION_CONFLICT' });
    const next: WorkspaceRoot = { ...root, policy: validPolicy(policy, root.policy), updated: Date.now(), revision: root.revision + 1 };
    if (primary === true) next.primary = true;
    this.store.transaction(() => {
      if (next.primary && !root.primary) for (const other of this.list(sessionId).filter(item => item.primary && item.id !== root.id)) { other.primary = false; this.save(other); }
      this.save(next); this.recordPolicy(next);
    });
    this.changed(next, 'policy');
    return next;
  }
  remove(sessionId: string, rootId: unknown) {
    const root = this.get(sessionId, rootId), time = Date.now();
    const removed: WorkspaceRoot = { ...root, removed: time, primary: false, updated: time, revision: root.revision + 1 };
    this.store.transaction(() => {
      this.save(removed); this.recordPolicy(removed);
      const next = this.list(sessionId)[0];
      if (root.primary && next) { next.primary = true; this.save(next); }
    });
    this.changed(removed, 'removed');
    return true;
  }
  /** Forgets every root of a deleted conversation (the folders themselves are untouched, except Cere's own workspace). */
  removeSession(sessionId: string) {
    const conversation = this.store.db.prepare('SELECT data FROM workspace_roots WHERE session_id=?').all(sessionId).map(row => JSON.parse(String(row.data)) as WorkspaceRoot).filter(root => root.kind === 'conversation');
    this.store.db.prepare('DELETE FROM workspace_policies WHERE root_id IN (SELECT id FROM workspace_roots WHERE session_id=?)').run(sessionId);
    this.store.db.prepare('DELETE FROM workspace_roots WHERE session_id=?').run(sessionId);
    return conversation.map(root => root.path);
  }
}
