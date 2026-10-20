/**
 * W10: desktop controls against real services inside the private desktop of
 * tools/test-virtual-desktop.sh, never the working one: a private PipeWire whose only device is a
 * null sink (volume and mute through wpctl), an MPRIS player on the private session bus (media
 * control through busctl), and application launch and file opening through a fixture desktop entry
 * in the private home. Each change is read back from the service and restored, and a target that
 * vanished since review is refused before anything acts. Outside the private desktop these skip with
 * that reason, so a passing run elsewhere does not claim them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { audioStatus, desktopAction, mediaStatus } from '../broker/desktop.ts';
import { defaultSettings } from '../broker/types.ts';

const run = promisify(execFile);
const privateDesktop = process.env.CERE_VIRTUAL_DESKTOP === '1' && !!process.env.HYPRLAND_INSTANCE_SIGNATURE && !!process.env.DBUS_SESSION_BUS_ADDRESS;
const skip = privateDesktop ? false : 'needs the private desktop of tools/test-virtual-desktop.sh';
const settings = { ...defaultSettings, categories: ['audio', 'media', 'apps', 'files'] } as any;
const until = async (check: () => Promise<boolean>, what: string) => {
  for (let n = 0; n < 200; n++) { if (await check().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for ' + what);
};
const started = (t: any, command: string, args: string[]) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { child.kill(); });
  return child;
};
const lines = async (path: string) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);

test('volume and mute act on the private PipeWire sink, read back, and are restored', { skip }, async t => {
  started(t, 'pipewire', []);
  await until(async () => { await run('pw-cli', ['info', '0'], { timeout: 2000 }); return true; }, 'PipeWire');
  started(t, 'wireplumber', []);
  await until(async () => { await run('wpctl', ['status'], { timeout: 2000 }); return true; }, 'WirePlumber');
  await run('pw-cli', ['create-node', 'adapter', '{ factory.name=support.null-audio-sink node.name=cere-fixture-sink node.description="Cere fixture sink" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }']);
  await until(async () => (await audioStatus()).available === true, 'the fixture sink to become the default');
  const original = await audioStatus() as { percent: number; muted: boolean };
  const target = original.percent === 35 ? 40 : 35;
  try {
    assert.equal(await desktopAction('audio.volume', { percent: target }, settings), `Volume ${target}%`);
    assert.equal((await audioStatus() as any).percent, target, 'wpctl reports the new volume');
    assert.equal(await desktopAction('audio.mute', {}, settings), 'Mute toggled');
    assert.equal((await audioStatus() as any).muted, !original.muted, 'the sink is muted');
    await desktopAction('audio.mute', {}, settings);
    assert.equal((await audioStatus() as any).muted, original.muted, 'muting is restored');
  } finally {
    await desktopAction('audio.volume', { percent: original.percent }, settings);
  }
  assert.equal((await audioStatus() as any).percent, original.percent, 'the original volume is restored');
});

test('media control drives an MPRIS player once per command and refuses unsupported or vanished targets', { skip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-mpris-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.log'), name = 'org.mpris.MediaPlayer2.cerefixture';
  const player = started(t, 'python3', ['tests/fixtures/fake-mpris.py', 'cerefixture', log]);
  await new Promise<void>((resolve, reject) => {
    player.stdout!.on('data', data => { if (String(data).includes('ready')) resolve(); });
    player.once('exit', () => reject(new Error('The fixture player exited')));
  });
  const status = await mediaStatus(name) as any;
  assert.deepEqual([status.name, status.status, status.canPlayPause, status.canNext], ['Cere fixture player', 'Paused', true, false]);
  const played = await desktopAction('media.control', { command: 'PlayPause', player: name }, settings) as any;
  assert.equal(played.player, name);
  assert.equal((await mediaStatus(name) as any).status, 'Playing', 'the player reports the change');
  // A command the player does not offer is refused before anything reaches it.
  await assert.rejects(desktopAction('media.control', { command: 'Next', player: name }, settings), /cannot perform Next/);
  await desktopAction('media.control', { command: 'PlayPause', player: name }, settings);
  assert.equal((await mediaStatus(name) as any).status, 'Paused', 'the original state is restored');
  assert.deepEqual(await lines(log), ['PlayPause', 'PlayPause'], 'each accepted command reached the player exactly once');
  const exited = new Promise(resolve => player.once('exit', resolve));
  player.kill(); await exited;
  await until(async () => !('player' in await mediaStatus(name)), 'the player to leave the bus');
  await assert.rejects(desktopAction('media.control', { command: 'PlayPause', player: name }, settings), /no longer available/);
  assert.deepEqual(await lines(log), ['PlayPause', 'PlayPause'], 'nothing reached the vanished player');
});

test('application launch and file opening run the reviewed entry, resolve links, and refuse removed targets', { skip }, async t => {
  // The sandbox home is private: the fixture entry and its file association exist only in this run.
  const applications = join(homedir(), '.local/share/applications'), entry = join(applications, 'cere-fixture.desktop');
  const directory = await mkdtemp(join(tmpdir(), 'cere-open-')), marker = join(directory, 'opened.log');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(applications, { recursive: true }); await mkdir(join(homedir(), '.config'), { recursive: true });
  const program = join(directory, 'open.sh');
  await writeFile(program, `#!/bin/sh\nprintf '%s\\n' "\${1:-launched}" >> '${marker}'\n`, { mode: 0o755 });
  await writeFile(entry, `[Desktop Entry]\nType=Application\nName=Cere fixture\nExec=${program} %f\nMimeType=text/plain;\n`);
  await writeFile(join(homedir(), '.config/mimeapps.list'), '[Default Applications]\ntext/plain=cere-fixture.desktop\n');
  t.after(async () => { await unlink(entry).catch(() => {}); await unlink(join(homedir(), '.config/mimeapps.list')).catch(() => {}); });

  assert.ok((await desktopAction('apps.list', {}, settings) as any[]).some(app => app.id === 'cere-fixture.desktop'), 'the entry is listed');
  assert.equal(await desktopAction('apps.launch', { desktopId: 'cere-fixture.desktop' }, settings), 'Application launched');
  await until(async () => (await lines(marker)).includes('launched'), 'the launched application');

  // A link is opened as the file it names, which is what the review showed.
  const file = join(directory, 'notes.txt'), link = join(directory, 'latest.txt');
  await writeFile(file, 'notes\n'); await symlink(file, link);
  assert.equal(await desktopAction('files.open', { path: link }, settings), 'Opened');
  await until(async () => (await lines(marker)).includes(file), 'the opened file');

  // Targets removed since review are refused before anything starts.
  const before = await lines(marker);
  await unlink(file);
  await assert.rejects(desktopAction('files.open', { path: link }, settings), /ENOENT/);
  await unlink(entry);
  await assert.rejects(desktopAction('apps.launch', { desktopId: 'cere-fixture.desktop' }, settings), /no longer installed/);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(await lines(marker), before, 'nothing ran for the removed targets');
});
