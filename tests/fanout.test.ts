import test from 'node:test';
import assert from 'node:assert/strict';
import { Fanout } from '../broker/fanout.ts';

/** A socket whose reader is controlled by the test: nothing drains until read() is called. */
class FakeSocket {
  destroyed=false; writableLength=0; lines:string[]=[]; drains=new Set<()=>void>();
  write(line:string){this.lines.push(line);this.writableLength+=Buffer.byteLength(line);}
  destroy(){this.destroyed=true;}
  on(_event:'drain',listener:()=>void){this.drains.add(listener);}
  off(_event:'drain',listener:()=>void){this.drains.delete(listener);}
  read(){this.writableLength=0;for(const drain of this.drains)drain();}
}
/** A reader frozen with some bytes already queued, as in the review's reproduction. */
class StuckSocket extends FakeSocket { constructor(queued:number){super();this.writableLength=queued;} write(line:string){this.lines.push(line);} }
const frames=(socket:FakeSocket,from=0)=>socket.lines.slice(from).map(line=>JSON.parse(line));
const held=(client:any)=>(client.pendingState?Buffer.byteLength(client.pendingState):0)+[...(client.pendingMessages?.values()??[])].reduce((n:number,line:string)=>n+Buffer.byteLength(line),0);

test('a backed-up client receives only the newest snapshot and message copies, and is never disconnected for it',()=>{
  const fanout=new Fanout<FakeSocket>(100,1000),socket=new FakeSocket(),client=fanout.add(socket);client.subscribed=true;
  fanout.broadcast('state',{revision:1,pad:'x'.repeat(120)}); // the first frame crosses the backlog threshold
  assert.equal(socket.lines.length,1);
  for(let revision=2;revision<=50;revision++)fanout.broadcast('state',{revision,pad:'x'.repeat(120)});
  for(let n=0;n<30;n++){fanout.broadcast('message',{id:'m1',text:'reply '+n});fanout.broadcast('message',{id:'m2',text:'other '+n});}
  assert.equal(socket.lines.length,1);assert.equal(socket.destroyed,false);
  assert.equal(client.pendingBytes,held(client),'held bytes are accounted exactly');
  socket.read(); // a drain delivers held frames until the socket backs up again
  const delivered=frames(socket,1);
  assert.deepEqual(delivered.map(frame=>[frame.method,frame.params.id]),[['message','m1'],['message','m2']]);
  assert.equal(delivered[0].params.text,'reply 29');assert.equal(delivered[1].params.text,'other 29');
  socket.read();
  assert.equal(frames(socket,3)[0].params.revision,50); // the newest snapshot follows, once
  socket.read();
  fanout.broadcast('state',{revision:51});
  assert.equal(frames(socket,4)[0].params.revision,51); // drained: delivered directly again
  assert.equal(socket.lines.length,5);assert.equal(client.pendingBytes,0);
});

test('ordered frames still end a client that never reads, and unsubscribed sockets receive no broadcasts',()=>{
  const fanout=new Fanout<FakeSocket>(100,1000),socket=new FakeSocket(),client=fanout.add(socket);
  fanout.broadcast('state',{revision:1});assert.equal(socket.lines.length,0);
  client.subscribed=true;
  for(let n=0;n<20;n++)fanout.send(client,{id:n,result:'r'.repeat(100)});
  assert.equal(socket.destroyed,true);
  assert.ok(socket.lines.join('').length<=1000,'nothing past the limit was queued');
  fanout.remove(client);const before=socket.lines.length;fanout.broadcast('state',{revision:2});
  assert.equal(socket.lines.length,before);
});

// The review's reproduction (414,790 bytes held against an 8,192-byte limit, socket still open),
// with assertions: distinct messages can no longer grow what a client retains past the limit.
test('many distinct messages for a frozen client stay within the limit: a resync-capable client is told to resync, another is disconnected',()=>{
  for(const resync of [false,true]){
    const fanout=new Fanout<StuckSocket>(1024,8192),socket=new StuckSocket(2048),client=fanout.add(socket);client.subscribed=true;client.resync=resync;
    let peak=0;
    for(let i=0;i<100;i++){fanout.broadcast('message',{id:String(i),text:'x'.repeat(4096)});peak=Math.max(peak,held(client)+socket.writableLength);}
    assert.ok(peak<=fanout.limit,`retained ${peak} bytes with an ${fanout.limit}-byte limit`);
    assert.equal(client.pendingBytes,held(client));
    if(!resync){assert.equal(socket.destroyed,true);assert.equal(held(client),0,'a disconnected client holds nothing');continue;}
    assert.equal(socket.destroyed,false);assert.equal(client.resyncPending,true);assert.equal(client.pendingMessages?.size??0,0);
    fanout.broadcast('state',{revision:7});
    socket.writableLength=0;fanout.flush(client);
    assert.deepEqual(frames(socket).map(frame=>frame.method),['resync','state'],'the reader is told to resync, then gets the newest snapshot');
    assert.equal(frames(socket)[1].params.revision,7);assert.equal(client.pendingBytes,0);assert.equal(client.resyncPending,false);
  }
});

