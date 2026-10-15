#!/usr/bin/env node
/**
 * Read-only broker traffic probe: subscribes to the running broker as a passive client and reports
 * how many state snapshots and message frames it pushes, their sizes and the snapshot's largest
 * keys. Usage: node tools/probe-broker.mjs [seconds]   (default 15; uses $CERE_RUNTIME_DIR or $XDG_RUNTIME_DIR/cere)
 */
import net from 'node:net';
import { join } from 'node:path';
const seconds = Number(process.argv[2] || 15);
const runtime = process.env.CERE_RUNTIME_DIR || join(process.env.XDG_RUNTIME_DIR || '/tmp', 'cere');
const socket = net.createConnection(join(runtime, 'broker.sock'));
let buffer = '', snapshot = null, snapshotBytes = 0; const keyBytes = {}, stats = {}; const started = Date.now();
socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'subscribe', params: { role: 'probe' } }) + '\n'));
socket.on('data', chunk => {
  buffer += chunk; let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    const bytes = Buffer.byteLength(line);
    if (frame.id === 1) { snapshot = frame.result; snapshotBytes = bytes; for (const key of Object.keys(snapshot)) keyBytes[key] = Buffer.byteLength(JSON.stringify(snapshot[key])); continue; }
    const key = frame.method === 'message' ? `message:${frame.params?.role || ''}` : frame.method;
    const entry = stats[key] ||= { count: 0, bytes: 0, maxBytes: 0 };
    entry.count++; entry.bytes += bytes; entry.maxBytes = Math.max(entry.maxBytes, bytes);
  }
});
socket.on('error', error => { console.error('probe: ' + error.message); process.exit(1); });
setTimeout(() => {
  socket.end(); const elapsed = (Date.now() - started) / 1000;
  const busy = (snapshot?.sessions || []).filter(s => ['starting', 'working', 'waiting', 'stopping'].includes(s.status)).map(s => `${s.provider}:${s.status}:${s.activity || ''}`);
  console.log(JSON.stringify({ seconds: elapsed, snapshotBytes, sessions: snapshot?.sessions?.length, busy,
    largestKeys: Object.entries(keyBytes).sort((a, b) => b[1] - a[1]).slice(0, 5),
    frames: Object.fromEntries(Object.entries(stats).map(([key, v]) => [key, { ...v, perSecond: +(v.count / elapsed).toFixed(2), kbPerSecond: +(v.bytes / 1024 / elapsed).toFixed(1) }])) }, null, 1));
}, seconds * 1000);
