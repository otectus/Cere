import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink, stat, chmod, copyFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { privateDir } from '../broker/paths.ts';
import { request } from '../broker/client.ts';
import { applications, desktopAction } from '../broker/desktop.ts';
import { publicAddress, createWebLoader, webUrl } from '../broker/web.ts';
import { MESSAGE_FRAME_BYTES, PAGE_BYTES } from '../broker/transcript.ts';
import type { Hooks } from '../broker/providers.ts';
import type { Session, Settings } from '../broker/types.ts';
import { seedAndRecall } from '../tools/check-knowledge.ts';

async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}
/** Replaces environment variables for one test and restores them afterwards. */
function environment(t: any, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}
async function directory(t: any, prefix = 'cere-review-core-') {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function ollamaSession(core: Core, cwd: string): Session {
  const now = Date.now();
  const session: Session = { id: crypto.randomUUID(), provider: 'ollama', nativeId: null, title: 'Tools', cwd, mode: 'managed', status: 'idle',
    created: now, updated: now, draft: '', scroll: 0, model: 'fixture', ollama: { host: 'http://127.0.0.1:9', tools: true } };
  core.store.saveSession(session); return session;
}

/** A Core whose action memory bookkeeping can be held at the "authorized" phase. */
async function heldAction(t: any) {
  const dir = await directory(t), log = join(dir, 'executions.log');
  const core = new Core(new Store(join(dir, 'state')), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(() => core.close());
  const session = ollamaSession(core, dir);
  let release!: () => void, held = false;
  core.memory.active = () => true;
  core.memory.actionEvent = async (_s: Session, _a: string, _e: string, phase: string) => {
    if (phase === 'authorized') { held = true; await new Promise<void>(r => { release = r; }); }
  };
  const script = { id: 'mark', name: 'Mark', executable: '/bin/sh', args: ['-c', 'printf x >> "$0"', log], cwd: dir, timeout: 5000 };
  const executions = async () => (await readFile(log, 'utf8').catch(() => '')).length;
  const run = async (settings: any, change?: () => Promise<unknown>, manual = false) => {
    held = false;const {bypassCliPermissions,...ordinary}=settings;await core.updateSettings({scripts:[script],...ordinary});if(bypassCliPermissions)await core.power.start({sessionIds:[session.id],minutes:5,cli:true,computer:false});
    const action = core.action('script.run', { id: 'mark' }, session.id);
    if (manual) { await until(() => core.approvals.size === 1); core.answer({ id: core.snapshot().approvals[0].id, choice: 'allow' }); }
    await until(() => held);
    await change?.();
    release();
    return action;
  };
  return { core, dir, session, run, executions };
}

test('F-001 revoking automatic authority while an action awaits bookkeeping prevents execution', async t => {
  const f = await heldAction(t);
  const grant = () => [{ category: 'scripts', cwd: f.dir, expires: Date.now() + 3600000 }];
  await assert.rejects(f.run({ profile: 'broad', categories: ['scripts'], grants: grant() }, () => f.core.updateSettings({ grants: [] })), /revoked/);
  await assert.rejects(f.run({ profile: 'broad', categories: ['scripts'], grants: [{ category: 'scripts', cwd: f.dir, expires: Date.now() + 300 }] }, () => new Promise(r => setTimeout(r, 400))), /revoked/);
  await assert.rejects(f.run({ profile: 'broad', categories: ['scripts'], grants: grant() }, () => f.core.updateSettings({ profile: 'scoped' })), /revoked/);
  await assert.rejects(f.run({ profile: 'scoped', categories: ['scripts'], grants: [], bypassCliPermissions: true }, () => f.core.power.end(f.core.power.snapshot().find(p=>p.state==='active')!.id)), /revoked|Power access ended/);
  assert.equal(f.core.approvals.size, 0, 'no allow response was requested or invented');
  assert.equal(await f.executions(), 0);
  // A still-valid grant and an explicit allow each execute exactly once.
  await f.run({ profile: 'broad', categories: ['scripts'], grants: grant() });
  assert.equal(await f.executions(), 1);
  await f.run({ profile: 'scoped', categories: ['scripts'], grants: [], bypassCliPermissions: false }, () => f.core.updateSettings({ grants: [] }), true);
  assert.equal(await f.executions(), 2);
});

test('F-002 private directories reject foreign owners, shared-directory symlinks and writable ancestors', async t => {
  const dir = await directory(t), created = join(dir, 'a', 'b', 'cere');
  privateDir(created);
  assert.equal((await stat(created)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'a'))).mode & 0o777, 0o700);
  const uid = process.getuid!();
  // A directory another user owns is rejected without modification.
  const foreign = join(dir, 'foreign'); await mkdir(foreign); await chmod(foreign, 0o755);
  assert.throws(() => privateDir(join(foreign, 'cere'), uid + 1), /owned by another user/);
  assert.equal((await stat(foreign)).mode & 0o777, 0o755);
  assert.ok(!existsSync(join(foreign, 'cere')));
  // A symlinked base inside a shared sticky directory, and a non-sticky shared ancestor.
  const shared = join(dir, 'shared'); await mkdir(shared); await chmod(shared, 0o1777);
  await mkdir(join(dir, 'target'), { mode: 0o700 }); await symlink(join(dir, 'target'), join(shared, 'cere-base'));
  assert.throws(() => privateDir(join(shared, 'cere-base', 'cere')), /symbolic link in a shared directory/);
  const open = join(dir, 'open'); await mkdir(open); await chmod(open, 0o777);
  assert.throws(() => privateDir(join(open, 'cere')), /writable by other users/);
  assert.ok(!existsSync(join(open, 'cere')));
  // Existing fallback layout: /tmp is sticky and shared, so its child must be ours.
  privateDir(join(shared, 'cere-owned', 'cere'));
  assert.equal((await stat(join(shared, 'cere-owned', 'cere'))).mode & 0o777, 0o700);
});

