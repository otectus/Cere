import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ToolProgress, noProgressRepeats, pollingTools } from '../broker/tool-progress.ts';
import { OllamaAdapter } from '../broker/ollama.ts';
import type { Session } from '../broker/types.ts';

test('Q06 identical calls with unchanged results warn once; changed results and polling tools never warn', () => {
  const progress = new ToolProgress();
  const same = (args: unknown, result: string) => progress.observe('files_open', args, result);
  assert.equal(same({ path: '/tmp/a' }, '{"error":"missing"}'), undefined);
  assert.equal(same({ path: '/tmp/a' }, '{"error":"missing"}'), undefined);
  const warning = same({ path: '/tmp/a' }, '{"error":"missing"}');
  assert.match(warning!, /files_open returned the same result 3 times/);
  assert.equal(same({ path: '/tmp/a' }, '{"error":"missing"}'), undefined, 'one warning per call');
  // Argument order does not make a different call; a different argument does.
  const keys = new ToolProgress();
  for (let index = 0; index < noProgressRepeats - 1; index++) keys.observe('web_read', { url: 'https://example.org', max: 1 }, 'same');
  assert.ok(keys.observe('web_read', { max: 1, url: 'https://example.org' }, 'same'));
  // A changed result is progress and starts the count again.
  const changing = new ToolProgress();
  for (let index = 0; index < 10; index++) assert.equal(changing.observe('web_search', { query: 'x' }, 'result ' + index), undefined);
  // Waiting and status tools repeat on purpose.
  const polling = new ToolProgress();
  for (const name of pollingTools) for (let index = 0; index < 10; index++) assert.equal(polling.observe(name, { id: 'child' }, 'running'), undefined);
  assert.equal(polling.size, 0);
});

test('Q06 the Ollama tool loop shows one notice for a stuck tool without changing what the model receives', async t => {
  let round = 0;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      if (req.url === '/api/show') { res.end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'x', 'x.context_length': 32768 } })); return; }
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [] })); return; }
      round++;
      const message = round <= 4 ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'files_open', arguments: { path: '/missing' } } }] } : { role: 'assistant', content: 'I could not open it.' };
      res.end(JSON.stringify({ message, done: true }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const host = `http://127.0.0.1:${(server.address() as any).port}`;
  const session = { id: 's', provider: 'ollama', model: 'm', cwd: '/tmp', ollama: { host, tools: true } } as Session;
  const events: any[] = [], saved: any[][] = [];
  let history: any[] = [];
  const adapter = new OllamaAdapter(session, { event: e => events.push(e), native() {}, approve: async () => ({ choice: 'deny' }), token: 't' }, {
    load: () => structuredClone(history), save: messages => { history = structuredClone(messages); saved.push(history); },
    tools: () => [{ type: 'function', function: { name: 'files_open', description: 'Open', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    call: async () => ({ error: 'No such file' }),
  });
  await adapter.run('Open the missing file', [], new AbortController().signal);
  const notices = events.filter(event => event.type === 'tool' && event.data?.notice);
  assert.equal(notices.length, 1, 'four identical failures produce one notice');
  assert.match(notices[0].text, /^No progress detected\nNo progress: files_open returned the same result 3 times/);
  assert.ok(history.every(message => !String(message.content).includes('No progress')), 'the notice never enters the model history');
  assert.equal(history.filter(message => message.role === 'tool').length, 4, 'every call still ran; nothing was skipped or retried');
  assert.equal(history.at(-1).content, 'I could not open it.');
});
