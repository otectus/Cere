#!/usr/bin/env node
// Scripted providers for the documentation screenshots. Never calls a model or runs a tool.
//   fixture.mjs codex app-server   Codex app-server protocol with scripted turns
//   fixture.mjs claude -p ...      Claude Code model discovery
//   fixture.mjs agy ...            AntiGravity CLI help and model list
//   fixture.mjs ollama             Ollama and SearXNG over HTTP; prints its address
//   fixture.mjs hyprctl|busctl|wpctl|check|quiet   desktop commands the broker runs
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const [role, ...args] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const later = (ms, work) => setTimeout(work, ms);

const codexModels = [
  ['gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium', true],
  ['gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium', false],
  ['gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', false],
  ['gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium', false],
].map(([id, displayName, description, efforts, defaultReasoningEffort, isDefault]) => ({ id, model: id, displayName, description, isDefault, defaultReasoningEffort,
  supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }));
const claudeModels = [
  ['default', 'Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks'],
  ['opus', 'Opus 5.5', 'For complex work and everyday tasks'],
  ['fable', 'Fable 5.1', 'For your toughest challenges'],
  ['sonnet', 'Sonnet 5.5', 'Most efficient for simpler tasks'],
  ['haiku', 'Haiku 5.5', 'Fastest for quick answers'],
].map(([value, displayName, description]) => ({ value, displayName, description, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }));

