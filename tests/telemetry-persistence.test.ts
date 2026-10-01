import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { TelemetryService } from '../broker/telemetry/service.ts';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

async function until(check:()=>boolean){const end=Date.now()+7000;while(!check()){if(Date.now()>end)throw new Error('Timed out');await new Promise(r=>setTimeout(r,10));}}
test('Core outgoing context stays out of transcripts, memory inputs, recovery backups and diagnostic files, including echoed HTTP errors',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'cere-telemetry-persistence-')),root=join(parent,'project'),directory=join(parent,'state'),runtime=join(parent,'runtime');await mkdir(root);
  let reject=false;const bodies:any[]=[],observed:string[]=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
    if(req.url==='/api/tags')res.end(JSON.stringify({models:[{name:'fixture',model:'fixture'}]}));
    else if(req.url==='/api/show')res.end(JSON.stringify({capabilities:['completion'],model_info:{'general.architecture':'llama','llama.context_length':8192}}));
    else if(req.url==='/api/chat'){bodies.push(body);if(reject){res.statusCode=400;res.end(JSON.stringify({error:JSON.stringify(body)}));}else res.end(JSON.stringify({message:{role:'assistant',content:'Ordinary reply'},done:true})+'\n');}
    else res.end('{}');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const host='http://127.0.0.1:'+(server.address() as any).port;
  const store=new Store(directory);store.set('settings',{ollama:{host,model:''}});const core=new Core(store);
  t.after(async()=>{if(!core.closed)await core.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(parent,{recursive:true,force:true});});
  await core.telemetry.close();core.telemetry=new TelemetryService(()=>{},runtime);
  await core.updateSettings({telemetry:{enabled:true,roots:[root],commands:true}});await until(()=>core.telemetry.status.listener==='listening');
  await new Promise<void>((resolve,reject)=>{const c=net.createConnection(join(runtime,'telemetry.sock'));c.on('error',reject);c.on('data',()=>{});c.on('connect',()=>c.end(JSON.stringify({v:1,type:'command',session:randomUUID(),seq:1,pid:2147483647,hook_version:1,ts:new Date().toISOString(),cwd:root,status:0,cmd:'TELEMETRY_PRIVATE_SENTINEL'})+'\n'));c.on('close',resolve);});
  await until(()=>core.telemetry.status.sessions===1);
  await core.refreshProviderModels('ollama');const session=await core.create({provider:'ollama',model:'fixture',cwd:root});
  core.settings.memory.enabled=true;core.memory.active=()=>true;
  core.memory.context=async(_s,text)=>{observed.push(text);return '';};core.memory.capture=async(_s,text,answer)=>{observed.push(text,answer);return{outcome:'captured'};};
  await core.send({id:session.id,text:'Hello'});await until(()=>core.store.session(session.id).status==='idle');core.flush();
  assert.match(JSON.stringify(bodies[0]),/TELEMETRY_PRIVATE_SENTINEL/);assert.doesNotMatch(JSON.stringify(bodies[0].messages.filter((m:any)=>m.role==='system')),/TELEMETRY_PRIVATE_SENTINEL/);
  assert.deepEqual(observed,['Hello','Hello','Ordinary reply']);
  reject=true;await core.send({id:session.id,text:'Trigger fixture rejection'});await until(()=>core.store.session(session.id).status==='error');core.flush();
  assert.doesNotMatch(JSON.stringify(store.messages(session.id)),/TELEMETRY_PRIVATE_SENTINEL|cere_telemetry/);
  assert.doesNotMatch(JSON.stringify(store.get('ollama:'+session.id,[])),/TELEMETRY_PRIVATE_SENTINEL|cere_telemetry/);
  const backup=await core.rpc('recovery.backup',{includeContent:true});const preview=core.diagnostics.preview();await core.diagnostics.export(preview.id,preview.digest);
  assert.doesNotMatch(await readFile(join(backup.directory,'profile.json'),'utf8'),/TELEMETRY_PRIVATE_SENTINEL|cere_telemetry/);
  await core.close();
  async function inspect(path:string):Promise<void>{for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await inspect(file);else if(entry.isFile())assert.equal((await readFile(file)).includes(Buffer.from('TELEMETRY_PRIVATE_SENTINEL')),false,entry.name);}}
  await inspect(directory);
});
