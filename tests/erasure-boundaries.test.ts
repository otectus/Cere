import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,writeFile,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../broker/store.ts';
import { erasureMatcher } from '../broker/memory.ts';
import { eraseWorkingCopies } from '../broker/working-erasure.ts';
import type { Session } from '../broker/types.ts';

test('erasure text matching preserves unrelated words while finding copied passages',()=>{
  const short=erasureMatcher({texts:['yes']});
  assert.equal(short('yes'),true);
  assert.equal(short('Review yesterday’s independent work'),false);
  assert.equal(short('The answer is yes, pending review.'),false);

  const passage=erasureMatcher({texts:['the orchid release phrase']});
  assert.equal(passage('Notes: the orchid release phrase. Do not repeat it.'),true);
  assert.equal(passage('Notes: the orchid release phrasebook is obsolete.'),false);
  assert.equal(erasureMatcher({texts:['Caf\u00e9 launch']})('The Cafe\u0301 launch remains private.'),true);
});

test('working-copy erasure uses source identities and removes actual copied files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-erasure-boundaries-'));
  const store=new Store(directory);
  try{
    const phrase='the orchid release phrase',session:Session={id:'session',provider:'codex',nativeId:null,title:'Yesterday plan',cwd:directory,mode:'managed',status:'idle',created:1,updated:1,draft:'Notes: '+phrase,scroll:0,draftAttachments:[],model:''};
    store.saveSession(session);
    const attachmentPath=join(directory,'draft-attachments','source');
    await mkdir(join(directory,'draft-attachments'),{recursive:true});await writeFile(attachmentPath,'Copied: '+phrase);
    const asset={id:'asset',path:attachmentPath,name:'source.txt',kind:'text' as const,mime:'text/plain',size:phrase.length,sha256:'unused'};
    session.draftAttachments=[asset];store.saveSession(session);store.set('attachment:asset',{sessionId:session.id,asset});
    store.set('submission:'+session.id,{turnId:'source-turn',text:'Paraphrased private source',attachmentIds:['asset']});
    store.set('capsule:'+session.cwd,{goal:'Paraphrased goal',decisions:['Private decision'],constraints:[],questions:[],nextSteps:[],sources:[{messageId:'source-message'}]});
    store.set('workflow:results',[{id:'remove',sessionId:session.id,messageId:'source-message'},{id:'keep',sessionId:session.id,messageId:'other'}]);

    eraseWorkingCopies(store,session,erasureMatcher({texts:[phrase],message_ids:['source-message'],turn_ids:['source-turn']}));

    const saved=store.session(session.id);
    assert.equal(saved.title,'Yesterday plan');
    assert.equal(saved.draft,'[Content removed by memory erasure]');
    assert.deepEqual(saved.draftAttachments,[]);
    await assert.rejects(access(attachmentPath));
    assert.equal(store.get<any>('submission:'+session.id,null).text,'[Content removed by memory erasure]');
    const capsule=store.get<any>('capsule:'+session.cwd,null);
    assert.equal(capsule.goal,'[Content removed by memory erasure]');assert.deepEqual(capsule.decisions,[]);assert.deepEqual(capsule.sources,[]);
    assert.deepEqual(store.get<any[]>('workflow:results',[]).map(row=>row.id),['keep']);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
