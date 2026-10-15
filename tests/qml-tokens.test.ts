import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// All avatar palettes must cover the same controls and keep their text readable.
const qml = new URL('../qml/', import.meta.url);
const files = readdirSync(qml).filter(name => name.endsWith('.qml'));
const artwork = new Set(['Theme.qml', 'CerePortrait.qml', 'EmoticonBadge.qml', 'MotionStage.qml', 'GesturePlayer.qml']);
const source = (name: string) => readFileSync(new URL(name, qml), 'utf8');
const theme = source('Theme.qml');
const palettes: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('../assets/palettes.json', import.meta.url), 'utf8'));
const luminance = (hex: string) => {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
};
const contrast = (palette: Record<string, string>, a: string, b: string) => {
  const [light, dark] = [luminance(palette[a].slice(-6)), luminance(palette[b].slice(-6))].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

test('interface colours come from Theme tokens, not literals', () => {
  const literals = files.flatMap(name => [...source(name).matchAll(/"#[0-9a-fA-F]{3,8}"/g)].map(match => `${name}: ${match[0]}`));
  assert.deepEqual(literals, []);
});

test('every avatar has a complete palette, with no unknown or malformed tokens', () => {
  const avatars: {id: string}[] = JSON.parse(readFileSync(new URL('../assets/avatars.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(palettes).sort(), avatars.map(a => a.id).sort());
  const tokens = [...theme.matchAll(/property color (\w+): colors\.\w+/g)].map(match => match[1]).sort();
  for (const [id, palette] of Object.entries(palettes)) {
    assert.deepEqual(Object.keys(palette).sort(), tokens, id);
    for (const [token, value] of Object.entries(palette)) assert.match(value, /^#(?:[a-f0-9]{6}|[a-f0-9]{8})$/, `${id}.${token}`);
  }
});

test('no text is set below the 11 px floor of the Theme type scale', () => {
  const small = files.filter(name => !artwork.has(name)).flatMap(name => [...source(name).matchAll(/pixelSize\s*:[^;\n}]*/g)]
    .flatMap(match => [...match[0].matchAll(/(?<![\w.])(\d+)(?![\w.])/g)].map(number => Number(number[1])).filter(size => size < 11).map(size => `${name}: ${size} in "${match[0].trim()}"`)));
  assert.deepEqual(small, []);
  const scale = [...theme.matchAll(/property int (caption|secondary|body|message|section|title|page|display|wordmark|glyph): (\d+)/g)];
  assert.equal(scale.length, 10);
  for (const [, name, size] of scale) assert.ok(Number(size) >= 11, `Theme.${name} is ${size} px`);
});

for (const [id, palette] of Object.entries(palettes)) test(`${id} colours meet WCAG 2.2 AA on every surface they sit on (4.5:1 text, 3:1 boundaries)`, () => {
  const surfaces = ['background', 'sidebar', 'surface', 'raised', 'input'];
  const ratio = (a: string, b: string) => contrast(palette, a, b);
  for (const text of ['text', 'muted', 'accentText', 'success', 'danger', 'amber', 'accent'])
    for (const surface of [...surfaces, 'selected']) assert.ok(ratio(text, surface) >= 4.5, `${text} on ${surface}: ${ratio(text, surface).toFixed(2)}`);
  for (const boundary of ['border', 'borderHover', 'borderStrong', 'primaryBorder', 'dangerBorder', 'warningBorder', 'approvalBorder', 'scrollThumb', 'accentText'])
    for (const surface of surfaces) assert.ok(ratio(boundary, surface) >= 3, `${boundary} on ${surface}: ${ratio(boundary, surface).toFixed(2)}`);
  for (const [boundary, fill] of [['approvalBorder', 'approvalSurface'], ['warningBorder', 'warningSurface'], ['dangerBorder', 'dangerSurface'], ['border', 'questionSurface']])
    assert.ok(ratio(boundary, fill) >= 3, `${boundary} on ${fill}: ${ratio(boundary, fill).toFixed(2)}`);
  for (const fill of ['codeSurface', 'userBubble', 'approvalSurface', 'questionSurface', 'warningSurface', 'dangerSurface', 'questionBadge', 'permissionBadge'])
    for (const text of ['text', 'muted']) assert.ok(ratio(text, fill) >= 4.5, `${text} on ${fill}: ${ratio(text, fill).toFixed(2)}`);
  for (const text of ['accentText', 'danger', 'amber', 'success', 'warm'])
    assert.ok(ratio(text, 'badgeSurface') >= 4.5, `${text} on badgeSurface: ${ratio(text, 'badgeSurface').toFixed(2)}`);
});
