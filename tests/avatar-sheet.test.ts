import assert from 'node:assert/strict';
import test from 'node:test';
import {sheetComponents} from '../tools/avatar-sheet.mjs';

test('thin contacts between portraits can be separated without erasing source pixels', () => {
  const width=200,height=140,data=Buffer.alloc(width*height*4);
  for(let y=25;y<115;y++)for(let x=25;x<175;x++){
    if((x>=65&&x<135)&&y!==70)continue;
    const at=(y*width+x)*4;
    data[at]=120;data[at+1]=150;data[at+2]=190;data[at+3]=255;
  }
  const sheet={data,info:{width,height,channels:4}};
  assert.throws(()=>sheetComponents(sheet,2,1),/separate opaque character cores/);
  const pieces=sheetComponents(sheet,2,1,200,1);
  assert.equal(pieces.length,2);
  const restored=Buffer.alloc(data.length),visits=new Uint8Array(width*height);
  for(const piece of pieces){
    const [left,top]=piece.source;
    for(let y=0;y<piece.info.height;y++)for(let x=0;x<piece.info.width;x++){
      const source=(y*piece.info.width+x)*4;
      if(!piece.data[source+3])continue;
      const target=(y+top)*width+x+left;
      assert.equal(visits[target]++,0,'a source pixel belongs to one portrait');
      piece.data.copy(restored,target*4,source,source+4);
    }
  }
  assert.deepEqual(restored,data,'erosion changes seed ownership, never the painted silhouette');
});