test('F-002 clients refuse a broker socket owned by another user before sending anything', async t => {
  const dir = await directory(t), received: string[] = [];
  environment(t, { CERE_RUNTIME_DIR: dir });
  const server = net.createServer(socket => { socket.on('data', chunk => { received.push(String(chunk)); socket.write('{"id":1,"result":{"forged":true}}\n'); }); });
  await new Promise<void>(resolve => server.listen(join(dir, 'broker.sock'), resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await assert.rejects(request('state', {}, 2000, process.getuid!() + 1), /another user/);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(received, [], 'no RPC payload reached the untrusted server');
  assert.deepEqual(await request('state', {}, 2000), { forged: true }, 'the same-user server still works');
});

test('F-007 Stop is bounded when interruption never acknowledges and the session accepts the next turn', async t => {
  const dir = await directory(t); let sends = 0;
  const core = new Core(new Store(dir), () => ({ async send() { sends++; }, interrupt: () => new Promise<void>(() => {}), async close() {} }));
  t.after(() => core.close());
  core.stopDeadlineMs = 150;
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  await core.send({ id: session.id, text: 'work' });
  const started = performance.now();
  await core.stop(session.id);
  assert.ok(performance.now() - started < 1000);
  assert.equal(core.store.session(session.id).status, 'interrupted');
  await core.send({ id: session.id, text: 'next' });
  assert.equal(sends, 2);
  // A force-close that itself hangs is bounded too.
  const stuck = new Core(new Store(join(dir, 'second')), () => ({ async send() {}, interrupt: () => new Promise<void>(() => {}), close: () => new Promise<void>(() => {}) }));
  t.after(() => stuck.close());
  stuck.stopDeadlineMs = 100; stuck.forceCloseMs = 100;
  const other = await stuck.create({ provider: 'codex', cwd: dir, trusted: true });
  await stuck.send({ id: other.id, text: 'work' });
  await stuck.stop(other.id);
  assert.equal(stuck.store.session(other.id).status, 'interrupted');
});

/** Fake desktop tools; the Satty editor stays open until it is killed. */
async function captureFixture(t: any) {
  const dir = await directory(t);
  environment(t, { PATH: dir + ':' + process.env.PATH, CERE_STATE_DIR: dir, CERE_DESKTOP_FIXTURE: dir });
  const script = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),tool=path.basename(process.argv[1]),a=process.argv.slice(2),dir=process.env.CERE_DESKTOP_FIXTURE;
if(tool==='hyprctl')console.log(JSON.stringify([{name:'test-output',focused:true}]));
else if(tool==='grim')fs.writeFileSync(a.at(-1),'raw');
else if(tool==='satty'&&!a.includes('--version')){fs.writeFileSync(path.join(dir,'satty.pid'),String(process.pid));setInterval(()=>{},1000);}
else if(tool==='sleeper'){fs.writeFileSync(path.join(dir,'sleeper.pid'),String(process.pid));setInterval(()=>{},1000);}
`;
  await writeFile(join(dir, 'fake.cjs'), script, { mode: 0o755 });
  for (const name of ['hyprctl', 'grim', 'satty', 'sleeper']) await symlink(join(dir, 'fake.cjs'), join(dir, name));
  const alive = async (name: string) => { try { process.kill(Number(await readFile(join(dir, name + '.pid'), 'utf8')), 0); return true; } catch { return false; } };
  return { dir, alive };
}

test('F-007 Stop and shutdown terminate an open Satty editor, remove the raw image and release the lock', async t => {
  const f = await captureFixture(t);
  const controller = new AbortController();
  const capture = desktopAction('screenshot.capture', {}, {} as Settings, controller.signal);
  await until(() => existsSync(join(f.dir, 'satty.pid')));
  controller.abort(new Error('Stopped by the user'));
  await assert.rejects(capture, (error: any) => error.name === 'AbortError' && /Stopped/.test(String(error.cause?.message)));
  await until(async () => !(await f.alive('satty')));
  assert.deepEqual((await readdir(join(f.dir, 'captures'))).filter(n => n.startsWith('.capture-')), []);
  await rm(join(f.dir, 'satty.pid'));
  // The capture lock is released: a user-started capture runs again, and shutdown cancels it.
  const core = new Core(new Store(join(f.dir, 'state')));
  const started = core.rpc('action.run', { name: 'screenshot.capture' }).then(() => null, (error: any) => error);
  await until(() => existsSync(join(f.dir, 'satty.pid')));
  const closing = performance.now();
  await core.close();
  assert.ok(performance.now() - closing < 4000);
  assert.match(String((await started)?.cause?.message), /closing/);
  await until(async () => !(await f.alive('satty')));
});

test('F-007 Stop cancels an MCP-originated saved script in flight', async t => {
  const f = await captureFixture(t);
  const core = new Core(new Store(join(f.dir, 'state')), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(() => core.close());
  const session = await core.create({ provider: 'codex', cwd: f.dir, trusted: true });
  await core.updateSettings({ scripts: [{ id: 'long', name: 'Long', executable: join(f.dir, 'sleeper'), args: [], cwd: f.dir, timeout: 600000 }] });
  await core.power.start({sessionIds:[session.id],minutes:5,cli:true,computer:false});
  core.tokens.set('mcp', session.id);
  await core.send({ id: session.id, text: 'run the script' });
  const call = core.rpc('mcp.call', { token: 'mcp', name: 'script.run', args: { id: 'long' } });
  await until(() => existsSync(join(f.dir, 'sleeper.pid')));
  await core.stop(session.id);
  await assert.rejects(call);
  await until(async () => !(await f.alive('sleeper')));
});

test('F-008 only the special 192.0.0.0/24 and documentation blocks are excluded from 192.0/16', async () => {
  for (const ip of ['192.0.78.24', '192.0.66.80', '192.0.3.1', '192.0.1.255', '192.1.0.1', '191.255.255.255', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
  for (const ip of ['192.0.0.1', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1', '10.1.1.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', 'ff02::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(webUrl('http://192.0.78.24/').hostname, '192.0.78.24');
  const pinned: string[] = [];
  const transport = (answers: { address: string; family: number }[]) => createWebLoader({
    lookup: async () => answers,
    request: ((url: URL, options: any, callback: (res: any) => void) => {
      options.lookup(url.hostname, {}, (_error: unknown, address: string) => pinned.push(address));
      const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/html' } });
      queueMicrotask(() => { callback(response); response.emit('data', Buffer.from('<p>ok</p>')); response.emit('end'); });
      return Object.assign(new EventEmitter(), { end() {} });
    }) as any,
  });
  const page = await transport([{ address: '192.0.78.24', family: 4 }])('https://example.com/', new AbortController().signal);
  assert.equal(page.status, 200); assert.deepEqual(pinned, ['192.0.78.24']);
  await assert.rejects(transport([{ address: '192.0.78.24', family: 4 }, { address: '192.168.1.1', family: 4 }])('https://example.com/', new AbortController().signal), /private or reserved/);
});

test('F-022 nested vendor desktop entries are discovered and launched by derived ID', async t => {
  const dir = await directory(t), home = join(dir, 'home', 'applications'), system = join(dir, 'system', 'applications'), log = join(dir, 'launch.log');
  await mkdir(join(home, 'vendor'), { recursive: true }); await mkdir(join(system, 'vendor', 'loop'), { recursive: true });
  const entry = (name: string, extra = '') => `[Desktop Entry]\nType=Application\nName=${name}\nExec=true\n${extra}`;
  await writeFile(join(home, 'vendor', 'sample.desktop'), entry('Nested Sample'));
  await writeFile(join(home, 'vendor', 'hidden.desktop'), entry('Hidden Override', 'Hidden=true\n'));
  await writeFile(join(system, 'vendor', 'hidden.desktop'), entry('Should Stay Hidden'));
  await writeFile(join(system, 'vendor-sample.desktop'), entry('Lower Priority Duplicate'));
  await writeFile(join(system, 'vendor', 'other.desktop'), entry('Lower Root App'));
  await symlink(join(system, 'vendor'), join(system, 'vendor', 'loop', 'again'));
  await writeFile(join(dir, 'gtk-launch'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  environment(t, { XDG_DATA_HOME: join(dir, 'home'), XDG_DATA_DIRS: join(dir, 'system'), PATH: dir + ':' + process.env.PATH });
  const apps = await applications();
  assert.deepEqual(apps.map(a => [a.id, a.name]), [['vendor-other.desktop', 'Lower Root App'], ['vendor-sample.desktop', 'Nested Sample']]);
  await desktopAction('apps.launch', { desktopId: 'vendor-sample.desktop' }, {} as Settings);
  assert.equal((await readFile(log, 'utf8')).trim(), 'vendor-sample.desktop');
});

test('F-023 transcripts larger than the frame limits load through bounded pages', async t => {
  const dir = await directory(t);
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(() => core.close());
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  const body = (i: number) => `${i} ` + 'ü"\\\n✦'.repeat(210_000);
  for (let i = 0; i < 17; i++) core.store.message({ id: `m${i}`, sessionId: session.id, role: 'assistant', text: body(i), time: i });
  core.store.message({ id: 'huge', sessionId: session.id, role: 'assistant', text: 'x'.repeat(3 * 1024 * 1024) + 'END', time: 18 });
  const seen: string[] = [], byId: Record<string, any> = {}; let before: number | null = null, pages = 0;
  do {
    const page: any = await core.rpc('session.messages', before === null ? { id: session.id } : { id: session.id, before });
    assert.ok(Buffer.byteLength(JSON.stringify({ id: 1, result: page })) <= PAGE_BYTES + 1024, 'page within its byte budget');
    for (const message of page.messages) { assert.ok(!seen.includes(message.id)); seen.push(message.id); byId[message.id] = message; }
    // A message streamed in while paging does not disturb older-page cursors.
    if (pages === 0) core.putMessage({ id: 'late', sessionId: session.id, role: 'assistant', text: 'late', time: 99 });
    before = page.hasMore ? page.before : null; pages++;
  } while (before !== null && pages < 100);
  assert.deepEqual(seen.filter(id => id !== 'late').sort(), [...Array.from({ length: 17 }, (_, i) => `m${i}`), 'huge'].sort());
  const huge = byId.huge;
  assert.equal(huge.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= MESSAGE_FRAME_BYTES);
  let text = '', offset: number | null = 0;
  while (offset !== null) { const chunk: any = await core.rpc('session.messageText', { id: session.id, messageId: 'huge', offset }); text += chunk.text; offset = chunk.next; }
  assert.equal(text.length, 3 * 1024 * 1024 + 3); assert.ok(text.endsWith('END'));
  const events: any[] = []; core.on('message', m => events.push(m));
  core.putMessage({ id: 'huge-live', sessionId: session.id, role: 'assistant', text: '✦'.repeat(2 * 1024 * 1024), time: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(events[0])) <= MESSAGE_FRAME_BYTES, 'live events are frame bounded');
});

test('F-024 overlapping sweeps deliver each due timer once and never a cancelled one', async t => {
  const dir = await directory(t), notes = join(dir, 'notified.log');
  await writeFile(join(dir, 'notify-send'), `#!/bin/sh\necho "$3" >> ${JSON.stringify(notes)}\nsleep 1.1\n`, { mode: 0o755 });
  environment(t, { PATH: dir + ':' + process.env.PATH });
  // The real one-second ticker with a notifier slower than its period.
  const core = new Core(new Store(join(dir, 'state')));
  t.after(() => core.close());
  const notices: string[] = []; core.on('notice', n => { if (n.kind === 'timer') notices.push(n.text); });
  for (const [id, label, due] of [['a', 'First', 1], ['b', 'Second', 1], ['c', 'Cancelled', 2], ['d', 'Future', Date.now() + 3000]] as const) core.store.timer({ id, label, due });
  await until(() => notices.length === 1);
  core.store.removeTimer('c'); // cancelled while the first notification is still running
  await until(() => notices.includes('Future'), 8000);
  await new Promise(r => setTimeout(r, 1300));
  assert.deepEqual(notices, ['First', 'Second', 'Future']);
  // A stale sweep started while another is mid-notification cannot redeliver: each timer is claimed atomically.
  const stale = new Core(new Store(join(dir, 'stale')));
  t.after(() => stale.close());
  clearInterval(stale.ticker);
  const delivered: string[] = []; stale.on('notice', n => { if (n.kind === 'timer') delivered.push(n.text); });
  for (const [id, label] of [['x', 'One'], ['y', 'Two']]) stale.store.timer({ id, label, due: 1 });
  const first = stale.checkTimers();
  await until(() => delivered.length === 1);
  stale.checkingTimers = false; // bypass the in-flight guard to force the overlap
  await Promise.all([first, stale.checkTimers()]);
  assert.deepEqual(delivered.sort(), ['One', 'Two']);
});

