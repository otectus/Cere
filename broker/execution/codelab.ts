/**
 * Code Lab, command runs and read-only Git, all through the one execution boundary (runner.ts).
 *
 * A Code Lab run is stateless Python with the selected artifact versions mounted read-only at
 * /work/input and a size-limited /work/output whose files become artifacts. Its code is kept as an
 * artifact too, so a chart traces back to the exact data and code that drew it. Exiting with status 0
 * means the run finished; it is never presented as verification of a conclusion.
 *
 * A command run is a reviewed argument vector in a workspace folder that allows commands, with that
 * folder writable and everything else hidden. Git tools run read-only with hooks, external diff
 * programs, text conversion and pagers turned off.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../paths.ts';
import type { Workbench } from '../workbench.ts';
import type { ArtifactRef } from '../tools/contracts.ts';
import { safeName } from '../artifacts/store.ts';
import { isolation, pythonRuntime, sandboxed, type SandboxResult } from './runner.ts';
import type { WorkspaceRoot } from '../workspace/roots.ts';
import { rootArgs, run as fs } from '../workspace/fsclient.ts';

export const labLimits = { codeBytes: 64 * 1024, inputs: 8, argv: 64, argBytes: 4096, commandWallMs: 30 * 60_000, gitOutput: 64 * 1024 };
export type ExecutionGrant = { id: string; sessionId: string; expires: number; maxRuns: number; usedRuns: number };

/** Built-in analysis recipes: real code over real inputs, producing real files. */
export const recipes: Record<string, { label: string; code: string }> = {
  summarize: { label: 'Summarize CSV columns and missing values', code: `import csv, glob, json, os\nfor path in sorted(glob.glob('/work/input/*.csv')):\n    with open(path, newline='', encoding='utf-8') as f:\n        rows = list(csv.DictReader(f))\n    columns = rows[0].keys() if rows else []\n    summary = {c: {'missing': sum(1 for r in rows if not (r.get(c) or '').strip()), 'distinct': len({r.get(c) for r in rows})} for c in columns}\n    print(os.path.basename(path), len(rows), 'rows')\n    print(json.dumps(summary, indent=2))\n    with open('/work/output/' + os.path.basename(path) + '.summary.json', 'w') as out: json.dump({'rows': len(rows), 'columns': summary}, out, indent=2)\n` },
  plot: { label: 'Plot two numeric columns', code: `import csv, glob\nimport matplotlib.pyplot as plt\npath = sorted(glob.glob('/work/input/*.csv'))[0]\nwith open(path, newline='', encoding='utf-8') as f:\n    rows = list(csv.DictReader(f))\nx_name, y_name = list(rows[0].keys())[:2]  # change these to the columns you want\nx = [float(r[x_name]) for r in rows]; y = [float(r[y_name]) for r in rows]\nplt.figure(figsize=(8, 4.5)); plt.plot(x, y, marker='o')\nplt.xlabel(x_name); plt.ylabel(y_name); plt.title(f'{y_name} by {x_name}'); plt.grid(alpha=.3)\nplt.tight_layout(); plt.savefig('/work/output/plot.png', dpi=150)\nprint('Plotted', len(rows), 'rows from', path.split('/')[-1])\n` },
  compare: { label: 'Compare two datasets (row counts and changed values)', code: `import csv, glob\npaths = sorted(glob.glob('/work/input/*.csv'))[:2]\ndata = []\nfor path in paths:\n    with open(path, newline='', encoding='utf-8') as f: data.append(list(csv.reader(f)))\nprint('Rows:', [len(d) for d in data])\nchanged = [(i, a, b) for i, (a, b) in enumerate(zip(*data)) if a != b]\nprint('Changed rows:', len(changed))\nwith open('/work/output/changes.csv', 'w', newline='') as out:\n    w = csv.writer(out); w.writerow(['row', 'before', 'after'])\n    for i, a, b in changed: w.writerow([i, '|'.join(a), '|'.join(b)])\n` },
  report: { label: 'Markdown report with a chart and source table', code: `import csv, glob\nimport matplotlib.pyplot as plt\npath = sorted(glob.glob('/work/input/*.csv'))[0]\nwith open(path, newline='', encoding='utf-8') as f: rows = list(csv.reader(f))\nheader, body = rows[0], rows[1:]\nvalues = [float(r[1]) for r in body]\nplt.figure(figsize=(7, 4)); plt.bar([r[0] for r in body], values); plt.tight_layout(); plt.savefig('/work/output/chart.png', dpi=150)\nlines = ['# Report', '', f'Source: {path.split("/")[-1]} ({len(body)} rows)', '', '![chart](chart.png)', '', '| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)]\nlines += ['| ' + ' | '.join(r) + ' |' for r in body[:200]]\nopen('/work/output/report.md', 'w').write('\\n'.join(lines) + '\\n')\n` },
  export: { label: 'Export selected rows to CSV', code: `import csv, glob\npath = sorted(glob.glob('/work/input/*.csv'))[0]\nwith open(path, newline='', encoding='utf-8') as f: rows = list(csv.DictReader(f))\nkeep = [r for r in rows if r]  # change this filter\nwith open('/work/output/selected.csv', 'w', newline='') as out:\n    w = csv.DictWriter(out, fieldnames=rows[0].keys()); w.writeheader(); w.writerows(keep)\nprint(len(keep), 'of', len(rows), 'rows exported')\n` },
  alpha: { label: 'Contact sheet and transparency coverage of images', code: `import glob\nfrom PIL import Image\npaths = sorted(glob.glob('/work/input/*'))\nimages = [Image.open(p).convert('RGBA') for p in paths]\nfor p, im in zip(paths, images):\n    a = im.getchannel('A'); opaque = sum(1 for v in a.getdata() if v == 255)\n    print(p.split('/')[-1], im.size, f'{100*opaque/(im.width*im.height):.1f}% opaque')\ncell = 256\nsheet = Image.new('RGBA', (cell * min(4, len(images)), cell * ((len(images) + 3) // 4)), 'white')\nfor i, im in enumerate(images):\n    im.thumbnail((cell, cell)); sheet.paste(im, ((i % 4) * cell, (i // 4) * cell), im)\nsheet.save('/work/output/contact-sheet.png')\n` },
};

