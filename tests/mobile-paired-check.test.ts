import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

test('paired evidence hashes the installed APKs and tears down after a report write fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'adb'), evidence = join(dir, 'e'), tmp = join(dir, 't'), calls = join(dir, 'calls');
  await mkdir(evidence); await mkdir(tmp);
  await mkdir(join(evidence, 'harness.log')); // Last record cannot be written.
  await writeFile(fake, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs'), args = process.argv.slice(2), cmd = args.join(' ');",
    "fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');",
    "if (cmd.includes('getprop')) console.log('36');",
    "else if (cmd.includes('dumpsys package')) console.log('versionName=fixture versionCode=1');",
    "else if (cmd.includes('pm path')) { const path = '/data/app/' + args.at(-1); console.log('package:' + path + '/base.apk\\npackage:' + path + '/split.apk'); }",
    "else if (cmd.includes('sha256sum')) console.log((args.at(-1).endsWith('/split.apk') ? 'b' : 'a').repeat(64) + '  ' + args.at(-1));",
    "else if (cmd.includes('pm clear')) process.exit(1);",
  ].join('\n'), { mode: 0o700 });
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, TMPDIR: tmp, FIXTURE_LOG: calls };
  await assert.rejects(promisify(execFile)(process.execPath, [resolve('tools/mobile-paired-check.ts'), '--package', 'fixture.mobile', '--evidence', evidence], { env, timeout: 45_000 }), (error: any) => {
    assert.match(error.stderr, /Could not write paired test evidence/);
    return true;
  });
  const report = JSON.parse(await readFile(join(evidence, 'summary.json'), 'utf8'));
  assert.equal(report.apkSha256, 'a'.repeat(64));
  assert.equal(report.testApkSha256, 'a'.repeat(64));
  assert.deepEqual(report.installedApks.instrumentation.map((part: any) => part.path),
    ['/data/app/fixture.mobile.test/base.apk', '/data/app/fixture.mobile.test/split.apk']);
  assert.equal(report.installedApks.application[1].sha256, 'b'.repeat(64));
  const history: string[][] = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const added = history.find(args => args[1] === '--no-rebind')!;
  assert.ok(added);
  assert.ok(history.some(args => args[1] === '--remove' && args[2] === added[2]));
  assert.equal(history.filter(args => args.includes('clear')).length, 1, 'cleanup does not clear an application when setup never completed');
  assert.deepEqual((await readdir(tmp)).filter(name => name.startsWith('cere-paired-')), []);
});
