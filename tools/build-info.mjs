#!/usr/bin/env node
// Writes the identity of the desktop build being made: the package version and the source commit,
// marked dirty when tracked files differ from it. The installed broker reports this in the mobile
// welcome and in diagnostics, so evidence and release claims name the exact build that was tested.
//   node tools/build-info.mjs OUTPUT.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const output = process.argv[2];
if (!output) { console.error('Usage: build-info.mjs OUTPUT.json'); process.exit(2); }
const root = resolve(new URL('..', import.meta.url).pathname);
const git = (...args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const commit = git('rev-parse', 'HEAD');
const info = {
  schema: 1,
  version: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  commit,
  dirty: commit ? git('status', '--porcelain', '--untracked-files=no') !== '' : null,
};
const text = JSON.stringify(info) + '\n';
mkdirSync(dirname(resolve(output)), { recursive: true });
// Unchanged identity keeps the file's timestamp, so the build does not reinstall it needlessly.
let previous = '';
try { previous = readFileSync(output, 'utf8'); } catch {}
if (previous !== text) writeFileSync(output, text);