test('F-038 the first explicit submit after a Codex exit resumes the same thread once', async t => {
  const dir = await directory(t), log = join(dir, 'requests.jsonl');
  environment(t, { CERE_CODEX_BIN: resolve('tests/fixtures/permissions-cli.mjs'), CERE_PERMISSION_TEST_LOG: log });
  const core = new Core(new Store(join(dir, 'state')));
  t.after(() => core.close());
  await core.updateSettings({ personality: 'Be calm.' });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  await core.send({ id: session.id, text: 'first' });
  await until(() => core.store.session(session.id).status === 'idle');
  const adapter: any = core.adapters.get(session.id);
  adapter.process.child.kill('SIGKILL');
  await until(() => core.store.session(session.id).status === 'error');
  await core.send({ id: session.id, text: 'resume' });
  await until(() => core.store.session(session.id).status === 'idle');
  const messages = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(messages.filter(m => m.method === 'turn/start').map(m => m.params.input[0].text), ['first', 'resume']);
  const resumed = messages.filter(m => m.method === 'thread/resume');
  assert.equal(resumed.length, 1); assert.equal(resumed[0].params.threadId, 'permission-thread');
  assert.match(resumed[0].params.developerInstructions, /Be calm/); assert.equal(resumed[0].params.approvalPolicy, 'on-request');
});

