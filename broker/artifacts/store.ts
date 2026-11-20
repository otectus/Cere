/**
 * Artifacts: immutable files Cere owns. Bytes live privately outside SQLite, named by their SHA-256;
 * metadata, ownership and derivations live in SQLite. A version is visible only after both are
 * committed. Possessing a hash or an ID grants nothing: every read resolves through a reference owned
 * by the asking conversation (or a project it belongs to, once the user shared the artifact there).
 *
 * Distinct things stay distinct: a workspace file is a live external file; an artifact version is a
 * snapshot that never changes; an export is a recorded write of a version somewhere the user chose, not
 * kept in sync afterwards.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat, link, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { privateDir } from '../paths.ts';
import type { Store } from '../store.ts';
import { localOnly, strictest, type ArtifactRef, type DestinationPolicy } from '../tools/contracts.ts';

export type ArtifactKind = 'text' | 'document' | 'table' | 'image' | 'plot' | 'bundle' | 'other';
export type ArtifactSource = 'user-import' | 'tool-output' | 'model-generation' | 'derived';
export type Provenance = Record<string, string | number | boolean | null | string[] | Record<string, unknown>> & { kind: string };
export type ArtifactVersion = {
  artifactId: string; versionId: string; projectId?: string; sessionId: string; turnId?: string; operationId?: string;
  kind: ArtifactKind; name: string; mime: string; bytes: number; sha256: string; createdAt: number; source: ArtifactSource;
  parents: { artifactId: string; versionId: string; relation: string }[];
  policyId: string; provenanceId: string;
  /** Where this content may be processed; derived content inherits the strictest of its sources. */
  policy: DestinationPolicy;
  provenance: Provenance;
  image?: { width: number; height: number; format: string; alpha: boolean; transparent?: boolean; frames?: number; orientation?: number };
  label?: string;
};
export type Artifact = { id: string; sessionId: string; project: string; name: string; kind: ArtifactKind; created: number; updated: number; latestVersionId: string; versions: number; pinned: boolean; tags: string[]; shared: boolean };
export const artifactLimits = { bytes: 100 * 1024 * 1024, imagePixels: 64_000_000, thumbnail: 256, names: 200, tags: 12, perPage: 60 };
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f-]{36}$/;

export function kindFor(mime: string, name = ''): ArtifactKind {
  if (mime.startsWith('image/')) return 'image';
  if (/^(text\/csv|text\/tab-separated-values|application\/vnd\.openxmlformats-officedocument\.spreadsheetml)/.test(mime) || /\.(csv|tsv|xlsx)$/i.test(name)) return 'table';
  if (/^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml|text\/html|text\/markdown)/.test(mime) || /\.(pdf|docx|html?|md)$/i.test(name)) return 'document';
  if (mime === 'application/zip') return 'bundle';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text';
  return 'other';
}
export function mimeFor(name: string, bytes: Buffer): string {
  const head = bytes.subarray(0, 12), ascii = head.toString('latin1');
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('%PDF')) return 'application/pdf';
  const lower = name.toLowerCase();
  if (ascii.startsWith('PK\x03\x04')) return lower.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : lower.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip';
  const byExtension: Record<string, string> = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown', py: 'text/x-python', txt: 'text/plain', svg: 'image/svg+xml' };
  const extension = lower.split('.').pop() || '';
  if (byExtension[extension]) return byExtension[extension];
  return bytes.subarray(0, 65536).includes(0) ? 'application/octet-stream' : 'text/plain';
}
export const safeName = (value: unknown, fallback = 'artifact') => {
  const text = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, artifactLimits.names) : '';
  return text && text !== '.' && text !== '..' ? text : fallback;
};

