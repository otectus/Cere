/**
 * Reading a workspace: listings, metadata, filename discovery, search and line-numbered excerpts. All
 * filesystem access goes through cere-workspacefs beneath the root. Results are bounded, say when and
 * why they were bounded, and carry a continuation cursor instead of silently dropping the rest.
 *
 * Names and contents are untrusted data. They are returned as plain strings for plain-text rendering;
 * nothing here interprets them as markup, commands or paths outside the root.
 */
import { spawn } from 'node:child_process';
import { workspaceLimits } from '../tools/contracts.ts';
import { b64, rootArgs, run, WorkspaceError, type HelperStat, type RootHandle } from './fsclient.ts';
import { baseName, credentialName, credentialPatterns, excludedDirectories, excludedInside, hiddenPath } from './policy.ts';
import type { WorkspaceRoot } from './roots.ts';

const vcsDirectories = ['.git', '.hg', '.svn', '.jj'];
/** Version-control internals can hold credentials (remote URLs with tokens); they are never read for a model. */
export const vcsInternal = (rel: string) => rel.split('/').some(part => vcsDirectories.includes(part));
const handle = (root: WorkspaceRoot): RootHandle => ({ path: root.path, dev: root.dev, ino: root.ino });
const decodePath = (entry: any, key: 'name' | 'path') => entry.invalidName ? null : String(entry[key]);
const cursorOf = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new WorkspaceError('invalid-cursor', 'Use the cursor returned by the previous page');
  return value;
};
export type EntryInfo = { name: string; path: string; type: HelperStat['type']; size: number; modified: number; hidden?: boolean; excluded?: boolean; credential?: boolean; links?: number };
function describe(entry: any, path: string): EntryInfo {
  const name = baseName(path);
  return { name, path, type: entry.type, size: entry.size, modified: entry.mtimeMs, ...(name.startsWith('.') ? { hidden: true } : {}),
    ...(entry.type === 'directory' && excludedDirectories.includes(name) ? { excluded: true } : {}), ...(entry.type === 'file' && credentialName(name) ? { credential: true } : {}),
    ...(entry.type === 'file' && entry.nlink > 1 ? { links: entry.nlink } : {}) };
}
/** Refuses paths the model may never read: Cere's state and other private locations, credentials and VCS internals. */
export function readable(root: WorkspaceRoot, rel: string) {
  if (excludedInside(root.path).some(location => rel === location || rel.startsWith(location + '/'))) throw new WorkspaceError('private', 'That location is private (credentials or Cere’s own state) and is not available to models');
  if (credentialName(baseName(rel))) throw new WorkspaceError('credential', `${baseName(rel)} looks like a credential or key file. Cere does not read it for a model; open it yourself if you need to.`);
  if (vcsInternal(rel)) throw new WorkspaceError('vcs-internal', 'Version-control internals are not read for a model; use the Git tools or open the file yourself.');
}

export async function list(root: WorkspaceRoot, rel: string, p: { cursor?: unknown; limit?: unknown; hidden?: boolean } = {}, signal?: AbortSignal) {
  const limit = p.limit === undefined ? workspaceLimits.listPage : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > workspaceLimits.listPageMax) throw new WorkspaceError('invalid-limit', `List 1–${workspaceLimits.listPageMax} entries at a time`);
  const cursor = cursorOf(p.cursor), hidden = p.hidden ?? root.policy.hidden;
  const value = await run(['list', ...rootArgs(handle(root)), rel || '.', '--limit', String(limit), ...(hidden ? ['--hidden'] : []), ...(cursor ? ['--after', cursor] : [])], { signal, timeoutMs: 15_000 });
  const privateHere = excludedInside(root.path);
  let unreadableNames = 0;
  const entries = value.entries.flatMap((entry: any) => {
    const name = decodePath(entry, 'name');
    if (name === null) { unreadableNames++; return []; }
    const path = rel ? rel + '/' + name : name;
    if (privateHere.includes(path)) return [];
    return [describe(entry, path)];
  });
  return { path: rel, entries, total: value.total, hiddenSkipped: value.hidden, ...(unreadableNames ? { unreadableNames } : {}), ...(value.next ? { nextCursor: value.next } : {}) };
}

