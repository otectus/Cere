/**
 * W08: checks the installed Codex CLI against the app-server methods Cere's adapter uses, without a
 * model turn or any billed request. Codex writes its protocol schema from the binary itself; every
 * method string the broker sends, handles or answers must appear in it. Run after a Codex update:
 *
 *   node tools/check-codex-protocol.ts            # exit 1 lists methods the installed Codex lacks
 *
 * A pass shows the protocol names are still offered. It does not prove the payload semantics; the
 * fixture tests (tests/providers.test.ts) and a live check cover those.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = new URL('..', import.meta.url).pathname;
const families = /^(thread|turn|item|model|config|account|mcpServer|serverRequest|currentTime|remoteControl)\//;
const sources = (await readdir(join(root, 'broker'))).filter(name => name.endsWith('.ts'));
const used = new Set<string>();
for (const name of sources) for (const match of (await readFile(join(root, 'broker', name), 'utf8')).matchAll(/["'`]([a-zA-Z]+\/[a-zA-Z/]+)["'`]/g)) if (families.test(match[1])) used.add(match[1]);
const version = (await run('codex', ['--version'], { timeout: 10_000 })).stdout.trim();
const directory = await mkdtemp(join(tmpdir(), 'cere-codex-schema-'));
try {
  await run('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', directory], { timeout: 60_000 });
  const schema = (await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(name => readFile(join(directory, name), 'utf8')))).join('\n');
  const offered = new Set([...schema.matchAll(/"([a-zA-Z]+\/[a-zA-Z/]+)"/g)].map(match => match[1]));
  const missing = [...used].filter(method => !offered.has(method)).sort();
  console.log(JSON.stringify({ codex: version, methodsUsed: used.size, missing }));
  if (missing.length) process.exitCode = 1;
} finally { await rm(directory, { recursive: true, force: true }); }