test('F-041 management edits must carry the revision they started from', async t => {
  const dir = await directory(t);
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(() => core.close());
  const session = ollamaSession(core, dir);
  const note = await core.rpc('memory.save', { sessionId: session.id, text: 'Original owner text.' });
  const listed = (await core.rpc('memory.list', { sessionId: session.id })).rows[0];
  await assert.rejects(core.rpc('memory.save', { sessionId: session.id, id: note.id, text: 'Unguarded edit.' }), /requires its current revision/);
  await core.rpc('memory.save', { sessionId: session.id, id: note.id, text: 'Fresh owner correction.', expected_revision: listed.revision });
  await assert.rejects(core.rpc('memory.save', { sessionId: session.id, id: note.id, text: 'Stale editor text.', expected_revision: listed.revision }), { code: 'REVISION_CONFLICT' });
  assert.equal((await core.rpc('memory.list', { sessionId: session.id })).rows[0].text, 'Fresh owner correction.');
});

test('F-044 the knowledge checker commits both saves before recall and awaits listings', async t => {
  const order: string[] = [];
  const memory = {
    async save(_s: Session, text: string) { await new Promise(r => setTimeout(r, 30)); order.push('saved:' + text.slice(0, 12)); },
    async recall() { order.push('recall'); return { mode: 'semantic', results: [{ text: 'espresso' }] }; },
  };
  await seedAndRecall(memory, {} as Session, 'query');
  assert.deepEqual(order, ['saved:For this tes', 'saved:The release ', 'recall']);
  await assert.rejects(seedAndRecall({ ...memory, recall: async () => ({ mode: 'keyword', warning: 'semantic_degraded', results: [] }) }, {} as Session, 'q'), /degraded by a memory dependency/);
  // The documented memory-only live check, driven end to end against a local fixture.
  const chats: any[] = [];
  const server = createHttpServer(async (req, res: ServerResponse) => {
    let text = ''; for await (const chunk of req) text += chunk; const body = text ? JSON.parse(text) : {};
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ model: 'fixture-chat', capabilities: ['completion', 'tools'], digest: 'e'.repeat(64) }, { model: 'nomic-embed-text:latest', capabilities: ['embedding'], digest: 'f'.repeat(64) }] }));
    else if (req.url === '/api/show') res.end(JSON.stringify({ capabilities: body.model === 'fixture-chat' ? ['completion', 'tools'] : ['embedding'] }));
    else if (req.url === '/api/embed') res.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) }));
    else if (req.url === '/api/chat') { chats.push(body); res.end(JSON.stringify({ message: { role: 'assistant', content: chats.length === 1 ? '' : 'Saved.', ...(chats.length === 1 ? { tool_calls: [{ function: { name: 'memory_save', arguments: { text: 'My project’s mascot is a silver otter.' } } }] } : {}) }, done: true }) + '\n'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const child = spawn(process.execPath, ['tools/check-knowledge.ts', 'fixture-chat', '--memory-only'], { env: { ...process.env, CERE_OLLAMA_HOST: 'http://127.0.0.1:' + (server.address() as any).port }, stdio: 'pipe' });
  let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
  assert.equal((await once(child, 'close'))[0], 0, output);
  const report = JSON.parse(await readFile(join(/Evidence: (.*)/.exec(output)![1], 'report.json'), 'utf8'));
  assert.deepEqual(report.checks.map((c: any) => c.name), ['model saves a durable memory on request']);
  await rm(/Evidence: (.*)/.exec(output)![1], { recursive: true, force: true });
});

