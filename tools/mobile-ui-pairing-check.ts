#!/usr/bin/env node
/**
 * Network-return pairing through the app's own pairing screen, for a build without instrumentation
 * (the R8 development snapshot). On a test emulator, against an isolated broker with fixture
 * providers: installs the APK with its data cleared, pastes a trusted-device network-return offer
 * into the pairing screen, taps Verify offer, then — as the owner at the desktop — checks that the
 * six words the phone shows are the ones the desktop received and confirms. The phone must finish
 * and sign in by itself, without a crash.
 *
 *   node tools/mobile-ui-pairing-check.ts --apk APP.apk [--serial SERIAL] [--evidence DIR] [--package ID]
 */
import { fileURLToPath } from 'node:url';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { brokerFrameLimit } from '../broker/fanout.ts';
import { JsonLines } from '../broker/wire.ts';
import { Store } from '../broker/store.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const serial = option('--serial', process.env.ANDROID_SERIAL), appPackage = option('--package', 'dev.otectus.cere.mobile.debug')!, apk = option('--apk');
if (!apk) throw new Error('Give --apk');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidence = resolve(option('--evidence', join('build', 'mobile-ui-pairing', new Date().toISOString().replace(/[:.]/g, '-')))!);
const log: string[] = [];
const note = (line: string) => { const stamped = `[${new Date().toISOString()}] ${line}`; log.push(stamped); console.log(stamped); };
const adb = (params: string[], timeout = 120_000, allowFailure = false) => new Promise<string>((resolvePromise, reject) => {
  execFile('adb', [...(serial ? ['-s', serial] : []), ...params], { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => { if (error && !allowFailure) reject(new Error(`adb ${params.join(' ')}: ${stderr || error.message}`)); else resolvePromise(String(stdout)); });
});
const until = async <T>(what: string, check: () => Promise<T | undefined>, timeout: number) => {
  const end = Date.now() + timeout;
  for (;;) { const value = await check().catch(() => undefined); if (value !== undefined) return value; if (Date.now() > end) throw new Error(`Timed out after ${timeout / 1000} s waiting for ${what}`); await new Promise(r => setTimeout(r, 500)); }
};
async function freePort() { const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r())); return port; }
function brokerRequest(socketPath: string, method: string, params: any = {}, timeout = 30_000): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(socketPath), lines = new JsonLines(brokerFrameLimit);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${method}: the isolated broker did not respond`)); }, timeout);
    const done = (error?: Error, value?: any) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolvePromise(value); };
    socket.setEncoding('utf8'); socket.on('error', error => done(error));
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    socket.on('data', chunk => { try { lines.push(String(chunk), m => { if (m.id === 1) done(m.error ? new Error(m.error.message) : undefined, m.result); }); } catch (error: any) { done(error); } });
  });
}
type Node = { text: string; desc: string; cls: string; bounds: [number, number, number, number] };
async function screen(): Promise<Node[]> {
  await adb(['shell', 'uiautomator', 'dump', '/sdcard/cere-ui.xml'], 30_000, true);
  const xml = await adb(['exec-out', 'cat', '/sdcard/cere-ui.xml'], 30_000, true);
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
  return [...xml.matchAll(/<node [^>]*>/g)].map(match => {
    const attribute = (name: string) => decode(new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1] ?? '');
    const box = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(match[0]);
    return { text: attribute('text'), desc: attribute('content-desc'), cls: attribute('class'), bounds: box ? [Number(box[1]), Number(box[2]), Number(box[3]), Number(box[4])] as [number, number, number, number] : [0, 0, 0, 0] };
  });
}
async function tap(node: Node) { const [l, t, r, b] = node.bounds; await adb(['shell', 'input', 'tap', String(Math.round((l + r) / 2)), String(Math.round((t + b) / 2))]); }

const summary: Record<string, unknown> = { started: new Date().toISOString(), serial: serial ?? 'default', package: appPackage };
let broker: ChildProcess | undefined, ollama: ChildProcess | undefined, brokerLog = '', port = 0, exitCode = 1, reverseAdded = false;
const work = await mkdtemp(join(tmpdir(), 'cere-ui-pair-'));
const state = join(work, 'state'), runtime = join(work, 'run'), project = join(work, 'project'), home = join(work, 'home'), socketPath = join(runtime, 'broker.sock');
try {
  await mkdir(evidence, { recursive: true }); await mkdir(project); await mkdir(home);
  ollama = spawn(process.execPath, [join(root, 'tests/fixtures/ui-ollama.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ollamaHost = await new Promise<string>((resolvePromise, reject) => { ollama!.stdout!.once('data', chunk => resolvePromise(String(chunk).trim())); ollama!.once('exit', () => reject(new Error('Ollama fixture exited'))); });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', CERE_STATE_DIR: state, CERE_RUNTIME_DIR: runtime, CERE_TTS_DISABLED: '1',
    CERE_OLLAMA_HOST: ollamaHost, CERE_CODEX_BIN: join(root, 'tests/fixtures/ui-codex.mjs'), CERE_CLAUDE_BIN: join(work, 'absent-claude'), CERE_ANTIGRAVITY_BIN: join(work, 'absent-antigravity') };
  const store = new Store(state); store.set('settings', { memory: { enabled: false } }); store.close();
  broker = spawn(process.execPath, [join(root, 'broker/main.ts')], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  broker.stdout!.on('data', chunk => { brokerLog += chunk; }); broker.stderr!.on('data', chunk => { brokerLog += chunk; });
  await until('the isolated broker', async () => (await brokerRequest(socketPath, 'remote.status', {}, 1000)) ? true : undefined, 30_000);
  port = await freePort();
  await adb(['reverse', '--no-rebind', `tcp:${port}`, `tcp:${port}`]); reverseAdded = true;
  await adb(['install', '-r', apk]); await adb(['shell', 'pm', 'clear', appPackage]);
  for (const permission of ['android.permission.POST_NOTIFICATIONS', 'android.permission.ACCESS_LOCAL_NETWORK']) await adb(['shell', 'pm', 'grant', appPackage, permission], 30_000, true);
  const prepared = await brokerRequest(socketPath, 'remote.preparePair', { addresses: ['127.0.0.1'], port, name: 'Cere UI pairing check', actionAuthentication: 'trusted-device', networkReturn: true });
  await adb(['logcat', '-c'], 30_000, true);
  await adb(['shell', 'am', 'start', '-W', '-n', `${appPackage}/dev.otectus.cere.mobile.MainActivity`]);
  // Scanning remains the primary first-use action; reveal the text fallback explicitly.
  await tap(await until('manual pairing', async () => (await screen()).find(node => node.text === 'Enter offer instead'), 30_000));
  // The offer goes into the second field (the first names this phone), as pasting it would.
  const field = await until('the pairing offer field', async () => (await screen()).filter(node => node.cls === 'android.widget.EditText')[1], 30_000);
  // Typed in short pieces: one long `input text` loses characters on the way through the keyboard.
  await tap(field); for (let start = 0; start < prepared.uri.length; start += 100) await adb(['shell', 'input', 'text', prepared.uri.slice(start, start + 100)], 60_000);
  await adb(['shell', 'input', 'keyevent', '111']);
  await tap(await until('Verify offer', async () => (await screen()).find(node => node.text === 'Verify offer'), 30_000));
  // At the desktop: the answer arrives by itself, and the words the phone shows are the desktop's.
  const received = await until('the phone\'s answer at the desktop', async () => (await brokerRequest(socketPath, 'remote.status', {}, 5000)).pairing?.received, 60_000);
  const shown = await until('the six words on the phone', async () => (await screen()).some(node => node.text === received.sas) ? true : undefined, 30_000);
  summary.wordsMatched = shown; note(`The phone shows the desktop's words ("${received.sas}"); confirming by pairing ID`);
  const device = await brokerRequest(socketPath, 'remote.confirmPair', { pairingId: prepared.pairingId, sas: received.sas, confirmed: true, projectPaths: [project], caps: ['chat.read', 'chat.write', 'approvals.answer'], categories: [], scriptIds: [] });
  summary.signedIn = await until('the phone to sign in', async () => { const status = await brokerRequest(socketPath, 'remote.status'); return (status.devices as { id: string; lastSeen?: number }[]).some(entry => entry.id === device.id && typeof entry.lastSeen === 'number') ? true : undefined; }, 60_000);
  summary.appShell = await until('the app after pairing', async () => (await screen()).some(node => node.text === 'Search conversations' || node.text === 'Sessions') ? true : undefined, 30_000);
  const crashes = (await adb(['logcat', '-d', '-s', 'AndroidRuntime:E'], 30_000, true)).split('\n').filter(line => /FATAL EXCEPTION/.test(line));
  summary.fatalExceptions = crashes.length; summary.processAlive = !!(await adb(['shell', 'pidof', appPackage], 15_000, true)).trim();
  note(`Signed in as ${device.id}; fatal exceptions ${crashes.length}; process alive ${summary.processAlive}`);
  exitCode = crashes.length === 0 && summary.processAlive === true ? 0 : 1;
} catch (error: any) {
  note(`ERROR ${error?.stack || error}`);
  await new Promise<void>(done => execFile('adb', [...(serial ? ['-s', serial] : []), 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (_error, png) => { void writeFile(join(evidence, 'failure-screen.png'), png).finally(done); }));
} finally {
  summary.finished = new Date().toISOString(); summary.passed = exitCode === 0;
  try {
    const logcat = await adb(['logcat', '-d', '-v', 'threadtime'], 30_000, true).catch(() => '');
    await writeFile(join(evidence, 'logcat.txt'), logcat.split('\n').filter(line => /Cere|cere|AndroidRuntime/.test(line)).join('\n'));
    await writeFile(join(evidence, 'broker.log'), brokerLog); await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); await writeFile(join(evidence, 'harness.log'), log.join('\n') + '\n');
  } catch (error) { console.error('Could not write evidence:', error); exitCode = 1; }
  if (reverseAdded) await adb(['reverse', '--remove', 'tcp:' + port], 30_000, true);
  if (broker?.pid) { try { process.kill(-broker.pid, 'SIGTERM'); } catch {} await new Promise(r => setTimeout(r, 1500)); try { process.kill(-broker.pid, 'SIGKILL'); } catch {} }
  ollama?.kill('SIGTERM');
  await rm(work, { recursive: true, force: true });
  console.log(`Evidence: ${evidence}`);
  console.log(exitCode === 0 ? 'UI PAIRING CHECK PASSED' : 'UI PAIRING CHECK FAILED');
  process.exit(exitCode);
}