// Codex turns, chosen by a phrase in the prompt. Each step is [delay in ms, notification or request].
const flakyReply = 'Found the gremlin. `login.spec.ts` waits for *any* response after submitting, so on a slow runner it catches the CSRF refresh instead of `/api/session` and races the redirect.\n\nI pinned the wait to the session response:\n\n```ts\nawait page.waitForResponse((r) =>\n  r.url().endsWith("/api/session"));\n```\n\nFifty runs locally: 50 passed, zero drama. Want me to open a PR?';
const item = (method, value, threadId = 'demo-thread') => ({ method, params: { threadId, item: value } });
const command = (id, text, output) => [item('item/started', { id, type: 'commandExecution', command: text }), item('item/completed', { id, type: 'commandExecution', command: text, aggregatedOutput: output })];
function codexTurn(prompt, turn) {
  if (/\bPR\b|pull request/i.test(prompt)) {
    const [started, completed] = command(`pr-${turn}`, 'gh pr create --fill --base main', 'https://github.com/demo/aurora-web/pull/482');
    return [[300, started], [700, completed],
      [900, item('item/completed', { id: `reply-${turn}`, type: 'agentMessage', phase: 'final_answer', text: 'Opened **#482** with the fix and the 50-run check. CI runs the suite with pnpm, as you prefer for this repo.' })],
      [1000, { method: 'turn/completed', params: { threadId: 'demo-thread', turn: { id: `turn-${turn}`, status: 'completed' } } }]];
  }
  if (/flak/i.test(prompt)) return [
    [200, item('item/started', { id: `think-${turn}`, type: 'reasoning' })],
    [500, item('item/started', { id: `run-${turn}`, type: 'commandExecution', command: 'pnpm vitest run tests/login.spec.ts --repeat 20' })],
    [900, item('item/completed', { id: `run-${turn}`, type: 'commandExecution', command: 'pnpm vitest run tests/login.spec.ts --repeat 20', aggregatedOutput: '✓ 17 passed  ✗ 3 failed\nTimeoutError: waiting for navigation to /dashboard (tests/login.spec.ts:41)' })],
    [1100, item('item/started', { id: `grep-${turn}`, type: 'commandExecution', command: 'rg -n "waitForResponse" tests/' })],
    [1300, item('item/completed', { id: `grep-${turn}`, type: 'commandExecution', command: 'rg -n "waitForResponse" tests/', aggregatedOutput: 'tests/login.spec.ts:38:  await page.waitForResponse(() => true);' })],
    [1500, item('item/started', { id: `verify-${turn}`, type: 'commandExecution', command: 'pnpm vitest run tests/login.spec.ts --repeat 50' })],
    [1900, item('item/completed', { id: `verify-${turn}`, type: 'commandExecution', command: 'pnpm vitest run tests/login.spec.ts --repeat 50', aggregatedOutput: '✓ 50 passed (50) in 41.8s' })],
    [2300, item('item/completed', { id: `reply-${turn}`, type: 'agentMessage', phase: 'final_answer', text: flakyReply })],
    [2400, { method: 'turn/completed', params: { threadId: 'demo-thread', turn: { id: `turn-${turn}`, status: 'completed' } } }],
  ];
  if (/test suite/i.test(prompt)) {
    const diff = '@@ -4,7 +4,10 @@ export default defineConfig({\n   test: {\n     environment: "jsdom",\n-    pool: "forks",\n+    pool: "threads",\n+    poolOptions: { threads: { singleThread: false } },\n     setupFiles: ["./tests/setup.ts"],\n+    // Reuse the seeded database between files instead of rebuilding it per test.\n+    globalSetup: ["./tests/global-db.ts"],\n   },\n });';
    return [
      [100, item('item/started', { id: `plan-${turn}`, type: 'plan' })],
      [400, item('item/started', { id: `timing-${turn}`, type: 'commandExecution', command: 'pnpm vitest run --reporter=json --outputFile=.cache/timings.json' })],
      [900, item('item/completed', { id: `timing-${turn}`, type: 'commandExecution', command: 'pnpm vitest run --reporter=json --outputFile=.cache/timings.json', aggregatedOutput: 'Test Files  64 passed (64)\n     Tests  412 passed (412)\n  Duration  3m 58s (setup 2m 41s, tests 1m 17s)' })],
      [1100, item('item/completed', { id: `spawn-${turn}`, type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'demo-thread', receiverThreadIds: ['profiler'], prompt: 'Rank the slowest test files and explain where their time goes', agentsStates: { profiler: { status: 'running' } } })],
      [1200, item('item/completed', { id: `spawn2-${turn}`, type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'demo-thread', receiverThreadIds: ['fixtures'], prompt: 'Find fixtures that rebuild the database for every test', agentsStates: { fixtures: { status: 'running' } } })],
      [1500, item('item/started', { id: 'child-run-1', type: 'commandExecution', command: 'node scripts/rank-timings.mjs .cache/timings.json' }, 'profiler')],
      [1700, item('item/started', { id: 'child-run-2', type: 'commandExecution', command: 'rg -n "beforeEach\\(.*seed" tests/' }, 'fixtures')],
      [2000, { method: 'item/agentMessage/delta', params: { threadId: 'demo-thread', itemId: `reply-${turn}`, delta: 'Setup is the problem, not the tests: **2m 41s** of the 3m 58s run is database seeding, repeated in 38 of 64 files. ' } }],
      [2300, { method: 'item/agentMessage/delta', params: { threadId: 'demo-thread', itemId: `reply-${turn}`, delta: 'Switching to thread workers and one global seed should bring it under a minute. I need your OK to change the Vitest config.' } }],
      [2500, item('item/started', { id: `patch-${turn}`, type: 'fileChange', changes: [{ path: 'vitest.config.ts', kind: { type: 'update' }, diff }] })],
      [2700, { id: `approve-patch-${turn}`, method: 'item/fileChange/requestApproval', params: { threadId: 'demo-thread', itemId: `patch-${turn}`, reason: 'Run test files on worker threads and seed the database once.' } }],
    ];
  }
  if (/release notes/i.test(prompt)) return [
    [200, item('item/started', { id: `think-${turn}`, type: 'reasoning' })],
    [500, { id: `ask-${turn}`, method: 'item/tool/requestUserInput', params: { threadId: 'demo-thread', questions: [
      { id: 'audience', header: 'Audience', question: 'Who are these release notes for?', multiSelect: false, options: [
        { label: 'People using the app', description: 'Plain-language highlights and what changed for them' },
        { label: 'Developers', description: 'API changes, migrations and deprecations' }] },
      { id: 'sections', header: 'Sections', question: 'Which sections should I include?', multiSelect: true, options: [
        { label: 'Highlights' }, { label: 'Breaking changes' }, { label: 'Bug fixes' }, { label: 'Contributors' }] },
      { id: 'context', header: 'Context', question: 'Anything else I should mention?', options: [] },
    ] } }],
  ];
  if (/deploy|staging/i.test(prompt)) return [
    [200, item('item/started', { id: `think-${turn}`, type: 'reasoning' })],
    [500, { id: `approve-run-${turn}`, method: 'item/commandExecution/requestApproval', params: { threadId: 'demo-thread', itemId: `deploy-${turn}`, command: 'pnpm run deploy --env staging', cwd: process.cwd(), reason: 'Publish the reviewed build to the staging environment.' } }],
  ];
  return [
    [300, item('item/completed', { id: `reply-${turn}`, type: 'agentMessage', phase: 'final_answer', text: 'Done. The change is in place and the checks pass.' })],
    [400, { method: 'turn/completed', params: { threadId: 'demo-thread', turn: { id: `turn-${turn}`, status: 'completed' } } }],
  ];
}

