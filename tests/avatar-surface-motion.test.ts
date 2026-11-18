import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import sharp from 'sharp';
import { avatarCatalog } from '../broker/avatars.ts';

const director = vm.createContext({});
vm.runInContext(readFileSync('qml/SurfaceMotion.js', 'utf8').replace(/^\.pragma library\s*/, ''), director);
const catalog = {
  routes: { wave: { frames: [0, 1, 2, 3], frameMs: 20, holdMs: 40 }, think: { frames: [0, 4, 5, 6], frameMs: 20, holdMs: 40 }, open: { frames: [0, 7, 8, 9], frameMs: 20, holdMs: 40 } },
  motions: { wave: 'wave', thinking: 'think', explainOpen: 'open' }
};
const tick = (state: any, seconds = .02) => director.sample(state, seconds, true);

test('new and repaired portrait cells have transparent gutters without neighboring-row fragments', async () => {
  for(const id of ['cere_default','cere_gothic','cere_punk','cere_punk_unmasked','nova','soap']){
    const {data,info}=await sharp(`assets/${id}-portraits.png`).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.deepEqual([info.width,info.height],[1024,768],id);
    for(let cell=0;cell<12;cell++){
      const left=cell%4*256,top=Math.floor(cell/4)*256;
      let painted=0;
      for(let y=0;y<256;y++)for(let x=0;x<256;x++){
        const alpha=data[((top+y)*info.width+left+x)*4+3];
        if(x<8||y<8||x>=248||y>=248)assert.equal(alpha,0,`${id}/${cell}: clear cell gutter`);
        if(alpha>180)painted++;
      }
      assert.ok(painted>5000,`${id}/${cell}: portrait remains visible`);
    }
  }
});

test('new neutral artwork preserves reference colors and blinks only registered visible eyes', async t => {
  const sources = Object.fromEntries(avatarCatalog.map(entry => [entry.id, entry.authoring]));
  for (const id of ['cere_default', 'cere_gothic', 'cere_punk_unmasked', 'cynthia', 'genga', 'kippy', 'pomni', 'rem', 'sarah', 'sylva', 'witty', 'alia']) {
    const directory = 'artwork/avatars/' + id;
    await t.test(id, {skip: !existsSync(directory + '/front.png') || !existsSync('reference/' + id + '.png')}, async () => {
      const cfg = sources[id];
      const [left, top, width, height] = cfg.crop;
      const reference = await sharp('reference/' + id + '.png').extract({left, top, width, height}).ensureAlpha().raw().toBuffer();
      const open = await sharp(directory + '/front.png').ensureAlpha().raw().toBuffer();
      const closed = await sharp(directory + '/blink.png').ensureAlpha().raw().toBuffer();
      const registration = JSON.parse(readFileSync(directory + '/registration.json', 'utf8'));
      assert.equal(open.length, reference.length);
      assert.equal(closed.length, open.length);
      assert.equal(registration.targets.length, cfg.eyes.length);
      if (id === 'rem') assert.equal(cfg.eyes.length, 1, 'the fringe-covered eye is never invented or repainted');
      if (id === 'witty') assert.equal(cfg.eyes.length, 1, 'the mint X is a fixed mark, only the visible eye blinks');
      let changes = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        assert.equal(open[at + 3], closed[at + 3], id + ': blinking preserves the silhouette');
        if (open[at + 3]) assert.deepEqual(open.subarray(at, at + 3), reference.subarray(at, at + 3), id + ': original RGB');
        if ([0, 1, 2].some(c => open[at + c] !== closed[at + c])) {
          assert.ok(cfg.eyes.some(([ex, ey, ew, eh]: number[]) => x + left >= ex && x + left < ex + ew && y + top >= ey && y + top < ey + eh), id + ': changes stay inside visible eyelids');
          changes++;
        }
      }
      assert.ok(changes > 100, id + ': eyelids actually close');
    });
  }
});

test('connected gestures enter, hold, and return through the authored drawings', () => {
  const state = director.create();
  director.select(state, catalog, 'wave', false, true);
  assert.deepEqual(Array.from({ length: 9 }, () => tick(state)), [1, 2, 3, 3, 3, 2, 1, 0, 0]);
  assert.equal(state.stage, 'idle');
});

