import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, skipWithoutHelper, workbenchFixture } from './fixtures/workbench.ts';

test('12.3 a narrow helper reads only its inputs, answers in the fixed shape, is recorded in Activity and changes nothing', { skip: skipWithoutHelper }, async t => {
  let helperRequest: any;
  const f = await workbenchFixture(t, [
    () => call('cere_tools', { add: ['helpers_review'] }),
    () => call('helpers_review', { role: 'document_summary', request: 'What are the key dates?', inputs: [{ kind: 'file', rootId: rootId, path: 'plan.md' }] }),
    body => { helperRequest = body; return { content: JSON.stringify({ observations: [{ text: 'Launch is on 3 March.', source: 'plan.md line 1' }], suggestions: [{ text: 'Confirm the venue.' }] }) }; },
    () => ({ content: 'The plan launches on 3 March.' }),
  ]);
  let rootId = '';
  await writeFile(join(f.project, 'plan.md'), 'Launch on 3 March.\nVenue TBD.\n');
  await f.core.updateSettings({ workbench: { helper: { provider: 'ollama', model: 'plain:latest' } } });
  const { session, root } = await f.session({ write: false });
  rootId = root.id;
  await f.core.workbench.prepare(session.id, new AbortController().signal);
  await f.core.send({ id: session.id, text: 'Summarize the plan' }); await f.finished(session.id);
  assert.equal(helperRequest.model, 'plain:latest'); assert.ok(helperRequest.format, 'Ollama gets the output schema as its format');
  assert.equal(helperRequest.tools, undefined, 'a helper has no tools');
  assert.match(helperRequest.messages[0].content, /Role: Document summarizer/); assert.match(helperRequest.messages[0].content, /Launch on 3 March/);
  const result = f.toolResults().find((r: any) => r.name === 'helpers_review')?.value;
  assert.equal(result?.status, 'completed', JSON.stringify(result).slice(0, 300));
  assert.deepEqual(result.data.observations, [{ text: 'Launch is on 3 March.', source: 'plan.md line 1' }]);
  assert.match(result.summary, /suggestions, not verified facts; nothing was changed/);
  const activity = f.core.store.db.prepare("SELECT data FROM activity ORDER BY rowid DESC LIMIT 20").all().map((row: any) => JSON.parse(String(row.data))).find((entry: any) => entry.action === 'helper.call');
  assert.ok((await f.core.rpc('operations.usage', { sessionId: session.id })).some((row: any) => row.kind === 'helper.document_summary' && row.model === 'plain:latest'), 'helper use joins the conversation’s reported usage');
  assert.equal(activity?.role, 'document_summary'); assert.equal(activity?.status, 'completed'); assert.match(activity?.inputs, /plan\.md/);
});