function codex() {
  let turn = 0, current = '', timers = [];
  const waiting = new Map();
  const finish = (id, text, steps = []) => {
    for (const step of steps) send(step);
    send({ method: 'item/completed', params: { threadId: 'demo-thread', item: { id: `reply-${id}`, type: 'agentMessage', phase: 'final_answer', text } } });
    send({ method: 'turn/completed', params: { threadId: 'demo-thread', turn: { id: `turn-${id}`, status: 'completed' } } });
  };
  createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (!m.method) {
      const pending = waiting.get(m.id), id = String(m.id);
      if (!pending) return;
      waiting.delete(m.id);
      if (m.result?.answers) finish(pending, 'Got it. Drafting developer-facing notes with highlights and breaking changes, and the SSO setup guide gets its own section.');
      else if (m.result?.decision !== 'accept') finish(pending, 'Understood, I left everything unchanged.');
      else if (id.startsWith('approve-patch')) {
        finish(pending, 'Applied. The suite now runs in **52 seconds** (from 3m 58s). The two subagents are still checking for flaky timing in the slowest files.',
          command(`rerun-${pending}`, 'pnpm vitest run', 'Test Files  64 passed (64)\n     Tests  412 passed (412)\n  Duration  52.3s'));
        // The subagents report back a little later, so the screenshots can show them at work first.
        for (const [child, text] of [['profiler', 'Three files account for 71% of the runtime; all three seed the database.'], ['fixtures', 'Moved the shared seed into tests/global-db.ts.']])
          timers.push(later(12000, () => {
            send(item('item/completed', { id: `${child}-reply`, type: 'agentMessage', text }, child));
            send({ method: 'turn/completed', params: { threadId: child, turn: { id: `${child}-turn`, status: 'completed' } } });
          }));
      } else {
        const [started, completed] = command(`deploy-${pending}`, 'pnpm run deploy --env staging', 'Uploaded build 2026.10.15-3\nSmoke checks: 12 passed');
        send(started);
        timers.push(later(12000, () => { send(completed); finish(pending, 'Deployed build `2026.10.15-3` to staging. Smoke checks passed, so QA can start.'); }));
      }
      return;
    }
    const reply = result => send({ id: m.id, result });
    if (m.method === 'initialize') reply({ userAgent: 'codex-demo' });
    if (m.method === 'model/list') reply({ data: codexModels, nextCursor: null });
    if (m.method === 'config/read') reply({ config: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } });
    if (m.method === 'thread/list') reply({ data: [
      { id: 'thread-history-1', name: 'Port the settings page to the new router', cwd: '/home/demo/Projects/aurora-web', updatedAt: Math.floor(Date.now() / 1000) - 86400 },
      { id: 'thread-history-2', name: 'Investigate memory growth in the indexer', cwd: '/home/demo/Projects/tidepool', updatedAt: Math.floor(Date.now() / 1000) - 3 * 86400 },
    ] });
    if (m.method === 'thread/start' || m.method === 'thread/resume')
      reply({ thread: { id: 'demo-thread' }, approvalPolicy: m.params.approvalPolicy, approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
    if (m.method === 'turn/start') {
      for (const timer of timers) clearTimeout(timer);
      // Item IDs stay unique when Cere restarts this process to resume the thread, as Codex's do.
      const id = current = `${process.pid}.${++turn}`; timers = [];
      reply({ turn: { id: `turn-${id}` } });
      send({ method: 'turn/started', params: { threadId: 'demo-thread', turn: { id: `turn-${id}` } } });
      // Recalled memory arrives as a cere_memory_data block before the person's words.
      const prompt = String(m.params.input?.[0]?.text || '').replace(/^\s*<cere_memory_data>[\s\S]*?<\/cere_memory_data>/, '');
      for (const [delay, message] of codexTurn(prompt, id)) timers.push(later(delay, () => {
        if (message.id !== undefined) waiting.set(message.id, id);
        send(message);
      }));
    }
    if (m.method === 'turn/interrupt') {
      for (const timer of timers) clearTimeout(timer);
      timers = []; waiting.clear(); reply({});
      send({ method: 'turn/completed', params: { threadId: 'demo-thread', turn: { id: `turn-${current}`, status: 'interrupted' } } });
    }
  });
}