export async function statPath(root: WorkspaceRoot, rel: string, signal?: AbortSignal) {
  const value = await run(['stat', ...rootArgs(handle(root)), rel || '.', '--max-bytes', String(workspaceLimits.readableFileBytes)], { signal, timeoutMs: 15_000 });
  return { ...describe(value, rel), ino: String(value.ino), mode: (value.mode & 0o777).toString(8), ...(value.sha256 ? { version: 'sha256:' + value.sha256 } : value.type === 'file' ? { versionNote: 'Too large to hash for a version' } : {}),
    ...(value.nlink > 1 && value.type === 'file' ? { linkNote: `This file has ${value.nlink} hard links. Cere replaces this name only; other links keep the old content.` } : {}) };
}

const globFor = (pattern: string) => /[*?[]/.test(pattern) ? pattern : `*${pattern}*`;
export async function find(root: WorkspaceRoot, rel: string, pattern: string, p: { cursor?: unknown; limit?: number } = {}, signal?: AbortSignal) {
  if (!pattern || pattern.length > 200 || /[\x00-\x1f/]/.test(pattern)) throw new WorkspaceError('invalid-pattern', 'Use a filename pattern of 1–200 characters without slashes');
  const cursor = cursorOf(p.cursor), limit = Math.min(p.limit || 100, 200);
  const value = await run(['walk', ...rootArgs(handle(root)), rel || '.', '--glob', b64(globFor(pattern)), '--icase', '--limit', String(limit),
    '--max-entries', String(workspaceLimits.searchCandidates), '--max-depth', String(workspaceLimits.searchDepth), '--deadline-ms', String(workspaceLimits.searchMs),
    ...(root.policy.hidden ? ['--hidden'] : []), ...excludedDirectories.flatMap(name => ['--exclude', name]), ...credentialPatterns.flatMap(item => ['--deny', item]),
    ...excludedInside(root.path).flatMap(location => ['--exclude-path', b64(location)]), ...(cursor ? ['--after', cursor] : [])], { signal, timeoutMs: workspaceLimits.searchMs + 5000 });
  const matches = value.entries.flatMap((entry: any) => { const path = decodePath(entry, 'path'); return path === null ? [] : [describe(entry, rel ? rel + '/' + path : path)]; });
  return { matches, visited: value.visited, complete: !value.stopped, ...(value.stopped ? { stoppedBecause: stopReason(value.stopped) } : {}), ...(value.next ? { nextCursor: value.next } : {}) };
}
const stopReason = (code: string) => ({ deadline: 'the 10-second search time limit', entries: `the ${workspaceLimits.searchCandidates.toLocaleString('en-US')}-entry traversal limit`, depth: `the folder depth limit of ${workspaceLimits.searchDepth}`, matches: 'the match limit for one page', limit: 'the page size' } as Record<string, string>)[code] || code;

export type SearchMatch = { path: string; version: string; matches: { line: number; text: string; clipped?: boolean }[] };
export async function search(root: WorkspaceRoot, rel: string, query: string, p: { mode?: 'literal' | 'regex'; caseSensitive?: boolean; cursor?: unknown; limit?: number } = {}, signal?: AbortSignal) {
  if (typeof query !== 'string' || !query || query.length > 1000 || query.includes('\0')) throw new WorkspaceError('invalid-query', 'Search for 1–1,000 characters');
  const limit = Math.min(p.limit || workspaceLimits.searchPage, workspaceLimits.searchPageMax), cursor = cursorOf(p.cursor);
  if (p.mode === 'regex') return regexSearch(root, rel, query, limit, p.caseSensitive === true, signal);
  const value = await run(['search', ...rootArgs(handle(root)), rel || '.', b64(query), ...(p.caseSensitive ? [] : ['--icase']), '--max-matches', String(limit),
    '--max-entries', String(workspaceLimits.searchCandidates), '--max-depth', String(workspaceLimits.searchDepth), '--deadline-ms', String(workspaceLimits.searchMs),
    '--max-file-bytes', String(workspaceLimits.searchFileBytes), ...(root.policy.hidden ? ['--hidden'] : []), ...excludedDirectories.flatMap(name => ['--exclude', name]),
    ...credentialPatterns.flatMap(item => ['--deny', item]), ...excludedInside(root.path).flatMap(location => ['--exclude-path', b64(location)]), ...(cursor ? ['--after', cursor] : [])],
    { signal, timeoutMs: workspaceLimits.searchMs + 5000 });
  const files: SearchMatch[] = value.files.flatMap((file: any) => { const path = decodePath(file, 'path'); return path === null ? [] : [{ path: rel ? rel + '/' + path : path, version: 'sha256:' + file.sha256, matches: file.matches }]; });
  return { mode: 'literal' as const, caseSensitive: p.caseSensitive === true, files, searchedFiles: value.searched, skippedLarge: value.skippedLarge, skippedBinary: value.skippedBinary,
    complete: !value.stopped, ...(value.stopped ? { stoppedBecause: stopReason(value.stopped) } : {}), ...(value.next ? { nextCursor: value.next } : {}),
    note: `Searched regular text files up to ${workspaceLimits.searchFileBytes / 1024 / 1024} MiB; ${excludedDirectories.slice(0, 6).join(', ')} and similar folders${root.policy.hidden ? '' : ', hidden files'} and credential files are skipped.` };
}

/**
 * Regular expressions run in ripgrep, whose engine is linear-time, in its own killable process with a
 * deadline; never in the broker's event loop. ripgrep only finds candidates: every excerpt released is
 * read again through the confined helper, so a link swapped in during the search cannot leak content.
 */
async function regexSearch(root: WorkspaceRoot, rel: string, pattern: string, limit: number, caseSensitive: boolean, signal?: AbortSignal) {
  const args = ['--json', '--no-config', '--no-follow', '--no-ignore', '--max-filesize', String(workspaceLimits.searchFileBytes), '--max-depth', String(workspaceLimits.searchDepth),
    '--max-count', '20', ...(caseSensitive ? [] : ['--ignore-case']), ...(root.policy.hidden ? ['--hidden'] : []),
    ...excludedDirectories.flatMap(name => ['--glob', `!${name}/`]), ...credentialPatterns.flatMap(item => ['--glob', `!${item}`]), ...excludedInside(root.path).flatMap(location => ['--glob', `!/${location}`]),
    '--regexp', pattern, '--', rel || '.'];
  const candidates = new Map<string, Set<number>>(); let stopped = '', count = 0;
  await new Promise<void>((resolve, reject) => {
    let child;
    try { child = spawn('rg', args, { cwd: root.path, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } }); }
    catch { return reject(new WorkspaceError('unavailable', 'Regular-expression search needs ripgrep (rg), which is not installed. Use literal search.')); }
    let buffer = '', errors = '';
    const timer = setTimeout(() => { stopped = 'deadline'; child.kill('SIGKILL'); }, workspaceLimits.searchMs);
    const abort = () => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error: any) => { clearTimeout(timer); reject(error?.code === 'ENOENT' ? new WorkspaceError('unavailable', 'Regular-expression search needs ripgrep (rg), which is not installed. Use literal search.') : error); });
    child.stderr.on('data', (chunk: Buffer) => { if (errors.length < 1000) errors += chunk.toString(); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event: any; try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== 'match' || typeof event.data?.path?.text !== 'string' || !Number.isInteger(event.data.line_number)) continue;
        const path = event.data.path.text.replace(/^\.\//, '');
        if (!candidates.has(path) && candidates.size >= 50) { stopped ||= 'matches'; child.kill('SIGKILL'); break; }
        if (count >= limit) { stopped ||= 'matches'; child.kill('SIGKILL'); break; }
        (candidates.get(path) || candidates.set(path, new Set()).get(path)!).add(event.data.line_number); count++;
      }
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      if (code === 2 && !stopped && !candidates.size) return reject(new WorkspaceError('invalid-query', 'ripgrep could not use that pattern: ' + errors.trim().split('\n').at(-1)?.slice(0, 200)));
      resolve();
    });
  });
  const files: SearchMatch[] = [];
  for (const [path, lines] of candidates) {
    try { readable(root, path); } catch { continue; }
    let excerpt;
    try { excerpt = await readText(root, path, signal); } catch { continue; }
    if (excerpt.binary) continue;
    files.push({ path, version: excerpt.version, matches: [...lines].sort((a, b) => a - b).filter(line => line <= excerpt.lines.length).map(line => ({ line, text: excerpt.lines[line - 1].slice(0, 400), ...(excerpt.lines[line - 1].length > 400 ? { clipped: true } : {}) })) });
  }
  return { mode: 'regex' as const, caseSensitive, files, complete: !stopped, ...(stopped ? { stoppedBecause: stopReason(stopped) } : {}),
    note: 'Line numbers come from ripgrep; each excerpt was read again through Cere’s confined file access.' };
}

