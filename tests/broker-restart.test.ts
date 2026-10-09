import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, access, readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from '../broker/client.ts';

async function until(check:()=>Promise<boolean>,timeout=15000){const end=Date.now()+timeout;while(!await check()){if(Date.now()>end)throw new Error('Timed out waiting for the isolated broker');await new Promise(r=>setTimeout(r,50));}}
const answers=async()=>{try{return !!await request('state',{},500);}catch{return false;}};
const exists=(path:string)=>access(path).then(()=>true,()=>false);

/** An isolated profile and broker launcher. `systemd` makes the broker its service's main process. */
async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'cere-restart-')),state=join(directory,'state'),runtime=join(directory,'runtime');
  const previous={state:process.env.CERE_STATE_DIR,runtime:process.env.CERE_RUNTIME_DIR};
  process.env.CERE_STATE_DIR=state;process.env.CERE_RUNTIME_DIR=runtime;
  const env:NodeJS.ProcessEnv={...process.env,CERE_TTS_DISABLED:'1',CERE_CODEX_BIN:'/bin/false',CERE_CLAUDE_BIN:'/bin/false',CERE_ANTIGRAVITY_BIN:'/bin/false',CERE_OLLAMA_HOST:'http://127.0.0.1:9'};
  delete env.INVOCATION_ID;delete env.SYSTEMD_EXEC_PID;
  const children:ChildProcess[]=[];
  const launch=(systemd=false)=>{
    const child=systemd
      ? spawn('bash',['-c','export SYSTEMD_EXEC_PID=$$ INVOCATION_ID=cere-test; exec "$0" broker/main.ts',process.execPath],{cwd:resolve('.'),env,detached:true,stdio:'ignore'})
      : spawn(process.execPath,['broker/main.ts'],{cwd:resolve('.'),env,detached:true,stdio:'ignore'});
    children.push(child);return child;
  };
  const exited=(child:ChildProcess)=>child.exitCode!==null||child.signalCode?Promise.resolve(child.exitCode):new Promise<number|null>(r=>child.once('exit',code=>r(code)));
  t.after(async()=>{
    // Stop every broker in this runtime, including a replacement this test did not spawn.
    for(const child of children)if(child.exitCode===null&&!child.signalCode)try{process.kill(-child.pid!,'SIGKILL');}catch{}
    const pid=Number(await readFile(join(runtime,'broker.pid'),'utf8').catch(()=>''));
    if(pid>1)try{process.kill(pid,'SIGKILL');}catch{}
    if(previous.state===undefined)delete process.env.CERE_STATE_DIR;else process.env.CERE_STATE_DIR=previous.state;
    if(previous.runtime===undefined)delete process.env.CERE_RUNTIME_DIR;else process.env.CERE_RUNTIME_DIR=previous.runtime;
    await rm(directory,{recursive:true,force:true});
  });
  return {directory,state,runtime,launch,exited};
}
async function restore(){
  const backup=await request('recovery.backup',{},20000),review=await request('recovery.preview',{directory:backup.directory},20000);
  assert.match(review.kept,/API keys, paired phones/);
  return request('recovery.activate',{id:review.id,digest:review.digest},20000);
}

test('a systemd service restarts through its manager after restore; the next start activates the profile',{timeout:60000},async t=>{
  const {state,launch,exited,directory}=await fixture(t);
  const first=launch(true);await until(answers);
  await request('settings.update',{personality:'Keep this personality across restore'});
  const activation=await restore();assert.equal(activation.restarting,true);
  // A detached replacement would die with the service's control group; the manager restarts instead.
  assert.equal(await exited(first),75);
  await new Promise(r=>setTimeout(r,700));
  assert.equal(await answers(),false,'no unmanaged replacement may start under systemd');
  assert.equal(await exists(join(dirname(state),'.'+basename(state)+'-recovery.json')),true);
  launch();await until(answers);
  const snapshot=await request('state');
  assert.equal(snapshot.recoveryPending,false);assert.equal(snapshot.settings.paused,true);
  assert.equal(snapshot.settings.personality,'Keep this personality across restore');
  assert.ok((await readdir(directory)).some(name=>name.startsWith('state-previous-')));
});

test('an unmanaged broker replaces itself after restore and serves the restored profile',{timeout:60000},async t=>{
  const {launch,exited,directory}=await fixture(t);
  const first=launch();await until(answers);
  const activation=await restore();assert.equal(activation.restarting,true);
  assert.equal(await exited(first),0);
  await until(async()=>{try{const s=await request('state',{},500);return s.recoveryPending===false;}catch{return false;}});
  assert.ok((await readdir(directory)).some(name=>name.startsWith('state-previous-')));
});

test('a second broker for the same runtime leaves the running broker serving',{timeout:30000},async t=>{
  const {launch,exited}=await fixture(t);
  const first=launch();await until(answers);
  const second=launch();
  assert.equal(await exited(second),0);
  assert.equal(first.exitCode,null);assert.equal(await answers(),true);
});
