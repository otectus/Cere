import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import sharp from 'sharp';

const director = vm.createContext({});
vm.runInContext(readFileSync('qml/SurfaceMotion.js', 'utf8').replace(/^\.pragma library\s*/, ''), director);
const catalog = {
  routes: { wave: { frames: [0, 1, 2, 3], frameMs: 20, holdMs: 40 }, think: { frames: [0, 4, 5, 6], frameMs: 20, holdMs: 40 }, open: { frames: [0, 7, 8, 9], frameMs: 20, holdMs: 40 } },
  motions: { wave: 'wave', thinking: 'think', explainOpen: 'open' }
};
const tick = (state: any, seconds = .02) => director.sample(state, seconds, true);

test('connected gestures enter, hold, and return through the authored drawings', () => {
  const state = director.create();
  director.select(state, catalog, 'wave', false, true);
  assert.deepEqual(Array.from({ length: 9 }, () => tick(state)), [1, 2, 3, 3, 3, 2, 1, 0, 0]);
  assert.equal(state.stage, 'idle');
});

test('interrupted gestures reverse without a cut and the latest request wins', () => {
  const state = director.create();
  director.select(state, catalog, 'wave', false, true);
  tick(state); tick(state);
  director.select(state, catalog, 'thinking', true, true);
  assert.equal(tick(state, 0), 2);
  assert.equal(tick(state), 1);
  director.select(state, catalog, 'explainOpen', false, true);
  assert.deepEqual(Array.from({ length: 4 }, () => tick(state)), [0, 7, 8, 9]);
  assert.equal(state.route, 'open');
});

test('looping poses remain held until interrupted, and disabling always restores neutral', () => {
  const state = director.create();
  director.select(state, catalog, 'thinking', true, true);
  for (let i = 0; i < 300; i++) tick(state);
  assert.equal(state.frame, 6);
  director.select(state, catalog, 'idle', true, true);
  assert.deepEqual(Array.from({ length: 3 }, () => tick(state)), [5, 4, 0]);
  director.select(state, catalog, 'wave', false, true); tick(state);
  assert.equal(director.sample(state, 10, false), 0);
  assert.equal(state.stage, 'idle');
  assert.equal(tick(state), 0);
});

test('source changes reset frame IDs and invalid or suspended clocks stay bounded', () => {
  const state = director.create();
  director.select(state, catalog, 'wave', false, true); tick(state);
  const replacement = { routes: {}, motions: {} };
  director.select(state, replacement, 'wave', false, true);
  assert.equal(state.frame, 0);
  director.select(state, catalog, 'thinking', true, true);
  assert.equal(tick(state, NaN), 0);
  assert.equal(tick(state, -1), 0);
  assert.equal(tick(state, 20), 6);
  assert.equal(state.elapsed, 0);
});

test('hover strengthens on click and settles back without crossing neutral', () => {
  const c = {routes:{shy:{frames:[0,1,2,3,4,5,6],frameMs:20,holdMs:40}},motions:{hoverBlush:'shy',clickBlush:'shy'}};
  const state=director.create();
  director.select(state,c,'hoverBlush',true,true,.5);
  for(let i=0;i<20;i++)tick(state);
  assert.equal(state.frame,3);
  director.select(state,c,'clickBlush',true,true,1);
  assert.equal(tick(state,0),3);
  assert.deepEqual(Array.from({length:3},()=>tick(state)),[4,5,6]);
  director.select(state,c,'hoverBlush',true,true,.5);
  assert.deepEqual(Array.from({length:5},()=>tick(state)),[5,4,3,3,3]);
  director.select(state,c,'idle',true,true);
  assert.deepEqual(Array.from({length:3},()=>tick(state)),[2,1,0]);
});

test('carried poses continuously reverse their flail cycle and retrace on release', () => {
  const c={routes:{carry:{frames:[0,1,2,3,4,5],frameMs:20,loopMode:'pingPong',loopStart:2}},motions:{dragging:'carry'}};
  const state=director.create();director.select(state,c,'dragging',true,true);
  assert.deepEqual(Array.from({length:12},()=>tick(state)),[1,2,3,4,5,4,3,2,3,4,5,4]);
  director.select(state,c,'idle',true,true);
  assert.deepEqual(Array.from({length:4},()=>tick(state)),[3,2,1,0]);
  director.select(state,c,'dragging',true,true);tick(state);
  assert.equal(director.sample(state,.02,false),0);
});