/** A text file decoded strictly as UTF-8, split into lines, with its exact version. */
export async function readText(root: WorkspaceRoot, rel: string, signal?: AbortSignal) {
  const value = await run(['read', ...rootArgs(handle(root)), rel, '--max-bytes', String(workspaceLimits.readableFileBytes)], { signal, timeoutMs: 30_000, maxOutput: workspaceLimits.readableFileBytes * 2 });
  const bytes = Buffer.from(value.data, 'base64'), version = 'sha256:' + value.sha256;
  const head = bytes.subarray(0, 65536);
  if (head.includes(0)) return { binary: true as const, version, size: value.size, kind: sniff(bytes), lines: [] as string[], bytes };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { binary: true as const, version, size: value.size, kind: 'non-UTF-8 text or binary', lines: [] as string[], bytes }; }
  const bom = text.startsWith('﻿'); if (bom) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/\n/g) || []).length - crlf;
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (!text.length) lines.length = 0;
  return { binary: false as const, version, size: value.size, text, lines, bom, endsWithNewline, newline: crlf && lf ? 'mixed' as const : crlf ? 'crlf' as const : 'lf' as const, mode: value.mode, nlink: value.nlink, bytes };
}
export function sniff(bytes: Buffer) {
  const ascii = bytes.subarray(0, 12).toString('latin1');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'PNG image';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'JPEG image';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'WebP image';
  if (ascii.startsWith('GIF8')) return 'GIF image';
  if (ascii.startsWith('%PDF')) return 'PDF document';
  if (ascii.startsWith('PK\x03\x04')) return 'ZIP archive (or DOCX/XLSX/ODF document)';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip archive';
  if (ascii.startsWith('\x7fELF')) return 'executable program';
  return 'binary data';
}

