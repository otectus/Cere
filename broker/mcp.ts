import { request } from './client.ts';
import { JsonLines } from './wire.ts';
import net from 'node:net';
import { socketPath } from './paths.ts';
const token = process.env.CERE_SESSION_TOKEN;
if (!token) { console.error('Cere MCP must be launched by a managed session'); process.exit(1); }
const lines = new JsonLines();
const respond = (m: any) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
let initialized=false,lastTools='';
const changes=net.createConnection(socketPath()),changeLines=new JsonLines();
changes.setEncoding('utf8');changes.on('error',()=>{});
changes.on('connect',()=>changes.write(JSON.stringify({id:'watch',method:'subscribe',params:{role:'mcp'}})+'\n'));
changes.on('data',chunk=>{try{changeLines.push(String(chunk),m=>{
  const settings=(m.method==='state'?m.params:m.id==='watch'?m.result:null)?.settings;
  if(!settings)return;const signature=JSON.stringify([settings.profile,settings.paused,settings.categories,settings.bypassCliPermissions,settings.bypassComputerPermissions]);
  if(initialized&&lastTools&&lastTools!==signature)respond({method:'notifications/tools/list_changed'});lastTools=signature;
});}catch{changes.destroy();}});
async function handle(m: any) {
  if (m.id === undefined) return;
  try {
    let result: any;
    if (m.method === 'initialize') {initialized=true;result={protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:true}},serverInfo:{name:'cere',version:'0.1.0'}};}
    else if (m.method === 'ping') result={};
    else if (m.method === 'tools/list') {
      const defs = await request('mcp.tools',{token});
      result={tools:[{name:'approve',description:'Respond to a Claude Code permission request through the Cere user interface',inputSchema:{type:'object',properties:{tool_name:{type:'string'},input:{type:'object'}},required:['tool_name','input']}},...defs.map((d:any)=>({name:d.name.replaceAll('.','_'),description:d.description,inputSchema:{type:'object',properties:d.schema,required:d.required||Object.keys(d.schema),additionalProperties:false}}))]};
    } else if (m.method === 'tools/call') {
      const name = m.params.name === 'approve' ? 'approve' : m.params.name.replace('_','.');
      try {
        const value=await request('mcp.call',{token,name,args:m.params.arguments || {}},24*60*60*1000);
        result={content:[{type:'text',text:JSON.stringify(value)}]};
      } catch(e:any) { result={isError:true,content:[{type:'text',text:e.message}]}; }
    } else { respond({id:m.id,error:{code:-32601,message:'Unsupported method'}}); return; }
    respond({id:m.id,result});
  } catch(e:any){respond({id:m.id,error:{code:-32603,message:e.message}});}
}
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{try{lines.push(String(chunk),m=>void handle(m));}catch{process.exit(1);}});
process.stdin.on('end',()=>changes.destroy());