test('the number of distinct held messages is bounded even when each is small',()=>{
  const fanout=new Fanout<StuckSocket>(10,1024*1024,16),socket=new StuckSocket(100),client=fanout.add(socket);client.subscribed=true;client.resync=true;
  for(let i=0;i<16;i++)fanout.broadcast('message',{id:'m'+i,text:'t'});
  assert.equal(client.pendingMessages?.size,16);assert.equal(client.resyncPending,undefined);
  fanout.broadcast('message',{id:'m16',text:'t'});
  assert.equal(client.resyncPending,true);assert.equal(client.pendingMessages?.size??0,0);assert.equal(socket.destroyed,false);
  for(let i=0;i<50;i++)fanout.broadcast('message',{id:'later'+i,text:'t'});
  assert.equal(client.pendingMessages?.size??0,0,'nothing is held while a resync is owed');
});

test('many revisions of one message hold one copy, sized as the newest',()=>{
  const fanout=new Fanout<StuckSocket>(10,64*1024),socket=new StuckSocket(100),client=fanout.add(socket);client.subscribed=true;
  for(let n=0;n<1000;n++)fanout.broadcast('message',{id:'stream',text:'token '.repeat(n%50)});
  assert.equal(client.pendingMessages?.size,1);assert.equal(socket.destroyed,false);
  const newest=JSON.stringify({method:'message',params:{id:'stream',text:'token '.repeat(999%50)}})+'\n';
  assert.equal(client.pendingBytes,Buffer.byteLength(newest));
});

test('a frozen client does not hold up a healthy one, and ordered frames to it keep their order',()=>{
  const fanout=new Fanout<FakeSocket>(64,4096),slow=new StuckSocket(4000),healthy=new FakeSocket();
  const a=fanout.add(slow),b=fanout.add(healthy);a.subscribed=b.subscribed=true;a.resync=true;b.resync=true;
  for(let n=0;n<40;n++){fanout.broadcast('message',{id:'m'+(n%5),text:'x'.repeat(200)});fanout.broadcast('state',{revision:n});healthy.read();}
  assert.equal(frames(healthy).length,80,'the healthy client got every frame');
  assert.ok(held(a)+slow.writableLength<=fanout.limit);
  const reader=new FakeSocket(),c=fanout.add(reader);c.subscribed=true;
  fanout.broadcast('state',{revision:100,pad:'x'.repeat(100)}); // backs the reader up
  for(let n=0;n<5;n++){fanout.send(c,{id:n,result:n});fanout.broadcast('message',{id:'m',text:String(n)});}
  assert.deepEqual(frames(reader).filter(frame=>'result' in frame).map(frame=>frame.id),[0,1,2,3,4],'results are written in order, never held');
});

test('removing a client releases everything held for it and its drain listener',()=>{
  const fanout=new Fanout<FakeSocket>(10,100000),socket=new FakeSocket(),client=fanout.add(socket);client.subscribed=true;
  fanout.broadcast('state',{revision:1,pad:'x'.repeat(50)});
  for(let n=0;n<20;n++)fanout.broadcast('message',{id:'m'+n,text:'x'.repeat(100)});
  assert.ok((client.pendingBytes??0)>0);assert.equal(socket.drains.size,1);
  socket.destroyed=true;fanout.remove(client);
  assert.equal(client.pendingBytes,0);assert.equal(client.pendingMessages,undefined);assert.equal(client.pendingState,undefined);
  assert.equal(socket.drains.size,0,'the drain listener is removed');assert.equal(fanout.clients.size,0);
});

test('held copies across all clients are bounded: the largest holder resyncs first',()=>{
  const fanout=new Fanout<StuckSocket>(10,64*1024,512,12*1024),sockets=[new StuckSocket(100),new StuckSocket(100),new StuckSocket(100)];
  const clients=sockets.map(socket=>{const client=fanout.add(socket);client.subscribed=true;client.resync=true;return client;});
  let peak=0;
  for(let n=0;n<30;n++){fanout.broadcast('message',{id:'m'+n,text:'x'.repeat(300)});peak=Math.max(peak,clients.reduce((total,client)=>total+(client.pendingBytes??0),0));}
  assert.ok(peak<=fanout.globalLimit,`${peak} bytes held across clients with a ${fanout.globalLimit}-byte global bound`);
  assert.ok(clients.some(client=>client.resyncPending),'a large holder was told to resync');
  assert.ok(clients.every(client=>(client.pendingBytes??0)<=fanout.limit));
  assert.ok(sockets.every(socket=>!socket.destroyed),'resync-capable clients stay connected');
});