export class Execution {
  workbench: Workbench;
  grants = new Map<string, ExecutionGrant>();
  constructor(workbench: Workbench) { this.workbench = workbench; }
  get core() { return this.workbench.core; }
  enabled() { return this.core.settings.workbench?.codeLab?.enabled === true; }
  async status() {
    const status = await isolation();
    return { enabled: this.enabled(), ...status, runtime: await pythonRuntime(), recipes: Object.entries(recipes).map(([id, recipe]) => ({ id, label: recipe.label, code: recipe.code })) };
  }
  grantFor(sessionId: string) { return [...this.grants.values()].find(grant => grant.sessionId === sessionId && grant.expires > Date.now() && grant.usedRuns < grant.maxRuns); }
  grantRuns(p: any) {
    const minutes = p.minutes ?? 30, maxRuns = p.maxRuns ?? 10;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240 || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 50) throw new Error('A Code Lab permission lasts 1–240 minutes and covers 1–50 runs');
    const grant: ExecutionGrant = { id: crypto.randomUUID(), sessionId: p.sessionId, expires: Date.now() + minutes * 60_000, maxRuns, usedRuns: 0 };
    this.grants.set(grant.id, grant); this.core.changed(); return grant;
  }
  /** Code Lab: runs Python over read-only copies of the selected artifact versions; outputs become artifacts. */
  /** Every run is tracked so closing Cere waits for it to record its outcome before the database closes. */
  run(...args: Parameters<Execution['runInner']>) { return this.workbench.track(this.runInner(...args)); }
  private async runInner(sessionId: string, p: { code: unknown; inputs?: unknown; purpose?: unknown; origin: 'model' | 'user'; turnId?: string; approval: 'individual' | 'grant' | 'user'; signal?: AbortSignal; timeoutSeconds?: unknown }) {
    const wallMs = p.timeoutSeconds === undefined ? 60_000 : Number.isInteger(p.timeoutSeconds) && (p.timeoutSeconds as number) >= 1 && (p.timeoutSeconds as number) <= 600 ? (p.timeoutSeconds as number) * 1000 : (() => { throw new Error('A Code Lab time limit is 1–600 seconds'); })();
    if (!this.enabled()) throw Object.assign(new Error('Code Lab is turned off. Turn it on in Settings → Connections → Images & analysis.'), { code: 'disabled' });
    const status = await isolation();
    if (!status.available) throw Object.assign(new Error(status.problem || 'Code Lab is unavailable'), { code: 'isolation_unavailable' });
    if (typeof p.code !== 'string' || !p.code.trim() || Buffer.byteLength(p.code) > labLimits.codeBytes || p.code.includes('\0')) throw new Error('Give 1 byte to 64 KiB of Python code');
    const refs = Array.isArray(p.inputs) ? p.inputs.slice(0, labLimits.inputs + 1) as ArtifactRef[] : [];
    if (refs.length > labLimits.inputs) throw new Error(`Use at most ${labLimits.inputs} inputs`);
    const artifacts = this.workbench.artifacts, session = this.core.store.session(sessionId);
    if (session.temporary) throw new Error('Temporary conversations stay text-only');
    const inputs = await Promise.all(refs.map(ref => artifacts.bytes(sessionId, ref.artifactId, ref.versionId)));
    const code = await artifacts.install({ sessionId, bytes: Buffer.from(p.code), name: 'analysis.py', mime: 'text/x-python', source: p.origin === 'model' ? 'tool-output' : 'user-import', turnId: p.turnId,
      policy: artifacts.inherit(sessionId, refs), provenance: { kind: 'codelab-code', purpose: typeof p.purpose === 'string' ? p.purpose.slice(0, 300) : '' } });
    const runtime = await pythonRuntime();
    let operation = this.workbench.operations.create({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), kind: 'codelab.run', origin: p.origin, label: 'Code Lab: ' + (typeof p.purpose === 'string' && p.purpose ? p.purpose.slice(0, 80) : 'analysis'),
      payloadDigest: createHash('sha256').update(JSON.stringify({ code: code.sha256, inputs: refs })).digest('hex'), witness: { approval: p.approval, inputs: inputs.map(input => input.version.versionId) },
      inputs: [...refs.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId, purpose: 'input' })), { artifactId: code.artifactId, versionId: code.versionId, purpose: 'code' }],
      details: { runtime, limits: status.enforced, timeLimitSeconds: wallMs / 1000, approval: p.approval, code: { artifactId: code.artifactId, versionId: code.versionId } } });
    const controller = new AbortController(); this.workbench.runControllers.set(operation.id, controller);
    const signal = p.signal ? AbortSignal.any([p.signal, controller.signal]) : controller.signal;
    const removeJob = this.core.jobs.add('codelab', operation.label, () => controller.abort(new Error('Cancelled')));
    const scratch = await mkdtemp(join(privateDir(join(this.core.store.directory, 'runs')), 'lab-'));
    try {
      operation = this.workbench.operations.transition(operation.id, 'queued');
      operation = this.workbench.operations.transition(operation.id, 'running');
      this.card(operation.id);
      const binds = [{ source: join(scratch, 'main.py'), target: '/work/main.py' }];
      await writeFile(join(scratch, 'main.py'), p.code, { mode: 0o600 });
      const used = new Set<string>();
      for (const [index, input] of inputs.entries()) {
        let name = safeName(input.version.name, `input-${index + 1}`).replace(/\s+/g, '_'); while (used.has(name)) name = `${index + 1}-${name}`;
        used.add(name); await writeFile(join(scratch, 'input-' + index), input.data, { mode: 0o400 });
        binds.push({ source: join(scratch, 'input-' + index), target: '/work/input/' + name });
      }
      const result = await sandboxed({ argv: ['/usr/bin/python3', '-I', '/work/main.py'], binds, cwd: '/work', signal, limits: { wallMs } });
      return this.finish(operation.id, sessionId, result, refs, code, p.turnId);
    } catch (error: any) {
      const current = this.workbench.operations.get(operation.id);
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state)) this.workbench.operations.transition(operation.id, signal.aborted ? (current.state === 'cancel_requested' ? 'cancelled' : 'interrupted') : 'failed', { error: { code: error?.code || 'failed', message: String(error?.message || error).slice(0, 500) } });
      this.card(operation.id);
      throw error;
    } finally { removeJob(); this.workbench.runControllers.delete(operation.id); await rm(scratch, { recursive: true, force: true }); }
  }
  private async finish(operationId: string, sessionId: string, result: SandboxResult, refs: ArtifactRef[], code: { artifactId: string; versionId: string }, turnId?: string) {
    const artifacts = this.workbench.artifacts, policy = artifacts.inherit(sessionId, refs), produced: ArtifactRef[] = [];
    for (const output of result.outputs) {
      const version = await artifacts.install({ sessionId, turnId, bytes: output.bytes, name: output.name.split('/').pop()!, source: 'tool-output', policy, operationId,
        parents: [...refs.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId, relation: 'analysis-input' })), { artifactId: code.artifactId, versionId: code.versionId, relation: 'analysis-code' }],
        provenance: { kind: 'codelab', operationId, exitCode: result.exitCode ?? -1, code: code.versionId } }).catch(() => null);
      if (version) produced.push({ artifactId: version.artifactId, versionId: version.versionId, purpose: version.kind === 'image' ? 'plot' : 'output' });
    }
    const current = this.workbench.operations.get(operationId);
    const state = result.cancelled ? 'cancelled' : result.timedOut ? 'failed' : 'completed';
    const operation = this.workbench.operations.transition(operationId, state === 'cancelled' && current.state !== 'cancel_requested' ? 'interrupted' : state, { results: produced,
      ...(result.timedOut ? { error: { code: 'timeout', message: 'Stopped at the time limit' } } : {}), ...(result.cancelled ? { cancellation: { requested: Date.now(), confirmed: true, note: 'The run’s processes were stopped' } } : {}),
      details: { ...current.details, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, ...(result.outputProblem ? { outputProblem: result.outputProblem } : {}) } });
    try { this.core.workflows.observeAction(sessionId, 'codelab.run', { operationId }, { exitCode: result.exitCode ?? -1, durationMs: result.durationMs }); } catch { /* no results record for this conversation */ }
    this.card(operationId);
    return operation;
  }
  /** One card per run, updated in place. */
  card(operationId: string) {
    const operation = this.workbench.operations.get(operationId), d = operation.details || {};
    const lines = [operation.label, operation.state === 'completed' ? `Finished with exit status ${d.exitCode} in ${((d.durationMs as number) / 1000).toFixed(1)} s${operation.results.length ? ` · ${operation.results.length} file${operation.results.length === 1 ? '' : 's'}` : ''}` : operation.state, operation.error?.message || '', d.outputProblem ? String(d.outputProblem) : ''].filter(Boolean);
    try { this.core.putMessage({ id: `${operation.sessionId}:op:${operation.id}`, sessionId: operation.sessionId, role: 'workbench', kind: 'operation', operationId: operation.id, time: operation.created, text: lines.join('\n'), ...(operation.results.length ? { artifacts: operation.results } : {}) }); } catch { /* gone */ }
  }

  /** A reviewed argument vector in a folder that allows commands; that folder writable, everything else hidden. */
  command(...args: Parameters<Execution['commandInner']>) { return this.workbench.track(this.commandInner(...args)); }
  private async commandInner(sessionId: string, root: WorkspaceRoot, p: { argv: unknown; cwd?: string; network?: boolean; timeoutSeconds?: number; origin: 'model' | 'user'; turnId?: string; signal?: AbortSignal }) {
    if (!root.policy.execute) throw new Error(`${root.name} does not allow running commands; allow it in the folder permissions`);
    if (!Array.isArray(p.argv) || !p.argv.length || p.argv.length > labLimits.argv || p.argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > labLimits.argBytes)) throw new Error('Give the program and its arguments as a list of up to 64 strings');
    const status = await isolation();
    if (!status.available) throw Object.assign(new Error(status.problem || 'Command runs are unavailable'), { code: 'isolation_unavailable' });
    const timeout = Math.min(Math.max(5, p.timeoutSeconds || 300), labLimits.commandWallMs / 1000) * 1000;
    const before = await this.manifest(root);
    let operation = this.workbench.operations.create({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), kind: 'command.run', origin: p.origin, label: 'Command: ' + (p.argv as string[]).join(' ').slice(0, 100),
      payloadDigest: createHash('sha256').update(JSON.stringify([root.id, p.argv, p.network])).digest('hex'), witness: { root: root.id, revision: root.revision, network: !!p.network }, inputs: [],
      details: { argv: p.argv, root: root.name, network: !!p.network, timeoutSeconds: timeout / 1000, limits: status.enforced } });
    const controller = new AbortController(); this.workbench.runControllers.set(operation.id, controller);
    const signal = p.signal ? AbortSignal.any([p.signal, controller.signal]) : controller.signal;
    const removeJob = this.core.jobs.add('codelab', operation.label, () => controller.abort(new Error('Cancelled')));
    try {
      operation = this.workbench.operations.transition(operation.id, 'queued'); operation = this.workbench.operations.transition(operation.id, 'running'); this.card(operation.id);
      let live = '', last = 0;
      const result = await sandboxed({ argv: p.argv as string[], binds: [{ source: root.path, target: root.path, writable: true }], cwd: root.path + (p.cwd ? '/' + p.cwd : ''), network: !!p.network, collectOutput: false, limits: { wallMs: timeout }, signal,
        onOutput: (_stream, text) => { live = (live + text).slice(-8000); if (Date.now() - last > 500) { last = Date.now(); this.workbench.operations.update(operation.id, { details: { ...operation.details, stdout: live } }); } } });
      const after = await this.manifest(root);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).slice(0, 200);
      const current = this.workbench.operations.get(operation.id);
      const finished = this.workbench.operations.transition(operation.id, result.cancelled ? (current.state === 'cancel_requested' ? 'cancelled' : 'interrupted') : result.timedOut ? 'failed' : 'completed', {
        ...(result.timedOut ? { error: { code: 'timeout', message: 'Stopped at the time limit' } } : {}),
        details: { ...current.details, exitCode: result.exitCode, durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated,
          changedFiles: changed, changeNote: before.size >= 5000 ? 'Only the first 5,000 files were compared; other changes may not be listed.' : 'Changes are observed by size and modification time inside this folder only; this is not a complete system audit.' } });
      try { this.core.workflows.observeAction(sessionId, 'command.run', { argv: p.argv, root: root.name }, { exitCode: result.exitCode ?? -1, durationMs: result.durationMs }); } catch { /* none */ }
      for (const path of changed) this.core.workflows.observeEdit(join(root.path, path), Date.now(), 'workspace');
      this.card(operation.id);
      return finished;
    } catch (error: any) {
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(this.workbench.operations.get(operation.id).state)) this.workbench.operations.transition(operation.id, 'failed', { error: { code: error?.code || 'failed', message: String(error?.message || error).slice(0, 500) } });
      this.card(operation.id); throw error;
    } finally { removeJob(); this.workbench.runControllers.delete(operation.id); }
  }
  private async manifest(root: WorkspaceRoot) {
    const map = new Map<string, string>();
    try {
      const value = await fs(['walk', ...rootArgs(this.workbench.roots.handle(root)), '.', '--hidden', '--limit', '5000', '--max-entries', '5000', '--max-depth', '12', '--deadline-ms', '5000', '--exclude', '.git', '--exclude', 'node_modules']);
      for (const entry of value.entries) if (!entry.invalidName && entry.type === 'file') map.set(entry.path, `${entry.size}:${entry.mtimeMs}`);
    } catch { /* unobservable */ }
    return map;
  }
  /** Read-only Git with every program hook disabled; the folder is mounted read-only for the run. */
  async git(root: WorkspaceRoot, args: string[], signal: AbortSignal) {
    const status = await isolation();
    if (!status.available) throw Object.assign(new Error(status.problem || 'Git tools are unavailable'), { code: 'isolation_unavailable' });
    const result = await sandboxed({ argv: ['/usr/bin/git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'safe.directory=*', '-c', 'protocol.allow=never', '-C', root.path, ...args],
      binds: [{ source: root.path, target: root.path }], cwd: root.path, env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, collectOutput: false, limits: { wallMs: 20_000, displayBytes: labLimits.gitOutput }, signal });
    if (result.exitCode !== 0) throw new Error((result.stderr || 'git failed').trim().split('\n').slice(-2).join(' ').slice(0, 300));
    return { output: result.stdout, truncated: result.truncated };
  }
}
