/** Isolated broker-state benchmark. Does not start providers or use user state. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../broker/store.ts';
import { Core } from '../broker/core.ts';

const directory = await mkdtemp(join(tmpdir(), 'cere-state-benchmark-'));
const rows: unknown[] = [];
try {
  for (const count of [100, 1000, 5000]) {
    const store = new Store(join(directory, String(count)));
    for (let i = 0; i < count; i++) store.saveSession({id:String(i),provider:'codex',nativeId:null,
      title:`Conversation ${i}`,cwd:directory,mode:'managed',status:'idle',created:i,updated:i,
      draft:'A recoverable draft.',scroll:0,model:''});
    const core = new Core(store, () => ({async send(){},async close(){},async interrupt(){}}));
    const samples: number[] = []; let bytes = 0;
    for (let i = 0; i < 55; i++) {
      const start = performance.now(); const serialized = JSON.stringify(core.snapshot());
      if (i >= 5) samples.push(performance.now() - start);
      bytes = Buffer.byteLength(serialized);
    }
    samples.sort((a,b) => a-b);
    rows.push({sessions:count,iterations:samples.length,snapshotBytes:bytes,
      p50Ms:samples[24],p95Ms:samples[47],p99Ms:samples[49],rssBytes:process.memoryUsage().rss});
    await core.close();
  }
  console.log(JSON.stringify({kind:'isolated-state-serialization',node:process.version,
    limitations:'Synchronous snapshot plus JSON serialization only; excludes UI, streaming, provider latency and whole-installation resource use.',rows}, null, 2));
} finally { await rm(directory, {recursive:true,force:true}); }
