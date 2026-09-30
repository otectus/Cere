import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const faces: any = vm.createContext({});
vm.runInContext(readFileSync(new URL('../qml/EmoticonState.js', import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), faces);
const now = Date.now();
const session = (status = 'idle', activity = '', id = 'a') => ({id, title:id, status, activity, updated:now});
const resolve = (state: any = {}, extra: any = {}) => faces.resolve({connected:true, state, selectedId:'a', now, ...extra});

test('badge covers a broad vocabulary with meaningful, distinct variations', () => {
  assert.ok(Object.keys(faces.faces).length >= 30);
  const glyphs = new Set<string>();
  for (const key of Object.keys(faces.faces)) {
    const entry = faces.make(key);
    assert.ok(entry.label && entry.tone);
    assert.equal(new Set(entry.faces).size, 3);
    for (let variant = 0; variant < 3; variant++) glyphs.add(faces.glyph(entry, variant));
  }
  assert.ok(glyphs.size >= 80);
});

test('connection and permissions override motion, mood, and completion', () => {
  const state = {sessions:[session('error')], approvals:[{sessionId:'a', kind:'question'}], completions:[{sessionId:'a',time:now}]};
  assert.equal(resolve(state, {connected:false, motion:'celebrate'}).key, 'reconnecting');
  assert.equal(resolve(state).key, 'question');
  state.approvals[0].kind = 'cli';
  assert.equal(resolve(state).key, 'approval');
  state.approvals = [];
  assert.equal(resolve(state, {motion:'celebrate'}).key, 'error');
});

test('background activity remains visible while the selected conversation is idle', () => {
  for (const [activity, key] of Object.entries({thinking:'thinking',planning:'planning',working:'working',delegating:'delegating',waitingForAgents:'agents',compacting:'compacting',speaking:'replying'})) {
    const result = resolve({sessions:[session(), session('working', activity, 'background')]}, {hovered:true, motion:'celebrate'});
    assert.equal(result.key, key);
    assert.equal(result.sessionId, 'background');
  }
  const multiple = resolve({sessions:[session('working'), session('working', '', 'b')]});
  assert.equal(multiple.key, 'multitasking');
  assert.equal(multiple.count, 2);
});

test('live tone colors replies, expires, and respects the expressive-cues preference', () => {
  const cues = {a:{mood:'tender', time:now}};
  assert.equal(resolve({sessions:[session('working','speaking')]}, {cues}).key, 'tender');
  assert.equal(resolve({sessions:[session('working','working')]}, {cues}).key, 'working');
  assert.equal(resolve({sessions:[session()]}, {cues, now:now+90001}).key, 'idle');
  assert.equal(resolve({sessions:[session()], settings:{expressiveCues:false}}, {cues}).key, 'idle');
  assert.equal(resolve({sessions:[session()], completions:[{sessionId:'a',time:now}]}, {cues}).key, 'tender');
});

test('closed panels follow fresh background tone; previews remain independent', () => {
  const state = {sessions:[session(), session('idle','','b')]};
  const cues = {b:{mood:'cheeky',time:now}};
  assert.equal(resolve(state, {cues}).key, 'cheeky');
  assert.equal(resolve(state, {cues,panelOpen:true}).key, 'idle');
  assert.equal(resolve({approvals:[{kind:'cli'}]}, {live:false, motion:'music'}).key, 'music');
  assert.equal(resolve({sessions:[session()], speech:{state:'speaking'}}).key, 'speaking');
});

test('the open window supplies the selected conversation across UI hosts', () => {
  const cues = {a:{mood:'cheeky',time:now}, b:{mood:'tender',time:now}};
  for (const owner of ['ui','overlay']) {
    const state = {sessions:[session(),session('idle','','b')],panels:{[owner]:true},attention:{[owner]:{sessionId:'b'}}};
    assert.equal(resolve(state, {cues,panelOpen:true}).key, 'tender');
    assert.equal(resolve(state, {cues,panelOpen:true}).sessionId, 'b');
  }
});