function claude() {
  if (args.includes('--version')) { console.log('2.1.300 (Claude Code)'); return; }
  if (args.includes('--help')) { console.log('Usage: claude [options]\n  --permission-prompts <mode>'); return; }
  createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.type === 'control_request' && m.request?.subtype === 'initialize')
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { models: claudeModels, commands: [] } } });
  });
}

function antigravity() {
  if (args.includes('--help')) { console.log('Usage: agy [options]\n  --input-format --output-format --conversation --disable-slash-commands'); return; }
  if (args.includes('models')) {
    console.log(['gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)', 'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)'].join('\n'));
    return;
  }
  process.exit(1);
}

// Ollama: three chat models (one local, two cloud), an embedding model, scripted replies and SearXNG results.
const ollamaModels = {
  'gpt-oss:20b': { capabilities: ['completion', 'tools', 'thinking'], details: { family: 'gptoss', parameter_size: '20.9B', quantization_level: 'MXFP4' }, model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131072 } },
  'gemma4:31b-cloud': { capabilities: ['completion', 'tools', 'vision'], remote_host: 'https://ollama.com:443', details: { family: 'gemma4', parameter_size: '32.7B', quantization_level: 'BF16' }, model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 262144 } },
  'glm-5.3:cloud': { capabilities: ['completion', 'tools'], remote_host: 'https://ollama.com:443', details: { family: 'glm', parameter_size: '753B', quantization_level: 'FP8' }, model_info: { 'general.architecture': 'glm', 'glm.context_length': 1048576 } },
  'nemotron-3-super:cloud': { capabilities: ['completion', 'tools'], remote_host: 'https://ollama.com:443', details: { family: 'nemotron', parameter_size: '120B', quantization_level: 'NVFP4' }, model_info: { 'general.architecture': 'nemotron', 'nemotron.context_length': 262144 } },
  'nomic-embed-text:latest': { capabilities: ['embedding'], details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' }, model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 2048 } },
};
const ollamaReplies = [
  [/workspace 9|spotify/i, 'Give Spotify a window rule keyed on its class, and Hyprland will put it on workspace 9 every time it opens:\n\n```ini\nwindowrule = workspace 9 silent, class:^(Spotify)$\n```\n\n`silent` keeps you where you are instead of jumping along with it. Reload with `hyprctl reload`, then reopen Spotify to check.'],
  [/discord/i, 'Same rule, different class: give `class:^(discord)$` a `workspace 8 silent` rule.\n\nDiscord\'s class is lowercase, unlike Spotify\'s. If it still lands elsewhere, `hyprctl clients` shows the exact class to match.'],
  [/.*/, 'Happy to help. What would you like to work on?'],
];
function vector(text) {
  const digest = createHash('sha256').update(String(text).toLowerCase()).digest();
  return Array.from({ length: 32 }, (_, i) => (digest[i] - 128) / 128);
}
function ollama() {
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/tags') return res.end(JSON.stringify({ models: Object.entries(ollamaModels).map(([name, info]) => ({ name, model: name, digest: createHash('sha256').update(name).digest('hex'), capabilities: info.capabilities, details: info.details, ...(info.remote_host ? { remote_host: info.remote_host } : {}) })) }));
    if (url.pathname === '/api/show') { const info = ollamaModels[body.model]; return res.end(JSON.stringify(info || { error: 'model not found' })); }
    if (url.pathname === '/api/embed') return res.end(JSON.stringify({ model: body.model, embeddings: [].concat(body.input).map(vector) }));
    if (url.pathname === '/search') return res.end(JSON.stringify({ results: [
      { title: 'Window Rules – Hyprland Wiki', url: 'https://wiki.hypr.land/Configuring/Window-Rules/', content: 'Window rules let you set workspaces, sizes and behaviour for matching windows.' },
      { title: 'Dispatchers – Hyprland Wiki', url: 'https://wiki.hypr.land/Configuring/Dispatchers/', content: 'workspace, movetoworkspace and movetoworkspacesilent dispatchers.' },
    ] }));
    if (url.pathname === '/api/chat') {
      // Memory extraction asks for schema-shaped JSON; the demo proposes nothing.
      if (body.format) return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '{"entities":[],"assertions":[]}' }, done: true }));
      const last = [...(body.messages || [])].reverse().find(message => message.role === 'user')?.content || '';
      const answer = ollamaReplies.find(([pattern]) => pattern.test(last))[1];
      res.setHeader('Content-Type', 'application/x-ndjson');
      const words = answer.split(/(?<= )/);
      for (let i = 0; i < words.length; i += 6) res.write(JSON.stringify({ message: { role: 'assistant', content: words.slice(i, i + 6).join('') }, done: false }) + '\n');
      return res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
    }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(11434, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
  process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
}

