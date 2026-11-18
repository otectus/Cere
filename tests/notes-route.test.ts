import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Core} from '../broker/core.ts';
import {Store} from '../broker/store.ts';

test('AUD-004 notes authority follows the saved host and fresh alias route, including outgoing results',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-notes-route-'));
  let cloud=false;
  async function server(remote:()=>boolean){const instance=createServer((req,res)=>{res.setHeader('content-type','application/json');const model={name:'alias',model:'alias',capabilities:['completion','tools'],...(remote()?{remote_host:'https://cloud.example'}:{})};res.end(JSON.stringify(req.url==='/api/tags'?{models:[model]}:model));});await new Promise<void>(r=>instance.listen(0,'127.0.0.1',r));t.after(()=>{instance.closeAllConnections();instance.close();});return 'http://127.0.0.1:'+(instance.address() as any).port;}
  const local=await server(()=>cloud),remote=await server(()=>true),core=new Core(new Store(join(directory,'state')));
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  const vault=join(directory,'notes');await mkdir(vault);await writeFile(join(vault,'private.md'),'Private note text');
  await core.updateSettings({notesVault:{enabled:true,path:vault,allowCloud:false},ollama:{host:local}});
  const session=await core.create({provider:'ollama',cwd:directory,model:'alias',host:local,tools:true,trusted:true});
  // The global catalog's same-name local alias is never evidence for a different saved host.
  core.capabilities.ollama={models:[{id:'alias',cloud:false}]};
  core.updateSession(session.id,{ollama:{host:remote,tools:true}});
  await core.refreshNoteRoute(session.id,new AbortController().signal);assert.equal(core.notesToolsFor(session.id).length,0);
  await assert.rejects(core.notesCall(session.id,'notes_read',{path:'private.md'},new AbortController().signal),/access/);
  core.updateSession(session.id,{ollama:{host:local,tools:true}});
  await core.refreshNoteRoute(session.id,new AbortController().signal);assert.ok(core.notesToolsFor(session.id).length);
  assert.match(JSON.stringify(await core.notesCall(session.id,'notes_read',{path:'private.md'},new AbortController().signal)),/Private note text/);
  const adapter=core.ensureAdapter(core.store.session(session.id)) as any;
  cloud=true;
  await assert.rejects(adapter.context.authorizePrivate(new AbortController().signal),/Notes access changed/);
  await core.updateSettings({notesVault:{allowCloud:true}});
  assert.match(JSON.stringify(await core.notesCall(session.id,'notes_read',{path:'private.md'},new AbortController().signal)),/Private note text/);
});
