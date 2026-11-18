/**
 * Reviewed file edits for broker-owned write tools (M07 notes now; M22's general boundary). A
 * proposal names a confined path, the SHA-256 of the content it was made against, the full new
 * content and a readable diff. Applying re-reads the file immediately before writing: a changed
 * base refuses, so a concurrent edit is never overwritten. The write is a same-directory temporary
 * file, flushed and renamed into place with the old file's mode; the old content is kept as a
 * private backup first. A proposal applies once. Native CLI edits are not routed through here.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

export type FileProposal = {
  id: string; root: string; path: string; display: string; baseSha256: string | null; content: string;
  diff: string; digest: string; created: number; expires: number; sessionId: string; reason: string;
  /** M22: a proposal is used once, whether it was applied or declined. */
  used?: boolean;
};
export const proposalLimits = { bytes: 256 * 1024, reviewBytes: 64 * 1024, diffLines: 1500, lifetimeMs: 15 * 60_000, backups: 50 };
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const proposalDigest = (proposal: Pick<FileProposal, 'root' | 'path' | 'display' | 'baseSha256' | 'content' | 'diff' | 'sessionId' | 'reason'>) => sha256(JSON.stringify({
  root: proposal.root, path: proposal.path, display: proposal.display, baseSha256: proposal.baseSha256,
  content: proposal.content, diff: proposal.diff, sessionId: proposal.sessionId, reason: proposal.reason,
}));
const staleBase = () => Object.assign(new Error('The file changed since this edit was proposed. Nothing was written; review a new proposal.'), { code: 'STALE_BASE' });

// Cere-owned commits for one target are serialized. External editors do not take this lock, so apply
// also rechecks immediately before replacement and reports conflicts rather than claiming portable CAS.
const targetLocks = new Map<string, Promise<void>>();
async function withTargetLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = targetLocks.get(path) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  targetLocks.set(path, current);
  await previous;
  try { return await task(); }
  finally { release(); if (targetLocks.get(path) === current) targetLocks.delete(path); }
}

/** A path inside root, without symbolic links on the way, hidden components or traversal. */
export async function confinedPath(root: string, requested: string) {
  const base = await realpath(root);
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) throw new Error('Choose a file inside the allowed folder');
  const target = join(base, requested.startsWith(base + sep) ? relative(base, requested) : requested);
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || rel.split(sep).some(part => part.startsWith('.') || part === '')) throw new Error('Choose a visible file inside the allowed folder');
  // Every existing component must be a real directory or file, never a link out of the folder.
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked files cannot be edited here'); }
    catch (error: any) { if (error?.code === 'ENOENT') break; throw error; }
  }
  return { base, path: target, rel };
}

/** A complete unified-style diff by line. Operations too large for the review surface are refused. */
export function lineDiff(before: string, after: string, name: string) {
  const a = before ? before.split('\n') : [], b = after.split('\n');
  if (a.length > proposalLimits.diffLines || b.length > proposalLimits.diffLines) throw new Error(`This edit is too large to review completely (limit: ${proposalLimits.diffLines} lines)`);
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lines: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(' ' + a[i]); i++; j++; }
    // Removals come before additions, as in a unified diff.
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) { lines.push('-' + a[i]); i++; }
    else { lines.push('+' + b[j]); j++; }
  }
  // Unchanged stretches longer than six lines are folded to keep the review readable.
  const folded: string[] = [];
  for (let start = 0; start < lines.length;) {
    if (!lines[start].startsWith(' ')) { folded.push(lines[start++]); continue; }
    let end = start; while (end < lines.length && lines[end].startsWith(' ')) end++;
    if (end - start > 6) folded.push(...lines.slice(start, start + 2), `@@ ${end - start - 4} unchanged lines @@`, ...lines.slice(end - 2, end));
    else folded.push(...lines.slice(start, end));
    start = end;
  }
  const diff = [`--- ${name}`, `+++ ${name}`, ...folded].join('\n');
  if (Buffer.byteLength(diff) > proposalLimits.reviewBytes) throw new Error('This edit is too large to review completely (limit: 64 KB of diff)');
  return diff;
}

