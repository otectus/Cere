/**
 * W16: checks that an installed Cere tree is complete against the source it was built from: every
 * tracked broker, QML, asset, protocol and shell-hook file, each runtime npm dependency, the native
 * modules, the bundled speech engine, launchers, the desktop entry and the user service unit, and a
 * build identity naming the expected commit. Stage an install without touching the session with
 *
 *   python3 tools/install-user.py --prefix /tmp/cere-stage
 *   node tools/check-install.ts /tmp/cere-stage [expected-commit]
 *
 * Exit 1 lists what is missing or different.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [prefixArgument, expectedCommit] = process.argv.slice(2);
if (!prefixArgument) { console.error('Usage: check-install.ts <prefix> [expected-commit]'); process.exit(2); }
const prefix = resolve(prefixArgument), root = new URL('..', import.meta.url).pathname, share = join(prefix, 'share/cere');
const tracked = (dir: string) => execFileSync('git', ['-C', root, 'ls-files', dir], { encoding: 'utf8' }).split('\n').filter(Boolean);
const problems: string[] = [];
const need = (path: string, what: string) => { if (!existsSync(path)) problems.push(`missing ${what}: ${path.slice(prefix.length + 1)}`); };
const executable = (path: string) => { need(path, 'program'); try { accessSync(path, constants.X_OK); } catch { if (existsSync(path)) problems.push(`not executable: ${path.slice(prefix.length + 1)}`); } };

for (const dir of ['broker', 'qml', 'assets', 'protocol', 'shell']) for (const file of tracked(dir)) {
  const installed = join(share, file);
  need(installed, dir + ' file');
  if (existsSync(installed) && statSync(installed).size !== statSync(join(root, file)).size) problems.push(`differs from source: share/cere/${file}`);
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const name of Object.keys(manifest.dependencies || {})) need(join(share, 'node_modules', name, 'package.json'), 'runtime package');
for (const module of ['cere-peercred.node', 'cere-telemetry.node']) need(join(share, 'native', module), 'native module');
const tts = join(share, 'tts');
if (!existsSync(tts) || !readdirSync(tts, { recursive: true }).some(entry => String(entry).endsWith('.onnx'))) problems.push('missing speech resources: share/cere/tts has no voice model');
for (const program of ['bin/cere', 'bin/cere-report', 'bin/cere-run', 'bin/cere-telemetry-hooks', 'lib/cere/cere']) executable(join(prefix, program));
need(join(prefix, 'share/applications/cere.desktop'), 'desktop entry');
need(join(prefix, 'lib/systemd/user/cere-broker.service'), 'user service unit');
const buildInfo = join(share, 'build-info.json');
need(buildInfo, 'build identity');
if (existsSync(buildInfo)) {
  const identity = JSON.parse(readFileSync(buildInfo, 'utf8'));
  if (identity.version !== manifest.version) problems.push(`build identity names version ${identity.version}, source is ${manifest.version}`);
  if (expectedCommit && identity.commit !== expectedCommit) problems.push(`build identity names commit ${identity.commit}, expected ${expectedCommit}`);
  if (identity.dirty) problems.push('build identity says the source tree was modified when it was built');
}
console.log(JSON.stringify({ prefix, checked: 'broker, qml, assets, protocol, shell, node_modules, native, tts, programs, desktop entry, service unit, build identity', problems }, null, 1));
if (problems.length) process.exitCode = 1;
