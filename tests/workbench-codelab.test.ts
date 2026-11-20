import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { isolation } from '../broker/execution/runner.ts';
import { call, until, workbenchFixture } from './fixtures/workbench.ts';

const status = await isolation();
const opts = { skip: status.available ? false : `isolation unavailable here: ${status.problem}` };
async function lab(t: any, steps?: any[]) {
  const f = await workbenchFixture(t, steps);
  await f.core.updateSettings({ workbench: { codeLab: { enabled: true } } });
  const session = await f.core.create({ provider: 'ollama', model: 'text-tools:latest', cwd: f.project, capabilities: { analysis: true, images: true } });
  return { f, session };
}
async function input(f: any, sessionId: string, name: string, text: string) {
  const path = join(f.directory, name); await writeFile(path, text);
  return f.core.rpc('artifacts.import', { sessionId, path });
}
const ran = async (f: any, sessionId: string) => { await until(() => f.core.workbench.operations.list(sessionId).some((op: any) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(op.state)), 30000); return f.core.workbench.operations.list(sessionId)[0]; };

test('Code Lab is off until the user turns it on, and refuses to run unconfined', opts, async t => {
  const f = await workbenchFixture(t);
  const session = await f.core.create({ provider: 'ollama', model: 'text-tools:latest', cwd: f.project, capabilities: { analysis: true } });
  await assert.rejects(f.core.workbench.execution.run(session.id, { code: 'print(1)', origin: 'user', approval: 'user' }), /turned off/);
  assert.ok(!f.core.toolsFor(session.id).some(tool => tool.function.name === 'codelab_run'));
});

test('DA07 code cannot read host credentials, Cere’s data or the network, and sees no inherited environment', opts, async t => {
  const { f, session } = await lab(t);
  process.env.CERE_TEST_SECRET = 'leaked-if-visible';
  await mkdir(join(f.directory, 'fake-ssh'), { recursive: true }); await writeFile(join(f.directory, 'fake-ssh', 'id_ed25519'), 'PRIVATE KEY');
  const code = `import os, socket, json\nr = {}\nfor p in [${JSON.stringify(join(f.directory, 'fake-ssh'))}, ${JSON.stringify(f.state)}, ${JSON.stringify(f.project)}, os.path.expanduser('~'), '/run/user']:\n    try: r[p] = os.listdir(p)\n    except Exception as e: r[p] = type(e).__name__\ntry:\n    socket.create_connection(('1.1.1.1', 443), timeout=3); r['network'] = 'reached'\nexcept Exception as e: r['network'] = type(e).__name__\nr['secret'] = os.environ.get('CERE_TEST_SECRET', 'absent')\nr['keys'] = sorted(k for k in os.environ if 'KEY' in k or 'TOKEN' in k)\nprint(json.dumps(r))\n`;
  await f.core.workbench.execution.run(session.id, { code, origin: 'user', approval: 'user' });
  const operation = await ran(f, session.id);
  assert.equal(operation.state, 'completed', operation.error?.message);
  const report = JSON.parse(String(operation.details!.stdout).trim());
  for (const path of [join(f.directory, 'fake-ssh'), f.state, f.project, '/run/user']) assert.match(String(report[path]), /Error/, path + ' must not be visible');
  assert.notEqual(report.network, 'reached'); assert.equal(report.secret, 'absent'); assert.deepEqual(report.keys, []);
  delete process.env.CERE_TEST_SECRET;
});

