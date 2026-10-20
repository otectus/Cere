import net from 'node:net';
import { spawn } from 'node:child_process';
import { activatePendingRecovery } from './recovery.ts';
import { chmod, unlink, lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { socketPath, paths, privateDir, ensureUserPath } from './paths.ts';
import { Core } from './core.ts';
import { JsonLines } from './wire.ts';
import { Fanout } from './fanout.ts';
import type { FanoutClient } from './fanout.ts';
import { requirePeerCredentials, sameUserPeer, trustedServer } from './peercred.ts';
import { MobileGateway } from './remote/server.ts';
import { linuxNative } from './telemetry/native.ts';
/** systemd restarts the service for this status; see packaging/cere-broker.service. */
const restartStatus = 75;
requirePeerCredentials();
process.umask(0o077);
// Whoever starts the broker (the service, the interface's fallback, a development shell), the
// provider CLIs in ~/.local/bin are found and every provider process inherits the same PATH.
ensureUserPath();
privateDir(paths().runtime);
const path = socketPath();
// One broker per runtime directory. A predecessor that is still exiting (a restart) or still
// starting holds the lock briefly; a second launcher waits for it instead of racing it.
await (async () => {
  let native;
  try { native = linuxNative(); } catch { console.error('Cere broker lock unavailable: the native helper is missing'); return; }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (native.lock(join(paths().runtime, 'broker.lock')) >= 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const owner = (await readFile(join(paths().runtime, 'broker.pid'), 'utf8').catch(() => '')).trim();
  console.error(`Another Cere broker${/^\d+$/.test(owner) ? ` (pid ${owner})` : ''} owns this runtime directory; not starting a second one.`);
  process.exit(0);
})();
// A listening socket counts as a running broker only when its server is this user.
async function occupied() {
  return new Promise<boolean>((resolve, reject) => {
    const client = net.createConnection(path);
    client.once('connect', () => { const trusted = trustedServer(client); client.destroy(); trusted ? resolve(true) : reject(new Error('The Cere broker socket belongs to another user')); });
    client.once('error', () => resolve(false));
  });
}
if (await occupied()) process.exit(0);
try { const s = await lstat(path); if (!s.isSocket() || s.uid !== process.getuid?.()) throw new Error('Unsafe broker socket'); await unlink(path); } catch (e:any) { if (e.code !== 'ENOENT') throw e; }
activatePendingRecovery(paths().state);
type Client = FanoutClient<net.Socket> & { role?: string };
const core = new Core(), fanout = new Fanout<net.Socket>(), clients = fanout.clients as Set<Client>;
const mobile = new MobileGateway(core);
await mobile.start().catch(error=>{console.error('Cere remote listener unavailable: '+error.message);});
const send = (client: Client, data: unknown) => fanout.send(client, data);
const server = net.createServer(socket => {
  if (!sameUserPeer(socket)) { socket.destroy(); return; }
  const client: Client = fanout.add(socket); const lines = new JsonLines(); let subscribed = false;
  socket.setEncoding('utf8'); socket.on('error', () => {}); socket.on('close', () => {
    fanout.remove(client);
    const role=client.role;
    if (role && ['ui','overlay'].includes(role) && ![...clients].some(c=>c.role===role)) core.panel(role,false);
  });
  socket.on('data', chunk => {
    try { lines.push(String(chunk), m => {
      if (!m || typeof m.method !== 'string' || m.id === undefined) { send(client,{id:m?.id ?? null,error:{message:'Invalid request'}}); return; }
      // A subscriber that offers `resync` is asked to reread its transcript when its backlog is dropped.
      if (m.method === 'subscribe') { subscribed = true; client.subscribed = true; client.role=m.params?.role; client.resync=m.params?.resync===true; send(client,{id:m.id,result:core.snapshot()}); return; }
      // Liveness: answered by this loop directly, so a reply means the broker itself is running.
      if (m.method === 'ping') { send(client,{id:m.id,result:{}}); return; }
      if (['ui.toggle','ui.expand'].includes(m.method)&&![...clients].some(c=>c.role==='ui')){send(client,{id:m.id,error:{message:'Cere interface is not running'}});return;}
      if (m.method.startsWith('memory.') && Buffer.byteLength(JSON.stringify(m)) > 1024*1024) { send(client,{id:m.id,error:{code:'INVALID_ARGUMENT',message:'Memory frame exceeds 1 MiB'}}); return; }
      void (m.method.startsWith('remote.') ? core.withMutation(()=>mobile.local(m.method,m.params)) : core.rpc(m.method,m.params)).then(result => send(client,{id:m.id,result}), error => send(client,{id:m.id,error:{code:error.code||'INVALID_ARGUMENT',message:error.message}}));
    }); } catch { socket.destroy(); }
  });
});
for (const event of ['state','message','notice','ui']) core.on(event, params => fanout.broadcast(event, params));
server.on('error', error => { console.error(error.message); process.exitCode=1; void core.close(); });
server.listen(path, async () => { await chmod(path,0o600); await writeFile(join(paths().runtime,'broker.pid'),String(process.pid),{mode:0o600}); void core.detect(); });
let closing = false;
/**
 * Bounded, ordered shutdown: no new local or phone change starts; the gateway refuses frames and lets
 * the ones running finish; then Core stops providers, workers, memory and speech and closes the store
 * last. A deadline or unfinished gateway work is recorded in last-shutdown.json, which Health shows
 * after the next start: termination that was not confirmed is never reported as clean.
 */
async function closeOwnedWork(){
  let deadline:NodeJS.Timeout|undefined;
  const problems:string[]=[];
  core.refuseMutations();
  try{
    await Promise.race([
      (async()=>{
        await mobile.close();
        if(mobile.unsettled)problems.push(`${mobile.unsettled} phone operation${mobile.unsettled===1?' was':'s were'} still running; ${mobile.unsettled===1?'its':'their'} outcome was not confirmed.`);
        await core.close();
      })(),
      new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Shutdown deadline reached; memory/provider termination was not confirmed.')),10000);})
    ]);
  }catch(error){problems.push(error instanceof Error?error.message:String(error));}
  finally{if(deadline)clearTimeout(deadline);}
  for(const problem of problems)console.error(problem);
  await writeFile(join(paths().state,'last-shutdown.json'),JSON.stringify({at:Date.now(),confirmed:!problems.length,problems}),{mode:0o600}).catch(()=>{});
}
async function shutdown() {
  if (closing) return; closing=true;
  for (const client of clients) client.socket.destroy();
  server.close(); await closeOwnedWork(); await unlink(path).catch(() => {}); await unlink(join(paths().runtime,'broker.pid')).catch(()=>{}); process.exit(0);
}
core.on('restart',async()=>{
  if(closing)return;closing=true;
  for(const client of clients)client.socket.destroy();server.close();await closeOwnedWork();
  await unlink(path).catch(()=>{});await unlink(join(paths().runtime,'broker.pid')).catch(()=>{});
  // A service's own process restarts through systemd: a detached child would be stopped
  // with the service's control group as soon as this process exits.
  if(process.env.INVOCATION_ID&&process.env.SYSTEMD_EXEC_PID===String(process.pid))process.exit(restartStatus);
  const replacement=spawn(process.execPath,process.argv.slice(1),{env:process.env,stdio:'ignore',detached:true});replacement.unref();process.exit(0);
});
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
