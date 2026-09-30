import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

// Exercise exactly the JavaScript Qt imports, while keeping the catalogue and
// puppet contract data-driven.
const motion = vm.createContext({});
vm.runInContext(readFileSync(new URL('../qml/Motion.js', import.meta.url), 'utf8')
  .replace(/^\.pragma library\s*/, ''), motion);
const catalog: any = JSON.parse(readFileSync(new URL('../assets/motions.json', import.meta.url), 'utf8'));
catalog.puppet = JSON.parse(readFileSync(new URL(`../assets/${catalog.rig}`, import.meta.url), 'utf8'));
const channels = Object.keys(catalog.puppet.channels);

function stateFor(name: string, seed = 19): any {
  const state = motion.create(seed);
  motion.select(state, catalog.clips[name], catalog, name);
  return state;
}

function sample(state: any, seconds = 1 / 120, intensity = 1, interaction?: any): any {
  return motion.sample(state, seconds, intensity, 0, 0, 0, 0, false, interaction);
}

test('critical and elastic springs are exact and refresh independent', () => {
  for (const [fn, args] of [[motion.spring, [13]], [motion.elastic, [11, .72]]] as const) {
    const results = [30, 60, 120, 144, 240].map(hz => {
      const state = { value: -2.25, velocity: 3.5 };
      for (let i = 0; i < hz; ++i) fn(state, 4, 1 / hz, ...args);
      return state;
    });
    for (const result of results) {
      assert.ok(Math.abs(result.value - results[0].value) < 1e-10);
      assert.ok(Math.abs(result.velocity - results[0].velocity) < 1e-10);
    }
  }
  const stopped = { value: 1, velocity: -2 };
  motion.spring(stopped, 8, 0, 20);
  motion.elastic(stopped, 8, -1, 12, .7);
  assert.deepEqual(stopped, { value: 1, velocity: -2 });
});

test('selecting an interruption retains every joint value and velocity', () => {
  const state = stateFor('wave');
  for (let i = 0; i < 50; ++i) sample(state);
  const before = structuredClone(state.springs);
  motion.select(state, catalog.clips.waiting, catalog, 'waiting');
  assert.deepEqual(structuredClone(state.springs), before);
  assert.equal(state.entry.duration, catalog.clips.waiting.entryMs);
});

test('catalogue and puppet references are complete and valid', () => {
  assert.equal(Object.keys(catalog.clips).length, 67);
  assert.equal(catalog.frames.length, 32);
  assert.ok(catalog.rig && Object.keys(catalog.puppet.poses).length >= catalog.frames.length);
  for (const [name, config] of Object.entries<any>(catalog.puppet.channels)) {
    assert.ok(Number.isFinite(config.min) && Number.isFinite(config.max) && config.min <= config.max, name);
    assert.ok(Number.isFinite(config.omega) && config.omega > 0, name);
  }
  const articulation = catalog.puppet.articulation;
  assert.ok(articulation && articulation.foldLead > 0 && articulation.foldLead < 1);
  assert.equal(articulation.arms.length, 2);
  for (const arm of articulation.arms) {
    assert.ok(channels.includes(arm.shoulder), `articulation shoulder ${arm.shoulder}`);
    assert.ok(channels.includes(arm.elbow), `articulation elbow ${arm.elbow}`);
    assert.ok(Math.abs(arm.liftSign) === 1, `articulation lift sign ${arm.shoulder}`);
  }
  for (const [name, clip] of Object.entries<any>(catalog.clips)) {
    assert.ok(Array.isArray(clip.keys) && clip.keys.length > 0, name);
    for (const key of clip.keys) {
      assert.ok(Number.isFinite(key.ms) && key.ms > 0, `${name} duration`);
      assert.ok(Number.isInteger(key.pose) && key.pose >= 0 && key.pose < catalog.frames.length, `${name} pose`);
      assert.ok(catalog.puppet.poses[String(key.pose)], `${name} stance ${key.pose}`);
      if (key.easeMs !== undefined) assert.ok(key.easeMs > 0 && key.easeMs <= key.ms, `${name} easing`);
      for (const channel of Object.keys(key.rig || {})) assert.ok(channels.includes(channel), `${name} key channel ${channel}`);
      for (const [channel, value] of Object.entries<any>(key.joints || {})) {
        const config = catalog.puppet.channels[channel];
        assert.ok(config, `${name} stance channel ${channel}`);
        assert.ok(Number.isFinite(value) && value >= config.min && value <= config.max, `${name}/${channel} stance bound`);
      }
    }
  }
});