test('all five surface atlases preserve neutral art, planted gestures and free carried limbs', async () => {
  const avatars = JSON.parse(readFileSync('assets/avatars.json', 'utf8'));
  assert.equal(avatars.length, 5);
  for (const avatar of avatars) {
    const rig = JSON.parse(readFileSync('assets/' + avatar.rig, 'utf8'));
    const registration = JSON.parse(readFileSync('artwork/avatars/' + avatar.id + '/registration.json', 'utf8'));
    const part = rig.parts[0];
    const {data, info} = await sharp('assets/' + rig.texture).raw().toBuffer({resolveWithObject: true});
    const original = await sharp('artwork/avatars/' + avatar.id + '/front.png').raw().toBuffer({resolveWithObject: true});
    const [ox, oy] = registration.originalOffset;
    for (let y = 0; y < original.info.height; y++) for (let x = 0; x < original.info.width; x++) {
      const source = (y * original.info.width + x) * 4;
      if (!original.data[source + 3]) continue;
      assert.ok(y + oy < part.sourceRect[3] && x + ox < part.sourceRect[2], avatar.id + ': neutral fits canvas');
      const target = ((y + oy) * info.width + ox + x) * 4;
      assert.deepEqual(data.subarray(target, target + 4), original.data.subarray(source, source + 4), avatar.id + ': exact visible neutral pixels');
    }
    assert.deepEqual(Object.keys(rig.surfaceSequences.routes), ['wave', 'thinking', 'present', 'celebrate', 'shy', 'carry']);
    assert.equal(rig.surfaceSequences.motions.shy, 'shy');
    assert.equal(rig.surfaceSequences.motions.hoverBlush, 'shy');
    assert.equal(rig.surfaceSequences.motions.clickBlush, 'shy');
    assert.equal(rig.surfaceSequences.motions.dragging, 'carry');
    assert.ok(part.surfaceFrames.length <= 384);
    assert.ok(info.width*info.height*4 <= 256*1024*1024, 'atlas stays within Qt image allocation limit');
    const hoverFrame=rig.surfaceSequences.routes.shy.frames[24];
    assert.ok(part.surfaceFrames[hoverFrame-1].blinkSourceRect, 'held hover pose can blink');
    const rects = [part.sourceRect, ...part.surfaceFrames.map((frame: any) => frame.sourceRect)];
    for (const [name, route] of Object.entries<any>(rig.surfaceSequences.routes)) {
      assert.equal(route.frames[0], 0, avatar.id + '/' + name + ': neutral entry');
      assert.ok(route.frames.length >= 30);
      assert.ok(route.frameMs <= 1000 / 60 + 1e-8);
      const endpoint = part.surfaceFrames[route.frames.at(-1) - 1];
      assert.ok(endpoint.blinkSourceRect, avatar.id + '/' + name + ': held pose blink');
      const baselines:number[]=[];
      for (const id of route.frames.slice(1)) {
        assert.ok(Number.isInteger(id) && rects[id]);
        const [x, y, w, h] = rects[id];
        let bottom = -1, edge = 0;
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
          const alpha = data[((y + yy) * info.width + x + xx) * 4 + 3];
          if (alpha > 180) { bottom = yy; if (xx === 0 || xx === w - 1 || yy === 0 || yy === h - 1) edge++; }
        }
        baselines.push(bottom);
        if(name!=='carry')assert.equal(bottom, registration.ground, avatar.id + '/' + name + '/' + id + ': planted baseline');
        assert.equal(edge, 0, avatar.id + '/' + name + '/' + id + ': no clipped opaque edge');
      }
      if(name==='carry'){
        assert.equal(route.loopMode,'pingPong');assert.ok(route.loopStart>0&&route.loopStart<route.frames.length-1);
        const suspended=baselines.slice(route.loopStart);
        assert.ok(Math.max(...suspended)-Math.min(...suspended)>3, avatar.id+': carried limbs are not pinned to the floor');
      }
    }
  }
});
