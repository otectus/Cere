import assert from 'node:assert/strict';
import test from 'node:test';
import {applyHeldEyes} from '../tools/avatar-eyes.mjs';

function solid(width:number,height:number,r:number,g:number,b:number){
 const data=Buffer.alloc(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const at=(y*width+x)*4;data[at]=r;data[at+1]=g;data[at+2]=b;
  // Vary alpha so an accidental replacement is visible to the assertion.
  data[at+3]=80+(x*13+y*7)%176;
 }
 return data;
}

function pixel(data:Uint8Array,width:number,x:number,y:number){
 return [...data.subarray((y*width+x)*4,(y*width+x+1)*4)];
}

test('held eyelids feather only inside reviewed geometry and preserve open alpha',()=>{
 const width=40,height=30,open=solid(width,height,20,30,40),neutralBlink=Buffer.from(open);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const at=(y*width+x)*4;neutralBlink[at]=220;neutralBlink[at+1]=80;neutralBlink[at+2]=60;
 }
 const spec={eyes:[[.7,17/height,.2,.2,0] as [number,number,number,number,number]]};
 const result=applyHeldEyes({open,neutralBlink,width,height,neutralTargets:[{x:10,y:15}],spec});
 assert.notDeepEqual(pixel(result,width,28,15),pixel(open,width,28,15),'target center receives the neutral lid');
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const at=(y*width+x)*4,inside=Math.hypot((x-28)/8,(y-15)/6)<1;
  assert.equal(result[at+3],open[at+3],'open alpha is exact');
  if(!inside)assert.deepEqual(result.subarray(at,at+4),open.subarray(at,at+4),'pixels outside the ellipse are untouched');
 }
 const feather=pixel(result,width,35,15)[0];
 assert.ok(feather>20&&feather<220,'the outer eyelid edge blends instead of cutting hard');
});

test('held eyelid mapping rotates and scales the neutral eye patch',()=>{
 const width=48,height=36,open=solid(width,height,0,0,180),neutralBlink=Buffer.from(open);
 // The helper's historical neutral footprint is centered two pixels above the iris.
 for(let y=9;y<=11;y++)for(let x=18;x<=20;x++){
  const at=(y*width+x)*4;neutralBlink[at]=240;neutralBlink[at+1]=20;neutralBlink[at+2]=10;
 }
 const target={x:10,y:12},plain=applyHeldEyes({
  open,neutralBlink,width,height,neutralTargets:[target],
  spec:{eyes:[[30/width,22/height,8/width,6/height,0]]}
 });
 const rotated=applyHeldEyes({
  open,neutralBlink,width,height,neutralTargets:[target],
  spec:{eyes:[[28/width,20/height,8/width,6/height,90]]},
  sourceEyes:[[10/width,12/height,18/width,14/height,0]]
 });
 assert.ok(pixel(plain,width,34,20)[0]>200,'scaled source detail lands on the target major axis');
 assert.ok(pixel(plain,width,30,24)[2]>150,'unrotated minor axis keeps the open colour');
 assert.ok(pixel(rotated,width,30,24)[0]>200,'rotation moves source detail onto the vertical major axis');
 assert.ok(pixel(rotated,width,34,20)[2]>150,'the former horizontal location is no longer repainted');
});

test('closed poses and individually preserved eyes retain exact open pixels',()=>{
 const width=40,height=24,open=solid(width,height,15,25,35),neutralBlink=solid(width,height,230,90,70);
 assert.deepEqual(applyHeldEyes({
  open,neutralBlink,width,height,neutralTargets:[{x:12,y:10},{x:28,y:10}],spec:{closed:true}
 }),open,'an authored closed pose is copied byte-for-byte without eye tuples');

 const repaired=applyHeldEyes({
  open,neutralBlink,width,height,neutralTargets:[{x:12,y:10},{x:28,y:10}],
  spec:{eyes:[null,[.7,.5,.16,.2,0]]}
 });
 assert.deepEqual(pixel(repaired,width,12,10),pixel(open,width,12,10),'a null eye keeps already-closed or covered art');
 assert.notDeepEqual(pixel(repaired,width,28,10),pixel(open,width,28,10),'the other neutral-indexed eye is repaired');
});
