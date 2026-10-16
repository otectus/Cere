import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { endpointUrl, validEndpoint } from '../broker/compatible-endpoint.ts';
import { defaultSettings } from '../broker/types.ts';

const base = defaultSettings.compatible;
const chunk = (delta: any, finish: string | null = null, extra: any = {}) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra }) + '\n\n';

test('M13 endpoint URLs: https outside this computer and the local network, no secrets or queries in the URL', () => {
  assert.equal(endpointUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
  assert.equal(endpointUrl('http://192.168.1.20:8000/v1'), 'http://192.168.1.20:8000/v1');
  assert.equal(endpointUrl('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(endpointUrl('https://llm.example/api/v1'), 'https://llm.example/api/v1');
  assert.equal(endpointUrl(''), '');
  for (const [value, error] of [['http://llm.example/v1', /Use https/], ['http://8.8.8.8/v1', /Use https/], ['https://user:secret@llm.example/v1', /key field/],
    ['https://llm.example/v1?key=secret', /without a query/], ['ftp://llm.example', /http or https/], ['not a url', /base URL/]] as [string, RegExp][])
    assert.throws(() => endpointUrl(value), error, value);
  assert.throws(() => validEndpoint({ model: 'x' }, base), /Unknown compatible endpoint setting/);
  assert.throws(() => validEndpoint({ contextLength: 1000 }, base), /0 \(not declared\) or 2,048/);
  assert.throws(() => validEndpoint({ tools: 'yes' }, base), /supports tools/);
  assert.deepEqual(validEndpoint({ baseUrl: 'http://127.0.0.1:1/v1/', label: '  Local  ', contextLength: 16384 }, base), { ...base, baseUrl: 'http://127.0.0.1:1/v1', label: 'Local', contextLength: 16384 });
});

type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void;
async function server(t: any, handler: Handler) {
  const requests: { url: string; auth: string; body: any }[] = [];
  const http = createServer((req, res) => {
    let text = ''; req.on('data', data => text += data);
    req.on('end', () => { const body = text ? JSON.parse(text) : undefined; requests.push({ url: req.url || '', auth: String(req.headers.authorization || ''), body }); handler(req, body, res); });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  return { url: `http://127.0.0.1:${(http.address() as any).port}/v1`, requests };
}
async function broker(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'cere-compatible-'));
  const core = new Core(new Store(join(dir, 'state')));
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.updateSettings({ memory: { enabled: false } });
  return { core, dir };
}
const idle = async (core: Core, id: string) => { for (let index = 0; index < 400 && ['starting', 'working', 'waiting', 'stopping'].includes(core.store.session(id).status); index++) await new Promise(resolve => setTimeout(resolve, 10)); };
const replying: Handler = (req, _body, res) => {
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'local-model' }] })); return; }
  res.setHeader('Content-Type', 'text/event-stream');
  res.end(chunk({ role: 'assistant', content: 'Hi there.' }) + chunk({}, 'stop') + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n');
};

