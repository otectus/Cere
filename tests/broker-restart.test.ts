import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, access, readdir, readFile, writeFile } from 'node:fs/promises';
import { Store } from '../broker/store.ts';
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
  const output={text:''};
  const launch=(systemd=false)=>{
    const child=systemd
      ? spawn('bash',['-c','export SYSTEMD_EXEC_PID=$$ INVOCATION_ID=cere-test; exec "$0" broker/main.ts',process.execPath],{cwd:resolve('.'),env,detached:true,stdio:'ignore'})
      : spawn(process.execPath,['broker/main.ts'],{cwd:resolve('.'),env,detached:true,stdio:['ignore','pipe','pipe']});
    child.stdout?.on('data',chunk=>{output.text+=chunk;});child.stderr?.on('data',chunk=>{output.text+=chunk;});
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
  return {directory,state,runtime,launch,exited,output};
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

test('W04 SIGTERM during running work ends within the deadline, records the shutdown and never reaches a closed store',{timeout:60000},async t=>{
  const {state,directory,launch,exited,output}=await fixture(t);
  const project=join(directory,'project');await mkdir(project);const marker=join(project,'started');
  const script={id:'long-fixture',name:'Long fixture',executable:'/bin/sh',args:['-c','printf started > "$1"; sleep 30','fixture',marker],cwd:project,timeout:35000};
  const store=new Store(state);store.set('settings',{profile:'scoped',categories:['scripts'],scripts:[script],memory:{enabled:false}});store.close();
  const broker=launch();await until(answers);
  // A local change that is still running when the broker is told to stop.
  const running=request('action.run',{name:'script.run',args:{id:script.id},expectedScript:script},40000).then(()=>'completed',(error:Error)=>error.message);
  await until(()=>exists(marker));
  const stopped=Date.now();process.kill(broker.pid!,'SIGTERM');
  assert.equal(await exited(broker),0);
  assert.ok(Date.now()-stopped<12000,'shutdown is bounded by its deadline');
  assert.notEqual(await running,'completed','the interrupted action is not reported as completed');
  assert.doesNotMatch(output.text,/database is not open|database connection is not open/i);
  const record=JSON.parse(await readFile(join(state,'last-shutdown.json'),'utf8'));
  assert.equal(typeof record.confirmed,'boolean');assert.ok(record.at>=stopped);
  // The next start serves again, and Health reads the record.
  launch();await until(answers);
  const report=await request('health.inspect',{},10000);
  assert.equal(report.previousShutdown?.at,record.at);
});

test('W04 a socket left by a killed broker is replaced; a non-socket file at the path stops startup without removing it',{timeout:60000},async t=>{
  const {runtime,launch,exited}=await fixture(t);
  await mkdir(runtime,{recursive:true,mode:0o700});
  // A process that dies without cleaning up leaves its listening socket file behind.
  const holder=spawn(process.execPath,['-e',`require('node:net').createServer().listen(${JSON.stringify(join(runtime,'broker.sock'))},()=>process.stdout.write('ready'))`],{stdio:['ignore','pipe','ignore']});
  await new Promise(r=>holder.stdout!.once('data',r));holder.kill('SIGKILL');await new Promise(r=>holder.once('exit',r));
  assert.equal(await exists(join(runtime,'broker.sock')),true,'the stale socket file remains');
  const first=launch();await until(answers);
  process.kill(first.pid!,'SIGTERM');assert.equal(await exited(first),0);
  assert.equal(await exists(join(runtime,'broker.sock')),false,'a clean shutdown removes its socket');
  await writeFile(join(runtime,'broker.sock'),'not a socket');
  const refused=launch();
  assert.notEqual(await exited(refused),0,'an unexpected file at the socket path is not replaced');
  assert.equal(await readFile(join(runtime,'broker.sock'),'utf8'),'not a socket');
});
