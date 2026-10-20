/**
 * W16: release approval names the exact bytes that were tested. An evidence record
 * (docs/mobile/release-evidence/mobile-vX.Y.Z.json) binds the hardware and install results to the
 * source commit, the unsigned release APK's SHA-256, the signing certificate, the desktop build it
 * was tested against, the device and OS, and the date. The release workflow refuses to sign unless
 * the record matches the APK it is about to sign; a stale record cannot certify new code.
 *
 *   node tools/mobile-release-evidence.ts template <unsigned.apk> <tag> <out.json>
 *   node tools/mobile-release-evidence.ts check <evidence.json> --tag <tag> --commit <sha> --unsigned-apk <apk> --signer <sha256> [--max-age-days 45]
 *
 * The template fills what can be computed and leaves every gate "not-run"; only a person who ran
 * the gate on the device changes it to "passed" (or "not-applicable" with a reason).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/** The checks docs/mobile/TESTING.md lists as release gates, each on the target device. */
export const requiredGates = {
  'fresh-install': 'Release (R8, arm64) fresh install on the target device starts, pairs and chats',
  'upgrade': 'In-place upgrade from the previous distributed build keeps pairing, drafts and history',
  'pairing': 'Pairing, replacement pairing, biometric enrollment and invalidation behave as documented',
  'reconnect': 'LAN, WireGuard/mobile data and desktop sleep/wake reconnect without a new pairing',
  'notifications': 'Screen-off/Doze delivery, deny from the notification, lock-screen privacy',
  'attachments': 'Camera, Photo Picker and file attachments review, and process-killed upload recovery',
  'accessibility': 'TalkBack, 200% font size, landscape and display cutouts on the target device',
  'no-play': 'Works on the installed OS without Google Play services',
  'paired-desktop': 'ConnectedDesktopTest or tools/mobile-paired-check.ts against the named desktop build',
} as const;
type Gate = keyof typeof requiredGates;
type Evidence = {
  schema: 1; tag: string; commit: string; date: string; tester: string;
  desktopBuild: { version: string; commit: string | null; dirty: boolean };
  apk: { unsignedSha256: string; packageId: string; versionName: string; versionCode: number };
  signerSha256: string;
  device: { model: string; os: string; sdk: number };
  gates: Record<Gate, { result: 'passed' | 'failed' | 'not-run' | 'not-applicable'; notes: string }>;
};

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hex = (value: unknown, length: number) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const version = (tag: string) => {
  const match = /^mobile-v(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tag);
  if (!match) throw new Error('Use a tag of the form mobile-vX.Y.Z');
  return { versionName: match.slice(1).join('.'), versionCode: Number(match[1]) * 1_000_000 + Number(match[2]) * 1000 + Number(match[3]) };
};