test('F-045 the dependency script signals only a verified Qdrant process', async t => {
  const home = await directory(t, 'cere-deps-');
  await mkdir(join(home, 'run')); await mkdir(join(home, 'qdrant'));
  await copyFile('/usr/bin/sleep', join(home, 'qdrant', 'qdrant')); await chmod(join(home, 'qdrant', 'qdrant'), 0o755);
  const stop = async () => { const child = spawn('bash', ['tools/memory-dependencies.sh', 'local-stop'], { env: { ...process.env, CERE_MEMORY_DEPS_HOME: home }, stdio: 'ignore' }); return (await once(child, 'close'))[0]; };
  const startTime = async (pid: number) => (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const unrelated = spawn('sleep', ['60']); t.after(() => unrelated.kill());
  for (const record of [`${unrelated.pid}`, `${unrelated.pid} ${await startTime(unrelated.pid!)} /usr/bin/sleep`, '0', '1', 'abc', '']) {
    await writeFile(join(home, 'run', 'qdrant.pid'), record + '\n');
    assert.equal(await stop(), 0);
    assert.ok(alive(unrelated.pid!), `record "${record}" must not signal`);
    assert.ok(!existsSync(join(home, 'run', 'qdrant.pid')), 'a stale record is removed');
  }
  const qdrant = spawn(join(home, 'qdrant', 'qdrant'), ['60']);
  await until(() => existsSync(`/proc/${qdrant.pid}/exe`));
  const exe = await realpath(join(home, 'qdrant', 'qdrant'));
  await writeFile(join(home, 'run', 'qdrant.pid'), `${qdrant.pid} ${Number(await startTime(qdrant.pid!)) + 1} ${exe}\n`);
  assert.equal(await stop(), 0);
  assert.ok(alive(qdrant.pid!), 'a start-time mismatch (PID reuse) is never signaled');
  await writeFile(join(home, 'run', 'qdrant.pid'), `${qdrant.pid} ${await startTime(qdrant.pid!)} ${exe}\n`);
  const exited = once(qdrant, 'exit');
  assert.equal(await stop(), 0);
  await exited;
  assert.ok(!existsSync(join(home, 'run', 'qdrant.pid')));
});

test('F-046 history discovery uses the configured Codex executable', async t => {
  const dir = await directory(t);
  environment(t, { CERE_CODEX_BIN: resolve('tests/fixtures/permissions-cli.mjs'), CERE_PERMISSION_TEST_LOG: join(dir, 'log.jsonl'), PATH: '/usr/bin:/bin' });
  const core = new Core(new Store(dir));
  t.after(() => core.close());
  const history = await core.history('codex');
  assert.deepEqual(history.map((h: any) => [h.nativeId, h.title]), [['fixture-history-thread', 'Fixture history']]);
});

test('F-043 atlas extraction names its external input and writes nothing without it', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'cere-atlas-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const child = spawn('python3', [resolve('tools/prepare-assets.py'), '--input', join(output, 'missing.gif'), '--output', join(output, 'assets')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(stderr, /not distributed with this repository/);
  assert.match(stderr, /--input PATH/);
  assert.deepEqual(await readdir(output), [], 'the preflight fails before creating or writing anything');
  const readme = await readFile('README.md', 'utf8');
  assert.match(readme, /prepare-assets\.py --input PATH/);
  assert.doesNotMatch(readme, /original GIFs remain intact/);
});