export class ArtifactStore {
  store: Store; directory: string;
  changed: () => void = () => {};
  constructor(store: Store) { this.store = store; this.directory = join(store.directory, 'artifacts'); }
  objectsDir() { return privateDir(join(this.directory, 'objects')); }
  objectPath(hash: string) { if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid artifact content'); return join(this.directory, 'objects', hash.slice(0, 2), hash); }
  /**
   * Installs bytes as a new version: staged privately, hashed, linked into the object store (sharing
   * identical bytes), then committed with its metadata and an owning reference in one transaction.
   */
  async install(p: { sessionId: string; bytes: Buffer; name: string; mime?: string; source: ArtifactSource; provenance: Provenance; policy?: DestinationPolicy; parents?: ArtifactVersion['parents'];
    artifactId?: string; turnId?: string; operationId?: string; label?: string; projectShare?: boolean }): Promise<ArtifactVersion> {
    const session = this.store.session(p.sessionId);
    if (session.temporary) throw new Error('Temporary conversations do not keep files');
    if (p.bytes.length > artifactLimits.bytes) throw new Error('Files over 100 MiB are not kept as artifacts');
    const name = safeName(p.name), mime = p.mime || mimeFor(name, p.bytes), kind = kindFor(mime, name), hash = sha256(p.bytes);
    let image: ArtifactVersion['image'];
    if (kind === 'image' && mime !== 'image/svg+xml') {
      const metadata = await sharp(p.bytes, { limitInputPixels: artifactLimits.imagePixels, animated: true }).metadata().catch(() => null);
      if (!metadata?.width || !metadata.height) throw new Error('This image could not be decoded, or is larger than 64 megapixels');
      // An alpha channel is not transparency: only pixels that are not fully opaque make it so.
      const transparent = metadata.hasAlpha ? !(await sharp(p.bytes, { limitInputPixels: artifactLimits.imagePixels }).stats().then(stats => stats.isOpaque).catch(() => false)) : false;
      image = { width: metadata.width, height: metadata.height, format: metadata.format || mime.slice(6), alpha: !!metadata.hasAlpha, transparent, ...(metadata.pages && metadata.pages > 1 ? { frames: metadata.pages } : {}), ...(metadata.orientation ? { orientation: metadata.orientation } : {}) };
    }
    // Stage, verify, then publish the bytes under their hash.
    const staging = privateDir(join(this.directory, 'staging')), temporary = join(staging, randomUUID());
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(p.bytes); await handle.sync(); } finally { await handle.close(); }
    const target = this.objectPath(hash);
    privateDir(join(this.directory, 'objects', hash.slice(0, 2)));
    try { await link(temporary, target); } catch (error: any) { if (error?.code !== 'EEXIST') { await rm(temporary, { force: true }); throw error; } }
    await rm(temporary, { force: true });
    const existing = await readFile(target);
    if (sha256(existing) !== hash) throw new Error('Stored artifact bytes do not match; nothing was recorded');
    const time = Date.now(), policy = p.policy || localOnly, versionId = randomUUID();
    let artifactId = p.artifactId;
    if (artifactId) { const owner = this.artifact(artifactId); if (owner.sessionId !== p.sessionId && !this.authorized(p.sessionId, artifactId)) throw new Error('That artifact belongs to another conversation'); }
    else artifactId = randomUUID();
    const version: ArtifactVersion = { artifactId, versionId, sessionId: p.sessionId, ...(session.cwd ? { projectId: session.cwd } : {}), ...(p.turnId ? { turnId: p.turnId } : {}), ...(p.operationId ? { operationId: p.operationId } : {}),
      kind, name, mime, bytes: p.bytes.length, sha256: hash, createdAt: time, source: p.source, parents: p.parents || [], policy, policyId: sha256(JSON.stringify(policy)).slice(0, 16),
      provenance: p.provenance, provenanceId: randomUUID(), ...(image ? { image } : {}), ...(p.label ? { label: safeName(p.label, '') } : {}) };
    this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT data FROM artifacts WHERE id=?').get(artifactId!);
      const artifact: Artifact = row ? { ...JSON.parse(String(row.data)), updated: time, latestVersionId: versionId } : { id: artifactId!, sessionId: p.sessionId, project: session.cwd || '', name, kind, created: time, updated: time, latestVersionId: versionId, versions: 0, pinned: false, tags: [], shared: false };
      artifact.versions = (artifact.versions || 0) + 1;
      this.store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data').run(artifact.id, artifact.sessionId, artifact.project, time, JSON.stringify(artifact));
      this.store.db.prepare('INSERT INTO artifact_versions VALUES (?,?,?,?,?)').run(versionId, artifactId!, hash, time, JSON.stringify(version));
      if (!row) this.store.db.prepare('INSERT INTO artifact_refs VALUES (?,?,?,?,?,?,?)').run(randomUUID(), artifactId!, null, 'session', p.sessionId, time, '{}');
      for (const parent of version.parents) this.store.db.prepare('INSERT INTO artifact_derivations VALUES (?,?,?,?,?,?)').run(randomUUID(), parent.versionId, versionId, parent.relation.slice(0, 40), time, '{}');
    });
    this.changed();
    return version;
  }
  artifact(id: unknown): Artifact {
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Unknown artifact');
    const row = this.store.db.prepare('SELECT data FROM artifacts WHERE id=?').get(id);
    if (!row) throw new Error('That artifact no longer exists');
    return JSON.parse(String(row.data));
  }
  /** Whether a conversation holds a reference: its own, or a project share for the project it belongs to. */
  authorized(sessionId: string, artifactId: string) {
    let session; try { session = this.store.session(sessionId); } catch { return false; }
    return !!this.store.db.prepare("SELECT 1 FROM artifact_refs WHERE artifact_id=? AND ((owner_kind='session' AND owner_id=?) OR (owner_kind='project' AND owner_id=?))").get(artifactId, sessionId, session.cwd);
  }
  /** One version, only through an authorized reference. A model-supplied ID for another conversation's file is refused. */
  version(sessionId: string, artifactId: unknown, versionId?: unknown): ArtifactVersion {
    const artifact = this.artifact(artifactId);
    if (!this.authorized(sessionId, artifact.id)) throw new Error('That artifact is not available in this conversation');
    const id = versionId === undefined || versionId === '' ? artifact.latestVersionId : versionId;
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Unknown artifact version');
    const row = this.store.db.prepare('SELECT data FROM artifact_versions WHERE id=? AND artifact_id=?').get(id, artifact.id);
    if (!row) throw new Error('That version does not exist');
    return JSON.parse(String(row.data));
  }
  versions(sessionId: string, artifactId: unknown): ArtifactVersion[] {
    const artifact = this.artifact(artifactId);
    if (!this.authorized(sessionId, artifact.id)) throw new Error('That artifact is not available in this conversation');
    return this.store.db.prepare('SELECT data FROM artifact_versions WHERE artifact_id=? ORDER BY created').all(artifact.id).map(row => JSON.parse(String(row.data)));
  }
  /** The bytes of a version, verified against its hash; a missing or altered file is reported, never served. */
  async bytes(sessionId: string, artifactId: unknown, versionId?: unknown) {
    const version = this.version(sessionId, artifactId, versionId);
    const data = await readFile(this.objectPath(version.sha256)).catch(() => { throw new Error(`The stored bytes of ${version.name} are missing`); });
    if (sha256(data) !== version.sha256) throw new Error(`The stored bytes of ${version.name} no longer match its record`);
    return { version, data };
  }
  async available(version: ArtifactVersion) { try { return (await stat(this.objectPath(version.sha256))).size === version.bytes; } catch { return false; } }
  /** Bounded PNG thumbnails, made on demand, cached by content and evictable. */
  async thumbnail(sessionId: string, artifactId: unknown, versionId?: unknown, size = artifactLimits.thumbnail) {
    const version = this.version(sessionId, artifactId, versionId);
    if (version.kind !== 'image' && version.kind !== 'plot') return null;
    const edge = Math.max(32, Math.min(1024, Math.round(size))), cache = join(privateDir(join(this.directory, 'thumbnails')), `${version.sha256}-${edge}.png`);
    let png = await readFile(cache).catch(() => null);
    if (!png) {
      const { data } = await this.bytes(sessionId, version.artifactId, version.versionId);
      png = await sharp(data, { limitInputPixels: artifactLimits.imagePixels }).rotate().resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const temporary = cache + '.' + randomUUID().slice(0, 8);
      await writeFile(temporary, png, { mode: 0o600 }); await rename(temporary, cache);
    }
    return 'data:image/png;base64,' + png.toString('base64');
  }
  /** Artifacts of a conversation (and, optionally, those shared with its project), newest first, a page at a time. */
  list(sessionId: string, p: { kind?: unknown; source?: unknown; query?: unknown; project?: boolean; before?: unknown; limit?: unknown } = {}) {
    const session = this.store.session(sessionId), limit = Math.min(Number(p.limit) || artifactLimits.perPage, 200);
    const rows = this.store.db.prepare(`SELECT a.data FROM artifacts a WHERE EXISTS (SELECT 1 FROM artifact_refs r WHERE r.artifact_id=a.id AND ((r.owner_kind='session' AND r.owner_id=?)${p.project ? " OR (r.owner_kind='project' AND r.owner_id=?)" : ''}))
      AND (? IS NULL OR a.updated < ?) ORDER BY a.updated DESC LIMIT ?`).all(...[sessionId, ...(p.project ? [session.cwd] : []), Number.isFinite(p.before) ? p.before as number : null, Number.isFinite(p.before) ? p.before as number : null, limit + 1]);
    let artifacts = rows.map(row => JSON.parse(String(row.data)) as Artifact);
    if (typeof p.kind === 'string' && p.kind) artifacts = artifacts.filter(item => item.kind === p.kind);
    if (typeof p.query === 'string' && p.query.trim()) { const q = p.query.toLowerCase(); artifacts = artifacts.filter(item => item.name.toLowerCase().includes(q) || item.tags.some(tag => tag.toLowerCase().includes(q))); }
    const page = artifacts.slice(0, limit).map(item => ({ ...item, latest: this.version(sessionId, item.id, item.latestVersionId) }));
    if (typeof p.source === 'string' && p.source) return { artifacts: page.filter(item => item.latest.source === p.source), ...(rows.length > limit ? { before: page.at(-1)?.updated } : {}) };
    return { artifacts: page, ...(rows.length > limit ? { before: page.at(-1)?.updated } : {}) };
  }
  update(sessionId: string, artifactId: unknown, p: { name?: unknown; tags?: unknown; pinned?: unknown; shared?: unknown }) {
    const artifact = this.artifact(artifactId);
    if (!this.authorized(sessionId, artifact.id)) throw new Error('That artifact is not available in this conversation');
    if (p.name !== undefined) artifact.name = safeName(p.name, artifact.name);
    if (p.tags !== undefined) { if (!Array.isArray(p.tags) || p.tags.length > artifactLimits.tags) throw new Error(`Use up to ${artifactLimits.tags} tags`); artifact.tags = [...new Set(p.tags.map(tag => safeName(tag, '').slice(0, 40)).filter(Boolean))]; }
    if (p.pinned !== undefined) { if (typeof p.pinned !== 'boolean') throw new Error('Invalid pin'); artifact.pinned = p.pinned; }
    if (p.shared !== undefined) {
      if (typeof p.shared !== 'boolean') throw new Error('Invalid project share');
      const session = this.store.session(sessionId);
      if (p.shared && !artifact.shared) this.store.db.prepare('INSERT INTO artifact_refs VALUES (?,?,?,?,?,?,?)').run(randomUUID(), artifact.id, null, 'project', session.cwd, Date.now(), JSON.stringify({ sharedBy: sessionId }));
      if (!p.shared) this.store.db.prepare("DELETE FROM artifact_refs WHERE artifact_id=? AND owner_kind='project'").run(artifact.id);
      artifact.shared = p.shared;
    }
    artifact.updated = Date.now();
    this.store.db.prepare('UPDATE artifacts SET updated=?, data=? WHERE id=?').run(artifact.updated, JSON.stringify(artifact), artifact.id);
    this.changed();
    return artifact;
  }
  /**
   * Removing an artifact from a conversation drops that reference. The artifact and its bytes go only
   * when nothing references them anymore; exported copies outside Cere are never touched.
   */
  async removeFromSession(sessionId: string, artifactId: unknown, scope: unknown = 'artifact') {
    const artifact = this.artifact(artifactId);
    if (scope !== 'artifact' && scope !== 'derived') throw new Error('Choose what to remove');
    // With "derived", what this conversation made from the file (extractions, OCR text, results) goes too.
    const ids = [artifact.id, ...(scope === 'derived' ? this.derivedIn(sessionId, artifact.id) : [])];
    if (!this.store.db.prepare("SELECT 1 FROM artifact_refs WHERE artifact_id=? AND owner_kind='session' AND owner_id=?").get(artifact.id, sessionId)) throw new Error('That artifact is not in this conversation');
    this.store.transaction(() => { for (const id of ids) this.store.db.prepare("DELETE FROM artifact_refs WHERE artifact_id=? AND owner_kind='session' AND owner_id=?").run(id, sessionId); });
    const deleted = await this.collect(ids);
    this.changed();
    return { removed: ids, deleted };
  }
  /** Artifacts this conversation holds that were derived from one, following derivation links transitively. */
  derivedIn(sessionId: string, artifactId: string) {
    const seen = new Set([artifactId]), queue = [artifactId], found: string[] = [];
    const next = this.store.db.prepare(`SELECT DISTINCT derived.artifact_id AS id FROM artifact_versions source JOIN artifact_derivations d ON d.source_version_id=source.id
      JOIN artifact_versions derived ON derived.id=d.derived_version_id WHERE source.artifact_id=?`);
    const held = this.store.db.prepare("SELECT 1 FROM artifact_refs WHERE artifact_id=? AND owner_kind='session' AND owner_id=?");
    while (queue.length && found.length < 1000) for (const row of next.all(queue.shift()!)) {
      const id = String(row.id); if (seen.has(id)) continue; seen.add(id);
      if (held.get(id, sessionId)) { found.push(id); queue.push(id); }
    }
    return found;
  }
  /** Deletes artifacts nothing references anymore, then bytes no version uses (and their thumbnails). */
  async collect(ids?: string[]) {
    const candidates = ids || this.store.db.prepare('SELECT id FROM artifacts').all().map(row => String(row.id));
    const removed: string[] = [];
    for (const id of candidates) {
      if (this.store.db.prepare('SELECT 1 FROM artifact_refs WHERE artifact_id=?').get(id)) continue;
      const hashes = this.store.db.prepare('SELECT DISTINCT sha256 FROM artifact_versions WHERE artifact_id=?').all(id).map(row => String(row.sha256));
      const versions = this.store.db.prepare('SELECT id FROM artifact_versions WHERE artifact_id=?').all(id).map(row => String(row.id));
      this.store.transaction(() => {
        for (const version of versions) this.store.db.prepare('DELETE FROM artifact_derivations WHERE source_version_id=? OR derived_version_id=?').run(version, version);
        this.store.db.prepare('DELETE FROM artifact_versions WHERE artifact_id=?').run(id);
        this.store.db.prepare('DELETE FROM artifacts WHERE id=?').run(id);
      });
      for (const hash of hashes) if (!this.store.db.prepare('SELECT 1 FROM artifact_versions WHERE sha256=?').get(hash)) {
        await rm(this.objectPath(hash), { force: true });
        for (const name of await readdir(join(this.directory, 'thumbnails')).catch(() => [] as string[])) if (name.startsWith(hash)) await rm(join(this.directory, 'thumbnails', name), { force: true });
      }
      removed.push(id);
    }
    return removed;
  }
  /** A deleted conversation's references go; artifacts it shared with its project stay there. */
  async removeSession(sessionId: string) {
    const ids = this.store.db.prepare("SELECT DISTINCT artifact_id FROM artifact_refs WHERE owner_kind='session' AND owner_id=?").all(sessionId).map(row => String(row.artifact_id));
    this.store.db.prepare("DELETE FROM artifact_refs WHERE owner_kind='session' AND owner_id=?").run(sessionId);
    await this.collect(ids);
  }
  /** Records a write of a version outside Cere, so its card can reveal the exported copy. */
  recordExport(version: ArtifactVersion, destination: string) {
    this.store.db.prepare('INSERT INTO artifact_derivations VALUES (?,?,?,?,?,?)').run(randomUUID(), version.versionId, null, 'export', Date.now(), JSON.stringify({ destination, sha256: version.sha256 }));
  }
  exports(version: ArtifactVersion) { return this.store.db.prepare("SELECT data,created FROM artifact_derivations WHERE source_version_id=? AND kind='export' ORDER BY created DESC LIMIT 10").all(version.versionId).map(row => ({ ...JSON.parse(String(row.data)), at: Number(row.created) })); }
  /** Derived content inherits every source's processing restrictions. */
  inherit(sessionId: string, refs: ArtifactRef[] | { artifactId: string; versionId: string }[]) { return refs.length ? strictest(...refs.map(ref => this.version(sessionId, ref.artifactId, ref.versionId).policy)) : localOnly; }
  /** Cleans staging files left by an interrupted install. */
  async recover() { await rm(join(this.directory, 'staging'), { recursive: true, force: true }).catch(() => {}); }
}
