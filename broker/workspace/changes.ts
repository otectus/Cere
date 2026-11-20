/**
 * Change sets: reviewed, exact file changes in workspace roots.
 *
 * A change set records the roots and their policy revisions, the ordered operations with normalized
 * paths, every precondition (source content hashes, destinations that must be absent), the staged new
 * bytes, a digest over all of it, and its expiry. It is immutable once created: editing it means a new
 * change set and a new review. Applying follows a fixed order: validate, take ordered locks, re-read and
 * compare every precondition, back up what will be replaced, re-check authorization, commit each
 * operation through cere-workspacefs (exclusive create, no-clobber rename, hash-checked replacement) and
 * record its observed outcome before the next one starts.
 *
 * What is not promised: atomicity across several files, or protection from an editor outside Cere
 * writing between the final check and the commit. A multi-file change is a journaled sequence; a
 * failure stops it, and the exact per-operation outcomes are what the user and the model are told.
 * Nothing is retried or replayed after a stop or a restart.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../paths.ts';
import { lineDiff, proposalLimits } from '../file-proposals.ts';
import type { Store } from '../store.ts';
import { workspaceLimits } from '../tools/contracts.ts';
import { rootArgs, run, WorkspaceError, type RootHandle } from './fsclient.ts';
import { readable, readText, statPath } from './files.ts';
import { baseName, credentialName, normalizePath, parentPath } from './policy.ts';
import type { WorkspaceRoot, WorkspaceRoots } from './roots.ts';

export type OperationInput =
  | { kind: 'create_text'; rootId: string; path: string; content: string }
  | { kind: 'patch_text'; rootId: string; path: string; baseVersion?: string; edits?: { oldText: string; newText: string }[]; content?: string }
  | { kind: 'mkdir'; rootId: string; path: string }
  | { kind: 'copy' | 'move'; rootId: string; from: string; toRootId?: string; to: string; collision?: 'refuse' | 'unique' }
  | { kind: 'trash'; rootId: string; path: string }
  | { kind: 'export'; rootId: string; path: string; artifactId: string; versionId: string };
/** Internal kinds used only by undo: never offered to a model. */
type Kind = OperationInput['kind'] | 'remove_folder' | 'restore';
export type StagedOperation = {
  index: number; kind: Kind; label: 'added' | 'changed' | 'folder' | 'copied' | 'moved' | 'trashed' | 'removed' | 'restored';
  rootId: string; path: string; fromRootId?: string; from?: string; implied?: boolean;
  /** What must hold at commit: the source's content or inode, and the destination's absence or content. */
  source?: { type: 'file' | 'directory'; sha256?: string; ino?: string; manifest?: { files: number; folders: number; bytes: number; sample: string[]; digest: string } };
  destination: 'absent' | { sha256: string };
  staged?: { sha256: string; bytes: number };
  mode?: number;
  trashId?: string;
  /** An export's source: the artifact version whose verified bytes are written. */
  artifact?: { artifactId: string; versionId: string };
  dependsOn: number[];
  review: { diff?: string; before?: { sha256: string; bytes: number }; after?: { sha256: string; bytes: number }; notes: string[]; whitespace?: boolean };
};
export type Outcome = { state: 'pending' | 'committing' | 'committed' | 'failed' | 'skipped' | 'unknown' | 'partial'; code?: string; message?: string; sha256?: string; backup?: string; trashId?: string; at?: number };
export type ChangeStatus = 'pending' | 'applying' | 'applied' | 'partial' | 'failed' | 'declined' | 'expired' | 'revoked' | 'unknown';
export type ChangeSet = {
  id: string; sessionId: string; turnId: string; origin: 'model' | 'user' | 'undo'; reason: string; created: number; expires: number; status: ChangeStatus;
  roots: { id: string; revision: number }[]; digest: string; reviewVersion: 1; complete: boolean; incompleteReason?: string;
  totals: { operations: number; files: number; bytes: number }; undoOf?: string; decidedBy?: 'user' | 'grant'; finished?: number;
};
type Lock = { key: string; release: () => void };
const locks = new Map<string, Promise<void>>();
/** Cere's own commits are serialized per path; keys are taken in sorted order so two change sets never deadlock. */
async function acquire(keys: string[]): Promise<Lock[]> {
  const held: Lock[] = [];
  for (const key of [...new Set(keys)].sort()) {
    const previous = locks.get(key) || Promise.resolve();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => gate); locks.set(key, current);
    await previous;
    held.push({ key, release: () => { release(); if (locks.get(key) === current) locks.delete(key); } });
  }
  return held;
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fail = (code: string, message: string) => new WorkspaceError(code, message);

/** Removes a staged area or backup set without following links. */
async function remove(path: string) { await rm(path, { recursive: true, force: true }).catch(() => {}); }

