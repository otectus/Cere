#!/usr/bin/env node
// Normalize the authored 4x3 expression grids to the runtime's 256px cells.
import sharp from 'sharp';
import {sheetComponents} from './avatar-sheet.mjs';
import {readFile} from 'node:fs/promises';
const configs=JSON.parse(await readFile('artwork/avatars/sources.json','utf8'));
const ids=process.argv.slice(2);if(!ids.length)ids.push(...JSON.parse(await readFile('assets/avatars.json','utf8')).map(avatar=>avatar.id));
for(const id of ids){
 const source=`artwork/avatars/${id}/portrait-sheet.png`,meta=await sharp(source).metadata(),cells=[];
 // Uneven gutters can leave another portrait's shoulders inside a square crop.
 // Separate the actual figures, then pack them at one shared scale with margin.
 let portraits=null,scale=1;
 if(configs[id]?.portraitComponents){
  const components=sheetComponents(await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true}),4,3);
  portraits=components.map(image=>{
   const {data,info:{width,height}}=image;let left=width,top=height,right=-1,bottom=-1;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4+3]>=12){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
   return {...image,bounds:{left,top,width:right-left+1,height:bottom-top+1}};
  });
  scale=232/Math.max(...portraits.flatMap(p=>[p.bounds.width,p.bounds.height]));
 }
 for(let i=0;i<12;i++){
  const col=i%4,row=Math.floor(i/4),left=Math.round(col*meta.width/4),top=Math.round(row*meta.height/3);
  const width=Math.round((col+1)*meta.width/4)-left,height=Math.round((row+1)*meta.height/3)-top;
  let data;
  if(portraits){
   const p=portraits[i],w=Math.max(1,Math.round(p.bounds.width*scale)),h=Math.max(1,Math.round(p.bounds.height*scale));
   const input=await sharp(p.data,{raw:p.info}).extract(p.bounds).resize(w,h).png().toBuffer();
   data=await sharp({create:{width:256,height:256,channels:4,background:'#00000000'}}).composite([{input,left:Math.floor((256-w)/2),top:Math.floor((256-h)/2)}]).raw().toBuffer();
  }else data=await sharp(source).extract({left,top,width,height}).resize(256,256).ensureAlpha().raw().toBuffer();
  for(let p=3;p<data.length;p+=4)if(data[p]<12)data[p]=0;
  cells.push({input:await sharp(data,{raw:{width:256,height:256,channels:4}}).png().toBuffer(),left:col*256,top:row*256});
 }
 await sharp({create:{width:1024,height:768,channels:4,background:'#00000000'}}).composite(cells).png().toFile(`assets/${id}-portraits.png`);
 console.log(`${id}: twelve expression portraits packed`);
}
