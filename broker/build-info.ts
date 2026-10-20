import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The desktop build this broker runs. An installed build carries build-info.json (written by the
 * build, see tools/build-info.mjs); a source checkout reads its own Git HEAD without running git.
 * `dirty` is null when it cannot be known. Never invented: unknown parts stay null.
 */
export type BuildIdentity = { version: string; commit: string | null; dirty: boolean | null; source: 'installed' | 'checkout' | 'unknown' };
let cached: BuildIdentity | undefined;
export function buildIdentity(root = join(new URL('.', import.meta.url).pathname, '..')): BuildIdentity {
  if (cached) return cached;
  const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  const version = (() => { try { return String(JSON.parse(read(join(root, 'package.json')) || '{}').version || 'unknown'); } catch { return 'unknown'; } })();
  try {
    const info = JSON.parse(read(join(root, 'build-info.json')) || 'null');
    if (info && typeof info.version === 'string') return cached = { version: info.version, commit: typeof info.commit === 'string' && /^[0-9a-f]{40}$/.test(info.commit) ? info.commit : null, dirty: typeof info.dirty === 'boolean' ? info.dirty : null, source: 'installed' };
  } catch {}
  const git = join(root, '.git');
  if (existsSync(git)) {
    const head = read(join(git, 'HEAD'))?.trim() || '';
    let commit: string | null = /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.startsWith('ref: ') ? head.slice(5) : '';
    if (ref) commit = read(join(git, ref))?.trim() || (read(join(git, 'packed-refs')) || '').split('\n').find(line => line.endsWith(' ' + ref))?.split(' ')[0] || null;
    return cached = { version, commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null, dirty: null, source: 'checkout' };
  }
  return cached = { version, commit: null, dirty: null, source: 'unknown' };
}
/** The welcome's build label: version, short commit (with +dirty), and the mobile protocol family. */
export function brokerBuildLabel(identity = buildIdentity()) {
  const commit = identity.commit ? '+' + identity.commit.slice(0, 12) + (identity.dirty ? '.dirty' : '') : '';
  return `${identity.version}${commit}/mobile-v1`;
}