test('M13 the key is bound to the endpoint origin: a changed endpoint never receives it, and an endpoint can run keyless', async t => {
  const first = await server(t, replying), second = await server(t, replying);
  const { core, dir } = await broker(t);
  await assert.rejects(core.rpc('provider.credentials', { provider: 'compatible', key: 'local-secret' }), /Set the compatible endpoint before saving its key/);
  await core.updateSettings({ compatible: { baseUrl: first.url, label: 'Workstation' } });
  await core.rpc('provider.credentials', { provider: 'compatible', key: 'local-secret' });
  assert.equal(core.capabilities.compatible.source, 'saved');
  const models = await core.rpc('provider.models', { provider: 'compatible' });
  assert.deepEqual(models.map((m: any) => m.id), ['local-model']);
  assert.equal(first.requests[0].auth, 'Bearer local-secret');
  assert.ok(!JSON.stringify(core.snapshot()).includes('local-secret'), 'the key never enters the snapshot');
  const session = await core.create({ provider: 'compatible', model: 'local-model', cwd: dir });
  await core.send({ id: session.id, text: 'Hello' }); await idle(core, session.id);
  assert.equal(core.store.messages(session.id).at(-1)?.text, 'Hi there.');
  // A different origin: the saved key stays with the first one and is not sent.
  await core.updateSettings({ compatible: { baseUrl: second.url } });
  assert.deepEqual([core.capabilities.compatible.source, core.capabilities.compatible.boundTo], ['missing', new URL(first.url).origin]);
  await assert.rejects(core.create({ provider: 'compatible', model: 'local-model', cwd: dir }), /Add a key for Workstation/);
  await core.send({ id: session.id, text: 'Again' }); await idle(core, session.id);
  assert.equal(second.requests.length, 0, 'nothing reaches the new endpoint without its own key');
  assert.match(core.store.messages(session.id).at(-1)!.text, /Add a key for Workstation/);
  // Declared keyless: requests go out without any Authorization header.
  await core.updateSettings({ compatible: { requiresKey: false } });
  await core.send({ id: session.id, text: 'Keyless' }); await idle(core, session.id);
  assert.equal(second.requests.at(-1)!.auth, '');
  assert.equal(core.store.messages(session.id).at(-1)?.text, 'Hi there.');
  // The old origin's key comes back into use only when the endpoint is that origin again.
  await core.updateSettings({ compatible: { baseUrl: first.url + '/', requiresKey: true } });
  assert.equal(core.capabilities.compatible.source, 'saved');
});

test('M13 only declared capabilities are used: tools, images, streaming and usage, each labelled unverified', async t => {
  const replies: string[] = [];
  const endpoint = await server(t, (req, body, res) => {
    if (req.url === '/v1/models') { res.statusCode = 404; res.end('{}'); return; }
    if (body.stream === false) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Plain JSON reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4 } })); replies.push('json'); return; }
    replying(req, body, res); replies.push('stream');
  });
  const { core, dir } = await broker(t);
  await core.updateSettings({ compatible: { baseUrl: endpoint.url, requiresKey: false, tools: false, images: false, usage: false }, webSearch: { enabled: true } });
  // An endpoint without a model list still works by model ID.
  assert.equal((await core.rpc('provider.models', { provider: 'compatible' })).length, 0);
  assert.match(core.capabilities.compatible.modelsWarning, /does not list its models/);
  assert.equal(core.capabilities.compatible.declared.verified, false);
  await assert.rejects(core.create({ provider: 'compatible', model: 'typed-model', cwd: dir, tools: true, trusted: true }), /not declared to support tools/);
  const session = await core.create({ provider: 'compatible', model: 'typed-model', cwd: dir });
  assert.deepEqual(core.toolsFor(session.id), [], 'no tools, not even web or memory tools, without tool calling');
  const image = join(dir, 'pixel.png'); await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await assert.rejects(core.send({ id: session.id, text: 'Look', images: [image] }), /not declared to accept images/);
  await core.send({ id: session.id, text: 'Hello' }); await idle(core, session.id);
  const sent = endpoint.requests.at(-1)!.body;
  assert.deepEqual([sent.stream, sent.tools, sent.stream_options, sent.max_tokens], [true, undefined, undefined, undefined]);
  let plan = (await core.rpc('session.context', { id: session.id })).lastPlan;
  assert.equal(plan.reported, undefined, 'usage is not recorded unless the endpoint is declared to report it');
  assert.equal(plan.contextSize, 8192);
  assert.ok(plan.unknown.some((line: string) => /not declared; Cere assumes 8,192 tokens/.test(line)));
  assert.ok(plan.unknown.some((line: string) => /as you declared them; not verified/.test(line)));
  // Declared usage and a declared context window: requested, recorded as reported, never priced.
  await core.updateSettings({ compatible: { usage: true, contextLength: 16384, maxOutputTokens: 2048 } });
  await core.send({ id: session.id, text: 'Count' }); await idle(core, session.id);
  const counted = endpoint.requests.at(-1)!.body;
  assert.deepEqual([counted.stream_options, counted.max_tokens], [{ include_usage: true }, 2048]);
  plan = (await core.rpc('session.context', { id: session.id })).lastPlan;
  assert.deepEqual(plan.reported, { inputTokens: 42, outputTokens: 3, source: 'Compatible endpoint' });
  assert.equal(plan.contextSize, 16384);
  assert.doesNotMatch(JSON.stringify(plan), /cost|price|\$/i);
  const library: any = vm.createContext({ Qt: { locale: () => undefined } });
  vm.runInContext(readFileSync(new URL('../qml/ContextExplain.js', import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), library);
  assert.equal(library.reportedUsage(plan), 'Compatible endpoint reported 42 in, 3 out tokens for this request.');
  assert.equal(library.reportedUsage({ layers: [] }), '');
  // Without streaming, the whole reply arrives as one JSON body.
  await core.updateSettings({ compatible: { streaming: false } });
  await core.send({ id: session.id, text: 'No stream' }); await idle(core, session.id);
  assert.equal(endpoint.requests.at(-1)!.body.stream, false);
  assert.equal(core.store.messages(session.id).at(-1)?.text, 'Plain JSON reply.');
  assert.deepEqual(replies, ['stream', 'stream', 'json']);
});