test('all clips stay finite and within their puppet channel limits', () => {
  for (const [name] of Object.entries<any>(catalog.clips)) {
    const state = stateFor(name);
    // Ten seconds crosses all normal loops and allows underdamped hair to settle.
    for (let tick = 0; tick < 1200; ++tick) {
      const result = sample(state, 1 / 120, .9);
      for (const channel of channels) {
        const value = result[channel], config = catalog.puppet.channels[channel];
        assert.ok(Number.isFinite(value), `${name}/${channel} is finite`);
        // Hair is intentionally underdamped; its authored overshoot remains tiny.
        assert.ok(value >= config.min - .25 && value <= config.max + .25,
          `${name}/${channel}=${value} outside [${config.min}, ${config.max}]`);
      }
    }
  }
});

test('still mode is the exact first stance and never advances either clock', () => {
  for (const [name, clip] of Object.entries<any>(catalog.clips)) {
    const state = stateFor(name);
    for (let i = 0; i < 17; ++i) sample(state);
    const beforeTime = state.time, beforeElapsed = state.elapsed;
    const result = motion.sample(state, 8, 0, 1, -1, 100, -100, true);
    const stance = { ...catalog.puppet.poses[String(clip.keys[0].pose)].joints, ...(clip.keys[0].joints || {}) };
    assert.equal(result.pose, clip.keys[0].pose, name);
    assert.equal(result.keyIndex, 0, name);
    for (const channel of channels) assert.equal(result[channel], stance[channel] || 0, `${name}/${channel}`);
    assert.equal(state.time, beforeTime, name);
    assert.equal(state.elapsed, beforeElapsed, name);
  }
});

test('partial key stances inherit their pose and remain exact in still and zero-intensity modes', () => {
  const key = { pose: 9, ms: 1000, joints: { leftHandOpen: 0 } };
  const held = { label: 'Held override', loop: true, entryMs: 0, life: catalog.clips.waiting.life, keys: [key] };
  const expected = { ...catalog.puppet.poses['9'].joints, ...key.joints };
  const directState: any = motion.create(); directState.catalog = catalog;
  assert.deepEqual(JSON.parse(JSON.stringify(motion.keyStance(directState, key))), expected);

  const still = motion.create(); motion.select(still, held, catalog, 'held override');
  const stillResult = motion.sample(still, 5, 0, 0, 0, 0, 0, true);
  assert.equal(stillResult.leftHandOpen, 0);
  assert.equal(stillResult.rightArm, expected.rightArm);
  assert.equal(stillResult.leftElbow, expected.leftElbow);

  const zero = motion.create(); motion.select(zero, held, catalog, 'held override');
  for (let i = 0; i < 600; ++i) sample(zero, 1 / 120, 0);
  assert.ok(Math.abs(sample(zero, 1 / 120, 0).leftHandOpen) < 1e-8);
});

test('intensity scales acting offsets while retaining anatomical stance', () => {
  // Permission stance has raised, open hands. At zero intensity those anatomical
  // angles must remain after springs settle; they must never be multiplied to 0.
  // Waiting normally cycles through attentive poses; hold pose 9 here so this
  // isolates intensity from the catalogue's deliberate state progression.
  const heldWaiting = { ...catalog.clips.waiting, entryMs: 0, keys: [{ ...catalog.clips.waiting.keys[0], pose: 9, ms: 1000 }] };
  const quiet = motion.create();
  motion.select(quiet, heldWaiting, catalog, 'waiting-held');
  for (let i = 0; i < 600; ++i) sample(quiet, 1 / 120, 0);
  const zero = sample(quiet, 1 / 120, 0);
  const stance = catalog.puppet.poses['9'].joints;
  assert.ok(Math.abs(zero.leftArm - stance.leftArm) < 1e-8);
  assert.ok(Math.abs(zero.leftElbow - stance.leftElbow) < 1e-8);
  assert.ok(Math.abs(zero.leftHandOpen - 1) < 1e-8);
  assert.notEqual(zero.leftArm, 0);

  const acting = motion.create();
  motion.select(acting, heldWaiting, catalog, 'waiting-held');
  let maximumActingOffset = 0;
  for (let i = 0; i < 600; ++i) {
    const result = sample(acting, 1 / 120, 1);
    maximumActingOffset = Math.max(maximumActingOffset, Math.abs(result.headTilt - zero.headTilt));
  }
  assert.ok(maximumActingOffset > .05);
});

test('wave visibly articulates its elbow through the authored greeting', () => {
  const state = stateFor('wave');
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 600; ++i) {
    const result = sample(state, 1 / 120, 1);
    min = Math.min(min, result.leftElbow); max = Math.max(max, result.leftElbow);
  }
  assert.ok(max - min > 15, `elbow range ${max - min}`);
});