export async function propose(p: { root: string; path: string; content: unknown; sessionId: string; reason?: unknown }): Promise<FileProposal> {
  if (typeof p.content !== 'string' || p.content.includes('\0') || Buffer.byteLength(p.content) > proposalLimits.bytes) throw new Error('A proposed file must be text of up to 256 KB');
  const { base, path, rel } = await confinedPath(p.root, p.path);
  let before: string | null = null;
  try { const info = await stat(path); if (!info.isFile()) throw new Error('Only files can be edited'); before = await readFile(path, 'utf8'); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const reason = typeof p.reason === 'string' ? p.reason.slice(0, 500) : '';
  const proposal = { id: randomUUID(), root: base, path, display: rel, baseSha256: before === null ? null : sha256(before), content: p.content,
    diff: lineDiff(before || '', p.content, rel), created: Date.now(), expires: Date.now() + proposalLimits.lifetimeMs, sessionId: p.sessionId, reason } as FileProposal;
  proposal.digest = proposalDigest(proposal);
  return proposal;
}

/** Applies a reviewed proposal once, refusing if the file changed since it was proposed. */
export async function apply(proposal: FileProposal, backups: string, validate: () => void | Promise<void> = () => {}, authorizeCommit: () => void = () => {}) {
  if (proposal.used) throw new Error('This proposal was already used. Ask for a new one.');
  proposal.used = true;
  if (proposal.expires < Date.now()) throw new Error('This proposal expired. Ask for it again.');
  if (proposal.digest !== proposalDigest(proposal)) throw new Error('This file proposal changed after review. Ask for a new one.');
  const first = await confinedPath(proposal.root, proposal.display);
  if (first.path !== proposal.path) throw new Error('The file’s location changed since the proposal');
  return withTargetLock(first.path, async () => {
    const confined = await confinedPath(proposal.root, proposal.display);
    if (confined.path !== proposal.path) throw new Error('The file’s location changed since the proposal');
    let current: string | null = null, mode = 0o644;
    try { const info = await stat(confined.path); mode = info.mode & 0o777; current = await readFile(confined.path, 'utf8'); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    if ((current === null ? null : sha256(current)) !== proposal.baseSha256) throw staleBase();
    if (current === null) await mkdir(dirname(confined.path), { recursive: true });
    const temporary = join(dirname(confined.path), `.${basename(confined.path)}.cere-${randomUUID().slice(0, 8)}`);
    let backup = '', committed = false;
    try {
      const handle = await open(temporary, 'wx', mode);
      try { await handle.writeFile(proposal.content); await handle.sync(); }
      finally { await handle.close(); }
      await chmod(temporary, mode);
      await validate();
      const final = await confinedPath(proposal.root, proposal.display);
      if (final.path !== proposal.path) throw new Error('The file’s location changed since the proposal');
      let latest: string | null = null;
      try { latest = await readFile(final.path, 'utf8'); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      if ((latest === null ? null : sha256(latest)) !== proposal.baseSha256) throw staleBase();
      if (latest !== null) {
        await mkdir(backups, { recursive: true, mode: 0o700 });
        backup = join(backups, `${Date.now()}-${randomUUID().slice(0, 8)}-${basename(final.path)}`);
        await writeFile(backup, latest, { mode: 0o600, flag: 'wx' });
        await pruneBackups(backups);
      }
      await validate();
      const atCommit = await confinedPath(proposal.root, proposal.display);
      if (atCommit.path !== proposal.path) throw new Error('The file’s location changed since the proposal');
      let commitBase: string | null = null;
      try { commitBase = await readFile(atCommit.path, 'utf8'); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      if ((commitBase === null ? null : sha256(commitBase)) !== proposal.baseSha256) throw staleBase();
      authorizeCommit();
      if (commitBase === null) {
        try { await link(temporary, atCommit.path); }
        catch (error: any) { if (error?.code === 'EEXIST') throw staleBase(); throw error; }
      } else await rename(temporary, atCommit.path);
      committed = true;
      return { path: atCommit.path, sha256: sha256(proposal.content), backup, created: commitBase === null };
    } finally {
      await rm(temporary, { force: true });
      if (!committed && backup) await rm(backup, { force: true });
    }
  });
}
async function pruneBackups(directory: string) {
  const names = (await readdir(directory)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - proposalLimits.backups))) await rm(join(directory, name), { force: true });
}
