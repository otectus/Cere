import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonLines } from '../broker/wire.ts';

test('MCP observes a tool change across large projected snapshots without settings', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-mcp-'));
  let watch: Socket | undefined, granted = false, reads = 0;
  const seen: any[] = [];
  const server = createServer(socket => {
    const lines = new JsonLines();
    socket.setEncoding('utf8');
    socket.on('data', chunk => lines.push(String(chunk), message => {
      if (message.method === 'subscribe') {
        watch = socket;
        socket.write(JSON.stringify({ id: message.id, result: { partial: true, padding: 'x'.repeat(9 * 1024 * 1024) } }) + '\n');
      } else if (message.method === 'mcp.tools') {
        reads++;
        socket.end(JSON.stringify({ id: message.id, result: granted ? [{ name: 'timer.start', schema: {} }] : [] }) + '\n');
      }
    }));
  });
  await new Promise<void>(ready => server.listen(join(directory, 'broker.sock'), ready));
  const child = spawn(process.execPath, [resolve('broker/mcp.ts')], {
    env: { ...process.env, CERE_RUNTIME_DIR: directory, CERE_SESSION_TOKEN: 'fixture' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => { child.stdin.end(); child.kill(); await closed; watch?.destroy(); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); });
  const lines = new JsonLines();
  child.stdout.setEncoding('utf8').on('data', chunk => lines.push(String(chunk), value => seen.push(value)));
  child.stdin.write('{"id":1,"method":"initialize"}\n');
  async function until(done: () => boolean) {
    for (let i = 0; i < 1000 && !done(); i++) await delay(5);
    assert.ok(done(), 'expected MCP data before timeout');
  }
  await until(() => reads > 0 && seen.some(value => value.id === 1));
  granted = true;
  watch!.write('{"method":"state","params":{"partial":true,"revision":"2"}}\n');
  await until(() => seen.some(value => value.method === 'notifications/tools/list_changed'));
  child.stdin.write('{"id":2,"method":"tools/list"}\n');
  await until(() => seen.some(value => value.id === 2));
  assert.ok(seen.find(value => value.id === 2).result.tools.some((item: any) => item.name === 'timer_start'));
});