/** Line-numbered excerpt: 300 lines or 64 KiB by default, whichever comes first, with an explicit continuation. */
export async function readExcerpt(root: WorkspaceRoot, rel: string, p: { startLine?: number; lineCount?: number; expectedVersion?: string } = {}, signal?: AbortSignal) {
  readable(root, rel);
  const file = await readText(root, rel, signal);
  if (file.binary) return { path: rel, version: file.version, size: file.size, binary: true, kind: file.kind, note: 'This is not UTF-8 text. Use files_extract for documents, or images_inspect for images.' };
  const total = file.lines.length, start = Math.max(1, Math.min(p.startLine || 1, Math.max(1, total)));
  const wanted = Math.min(p.lineCount || workspaceLimits.readLines, workspaceLimits.readLines);
  const out: string[] = []; let bytes = 0, end = start - 1;
  for (let line = start; line <= total && out.length < wanted; line++) {
    const row = `${line}| ${file.lines[line - 1]}`, size = Buffer.byteLength(row) + 1;
    if (bytes + size > workspaceLimits.readBytes && out.length) break;
    out.push(size > workspaceLimits.readBytes ? row.slice(0, workspaceLimits.readBytes) + ' [line clipped]' : row); bytes += size; end = line;
  }
  return { path: rel, version: file.version, ...(p.expectedVersion && p.expectedVersion !== file.version ? { versionChanged: true, note: 'The file changed since the version you expected.' } : {}),
    totalLines: total, startLine: total ? start : 0, endLine: end, newline: file.newline, endsWithNewline: file.endsWithNewline, ...(file.bom ? { byteOrderMark: true } : {}),
    text: out.join('\n'), ...(end < total ? { truncated: true, nextStartLine: end + 1 } : {}), bytesReleased: bytes };
}
export const isHidden = hiddenPath;
