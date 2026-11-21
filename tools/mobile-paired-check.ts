#!/usr/bin/env node
/**
 * Phone-to-broker interoperability gate. Starts an isolated broker with fixture providers (no owner
 * account, profile or desktop session), pairs the installed debug app to it over `adb reverse` with a
 * trusted-device offer, then runs the paired instrumentation tests with their explicit arguments:
 * UsbPairingSetupTest#pairFromExplicitUsbOffer, then ConnectedDesktopTest against a synthetic Ollama
 * conversation. Unlike `connectedDebugAndroidTest`, which skips these without arguments, every test
 * here must report a pass; a skip, an assumption failure or a missing result fails the gate.
 *
 *   node tools/mobile-paired-check.ts [--serial SERIAL] [--evidence DIR] [--package ID] [--keep-pairing] [--pairing manual|network]
 *
 * --pairing network uses a network-return offer: the app sends its signed answer to the isolated
 * broker over pinned TLS (UsbPairingSetupTest#pairByNetworkReturn), the harness compares the six
 * words the desktop shows with the phone's and confirms by pairing ID, and the phone must finish by itself.
 *
 * The debug app and its instrumentation APK must already be installed (`:app:installDebug
 * :app:installDebugAndroidTest`). The app's data is cleared first, so run it only on a test emulator
 * or a device whose Cere Mobile pairing may be discarded.
 */
import { fileURLToPath } from 'node:url';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { brokerFrameLimit } from '../broker/fanout.ts';
import { JsonLines } from '../broker/wire.ts';
import { parsePairing } from '../broker/remote/crypto.ts';
import { Store } from '../broker/store.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const serial = option('--serial', process.env.ANDROID_SERIAL);
const appPackage = option('--package', 'dev.otectus.cere.mobile.debug')!;
if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(appPackage)) throw new Error('Invalid Android package ID');
const runner = `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`;
const evidence = resolve(option('--evidence', join('build', 'mobile-paired', new Date().toISOString().replace(/[:.]/g, '-')))!);
const keepPairing = args.includes('--keep-pairing');
const pairingMode = option('--pairing', 'manual')!;
if (!['manual', 'network'].includes(pairingMode)) throw new Error('--pairing is manual or network');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
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
async function installedApks(packageId: string) {
  const paths = (await adb(['shell', 'pm', 'path', packageId])).trim().split(/\r?\n/);
  const apks = [];
  for (const line of paths) {
    const path = /^package:(\/[A-Za-z0-9/_.=+~-]+\.apk)$/.exec(line)?.[1];
    if (!path) throw new Error('Could not resolve the installed APK for ' + packageId);
    const output = await adb(['shell', 'sha256sum', path]);
    const sha256 = /^([a-f0-9]{64})\s/.exec(output)?.[1];
    if (!sha256) throw new Error('Could not verify the installed APK for ' + packageId);
    apks.push({ path, sha256 });
  }
  return apks;
}

/** A same-user socket client for the isolated broker only; it never reads the owner's runtime directory. */
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

type Instrumented = { name: string; passed: boolean; statuses: number[]; output: string };
/** Runs one instrumentation test with -r and reads its status codes: 0 passed, -2 failed, -3 ignored, -4 assumption failure. */
function instrument(test: string, extras: Record<string, string>, timeout: number): { done: Promise<Instrumented>; process: ChildProcess } {
  const params = ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', test, ...Object.entries(extras).flatMap(([key, value]) => ['-e', key, value]), runner];
  const child = spawn('adb', [...(serial ? ['-s', serial] : []), ...params], { stdio: ['ignore', 'pipe', 'pipe'] });
  instrumentation.add(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const done = new Promise<Instrumented>((resolvePromise, reject) => { child.once('error', reject); child.once('close', () => {
    instrumentation.delete(child);
    clearTimeout(timer);
    const statuses = [...output.matchAll(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)/gm)].map(match => Number(match[1])).filter(code => code !== 1);
    const passed = statuses.length === 1 && statuses[0] === 0 && /OK \(1 test\)/.test(output) && !/FAILURES!!!|INSTRUMENTATION_FAILED/.test(output);
    resolvePromise({ name: test, passed, statuses, output });
  }); });
  // Pairing may fail before the caller awaits this result.
  void done.catch(() => {});
  return { done, process: child };
}

