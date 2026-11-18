import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { avatarCatalog } from '../broker/avatars.ts';

// qml/SettingsCatalog.js drives the Settings rail, chips, search, the command palette and deep links.
const qml = new URL('../qml/', import.meta.url);
const source = (name: string) => readFileSync(new URL(name, qml), 'utf8');
const catalog: any = vm.createContext({});
vm.runInContext(source('SettingsCatalog.js').replace(/^\.pragma library\s*/, ''), catalog);
const search = (query: string, hidden?: string[]) => catalog.search(query, hidden, avatarCatalog);
const files = readdirSync(qml).filter(name => name.endsWith('.qml'));
const all = files.map(source).join('\n');
// The catalog runs in its own realm; copy what is compared structurally into this one.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settings = plain(catalog.categories.flatMap((category: any) => category.settings.map((setting: any) => ({ ...setting, category: category.id }))));

test('every catalog target names a control that exists in the QML', () => {
  const literal = new Set([...all.matchAll(/objectName\s*:\s*"([^"]+)"/g)].map(match => match[1]));
  // A few controls are named per item, as "apiKey_"+provider; the item must also be named somewhere.
  const prefixes = [...all.matchAll(/objectName\s*:\s*"([^"]+)"\s*\+/g)].map(match => match[1]);
  // Others take a property's value, as VoiceSettings' sliders take their settingKey.
  const indirect = [...all.matchAll(/objectName\s*:\s*\w+\.(\w+)\s*[;\n}]/g)].map(match => match[1]);
  for (const { target, label } of settings) {
    const prefix = prefixes.find(value => target.startsWith(value) && all.includes(`"${target.slice(value.length)}"`));
    const named = indirect.some(property => new RegExp(`\\b${property}\\s*:\\s*"${target}"`).test(all));
    assert.ok(literal.has(target) || prefix || named, `${label} → ${target} is not an objectName in qml/`);
  }
});

test('ids, targets and labels are unique, and every category is complete', () => {
  const groups = new Set(catalog.groups.map((group: any) => group.id));
  const ids = catalog.categories.map((category: any) => category.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(catalog.categories.map((category: any) => category.label)).size, ids.length);
  assert.equal(new Set(settings.map((setting: any) => setting.target)).size, settings.length);
  const icons = source('CIcon.qml');
  for (const category of catalog.categories) {
    assert.ok(groups.has(category.group), `${category.id} has a known group`);
    assert.ok(category.settings.length > 0 && category.blurb && category.keywords, `${category.id} is complete`);
    assert.ok(new RegExp(`\\b${category.icon}:`).test(icons), `${category.id} uses a CIcon path`);
    assert.equal(new Set(category.settings.map((setting: any) => setting.label)).size, category.settings.length);
    for (const setting of category.settings) assert.equal(catalog.categoryOf(setting.target), category.id);
  }
  assert.ok(catalog.category(catalog.defaultCategory));
});

test('Settings has one page per category, and the palette builds its entries from the catalog', () => {
  const page = source('Settings.qml'), pages = page.match(/pages:\(\{([^}]*)\}\)/)?.[1] || '';
  assert.deepEqual(pages.split(',').map(entry => entry.split(':')[0].trim()).sort(), plain(catalog.categories.map((category: any) => category.id)).sort());
  assert.doesNotMatch(page, /settingsSectionPicker|navigationEntries/);
  const palette = source('CommandPalette.qml');
  assert.match(palette, /import "SettingsCatalog\.js" as SettingsCatalog/);
  assert.doesNotMatch(palette, /settingsEntries/);
  for (const category of catalog.categories) assert.ok(!palette.includes(`"${category.label}"`), `CommandPalette.qml hard-codes "${category.label}"`);
});

test('search ranks a setting by its own words and honours unavailable categories', () => {
  const only = search('citations');
  assert.equal(only.length, 1);
  assert.equal(only[0].setting.target, 'showMemoryCitations');
  assert.equal(search('citation')[0].setting.target, 'showMemoryCitations');
  assert.equal(search('Memory citations')[0].setting.target, 'showMemoryCitations');
  assert.equal(search('no-such-setting').length, 0);
  assert.equal(search('   ').length, 0);
  // A category's exact name leads; its own settings follow by how well their labels match.
  const voice = search('voice');
  assert.equal(voice[0].category.id, 'voice'); assert.equal(voice[0].setting, null);
  assert.ok(voice.some((result: any) => result.setting?.target === 'speechVoice'));
  assert.ok(!search('voice', ['voice']).some((result: any) => result.category.id === 'voice'));
  // Keywords find settings whose labels use other words.
  assert.ok(search('gemini').some((result: any) => result.setting?.target === 'apiKey_google'));
  assert.equal(search('backup')[0].setting.target, 'openBackup');
  assert.equal(search('quiet')[0].setting.target, 'quietMode');
  assert.equal(catalog.categoryOf('avatarSelection'), 'companion');
  for (const word of ['avatar', 'appearance', 'mask', 'tactical', 'tan', 'purple', ...avatarCatalog.map(entry => entry.id.replaceAll('_', ' '))]) {
    const result = search(word)[0];
    assert.equal(result.setting.target, 'avatarSelection');
    assert.equal(result.category.id, 'companion');
  }
  // Automatic delegation updates sit with the other AI assistance switches.
  assert.equal(catalog.categoryOf('delegationUpdates'), 'assistance');
  assert.equal(search('delegated results')[0].setting.target, 'delegationUpdates');
  assert.equal(search('report back')[0].setting.target, 'delegationUpdates');
});


test('new manifest entries reach both Settings and command-palette search without keyword wiring', () => {
  const entries = [...avatarCatalog, { id: 'future_companion', label: 'Future companion', description: 'Copper feathers', themeLabel: 'Autumn', aliases: ['old_friend'] }];
  for (const query of ['future companion', 'copper', 'autumn', 'old friend'])
    assert.equal(catalog.search(query, [], entries)[0].setting.target, 'avatarSelection');
  const companion = catalog.visibleCategories([], entries).find((entry: any) => entry.id === 'companion');
  assert.match(companion.settings.find((entry: any) => entry.target === 'avatarSelection').keywords, /future_companion/);
  assert.match(source('CommandPalette.qml'), /AvatarCatalog\.entries/);
});