test('Witty held blinks follow the visible eye and retain authored closed-eye blush', async t => {
  const sourcePath='artwork/avatars/witty/registration.json';
  if(!existsSync(sourcePath)){t.skip('local authoring landmarks are optional');return;}
  const registration=JSON.parse(readFileSync(sourcePath,'utf8'));
  const rig=JSON.parse(readFileSync('assets/witty-surface-rig.json','utf8'));
  const {data,info}=await sharp('assets/witty-surface.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(const [name,route] of Object.entries<any>(rig.surfaceSequences.routes)){
    const authored=registration.routes[name].frames;
    assert.equal(authored.length,16);
    for(const pose of authored)assert.equal(pose.landmarks.length,1, 'the X is not an eye landmark');
    for(const n of name==='shy'?[6,15]:[15]){
      const pose=authored[n],eye=pose.landmarks[0];
      const ex=eye.x*pose.scaleX+pose.tx,ey=eye.y*pose.scaleY+pose.ty;
      const frame=rig.parts[0].surfaceFrames[route.frames[6+n*3]-1];
      const [x,y,w,h]=frame.sourceRect,[bx,by]=frame.blinkSourceRect;
      let changes=0;
      for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
        const a=((y+yy)*info.width+x+xx)*4,b=((by+yy)*info.width+bx+xx)*4;
        if([0,1,2].some(c=>data[a+c]!==data[b+c])){
          const [scale, turn, dx, dy] = pose.bodyRegistration?.head || [1,0,0,0];
          const sx=scale*xx-turn*yy+dx,sy=turn*xx+scale*yy+dy;
          assert.ok(Math.hypot((sx-ex)/18,(sy-ey+2)/14)<1.1, name+': blink stays on the registered visible eye');
          changes++;
        }
      }
      if(pose.authoredClosed)assert.equal(changes,0,'strong blush keeps its authored eyelid and cheeks');
      else assert.ok(changes>100,name+': visible eye actually closes');
    }
  }
});

test('reviewed held eyelids close at the actual eyes and preserve already-closed expressions', async t => {
  const configs=Object.fromEntries(avatarCatalog.map(entry=>[entry.id,entry.authoring]));
  let checked=0,avatars=0;
  for(const [id,cfg] of Object.entries<any>(configs)){
    if(!cfg.heldEyes)continue;
    avatars++;
    const rig=JSON.parse(readFileSync(`assets/${id}-surface-rig.json`,'utf8'));
    const {data,info}=await sharp(`assets/${id}-surface.png`).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    for(const [key,spec]of Object.entries<any>(cfg.heldEyes)){
      const route=rig.surfaceSequences.routes[key==='shyHover'?'shy':key];
      const frame=rig.parts[0].surfaceFrames[(key==='shyHover'?route.frames[24]:route.frames.at(-1))-1];
      const [x,y,w,h]=frame.sourceRect,[bx,by]=frame.blinkSourceRect;
      const eyes=(spec.eyes||[]).map((eye:number[]|null)=>{
        if(!eye)return null;
        const angle=eye[4]*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
        return {x:eye[0]*w+2*sin,y:eye[1]*h-2*cos,rx:eye[2]*w,ry:eye[3]*h,cos,sin};
      });
      const changes=eyes.map(()=>0);
      for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
        const a=((y+yy)*info.width+x+xx)*4,b=((by+yy)*info.width+bx+xx)*4;
        assert.equal(data[a+3],data[b+3],`${id}/${key}: blink preserves exact alpha`);
        if([0,1,2].some(c=>data[a+c]!==data[b+c])){
          assert.notEqual(spec.closed,true,`${id}/${key}: authored closed eyes remain exact`);
          const owner=eyes.findIndex((eye:any)=>{
            if(!eye)return false;
            const dx=xx-eye.x,dy=yy-eye.y;
            return Math.hypot((eye.cos*dx+eye.sin*dy)/eye.rx,(-eye.sin*dx+eye.cos*dy)/eye.ry)<1.00001;
          });
          assert.ok(owner>=0,`${id}/${key}: displaced cheek, hair or mouth pixels must not change`);
          changes[owner]++;
        }
      }
      for(let i=0;i<eyes.length;i++)if(eyes[i])assert.ok(changes[i]>100,`${id}/${key}/${i}: the actual visible eye closes`);
      checked++;
    }
  }
  assert.equal(avatars,14,'all reviewed avatars retain their eye landmarks');
  assert.equal(checked,79,'all reviewed held poses retain their eye landmarks');
});

