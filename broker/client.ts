import net from 'node:net';
import { socketPath } from './paths.ts';
import { JsonLines } from './wire.ts';
import { trustedServer } from './peercred.ts';
export function request(method: string, params: any = {}, timeout = 10000, expectedUid = process.getuid?.()): Promise<any> {
  return new Promise((resolve,reject) => {
    const socket = net.createConnection(socketPath()); const lines=new JsonLines();
    const timer=setTimeout(() => { socket.destroy(); reject(new Error('Cere did not respond')); },timeout);
    const done=(error?: Error,value?: any) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setEncoding('utf8'); socket.on('error',error => done(error));
    // The server's credentials are verified before any request data is written.
    socket.on('connect',() => {
      try { if (!trustedServer(socket, expectedUid)) { done(new Error('The Cere broker socket belongs to another user; refusing to connect')); return; } }
      catch (error: any) { done(error); return; }
      socket.write(JSON.stringify({id:1,method,params})+'\n');
    });
    socket.on('data',chunk => { try { lines.push(String(chunk),m => { if(m.id===1) done(m.error ? new Error(m.error.message) : undefined,m.result); }); } catch(e:any){done(e);} });
  });
}