/** Every reason the record does not certify these bytes; empty when it does. */
export function problems(evidence: any, expected: { tag: string; commit: string; unsignedSha256: string; signer: string; now?: number; maxAgeDays?: number; changedSince?: (commit: string) => string[] | null }) {
  const found: string[] = [];
  if (evidence?.schema !== 1) return ['The evidence record has an unknown schema'];
  const { versionName, versionCode } = version(expected.tag);
  if (evidence.tag !== expected.tag) found.push(`The record is for ${evidence.tag}, not ${expected.tag}`);
  if (evidence.apk?.packageId !== 'dev.otectus.cere.mobile') found.push('The record names another package');
  if (evidence.apk?.versionName !== versionName || evidence.apk?.versionCode !== versionCode) found.push('The record names another version');
  if (!hex(evidence.apk?.unsignedSha256, 64) || evidence.apk.unsignedSha256 !== expected.unsignedSha256.toLowerCase()) found.push('The tested APK is not the APK being signed (unsigned SHA-256 differs)');
  if (!hex(evidence.signerSha256, 64) || evidence.signerSha256 !== expected.signer.toLowerCase()) found.push('The record names another signing certificate');
  if (!hex(evidence.commit, 40)) found.push('The record does not name a full source commit');
  else if (evidence.commit !== expected.commit) {
    // A record is committed after its test, so the tag may be a later commit that adds only records.
    const changed = expected.changedSince?.(evidence.commit);
    if (!changed) found.push('The tested commit is not an ancestor of the release commit');
    else if (changed.some(path => !path.startsWith('docs/mobile/release-evidence/'))) found.push('Source changed after the tested commit: ' + changed.filter(path => !path.startsWith('docs/mobile/release-evidence/')).slice(0, 5).join(', '));
  }
  if (typeof evidence.desktopBuild?.version !== 'string' || !evidence.desktopBuild.version || typeof evidence.desktopBuild.dirty !== 'boolean') found.push('The record does not name the desktop build it was tested against');
  if (typeof evidence.device?.model !== 'string' || !evidence.device.model || typeof evidence.device?.os !== 'string' || !evidence.device.os || !Number.isInteger(evidence.device?.sdk)) found.push('The record does not name the device and OS');
  if (typeof evidence.tester !== 'string' || !evidence.tester.trim()) found.push('The record does not name who ran the gates');
  const date = Date.parse(evidence.date), now = expected.now ?? Date.now(), maxAge = (expected.maxAgeDays ?? 45) * 86_400_000;
  if (!Number.isFinite(date) || date > now + 86_400_000) found.push('The record has no valid test date');
  else if (now - date > maxAge) found.push(`The gates ran more than ${expected.maxAgeDays ?? 45} days ago`);
  for (const gate of Object.keys(requiredGates) as Gate[]) {
    const entry = evidence.gates?.[gate];
    if (entry?.result === 'passed') continue;
    if (entry?.result === 'not-applicable' && typeof entry.notes === 'string' && entry.notes.trim().length >= 10) continue;
    found.push(`Gate ${gate} is ${entry?.result || 'missing'}`);
  }
  return found;
}

function option(args: string[], name: string) { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'template') {
    const [apk, tag, out] = args;
    if (!apk || !tag || !out) throw new Error('Usage: mobile-release-evidence.ts template <unsigned.apk> <tag> <out.json>');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // The desktop build of the same source, as tools/build-info.mjs records it for the broker.
    const build = { version: JSON.parse(readFileSync('package.json', 'utf8')).version as string, commit,
      dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '' };
    const record: Evidence = {
      schema: 1, tag, commit, date: new Date().toISOString().slice(0, 10), tester: '',
      desktopBuild: { version: build.version, commit: build.commit, dirty: build.dirty },
      apk: { unsignedSha256: sha256(apk), packageId: 'dev.otectus.cere.mobile', ...version(tag) },
      signerSha256: '', device: { model: '', os: '', sdk: 0 },
      gates: Object.fromEntries(Object.keys(requiredGates).map(gate => [gate, { result: 'not-run', notes: requiredGates[gate as Gate] }])) as Evidence['gates'],
    };
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    console.log(`Wrote ${out}: fill in the tester, device, signer and each gate you ran.`);
  } else if (command === 'check') {
    const [path] = args, tag = option(args, '--tag'), commit = option(args, '--commit'), apk = option(args, '--unsigned-apk'), signer = option(args, '--signer');
    if (!path || !tag || !commit || !apk || !signer) throw new Error('Usage: mobile-release-evidence.ts check <evidence.json> --tag <tag> --commit <sha> --unsigned-apk <apk> --signer <sha256>');
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    const changedSince = (base: string) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', base, commit]);
        return execFileSync('git', ['diff', '--name-only', base, commit], { encoding: 'utf8' }).split('\n').filter(Boolean);
      } catch { return null; }
    };
    const found = problems(evidence, { tag, commit, unsignedSha256: sha256(apk), signer, maxAgeDays: Number(option(args, '--max-age-days') || 45), changedSince });
    if (found.length) { console.error('The release evidence does not certify this APK:\n- ' + found.join('\n- ')); process.exit(1); }
    console.log(`Evidence ${path} certifies ${tag}: unsigned ${evidence.apk.unsignedSha256}, signer ${evidence.signerSha256}, ${evidence.device.model} (${evidence.device.os}), ${evidence.date}.`);
  } else throw new Error('Use template or check');
}