export class ChangeSets {
  store: Store; roots: WorkspaceRoots; directory: string;
  /** Called after a commit with the absolute paths that changed, for results and stale-check tracking. */
  observed: (sessionId: string, set: ChangeSet, paths: string[]) => void = () => {};
  /** Resolves an artifact version the conversation may use, for exports; set by the Workbench. */
  artifactBytes: (sessionId: string, artifactId: unknown, versionId: unknown) => Promise<{ version: { name: string; mime: string; sha256: string; bytes: number; versionId: string; artifactId: string }; data: Buffer }> = () => Promise.reject(new Error('Exports are unavailable'));
  exported: (sessionId: string, artifactId: string, versionId: string, destination: string) => void = () => {};
  changed: () => void = () => {};
  constructor(store: Store, roots: WorkspaceRoots) { this.store = store; this.roots = roots; this.directory = join(store.directory, 'workspace'); }
  private area(name: string) { return privateDir(join(this.directory, name)); }
  private save(set: ChangeSet, operations?: StagedOperation[]) {
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO change_sets VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(set.id, set.sessionId, set.status, set.created, JSON.stringify(set));
      if (operations) for (const operation of operations) this.store.db.prepare('INSERT OR REPLACE INTO change_operations VALUES (?,?,?,?)').run(set.id, operation.index, JSON.stringify(operation), JSON.stringify({ state: 'pending' } satisfies Outcome));
    });
  }
  private outcome(id: string, index: number, outcome: Outcome) { this.store.db.prepare('UPDATE change_operations SET outcome=? WHERE change_set_id=? AND idx=?').run(JSON.stringify({ ...outcome, at: Date.now() }), id, index); }
  get(id: unknown): ChangeSet {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw fail('unknown-change', 'Unknown change set');
    const row = this.store.db.prepare('SELECT data FROM change_sets WHERE id=?').get(id);
    if (!row) throw fail('unknown-change', 'This change set no longer exists');
    const set = JSON.parse(String(row.data)) as ChangeSet;
    if (set.status === 'pending' && set.expires < Date.now()) { set.status = 'expired'; this.save(set); }
    return set;
  }
  operations(id: string): { operation: StagedOperation; outcome: Outcome }[] {
    return this.store.db.prepare('SELECT data,outcome FROM change_operations WHERE change_set_id=? ORDER BY idx').all(id).map(row => ({ operation: JSON.parse(String(row.data)), outcome: JSON.parse(String(row.outcome || '{"state":"pending"}')) }));
  }
  list(sessionId: string, limit = 50) {
    return this.store.db.prepare('SELECT data FROM change_sets WHERE session_id=? ORDER BY created DESC LIMIT ?').all(sessionId, limit).map(row => {
      const set = JSON.parse(String(row.data)) as ChangeSet;
      if (set.status === 'pending' && set.expires < Date.now()) { set.status = 'expired'; this.save(set); }
      return set;
    });
  }
  private digestOf(set: Pick<ChangeSet, 'sessionId' | 'roots' | 'reason' | 'origin' | 'undoOf'>, operations: StagedOperation[]) {
    return sha256(stableJson({ sessionId: set.sessionId, roots: set.roots, reason: set.reason, origin: set.origin, undoOf: set.undoOf || '', operations: operations.map(({ review: _review, ...operation }) => operation) }));
  }
  private requireRoot(sessionId: string, rootId: string, need: 'write' | 'organize') {
    const root = this.roots.get(sessionId, rootId);
    // A model that tries to rewrite a file by trashing it is pointed to the edit it is allowed to make.
    if (!root.policy[need]) throw fail('denied', `${root.name} does not allow ${need === 'write' ? 'creating or editing files' : 'organizing (folders, copy, move, trash)'}. Change it in the Workbench folder settings.${need === 'organize' && root.policy.write ? ' To change text inside an existing file, propose a patch_text operation with edits [{"oldText": exact current text, "newText": replacement}] instead.' : ''}`);
    return root;
  }
  private writablePath(root: WorkspaceRoot, value: unknown) {
    const rel = normalizePath(value, root.path);
    if (!rel) throw fail('invalid-path', 'Name a file or folder inside the workspace folder');
    readable(root, rel);
    if (credentialName(baseName(rel))) throw fail('credential', 'Cere does not create or change credential files');
    return rel;
  }

  /**
   * Validates and stages an exact change set. Nothing on disk changes here except Cere's private staging
   * area. A change set too large to review completely is kept but marked incomplete, which disables approval.
   */
  async propose(sessionId: string, inputs: unknown, p: { reason?: unknown; origin: ChangeSet['origin']; turnId?: string; undoOf?: string; internal?: StagedOperation[] }, signal?: AbortSignal): Promise<ChangeSet> {
    const session = this.store.session(sessionId);
    if (session.temporary) throw fail('temporary', 'Temporary conversations cannot change files');
    const operations: StagedOperation[] = [];
    const reason = typeof p.reason === 'string' ? p.reason.trim().slice(0, 500) : '';
    const stagedBytes: Buffer[] = [];
    let incomplete = '';
    const planned = new Map<string, 'file' | 'directory' | 'absent'>(); // root\npath -> state after earlier operations
    const key = (rootId: string, rel: string) => rootId + '\n' + rel;
    const exists = async (root: WorkspaceRoot, rel: string): Promise<'file' | 'directory' | 'absent' | 'other'> => {
      const known = planned.get(key(root.id, rel)); if (known) return known;
      try { const info = await statPath(root, rel, signal); return info.type === 'file' ? 'file' : info.type === 'directory' ? 'directory' : 'other'; }
      catch (error: any) { if (error?.code === 'missing') return 'absent'; throw error; }
    };
    const add = (operation: Omit<StagedOperation, 'index'>, bytes?: Buffer) => {
      if (operations.length >= workspaceLimits.changeOperations) throw fail('too-many', `A change set holds at most ${workspaceLimits.changeOperations} operations; split the work`);
      operations.push({ ...operation, index: operations.length } as StagedOperation);
      if (bytes) stagedBytes[operations.length - 1] = bytes;
    };
    const dependency = (rootId: string, rel: string) => operations.filter(op => op.rootId === rootId && (rel === op.path || rel.startsWith(op.path + '/')) && ['folder', 'added', 'copied', 'moved', 'restored'].includes(op.label)).map(op => op.index);
    /** Missing parent folders become explicit folder operations, shown in review. */
    const parents = async (root: WorkspaceRoot, rel: string) => {
      const parts = parentPath(rel).split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const folder = parts.slice(0, i).join('/'), state = await exists(root, folder);
        if (state === 'directory') continue;
        if (state !== 'absent') throw fail('not-directory', `${folder} exists and is not a folder`);
        add({ kind: 'mkdir', label: 'folder', rootId: root.id, path: folder, implied: true, destination: 'absent', dependsOn: dependency(root.id, parentPath(folder)), review: { notes: ['Created because a later operation needs it'] } });
        planned.set(key(root.id, folder), 'directory');
      }
    };
    const uniqueName = async (root: WorkspaceRoot, rel: string) => {
      const name = baseName(rel), dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : '';
      for (let n = 2; n < 100; n++) { const candidate = (parentPath(rel) ? parentPath(rel) + '/' : '') + `${stem} (${n})${extension}`; if (await exists(root, candidate) === 'absent') return candidate; }
      throw fail('exists', 'No free name was found for the copy');
    };
    const manifest = async (root: WorkspaceRoot, rel: string) => {
      const value = await run(['walk', ...rootArgs(this.roots.handle(root)), rel, '--hidden', '--limit', String(workspaceLimits.manifestEntries + 1), '--max-entries', String(workspaceLimits.manifestEntries + 1), '--max-depth', '32', '--deadline-ms', '10000'], { signal, timeoutMs: 15_000 });
      const entries = value.entries as any[];
      if (entries.length > workspaceLimits.manifestEntries || value.stopped) throw fail('too-many', `This folder has more than ${workspaceLimits.manifestEntries} items, more than one change set reviews. Organize a smaller folder.`);
      if (entries.some(entry => entry.invalidName)) throw fail('unsupported', 'This folder contains names Cere cannot display, so it cannot be reviewed completely');
      if (entries.some(entry => !['file', 'directory'].includes(entry.type))) throw fail('unsupported', 'This folder contains links or special files; Cere moves only ordinary files and folders');
      const files = entries.filter(entry => entry.type === 'file'), bytes = files.reduce((sum, entry) => sum + entry.size, 0);
      if (bytes > workspaceLimits.manifestBytes) throw fail('too-large', 'This folder is larger than one change set handles (100 MiB)');
      const lines = entries.map(entry => `${entry.type === 'directory' ? 'd' : 'f'} ${entry.path} ${entry.type === 'file' ? entry.size : ''}`);
      return { files: files.length, folders: entries.length - files.length, bytes, sample: entries.slice(0, 20).map(entry => entry.path), digest: sha256(lines.join('\n')) };
    };

    if (p.internal) for (const operation of p.internal) add(operation);
    else {
      if (!Array.isArray(inputs) || !inputs.length) throw fail('empty', 'Propose at least one operation');
      for (const raw of inputs as any[]) {
        signal?.throwIfAborted();
        if (!raw || typeof raw !== 'object') throw fail('invalid', 'Each operation must be an object');
        const kind = raw.kind;
        if (kind === 'create_text' || kind === 'patch_text') {
          const root = this.requireRoot(sessionId, raw.rootId, 'write'), rel = this.writablePath(root, raw.path);
          const state = await exists(root, rel);
          if (kind === 'create_text') {
            if (typeof raw.content !== 'string' || raw.content.includes('\0') || Buffer.byteLength(raw.content) > workspaceLimits.proposalBytes) throw fail('invalid-content', 'New file content must be text of up to 256 KiB');
            if (state !== 'absent') throw fail('exists', `${rel} already exists. Read it and use patch_text to change it.`);
            await parents(root, rel);
            const bytes = Buffer.from(raw.content, 'utf8');
            let diff = '', notes: string[] = [];
            try { diff = lineDiff('', raw.content, rel); } catch (error: any) { incomplete ||= error.message; notes = ['Too large to show completely']; }
            add({ kind, label: 'added', rootId: root.id, path: rel, destination: 'absent', staged: { sha256: sha256(bytes), bytes: bytes.length }, mode: 0o644, dependsOn: dependency(root.id, parentPath(rel)), review: { diff, after: { sha256: sha256(bytes), bytes: bytes.length }, notes } }, bytes);
            planned.set(key(root.id, rel), 'file');
          } else {
            if (state === 'absent') throw fail('missing', `${rel} does not exist; use create_text for a new file`);
            if (state !== 'file') throw fail('not-file', `${rel} is not a regular file`);
            if (planned.has(key(root.id, rel))) throw fail('duplicate', `${rel} is already changed earlier in this change set; combine the edits`);
            const current = await readText(root, rel, signal);
            if (current.binary) throw fail('binary', `${rel} is not UTF-8 text; Cere edits text files only`);
            if (raw.baseVersion !== undefined && raw.baseVersion !== current.version) throw fail('stale', `${rel} changed since you read it (now ${current.version}). Read it again before proposing an edit.`);
            const next = patched(current, raw);
            const bytes = Buffer.from((current.bom ? '﻿' : '') + next, 'utf8');
            if (bytes.length > workspaceLimits.proposalBytes) throw fail('too-large', 'The edited file would be larger than 256 KiB, the most Cere edits in one proposal');
            if (sha256(bytes) === current.version.slice(7)) throw fail('no-change', `The edit leaves ${rel} unchanged`);
            let diff = '', notes: string[] = [];
            try { diff = lineDiff(current.lines.join('\n'), next.replace(/\r\n/g, '\n').replace(/\n$/, ''), rel); } catch (error: any) { incomplete ||= error.message; notes = ['Too large to show completely']; }
            if (current.endsWithNewline !== /\n$/.test(next)) notes.push(current.endsWithNewline ? 'Removes the final newline' : 'Adds a final newline');
            if (current.nlink && current.nlink > 1) notes.push(`This file has ${current.nlink} hard links; Cere replaces this name only and the other links keep the old content.`);
            const whitespace = current.text.replace(/\s+/g, '') === next.replace(/\s+/g, '');
            add({ kind, label: 'changed', rootId: root.id, path: rel, source: { type: 'file', sha256: current.version.slice(7) }, destination: { sha256: current.version.slice(7) },
              staged: { sha256: sha256(bytes), bytes: bytes.length }, mode: (current.mode ?? 0o644) & 0o777, dependsOn: dependency(root.id, rel),
              review: { diff, before: { sha256: current.version.slice(7), bytes: current.size }, after: { sha256: sha256(bytes), bytes: bytes.length }, notes, ...(whitespace ? { whitespace: true } : {}) } }, bytes);
            planned.set(key(root.id, rel), 'file');
          }
        } else if (kind === 'mkdir') {
          const root = this.requireRoot(sessionId, raw.rootId, 'organize'), rel = this.writablePath(root, raw.path);
          if (await exists(root, rel) !== 'absent') throw fail('exists', `${rel} already exists`);
          await parents(root, rel);
          add({ kind, label: 'folder', rootId: root.id, path: rel, destination: 'absent', dependsOn: dependency(root.id, parentPath(rel)), review: { notes: [] } });
          planned.set(key(root.id, rel), 'directory');
        } else if (kind === 'copy' || kind === 'move') {
          const source = this.requireRoot(sessionId, raw.rootId, 'organize'), target = this.requireRoot(sessionId, raw.toRootId || raw.rootId, 'organize');
          const from = this.writablePath(source, raw.from); let to = this.writablePath(target, raw.to);
          if (source.id === target.id && (to === from || to.startsWith(from + '/'))) throw fail('invalid', 'A folder cannot be copied or moved into itself');
          const state = await exists(source, from);
          if (state === 'absent') throw fail('missing', `${from} does not exist`);
          if (state === 'other') throw fail('unsupported', `${from} is a link or special file; Cere copies and moves only ordinary files and folders`);
          if (await exists(target, to) !== 'absent') {
            if (raw.collision !== 'unique') throw fail('exists', `${to} already exists. Choose another name, or ask for a unique name with collision "unique".`);
            to = await uniqueName(target, to);
          }
          await parents(target, to);
          if (kind === 'copy' && state === 'directory') throw fail('unsupported', 'Copying whole folders is not supported yet; copy the files you need');
          let sourceInfo: NonNullable<StagedOperation['source']>;
          if (state === 'file') { const info = await run(['hash', ...rootArgs(this.roots.handle(source)), from], { signal }); sourceInfo = { type: 'file', sha256: info.sha256, ino: info.ino }; }
          else { const identity = await statPath(source, from, signal), list = await manifest(source, from); sourceInfo = { type: 'directory', ino: (identity as any).ino, manifest: list }; }
          const notes = [source.id !== target.id ? `From ${source.name} to ${target.name}` : '', sourceInfo.manifest ? `${sourceInfo.manifest.files} files and ${sourceInfo.manifest.folders} folders (${sourceInfo.manifest.bytes.toLocaleString('en-US')} bytes)` : '', to !== this.writablePath(target, raw.to) ? 'Renamed to avoid replacing an existing item' : ''].filter(Boolean);
          add({ kind, label: kind === 'copy' ? 'copied' : 'moved', rootId: target.id, path: to, fromRootId: source.id, from, source: sourceInfo, destination: 'absent', dependsOn: [...dependency(source.id, from), ...dependency(target.id, parentPath(to))], review: { notes } });
          planned.set(key(target.id, to), state);
          if (kind === 'move') planned.set(key(source.id, from), 'absent');
        } else if (kind === 'export') {
          // A file Cere keeps, written as a new file: the review shows its name, type and size; a diff means nothing here.
          const root = this.requireRoot(sessionId, raw.rootId, 'write'), rel = this.writablePath(root, raw.path);
          if (await exists(root, rel) !== 'absent') throw fail('exists', `${rel} already exists; choose another name`);
          const { version, data } = await this.artifactBytes(sessionId, raw.artifactId, raw.versionId);
          if (data.length > 50 * 1024 * 1024) throw fail('too-large', 'Exports into a workspace folder are limited to 50 MiB; use Save as for larger files');
          await parents(root, rel);
          add({ kind, label: 'added', rootId: root.id, path: rel, destination: 'absent', staged: { sha256: version.sha256, bytes: data.length }, mode: 0o644, dependsOn: dependency(root.id, parentPath(rel)),
            artifact: { artifactId: version.artifactId, versionId: version.versionId }, review: { after: { sha256: version.sha256, bytes: data.length }, notes: [`Export of ${version.name} (${version.mime}, ${data.length.toLocaleString('en-US')} bytes); the file is not kept in sync afterwards`] } }, data);
          planned.set(key(root.id, rel), 'file');
        } else if (kind === 'trash') {
          const root = this.requireRoot(sessionId, raw.rootId, 'organize'), rel = this.writablePath(root, raw.path), state = await exists(root, rel);
          if (state === 'absent') throw fail('missing', `${rel} does not exist`);
          if (state === 'other') throw fail('unsupported', `${rel} is a link or special file`);
          const sourceInfo: NonNullable<StagedOperation['source']> = state === 'file' ? await run(['hash', ...rootArgs(this.roots.handle(root)), rel], { signal }).then(info => ({ type: 'file' as const, sha256: info.sha256, ino: info.ino }))
            : { type: 'directory', ino: (await statPath(root, rel, signal) as any).ino, manifest: await manifest(root, rel) };
          add({ kind, label: 'trashed', rootId: root.id, path: rel, source: sourceInfo, destination: 'absent', trashId: randomUUID(), dependsOn: dependency(root.id, rel),
            review: { notes: ['Kept in Cere’s trash so it can be restored', ...(sourceInfo.manifest ? [`${sourceInfo.manifest.files} files and ${sourceInfo.manifest.folders} folders`] : [])] } });
          planned.set(key(root.id, rel), 'absent');
        } else throw fail('invalid-kind', 'Unknown operation kind: use create_text, patch_text, mkdir, copy, move or trash');
      }
    }
    const total = stagedBytes.reduce((sum, bytes, index) => sum + (operations[index]?.kind === 'export' ? 0 : bytes?.length || 0), 0);
    if (total > workspaceLimits.changeBytes) throw fail('too-large', 'The staged text in this change set is larger than 5 MiB; split the work');
    const rootIds = [...new Set(operations.flatMap(op => [op.rootId, op.fromRootId].filter(Boolean) as string[]))];
    const time = Date.now();
    const set: ChangeSet = { id: randomUUID(), sessionId, turnId: p.turnId || session.turnId || '', origin: p.origin, reason, created: time, expires: time + workspaceLimits.proposalLifetimeMs, status: 'pending',
      roots: rootIds.map(id => ({ id, revision: this.roots.get(sessionId, id).revision })), digest: '', reviewVersion: 1, complete: !incomplete, ...(incomplete ? { incompleteReason: incomplete } : {}),
      totals: { operations: operations.length, files: operations.filter(op => op.kind !== 'mkdir').length, bytes: total }, ...(p.undoOf ? { undoOf: p.undoOf } : {}) };
    set.digest = this.digestOf(set, operations);
    const staging = this.area(join('staged', set.id));
    for (const [index, bytes] of stagedBytes.entries()) if (bytes) await writeFile(join(staging, String(index)), bytes, { mode: 0o600, flag: 'wx' });
    this.save(set, operations);
    this.changed();
    return set;
  }

  /** The structured review: every operation, its diff or manifest, its precondition, and why approval is disabled when it is. */
  review(id: unknown) {
    const set = this.get(id), operations = this.operations(set.id);
    const rootNames = Object.fromEntries(set.roots.map(entry => { try { const root = this.roots.get(set.sessionId, entry.id); return [entry.id, { name: root.name, current: root.revision === entry.revision }]; } catch { return [entry.id, { name: 'Removed folder', current: false }]; } }));
    const revoked = Object.values(rootNames).some(root => !root.current);
    const blocked = set.status !== 'pending' ? `This change set is ${set.status}` : !set.complete ? `Preview incomplete: ${set.incompleteReason}` : revoked ? 'A folder’s permissions changed since this was proposed' : '';
    return { ...set, approvable: !blocked, ...(blocked ? { blockedBecause: blocked } : {}), roots: set.roots.map(entry => ({ ...entry, ...rootNames[entry.id] })),
      operations: operations.map(({ operation, outcome }) => ({ ...operation, outcome })) };
  }

  /** Every operation index a selected subset needs, so a move never applies without the edits it depends on. */
  closure(set: ChangeSet, selected: number[] | undefined) {
    const operations = this.operations(set.id).map(item => item.operation);
    if (!selected) return operations.map(op => op.index);
    if (!Array.isArray(selected) || !selected.length || selected.some(index => !Number.isInteger(index) || index < 0 || index >= operations.length)) throw fail('invalid-selection', 'Choose operations from this change set');
    const chosen = new Set(selected);
    for (const index of chosen) for (const dependency of operations[index].dependsOn) if (!chosen.has(dependency)) throw fail('dependency', `Operation ${index + 1} (${operations[index].path}) needs operation ${dependency + 1} (${operations[dependency].path}); select both`);
    return [...chosen].sort((a, b) => a - b);
  }

  /**
   * Applies a pending change set once, in order, stopping at the first failure. `authorize` runs before
   * anything is written and again immediately before each commit; it throws when the session, roots,
   * policy or the deciding grant changed. Returns the exact outcome of every operation.
   */
  async apply(id: unknown, p: { digest: unknown; operations?: number[]; decidedBy: 'user' | 'grant'; authorize: () => void; signal?: AbortSignal }) {
    const set = this.get(id);
    if (set.status !== 'pending') throw fail('not-pending', `This change set is ${set.status}; nothing was applied`);
    if (set.expires < Date.now()) { set.status = 'expired'; this.save(set); throw fail('expired', 'This change set expired; ask for it again'); }
    if (!set.complete) throw fail('incomplete', 'This change set could not be reviewed completely, so it cannot be applied');
    const all = this.operations(set.id);
    if (p.digest !== set.digest || this.digestOf(set, all.map(item => item.operation)) !== set.digest) throw fail('changed', 'This change set does not match the reviewed one; nothing was applied');
    for (const entry of set.roots) { const root = this.roots.get(set.sessionId, entry.id); if (root.revision !== entry.revision) { set.status = 'revoked'; this.save(set); throw fail('revoked', `${root.name}’s permissions changed since review; nothing was applied`); } }
    const selected = new Set(this.closure(set, p.operations));
    p.authorize();
    set.status = 'applying'; set.decidedBy = p.decidedBy; this.save(set);
    const staging = join(this.directory, 'staged', set.id), backups = join(this.directory, 'backups', set.id);
    const lockKeys = all.filter(item => selected.has(item.operation.index)).flatMap(({ operation }) => [operation.rootId + ':' + operation.path, ...(operation.from ? [operation.fromRootId + ':' + operation.from] : [])]);
    const held = await acquire(lockKeys);
    const results: { index: number; path: string; label: string; outcome: Outcome }[] = [];
    const changedPaths: string[] = [];
    let stopped = false;
    try {
      for (const { operation } of all) {
        if (!selected.has(operation.index)) { this.outcome(set.id, operation.index, { state: 'skipped', message: 'Not selected' }); results.push({ index: operation.index, path: operation.path, label: operation.label, outcome: { state: 'skipped', message: 'Not selected' } }); continue; }
        if (stopped || p.signal?.aborted) {
          const outcome: Outcome = { state: 'skipped', message: p.signal?.aborted && !stopped ? 'Stopped before this operation' : 'Not attempted after an earlier operation failed' };
          this.outcome(set.id, operation.index, outcome); results.push({ index: operation.index, path: operation.path, label: operation.label, outcome }); stopped = true; continue;
        }
        this.outcome(set.id, operation.index, { state: 'committing' });
        let outcome: Outcome;
        try {
          p.authorize();
          outcome = await this.commit(set, operation, staging, backups, p.authorize);
          if (outcome.state === 'committed' || outcome.state === 'partial') {
            const root = this.roots.get(set.sessionId, operation.rootId);
            changedPaths.push(join(root.path, operation.path));
            if (operation.from && operation.fromRootId) changedPaths.push(join(this.roots.get(set.sessionId, operation.fromRootId).path, operation.from));
          }
          if (outcome.state !== 'committed') stopped = true;
        } catch (error: any) {
          // A failure the helper reported is known; anything else after dispatch may have taken effect.
          outcome = error instanceof WorkspaceError && error.code !== 'timeout' && error.code !== 'helper-failed' ? { state: 'failed', code: error.code, message: error.message } : { state: 'unknown', code: error?.code || 'unknown', message: (error?.message || 'The outcome could not be confirmed') + '. Check the file before trying again.' };
          stopped = true;
        }
        this.outcome(set.id, operation.index, outcome);
        results.push({ index: operation.index, path: operation.path, label: operation.label, outcome });
      }
    } finally { for (const lock of held.reverse()) lock.release(); }
    const states = results.filter(result => selected.has(result.index)).map(result => result.outcome.state);
    set.status = states.includes('unknown') ? 'unknown' : states.every(state => state === 'committed') ? 'applied' : states.some(state => state === 'committed' || state === 'partial') ? 'partial' : 'failed';
    set.finished = Date.now(); this.save(set);
    await remove(staging);
    if (changedPaths.length) this.observed(set.sessionId, set, changedPaths);
    this.changed();
    return { changeSetId: set.id, status: set.status, results };
  }

  private async commit(set: ChangeSet, operation: StagedOperation, staging: string, backups: string, authorize: () => void): Promise<Outcome> {
    const root = this.roots.get(set.sessionId, operation.rootId), handle = this.roots.handle(root);
    if (operation.kind === 'mkdir') { authorize(); await run(['mkdir', ...rootArgs(handle), operation.path]); return { state: 'committed' }; }
    if (operation.kind === 'create_text' || operation.kind === 'patch_text' || operation.kind === 'export') {
      const bytes = await readFile(join(staging, String(operation.index)));
      if (sha256(bytes) !== operation.staged!.sha256) throw fail('staging-changed', 'Cere’s staged copy of this edit changed; nothing was written');
      let backup = '';
      if (operation.destination !== 'absent') {
        // The replaced content is kept privately first; the helper's hash check ties it to what is replaced.
        const current = await run(['read', ...rootArgs(handle), operation.path, '--max-bytes', String(workspaceLimits.readableFileBytes)]);
        if (current.sha256 !== operation.destination.sha256) return { state: 'failed', code: 'stale', message: `${operation.path} changed since review; it was not overwritten. Review a new proposal.` };
        privateDir(backups); backup = join(backups, String(operation.index));
        await writeFile(backup, Buffer.from(current.data, 'base64'), { mode: 0o600, flag: 'wx' });
      }
      authorize();
      const written = await run(['write', ...rootArgs(handle), operation.path, (operation.mode ?? 0o644).toString(8), '--expect', operation.destination === 'absent' ? 'absent' : 'sha256:' + operation.destination.sha256, '--max-bytes', String(Math.max(workspaceLimits.changeBytes, bytes.length))], { input: bytes, timeoutMs: 120_000 });
      const exported = operation.artifact;
      if (exported) this.exported(set.sessionId, exported.artifactId, exported.versionId, join(root.path, operation.path));
      return { state: 'committed', sha256: written.sha256, ...(backup ? { backup } : {}) };
    }
    if (operation.kind === 'copy') {
      const source = this.roots.get(set.sessionId, operation.fromRootId!);
      authorize();
      const copied = await run(['copy', ...rootArgs(this.roots.handle(source)), operation.from!, ...rootArgs(handle), operation.path, '--expect', 'sha256:' + operation.source!.sha256, '--max-bytes', String(workspaceLimits.manifestBytes)], { timeoutMs: 120_000 });
      return { state: 'committed', sha256: copied.sha256 };
    }
    if (operation.kind === 'move') {
      const source = this.roots.get(set.sessionId, operation.fromRootId!), sourceHandle = this.roots.handle(source);
      await this.checkManifest(source, operation);
      const expect = operation.source!.type === 'file' ? 'sha256:' + operation.source!.sha256 : 'ino:' + operation.source!.ino;
      authorize();
      try { await run(['rename', ...rootArgs(sourceHandle), operation.from!, ...rootArgs(handle), operation.path, '--expect', expect]); return { state: 'committed', ...(operation.source!.sha256 ? { sha256: operation.source!.sha256 } : {}) }; }
      catch (error: any) {
        if (error?.code !== 'cross-device' || operation.source!.type !== 'file') throw error;
        // Another filesystem: copy and verify first, then remove the original. A failure after the copy leaves both, and says so.
        const copied = await run(['copy', ...rootArgs(sourceHandle), operation.from!, ...rootArgs(handle), operation.path, '--expect', expect, '--max-bytes', String(workspaceLimits.manifestBytes)], { timeoutMs: 120_000 });
        authorize();
        try { await run(['unlink', ...rootArgs(sourceHandle), operation.from!, '--expect', expect]); }
        catch (removal: any) { return { state: 'partial', code: removal?.code || 'remove-failed', sha256: copied.sha256, message: `Copied to ${operation.path}, but the original at ${operation.from} could not be removed (${removal?.message}). Both copies exist.` }; }
        return { state: 'committed', sha256: copied.sha256, message: 'Moved between filesystems by copying, verifying and removing the original' };
      }
    }
    if (operation.kind === 'trash') {
      const trash = await this.trashRoot(), item = operation.trashId!;
      await this.checkManifest(root, operation);
      const expect = operation.source!.type === 'file' ? 'sha256:' + operation.source!.sha256 : 'ino:' + operation.source!.ino;
      privateDir(join(trash.path, item));
      const record = { id: item, sessionId: set.sessionId, changeSetId: set.id, rootId: root.id, rootPath: root.path, path: operation.path, type: operation.source!.type, sha256: operation.source!.sha256, manifest: operation.source!.manifest, at: Date.now(), state: 'trashing' };
      await writeFile(join(trash.path, item + '.json'), JSON.stringify(record), { mode: 0o600 });
      authorize();
      try { await run(['rename', ...rootArgs(handle), operation.path, ...rootArgs(trash), item + '/' + baseName(operation.path), '--expect', expect]); }
      catch (error: any) {
        if (error?.code !== 'cross-device' || operation.source!.type !== 'file') { await rm(join(trash.path, item + '.json'), { force: true }); await rm(join(trash.path, item), { recursive: true, force: true }); if (error?.code === 'cross-device') throw fail('cross-device', 'This folder is on another drive; Cere can trash its files one at a time but not the whole folder'); throw error; }
        await run(['copy', ...rootArgs(handle), operation.path, ...rootArgs(trash), item + '/' + baseName(operation.path), '--expect', expect, '--max-bytes', String(workspaceLimits.manifestBytes)], { timeoutMs: 120_000 });
        authorize();
        await run(['unlink', ...rootArgs(handle), operation.path, '--expect', expect]);
      }
      await writeFile(join(trash.path, item + '.json'), JSON.stringify({ ...record, state: 'trashed' }), { mode: 0o600 });
      return { state: 'committed', trashId: item };
    }
    if (operation.kind === 'restore') {
      const trash = await this.trashRoot(), record = JSON.parse(await readFile(join(trash.path, operation.trashId! + '.json'), 'utf8'));
      authorize();
      await run(['rename', ...rootArgs(trash), operation.trashId + '/' + baseName(record.path), ...rootArgs(handle), operation.path, '--expect', record.type === 'file' ? 'sha256:' + record.sha256 : 'any']);
      await writeFile(join(trash.path, operation.trashId + '.json'), JSON.stringify({ ...record, state: 'restored', restoredTo: operation.path, restoredAt: Date.now() }), { mode: 0o600 });
      await rm(join(trash.path, operation.trashId!), { recursive: true, force: true });
      return { state: 'committed', ...(record.sha256 ? { sha256: record.sha256 } : {}) };
    }
    if (operation.kind === 'remove_folder') { authorize(); await run(['rmdir', ...rootArgs(handle), operation.path, '--expect', 'ino:' + operation.source!.ino]); return { state: 'committed' }; }
    throw fail('invalid-kind', 'Unknown operation');
  }
  /** A folder's contents may not change materially between review and commit. */
  private async checkManifest(root: WorkspaceRoot, operation: StagedOperation) {
    if (operation.source?.type !== 'directory' || !operation.source.manifest) return;
    const value = await run(['walk', ...rootArgs(this.roots.handle(root)), operation.from || operation.path, '--hidden', '--limit', String(workspaceLimits.manifestEntries + 1), '--max-entries', String(workspaceLimits.manifestEntries + 1), '--max-depth', '32', '--deadline-ms', '10000']);
    const digest = sha256((value.entries as any[]).map(entry => `${entry.type === 'directory' ? 'd' : 'f'} ${entry.path} ${entry.type === 'file' ? entry.size : ''}`).join('\n'));
    if (digest !== operation.source.manifest.digest) throw fail('stale', `${operation.from || operation.path} changed since review (its contents are different); nothing was moved`);
  }
  private trash?: RootHandle;
  /** Cere's private trash, a root of its own so restores go through the same confined helper. */
  async trashRoot(): Promise<RootHandle> {
    const path = this.area('trash');
    if (this.trash?.path === path) return this.trash;
    const identity = await run(['identity', path]);
    return this.trash = { path, dev: String(identity.dev), ino: String(identity.ino) };
  }
  async trashItems(sessionId?: string) {
    const trash = await this.trashRoot(), items: any[] = [];
    for (const name of await readdir(trash.path).catch(() => [] as string[])) if (name.endsWith('.json')) {
      try { const record = JSON.parse(await readFile(join(trash.path, name), 'utf8')); if (!sessionId || record.sessionId === sessionId) items.push(record); } catch { /* unreadable record */ }
    }
    return items.sort((a, b) => b.at - a.at);
  }
  /** Permanently deletes one trashed item: a separate, explicit user action. */
  async purge(trashId: unknown, sessionId: string) {
    if (typeof trashId !== 'string' || !/^[0-9a-f-]{36}$/.test(trashId)) throw fail('invalid', 'Unknown trash item');
    const trash = await this.trashRoot(), record = JSON.parse(await readFile(join(trash.path, trashId + '.json'), 'utf8').catch(() => { throw fail('missing', 'That trash item no longer exists'); }));
    if (record.sessionId !== sessionId) throw fail('denied', 'That trash item belongs to another conversation');
    await rm(join(trash.path, trashId), { recursive: true, force: true }); await rm(join(trash.path, trashId + '.json'), { force: true });
    return true;
  }

  /**
   * Undo builds a new change set from the recorded inverse operations, for review like any other. An
   * inverse whose target no longer holds exactly what Cere wrote is offered as a restore-as-copy instead,
   * so a newer external edit is never overwritten.
   */
  async undo(id: unknown, signal?: AbortSignal) {
    const set = this.get(id);
    if (!['applied', 'partial'].includes(set.status)) throw fail('not-applied', 'Only applied changes can be undone');
    const inverse: StagedOperation[] = [], conflicts: string[] = [];
    const committed = this.operations(set.id).filter(item => item.outcome.state === 'committed').reverse();
    const stagedBytes = new Map<number, Buffer>();
    for (const { operation, outcome } of committed) {
      const root = this.roots.get(set.sessionId, operation.rootId), handle = this.roots.handle(root);
      const currentHash = async (rel: string) => { try { return (await run(['hash', ...rootArgs(handle), rel], { signal })).sha256 as string; } catch (error: any) { if (error?.code === 'missing') return null; throw error; } };
      const index = inverse.length;
      if (operation.kind === 'create_text' || operation.kind === 'copy') {
        const now = await currentHash(operation.path);
        if (now === null) continue;
        if (now !== outcome.sha256) { conflicts.push(`${operation.path} changed after Cere wrote it; it was left as it is`); continue; }
        inverse.push({ index, kind: 'trash', label: 'trashed', rootId: root.id, path: operation.path, source: { type: 'file', sha256: now }, destination: 'absent', trashId: randomUUID(), dependsOn: [], review: { notes: [`Undo: ${operation.kind === 'copy' ? 'remove the copy' : 'remove the file Cere created'} (kept in Cere’s trash)`] } });
      } else if (operation.kind === 'patch_text') {
        const now = await currentHash(operation.path), previous = outcome.backup ? await readFile(outcome.backup).catch(() => null) : null;
        if (!previous) { conflicts.push(`${operation.path}: the previous version is no longer kept`); continue; }
        if (now === outcome.sha256) {
          stagedBytes.set(index, previous);
          inverse.push({ index, kind: 'patch_text', label: 'changed', rootId: root.id, path: operation.path, source: { type: 'file', sha256: now! }, destination: { sha256: now! }, staged: { sha256: sha256(previous), bytes: previous.length }, mode: operation.mode, dependsOn: [],
            review: { notes: ['Undo: restore the version from before Cere’s edit'] } });
          try { const current = await readText(root, operation.path, signal); inverse[index].review.diff = lineDiff(current.binary ? '' : current.lines.join('\n'), previous.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n$/, ''), operation.path); } catch { inverse[index].review.notes.push('Too large to show completely'); }
        } else {
          // Restore as a copy beside the newer file.
          const copyPath = restoredName(operation.path);
          if (await currentHash(copyPath) !== null) { conflicts.push(`${operation.path} changed after Cere’s edit and ${copyPath} already exists`); continue; }
          stagedBytes.set(index, previous);
          inverse.push({ index, kind: 'create_text', label: 'added', rootId: root.id, path: copyPath, destination: 'absent', staged: { sha256: sha256(previous), bytes: previous.length }, mode: operation.mode, dependsOn: [], review: { notes: [`Undo as a copy: ${operation.path} changed after Cere’s edit, so the earlier version is restored beside it`] } });
        }
      } else if (operation.kind === 'mkdir') {
        // The folder may hold only items that earlier undo steps remove; it must be empty once they ran.
        let listing: any;
        try { listing = await run(['list', ...rootArgs(handle), operation.path, '--hidden', '--limit', '500']); } catch { continue; }
        const removedBefore = inverse.filter(item => item.rootId === root.id && (item.kind === 'trash' || item.kind === 'remove_folder' || item.kind === 'move' && item.fromRootId === root.id));
        const leaving = (name: string) => removedBefore.find(item => (item.kind === 'move' ? item.from : item.path) === operation.path + '/' + name);
        if (listing.total > 500 || listing.entries.some((entry: any) => entry.invalidName || !leaving(entry.name))) { conflicts.push(`${operation.path} is no longer empty; it was left in place`); continue; }
        const info = await statPath(root, operation.path, signal) as any;
        inverse.push({ index, kind: 'remove_folder', label: 'removed', rootId: root.id, path: operation.path, source: { type: 'directory', ino: info.ino }, destination: 'absent',
          dependsOn: listing.entries.map((entry: any) => leaving(entry.name)!.index), review: { notes: ['Undo: remove the empty folder Cere made'] } });
      } else if (operation.kind === 'move') {
        const back = this.roots.get(set.sessionId, operation.fromRootId!);
        if (operation.source?.type === 'file') {
          const now = await currentHash(operation.path);
          if (now !== operation.source.sha256) { conflicts.push(`${operation.path} changed or is gone since Cere moved it`); continue; }
        }
        let destination = operation.from!;
        try { await statPath(back, destination, signal); destination = restoredName(destination); conflicts.push(`${operation.from} is taken again; the item goes back as ${destination}`); } catch (error: any) { if (error?.code !== 'missing') throw error; }
        const info = await statPath(root, operation.path, signal) as any;
        inverse.push({ index, kind: 'move', label: 'moved', rootId: back.id, path: destination, fromRootId: root.id, from: operation.path, source: { ...operation.source!, ino: info.ino }, destination: 'absent', dependsOn: [], review: { notes: ['Undo: move it back'] } });
      } else if (operation.kind === 'trash') {
        const trash = await this.trashRoot();
        const record = await readFile(join(trash.path, outcome.trashId + '.json'), 'utf8').then(text => JSON.parse(text), () => null);
        if (record?.state !== 'trashed') { conflicts.push(`${operation.path} was already restored or permanently deleted from Cere’s trash`); continue; }
        let destination = operation.path;
        try { await statPath(root, destination, signal); destination = restoredName(destination); conflicts.push(`${operation.path} exists again; the trashed item is restored as ${destination}`); } catch (error: any) { if (error?.code !== 'missing') throw error; }
        inverse.push({ index, kind: 'restore', label: 'restored', rootId: root.id, path: destination, source: { type: operation.source!.type, sha256: operation.source!.sha256 }, destination: 'absent', trashId: outcome.trashId, dependsOn: [], review: { notes: ['Undo: restore from Cere’s trash'] } });
      }
    }
    if (!inverse.length) throw fail('nothing', conflicts.length ? 'Nothing can be undone safely: ' + conflicts.join('; ') : 'Nothing is left to undo');
    const undoSet = await this.propose(set.sessionId, undefined, { origin: 'undo', reason: `Undo ${set.reason || 'earlier change'}`.slice(0, 500), undoOf: set.id, internal: inverse }, signal);
    const staging = this.area(join('staged', undoSet.id));
    for (const [index, bytes] of stagedBytes) await writeFile(join(staging, String(index)), bytes, { mode: 0o600, flag: 'wx' });
    return { ...this.review(undoSet.id), conflicts };
  }
  /** Marks a pending change set declined, expired or revoked; it can never be applied afterwards. */
  retire(id: string, status: 'declined' | 'expired' | 'revoked') {
    const set = this.get(id);
    if (set.status !== 'pending') return set;
    set.status = status; set.finished = Date.now(); this.save(set);
    void remove(join(this.directory, 'staged', set.id));
    this.changed();
    return set;
  }
  /** Pending change sets bound to a root, for retirement when its permissions change. */
  pendingFor(rootId: string) { return this.store.db.prepare("SELECT data FROM change_sets WHERE status='pending'").all().map(row => JSON.parse(String(row.data)) as ChangeSet).filter(set => set.roots.some(root => root.id === rootId)); }
  /**
   * After a restart: a change set left applying has operations whose outcome is unknown. They are
   * recorded as such and never replayed; the user checks the files and decides.
   */
  recover() {
    for (const row of this.store.db.prepare("SELECT data FROM change_sets WHERE status='applying'").all()) {
      const set = JSON.parse(String(row.data)) as ChangeSet;
      for (const { operation, outcome } of this.operations(set.id)) {
        if (outcome.state === 'committing') this.outcome(set.id, operation.index, { state: 'unknown', code: 'interrupted', message: 'Cere stopped while this was being written. Check the file; nothing is retried automatically.' });
        else if (outcome.state === 'pending') this.outcome(set.id, operation.index, { state: 'skipped', message: 'Not attempted: Cere stopped first' });
      }
      set.status = 'unknown'; set.finished = Date.now(); this.save(set);
    }
    for (const row of this.store.db.prepare("SELECT data FROM change_sets WHERE status='pending'").all()) {
      const set = JSON.parse(String(row.data)) as ChangeSet;
      // A model's pending review belonged to a turn that the restart ended.
      if (set.origin === 'model' || set.expires < Date.now()) { set.status = set.expires < Date.now() ? 'expired' : 'declined'; set.finished = Date.now(); this.save(set); }
    }
  }
  removeSession(sessionId: string) {
    const ids = this.store.db.prepare('SELECT id FROM change_sets WHERE session_id=?').all(sessionId).map(row => String(row.id));
    for (const id of ids) { this.store.db.prepare('DELETE FROM change_operations WHERE change_set_id=?').run(id); void remove(join(this.directory, 'staged', id)); void remove(join(this.directory, 'backups', id)); }
    this.store.db.prepare('DELETE FROM change_sets WHERE session_id=?').run(sessionId);
  }
}

