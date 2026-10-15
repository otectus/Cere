#!/usr/bin/env node
// Register authored drawings, bake premultiplied optical-flow inbetweens, pack
// bounded native surface sequences. Run from the repository root.
import sharp from 'sharp';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile), interpolate=process.argv[2];
if(!interpolate) throw Error('Usage: node tools/prepare-avatar-poses.mjs INTERPOLATOR [avatar ...]');
const sourceConfig=JSON.parse(await readFile('artwork/avatars/sources.json','utf8'));
const carryOnly=process.argv.includes('--carry-only'),ids=process.argv.slice(3).filter(arg=>arg!=='--carry-only');if(!ids.length) ids.push('cere','daemona','jade','nova','soap');
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
// Generated sheets can have uneven row gutters. Split each column through its
// transparent gutter, so a horn or dangling boot never crosses a cell boundary.
function carryRows(sheet,left,width){
 const {data,info:{width:w,height:h}}=sheet,rows=[0];
 for(let row=1;row<4;row++){
  const center=row*h/4,lo=Math.floor(center-h*.055),hi=Math.ceil(center+h*.055);let best=center,bestScore=Infinity;
  for(let y=lo;y<=hi;y++){
   let pixels=0;
   for(let yy=y-1;yy<=y+1;yy++)for(let x=left;x<left+width;x++)if(data[(yy*w+x)*4+3]>180)pixels++;
   const score=pixels*1000+Math.abs(y-center);
   if(score<bestScore){bestScore=score;best=y;}
  }
  rows.push(best);
 }
 rows.push(h);return rows;
}
function carryComponents(sheet,threshold=200){
 const {data,info:{width:w,height:h}}=sheet,size=w*h,labels=new Int32Array(size),queue=new Int32Array(size),cores=[];let component=0;
 for(let start=0;start<size;start++){
  if(labels[start]||data[start*4+3]<threshold)continue;
  component++;let head=0,tail=0;queue[tail++]=start;labels[start]=component;
  let sx=0,sy=0;
  while(head<tail){const p=queue[head++],x=p%w,y=Math.floor(p/w);sx+=x;sy+=y;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const xx=x+dx,yy=y+dy,q=yy*w+xx;
    if(xx<0||xx>=w||yy<0||yy>=h||labels[q]||data[q*4+3]<threshold)continue;
    labels[q]=component;queue[tail++]=q;
   }
  }
  if(tail>=1000)cores.push({label:component,x:sx/tail,y:sy/tail});
 }
 if(cores.length!==16&&threshold===200)return carryComponents(sheet,245);
 if(cores.length!==16)throw Error(`carry sheet needs 16 separate opaque character cores, found ${cores.length}`);
 const grid=new Set(cores.map(c=>Math.floor(c.y/(h/4))*4+Math.floor(c.x/(w/4))));
 if(grid.size!==16)throw Error('carry sheet must have one character core in each grid cell');
 // High-alpha cores stay separate even where low-alpha hair halos touch.
 // Grow every core together, partitioning only those halos, never a hard
 // horizontal strip through a horn or boot.
 cores.sort((a,b)=>Math.floor(a.x/(w/4))-Math.floor(b.x/(w/4))||a.y-b.y);
 const order=new Map(cores.map((c,i)=>[c.label,(i%4)*4+Math.floor(i/4)+1]));let head=0,tail=0;
 for(let p=0;p<size;p++){labels[p]=order.get(labels[p])||0;if(labels[p])queue[tail++]=p;}
 while(head<tail){const p=queue[head++],x=p%w,y=Math.floor(p/w);
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
   const xx=x+dx,yy=y+dy,q=yy*w+xx;
   if(xx<0||xx>=w||yy<0||yy>=h||labels[q]||data[q*4+3]<8)continue;
   labels[q]=labels[p];queue[tail++]=q;
  }
 }
 const bounds=Array.from({length:16},()=>({left:w,top:h,right:-1,bottom:-1}));
 for(let p=0;p<size;p++)if(labels[p]){const b=bounds[labels[p]-1],x=p%w,y=Math.floor(p/w);b.left=Math.min(b.left,x);b.right=Math.max(b.right,x);b.top=Math.min(b.top,y);b.bottom=Math.max(b.bottom,y);}
 return bounds.map((b,n)=>{
  const col=n%4,row=Math.floor(n/4),columnLeft=Math.round(col*w/4),columnWidth=Math.round((col+1)*w/4)-columnLeft,rows=carryRows(sheet,columnLeft,columnWidth);
  const left=Math.min(columnLeft,b.left-4),top=Math.min(rows[row],b.top-4),right=Math.max(columnLeft+columnWidth,b.right+5),bottom=Math.max(rows[row+1],b.bottom+5),width=right-left,height=bottom-top,out=Buffer.alloc(width*height*4);
  for(let y=b.top;y<=b.bottom;y++)for(let x=b.left;x<=b.right;x++){const p=y*w+x;if(labels[p]===n+1)data.copy(out,((y-top)*width+x-left)*4,p*4,p*4+4);}
  return {data:out,info:{width,height,channels:4},source:[left,top,width,height]};
 });
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
 const cfg=sourceConfig[id],W=400,H=id==='cere'?420:460,fullW=W*2,fullH=H*2,referenceHeight=id==='cere'?760:840;
 const ox=Math.floor((fullW-original.info.width)/2),oy=id==='cere'?80:fullH-8-(cfg.bounds[3]+1);
 const open=Buffer.alloc(fullW*fullH*4),closed=Buffer.alloc(open.length);
 for(let y=0;y<original.info.height;y++){
  original.data.copy(open,((y+oy)*fullW+ox)*4,y*original.info.width*4,(y+1)*original.info.width*4);
  originalBlink.data.copy(closed,((y+oy)*fullW+ox)*4,y*original.info.width*4,(y+1)*original.info.width*4);
 }
 const neutral=await sharp(open,{raw:{width:fullW,height:fullH,channels:4}}).resize(W,H).raw().toBuffer({resolveWithObject:true});
 const blink=await sharp(closed,{raw:{width:fullW,height:fullH,channels:4}}).resize(W,H).raw().toBuffer({resolveWithObject:true});
 const color=id==='cere'?'cyan':cfg.color;
 const boxes=id==='cere'?[[140,230,205,285],[240,230,310,285]]:cfg.eyes.map(([x,y,w,h])=>[x-cfg.crop[0],y-cfg.crop[1],x-cfg.crop[0]+w,y-cfg.crop[1]+h]);
 const eyeTargets=boxes.map(b=>iris(original,b,color));
 if(eyeTargets.some(e=>!e))throw Error(id+': reference iris missing');
 const targets=eyeTargets.map(e=>({x:(e.x+ox)/2,y:(e.y+oy)/2}));
 const targetX=(targets[0].x+targets[1].x)/2,targetY=(targets[0].y+targets[1].y)/2,targetDistance=targets[1].x-targets[0].x;
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
  const sheet=await raw(`${dir}/${name}-sheet.png`),cells=[],components=name==='carry'?carryComponents(sheet):null;
  for(let n=0;n<16;n++){
   const col=n%4,row=Math.floor(n/4),left=Math.round(col*sheet.info.width/4),width=Math.round((col+1)*sheet.info.width/4)-left;
   const top=Math.round(row*sheet.info.height/4),height=Math.round((row+1)*sheet.info.height/4)-top;
   const cell=components?components[n]:await sharp(sheet.data,{raw:sheet.info}).extract({left,top,width,height}).raw().toBuffer({resolveWithObject:true});
   const cw=cell.info.width,ch=cell.info.height;
   const a=iris(cell,[cw*(id==='nova'?.39:.33),ch*(id==='nova'?.31:.27),cw*.49,ch*.41],color),b=iris(cell,[cw*.50,ch*(id==='nova'?.31:.27),cw*(id==='nova'?.62:.66),ch*.41],color);
   cells.push({cell,left:a,right:b,sole:baseline(cell),top:topline(cell),bounds:visibleBounds(cell),source:cell.source||[left,top,width,height]});
  }
  const valid=cells.filter(c=>c.left&&c.right&&c.right.x-c.left.x>20);
  if(valid.length<3)throw Error(`${id}/${name}: insufficient iris landmarks (${valid.length})`);
  // Uniform route scale preserves facial/body proportions. Iris distance is
  // diagnostic only: colored hair can overlap an iris search region.
  const carried=name==='carry';
  let scaleX=carried ? (targetY-neutralTop)/median(valid.map(c=>(c.left.y+c.right.y)/2-c.top))
                       : (ground-neutralTop)/median(cells.map(c=>c.sole-c.top));
  const fallbackX=median(valid.map(c=>(c.left.x+c.right.x)/2));
  const fallbackY=median(valid.map(c=>(c.left.y+c.right.y)/2));
  if(carried)for(const c of cells){
   const ex=c.left&&c.right?(c.left.x+c.right.x)/2:fallbackX,ey=c.left&&c.right?(c.left.y+c.right.y)/2:fallbackY,b=c.bounds;
   // One uniform scale for the entire route, with room for interpolation and
   // secondary sway. Suspended feet deliberately have no planted-foot blend.
   scaleX=Math.min(scaleX,(targetX-6)/(ex-b.left),(W-7-targetX)/(b.right-ex),(targetY-6)/(ey-b.top),(H-7-targetY)/(b.bottom-ey));
  }
  const scaleY=scaleX;
  registration.routes[name]={scaleX,scaleY,grounded:!carried,frames:[]};
  let previous=neutralPath;
  for(let n=0;n<16;n++){
   const {cell,left,right,sole}=cells[n],mid=left&&right&&right.x-left.x>20?(left.x+right.x)/2:fallbackX;
   const tx=targetX-mid*scaleX,ty=carried ? targetY-(left&&right?(left.y+right.y)/2:median(valid.map(c=>(c.left.y+c.right.y)/2)))*scaleY : ground-sole*scaleY,data=Buffer.alloc(W*H*4),shut=Buffer.alloc(data.length);
   for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=(y*W+x)*4,pixel=sample(cell,(x-tx)/scaleX,(y-ty)/scaleY);if(pixel[3]<12)pixel[3]=0;
    const base=sample(neutral,x,y),weight=carried?0:id==='cere'?smooth(326,342,y):smooth(H*.79,H*.86,y),alpha=pixel[3]*(1-weight)+base[3]*weight;
    for(let c=0;c<3;c++)data[i+c]=alpha?Math.round((pixel[c]*pixel[3]*(1-weight)+base[c]*base[3]*weight)/alpha):0;
    data[i+3]=Math.round(alpha);data.copy(shut,i,i,i+4);
    for(let e=0;e<2;e++){
     const point=e===0?left:right;
     const ex=point?point.x*scaleX+tx:targets[e].x,ey=point?point.y*scaleY+ty:targets[e].y;
     const radius=Math.hypot((x-ex)/18,(y-ey+2)/14),mix=1-smooth(.72,1,radius);
     if(mix>0){const eyelid=sample(blink,x-ex+targets[e].x,y-ey+targets[e].y);for(let c=0;c<3;c++)shut[i+c]=Math.round(data[i+c]*(1-mix)+eyelid[c]*mix);}
    }
   }
   // Closed-eyed authored endpoint already carries its own expression and blush.
   if(!left||!right) data.copy(shut);
   const next=`${cache}/${name}-${String(n).padStart(2,'0')}.png`;
   await sharp(data,{raw:{width:W,height:H,channels:4}}).png().toFile(next);
   const steps=n===0?5:2,prefix=`${cache}/inbetweens/${name}-${String(n).padStart(2,'0')}`;
   await run(interpolate,[previous,next,prefix,String(steps)]);
   for(let s=1;s<=steps;s++){
    const between=(await raw(`${prefix}-${String(s).padStart(2,'0')}.png`)).data;
    frames.push({name,data:carried?removeFlowSpecks(between,W,H):between});
   }
   frames.push({name,data,closed:n===15||(name==='shy'&&n===6)?shut:null});
   registration.routes[name].frames.push({n,tx,ty,sole,eyes:!!(left&&right),...(carried?{source:cells[n].source}:{})});previous=next;
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