const results: Instrumented[] = [];
const summary: Record<string, unknown> = { started: new Date().toISOString(), serial: serial ?? 'default', package: appPackage, pairing: pairingMode };
let broker: ChildProcess | undefined, ollama: ChildProcess | undefined, brokerLog = '', port = 0;
const work = await mkdtemp(join(tmpdir(), 'cere-paired-'));
// The Unix socket path must stay under 108 bytes, so the runtime directory is short.
const state = join(work, 'state'), runtime = join(work, 'run'), project = join(work, 'project'), home = join(work, 'home');
const socketPath = join(runtime, 'broker.sock');
let exitCode = 1, reverseAdded = false, appCleared = false;
const instrumentation = new Set<ChildProcess>();
try {
  await mkdir(evidence, { recursive: true }); await mkdir(project); await mkdir(home);
  const device = (await adb(['shell', 'getprop', 'ro.build.version.sdk'])).trim();
  summary.androidApi = Number(device); summary.androidRelease = (await adb(['shell', 'getprop', 'ro.build.version.release'])).trim();
  const packageInfo = await adb(['shell', 'dumpsys', 'package', appPackage]);
  summary.versionName = packageInfo.match(/versionName=(\S+)/)?.[1]; summary.versionCode = packageInfo.match(/versionCode=(\d+)/)?.[1];
  if (!summary.versionName) throw new Error(`${appPackage} is not installed; install the debug and instrumentation APKs first`);
  const appApks = await installedApks(appPackage), testApks = await installedApks(appPackage + '.test');
  summary.installedApks = { application: appApks, instrumentation: testApks };
  summary.apkSha256 = appApks.find(apk => apk.path.endsWith('/base.apk'))?.sha256 ?? appApks[0].sha256;
  summary.testApkSha256 = testApks.find(apk => apk.path.endsWith('/base.apk'))?.sha256 ?? testApks[0].sha256;
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
  await adb(['reverse', '--no-rebind', `tcp:${port}`, `tcp:${port}`]);
  reverseAdded = true;
  await adb(['shell', 'pm', 'clear', appPackage]);
  appCleared = true;
  // Instrumentation runs as the app's user; the alert and local-network prompts must not block it.
  for (const permission of ['android.permission.POST_NOTIFICATIONS', 'android.permission.ACCESS_LOCAL_NETWORK'])
    await adb(['shell', 'pm', 'grant', appPackage, permission], { allowFailure: true });
  const prepared = await brokerRequest(socketPath, 'remote.preparePair', { addresses: ['127.0.0.1'], port, name: 'Cere paired check', actionAuthentication: 'trusted-device', ...(pairingMode === 'network' ? { networkReturn: true } : {}) });
  const offer = parsePairing(prepared.uri) as any;
  summary.desktopId = offer.desktopId;
  note(`Prepared a trusted-device ${pairingMode} offer for wss://127.0.0.1:${port} (desktop ${offer.desktopId})`);
  const readPhone = (key: string) => until(`the phone's ${key}`, async () => {
    const text = await adb(['exec-out', 'run-as', appPackage, 'cat', 'files/usb-pairing-response.json'], { allowFailure: true, timeout: 10_000 });
    try { const value = JSON.parse(text); return typeof value[key] === 'string' ? value : undefined; } catch { return undefined; }
  }, 120_000);
  let pairing: ReturnType<typeof instrument>, phone: any;
  if (pairingMode === 'network') {
    pairing = instrument('dev.otectus.cere.mobile.UsbPairingSetupTest#pairByNetworkReturn', { cereNetworkPairingOffer: prepared.uri }, 240_000);
    // As the owner would at the desktop: the phone's answer arrives by itself, and its words are compared.
    const received = await until('the phone\'s answer at the desktop', async () => (await brokerRequest(socketPath, 'remote.status', {}, 5000)).pairing?.received, 120_000);
    phone = await readPhone('sas');
    if (received.sas !== phone.sas) throw new Error(`Six-word comparison differs: desktop "${received.sas}", phone "${phone.sas}"`);
    if (received.actionAuthentication !== 'trusted-device') throw new Error('Pairing did not keep the trusted-device policy');
    summary.networkReturn = { received: true, wordsMatched: true };
    await brokerRequest(socketPath, 'remote.confirmPair', { pairingId: prepared.pairingId, sas: received.sas, confirmed: true, projectPaths: [project],
      caps: ['chat.read', 'chat.write', 'approvals.answer', 'providers.execute', 'approvals.provider', 'settings.write', 'desktop.control'], categories: ['timers'], scriptIds: [] });
    note(`SAS matched ("${received.sas}"); desktop confirmed device ${phone.deviceId} by pairing ID; the phone finishes by itself`);
  } else {
    pairing = instrument('dev.otectus.cere.mobile.UsbPairingSetupTest#pairFromExplicitUsbOffer', { cerePairingOffer: prepared.uri }, 240_000);
    phone = await readPhone('response');
    const review = await brokerRequest(socketPath, 'remote.reviewPair', { response: phone.response });
    if (review.sas !== phone.sas) throw new Error(`Six-word comparison differs: desktop "${review.sas}", phone "${phone.sas}"`);
    if (review.actionAuthentication !== 'trusted-device' || phone.actionAuthentication !== 'trusted-device') throw new Error('Pairing did not keep the trusted-device policy');
    await brokerRequest(socketPath, 'remote.confirmPair', { response: phone.response, sas: review.sas, confirmed: true, projectPaths: [project],
      caps: ['chat.read', 'chat.write', 'approvals.answer', 'providers.execute', 'approvals.provider', 'settings.write', 'desktop.control'], categories: ['timers'], scriptIds: [] });
    await adb(['shell', 'run-as', appPackage, 'touch', 'files/usb-pairing-desktop-confirmed']);
    note(`SAS matched ("${review.sas}"); desktop confirmed device ${phone.deviceId}`);
  }
  // The setup instrumentation cleans its activity after it reports success, which can race the
  // status sampling below. Observe the authenticated socket while this pairing is live instead. A
  // network-return phone finishes by itself, often before the confirmation call returns here, so a
  // sign-in the desktop recorded for the new device (lastSeen is set only on authentication) counts too.
  const connectedAfterPairing = await until('the paired device connection', async () => {
    const status = await brokerRequest(socketPath, 'remote.status');
    const connected = (status.connected as { id: string }[]).some(entry => entry.id === phone.deviceId);
    const signedIn = (status.devices as { id: string; lastSeen?: number }[] | undefined)?.some(entry => entry.id === phone.deviceId && typeof entry.lastSeen === 'number');
    return connected || signedIn ? true : undefined;
  }, 30_000);
  results.push(await pairing.done);
  summary.connectedAfterPairing = connectedAfterPairing;

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
  const checkpoints = [pairingMode === 'network' ? 'USB_NETWORK_PAIRING:' : 'USB_SETUP:', 'CONNECTED_CHECK: pinned TLS', 'CONNECTED_CHECK: live Ollama reply received', 'CONNECTED_CHECK: revision-bound pin/archive', 'CONNECTED_CHECK: disconnect/reconnect'];
  summary.checkpoints = Object.fromEntries(checkpoints.map(checkpoint => [checkpoint, output.includes(checkpoint)]));
  const staged = checkpoints.every(checkpoint => output.includes(checkpoint));
  note(`Checkpoints: ${checkpoints.filter(checkpoint => output.includes(checkpoint)).length}/${checkpoints.length} reached`);
  exitCode = results.length === 2 && results.every(result => result.passed) && transcriptOk && staged && summary.connectedAfterPairing === true ? 0 : 1;
} catch (error: any) {
  note(`ERROR ${error?.stack || error}`);
} finally {
  summary.finished = new Date().toISOString(); summary.passed = exitCode === 0;
  summary.tests = results.map(({ name, passed, statuses }) => ({ name, passed, statuses }));
  try {
    const logcat = await adb(['logcat', '-d', '-v', 'threadtime'], { allowFailure: true, timeout: 30_000 }).catch(() => '');
    await writeFile(join(evidence, 'logcat.txt'), logcat.split('\n').filter(line => /Cere|cere|System\.out|AndroidRuntime|TestRunner|StrictMode/.test(line)).join('\n'));
    for (const result of results) await writeFile(join(evidence, result.name.replace(/[^A-Za-z0-9_.#-]/g, '_') + '.txt'), result.output);
    await writeFile(join(evidence, 'broker.log'), brokerLog);
    await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(join(evidence, 'harness.log'), log.join('\n') + '\n');
  } catch (error) {
    console.error('Could not write paired test evidence:', error);
    exitCode = 1;
  } finally {
    for (const child of instrumentation) child.kill('SIGTERM');
    if (reverseAdded) await adb(['reverse', '--remove', 'tcp:' + port], { allowFailure: true });
    if (appCleared && !keepPairing) await adb(['shell', 'pm', 'clear', appPackage], { allowFailure: true });
    if (broker?.pid) {
      try { process.kill(-broker.pid, 'SIGTERM'); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      try { process.kill(-broker.pid, 'SIGKILL'); } catch {}
    }
    ollama?.kill('SIGTERM');
    await rm(work, { recursive: true, force: true });
  }
  console.log(`Evidence: ${evidence}`);
  console.log(exitCode === 0 ? 'PAIRED CHECK PASSED' : 'PAIRED CHECK FAILED');
  process.exit(exitCode);
}