function restoredName(rel: string) {
  const name = baseName(rel), dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : '';
  return (parentPath(rel) ? parentPath(rel) + '/' : '') + `${stem} (restored)${extension}`;
}

/**
 * Applies exact replacements to a text file. Each oldText must match exactly once, after the file's
 * line endings are read as \n; the result is written back with the file's own line endings. There is
 * no fuzzy matching: a missing or ambiguous match fails with a message saying which.
 */
export function patched(current: { text: string; newline: 'lf' | 'crlf' | 'mixed'; endsWithNewline: boolean }, p: { edits?: unknown; content?: unknown }) {
  const crlf = current.newline === 'crlf';
  if (p.content !== undefined) {
    if (p.edits !== undefined) throw fail('invalid', 'Give either edits or content, not both');
    if (typeof p.content !== 'string' || p.content.includes('\0')) throw fail('invalid-content', 'Content must be text');
    return crlf ? p.content.replace(/\r?\n/g, '\r\n') : p.content;
  }
  if (!Array.isArray(p.edits) || !p.edits.length || p.edits.length > 50) throw fail('invalid', 'Give 1–50 edits, each with oldText and newText');
  if (current.newline === 'mixed' && p.edits.some((edit: any) => typeof edit?.oldText === 'string' && edit.oldText.includes('\n'))) throw fail('mixed-newlines', 'This file mixes line endings, so multi-line edits are ambiguous. Replace single lines, or give the full content.');
  let text = crlf ? current.text.replace(/\r\n/g, '\n') : current.text;
  for (const [index, edit] of (p.edits as any[]).entries()) {
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string' || !edit.oldText || edit.oldText.includes('\0') || edit.newText.includes('\0')) throw fail('invalid', `Edit ${index + 1} needs a non-empty oldText and a newText`);
    const oldText = edit.oldText.replace(/\r\n/g, '\n'), newText = edit.newText.replace(/\r\n/g, '\n');
    const first = text.indexOf(oldText);
    if (first < 0) throw fail('no-match', `Edit ${index + 1}: oldText was not found. Copy it exactly from files_read (without the line-number prefixes).`);
    const second = text.indexOf(oldText, first + 1);
    if (second >= 0) { let count = 0; for (let at = text.indexOf(oldText); at >= 0; at = text.indexOf(oldText, at + 1)) count++; throw fail('ambiguous', `Edit ${index + 1}: oldText matches ${count} places. Include more surrounding lines so it matches exactly one.`); }
    text = text.slice(0, first) + newText + text.slice(first + oldText.length);
  }
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}
export const reviewLimits = { diffLines: proposalLimits.diffLines, reviewBytes: proposalLimits.reviewBytes };
