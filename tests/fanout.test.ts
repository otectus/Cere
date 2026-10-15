import test from 'node:test';
import assert from 'node:assert/strict';
import { Fanout } from '../broker/fanout.ts';

/** A socket whose reader is controlled by the test: nothing drains until read() is called. */
class FakeSocket {
  destroyed=false; writableLength=0; lines:string[]=[]; drain?:()=>void;
  write(line:string){this.lines.push(line);this.writableLength+=line.length;}
  destroy(){this.destroyed=true;}
  on(_event:'drain',listener:()=>void){this.drain=listener;}
  read(){this.writableLength=0;this.drain?.();}
}
const frames=(socket:FakeSocket,from=0)=>socket.lines.slice(from).map(line=>JSON.parse(line));

test('a backed-up client receives only the newest snapshot and message copies, and is never disconnected for it',()=>{
  const fanout=new Fanout<FakeSocket>(100,1000),socket=new FakeSocket(),client=fanout.add(socket);client.subscribed=true;
  fanout.broadcast('state',{revision:1,pad:'x'.repeat(120)}); // the first frame crosses the backlog threshold
  assert.equal(socket.lines.length,1);
  for(let revision=2;revision<=50;revision++)fanout.broadcast('state',{revision,pad:'x'.repeat(120)});
  for(let n=0;n<30;n++){fanout.broadcast('message',{id:'m1',text:'reply '+n});fanout.broadcast('message',{id:'m2',text:'other '+n});}
  assert.equal(socket.lines.length,1);assert.equal(socket.destroyed,false);
  socket.read(); // a drain delivers held frames until the socket backs up again
  const held=frames(socket,1);
  assert.deepEqual(held.map(frame=>[frame.method,frame.params.id]),[['message','m1'],['message','m2']]);
  assert.equal(held[0].params.text,'reply 29');assert.equal(held[1].params.text,'other 29');
  socket.read();
  assert.equal(frames(socket,3)[0].params.revision,50); // the newest snapshot follows, once
  socket.read();
  fanout.broadcast('state',{revision:51});
  assert.equal(frames(socket,4)[0].params.revision,51); // drained: delivered directly again
  assert.equal(socket.lines.length,5);
});

test('ordered frames still end a client that never reads, and unsubscribed sockets receive no broadcasts',()=>{
  const fanout=new Fanout<FakeSocket>(100,1000),socket=new FakeSocket(),client=fanout.add(socket);
  fanout.broadcast('state',{revision:1});assert.equal(socket.lines.length,0);
  client.subscribed=true;
  for(let n=0;n<20;n++)fanout.send(client,{id:n,result:'r'.repeat(100)});
  assert.equal(socket.destroyed,true);
  fanout.remove(client);fanout.broadcast('state',{revision:2});
  assert.equal(socket.lines.length,socket.lines.length);
});