// Desktop commands the broker runs, so the Desktop page shows a believable session instead of this machine's.
const windows = [
  ['0x5f1c40', 'firefox', 'Window Rules – Hyprland Wiki — Mozilla Firefox', 2],
  ['0x5f2a10', 'kitty', 'nvim vitest.config.ts — aurora-web', 1],
  ['0x5f3b70', 'Spotify', 'Spotify Premium', 9],
  ['0x5f4d20', 'obsidian', 'Release checklist – Obsidian', 3],
].map(([address, cls, title, workspace]) => ({ address, class: cls, initialClass: cls, title, workspace: { id: workspace, name: String(workspace) }, pid: 4000 + workspace, mapped: true, hidden: false }));
function hyprctl() {
  if (args.includes('clients')) console.log(JSON.stringify(windows));
  else if (args.includes('monitors')) console.log(JSON.stringify([{ id: 0, name: 'Primary', width: 1920, height: 1080, focused: true }]));
  else if (args[0] !== 'dispatch') process.exit(1);
}
function busctl() {
  const call = args.slice(args.indexOf('--json=short') + 1);
  const reply = data => console.log(JSON.stringify({ type: 'x', data }));
  if (call.includes('ListNames')) reply([['org.freedesktop.DBus', 'org.mpris.MediaPlayer2.spotify']]);
  else if (call.includes('GetAll')) reply([{ PlaybackStatus: { type: 's', data: 'Playing' }, CanControl: { type: 'b', data: true }, CanPlay: { type: 'b', data: true }, CanPause: { type: 'b', data: true }, CanGoNext: { type: 'b', data: true }, CanGoPrevious: { type: 'b', data: true } }]);
  else if (call.includes('Identity')) reply('Spotify');
}

if (role === 'codex') { if (args.includes('--version')) console.log('codex-cli 0.162.1'); else codex(); }
else if (role === 'claude') claude();
else if (role === 'agy') antigravity();
else if (role === 'ollama') ollama();
else if (role === 'hyprctl') hyprctl();
else if (role === 'busctl') busctl();
else if (role === 'wpctl') { if (args[0] === 'get-volume') console.log('Volume: 0.45'); }
else if (role === 'check') console.log(args[0] === 'test' ? 'Test Files  64 passed (64)\n     Tests  412 passed (412)\n  Duration  52.3s' : 'Notes backed up.');
else if (role !== 'quiet') { console.error('Usage: fixture.mjs codex|claude|agy|ollama|hyprctl|busctl|wpctl|check|quiet'); process.exit(2); }
