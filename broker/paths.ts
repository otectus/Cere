import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdirSync, chmodSync, lstatSync, readlinkSync } from 'node:fs';
export function paths() {
  const base = process.env.CERE_STATE_DIR;
  return {
    state: base ? resolve(base) : join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'cere'),
    config: base ? join(resolve(base), 'config') : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cere'),
    runtime: process.env.CERE_RUNTIME_DIR ? resolve(process.env.CERE_RUNTIME_DIR)
      : join(process.env.XDG_RUNTIME_DIR || join(tmpdir(), `cere-${process.getuid?.()}`), 'cere'),
  };
}
function unsafe(path: string, reason: string): never { throw new Error(`Unsafe Cere directory (${reason}): ${path}`); }
/**
 * Resolves an existing absolute path component by component. Every component must be
 * owned by root or the expected user, and every directory that others can write must
 * be sticky, so no other user can rename a component away and substitute their own.
 * Symlinks are followed only when they are equally trustworthy; inside a writable
 * (sticky) directory, a symlink is refused outright.
 */
function trustedChain(path: string, uid: number): string {
  let current = '/', hops = 0;
  const parts = path.split('/').filter(Boolean);
  while (parts.length) {
    const name = parts.shift()!, child = join(current, name);
    if (name === '..') { current = dirname(current); continue; }
    if (name === '.') continue;
    const parent = lstatSync(current), info = lstatSync(child);
    const shared = (parent.mode & 0o022) !== 0;
    if (shared && (parent.mode & 0o1000) === 0) unsafe(current, 'writable by other users');
    if (info.uid !== 0 && info.uid !== uid) unsafe(child, 'owned by another user');
    if (info.isSymbolicLink()) {
      if (shared) unsafe(child, 'symbolic link in a shared directory');
      if (++hops > 32) unsafe(child, 'symbolic link loop');
      parts.unshift(...resolve(current, readlinkSync(child)).split('/').filter(Boolean));
      current = '/';
      continue;
    }
    if (!info.isDirectory()) unsafe(child, 'not a directory');
    current = child;
  }
  return current;
}
/**
 * Creates and verifies an owner-private directory. Missing components are created
 * one at a time with mode 0700 and verified; an existing foreign-owned or symlinked
 * component is rejected without modification. The directory itself must be a real
 * directory owned by the current user, and is restricted to 0700.
 */
export function privateDir(path: string, uid = process.getuid!()) {
  const target = resolve(path), missing: string[] = [];
  let existing = target;
  for (;;) {
    try { lstatSync(existing); break; }
    catch (error: any) { if (error.code !== 'ENOENT' || existing === dirname(existing)) throw error; missing.unshift(basename(existing)); existing = dirname(existing); }
  }
  let real = trustedChain(existing, uid);
  for (const name of missing) {
    // Refuse before creating anything inside a directory other users could rename entries in.
    const parent = lstatSync(real);
    if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) unsafe(real, 'writable by other users');
    try { mkdirSync(join(real, name), { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(join(real, name));
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) unsafe(join(real, name), 'replaced while it was being created');
    real = trustedChain(join(real, name), uid);
  }
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) unsafe(target, 'not a private directory owned by this user');
  chmodSync(target, 0o700);
  return real;
}
export function socketPath() { return join(paths().runtime, 'broker.sock'); }