test('Alia held blinks stay on both registered eyes through full-body registration', async t => {
  const sourcePath='artwork/avatars/alia/registration.json';
  if(!existsSync(sourcePath)){t.skip('local authoring landmarks are optional');return;}
  const registration=JSON.parse(readFileSync(sourcePath,'utf8'));
  const rig=JSON.parse(readFileSync('assets/alia-surface-rig.json','utf8'));
  const {data,info}=await sharp('assets/alia-surface.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(const [name,route] of Object.entries<any>(rig.surfaceSequences.routes)){
    const authored=registration.routes[name].frames;
    assert.equal(authored.length,16);
    for(const pose of authored)assert.equal(pose.landmarks.length,2, name+': both eyes are explicitly registered');
    for(const n of name==='shy'?[6,15]:[15]){
      const pose=authored[n],changed=[0,0];
      const eyes=pose.landmarks.map((eye:any)=>({x:eye.x*pose.scaleX+pose.tx,y:eye.y*pose.scaleY+pose.ty}));
      const frame=rig.parts[0].surfaceFrames[route.frames[6+n*3]-1];
      const [x,y,w,h]=frame.sourceRect,[bx,by]=frame.blinkSourceRect;
      for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
        const a=((y+yy)*info.width+x+xx)*4,b=((by+yy)*info.width+bx+xx)*4;
        if([0,1,2].some(c=>data[a+c]!==data[b+c])){
          const [scale,turn,dx,dy]=pose.bodyRegistration?.head||[1,0,0,0];
          const sx=scale*xx-turn*yy+dx,sy=turn*xx+scale*yy+dy;
          const eye=eyes.findIndex((e:any)=>Math.hypot((sx-e.x)/18,(sy-e.y+2)/14)<1.1);
          assert.ok(eye>=0,name+': eyelid changes stay on the registered eyes');
          changed[eye]++;
        }
      }
      for(const count of changed)assert.ok(count>100,name+': each eye actually closes');
    }
  }
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

test('every catalog clip and every route interruption restore neutral without stale frames', () => {
  const avatars=JSON.parse(readFileSync('assets/avatars.json','utf8'));
  const clips=JSON.parse(readFileSync('assets/motions.json','utf8')).clips;
  for(const avatar of avatars){
    const c=JSON.parse(readFileSync('assets/'+avatar.rig,'utf8')).surfaceSequences;
    const names=Object.keys(c.routes);
    const illustrated=['wave','greeting','goodbye','thinking','ponder','curious','skeptical','explainOpen','explainSweep','speaking','listen','approval','celebrate','success','fistPump','shy','hoverBlush','clickBlush','dragging'];
    assert.deepEqual(Object.keys(clips).filter(name=>c.motions[name]).sort(),illustrated.sort(),avatar.id+': explicit illustrated-gesture coverage');
    for(const [name,clip] of Object.entries<any>(clips)){
      const state=director.create();
      assert.equal(state.frame,0,avatar.id+'/'+name+': starts neutral');
      director.select(state,c,name,clip.loop||clip.surfaceHold,true,clip.surfaceStrength);
      let illustratedFrames=0;
      for(let i=0;i<180;i++){
        const frame=tick(state,1/60);
        assert.ok(frame===0||c.routes[c.motions[name]].frames.includes(frame),avatar.id+'/'+name);
        if(frame)illustratedFrames++;
      }
      assert.equal(illustratedFrames>0,illustrated.includes(name),avatar.id+'/'+name+': full pose or secondary motion is deliberate');
      director.select(state,c,'idle',true,true);
      for(let i=0;i<60;i++)tick(state,1/60);
      assert.equal(state.frame,0,avatar.id+'/'+name+': no residual drawing');
      assert.equal(state.route,'');assert.equal(state.index,0);
    }
    for(const from of names)for(const to of names)for(const interruption of [1,24,51]){
      const motionFor=(route:string)=>Object.keys(c.motions).find(name=>c.motions[name]===route);
      const state=director.create();
      director.select(state,c,motionFor(from),true,true);
      for(let i=0;i<interruption;i++)tick(state,1/60);
      const prior=state.frame;
      director.select(state,c,motionFor(to),true,true);
      assert.equal(tick(state,0),prior,avatar.id+': interruption keeps the current drawing');
      for(let i=0;i<120;i++)tick(state,1/60);
      assert.equal(state.route,to,avatar.id+': latest route wins');
      assert.equal(director.sample(state,.02,false),0,avatar.id+': reduced motion clears every route');
      assert.equal(state.index,0);assert.equal(state.stage,'idle');
    }
  }
});

test('every manifest surface atlas preserves neutral art, planted gestures and free carried limbs', async t => {
  const avatars = JSON.parse(readFileSync('assets/avatars.json', 'utf8'));
  assert.ok(avatars.length > 0);
  for (const avatar of avatars) {
    const rig = JSON.parse(readFileSync('assets/' + avatar.rig, 'utf8'));
    const part = rig.parts[0];
    const {data, info} = await sharp('assets/' + rig.texture).raw().toBuffer({resolveWithObject: true});
    const sourceDir = 'artwork/avatars/' + avatar.id;
    await t.test(avatar.id + ': exact visible neutral source pixels', {
      skip: !existsSync(sourceDir + '/registration.json') || !existsSync(sourceDir + '/front.png')
        ? 'authoring sources are optional; packed runtime art is checked below' : false
    }, async () => {
      const registration = JSON.parse(readFileSync(sourceDir + '/registration.json', 'utf8'));
      const original = await sharp(sourceDir + '/front.png').raw().toBuffer({resolveWithObject: true});
      const [ox, oy] = registration.originalOffset;
      for (let y = 0; y < original.info.height; y++) for (let x = 0; x < original.info.width; x++) {
        const source = (y * original.info.width + x) * 4;
        if (!original.data[source + 3]) continue;
        assert.ok(y + oy < part.sourceRect[3] && x + ox < part.sourceRect[2], avatar.id + ': neutral fits canvas');
        const target = ((y + oy) * info.width + ox + x) * 4;
        assert.deepEqual(data.subarray(target, target + 4), original.data.subarray(source, source + 4), avatar.id + ': exact visible neutral pixels');
      }
    });
    const [nx, ny, nw, nh] = part.sourceRect;
    const [, , frameWidth, frameHeight] = part.surfaceFrames[0].sourceRect;
    const neutral = await sharp(data, {raw:info}).extract({left:nx, top:ny, width:nw, height:nh})
      .resize(frameWidth, frameHeight).raw().toBuffer();
    let ground = -1;
    for (let p = 3; p < neutral.length; p += 4) if (neutral[p] > 180) ground = Math.floor(p / 4 / frameWidth);
    assert.deepEqual(Object.keys(rig.surfaceSequences.routes), ['wave', 'thinking', 'present', 'celebrate', 'shy', 'carry']);
    assert.equal(rig.surfaceSequences.motions.shy, 'shy');
    assert.equal(rig.surfaceSequences.motions.hoverBlush, 'shy');
    assert.equal(rig.surfaceSequences.motions.clickBlush, 'shy');
    assert.equal(rig.surfaceSequences.motions.dragging, 'carry');
    assert.equal(part.surfaceFrames.length, 306);
    assert.ok(info.width*info.height*4 <= 256*1024*1024, 'atlas stays within Qt image allocation limit');
    const hoverFrame=rig.surfaceSequences.routes.shy.frames[24];
    assert.ok(part.surfaceFrames[hoverFrame-1].blinkSourceRect, 'held hover pose can blink');
    for (const frame of [part, ...part.surfaceFrames].filter(frame => frame.blinkSourceRect)) {
      const [x, y, w, h] = frame.sourceRect, [bx, by, bw, bh] = frame.blinkSourceRect;
      assert.deepEqual([bw, bh], [w, h], avatar.id + ': blink cell matches its open pose');
      assert.ok(bx >= 0 && by >= 0 && bx + bw <= info.width && by + bh <= info.height, avatar.id + ': blink cell fits atlas');
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++)
        assert.equal(data[((y + yy) * info.width + x + xx) * 4 + 3], data[((by + yy) * info.width + bx + xx) * 4 + 3], avatar.id + ': blinking preserves pose silhouette');
    }
    const rects = [part.sourceRect, ...part.surfaceFrames.map((frame: any) => frame.sourceRect)];
    for (const [name, route] of Object.entries<any>(rig.surfaceSequences.routes)) {
      assert.equal(route.frames[0], 0, avatar.id + '/' + name + ': neutral entry');
      assert.equal(route.frames.length, 52, avatar.id + '/' + name + ': neutral plus 51 prepared frames');
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
        if(name!=='carry')assert.equal(bottom, ground, avatar.id + '/' + name + '/' + id + ': planted baseline');
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
