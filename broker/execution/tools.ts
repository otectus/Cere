/**
 * Model-facing analysis tools. Code Lab and command runs show the exact code or command, the inputs, the
 * runtime and how each limit is enforced before they run; a bounded Code Lab permission the user gave can
 * cover Code Lab runs, never commands. Git tools only read.
 */
import { z } from 'zod';
import { completed, declined, failed, routeAllowed, type ToolResultV1 } from '../tools/contracts.ts';
import type { ToolSpec } from '../tools/registry.ts';
import type { Workbench } from '../workbench.ts';
import { WorkspaceError } from '../workspace/fsclient.ts';
import { describeOperation } from '../media/tools.ts';
import { normalizePath } from '../workspace/policy.ts';

const id = z.string().regex(/^[0-9a-f-]{36}$/);
export function registerAnalysisTools(workbench: Workbench) {
  const { registry } = workbench, lab = () => workbench.execution;
  const guard = (run: (context: Parameters<ToolSpec['run']>[0], args: any) => Promise<ToolResultV1>) => async (context: Parameters<ToolSpec['run']>[0], args: any) => {
    try { return await run(context, args); }
    catch (error: any) { if (context.signal.aborted) throw error; return failed(error?.code || 'failed', String(error?.message || error).slice(0, 600), error instanceof WorkspaceError ? 'explicit' : 'never'); }
  };
  const analysis = (session: any) => {
    if (!workbench.families(session).has('analysis')) return 'Analysis is not turned on for this conversation';
    return lab().enabled() ? '' : 'Code Lab is turned off in Settings';
  };
  const runResult = (operation: any): ToolResultV1 => {
    const d = operation.details || {};
    const data = { ...describeOperation(operation), exitCode: d.exitCode, durationMs: d.durationMs, stdout: String(d.stdout || '').slice(0, 16000), stderr: String(d.stderr || '').slice(0, 8000), ...(d.truncated ? { outputTruncated: true } : {}), ...(d.outputProblem ? { outputProblem: d.outputProblem } : {}), ...(d.changedFiles ? { changedFiles: d.changedFiles, changeNote: d.changeNote } : {}) };
    return operation.state === 'completed' ? completed(`Finished with exit status ${d.exitCode}${operation.results.length ? `; ${operation.results.length} output file${operation.results.length === 1 ? '' : 's'} kept as artifacts` : ''}. A finished run is not proof that its conclusion is right.`, data, { ...(operation.results.length ? { artifacts: operation.results } : {}), operationId: operation.id })
      : { schema: 1, status: 'failed', summary: operation.error?.message || `The run ended ${operation.state}.`, data, operationId: operation.id, error: { code: operation.error?.code || operation.state, message: operation.error?.message || operation.state, retry: 'explicit' } };
  };
  registry.register({
    name: 'codelab_run', family: 'analysis', core: true, effects: { execute: true },
    description: 'Run Python 3 in Cere’s isolated Code Lab: no network, no access to the user’s files except the artifact versions you pass as inputs (read-only at /work/input/<name>). Write results to /work/output; they become artifacts. numpy, matplotlib and Pillow are available. The user reviews the code first unless they allowed Code Lab runs for a while.',
    input: z.strictObject({ code: z.string().min(1).max(64 * 1024), inputs: z.array(z.strictObject({ artifactId: id, versionId: id })).max(8).optional(), purpose: z.string().min(1).max(300) }),
    available: analysis,
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const grant = lab().grantFor(sessionId);
      if (!grant) {
        const status = await lab().status();
        const answer = await workbench.core.approval(sessionId, { kind: 'execution', title: `Run analysis code: ${args.purpose.slice(0, 80)}?`,
          detail: [`Purpose: ${args.purpose}`, `Inputs: ${(args.inputs || []).length ? (args.inputs || []).map((ref: any) => { try { return workbench.artifacts.version(sessionId, ref.artifactId, ref.versionId).name; } catch { return 'unavailable input'; } }).join(', ') : 'none'}`,
            `Runtime: Python ${status.runtime.python}; no network; read-only inputs; outputs up to 20 files.`, `Memory: ${status.enforced.memory}. Processes: ${status.enforced.processes}.`, '', args.code.slice(0, 6000) + (args.code.length > 6000 ? '\n…' : '')].join('\n'),
          choices: ['allow', 'deny'], fields: { reviewComplete: args.code.length <= 48 * 1024, purpose: args.purpose } });
        if (answer.choice !== 'allow') return declined(answer.cancelled ? 'Stopped before the code ran.' : 'The user declined running this code.');
      } else grant.usedRuns++;
      const operation = await lab().run(sessionId, { code: args.code, inputs: args.inputs, purpose: args.purpose, origin: 'model', turnId, approval: grant ? 'grant' : 'individual', signal });
      return runResult(operation);
    }),
  });
  registry.register({
    name: 'commands_run', family: 'analysis', effects: { execute: true, write: true },
    description: 'Run one program with arguments (a list, never a shell string) in a workspace folder that allows commands, such as a build or test. The folder is writable for the run; nothing else of the user’s is visible; network is off unless needed. The user reviews every command.',
    input: z.strictObject({ rootId: id.optional(), argv: z.array(z.string().max(4096)).min(1).max(64), cwd: z.string().max(4096).optional(), network: z.boolean().optional(), timeoutSeconds: z.int().min(5).max(1800).optional(), purpose: z.string().min(1).max(300) }),
    available: session => analysis(session) || (workbench.roots.list(session.id).some(root => root.policy.execute) ? '' : 'No workspace folder allows running commands'),
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = args.rootId ? workbench.roots.get(sessionId, args.rootId) : workbench.roots.list(sessionId).find(item => item.policy.execute);
      if (!root?.policy.execute) return failed('denied', 'No workspace folder allows running commands', 'never');
      if (!routeAllowed((await workbench.route(sessionId, signal)).route, root.policy.destinations)) return failed('destination', `${root.name}’s contents may not be sent to this conversation’s model`, 'never');
      const cwd = args.cwd ? normalizePath(args.cwd, root.path) : '';
      const answer = await workbench.core.approval(sessionId, { kind: 'execution', title: `Run ${args.argv[0]} in ${root.name}?`,
        detail: [`Purpose: ${args.purpose}`, `Command: ${args.argv.map((arg: string) => JSON.stringify(arg)).join(' ')}`, `Folder: ${root.path}${cwd ? '/' + cwd : ''} (writable during the run)`, `Network: ${args.network ? 'allowed' : 'off'}`, `Time limit: ${args.timeoutSeconds || 300} s`].join('\n'),
        choices: ['allow', 'deny'], fields: { reviewComplete: true, root: root.id } });
      if (answer.choice !== 'allow') return declined(answer.cancelled ? 'Stopped before the command ran.' : 'The user declined this command.');
      return runResult(await lab().command(sessionId, root, { argv: args.argv, cwd, network: args.network, timeoutSeconds: args.timeoutSeconds, origin: 'model', turnId, signal }));
    }),
  });
  const gitTool = (name: string, description: string, input: z.ZodObject<any>, argv: (args: any) => string[]) => registry.register({
    name, family: 'files', effects: { read: true }, description, input,
    available: session => workbench.filesAvailable(session, 'read'),
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = args.rootId ? workbench.roots.get(sessionId, args.rootId) : workbench.roots.primary(sessionId);
      if (!root) return failed('no_root', 'No workspace folder is chosen', 'never');
      if (!routeAllowed((await workbench.route(sessionId, signal)).route, root.policy.destinations)) return failed('destination', `${root.name}’s contents may not be sent to this conversation’s model`, 'never');
      const value = await lab().git(root, argv(args), signal);
      if (!workbench.spendEvidence(sessionId, turnId, Buffer.byteLength(value.output))) return failed('evidence-budget', 'This turn already received the most file content Cere releases in one turn', 'never');
      return workbench.restricted(completed(`${name.replace('_', ' ')} for ${root.name}${value.truncated ? ' (output cut at 64 KiB)' : ''}.`, { rootId: root.id, output: value.output, ...(value.truncated ? { truncated: true } : {}) }), root.policy.destinations);
    }),
  });
  gitTool('git_status', 'Read-only git status of a workspace folder (branch, staged, changed and untracked files).', z.strictObject({ rootId: id.optional() }), () => ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
  gitTool('git_diff', 'Read-only git diff of a workspace folder, optionally for one path or the staged changes. External diff programs and text conversion are off.', z.strictObject({ rootId: id.optional(), path: z.string().max(4096).optional(), staged: z.boolean().optional() }),
    args => ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(args.staged ? ['--cached'] : []), ...(args.path ? ['--', normalizePath(args.path) || '.'] : [])]);
  gitTool('git_log', 'Read-only recent commit history of a workspace folder.', z.strictObject({ rootId: id.optional(), limit: z.int().min(1).max(100).optional() }),
    args => ['log', '--no-decorate', '--no-color', `-n${args.limit || 20}`, '--date=short', '--format=%h %ad %an%n    %s']);
}
