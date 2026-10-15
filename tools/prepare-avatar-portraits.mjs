#!/usr/bin/env node
// Normalize the authored 4x3 expression grids to the runtime's 256px cells.
import sharp from 'sharp';
const ids=process.argv.slice(2);if(!ids.length)ids.push('cere','daemona','jade','nova','soap');
for(const id of ids){
 const source=`artwork/avatars/${id}/portrait-sheet.png`,meta=await sharp(source).metadata(),cells=[];
 for(let i=0;i<12;i++){
  const col=i%4,row=Math.floor(i/4),left=Math.round(col*meta.width/4),top=Math.round(row*meta.height/3);
  const width=Math.round((col+1)*meta.width/4)-left,height=Math.round((row+1)*meta.height/3)-top;
  const data=await sharp(source).extract({left,top,width,height}).resize(256,256).ensureAlpha().raw().toBuffer();
  for(let p=3;p<data.length;p+=4)if(data[p]<12)data[p]=0;
  cells.push({input:await sharp(data,{raw:{width:256,height:256,channels:4}}).png().toBuffer(),left:col*256,top:row*256});
 }
 await sharp({create:{width:1024,height:768,channels:4,background:'#00000000'}}).composite(cells).png().toFile(`assets/${id}-portraits.png`);
 console.log(`${id}: twelve expression portraits packed`);
}
