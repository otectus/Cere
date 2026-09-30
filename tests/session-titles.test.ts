import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { Hooks } from '../broker/providers.ts';

async function fixture(t: any) {
  const directory=await mkdtemp(join(tmpdir(),'cere-titles-'));
  let hooks: Hooks | undefined;
  const core=new Core(new Store(directory),(_session,value)=>{
    hooks=value;
    return {
      async send(_text,_images,options){options?.onAccepted?.();},
      async interrupt(){value.event({type:'interrupted'});},
      async close(){},
    };
  });
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  return {core,directory,hooks:()=>hooks!};
}

test('explicit and fallback session titles stay stable across local and accepted sends',async t=>{
  const {core,directory}=await fixture(t);
  const named=await core.create({provider:'codex',cwd:directory,trusted:true,title:'  Release notes  '});
  assert.equal(named.title,'Release notes');
  await core.send({id:named.id,text:'This first message must not replace the title'});
  assert.equal(core.store.session(named.id).title,'Release notes');

  const untitled=await core.create({provider:'codex',cwd:directory,trusted:true,title:'   '});
  assert.equal(untitled.title,'Untitled session');
  let accepted=false;
  await core.sendTurn({id:untitled.id,text:'Remote first message'},undefined,undefined,()=>{accepted=true;});
  assert.equal(accepted,true);
  assert.equal(core.store.session(untitled.id).title,'Untitled session');
});

test('imported titles and explicit renames are trimmed, bounded, and never empty',async t=>{
  const {core,directory}=await fixture(t);
  const imported=await core.create({provider:'codex',cwd:directory,trusted:true,nativeId:'imported-1',handoffConfirmed:true,title:'  Imported provider title  '});
  assert.equal(imported.title,'Imported provider title');

  const renamed=await core.rpc('session.rename',{id:imported.id,title:`  ${'x'.repeat(120)}  `});
  assert.equal(renamed.title,'x'.repeat(100));
  const reset=await core.rpc('session.rename',{id:imported.id,title:'\n\t'});
  assert.equal(reset.title,'Untitled session');
});
