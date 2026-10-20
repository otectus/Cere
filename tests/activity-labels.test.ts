import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const declared = read('broker/types.ts').match(/export type SessionActivity = ([^;]+);/);
const activities = [...(declared?.[1] || '').matchAll(/'(\w+)'/g)].map(match => match[1]);

// A session's activity is what the conversation shows while a turn runs. One without a label in a
// view falls back to a vague status there, as an unlabelled "recalling" would have.
test('every session activity has a label in each desktop view and in Cere Mobile', () => {
  assert.ok(activities.includes('recalling') && activities.length >= 8, activities.join(', '));
  const views = [
    ['qml/Chat.qml', (a: string) => `case "${a}":`],
    ['qml/ActivityPanel.qml', (a: string) => `case "${a}":`],
    ['qml/SessionList.qml', (a: string) => `case"${a}":`],
    ['mobile/android/app/src/main/kotlin/dev/otectus/cere/mobile/InteractionState.kt', (a: string) => `session.activity == "${a}"`],
  ] as const;
  const missing = views.flatMap(([path, label]) => { const source = read(path); return activities.filter(a => !source.includes(label(a))).map(a => `${path}: ${a}`); });
  assert.deepEqual(missing, []);
});

// W05: the phone's conversation timeline names a working turn's activity with the desktop chat's words.
test('the shared activity labels are the ones the desktop chat shows', () => {
  const chat = read('qml/Chat.qml');
  const body = chat.slice(chat.indexOf('function activityStatus()'), chat.indexOf('default:', chat.indexOf('function activityStatus()')));
  const desktop = Object.fromEntries([...body.matchAll(/case "(\w+)": return "([^"]+)"/g)].map(match => [match[1], match[2]]));
  const { labels } = JSON.parse(read('tests/fixtures/activity-labels.json'));
  assert.deepEqual(desktop, labels);
  assert.deepEqual(Object.keys(labels).sort(), [...activities].sort(), 'every activity has a timeline label');
});