test('glasses adjustment keeps its hand sprite closed through every intensity', () => {
  for (const intensity of [.2, .5, 1]) {
    const state = stateFor('idle', 41);
    for (let i = 0; i < 240; ++i) sample(state, 1 / 120, intensity);
    motion.select(state, catalog.clips.glassesAdjust, catalog, 'glassesAdjust');
    let maximum = -Infinity;
    for (let i = 0; i < 720; ++i) maximum = Math.max(maximum, sample(state, 1 / 120, intensity).leftHandOpen);
    assert.ok(maximum <= .5, `intensity ${intensity}: leftHandOpen=${maximum}`);
  }
});

test('mirrored arms fold before lifting and release after lowering', () => {
  const articulation = { foldLead: .22, arms: [
    { shoulder: 'leftArm', elbow: 'leftElbow', liftSign: 1 },
    { shoulder: 'rightArm', elbow: 'rightElbow', liftSign: -1 },
  ] };
  const state: any = motion.create();
  state.catalog = { puppet: { articulation } };
  const rise = { leftArm: 0, leftElbow: 0, rightArm: 0, rightElbow: 0 };
  const raised = { leftArm: 60, leftElbow: 80, rightArm: -60, rightElbow: 80 };
  const lower = raised;
  const rest = rise;
  for (const [shoulder, elbow] of [['leftArm', 'leftElbow'], ['rightArm', 'rightElbow']] as const) {
    assert.equal(motion.jointProgress(state, rise, raised, shoulder, 0), 0);
    assert.equal(motion.jointProgress(state, rise, raised, elbow, 0), 0);
    assert.equal(motion.jointProgress(state, rise, raised, shoulder, 1), 1);
    assert.equal(motion.jointProgress(state, rise, raised, elbow, 1), 1);
    // At one fifth of the segment, the early-folding elbow is materially ahead.
    assert.ok(motion.jointProgress(state, rise, raised, elbow, .2) > motion.jointProgress(state, rise, raised, shoulder, .2));
    // On the way down the shoulder leads and the elbow stays folded longer.
    assert.ok(motion.jointProgress(state, lower, rest, shoulder, .2) > motion.jointProgress(state, lower, rest, elbow, .2));
  }
});

test('joint articulation uses a quintic, monotonic endpoint curve', () => {
  const state: any = motion.create();
  state.catalog = { puppet: { articulation: { foldLead: .22, arms: [
    { shoulder: 'leftArm', elbow: 'leftElbow', liftSign: 1 },
  ] } } };
  const previous = { leftArm: 0, leftElbow: 0, bodyTilt: 0 }, next = { leftArm: 60, leftElbow: 80, bodyTilt: 1 };
  let last = -1;
  for (let i = 0; i <= 100; ++i) {
    const progress = motion.jointProgress(state, previous, next, 'bodyTilt', i / 100);
    assert.ok(progress >= last, `non-monotonic at ${i}`);
    last = progress;
  }
  assert.equal(motion.jointProgress(state, previous, next, 'bodyTilt', 0), 0);
  assert.equal(motion.jointProgress(state, previous, next, 'bodyTilt', 1), 1);
  // Quintic smoothstep has the exact midpoint 1/2 and a zero-slope endpoint.
  assert.equal(motion.jointProgress(state, previous, next, 'bodyTilt', .5), .5);
  assert.ok(motion.jointProgress(state, previous, next, 'bodyTilt', .001) < 1e-7);
  assert.ok(1 - motion.jointProgress(state, previous, next, 'bodyTilt', .999) < 1e-7);
});

test('entry snapshots current joints and dt=0 cannot teleport an interruption', () => {
  const state = stateFor('wave');
  for (let i = 0; i < 75; ++i) sample(state);
  const before = structuredClone(state.springs);
  motion.select(state, catalog.clips.speaking, catalog, 'speaking');
  const initial = JSON.parse(JSON.stringify(state.entry.initial.joints));
  assert.deepEqual(initial, Object.fromEntries(channels.map(channel => [channel, before[channel].value])));
  const atZero = sample(state, 0);
  for (const channel of channels) assert.equal(atZero[channel], before[channel].value, channel);
});

test('first loop starts from its first stance; later wraps blend last to first', () => {
  const loop: any = { loop: true, initial: { pose: 0, joints: { leftArm: 0 } }, keys: [
    { pose: 0, ms: 100, joints: { leftArm: 0 } },
    { pose: 9, ms: 100, joints: { leftArm: 35 } },
  ] };
  assert.equal(motion.frameAt(loop, 0).previous.pose, 0);
  assert.equal(motion.frameAt(loop, 99).previous.pose, 0);
  assert.equal(motion.frameAt(loop, 200).previous.pose, 9);
});

