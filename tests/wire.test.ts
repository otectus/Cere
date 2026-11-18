import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonLines } from '../broker/wire.ts';

const limit = 8 * 1024 * 1024;
const stringLine = (bytes: number) => '"' + 'x'.repeat(bytes - 2) + '"';

test('JSON lines limits each message rather than the combined read', () => {
  const parser = new JsonLines(), lengths: number[] = [];
  const line = stringLine(5 * 1024 * 1024);
  parser.push(line + '\n' + line + '\n', message => lengths.push(message.length));
  assert.deepEqual(lengths, [line.length - 2, line.length - 2]);
  assert.equal(parser.buffer, '');
});

test('JSON lines accepts a message at the byte limit with its delimiter in either read', () => {
  const line = stringLine(limit);
  for (const chunks of [[line + '\n'], [line, '\n']]) {
    const parser = new JsonLines(), lengths: number[] = [];
    for (const chunk of chunks) parser.push(chunk, message => lengths.push(message.length));
    assert.deepEqual(lengths, [limit - 2]);
    assert.equal(parser.buffer, '');
  }
});

test('JSON lines keeps a partial next message after a combined read over the limit', () => {
  const parser = new JsonLines(), lengths: number[] = [];
  const line = stringLine(5 * 1024 * 1024);
  parser.push(line.slice(0, 100), message => lengths.push(message.length));
  parser.push(line.slice(100) + '\n' + line.slice(0, -1), message => lengths.push(message.length));
  assert.deepEqual(lengths, [line.length - 2]);
  parser.push('"\n', message => lengths.push(message.length));
  assert.deepEqual(lengths, [line.length - 2, line.length - 2]);
});

test('JSON lines rejects oversized completed and unfinished messages, including UTF-8', () => {
  const ascii = stringLine(limit + 1), unicode = '"' + '界'.repeat(Math.floor(limit / 3) + 1) + '"';
  assert.ok(unicode.length < limit);
  assert.ok(Buffer.byteLength(unicode) > limit);
  for (const line of [ascii, unicode]) {
    for (const ending of ['', '\n']) {
      for (const split of [0, 100]) {
        const parser = new JsonLines();
        const receive = () => assert.fail('Oversized message must not be delivered');
        parser.push(line.slice(0, split), receive);
        assert.throws(() => parser.push(line.slice(split) + ending, receive), /Protocol message exceeds 8 MiB/);
      }
    }
  }
});

test('JSON lines delivers a valid message before rejecting an oversized next one', () => {
  const parser = new JsonLines(), received: unknown[] = [];
  assert.throws(() => parser.push('{"ok":true}\n' + stringLine(limit + 1), message => received.push(message)), /exceeds 8 MiB/);
  assert.deepEqual(received, [{ ok: true }]);
});

test('desktop response decoder may use the fanout limit without widening provider framing', () => {
  const desktop = new JsonLines(16 * 1024 * 1024), provider = new JsonLines();
  const line = stringLine(9 * 1024 * 1024), values: unknown[] = [];
  desktop.push(line + '\n', value => values.push(value));
  assert.equal((values[0] as string).length, line.length - 2);
  assert.throws(() => provider.push(line + '\n', () => {}), /exceeds 8 MiB/);
});

test('AUD-008 close kills an owned descendant after its leader has exited',async t=>{
  const {RpcProcess}=await import('../broker/wire.ts');
  const childCode="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const leaderCode=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});console.log(JSON.stringify({pid:child.pid}));setTimeout(()=>process.exit(0),100);`;
  const rpc=new RpcProcess(process.execPath,['-e',leaderCode],process.cwd());
  rpc.on('fault',()=>{});t.after(()=>rpc.close());
  const message=await new Promise<any>(resolve=>rpc.once('message',resolve));
  await new Promise<void>(resolve=>rpc.once('exit',()=>resolve()));
  const started=Date.now();await rpc.close();await rpc.close();assert.ok(Date.now()-started<5000);
  const {readFile}=await import('node:fs/promises');
  const stat=await readFile(`/proc/${message.pid}/stat`,'utf8').catch(()=>'');
  assert.ok(!stat||stat.slice(stat.lastIndexOf(')')+2).startsWith('Z '));
});
