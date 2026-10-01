import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpStatusError, withHttpRetry } from '../broker/http-retry.ts';

for(const status of [429,500,502,503,504])test(`HTTP ${status}: retries three times with exponential backoff and jitter`,async()=>{
  let calls=0;const waits:number[]=[],logs:string[]=[],failure=new HttpStatusError(status,'private prompt/key');
  await assert.rejects(withHttpRetry(async()=>{calls++;throw failure;},{random:()=>.5,sleep:async ms=>{waits.push(ms);},log:s=>logs.push(s)}),error=>error===failure);
  assert.equal(calls,4);assert.deepEqual(waits,[1125,2250,4500]);
  assert.equal(logs.length,3);assert.match(logs[2],new RegExp(`HTTP ${status}; retry 3/3 in 4500ms`));
  assert.ok(!logs.join('').includes('private'));
});
for(const status of [400,401,403,404,408,409,501])test(`HTTP ${status}: fails immediately with the original error`,async()=>{
  let calls=0;const failure=new HttpStatusError(status,'original');
  await assert.rejects(withHttpRetry(async()=>{calls++;throw failure;},{sleep:async()=>assert.fail('must not wait'),log:()=>assert.fail('must not log')}),error=>error===failure);
  assert.equal(calls,1);
});
test('SDK-style status and Retry-After headers are supported, including HTTP dates',async()=>{
  const waits:number[]=[],notices:any[]=[];let calls=0;
  const result=await withHttpRetry(async attempt=>{
    assert.equal(attempt,calls++);
    if(attempt===0)throw {response:{status:429,headers:{'retry-after':'3'}}};
    if(attempt===1)throw {status:503,headers:new Headers({'retry-after':'Wed, 30 Sep 2026 12:00:05 GMT'})};
    return 'done';
  },{now:()=>Date.parse('2026-09-30T12:00:00Z'),random:()=>0,sleep:async ms=>{waits.push(ms);},log:()=>{},onRetry:n=>notices.push(n)});
  assert.equal(result,'done');assert.deepEqual(waits,[3000,5000]);assert.equal(notices[1].attempt,2);
});
test('unreasonably long Retry-After fails without retrying earlier than requested',async()=>{
  const failure=new HttpStatusError(429,'rate limited','120');let calls=0;
  await assert.rejects(withHttpRetry(async()=>{calls++;throw failure;},{sleep:async()=>assert.fail('must not wait')}),error=>error===failure);
  assert.equal(calls,1);
});
test('malformed Retry-After falls back to normal backoff and jitter stays capped',async()=>{
  let calls=0;const waits:number[]=[];
  await withHttpRetry(async()=>{if(calls++<3)throw new HttpStatusError(503,'busy','-1');return true;},
    {maxDelayMs:2000,random:()=>1,sleep:async ms=>{waits.push(ms);},log:()=>{}});
  assert.deepEqual(waits,[1250,2000,2000]);
});
test('transport errors and cancellation are never retried',async()=>{
  for(const failure of [new TypeError('fetch failed'),new DOMException('stopped','AbortError'),Object.assign(new Error('timeout'),{name:'TimeoutError',status:503})]){
    let calls=0;await assert.rejects(withHttpRetry(async()=>{calls++;throw failure;},{sleep:async()=>assert.fail('must not wait')}),error=>error===failure);assert.equal(calls,1);
  }
  const controller=new AbortController();controller.abort(new Error('already stopped'));
  await assert.rejects(withHttpRetry(async()=>assert.fail('must not run'),{signal:controller.signal}),/already stopped/);
});
test('Stop cancels a real backoff wait promptly and no further attempt starts',async()=>{
  const controller=new AbortController();let calls=0,waiting!:()=>void;const ready=new Promise<void>(resolve=>waiting=resolve);
  const task=withHttpRetry(async()=>{calls++;throw new HttpStatusError(503,'busy');},{signal:controller.signal,initialDelayMs:10000,onRetry:waiting,log:()=>{}});
  await ready;controller.abort(new Error('stop now'));
  await assert.rejects(task,/stop now/);assert.equal(calls,1);
});