test('roaming runs counter-swing arms as well as legs', () => {
  for (const name of ['runLeft', 'runRight']) {
    const state = stateFor(name);
    const values: Record<string, number[]> = { leftArm: [], rightArm: [], leftLeg: [], rightLeg: [] };
    for (let i = 0; i < 480; ++i) {
      const result = sample(state, 1 / 120, 1);
      for (const channel of Object.keys(values)) values[channel].push(result[channel]);
    }
    const range = (channel: string) => Math.max(...values[channel]) - Math.min(...values[channel]);
    assert.ok(range('leftLeg') > 2 && range('rightLeg') > 2, `${name} leg stride`);
    assert.ok(range('leftArm') > 1 && range('rightArm') > 1, `${name} arm swing`);
    assert.notDeepEqual(values.leftArm, values.rightArm, `${name} arms do not move as one rigid bar`);
  }
});

test('long entries stage anticipation, transfer and arrival while urgent states arrive directly', () => {
  const staged = motion.create(5);
  staged.pose = 0;
  motion.select(staged, catalog.clips.speaking, catalog, 'speaking');
  const phases = new Set<string>(), poses = new Set<number>();
  for (let i = 0; i < 160; ++i) {
    const result = sample(staged);
    phases.add(result.phase); poses.add(result.pose);
  }
  for (const phase of ['anticipate', 'release', 'transfer', 'arrive', 'settle', 'living']) assert.ok(phases.has(phase), phase);
  for (const pose of [0, 25, 26, 22]) assert.ok(poses.has(pose), `staged pose ${pose}`);

  const urgent = motion.create(7);
  urgent.pose = 0;
  motion.select(urgent, catalog.clips.waiting, catalog, 'waiting');
  const urgentPhases = new Set<string>();
  for (let i = 0; i < 18; ++i) urgentPhases.add(sample(urgent).phase);
  assert.ok(urgentPhases.has('arrive'));
  assert.ok(urgentPhases.has('living'));
  assert.ok(!urgentPhases.has('release') && !urgentPhases.has('transfer'));
  assert.equal(urgent.pose, 9);
});

test('idle attention varies without immediate repeats and pointer attention takes precedence', () => {
  const state = stateFor('idle', 17);
  const kinds: number[] = [];
  let seen = 0;
  for (let i = 0; i < 60 * 120; ++i) {
    sample(state);
    if (state.beatCount !== seen) { kinds.push(state.lastBeat); seen = state.beatCount; }
  }
  assert.ok(kinds.length >= 8);
  assert.ok(new Set(kinds).size >= 3);
  assert.ok(kinds.every((kind, index) => index === 0 || kind !== kinds[index - 1]));
  const count = state.beatCount;
  for (let i = 0; i < 600; ++i) assert.equal(sample(state, 1 / 120, 1, { hovered: true }).beat, 'At ease');
  assert.equal(state.beatCount, count);
});

test('blink is a continuous 0..1 overlay and does not stop body motion', () => {
  const state = stateFor('idle', 5);
  let partial = 0, closed = 0, previousHead = 0, movingHead = false;
  for (let i = 0; i < 12 * 120; ++i) {
    const result = sample(state);
    assert.ok(result.blink >= 0 && result.blink <= 1);
    assert.ok(result.eyeClose >= 0 && result.eyeClose <= 1);
    if (result.blink > 0 && result.blink < 1) ++partial;
    if (result.blink === 1) ++closed;
    if (i && Math.abs(result.headTilt - previousHead) > 1e-5) movingHead = true;
    previousHead = result.headTilt;
  }
  assert.ok(partial > 25, `partial frames ${partial}`);
  assert.ok(closed >= 4, `closed frames ${closed}`);
  assert.ok(movingHead);
});


test('an interrupted blink finishes smoothly while a new gesture starts', () => {
  const state = stateFor('idle', 5);
  let before: any;
  for (let i = 0; i < 500; ++i) {
    before = sample(state);
    if (before.blink > .2 && before.blink < .8) break;
  }
  assert.ok(before.blink > .2 && before.blink < .8);
  motion.select(state, catalog.clips.wave, catalog, 'wave');
  const interrupted = sample(state, 0);
  assert.equal(interrupted.eyeClose, before.eyeClose);
  const after = sample(state, 1 / 240);
  assert.ok(Math.abs(after.eyeClose - interrupted.eyeClose) < .12);
  for (let i = 0; i < 90; ++i) sample(state);
  assert.equal(state.blink, 0);
});
