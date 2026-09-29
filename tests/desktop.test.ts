import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopAction,mediaStatus,validateAction} from '../broker/desktop.ts';
import type {Settings} from '../broker/types.ts';

// Exercise the actual process arguments and output parsing without touching
// the user's playback, screenshots or desktop.
async function fixture(t:any) {
  const dir=await mkdtemp(join(tmpdir(),'cere-desktop-test-'));
  const old={PATH:process.env.PATH,CERE_STATE_DIR:process.env.CERE_STATE_DIR,CERE_DESKTOP_FIXTURE:process.env.CERE_DESKTOP_FIXTURE};
  process.env.PATH=dir;process.env.CERE_STATE_DIR=dir;process.env.CERE_DESKTOP_FIXTURE=dir;
  t.after(async()=>{for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await rm(dir,{recursive:true,force:true});});
  await writeFile(join(dir,'state.json'),JSON.stringify({names:['org.mpris.MediaPlayer2.chromium.instance1','org.mpris.MediaPlayer2.spotify'],status:'Paused'}));
  const script=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),dir=process.env.CERE_DESKTOP_FIXTURE;
const tool=path.basename(process.argv[1]),a=process.argv.slice(2),s=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));
fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({tool,args:a})+'\\n');
const out=(type,data)=>console.log(JSON.stringify({type,data}));
if(tool==='busctl'){
  if(a.includes('ListNames'))out('as',[s.names]);
  else if(a.includes('Identity'))out('s',a[3].includes('spotify')?'Spotify':'Chromium');
  else if(a.includes('GetAll')){
    const p=a[3].includes('spotify'),b=data=>({type:'b',data});
    out('a{sv}',[{PlaybackStatus:{type:'s',data:p?s.status:'Playing'},CanControl:b(true),CanPlay:b(true),CanPause:b(true),CanGoNext:b(!s.noNext),CanGoPrevious:b(true)}]);
  }else if(a.at(-1)==='PlayPause'){s.status=s.status==='Playing'?'Paused':'Playing';fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(s));}
}else if(tool==='hyprctl')console.log(JSON.stringify([{name:'test-output',focused:true}]));
else if(tool==='grim')fs.writeFileSync(a.at(-1),'raw image');
else if(tool==='satty'){
  if(s.missingSatty)process.exit(127);
  if(!a.includes('--version')){
    if(s.editorFailure)process.exit(1);
    if(s.slow)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);
    if(!s.cancel)fs.writeFileSync(a[a.indexOf('--output-filename')+1],'edited image');
  }
}
`;
  await writeFile(join(dir,'fake.cjs'),script,{mode:0o755});
  for(const name of ['busctl','hyprctl','grim','satty'])await symlink(join(dir,'fake.cjs'),join(dir,name));
  return {dir,async set(patch:any){const path=join(dir,'state.json');await writeFile(path,JSON.stringify({...JSON.parse(await readFile(path,'utf8')),...patch}));},
    async calls(){return(await readFile(join(dir,'calls.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));}};
}
test('media targets Spotify ahead of Chromium, including when Spotify is paused',async t=>{
  const f=await fixture(t);
  const state=await mediaStatus();assert.equal('name' in state&&state.name,'Spotify');
  for(const command of ['PlayPause','Next','Previous','Stop'])await desktopAction('media.control',{command},{} as Settings);
  const commands=(await f.calls()).filter(c=>c.tool==='busctl'&&['PlayPause','Next','Previous','Stop'].includes(c.args.at(-1)));
  assert.equal(commands.length,4);assert.ok(commands.every(c=>c.args[3]==='org.mpris.MediaPlayer2.spotify'));
  const after=await mediaStatus();assert.equal('status' in after&&after.status,'Playing');
});
test('media respects an explicit target, disappeared players and disabled controls',async t=>{
  const f=await fixture(t);
  await desktopAction('media.control',{command:'Stop',player:'org.mpris.MediaPlayer2.chromium.instance1'},{} as Settings);
  assert.equal((await f.calls()).at(-1).args[3],'org.mpris.MediaPlayer2.chromium.instance1');
  await f.set({noNext:true});await assert.rejects(desktopAction('media.control',{command:'Next'},{} as Settings),/cannot perform/);
  await f.set({names:['org.mpris.MediaPlayer2.chromium.instance1']});
  await assert.rejects(desktopAction('media.control',{command:'PlayPause',player:'org.mpris.MediaPlayer2.spotify'},{} as Settings),/no longer available/);
  await f.set({names:[]});assert.deepEqual(await mediaStatus(),{available:false});
  await assert.rejects(desktopAction('media.control',{command:'PlayPause'},{} as Settings),/No media player/);
  assert.throws(()=>validateAction('media.control',{command:'Stop',player:'--system'}),/Invalid media player/);
});
test('capture opens Satty directly and returns only its edited output',async t=>{
  const f=await fixture(t);
  const result=await desktopAction('screenshot.capture',{},{} as Settings);
  assert.ok(typeof result==='object'&&'path' in result&&result.path);
  assert.equal(await readFile(result.path,'utf8'),'edited image');
  const calls=await f.calls(),editor=calls.find(c=>c.tool==='satty'&&c.args.includes('--filename'));
  assert.ok(editor);assert.equal(editor.args[editor.args.indexOf('--initial-tool')+1],'crop');
  assert.ok(calls.find(c=>c.tool==='grim'&&c.args.includes('test-output')));
  assert.equal((await readdir(join(f.dir,'captures'))).length,1);
});
test('capture cancellation and editor failure clean up raw images and allow retry',async t=>{
  const f=await fixture(t);await f.set({cancel:true});
  assert.deepEqual(await desktopAction('screenshot.capture',{},{} as Settings),{cancelled:true,message:'Capture cancelled'});
  assert.deepEqual(await readdir(join(f.dir,'captures')),[]);
  await f.set({cancel:false,editorFailure:true});
  await assert.rejects(desktopAction('screenshot.capture',{},{} as Settings));
  assert.deepEqual(await readdir(join(f.dir,'captures')),[]);
  await f.set({editorFailure:false});const retry=await desktopAction('screenshot.capture',{},{} as Settings);
  assert.ok(typeof retry==='object'&&'path' in retry&&retry.path);
});
test('missing Satty is actionable and duplicate capture requests cannot open competing editors',async t=>{
  const f=await fixture(t);await f.set({missingSatty:true});
  await assert.rejects(desktopAction('screenshot.capture',{},{} as Settings),/Install the satty package/);
  await f.set({missingSatty:false,slow:true});
  const first=desktopAction('screenshot.capture',{},{} as Settings);
  await assert.rejects(desktopAction('screenshot.capture',{},{} as Settings),/already open/);
  const result=await first;assert.ok(typeof result==='object'&&'path' in result&&result.path);
});