test('DA08 loops, process floods and output floods are stopped by enforced limits; cancelling is observable', opts, async t => {
  const { f, session } = await lab(t);
  await f.core.workbench.execution.run(session.id, { code: 'while True: pass', origin: 'user', approval: 'user', timeoutSeconds: 2 });
  let operation = await ran(f, session.id);
  assert.equal(operation.state, 'failed'); assert.match(operation.error!.message, /time limit/);
  await f.core.workbench.execution.run(session.id, { code: 'import sys\nfor i in range(5_000_000): sys.stdout.write("flood " * 20 + "\\n")', origin: 'user', approval: 'user', timeoutSeconds: 20 });
  operation = f.core.workbench.operations.list(session.id)[0];
  assert.equal(operation.details!.truncated, true); assert.ok(String(operation.details!.stdout).length <= 256 * 1024);
  // The run's children re-exec with a random marker, so a check finds only processes of this run.
  const marker = 'cere-run-' + crypto.randomUUID();
  const running = f.core.workbench.execution.run(session.id, { code: `import os, sys, time\nfor i in range(8):\n    if os.fork() == 0:\n        os.execv(sys.executable, [sys.executable, '-c', 'import time; time.sleep(120)', '${marker}'])\ntime.sleep(120)`, origin: 'user', approval: 'user', timeoutSeconds: 100 });
  await until(() => f.core.workbench.operations.list(session.id)[0].state === 'running' && f.core.workbench.operations.list(session.id)[0].details?.timeLimitSeconds === 100);
  const { execFileSync } = await import('node:child_process');
  const survivors = () => { try { return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  await until(() => survivors().split('\n').filter(Boolean).length >= 1, 10000);
  const id = f.core.workbench.operations.list(session.id)[0].id, started = Date.now();
  await f.core.rpc('operations.cancel', { id });
  await running.catch(() => {});
  assert.ok(Date.now() - started < 10000, 'cancellation is prompt');
  assert.equal(f.core.workbench.operations.get(id).state, 'cancelled');
  await until(() => survivors() === '', 5000).catch(() => {});
  assert.equal(survivors(), '', 'no process of the run survives');
  const limits = f.core.workbench.operations.get(id).details!.limits as any;
  assert.match(limits.memory, /enforced|address-space|not enforced/); assert.match(limits.processes, /enforced|not enforced/);
});

test('DA09 a chart is drawn from the selected data by stored code, and its provenance links both', opts, async t => {
  const { f, session } = await lab(t);
  const data = await input(f, session.id, 'sales.csv', 'month,sales\n1,10\n2,30\n3,20\n');
  await f.core.workbench.execution.run(session.id, { code: (await f.core.rpc('codelab.status', {})).recipes.find((r: any) => r.id === 'plot').code, inputs: [{ artifactId: data.artifactId, versionId: data.versionId }], purpose: 'Plot sales', origin: 'user', approval: 'user' });
  const operation = await ran(f, session.id);
  assert.equal(operation.state, 'completed', String(operation.details?.stderr)); assert.equal(operation.details!.exitCode, 0);
  assert.equal(operation.results.length, 1);
  const chart = f.core.workbench.artifacts.version(session.id, operation.results[0].artifactId);
  assert.equal(chart.kind, 'image'); assert.ok((await sharp((await f.core.workbench.artifacts.bytes(session.id, chart.artifactId)).data).metadata()).width! > 100);
  assert.deepEqual(chart.parents.map(parent => parent.relation).sort(), ['analysis-code', 'analysis-input']);
  assert.equal(chart.parents.find(parent => parent.relation === 'analysis-input')!.versionId, data.versionId);
  const code = chart.parents.find(parent => parent.relation === 'analysis-code')!;
  assert.match((await f.core.workbench.artifacts.bytes(session.id, code.artifactId, code.versionId)).data.toString(), /plt\.savefig/);
  assert.match(String(operation.details!.stdout), /Plotted 3 rows from sales\.csv/);
});

test('a model’s Code Lab run waits for review, then reports the exit status and files without claiming verification', opts, async t => {
  const { f, session } = await lab(t, [() => call('codelab_run', { code: 'open("/work/output/answer.txt","w").write(str(6*7)); print("done")', purpose: 'Compute the answer' }), () => ({ content: 'The run finished.' })]);
  await f.core.send({ id: session.id, text: 'Compute it' });
  await until(() => [...f.core.approvals.values()].some(item => item.value.kind === 'execution'));
  const approval = [...f.core.approvals.values()].find(item => item.value.kind === 'execution')!.value;
  assert.match(approval.detail, /6\*7/); assert.match(approval.detail, /no network/);
  f.core.answer({ id: approval.id, choice: 'allow' });
  await f.finished(session.id);
  const result = f.toolResults().find((r: any) => r.name === 'codelab_run')!.value;
  assert.equal(result.status, 'completed'); assert.match(result.summary, /not proof that its conclusion is right/);
  assert.equal(result.data.exitCode, 0); assert.equal(result.artifacts.length, 1);
  assert.equal((await f.core.workbench.artifacts.bytes(session.id, result.artifacts[0].artifactId)).data.toString(), '42');
});

test('closing Cere during a Code Lab run stops it and still records the run as interrupted', opts, async t => {
  const f = await workbenchFixture(t);
  const { session } = await f.session(null as any);
  await f.core.updateSettings({ workbench: { codeLab: { enabled: true } } });
  assert.equal(await f.core.rpc('codelab.run', { sessionId: session.id, code: 'import time\ntime.sleep(60)\n', purpose: 'Slow run' }), true);
  await until(() => f.core.workbench.operations.list(session.id).some(op => op.state === 'running'));
  const id = f.core.workbench.operations.list(session.id)[0].id;
  await f.core.close();
  const { Store } = await import('../broker/store.ts');
  const reopened = new Store(f.state);
  try {
    const row: any = reopened.db.prepare('SELECT state FROM operations WHERE id=?').get(id);
    assert.equal(row.state, 'interrupted', 'the run was stopped and its outcome written before the database closed');
  } finally { reopened.close(); }
});
