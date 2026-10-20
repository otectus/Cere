#!/usr/bin/env node
/**
 * Phone-to-broker interoperability gate. Starts an isolated broker with fixture providers (no owner
 * account, profile or desktop session), pairs the installed debug app to it over `adb reverse` with a
 * trusted-device offer, then runs the paired instrumentation tests with their explicit arguments:
 * UsbPairingSetupTest#pairFromExplicitUsbOffer, then ConnectedDesktopTest against a synthetic Ollama
 * conversation. Unlike `connectedDebugAndroidTest`, which skips these without arguments, every test
 * here must report a pass; a skip, an assumption failure or a missing result fails the gate.
 *
 *   node tools/mobile-paired-check.ts [--serial SERIAL] [--evidence DIR] [--package ID] [--keep-pairing]
 *
 * The debug app and its instrumentation APK must already be installed (`:app:installDebug
 * :app:installDebugAndroidTest`). The app's data is cleared first, so run it only on a test emulator
 * or a device whose Cere Mobile pairing may be discarded.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { JsonLines } from '../broker/wire.ts';
import { parsePairing } from '../broker/remote/crypto.ts';
import { Store } from '../broker/store.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const serial = option('--serial', process.env.ANDROID_SERIAL);
const appPackage = option('--package', 'dev.otectus.cere.mobile.debug')!;
const runner = `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`;
const evidence = resolve(option('--evidence', join('build', 'mobile-paired', new Date().toISOString().replace(/[:.]/g, '-')))!);
const keepPairing = args.includes('--keep-pairing');
const root = resolve(new URL('..', import.meta.url).pathname);
const log: string[] = [];
const note = (line: string) => { const stamped = `[${new Date().toISOString()}] ${line}`; log.push(stamped); console.log(stamped); };

function adb(params: string[], options: { timeout?: number; allowFailure?: boolean } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('adb', [...(serial ? ['-s', serial] : []), ...params], { timeout: options.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !options.allowFailure) reject(new Error(`adb ${params.join(' ')} failed: ${stderr || error.message}`));
      else resolvePromise(String(stdout));
    });
  });
}
const until = async <T>(what: string, check: () => Promise<T | undefined>, timeout: number) => {
  const end = Date.now() + timeout;
  for (;;) { const value = await check().catch(() => undefined); if (value !== undefined) return value; if (Date.now() > end) throw new Error(`Timed out after ${timeout / 1000} s waiting for ${what}`); await new Promise(r => setTimeout(r, 500)); }
};
async function freePort() { const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r())); return port; }
const sha256 = (path: string) => new Promise<string>((resolvePromise, reject) => { const hash = createHash('sha256'); createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolvePromise(hash.digest('hex'))); });

/** A same-user socket client for the isolated broker only; it never reads the owner's runtime directory. */
function brokerRequest(socketPath: string, method: string, params: any = {}, timeout = 30_000): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(socketPath), lines = new JsonLines();
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${method}: the isolated broker did not respond`)); }, timeout);
    const done = (error?: Error, value?: any) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolvePromise(value); };
    socket.setEncoding('utf8'); socket.on('error', error => done(error));
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    socket.on('data', chunk => { try { lines.push(String(chunk), m => { if (m.id === 1) done(m.error ? new Error(m.error.message) : undefined, m.result); }); } catch (error: any) { done(error); } });
  });
}

type Instrumented = { name: string; passed: boolean; statuses: number[]; output: string };
/** Runs one instrumentation test with -r and reads its status codes: 0 passed, -2 failed, -3 ignored, -4 assumption failure. */
function instrument(test: string, extras: Record<string, string>, timeout: number): { done: Promise<Instrumented>; process: ChildProcess } {
  const params = ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', test, ...Object.entries(extras).flatMap(([key, value]) => ['-e', key, value]), runner];
  const child = spawn('adb', [...(serial ? ['-s', serial] : []), ...params], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const done = new Promise<Instrumented>(resolvePromise => child.on('close', () => {
    clearTimeout(timer);
    const statuses = [...output.matchAll(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)/gm)].map(match => Number(match[1])).filter(code => code !== 1);
    const passed = statuses.length === 1 && statuses[0] === 0 && /OK \(1 test\)/.test(output) && !/FAILURES!!!|INSTRUMENTATION_FAILED/.test(output);
    resolvePromise({ name: test, passed, statuses, output });
  }));
  return { done, process: child };
}

const results: Instrumented[] = [];
const summary: Record<string, unknown> = { started: new Date().toISOString(), serial: serial ?? 'default', package: appPackage };
let broker: ChildProcess | undefined, ollama: ChildProcess | undefined, brokerLog = '', port = 0;
const work = await mkdtemp(join(tmpdir(), 'cere-paired-'));
// The Unix socket path must stay under 108 bytes, so the runtime directory is short.
const state = join(work, 'state'), runtime = join(work, 'run'), project = join(work, 'project'), home = join(work, 'home');
const socketPath = join(runtime, 'broker.sock');
let exitCode = 1;
try {
  await mkdir(evidence, { recursive: true }); await mkdir(project); await mkdir(home);
  const device = (await adb(['shell', 'getprop', 'ro.build.version.sdk'])).trim();
  summary.androidApi = Number(device); summary.androidRelease = (await adb(['shell', 'getprop', 'ro.build.version.release'])).trim();
  const packageInfo = await adb(['shell', 'dumpsys', 'package', appPackage]);
  summary.versionName = packageInfo.match(/versionName=(\S+)/)?.[1]; summary.versionCode = packageInfo.match(/versionCode=(\d+)/)?.[1];
  if (!summary.versionName) throw new Error(`${appPackage} is not installed; install the debug and instrumentation APKs first`);
  for (const apk of ['mobile/android/app/build/outputs/apk/debug/app-debug.apk', 'mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'])
    summary[apk.endsWith('androidTest.apk') ? 'testApkSha256' : 'apkSha256'] = await sha256(join(root, apk)).catch(() => 'not built here');
  note(`Device API ${summary.androidApi} (Android ${summary.androidRelease}), ${appPackage} ${summary.versionName}/${summary.versionCode}`);

  // Fixture providers: the Ollama fixture streams fixed replies; Codex uses its fixture CLI; Claude is absent.
  ollama = spawn(process.execPath, [join(root, 'tests/fixtures/ui-ollama.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ollamaHost = await new Promise<string>((resolvePromise, reject) => { ollama!.stdout!.once('data', chunk => resolvePromise(String(chunk).trim())); ollama!.once('exit', () => reject(new Error('Ollama fixture exited'))); });
  // No desktop session, bus, display or owner profile reaches the isolated broker.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', CERE_STATE_DIR: state, CERE_RUNTIME_DIR: runtime, CERE_TTS_DISABLED: '1',
    CERE_OLLAMA_HOST: ollamaHost, CERE_CODEX_BIN: join(root, 'tests/fixtures/ui-codex.mjs'), CERE_CLAUDE_BIN: join(work, 'absent-claude'), CERE_ANTIGRAVITY_BIN: join(work, 'absent-antigravity') };
  // Memory stays off: the gate covers pairing, scoped reads, a signed send and reconnection.
  const store = new Store(state); store.set('settings', { memory: { enabled: false } }); store.close();
  broker = spawn(process.execPath, [join(root, 'broker/main.ts')], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  broker.stdout!.on('data', chunk => { brokerLog += chunk; }); broker.stderr!.on('data', chunk => { brokerLog += chunk; });
  await until('the isolated broker', async () => (await brokerRequest(socketPath, 'remote.status', {}, 1000)) ? true : undefined, 30_000);
  note(`Isolated broker ready (state ${state}); Ollama fixture ${ollamaHost}`);

  port = await freePort();
  await adb(['logcat', '-c'], { allowFailure: true });
  await adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
  await adb(['shell', 'pm', 'clear', appPackage]);
  // Instrumentation runs as the app's user; the alert and local-network prompts must not block it.
  for (const permission of ['android.permission.POST_NOTIFICATIONS', 'android.permission.ACCESS_LOCAL_NETWORK'])
    await adb(['shell', 'pm', 'grant', appPackage, permission], { allowFailure: true });
  const prepared = await brokerRequest(socketPath, 'remote.preparePair', { addresses: ['127.0.0.1'], port, name: 'Cere paired check', actionAuthentication: 'trusted-device' });
  const offer = parsePairing(prepared.uri) as any;
  summary.desktopId = offer.desktopId;
  note(`Prepared a trusted-device offer for wss://127.0.0.1:${port} (desktop ${offer.desktopId})`);

  const pairing = instrument('dev.otectus.cere.mobile.UsbPairingSetupTest#pairFromExplicitUsbOffer', { cerePairingOffer: prepared.uri }, 240_000);
  const phone = await until('the phone\'s staged pairing response', async () => {
    const text = await adb(['exec-out', 'run-as', appPackage, 'cat', 'files/usb-pairing-response.json'], { allowFailure: true, timeout: 10_000 });
    try { const value = JSON.parse(text); return typeof value.response === 'string' ? value : undefined; } catch { return undefined; }
  }, 120_000);
  const review = await brokerRequest(socketPath, 'remote.reviewPair', { response: phone.response });
  if (review.sas !== phone.sas) throw new Error(`Six-word comparison differs: desktop "${review.sas}", phone "${phone.sas}"`);
  if (review.actionAuthentication !== 'trusted-device' || phone.actionAuthentication !== 'trusted-device') throw new Error('Pairing did not keep the trusted-device policy');
  await brokerRequest(socketPath, 'remote.confirmPair', { response: phone.response, sas: review.sas, confirmed: true, projectPaths: [project],
    caps: ['chat.read', 'chat.write', 'approvals.answer', 'providers.execute', 'approvals.provider', 'settings.write', 'desktop.control'], categories: ['timers'], scriptIds: [] });
  await adb(['shell', 'run-as', appPackage, 'touch', 'files/usb-pairing-desktop-confirmed']);
  note(`SAS matched ("${review.sas}"); desktop confirmed device ${phone.deviceId}`);
  results.push(await pairing.done);
  const connected = (await brokerRequest(socketPath, 'remote.status')).connected as { id: string }[];
  summary.connectedAfterPairing = connected.some(entry => entry.id === phone.deviceId);

  const session = await brokerRequest(socketPath, 'session.create', { provider: 'ollama', cwd: project, title: `Cere mobile validation ${Date.now()}`, model: 'fixture-chat:latest', tools: false });
  note(`Created synthetic Ollama conversation ${session.id}`);
  const conversation = instrument('dev.otectus.cere.mobile.ConnectedDesktopTest', { cereExpectedDesktopId: offer.desktopId, cereSmokeSessionId: session.id }, 300_000);
  results.push(await conversation.done);
  // The desktop side of the same send: one user row for the one logical send, and the fixture reply.
  const page = await brokerRequest(socketPath, 'session.messages', { id: session.id });
  const rows = (page.messages ?? []) as { role: string; text: string }[];
  const prompts = rows.filter(row => row.role === 'user' && row.text.includes('Reply with exactly CERE_MOBILE_OK'));
  summary.desktopTranscript = { userRowsForTheSend: prompts.length, reply: rows.some(row => row.role === 'assistant' && row.text.includes('CERE_MOBILE_OK')) };
  const transcriptOk = prompts.length === 1 && (summary.desktopTranscript as any).reply === true;
  const ledger = (await brokerRequest(socketPath, 'remote.status')).devices?.find((entry: any) => entry.id === phone.deviceId);
  summary.deviceRecorded = !!ledger;
  for (const result of results) note(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} (status codes ${result.statuses.join(',') || 'none'})`);
  note(`Desktop transcript: ${prompts.length} user row(s) for the send, reply ${(summary.desktopTranscript as any).reply ? 'present' : 'missing'}`);
  // The tests print a checkpoint after each stage; a stage that returned early leaves its line out.
  const output = await adb(['logcat', '-d', '-s', 'System.out:I'], { allowFailure: true, timeout: 30_000 });
  const checkpoints = ['USB_SETUP:', 'CONNECTED_CHECK: pinned TLS', 'CONNECTED_CHECK: live Ollama reply received', 'CONNECTED_CHECK: revision-bound pin/archive', 'CONNECTED_CHECK: disconnect/reconnect'];
  summary.checkpoints = Object.fromEntries(checkpoints.map(checkpoint => [checkpoint, output.includes(checkpoint)]));
  const staged = checkpoints.every(checkpoint => output.includes(checkpoint));
  note(`Checkpoints: ${checkpoints.filter(checkpoint => output.includes(checkpoint)).length}/${checkpoints.length} reached`);
  exitCode = results.length === 2 && results.every(result => result.passed) && transcriptOk && staged && summary.connectedAfterPairing === true ? 0 : 1;
} catch (error: any) {
  note(`ERROR ${error?.stack || error}`);
} finally {
  summary.finished = new Date().toISOString(); summary.passed = exitCode === 0;
  summary.tests = results.map(({ name, passed, statuses }) => ({ name, passed, statuses }));
  const logcat = await adb(['logcat', '-d', '-v', 'threadtime'], { allowFailure: true, timeout: 30_000 }).catch(() => '');
  await writeFile(join(evidence, 'logcat.txt'), logcat.split('\n').filter(line => /Cere|cere|System\.out|AndroidRuntime|TestRunner|StrictMode/.test(line)).join('\n'));
  for (const result of results) await writeFile(join(evidence, result.name.replace(/[^A-Za-z0-9_.#-]/g, '_') + '.txt'), result.output);
  await writeFile(join(evidence, 'broker.log'), brokerLog);
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(evidence, 'harness.log'), log.join('\n') + '\n');
  if (port) await adb(['reverse', '--remove', `tcp:${port}`], { allowFailure: true });
  if (!keepPairing) await adb(['shell', 'pm', 'clear', appPackage], { allowFailure: true });
  if (broker?.pid) { try { process.kill(-broker.pid, 'SIGTERM'); } catch {} await new Promise(r => setTimeout(r, 1500)); try { process.kill(-broker.pid, 'SIGKILL'); } catch {} }
  ollama?.kill('SIGTERM');
  await rm(work, { recursive: true, force: true }).catch(() => {});
  console.log(`Evidence: ${evidence}`);
  console.log(exitCode === 0 ? 'PAIRED CHECK PASSED' : 'PAIRED CHECK FAILED');
  process.exit(exitCode);
}
