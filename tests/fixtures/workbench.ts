// Shared fixtures for Workbench tests: the confined file helper built from source, and a scripted
// Ollama server that answers each chat request with the next step of a script.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from '../../broker/core.ts';
import { Store } from '../../broker/store.ts';
import { resetHelperPath } from '../../broker/workspace/fsclient.ts';

/** Builds cere-workspacefs from the current source once per source version; undefined without a compiler. */
export function workspaceHelper(): string | undefined {
  const source = fileURLToPath(new URL('../../native/workspacefs.cpp', import.meta.url));
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const directory = join(tmpdir(), 'cere-test-workspacefs'), target = join(directory, digest);
  if (existsSync(target)) return target;
  try {
    mkdirSync(directory, { recursive: true });
    const temporary = `${target}.${process.pid}`;
    execFileSync(process.env.CXX || 'c++', ['-std=c++20', '-O1', '-o', temporary, source], { stdio: 'pipe' });
    renameSync(temporary, target);
    return target;
  } catch { return undefined; }
}
/** Points the broker at the test helper; returns false (and the test should skip) when it cannot be built. */
export function useWorkspaceHelper() {
  const helper = workspaceHelper();
  if (!helper) return false;
  process.env.CERE_WORKSPACEFS = helper; resetHelperPath();
  return true;
}
export const skipWithoutHelper = useWorkspaceHelper() ? false : 'needs a C++20 compiler to build cere-workspacefs';

export type Step = (body: any, index: number) => { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] } | Promise<{ content?: string; tool_calls?: any[] }>;
const model = (id: string, capabilities: string[], extra: Record<string, unknown> = {}) => ({ model: id, name: id, capabilities, details: { parameter_size: '3B' }, ...extra });
export const call = (name: string, args: Record<string, unknown> = {}) => ({ tool_calls: [{ function: { name, arguments: args } }] });

export async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > end) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
/**
 * A Core with a private state directory, a project folder and a scripted Ollama server. `steps` answer
 * successive /api/chat requests; the last step repeats. `requests` holds every chat request body.
 */
export async function workbenchFixture(t: any, steps: Step[] = [() => ({ content: 'Done.' })], options: { cloud?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-workbench-')), state = join(directory, 'state'), project = join(directory, 'project');
  await mkdir(project); await mkdir(state);
  const requests: any[] = [];
  const catalog = [model('chat:latest', ['completion', 'tools', 'vision']), model('text-tools:latest', ['completion', 'tools']), model('plain:latest', ['completion']), model('cloudy:cloud', ['completion', 'tools'], { remote_host: 'https://ollama.com' }), model('see:latest', ['completion', 'vision'])];
  const server = createServer(async (req, res: ServerResponse) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    res.setHeader('Content-Type', 'application/x-ndjson');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: catalog }));
    if (req.url === '/api/show') { const entry = catalog.find(m => m.model === body.model); return res.end(JSON.stringify(entry || { error: 'model not found' })); }
    if (req.url === '/api/chat') {
      requests.push(body);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      const message = await step(body, requests.length - 1);
      return res.end(JSON.stringify({ message: { role: 'assistant', content: message.content || '', ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) }, done: true }) + '\n');
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = 'http://127.0.0.1:' + (server.address() as any).port;
  const store = new Store(state); store.set('settings', { ollama: { host, model: '' } });
  const core = new Core(store);
  await core.refreshProviderModels('ollama');
  await core.workbench.probe();
  t.after(async () => { await core.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const fixture = { core, directory, project, state, host, requests, server,
    /** A tool-capable Ollama conversation with Files turned on and the project as its write-enabled root. */
    async session(policy: Record<string, unknown> = { write: true, organize: true }, extra: Record<string, unknown> = {}) {
      const session = await core.create({ provider: 'ollama', model: options.cloud ? 'cloudy:cloud' : 'chat:latest', cwd: project, capabilities: { files: true }, ...extra });
      if (policy === null) return { session, root: null as any };
      const root = await core.rpc('workspace.addRoot', { sessionId: session.id, path: project, policy });
      return { session, root };
    },
    async finished(id: string) { await until(() => ['idle', 'error', 'interrupted'].includes(core.store.session(id).status)); core.flush(); return core.store.session(id); },
    /** The tool results the model received, in order, parsed. */
    toolResults() { const last = requests.at(-1); return (last?.messages || []).filter((m: any) => m.role === 'tool').map((m: any) => ({ name: m.tool_name, value: JSON.parse(m.content) })); },
  };
  return fixture;
}
