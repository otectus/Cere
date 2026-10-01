import net from 'node:net';
import { spawn } from 'node:child_process';
import { activatePendingRecovery } from './recovery.ts';
import { chmod, unlink, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { socketPath, paths, privateDir } from './paths.ts';
import { Core } from './core.ts';
import { JsonLines } from './wire.ts';
import { requirePeerCredentials, sameUserPeer, trustedServer } from './peercred.ts';
import { MobileGateway } from './remote/server.ts';
requirePeerCredentials();
process.umask(0o077);
privateDir(paths().runtime);
const path = socketPath();
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
const core = new Core(), clients = new Set<net.Socket>();
const mobile = new MobileGateway(core);
await mobile.start().catch(error=>{console.error('Cere remote listener unavailable: '+error.message);});
function send(client: net.Socket, data: unknown) {
  if (client.destroyed) return;
  if (client.writableLength > 16*1024*1024) { client.destroy(); return; }
  client.write(JSON.stringify(data)+'\n');
}
const server = net.createServer(client => {
  if (!sameUserPeer(client)) { client.destroy(); return; }
  clients.add(client); const lines = new JsonLines(); let subscribed = false;
  client.setEncoding('utf8'); client.on('error', () => {}); client.on('close', () => {
    clients.delete(client);
    const role=(client as any).role;
    if (['ui','overlay'].includes(role) && ![...clients].some(c=>(c as any).role===role)) core.panel(role,false);
  });
  client.on('data', chunk => {
    try { lines.push(String(chunk), m => {
      if (!m || typeof m.method !== 'string' || m.id === undefined) { send(client,{id:m?.id ?? null,error:{message:'Invalid request'}}); return; }
      if (m.method === 'subscribe') { subscribed = true; (client as any).subscribed = true; (client as any).role=m.params?.role; send(client,{id:m.id,result:core.snapshot()}); return; }
      if (['ui.toggle','ui.expand'].includes(m.method)&&![...clients].some(c=>(c as any).role==='ui')){send(client,{id:m.id,error:{message:'Cere interface is not running'}});return;}
      if (m.method.startsWith('memory.') && Buffer.byteLength(JSON.stringify(m)) > 1024*1024) { send(client,{id:m.id,error:{code:'INVALID_ARGUMENT',message:'Memory frame exceeds 1 MiB'}}); return; }
      void (m.method.startsWith('remote.') ? core.withMutation(()=>mobile.local(m.method,m.params)) : core.rpc(m.method,m.params)).then(result => send(client,{id:m.id,result}), error => send(client,{id:m.id,error:{code:error.code||'INVALID_ARGUMENT',message:error.message}}));
    }); } catch { client.destroy(); }
  });
});
for (const event of ['state','message','notice','ui']) core.on(event, params => {
  for (const client of clients) if ((client as any).subscribed) send(client,{method:event,params});
});
server.on('error', error => { console.error(error.message); process.exitCode=1; void core.close(); });
server.listen(path, async () => { await chmod(path,0o600); await writeFile(join(paths().runtime,'broker.pid'),String(process.pid),{mode:0o600}); void core.detect(); });
let closing = false;
async function closeOwnedWork(){
  let deadline:NodeJS.Timeout|undefined;
  try{
    await Promise.race([
      Promise.all([mobile.close(),core.close()]),
      new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Shutdown deadline reached; memory/provider termination was not confirmed.')),10000);})
    ]);
  }catch(error){console.error(String(error));}
  finally{if(deadline)clearTimeout(deadline);}
}
async function shutdown() {
  if (closing) return; closing=true;
  for (const client of clients) client.destroy();
  server.close(); await closeOwnedWork(); await unlink(path).catch(() => {}); await unlink(join(paths().runtime,'broker.pid')).catch(()=>{}); process.exit(0);
}
core.on('restart',async()=>{
  if(closing)return;closing=true;
  for(const client of clients)client.destroy();server.close();await closeOwnedWork();
  await unlink(path).catch(()=>{});await unlink(join(paths().runtime,'broker.pid')).catch(()=>{});
  const replacement=spawn(process.execPath,process.argv.slice(1),{env:process.env,stdio:'ignore',detached:true});replacement.unref();process.exit(0);
});
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
