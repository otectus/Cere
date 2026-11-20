import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { guardedFetch, validServers, type ExtensionServer } from '../broker/extensions.ts';
import { httpMcpFixture } from './fixtures/mcp-http-server.ts';

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
async function broker(t: any, token?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cere-mcp-http-')), project = join(dir, 'project');
  await mkdir(project);
  const fixture = await httpMcpFixture({ token });
  const core = new Core(new Store(join(dir, 'state')), idle);
  t.after(async () => { await core.close(); await fixture.close(); await rm(dir, { recursive: true, force: true }); });
  await core.rpc('provider.credentials', { provider: 'openai', key: 'fixture-key' });
  const server = (patch: any = {}) => ({ name: 'Remote', transport: 'http', url: fixture.url, enabled: true, secrets: token ? ['BEARER_TOKEN'] : [], projects: [], allowed: [], timeoutSeconds: 10, ...patch });
  return { core, dir, project, fixture, server };
}

test('HTTP tool servers: HTTPS on the internet, plain HTTP only for this computer or a network the user marked local', async () => {
  for (const [patch, error] of [
    [{ url: 'http://example.com/mcp' }, /must use HTTPS/], [{ url: 'https://user:pw@example.com/mcp' }, /BEARER_TOKEN secret, not in its address/], [{ url: 'not a url' }, /full address/],
    [{ url: 'https://example.com/mcp', secrets: ['API_KEY'] }, /one secret, BEARER_TOKEN/], [{ url: 'https://example.com/mcp', network: 'lan' }, /internet or on this computer/],
  ] as [any, RegExp][]) await assert.rejects(validServers([{ name: 'S', transport: 'http', enabled: false, ...patch }]), error, JSON.stringify(patch));
  const [loopback] = await validServers([{ name: 'S', transport: 'http', url: 'http://127.0.0.1:9/mcp' }]);
  assert.equal(loopback.network, 'local', 'loopback addresses are local without asking');
  const [lan] = await validServers([{ name: 'S', transport: 'http', url: 'http://192.168.1.20:8080/mcp', network: 'local' }]);
  assert.equal(lan.url, 'http://192.168.1.20:8080/mcp');
  assert.equal(lan.command, '', 'nothing is started for an HTTP server');
});

test('guarded fetch keeps the token on the configured origin and refuses private addresses for internet servers', async () => {
  const server = { id: 'x', name: 'S', transport: 'http', url: 'https://mcp.example.com/mcp', network: 'public' } as ExtensionServer;
  const fetchFor = (addresses: string[]) => guardedFetch(server, 'secret-token', async () => addresses);
  await assert.rejects(fetchFor(['93.184.216.34'])('https://other.example.com/mcp'), /only contacts https:\/\/mcp\.example\.com/);
  await assert.rejects(fetchFor(['10.0.0.5'])('https://mcp.example.com/mcp'), /private network; mark the server as local/);
  await assert.rejects(fetchFor(['127.0.0.1'])('https://mcp.example.com/mcp'), /private network/);
});

test('M7 Streamable HTTP: tools are listed and called through the same approval path; images become artifacts; the session ends with a DELETE', async t => {
  const { core, project, fixture, server } = await broker(t, 'tok-123');
  await core.updateSettings({ extensions: [server({ allowed: ['echo', 'picture'] })] });
  const id = core.settings.extensions[0].id;
  await assert.rejects(core.rpc('extensions.restart', { id }), /did not start: .*HTTP 401.*BEARER_TOKEN/);
  await core.rpc('extensions.secret', { id, name: 'BEARER_TOKEN', value: 'tok-123' });
  const withToken = fixture.seen.length;
  const status = await core.rpc('extensions.restart', { id });
  assert.equal(status.state, 'ready'); assert.equal(status.transport, 'http'); assert.deepEqual(status.offers, { tools: true, resources: true, prompts: true });
  assert.ok(status.discovered > 0); assert.match(status.protocol, /^20\d\d-/);
  assert.doesNotMatch(JSON.stringify(core.snapshot().extensions), /tok-123/, 'the token never appears in snapshots');
  const session = await core.create({ provider: 'openai', model: 'm', cwd: project, tools: true, trusted: true });
  await core.extensions.ensure(session.id);
  const names = core.toolsFor(session.id).map(tool => tool.function.name).filter(name => name.startsWith('ext_'));
  assert.deepEqual(names, ['ext_remote_echo', 'ext_remote_picture']);
  const echo: any = await core.callTool(session.id, 'ext_remote_echo', { text: 'hello' }, new AbortController().signal);
  assert.equal(echo.output, 'echo: hello');
  const picture: any = await core.callTool(session.id, 'ext_remote_picture', {}, new AbortController().signal);
  assert.equal(picture.status, 'completed'); assert.equal(picture.artifacts.length, 1);
  assert.deepEqual(fixture.calls, ['echo:hello', 'picture']);
  assert.ok(fixture.seen.slice(withToken).every(request => request.authorization === 'Bearer tok-123'), 'every request after the token was set carries it');
  await core.updateSettings({ extensions: [] });
  for (let index = 0; index < 100 && !fixture.seen.some(request => request.method === 'DELETE'); index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fixture.seen.some(request => request.method === 'DELETE'), 'turning the server off ends its HTTP session');
});

test('M7 resources and prompt templates are the user’s own operations: listed, read with bounds, kept as files only on request', async t => {
  const { core, project, server } = await broker(t);
  await core.updateSettings({ extensions: [server()] });
  const id = core.settings.extensions[0].id;
  const listed = await core.rpc('extensions.resources', { id });
  assert.deepEqual(listed.resources.map((r: any) => [r.uri, r.name, r.mimeType]), [['fixture://docs/readme.md', 'readme', 'text/markdown']]);
  const read = await core.rpc('extensions.resource', { id, uri: 'fixture://docs/readme.md' });
  assert.equal(read.contents[0].text, '# Fixture\nResource text.'); assert.equal(read.kept, undefined);
  const session = await core.create({ provider: 'openai', model: 'm', cwd: project, trusted: true });
  const kept = await core.rpc('extensions.resource', { id, uri: 'fixture://docs/readme.md', sessionId: session.id });
  assert.equal(kept.kept.length, 1);
  const version = core.workbench.artifacts.version(session.id, kept.kept[0].artifactId);
  assert.equal(version.provenance.kind, 'mcp-resource'); assert.deepEqual(version.policy, { remote: false, cloud: false }, 'a server on this computer keeps its resources local');
  const prompts = await core.rpc('extensions.prompts', { id });
  assert.deepEqual(prompts.prompts.map((p: any) => [p.name, p.arguments.map((a: any) => [a.name, a.required])]), [['review', [['file', true]]]]);
  const filled = await core.rpc('extensions.prompt', { id, name: 'review', arguments: { file: 'notes.md' } });
  assert.equal(filled.text, 'Please review notes.md carefully.');
  await assert.rejects(core.rpc('extensions.prompt', { id, name: 'review', arguments: { file: 5 } }), /up to 20 text values/);
});

test('an HTTP server that redirects to another origin is refused, and no credential follows the redirect', async t => {
  const { core, fixture, server } = await broker(t);
  await core.updateSettings({ extensions: [server({ url: fixture.redirectUrl })] });
  await assert.rejects(core.rpc('extensions.restart', { id: core.settings.extensions[0].id }), /did not start/);
  assert.equal(fixture.seen.filter(request => request.path === '/mcp').length, 0);
});
