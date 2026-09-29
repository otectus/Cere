import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
export function paths() {
  const base = process.env.CERE_STATE_DIR;
  return {
    state: base ? resolve(base) : join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'cere'),
    config: base ? join(resolve(base), 'config') : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cere'),
    runtime: process.env.CERE_RUNTIME_DIR || join(process.env.XDG_RUNTIME_DIR || join(tmpdir(), `cere-${process.getuid?.()}`), 'cere'),
  };
}
export function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('Unsafe Cere directory: ' + path);
  chmodSync(path, 0o700);
}
export function socketPath() { return join(paths().runtime, 'broker.sock'); }
