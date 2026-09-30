import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
export class JsonLines {
  buffer = '';
  push(chunk: string, receive: (value: any) => void) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) throw new Error('Protocol message exceeds 8 MiB');
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
      if (line.trim()) receive(JSON.parse(line));
    }
  }
}
export class RpcResponseError extends Error {}
export class RpcProcess extends EventEmitter {
  child: ChildProcessWithoutNullStreams; seq = 0; closed = false; stderr = '';
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    super(); this.child = spawn(command, args, { cwd, env, stdio: 'pipe', detached: true });
    const lines = new JsonLines();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      try { lines.push(chunk, message => {
        if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
          const p = this.pending.get(message.id)!; clearTimeout(p.timer); this.pending.delete(message.id);
          message.error ? p.reject(new RpcResponseError(message.error.message || JSON.stringify(message.error))) : p.resolve(message.result);
        } else this.emit('message', message);
      }); } catch (e) { this.emit('fault', e); this.child.kill('SIGTERM'); }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.child.on('error', error => this.emit('fault', error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Provider disconnected')); }
      this.pending.clear(); this.emit('exit', code, signal);
    });
    this.child.stdin.on('error', error => this.emit('fault', error));
  }
  write(message: unknown) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Provider disconnected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown, timeout = 60000, onDispatched?: () => void): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; the request may have been received`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); onDispatched?.(); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => { try { if (this.child.pid) process.kill(-this.child.pid, 'SIGKILL'); } catch {} }, 3000);
    await new Promise<void>(resolve => this.child.once('close', () => { clearTimeout(timer); resolve(); }));
  }
}
