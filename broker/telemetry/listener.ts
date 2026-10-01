import net from 'node:net';
import { debuglog } from 'node:util';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../paths.ts';
import { sameUserPeer } from '../peercred.ts';
import { linuxNative, type LinuxNative } from './native.ts';
import { validate, HOOK_VERSION, type Event, type TelemetryConfig } from './protocol.ts';
const debug=debuglog('cere-telemetry');
export function telemetryDirectory(){return process.env.XDG_RUNTIME_DIR?join(process.env.XDG_RUNTIME_DIR,'cere'):`/tmp/cere-${process.getuid!()}`;}
export class Listener {
  server?:net.Server; clients=new Set<net.Socket>(); socket:string; inode?:number; native:LinuxNative; directory:string;
  state='stopped';events=0;drops=0;invalid=0;outdated=false;lastError='';
  lastDebug=0;
  config:()=>TelemetryConfig; receive:(event:Event,at:number)=>void; peer:(socket:net.Socket)=>boolean;
  constructor(directory:string,config:()=>TelemetryConfig,receive:(event:Event,at:number)=>void,peer=sameUserPeer,native=linuxNative()){
    this.directory=directory;this.socket=join(directory,'telemetry.sock');this.config=config;this.receive=receive;this.peer=peer;this.native=native;
  }
  async start(){
    privateDir(this.directory);const lock=this.native.lock(join(this.directory,'telemetry.lock'));
    if(lock<0){this.state='in use';return;}
    try{
      try{
        const stat=await lstat(this.socket);if(stat.isSymbolicLink()||!stat.isSocket()||stat.uid!==process.getuid!())throw new Error('UNSAFE_SOCKET');
        const occupied=await new Promise<boolean>((resolve,reject)=>{const s=net.createConnection(this.socket);s.setTimeout(200,()=>{s.destroy();reject(new Error('SOCKET_UNAVAILABLE'));});s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',(e:NodeJS.ErrnoException)=>['ECONNREFUSED','ENOENT'].includes(e.code||'')?resolve(false):reject(new Error('SOCKET_UNAVAILABLE')));});
        if(occupied){this.state='in use';return;}await unlink(this.socket);
      }catch(e:any){if(e.code!=='ENOENT')throw e;}
      this.server=net.createServer(socket=>this.connect(socket));
      await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.socket,resolve);});
      await chmod(this.socket,0o600);this.inode=(await lstat(this.socket)).ino;this.state='listening';
      this.server.on('error',()=>{this.state='error';this.lastError='LISTENER_ERROR';});
    }catch(e:any){this.state='error';this.lastError=['UNSAFE_SOCKET','SOCKET_UNAVAILABLE'].includes(e.message)?e.message:'LISTENER_UNAVAILABLE';await this.stop(true);}
    finally{this.native.unlock(lock);}
  }
  connect(socket:net.Socket){
    if(!this.peer(socket)||this.clients.size>=16){this.drops++;socket.destroy();return;}
    this.clients.add(socket);let buffer=Buffer.alloc(0);
    const policy=this.config();socket.write(JSON.stringify({enabled:policy.enabled,commands:policy.commands,output:policy.output})+'\n');
    socket.setTimeout(1000,()=>socket.destroy());socket.on('error',()=>{});socket.on('close',()=>this.clients.delete(socket));
    socket.on('data',chunk=>{
      // Scan before concatenation; one peer can never allocate an unbounded frame.
      for(let offset=0;offset<chunk.length;){const end=chunk.indexOf(10,offset),stop=end<0?chunk.length:end;
        if(buffer.length+stop-offset>16*1024){this.drops++;socket.destroy();return;}
        buffer=Buffer.concat([buffer,chunk.subarray(offset,stop)]);offset=stop+1;if(end<0)break;
        const config=this.config();if(config.enabled){let event:Event|undefined;try{event=validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)),config);}catch{}
          if(event){this.events++;if(event.hook_version!==HOOK_VERSION)this.outdated=true;this.receive(event,performance.now());}else{this.invalid++;if(performance.now()-this.lastDebug>1000){this.lastDebug=performance.now();debug('EVENT_REJECTED');}}}
        buffer=Buffer.alloc(0);
      }
    });
  }
  discardBuffers(){for(const c of this.clients)c.destroy();this.clients.clear();}
  async stop(locked=false){
    this.discardBuffers();if(this.server){await new Promise<void>(resolve=>this.server!.close(()=>resolve()));this.server=undefined;}
    if(this.inode!==undefined){let lock=-1;try{lock=locked?-1:this.native.lock(join(this.directory,'telemetry.lock'));if(locked||lock>=0){const s=await lstat(this.socket);if(s.isSocket()&&s.uid===process.getuid!()&&s.ino===this.inode)await unlink(this.socket);}}catch{}finally{if(lock>=0)this.native.unlock(lock);}this.inode=undefined;}
    if(this.state==='listening')this.state='stopped';
  }
}
