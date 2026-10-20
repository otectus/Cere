/**
 * W10: desktop actions against a real compositor: the private Hyprland that
 * tools/test-virtual-desktop.sh starts, never the working desktop. Workspace and window actions run
 * through Cere's own dispatch, their effect is read back from Hyprland, a vanished target is refused,
 * and the original workspace is restored. Outside the private desktop these checks skip with that
 * reason, so a passing run elsewhere does not claim them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopAction } from '../broker/desktop.ts';
import { defaultSettings } from '../broker/types.ts';

const run = promisify(execFile);
const privateDesktop = process.env.CERE_VIRTUAL_DESKTOP === '1' && !!process.env.HYPRLAND_INSTANCE_SIGNATURE;
const skip = privateDesktop ? false : 'needs the private Hyprland of tools/test-virtual-desktop.sh';
const hypr = async (...args: string[]) => JSON.parse((await run('hyprctl', ['-j', ...args], { timeout: 5000 })).stdout);
const settings = { ...defaultSettings, categories: ['windows'] } as any;

test('workspace switching acts on the compositor, reads back, and is restored', { skip }, async () => {
  const original = (await hypr('activeworkspace')).id;
  const target = original === 4 ? 5 : 4;
  try {
    assert.equal(await desktopAction('workspace.switch', { workspace: target }, settings), 'Workspace switched');
    for (let n = 0; n < 50 && (await hypr('activeworkspace')).id !== target; n++) await new Promise(r => setTimeout(r, 50));
    assert.equal((await hypr('activeworkspace')).id, target, 'Hyprland reports the switched workspace');
  } finally {
    await desktopAction('workspace.switch', { workspace: original }, settings);
  }
  for (let n = 0; n < 50 && (await hypr('activeworkspace')).id !== original; n++) await new Promise(r => setTimeout(r, 50));
  assert.equal((await hypr('activeworkspace')).id, original, 'the original workspace is restored');
});

test('window listing reads the compositor and a vanished window is refused before acting', { skip }, async () => {
  const listed = await desktopAction('windows.list', {}, settings);
  assert.ok(Array.isArray(listed));
  const clients = await hypr('clients');
  assert.equal(listed.length, clients.length, 'the list is what Hyprland reports');
  // A window address that does not exist (closed since review) changes nothing.
  const before = await hypr('activewindow').catch(() => ({}));
  await assert.rejects(desktopAction('windows.focus', { address: '0xdeadbeef00' }, settings), /That window no longer exists/);
  assert.deepEqual(await hypr('activewindow').catch(() => ({})), before, 'the focused window is unchanged');
});
