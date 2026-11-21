#!/usr/bin/env node
/**
 * In-place upgrade gate for development builds (MOB-006). On a test emulator or a phone whose Cere
 * Mobile data may be discarded, against an isolated broker with fixture providers:
 *
 *  1. checks that the old and candidate APKs are the same package and signer, the candidate newer;
 *  2. installs the old APK, pairs it with the old source's own UsbPairingSetupTest (trusted-device);
 *  3. seeds what an upgrade must keep through the old app's UI: an open conversation and an unsent draft;
 *  4. installs the candidate over it with `adb install -r` (no uninstall, no data clearing);
 *  5. drives the candidate's UI: it must sign in as the same device, show the selected conversation
 *     and its draft, open Conversation settings (the desktop's default style is JSON null), and send
 *     the draft as one signed turn that the desktop records once.
 *
 *   node tools/mobile-upgrade-check.ts --old-apk OLD.apk --old-test-apk OLD-androidTest.apk --candidate-apk NEW.apk
 *     [--serial SERIAL] [--evidence DIR] [--package ID]
 *
 * The old test APK must be built from the old APK's source with the same signing key.
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
const serial = option('--serial', process.env.ANDROID_SERIAL);
const appPackage = option('--package', 'dev.otectus.cere.mobile.debug')!;
const oldApk = option('--old-apk'), oldTestApk = option('--old-test-apk'), candidateApk = option('--candidate-apk');
if (!oldApk || !oldTestApk || !candidateApk) throw new Error('Give --old-apk, --old-test-apk and --candidate-apk');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sdk = process.env.ANDROID_HOME || join(root, 'mobile/android/.android-sdk');
const buildTools = join(sdk, 'build-tools/36.0.0');
const evidence = resolve(option('--evidence', join('build', 'mobile-upgrade', new Date().toISOString().replace(/[:.]/g, '-')))!);
const log: string[] = [];
const note = (line: string) => { const stamped = `[${new Date().toISOString()}] ${line}`; log.push(stamped); console.log(stamped); };
const run = (file: string, params: string[], timeout = 120_000, allowFailure = false) => new Promise<string>((resolvePromise, reject) => {
  execFile(file, params, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => { if (error && !allowFailure) reject(new Error(`${file} ${params.join(' ')}: ${stderr || error.message}`)); else resolvePromise(String(stdout)); });
});
const adb = (params: string[], timeout = 120_000, allowFailure = false) => run('adb', [...(serial ? ['-s', serial] : []), ...params], timeout, allowFailure);
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
/** Package, version and signer as the APK itself states them. */
async function identity(apk: string) {
  const badging = await run(join(buildTools, 'aapt2'), ['dump', 'badging', apk]);
  const certs = await run(join(buildTools, 'apksigner'), ['verify', '--print-certs', apk]);
  return { package: /package: name='([^']+)'/.exec(badging)?.[1], versionCode: Number(/versionCode='(\d+)'/.exec(badging)?.[1]), versionName: /versionName='([^']+)'/.exec(badging)?.[1],
    signer: /certificate SHA-256 digest: ([0-9a-f]{64})/.exec(certs)?.[1], debuggable: /application-debuggable/.test(badging) };
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
const find = (nodes: Node[], predicate: (node: Node) => boolean) => nodes.find(predicate);
async function tap(node: Node) { const [l, t, r, b] = node.bounds; await adb(['shell', 'input', 'tap', String(Math.round((l + r) / 2)), String(Math.round((t + b) / 2))]); }
async function tapWhen(what: string, predicate: (node: Node) => boolean, timeout = 30_000) { const node = await until(what, async () => find(await screen(), predicate), timeout); await tap(node); return node; }

const summary: Record<string, unknown> = { started: new Date().toISOString(), serial: serial ?? 'default', package: appPackage };
let broker: ChildProcess | undefined, ollama: ChildProcess | undefined, brokerLog = '', port = 0, exitCode = 1, reverseAdded = false;
const work = await mkdtemp(join(tmpdir(), 'cere-upgrade-'));
const state = join(work, 'state'), runtime = join(work, 'run'), project = join(work, 'project'), home = join(work, 'home'), socketPath = join(runtime, 'broker.sock');
const instrumentation = new Set<ChildProcess>();
try {
  await mkdir(evidence, { recursive: true }); await mkdir(project); await mkdir(home);
  const before = await identity(oldApk), after = await identity(candidateApk);
  summary.old = before; summary.candidate = after;
  if (before.package !== appPackage || after.package !== appPackage) throw new Error(`Both APKs must be ${appPackage}`);
  if (!before.signer || before.signer !== after.signer) throw new Error('The candidate is signed by a different key; it cannot update the old install in place');
  if (!(after.versionCode > before.versionCode)) throw new Error('The candidate must have a higher versionCode');
  note(`Old ${before.versionName}/${before.versionCode} → candidate ${after.versionName}/${after.versionCode}; signer ${before.signer} on both`);

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

  // The old build, paired as its own owner would have it.
  await adb(['uninstall', appPackage + '.test'], 60_000, true); await adb(['uninstall', appPackage], 60_000, true);
  await adb(['install', '-t', oldApk]); await adb(['install', '-t', oldTestApk]);
  for (const permission of ['android.permission.POST_NOTIFICATIONS', 'android.permission.ACCESS_LOCAL_NETWORK']) await adb(['shell', 'pm', 'grant', appPackage, permission], 30_000, true);
  const prepared = await brokerRequest(socketPath, 'remote.preparePair', { addresses: ['127.0.0.1'], port, name: 'Cere upgrade check', actionAuthentication: 'trusted-device' });
  const pairing = spawn('adb', [...(serial ? ['-s', serial] : []), 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'dev.otectus.cere.mobile.UsbPairingSetupTest#pairFromExplicitUsbOffer', '-e', 'cerePairingOffer', prepared.uri, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`], { stdio: ['ignore', 'pipe', 'pipe'] });
  instrumentation.add(pairing); let pairingOutput = ''; pairing.stdout!.on('data', chunk => { pairingOutput += chunk; }); pairing.stderr!.on('data', chunk => { pairingOutput += chunk; });
  const pairingDone = new Promise<void>(resolvePromise => pairing.once('close', () => { instrumentation.delete(pairing); resolvePromise(); }));
  const phone = await until('the old app\'s staged answer', async () => { const text = await adb(['exec-out', 'run-as', appPackage, 'cat', 'files/usb-pairing-response.json'], 10_000, true); try { const value = JSON.parse(text); return typeof value.response === 'string' ? value : undefined; } catch { return undefined; } }, 120_000);
  const review = await brokerRequest(socketPath, 'remote.reviewPair', { response: phone.response });
  if (review.sas !== phone.sas) throw new Error('Six-word comparison differs');
  await brokerRequest(socketPath, 'remote.confirmPair', { response: phone.response, sas: review.sas, confirmed: true, projectPaths: [project], caps: ['chat.read', 'chat.write', 'approvals.answer'], categories: [], scriptIds: [] });
  await adb(['shell', 'run-as', appPackage, 'touch', 'files/usb-pairing-desktop-confirmed']);
  await pairingDone; await writeFile(join(evidence, 'old-pairing-instrumentation.txt'), pairingOutput);
  if (!/OK \(1 test\)/.test(pairingOutput)) throw new Error('The old app did not pair: ' + pairingOutput.slice(-400));
  summary.deviceId = phone.deviceId; note(`Old app paired as device ${phone.deviceId}`);

  // What the upgrade must keep: an open conversation and an unsent draft, entered through the old UI.
  const title = `Upgrade check ${Date.now()}`, draft = `UPGRADE_DRAFT_${Math.random().toString(36).slice(2, 10)}`;
  const session = await brokerRequest(socketPath, 'session.create', { provider: 'ollama', cwd: project, title, model: 'fixture-chat:latest', tools: false });
  await adb(['shell', 'am', 'start', '-W', '-n', `${appPackage}/dev.otectus.cere.mobile.MainActivity`]);
  await tapWhen('the conversation in the old app', node => node.text === title, 60_000);
  await tapWhen('the old app\'s message field', node => node.cls === 'android.widget.EditText', 30_000);
  await adb(['shell', 'input', 'text', draft]);
  // Snapshot rows leave drafts out unless selected; hydrate reads the stored draft.
  await until('the draft to reach the desktop', async () => (await brokerRequest(socketPath, 'session.hydrate', { id: session.id }))?.session?.draft === draft ? true : undefined, 30_000);
  await new Promise(r => setTimeout(r, 2000)); // the local encrypted cache is written on its own debounce
  await adb(['shell', 'am', 'force-stop', appPackage]);
  note(`Seeded conversation "${title}" and draft ${draft} in the old app`);

  // The update itself: same package and signer, data kept.
  await adb(['install', '-r', candidateApk]);
  const installed = await adb(['shell', 'dumpsys', 'package', appPackage]);
  summary.installedVersionCode = Number(/versionCode=(\d+)/.exec(installed)?.[1]);
  if (summary.installedVersionCode !== after.versionCode) throw new Error('The candidate did not replace the old install');
  await adb(['logcat', '-c'], 30_000, true);
  await adb(['shell', 'am', 'start', '-W', '-n', `${appPackage}/dev.otectus.cere.mobile.MainActivity`]);
  const signedIn = await until('the upgraded app to sign in as the same device', async () => {
    const status = await brokerRequest(socketPath, 'remote.status');
    return (status.connected as { id: string }[]).some(entry => entry.id === phone.deviceId) ? true : undefined;
  }, 60_000);
  summary.sameDeviceSignedIn = signedIn; note('The candidate signed in with the old pairing and keys');
  // The selected conversation and its draft, as the old app left them.
  // The app reopens the selected conversation itself; the Chat destination is a fallback.
  const shown = async () => { const nodes = await screen(); return nodes.some(node => node.text.includes(draft)) && nodes.some(node => node.text.includes(title)); };
  if (!(await until('the upgraded app\'s first screen', async () => (await screen()).length ? true : undefined, 30_000) && await shown())) await tapWhen('the Chat destination', node => node.text === 'Chat' || node.desc === 'Chat', 30_000);
  const restored = await until('the restored draft in the composer', async () => { const nodes = await screen(); return nodes.some(node => node.text.includes(draft)) && nodes.some(node => node.text.includes(title)) ? true : undefined; }, 30_000);
  summary.draftAndSelectionKept = restored; note('The selected conversation and its unsent draft survived the update');
  // MOB-002 on the shipped variant: the default style answer is JSON null and the sheet still renders.
  await tapWhen('Conversation settings', node => node.text === 'Conversation settings', 30_000);
  summary.defaultStyleRendered = await until('the default style line', async () => (await screen()).some(node => node.text === 'No style · the personality, for every conversation') ? true : undefined, 30_000);
  await tapWhen('Close', node => node.text === 'Close', 15_000);
  // One signed turn from the kept draft; the desktop records it once and the fixture replies.
  await tapWhen('Send', node => node.desc === 'Send', 15_000);
  const transcript = await until('the reply on the desktop', async () => {
    const page = await brokerRequest(socketPath, 'session.messages', { id: session.id });
    const rows = (page.messages ?? []) as { role: string; text: string }[];
    return rows.some(row => row.role === 'assistant') ? rows : undefined;
  }, 60_000);
  summary.userRowsForTheSend = transcript.filter(row => row.role === 'user' && row.text.includes(draft)).length;
  const crashes = (await adb(['logcat', '-d', '-s', 'AndroidRuntime:E'], 30_000, true)).split('\n').filter(line => /FATAL EXCEPTION/.test(line));
  summary.fatalExceptions = crashes.length;
  summary.processAlive = !!(await adb(['shell', 'pidof', appPackage], 15_000, true)).trim();
  note(`Send recorded ${summary.userRowsForTheSend} user row(s); fatal exceptions ${crashes.length}; process alive ${summary.processAlive}`);
  exitCode = summary.userRowsForTheSend === 1 && crashes.length === 0 && summary.processAlive === true ? 0 : 1;
} catch (error: any) {
  note(`ERROR ${error?.stack || error}`);
} finally {
  summary.finished = new Date().toISOString(); summary.passed = exitCode === 0;
  try {
    const logcat = await adb(['logcat', '-d', '-v', 'threadtime'], 30_000, true).catch(() => '');
    await writeFile(join(evidence, 'logcat.txt'), logcat.split('\n').filter(line => /Cere|cere|AndroidRuntime|TestRunner/.test(line)).join('\n'));
    await writeFile(join(evidence, 'broker.log'), brokerLog);
    await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(join(evidence, 'harness.log'), log.join('\n') + '\n');
  } catch (error) { console.error('Could not write upgrade evidence:', error); exitCode = 1; }
  for (const child of instrumentation) child.kill('SIGTERM');
  if (reverseAdded) await adb(['reverse', '--remove', 'tcp:' + port], 30_000, true);
  if (broker?.pid) { try { process.kill(-broker.pid, 'SIGTERM'); } catch {} await new Promise(r => setTimeout(r, 1500)); try { process.kill(-broker.pid, 'SIGKILL'); } catch {} }
  ollama?.kill('SIGTERM');
  await rm(work, { recursive: true, force: true });
  console.log(`Evidence: ${evidence}`);
  console.log(exitCode === 0 ? 'UPGRADE CHECK PASSED' : 'UPGRADE CHECK FAILED');
  process.exit(exitCode);
}
