// Deterministic held-pose eyelid transfer. Coordinates in `spec.eyes` are
// normalized against the final registered frame: [cx, cy, rx, ry, degrees].
// The source uses the same 18x14 neutral-eye footprint as the pose baker. Its
// axes follow the neutral inter-eye line unless `sourceEyes` supplies reviewed
// normalized neutral-frame ellipses. Centers use the historical two-pixel
// upward lid offset. Only RGB is feathered, so open alpha and the complete
// frame outside the reviewed ellipses remain byte-identical.

const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};

function sampleRgb(data,width,height,x,y){
 const xx=Math.floor(x),yy=Math.floor(y),fx=x-xx,fy=y-yy,out=[0,0,0],weights=[0,0,0];
 for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
  const sx=xx+dx,sy=yy+dy;if(sx<0||sy<0||sx>=width||sy>=height)continue;
  const at=(sy*width+sx)*4,weight=(dx?fx:1-fx)*(dy?fy:1-fy),alpha=data[at+3]/255;
  for(let channel=0;channel<3;channel++){out[channel]+=data[at+channel]*alpha*weight;weights[channel]+=alpha*weight;}
 }
 return out.map((value,channel)=>weights[channel]>0?value/weights[channel]:0);
}

function checkedEye(eye,index,label){
 if(!Array.isArray(eye)||eye.length!==5||eye.some(value=>!Number.isFinite(value)))throw Error(`${label} eye ${index} must be null or [cx, cy, rx, ry, angleDegrees]`);
 const [cx,cy,rx,ry]=eye;
 if(cx<=0||cx>=1||cy<=0||cy>=1||rx<=0||rx>=.5||ry<=0||ry>=.5)throw Error(`${label} eye ${index} has invalid normalized geometry`);
}

function checkedSpec(spec,sourceEyes,eyeCount){
 if(!spec||typeof spec!=='object'||Array.isArray(spec))throw Error('held eye spec must be an object');
 if(spec.closed!==true){
  if(!Array.isArray(spec.eyes)||spec.eyes.length!==eyeCount)throw Error(`held eye spec requires ${eyeCount} eye ellipse${eyeCount===1?'':'s'}`);
  for(const [index,eye] of spec.eyes.entries())if(eye!==null)checkedEye(eye,index,'held');
 }
 if(sourceEyes!==undefined){
  if(!Array.isArray(sourceEyes)||sourceEyes.length!==eyeCount)throw Error(`heldEyeSource requires ${eyeCount} eye ellipse${eyeCount===1?'':'s'}`);
  for(const [index,eye] of sourceEyes.entries())if(eye!==null)checkedEye(eye,index,'source');
 }
}

export function applyHeldEyes({open,neutralBlink,width,height,neutralTargets,spec,sourceEyes}){
 if(!Number.isInteger(width)||width<=0||!Number.isInteger(height)||height<=0)throw Error('held eye frame dimensions must be positive integers');
 const bytes=width*height*4;
 if(!open||open.length!==bytes||!neutralBlink||neutralBlink.length!==bytes)throw Error('held eye buffers must match the frame dimensions');
 if(!Array.isArray(neutralTargets)||neutralTargets.length<1||neutralTargets.length>2||neutralTargets.some(point=>!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)))throw Error('held eye transfer requires one or two neutral targets');
 checkedSpec(spec,sourceEyes,neutralTargets.length);
 const result=Buffer.from(open);
 if(spec.closed===true)return result;

 const sourceAngle=neutralTargets.length===2
  ?Math.atan2(neutralTargets[1].y-neutralTargets[0].y,neutralTargets[1].x-neutralTargets[0].x):0;
 for(let eyeIndex=0;eyeIndex<spec.eyes.length;eyeIndex++){
  const eye=spec.eyes[eyeIndex];if(eye===null)continue;
  const [ncx,ncy,nrx,nry,degrees]=eye,rx=nrx*width,ry=nry*height;
  const angle=degrees*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  // Input centers are eye landmarks. Match the original baker by centering
  // both source and target ellipses two pixels above that landmark.
  const cx=ncx*width+2*sin,cy=ncy*height-2*cos;
  const extentX=Math.abs(cos*rx)+Math.abs(sin*ry),extentY=Math.abs(sin*rx)+Math.abs(cos*ry);
  const left=Math.max(0,Math.floor(cx-extentX)),right=Math.min(width-1,Math.ceil(cx+extentX));
  const top=Math.max(0,Math.floor(cy-extentY)),bottom=Math.min(height-1,Math.ceil(cy+extentY));
  const configuredSource=sourceEyes?.[eyeIndex],target=neutralTargets[eyeIndex];
  const sourceRotation=configuredSource?configuredSource[4]*Math.PI/180:sourceAngle;
  const sourceEyeCos=Math.cos(sourceRotation),sourceEyeSin=Math.sin(sourceRotation);
  const sourceRx=configuredSource?configuredSource[2]*width:18,sourceRy=configuredSource?configuredSource[3]*height:14;
  const sourceLandmarkX=configuredSource?configuredSource[0]*width:target.x;
  const sourceLandmarkY=configuredSource?configuredSource[1]*height:target.y;
  const sourceCx=sourceLandmarkX+2*sourceEyeSin,sourceCy=sourceLandmarkY-2*sourceEyeCos;
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
   const dx=x-cx,dy=y-cy,localX=cos*dx+sin*dy,localY=-sin*dx+cos*dy;
   const u=localX/rx,v=localY/ry,radius=Math.hypot(u,v);
   if(radius>=1)continue;
   const mix=1-smooth(.72,1,radius);
   const sourceX=sourceCx+(u*sourceRx)*sourceEyeCos-(v*sourceRy)*sourceEyeSin;
   const sourceY=sourceCy+(u*sourceRx)*sourceEyeSin+(v*sourceRy)*sourceEyeCos;
   const sampled=sampleRgb(neutralBlink,width,height,sourceX,sourceY),at=(y*width+x)*4;
   for(let channel=0;channel<3;channel++)result[at+channel]=Math.round(open[at+channel]*(1-mix)+sampled[channel]*mix);
  }
 }
 return result;
}
