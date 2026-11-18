import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {safeError} from '../broker/remote/router.ts';

test('AUD-012 oversized collections reject before element parsing in a bounded subprocess',async()=>{
  const source=`import {z} from 'zod';let visits=0;const element=z.any().transform(v=>{visits++;return v;});
    for(const [schema,value] of [[z.array(element).max(10),Array(100000).fill(null)],[z.set(element).max(10),new Set(Array.from({length:10000},(_,i)=>i))],[z.map(element,element).max(10),new Map(Array.from({length:10000},(_,i)=>[i,i]))]]){
      const result=schema.safeParse(value);if(result.success||visits!==0)throw new Error('Oversized input traversed');
    }process.stdout.write(JSON.stringify({visits,rss:process.memoryUsage().rss}));`;
  const {stdout}=await promisify(execFile)(process.execPath,['--max-old-space-size=64','--input-type=module','-e',source],{timeout:5000,maxBuffer:4096,env:{...process.env,NODE_TEST_CONTEXT:''}});
  const result=JSON.parse(stdout);assert.equal(result.visits,0);assert.ok(result.rss<192*1024*1024);
  assert.ok(JSON.stringify(safeError({message:'private'.repeat(100000),issues:Array(10000).fill({message:'private'})})).length<512);
});
