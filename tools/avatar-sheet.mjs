// Separate authored figures before packing, preserving soft silhouette edges.
// Generated sheets can have uneven row gutters. Split each column through its
// transparent gutter, so a horn or dangling boot never crosses a cell boundary.
function sheetRows(sheet,left,width,rowCount){
 const {data,info:{width:w,height:h}}=sheet,rows=[0];
 for(let row=1;row<rowCount;row++){
  const center=row*h/rowCount,lo=Math.floor(center-h*.055),hi=Math.ceil(center+h*.055);let best=center,bestScore=Infinity;
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
export function sheetComponents(sheet,columns=4,rowCount=4,threshold=200){
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
 if(cores.length!==columns*rowCount&&threshold===200)return sheetComponents(sheet,columns,rowCount,245);
 if(cores.length!==columns*rowCount)throw Error(`sprite sheet needs ${columns*rowCount} separate opaque character cores, found ${cores.length}`);
 const grid=new Set(cores.map(c=>Math.floor(c.y/(h/rowCount))*columns+Math.floor(c.x/(w/columns))));
 if(grid.size!==columns*rowCount)throw Error('sprite sheet must have one character core in each grid cell');
 // High-alpha cores stay separate even where low-alpha hair halos touch.
 // Grow every core together, partitioning only those halos, never a hard
 // horizontal strip through a horn or boot.
 cores.sort((a,b)=>Math.floor(a.x/(w/columns))-Math.floor(b.x/(w/columns))||a.y-b.y);
 const order=new Map(cores.map((c,i)=>[c.label,(i%rowCount)*columns+Math.floor(i/rowCount)+1]));let head=0,tail=0;
 for(let p=0;p<size;p++){labels[p]=order.get(labels[p])||0;if(labels[p])queue[tail++]=p;}
 while(head<tail){const p=queue[head++],x=p%w,y=Math.floor(p/w);
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
   const xx=x+dx,yy=y+dy,q=yy*w+xx;
   if(xx<0||xx>=w||yy<0||yy>=h||labels[q]||data[q*4+3]<8)continue;
   labels[q]=labels[p];queue[tail++]=q;
  }
 }
 const bounds=Array.from({length:columns*rowCount},()=>({left:w,top:h,right:-1,bottom:-1}));
 for(let p=0;p<size;p++)if(labels[p]){const b=bounds[labels[p]-1],x=p%w,y=Math.floor(p/w);b.left=Math.min(b.left,x);b.right=Math.max(b.right,x);b.top=Math.min(b.top,y);b.bottom=Math.max(b.bottom,y);}
 return bounds.map((b,n)=>{
  const col=n%columns,row=Math.floor(n/columns),columnLeft=Math.round(col*w/columns),columnWidth=Math.round((col+1)*w/columns)-columnLeft,rows=sheetRows(sheet,columnLeft,columnWidth,rowCount);
  const left=Math.min(columnLeft,b.left-4),top=Math.min(rows[row],b.top-4),right=Math.max(columnLeft+columnWidth,b.right+5),bottom=Math.max(rows[row+1],b.bottom+5),width=right-left,height=bottom-top,out=Buffer.alloc(width*height*4);
  for(let y=b.top;y<=b.bottom;y++)for(let x=b.left;x<=b.right;x++){const p=y*w+x;if(labels[p]===n+1)data.copy(out,((y-top)*width+x-left)*4,p*4,p*4+4);}
  return {data:out,info:{width,height,channels:4},source:[left,top,width,height]};
 });
}