test('M13 declared tool calling runs tools through the usual loop, and an endpoint change stops a reply in progress', async t => {
  let hold: ServerResponse | undefined, closed = false;
  const endpoint = await server(t, (req, body, res) => {
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'm' }] })); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    const last = body.messages.at(-1);
    if (last.role === 'user' && last.content.includes('Wait')) { hold = res; res.write(chunk({ role: 'assistant', content: 'Thinking' })); req.on('close', () => { closed = true; }); return; }
    if (last.role === 'tool') { res.end(chunk({ content: 'The note is saved.' }) + chunk({}, 'stop')); return; }
    // The call has no ID: Cere gives it one so its result can be matched.
    res.end(chunk({ tool_calls: [{ index: 0, type: 'function', function: { name: 'web_search', arguments: '{"query":"cere"}' } }] }) + chunk({}, 'tool_calls'));
  });
  const { core, dir } = await broker(t);
  await core.updateSettings({ compatible: { baseUrl: endpoint.url, requiresKey: false, tools: true }, webSearch: { enabled: true } });
  core.web.search = (async () => ({ results: [{ title: 'Cere', url: 'https://cere.example', snippet: 'x' }] })) as any;
  const session = await core.create({ provider: 'compatible', model: 'm', cwd: dir });
  assert.ok(core.toolsFor(session.id).some(tool => tool.function.name === 'web_search'));
  await core.send({ id: session.id, text: 'Search for cere' }); await idle(core, session.id);
  assert.equal(core.store.messages(session.id).at(-1)?.text, 'The note is saved.');
  const followUp = endpoint.requests.at(-1)!.body.messages;
  const call = followUp.at(-2).tool_calls[0], result = followUp.at(-1);
  assert.match(call.id, /^call_[0-9a-f]{24}$/); assert.equal(result.tool_call_id, call.id);
  // Saving a new declaration while a reply streams stops it; nothing is resent.
  const chats = () => endpoint.requests.filter(request => request.url.endsWith('/chat/completions')).length, before = chats();
  await core.send({ id: session.id, text: 'Wait for me' });
  for (let index = 0; index < 200 && !hold; index++) await new Promise(resolve => setTimeout(resolve, 5));
  await core.updateSettings({ compatible: { label: 'Renamed' } });
  await idle(core, session.id);
  for (let index = 0; index < 100 && !closed; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(closed, true, 'the request was aborted');
  assert.equal(chats(), before + 1);
  assert.equal(core.adapters.has(session.id), false, 'the conversation reconnects with the new declaration');
  assert.equal(core.capabilities.compatible.label, 'Renamed');
});
