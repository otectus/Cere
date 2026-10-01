import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Shared layout and colour rules live in qml/Theme.qml; these checks keep them there.
const qml = new URL('../qml/', import.meta.url);
// The avatar's own artwork (portrait, badge and pet acting) keeps its painted colours.
const artwork = new Set(['Theme.qml', 'CerePortrait.qml', 'EmoticonBadge.qml', 'MotionStage.qml', 'GesturePlayer.qml']);
const files = readdirSync(qml).filter(name => name.endsWith('.qml') && !artwork.has(name));
const source = (name: string) => readFileSync(new URL(name, qml), 'utf8');
const theme = source('Theme.qml');
const colour = (name: string) => {
  const match = theme.match(new RegExp(`property color ${name}: "#([0-9a-fA-F]{6,8})"`));
  assert.ok(match, `Theme.${name} is defined`);
  return match[1].slice(-6);
};
const luminance = (hex: string) => {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
};
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(colour(a)), luminance(colour(b))].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

test('interface colours come from Theme tokens, not literals', () => {
  const literals = files.flatMap(name => [...source(name).matchAll(/"#[0-9a-fA-F]{3,8}"/g)].map(match => `${name}: ${match[0]}`));
  assert.deepEqual(literals, []);
});

test('no text is set below the 11 px floor of the Theme type scale', () => {
  const small = files.flatMap(name => [...source(name).matchAll(/pixelSize\s*:[^;\n}]*/g)]
    .flatMap(match => [...match[0].matchAll(/(?<![\w.])(\d+)(?![\w.])/g)].map(number => Number(number[1])).filter(size => size < 11).map(size => `${name}: ${size} in "${match[0].trim()}"`)));
  assert.deepEqual(small, []);
  const scale = [...theme.matchAll(/property int (caption|secondary|body|message|section|title|page|display|wordmark|glyph): (\d+)/g)];
  assert.equal(scale.length, 10);
  for (const [, name, size] of scale) assert.ok(Number(size) >= 11, `Theme.${name} is ${size} px`);
});

test('theme colours meet WCAG 2.2 AA on every surface they sit on (4.5:1 text, 3:1 boundaries)', () => {
  const surfaces = ['background', 'sidebar', 'surface', 'raised', 'input'];
  for (const text of ['text', 'muted', 'cyan', 'success', 'danger', 'amber', 'accent'])
    for (const surface of [...surfaces, 'selected']) assert.ok(contrast(text, surface) >= 4.5, `${text} on ${surface}: ${contrast(text, surface).toFixed(2)}`);
  for (const boundary of ['border', 'borderHover', 'borderStrong', 'primaryBorder', 'dangerBorder', 'warningBorder', 'approvalBorder', 'scrollThumb', 'cyan'])
    for (const surface of surfaces) assert.ok(contrast(boundary, surface) >= 3, `${boundary} on ${surface}: ${contrast(boundary, surface).toFixed(2)}`);
  for (const [boundary, fill] of [['approvalBorder', 'approvalSurface'], ['warningBorder', 'warningSurface'], ['dangerBorder', 'dangerSurface'], ['border', 'questionSurface']])
    assert.ok(contrast(boundary, fill) >= 3, `${boundary} on ${fill}: ${contrast(boundary, fill).toFixed(2)}`);
});
