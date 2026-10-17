#!/usr/bin/env node
// Register authored drawings, bake premultiplied optical-flow inbetweens, pack
// bounded native surface sequences. Run from the repository root.
import sharp from 'sharp';
import {sheetComponents} from './avatar-sheet.mjs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile), interpolate=process.argv[2];
if(!interpolate) throw Error('Usage: node tools/prepare-avatar-poses.mjs INTERPOLATOR [avatar ...]');
const sourceConfig=JSON.parse(await readFile('artwork/avatars/sources.json','utf8'));
const carryOnly=process.argv.includes('--carry-only'),ids=process.argv.slice(3).filter(arg=>arg!=='--carry-only');
if(!ids.length) ids.push(...JSON.parse(await readFile('assets/avatars.json','utf8')).map(avatar=>avatar.id));
const raw=path=>sharp(path).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
const median=values=>values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
function sample(image,x,y){
 const {data,info:{width:w,height:h}}=image,xx=Math.floor(x),yy=Math.floor(y),fx=x-xx,fy=y-yy,out=[0,0,0,0];
 for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
  const sx=xx+dx,sy=yy+dy;if(sx<0||sy<0||sx>=w||sy>=h)continue;
  const i=(sy*w+sx)*4,weight=(dx?fx:1-fx)*(dy?fy:1-fy),alpha=data[i+3]/255;
  for(let c=0;c<3;c++)out[c]+=weight*data[i+c]*alpha;
  out[3]+=weight*data[i+3];
 }
 if(out[3]>0)for(let c=0;c<3;c++)out[c]*=255/out[3];return out;
}
function iris(image,box,color){
 const {data,info:{width:w,height:h}}=image;let x=0,y=0,mass=0;
 for(let yy=Math.max(0,Math.floor(box[1]));yy<Math.min(h,box[3]);yy++)for(let xx=Math.max(0,Math.floor(box[0]));xx<Math.min(w,box[2]);xx++){
  const i=(yy*w+xx)*4,r=data[i],g=data[i+1],b=data[i+2];let weight=0;
  if(data[i+3]<180)continue;
  if(color==='cyan')weight=r<170&&b>170&&g>110&&b>r*1.4&&g>b*.66?g-b*.66:0;
  if(color==='red')weight=r>220&&g<165&&b<170&&r>g*1.35?r-Math.max(g,b):0;
  if(color==='purple')weight=b>190&&r>140&&g>75&&b>g*1.35&&b>r*.9?b-g:0;
  if(color==='bluegray')weight=b>60&&r<170&&b>r*1.12&&b>g*1.025?b-r:0;
  if(color==='brown')weight=r>65&&r>g*1.35&&r>b*1.5&&g<120?r-Math.max(g,b):0;
  if(color==='amber')weight=r>170&&g>75&&g<195&&b<100&&r>g*1.25?r-b:0;
  if(color==='green')weight=g>110&&g>r*1.09&&g>b*1.04?g-Math.min(r,b):0;
  x+=xx*weight;y+=yy*weight;mass+=weight;
 }
 return mass>40?{x:x/mass,y:y/mass,mass}:null;
}
function visibleBaseline(image){
 const {data,info:{width:w,height:h}}=image;
 for(let y=h-1;y>=0;y--)for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]>180)return y;
 return -1;
}
function visibleBounds(image){
 const {data,info:{width:w,height:h}}=image;let left=w,top=h,right=-1,bottom=-1;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]>180){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
 return {left,top,right,bottom};
}
function removeFlowSpecks(data,w,h){
 // Occlusion in dense flow can leave a small detached copy of a moving boot
 // or fingertip. Retain the connected figure and substantial components;
 // remove only isolated interpolation debris, including translucent fringes.
 const seen=new Uint8Array(w*h),queue=new Int32Array(w*h);
 for(let start=0;start<w*h;start++){
  if(seen[start]||data[start*4+3]<8)continue;
  let head=0,tail=0;queue[tail++]=start;seen[start]=1;
  while(head<tail){const p=queue[head++],x=p%w,y=Math.floor(p/w);
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const xx=x+dx,yy=y+dy,q=yy*w+xx;
    if(xx<0||xx>=w||yy<0||yy>=h||seen[q]||data[q*4+3]<8)continue;
    seen[q]=1;queue[tail++]=q;
   }
  }
  if(tail<600)for(let i=0;i<tail;i++)data.fill(0,queue[i]*4,queue[i]*4+4);
 }
 return data;
}
function topline(image){
 const {data,info:{width:w,height:h}}=image;
 for(let y=0;y<h;y++){let count=0;for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]>180)count++;if(count>3)return y;}
 throw Error('empty character');
}
function baseline(image){
 const {data,info:{width:w,height:h}}=image;let sole=0;
 for(let y=Math.floor(h*.7);y<h;y++){let count=0;for(let x=Math.floor(w*.18);x<w*.82;x++)if(data[(y*w+x)*4+3]>180)count++;if(count>12)sole=y;}
 return sole;
}
const motions={wave:'wave',greeting:'wave',goodbye:'wave',thinking:'thinking',ponder:'thinking',curious:'thinking',skeptical:'thinking',explainOpen:'present',explainSweep:'present',speaking:'present',listen:'present',approval:'present',celebrate:'celebrate',success:'celebrate',fistPump:'celebrate',shy:'shy',blush:'shy',hoverBlush:'shy',clickBlush:'shy',dragging:'carry'};
for(const id of ids){
 const dir=`artwork/avatars/${id}`,original=await raw(`${dir}/front.png`),originalBlink=await raw(`${dir}/blink.png`);
 const cfg=sourceConfig[id],W=400,H=id==='cere'?420:460,fullW=W*2,fullH=H*2,referenceHeight=cfg?.referenceHeight||(id==='cere'?760:840);
 if(id!=='cere'&&!cfg)throw Error(`${id}: missing source registration`);
 const ox=Math.floor((fullW-original.info.width)/2),oy=id==='cere'?80:fullH-8-(cfg.bounds[3]+1);
 const open=Buffer.alloc(fullW*fullH*4),closed=Buffer.alloc(open.length);
 if(ox<0||oy<0)throw Error(`${id}: reference exceeds the neutral canvas`);
 for(let y=0;y<original.info.height;y++){
  if(y+oy>=fullH){
   for(let x=0;x<original.info.width;x++)if(original.data[(y*original.info.width+x)*4+3]>0)throw Error(`${id}: reference would be clipped`);
   continue;
  }
  original.data.copy(open,((y+oy)*fullW+ox)*4,y*original.info.width*4,(y+1)*original.info.width*4);
  originalBlink.data.copy(closed,((y+oy)*fullW+ox)*4,y*original.info.width*4,(y+1)*original.info.width*4);
 }
 const neutral=await sharp(open,{raw:{width:fullW,height:fullH,channels:4}}).resize(W,H).raw().toBuffer({resolveWithObject:true});
 const blink=await sharp(closed,{raw:{width:fullW,height:fullH,channels:4}}).resize(W,H).raw().toBuffer({resolveWithObject:true});
 const color=id==='cere'?'cyan':cfg.color;
 const boxes=id==='cere'?[[140,230,205,285],[240,230,310,285]]:cfg.eyes.map(([x,y,w,h])=>[x-cfg.crop[0],y-cfg.crop[1],x-cfg.crop[0]+w,y-cfg.crop[1]+h]);
 const eyeTargets=boxes.map(b=>iris(original,b,color));
 if(eyeTargets.some(e=>!e))throw Error(id+': reference iris missing');
 if(eyeTargets.length<1||eyeTargets.length>2)throw Error(id+': register one or two visible eyes');
 // A fringe may cover one eye (Rem). Register and blink only visible eyes;
 // the covered side is artwork, not a second landmark to invent or repaint.
 const singleEye=eyeTargets.length===1;
 const targets=eyeTargets.map(e=>({x:(e.x+ox)/2,y:(e.y+oy)/2}));
 const targetX=targets.reduce((sum,e)=>sum+e.x,0)/targets.length,targetY=targets.reduce((sum,e)=>sum+e.y,0)/targets.length;
 const hasEyes=c=>!!(c.left&&(singleEye||(c.right&&c.right.x-c.left.x>20)));
 const eyeCenter=c=>singleEye?c.left:{x:(c.left.x+c.right.x)/2,y:(c.left.y+c.right.y)/2};
 const ground=baseline(neutral),neutralTop=topline(neutral),frames=[],registration={canvas:[fullW,fullH],originalOffset:[ox,oy],ground:visibleBaseline(neutral),footAnchor:ground,targets,routes:{}};
 if(carryOnly){
  const previousRig=JSON.parse(await readFile(`assets/${id}-surface-rig.json`,'utf8')),previousAtlas=await raw(`assets/${id}-surface.png`),previousRegistration=JSON.parse(await readFile(`${dir}/registration.json`,'utf8'));
  const crop=async r=>(await sharp(previousAtlas.data,{raw:previousAtlas.info}).extract({left:r[0],top:r[1],width:r[2],height:r[3]}).raw().toBuffer());
  for(const name of ['wave','thinking','present','celebrate','shy']){
   for(const frameId of previousRig.surfaceSequences.routes[name].frames.slice(1)){
    const frame=previousRig.parts[0].surfaceFrames[frameId-1];
    frames.push({name,data:await crop(frame.sourceRect),closed:frame.blinkSourceRect?await crop(frame.blinkSourceRect):null});
   }
   registration.routes[name]=previousRegistration.routes[name];
  }
 }
 const cache=`build/avatar-frames/${id}`;await mkdir(cache+'/inbetweens',{recursive:true});
 const neutralPath=`${cache}/neutral.png`;await sharp(neutral.data,{raw:neutral.info}).png().toFile(neutralPath);
 for(const name of carryOnly?['carry']:['wave','thinking','present','celebrate','shy','carry']){
  // Isolate the connected figure for every avatar. The legacy rectangular
  // crops also admitted faint sheet rules and detached background debris.
  const sheet=await raw(`${dir}/${name}-sheet.png`),cells=[],components=sheetComponents(sheet);
  for(let n=0;n<16;n++){
   const cell=components[n];
   const cw=cell.info.width,ch=cell.info.height;
   // Explicit landmarks distinguish an iris from same-colored hair or facial
   // markings. Closed authored eyes still provide a stable registration point.
   const authored=cfg?.sheetLandmarks?.[name]?.[n];
   if(cfg?.sheetLandmarks?.[name] && (cfg.sheetLandmarks[name].length!==16 ||
      !authored || authored.eyes.length!==targets.length ||
      authored.eyes.some(p=>p.length!==2||p.some(v=>!Number.isFinite(v)||v<=0||v>=1))))
    throw Error(`${id}/${name}/${n}: invalid authored eye landmarks`);
   const eyeBoxes=cfg?.sheetEyes||[[id==='nova'?.39:.33,id==='nova'?.31:.27,.49,.41],[.50,id==='nova'?.31:.27,id==='nova'?.62:.66,.41]];
   const points=authored?authored.eyes.map(([x,y])=>({x:x*cw,y:y*ch}))
                        :eyeBoxes.map(box=>iris(cell,box.map((value,axis)=>value*(axis%2?ch:cw)),color));
   const [a,b]=points;
   cells.push({cell,left:a,right:b,authoredClosed:!!authored?.closed,sole:baseline(cell),top:topline(cell),bounds:visibleBounds(cell),source:cell.source});
  }
  const valid=cells.filter(hasEyes);
  if(valid.length<3)throw Error(`${id}/${name}: insufficient iris landmarks (${valid.length})`);
  // Uniform route scale preserves facial/body proportions. Iris distance is
  // diagnostic only: colored hair can overlap an iris search region.
  const carried=name==='carry';
  let scaleX=carried ? (targetY-neutralTop)/median(valid.map(c=>eyeCenter(c).y-c.top))
                       : (ground-neutralTop)/median(cells.map(c=>c.sole-c.top));
  const fallbackX=median(valid.map(c=>eyeCenter(c).x));
  const fallbackY=median(valid.map(c=>eyeCenter(c).y));
  // Some authored sheets change drawing size between rows. Normalize those
  // explicitly registered routes uniformly in both axes, keeping the same
  // head-to-foot height rather than shrinking at a row boundary.
  const normalizeHeight=!carried&&cfg?.normalizedRoutes?.includes(name);
  const medianHeight=median(cells.map(c=>c.sole-c.top));
  for(const c of cells)c.sizeFactor=normalizeHeight?medianHeight/(c.sole-c.top):1;
  if(!carried)for(const c of cells){
   const ex=hasEyes(c)?eyeCenter(c).x:fallbackX,b=c.bounds;
   scaleX=Math.min(scaleX,(targetX-6)/(ex-b.left)/c.sizeFactor,
                  (W-7-targetX)/(b.right-ex)/c.sizeFactor,
                  (ground-6)/(c.sole-b.top)/c.sizeFactor);
  }
  if(carried)for(const c of cells){
   const ex=hasEyes(c)?eyeCenter(c).x:fallbackX,ey=hasEyes(c)?eyeCenter(c).y:fallbackY,b=c.bounds;
   // One uniform scale for the entire route, with room for interpolation and
   // secondary sway. Suspended feet deliberately have no planted-foot blend.
   scaleX=Math.min(scaleX,(targetX-6)/(ex-b.left),(W-7-targetX)/(b.right-ex),(targetY-6)/(ey-b.top),(H-7-targetY)/(b.bottom-ey));
  }
  const scaleY=scaleX;
  registration.routes[name]={scaleX,scaleY,grounded:!carried,normalizedHeight:!!normalizeHeight,frames:[]};
  let previous=neutralPath;
  for(let n=0;n<16;n++){
   const {cell,left,right,sole}=cells[n],foundEyes=hasEyes(cells[n]),mid=foundEyes?eyeCenter(cells[n]).x:fallbackX;
   const frameScaleX=scaleX*cells[n].sizeFactor,frameScaleY=scaleY*cells[n].sizeFactor;
   const tx=targetX-mid*frameScaleX,ty=carried ? targetY-(foundEyes?eyeCenter(cells[n]).y:fallbackY)*frameScaleY : ground-sole*frameScaleY;
   let data=Buffer.alloc(W*H*4),shut=Buffer.alloc(data.length);
   for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=(y*W+x)*4,pixel=sample(cell,(x-tx)/frameScaleX,(y-ty)/frameScaleY);if(pixel[3]<12)pixel[3]=0;
    for(let c=0;c<4;c++)data[i+c]=Math.round(pixel[c]);
    data.copy(shut,i,i,i+4);
    for(let e=0;e<targets.length;e++){
     const point=e===0?left:right;
     const ex=point?point.x*frameScaleX+tx:targets[e].x,ey=point?point.y*frameScaleY+ty:targets[e].y;
     const radius=Math.hypot((x-ex)/18,(y-ey+2)/14),mix=1-smooth(.72,1,radius);
     if(mix>0){const eyelid=sample(blink,x-ex+targets[e].x,y-ey+targets[e].y);for(let c=0;c<3;c++)shut[i+c]=Math.round(data[i+c]*(1-mix)+eyelid[c]*mix);}
    }
   }
   // Closed-eyed authored endpoint already carries its own expression and blush.
   if(!foundEyes||cells[n].authoredClosed) data.copy(shut);
   const next=`${cache}/${name}-${String(n).padStart(2,'0')}.png`;
   const registrationPrefix=`${cache}/${name}-${String(n).padStart(2,'0')}-registered`;
   await sharp(data,{raw:{width:W,height:H,channels:4}}).png().toFile(next);
   await sharp(shut,{raw:{width:W,height:H,channels:4}}).png().toFile(next+'.blink.png');
   // Correct authored drawing-size drift with a continuous full-body map.
   // Both endpoints and their eyelids use exactly the same map; no horizontal
   // band ever crossfades between an animated torso and neutral legs.
   let bodyRegistration;
   if(!carried){
    await run(interpolate,['--register',neutralPath,next,next+'.blink.png',registrationPrefix,
                          String(targetX),String(targetY),'grounded','v1']);
    data=(await raw(registrationPrefix+'-open.png')).data;
    shut=(await raw(registrationPrefix+'-blink.png')).data;
    bodyRegistration=JSON.parse(await readFile(registrationPrefix+'.json','utf8'));
   }
   await sharp(data,{raw:{width:W,height:H,channels:4}}).png().toFile(next);
   const steps=n===0?5:2,prefix=`${cache}/inbetweens/${name}-${String(n).padStart(2,'0')}`;
   await run(interpolate,[previous,next,prefix,String(steps),...(carried?[]:[String(visibleBaseline(neutral))])]);
   for(let s=1;s<=steps;s++){
    const between=(await raw(`${prefix}-${String(s).padStart(2,'0')}.png`)).data;
    frames.push({name,data:carried?removeFlowSpecks(between,W,H):between});
   }
   frames.push({name,data,closed:n===15||(name==='shy'&&n===6)?shut:null});
   registration.routes[name].frames.push({n,tx,ty,sole,scaleX:frameScaleX,scaleY:frameScaleY,eyes:foundEyes,...(bodyRegistration?{bodyRegistration}:{}),...(cfg?.sheetLandmarks?.[name]?{landmarks:[left,right].filter(Boolean),authoredClosed:cells[n].authoredClosed}:{}),...(carried?{source:cells[n].source}:{})});previous=next;
  }
  console.log(`${id}/${name}: registered and interpolated`);
 }
 const columns=16,atlasW=W*columns,atlasH=fullH+Math.ceil((frames.length+7)/columns)*H,atlas=Buffer.alloc(atlasW*atlasH*4);
 function blit(data,w,h,left,top){for(let y=0;y<h;y++)data.copy(atlas,((top+y)*atlasW+left)*4,y*w*4,(y+1)*w*4);}
 blit(open,fullW,fullH,0,0);blit(closed,fullW,fullH,fullW,0);
 let cell=0;const nextRect=()=>{const r=[cell%columns*W,fullH+Math.floor(cell/columns)*H,W,H];cell++;return r;};
 const metadata=[],routes={};
 for(let i=0;i<frames.length;i++){
  const f=frames[i],sourceRect=nextRect(),entry={sourceRect};blit(f.data,W,H,sourceRect[0],sourceRect[1]);
  if(f.closed){entry.blinkSourceRect=nextRect();blit(f.closed,W,H,entry.blinkSourceRect[0],entry.blinkSourceRect[1]);}
  metadata.push(entry);(routes[f.name]||={frames:[0],frameMs:1000/60,holdMs:f.name==='shy'?1400:850}).frames.push(i+1);
 }
 routes.carry.loopMode='pingPong';routes.carry.loopStart=15;
 const rig={texture:`${id}-surface.png`,presentation:'reference',parts:[{name:'reference',bone:'root',sourceRect:[0,0,fullW,fullH],blinkSourceRect:[fullW,0,fullW,fullH],rect:[96-176*fullW/referenceHeight/2,202-176*fullH/referenceHeight,176*fullW/referenceHeight,176*fullH/referenceHeight],surfaceMotion:true,z:0,surfaceFrames:metadata}],surfaceSequences:{routes,motions}};
 const packedPath=`assets/${id}-surface.png`;
 await sharp(atlas,{raw:{width:atlasW,height:atlasH,channels:4}}).png().toFile(packedPath+'.tmp');
 await rename(packedPath+'.tmp',packedPath);
 await writeFile(`assets/${id}-surface-rig.json`,JSON.stringify(rig,null,2)+'\n');
 if(id==='cere'){const base=JSON.parse(await readFile('assets/cere-rig.json','utf8'));await writeFile('assets/cere-rig.json',JSON.stringify({...base,...rig},null,2)+'\n');}
 await writeFile(`${dir}/registration.json`,JSON.stringify(registration,null,2)+'\n');
 console.log(`${id}: ${frames.length} frames, ${atlasW}x${atlasH}, grounded at ${ground}`);
}
