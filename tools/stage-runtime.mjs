// Package only locked production dependencies; installed Cere has no npm step.
import { readFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2]);
if (output === root || !output.endsWith('/runtime')) throw new Error('Expected a build/runtime staging directory');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const packages = Object.entries(lock.packages).filter(([name, metadata]) => name.startsWith('node_modules/') && !metadata.dev && !metadata.devOptional
  && (!metadata.optional || existsSync(join(root,name,'package.json'))));
for (const [name] of packages) if (!existsSync(join(root,name,'package.json'))) throw new Error('Missing runtime dependency. Run npm ci before building Cere.');
rmSync(output, { recursive: true, force: true });
for (const [name] of packages) { mkdirSync(dirname(join(output,name)), { recursive: true }); cpSync(join(root,name), join(output,name), { recursive: true }); }
