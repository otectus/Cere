import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

test('installer desktop entries launch the intended program from a prefix containing Exec metacharacters', async t => {
  if (spawnSync('gio', ['version']).error) return t.skip('requires GIO desktop entry support');
  const base = await mkdtemp(join(tmpdir(), 'cere-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'checkout'), commands = join(base, 'commands');
  const prefix = join(base, 'space "quote" $cash %code back\\slash');
  for (const dir of [commands, join(repo, 'tools'), join(prefix, 'bin'), join(prefix, 'share/applications'),
    join(prefix, 'share/kio/servicemenus'), join(prefix, 'lib/systemd/user')]) await mkdir(dir, { recursive: true });
  await cp('tools/install-user.py', join(repo, 'tools/install-user.py'));
  await cp('packaging', join(repo, 'packaging'), { recursive: true });
  await writeFile(join(commands, 'cmake'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, HOME: base, PATH: commands + ':' + process.env.PATH, CERE_TEST_ARGV: join(base, 'arguments') };
  const install = spawnSync('python3', [join(repo, 'tools/install-user.py'), '--prefix', prefix], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const launcher = join(prefix, 'bin/cere');
  await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "$CERE_TEST_ARGV"\n');
  await chmod(launcher, 0o755);
  const launch = spawnSync('gio', ['launch', join(prefix, 'share/applications/cere.desktop')], { env, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  let received = '';
  for (let attempt = 0; attempt < 100 && !received; attempt++) {
    received = await readFile(env.CERE_TEST_ARGV, 'utf8').catch(() => '');
    if (!received) await sleep(10);
  }
  assert.equal(received, launcher + '\n--show\n');
  const unit = await readFile(join(prefix, 'share/systemd/user/cere-broker.service'), 'utf8');
  assert.ok(unit.includes('$$cash %%code'));
});
