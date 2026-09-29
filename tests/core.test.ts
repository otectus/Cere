import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { JsonLines } from '../broker/wire.ts';
import { validateAction } from '../broker/desktop.ts';
import type { Hooks } from '../broker/providers.ts';
import { defaultPersonality, personalityMaxLength } from '../broker/personality.ts';

async function setup(t: any) {
  const directory=await mkdtemp(join(tmpdir(),'cere-test-'));
  let hooks: Hooks | undefined, sends=0;
  const core=new Core(new Store(directory),(_s,h)=>{hooks=h;return{async send(){sends++},async interrupt(){h.event({type:'complete',text:'interrupted'})},async close(){}}});
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true})});
  const session=await core.create({provider:'codex',cwd:directory,trusted:true});
  return{core,session,directory,getHooks:()=>hooks!,sends:()=>sends};
}
test('personality defaults migrate, edits persist, and invalid patches are atomic',async t=>{
  const {core,directory,session,getHooks}=await setup(t);
  assert.equal(core.settings.personality,defaultPersonality);
  core.store.set('settings',{quiet:true});
  assert.equal(core.store.settings().personality,defaultPersonality);
  assert.equal(core.snapshot().personality.defaultText,defaultPersonality);
  const custom='  Be calm, concise and kind.\nUse plain language. ✦  ';
  await core.updateSettings({personality:custom});
  await core.send({id:session.id,text:'hello'});
  assert.equal(getHooks().personality?.(),custom);
  for(const personality of [42,{},[],true,'x'.repeat(personalityMaxLength+1),'bad\0text']){
    await assert.rejects(core.updateSettings({personality,quiet:true}),/personality text/);
    assert.equal(core.settings.personality,custom);assert.equal(core.settings.quiet,false);
    assert.equal(core.store.settings().personality,custom);
  }
  await assert.rejects(core.updateSettings({personality:'Should not save',scale:99}));
  assert.equal(core.settings.personality,custom);
  await core.updateSettings({personality:''});assert.equal(getHooks().personality?.(),'');
  const restored=new Store(directory);
  try { assert.equal(restored.settings().personality,''); }
  finally { restored.close(); }
  await core.updateSettings({personality:custom});assert.equal(core.store.settings().personality,custom);
  await core.updateSettings({personality:null});assert.equal(core.settings.personality,defaultPersonality);
});
test('expressive settings default, validate atomically and persist',async t=>{
  const {core,directory}=await setup(t);
  assert.equal(core.settings.motionIntensity,.7);assert.equal(core.settings.expressiveCues,true);
  core.store.set('settings',{quiet:true});
  assert.equal(core.store.settings().motionIntensity,.7);assert.equal(core.store.settings().expressiveCues,true);
  for(const motionIntensity of ['.5',NaN,-.01,1.01,Infinity]){
    await assert.rejects(core.updateSettings({motionIntensity,quiet:true}),/Motion intensity/);
    assert.equal(core.settings.motionIntensity,.7);assert.equal(core.settings.quiet,false);
  }
  for(const expressiveCues of ['true',1,null]){
    await assert.rejects(core.updateSettings({expressiveCues,motionIntensity:.2}),/Invalid expressiveCues/);
    assert.equal(core.settings.motionIntensity,.7);assert.equal(core.settings.expressiveCues,true);
  }
  await core.updateSettings({motionIntensity:0,expressiveCues:false});
  const reopened=new Store(directory);
  try{assert.equal(reopened.settings().motionIntensity,0);assert.equal(reopened.settings().expressiveCues,false);}
  finally{reopened.close();}
  await core.updateSettings({motionIntensity:1,expressiveCues:true});
});
test('JSON lines preserves partial and Unicode messages and rejects oversized input',()=>{
  const parser=new JsonLines(),received:any[]=[];
  parser.push('{"text":"Ce',m=>received.push(m));parser.push('re ✦"}\n\n{"n":2}\n',m=>received.push(m));
  assert.deepEqual(received,[{text:'Cere ✦'},{n:2}]);assert.throws(()=>parser.push('x'.repeat(8*1024*1024+1),()=>{}),/exceeds/);
});
test('animation previews relay to the pet and desktop actions emit a reaction',async t=>{
  const {core,session}=await setup(t), events:any[]=[];
  core.on('ui',event=>events.push(event));
  await core.rpc('ui.animate',{name:'stretch'});
  assert.deepEqual(events.pop(),{command:'animate',name:'stretch'});
  await assert.rejects(core.rpc('ui.animate',{name:'../invalid'}),/Invalid animation/);
  await core.rpc('ui.panel',{owner:'ui',visible:true});
  assert.equal(core.snapshot().panels.ui,true);
  assert.deepEqual(events.pop(),{command:'panel',owner:'ui',visible:true});
  await assert.rejects(core.rpc('ui.panel',{owner:'invalid',visible:true}),/Invalid panel owner/);
  await core.rpc('ui.attention',{owner:'ui',sessionId:session.id,listening:true});
  assert.deepEqual(events.pop(),{command:'attention',owner:'ui',sessionId:session.id,listening:true});
  assert.deepEqual(core.snapshot().attention.ui,{owner:'ui',sessionId:session.id,listening:true});
  await core.rpc('ui.panel',{owner:'ui',visible:false});
  assert.deepEqual(core.snapshot().attention.ui,{owner:'ui',sessionId:session.id,listening:false});
  assert.deepEqual(events.slice(-2),[
    {command:'attention',owner:'ui',sessionId:session.id,listening:false},
    {command:'panel',owner:'ui',visible:false},
  ]);
  await core.rpc('ui.attention',{owner:'overlay',sessionId:'',listening:false});
  assert.deepEqual(events.pop(),{command:'attention',owner:'overlay',sessionId:'',listening:false});
  await assert.rejects(core.rpc('ui.attention',{owner:'pet',sessionId:session.id,listening:true}),/owner/);
  await assert.rejects(core.rpc('ui.attention',{owner:'ui',sessionId:'missing',listening:true}),/no longer exists/);
  await assert.rejects(core.rpc('ui.attention',{owner:'ui',sessionId:session.id,listening:1}),/state/);
  await core.action('timer.start',{minutes:1,label:'Animation test'});
  assert.deepEqual(events.pop(),{command:'animate',name:'success'});
});
test('project trust, absolute paths and external handoff are required',async t=>{
  const{core,directory}=await setup(t);
  await assert.rejects(core.create({provider:'claude',cwd:directory}),/trust/);
  await assert.rejects(core.create({provider:'claude',cwd:'.',trusted:true}),/absolute/);
  await assert.rejects(core.create({provider:'claude',cwd:directory,trusted:true,nativeId:'test'}),/Stop the external/);
});
test('sessions persist only provider-advertised model and effort selections',async t=>{
  const{core,directory}=await setup(t);
  core.capabilities.codex={available:true,modelsStatus:'ready',models:[{id:'gpt-test',displayName:'GPT Test',description:'',isDefault:true,defaultEffort:'low',efforts:[{id:'low',displayName:'Low'},{id:'high',displayName:'High'}]}]};
  const session=await core.create({provider:'codex',cwd:directory,trusted:true,model:'gpt-test',effort:'high'});
  assert.equal(session.model,'gpt-test');assert.equal(session.effort,'high');
  assert.equal(core.store.session(session.id).effort,'high');
  await assert.rejects(core.create({provider:'codex',cwd:directory,trusted:true,model:'missing'}),/available/);
  await assert.rejects(core.create({provider:'codex',cwd:directory,trusted:true,model:'gpt-test',effort:'ultra'}),/effort/);
});
test('only one turn writes to a managed session and interruption permits another turn',async t=>{
  const{core,session,sends}=await setup(t);
  await core.send({id:session.id,text:'hello'});
  await assert.rejects(core.send({id:session.id,text:'duplicate'}),/busy/);
  assert.equal(sends(),1);await core.stop(session.id);assert.equal(core.store.session(session.id).status,'interrupted');
  await core.send({id:session.id,text:'continue'});assert.equal(sends(),2);
});
test('simultaneous submissions cannot race across attachment validation',async t=>{
  const{core,session,sends}=await setup(t);
  const result=await Promise.allSettled([core.send({id:session.id,text:'first'}),core.send({id:session.id,text:'second'})]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(sends(),1);
});
test('streaming messages reconcile final text without duplicate replies',async t=>{
  const{core,session,getHooks}=await setup(t);await core.send({id:session.id,text:'hello'});
  getHooks().event({type:'delta',id:'a',text:'Hel'});getHooks().event({type:'delta',id:'a',text:'lo'});
  getHooks().event({type:'message',id:'a',text:'Hello!'});getHooks().event({type:'complete'});
  const replies=core.store.messages(session.id).filter(m=>m.role==='assistant');assert.equal(replies.length,1);assert.equal(replies[0].text,'Hello!');
});
test('session activity follows observed turn phases and terminal notices preserve outcomes',async t=>{
  const{core,session,getHooks}=await setup(t),notices:any[]=[];core.on('notice',notice=>notices.push(notice));
  await core.send({id:session.id,text:'hello'});assert.equal(core.snapshot().sessions.find(s=>s.id===session.id)?.activity,'thinking');
  let states=0;core.on('state',()=>states++);getHooks().event({type:'activity',text:'thinking'});assert.equal(states,0);
  getHooks().event({type:'tool',id:'tool',text:'command started'});assert.equal(core.store.session(session.id).activity,'working');
  getHooks().event({type:'activity',text:'thinking'});assert.equal(core.store.session(session.id).activity,'thinking');
  getHooks().event({type:'delta',id:'reply',text:'Hi'});assert.equal(core.store.session(session.id).activity,'speaking');
  const pending=core.approval(session.id,{kind:'provider',title:'Allow?',detail:'',choices:['allow','deny']});
  assert.equal(core.store.session(session.id).status,'waiting');assert.equal(core.store.session(session.id).activity,undefined);
  const approval=core.snapshot().approvals[0];core.answer({id:approval.id,choice:'allow'});await pending;
  assert.equal(core.store.session(session.id).activity,'thinking');
  getHooks().event({type:'complete',text:'interrupted'});
  assert.equal(core.store.session(session.id).status,'interrupted');assert.equal(core.store.session(session.id).activity,undefined);
  assert.equal(notices.at(-1).kind,'interrupted');assert.notEqual(notices.at(-1).text,'Task complete');
  getHooks().event({type:'delta',id:'late',text:'Too late'});getHooks().event({type:'complete'});
  getHooks().event({type:'activity',text:'thinking'});
  assert.equal(core.store.session(session.id).status,'interrupted');assert.equal(core.store.session(session.id).activity,undefined);
  assert.ok(!core.store.messages(session.id).some(message=>message.text==='Too late'));assert.equal(notices.at(-1).kind,'interrupted');
  await core.send({id:session.id,text:'retry'});core.event(session.id,{type:'error',text:'Provider failed'});
  assert.equal(core.store.session(session.id).status,'error');assert.deepEqual(notices.at(-1),{kind:'error',sessionId:session.id,text:'Provider failed'});
  core.event(session.id,{type:'complete'});
  assert.equal(core.store.session(session.id).status,'error');assert.equal(notices.at(-1).kind,'error');
  await core.send({id:session.id,text:'retry again'});core.updateSession(session.id,{status:'stopping'});core.event(session.id,{type:'complete',text:'completed'});
  assert.equal(core.store.session(session.id).status,'interrupted');assert.equal(notices.at(-1).kind,'interrupted');
  await core.send({id:session.id,text:'one more'});core.event(session.id,{type:'complete'});core.event(session.id,{type:'error',text:'Adapter disconnected'});
  assert.equal(core.store.session(session.id).status,'error');assert.equal(notices.at(-1).text,'Adapter disconnected');
});
test('approvals cannot be replayed after completion or answered twice',async t=>{
  const{core,session}=await setup(t);
  const promise=core.approval(session.id,{kind:'provider',title:'Allow?',detail:'test',choices:['allow','deny']});
  const approval=core.snapshot().approvals[0];core.answer({id:approval.id,choice:'deny'});assert.equal((await promise).choice,'deny');assert.throws(()=>core.answer({id:approval.id,choice:'allow'}),/already ended/);
  const stale=core.approval(session.id,{kind:'provider',title:'Allow?',detail:'test',choices:['allow','deny']});
  core.event(session.id,{type:'complete'});assert.equal((await stale).choice,'deny');assert.equal(core.approvals.size,0);
});
test('disabled and revoked desktop capabilities fail before side effects',async t=>{
  const{core,session}=await setup(t);
  await assert.rejects(core.action('timer.start',{minutes:1,label:'test'},session.id),/disabled/);
  await core.updateSettings({categories:['timers']});await core.action('timer.start',{minutes:1,label:'test'},session.id);assert.equal(core.store.timers().length,1);
  await core.updateSettings({paused:true});await assert.rejects(core.action('timer.start',{minutes:1,label:'second'},session.id),/disabled/);assert.equal(core.store.timers().length,1);
});
test('revoking a capability while approval is open prevents execution',async t=>{
  const{core,session}=await setup(t);await core.updateSettings({categories:['files']});
  const action=core.action('files.open',{path:'/tmp'},session.id);const approval=core.snapshot().approvals[0];
  await core.updateSettings({categories:[]});core.answer({id:approval.id,choice:'allow'});await assert.rejects(action,/revoked/);
});
test('broad grants are bounded to a project and expiration',async t=>{
  const{core,directory}=await setup(t);await core.updateSettings({profile:'broad',categories:['files']});
  await assert.rejects(core.updateSettings({grants:[{category:'files',cwd:directory,expires:Date.now()+48*3600000}]}),/expiry/);
  await assert.rejects(core.updateSettings({grants:[{category:'files',cwd:'relative',expires:Date.now()+3600000}]}),/Grants/);
});
test('action validation prevents argument injection',()=>{
  assert.throws(()=>validateAction('windows.focus',{address:'0x12; exec evil'}),/address/);
  assert.throws(()=>validateAction('workspace.switch',{workspace:'1,exec evil'}),/workspace/);
  assert.throws(()=>validateAction('audio.volume',{percent:101}),/percent/);
  assert.throws(()=>validateAction('files.open',{path:'https://example.com'}),/absolute/);
  assert.throws(()=>validateAction('audio.mute',{command:'anything'}),/Unexpected/);
});
test('database files are private and a broker restart never replays work',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-recovery-'));let executions=0;
  const first=new Core(new Store(directory),()=>({async send(){executions++},async interrupt(){},async close(){}}));
  const s=await first.create({provider:'codex',cwd:directory,trusted:true});await first.send({id:s.id,text:'once'});await first.close();
  const recovered=new Core(new Store(directory));t.after(async()=>{await recovered.close();await rm(directory,{recursive:true,force:true})});
  assert.equal(recovered.store.session(s.id).status,'interrupted');assert.equal(executions,1);
  assert.equal((await stat(join(directory,'cere.sqlite'))).mode&0o777,0o600);
});

test('permission bypasses default off, validate strictly and persist independently', async t => {
  const { core, directory } = await setup(t);
  assert.equal(core.settings.bypassCliPermissions, false);
  assert.equal(core.settings.bypassComputerPermissions, false);
  for (const key of ['bypassCliPermissions', 'bypassComputerPermissions']) {
    for (const value of ['true', 1, null]) await assert.rejects(core.updateSettings({ [key]: value }), /Invalid/);
  }
  await core.updateSettings({ bypassCliPermissions: true });
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.settings().bypassCliPermissions, true);
    assert.equal(reopened.settings().bypassComputerPermissions, false);
  } finally { reopened.close(); }
});

test('each bypass accepts only its pending permissions and never answers questions', async t => {
  const { core, session } = await setup(t);
  const pending = new Map<string, Promise<any>>();
  for (const kind of ['provider', 'permissions', 'cli', 'desktop', 'image', 'unknown', 'question']) {
    pending.set(kind, core.approval(session.id, { kind, title: kind, detail: '', choices: kind === 'question' ? ['answer'] : ['allow', 'deny'] }));
  }
  await core.updateSettings({ bypassCliPermissions: true });
  for (const kind of ['provider', 'permissions', 'cli']) assert.equal((await pending.get(kind)).choice, 'allow');
  assert.deepEqual(core.snapshot().approvals.map(a => a.kind), ['desktop', 'image', 'unknown', 'question']);
  await core.updateSettings({ bypassComputerPermissions: true });
  for (const kind of ['desktop', 'image']) assert.equal((await pending.get(kind)).choice, 'allow');
  assert.deepEqual(core.snapshot().approvals.map(a => a.kind), ['unknown', 'question']);
  for (const kind of ['provider', 'permissions', 'cli', 'desktop', 'image']) {
    assert.equal((await core.approval(session.id, { kind, title: kind, detail: '', choices: ['allow', 'deny'] })).choice, 'allow');
  }
  core.cancelApprovals(session.id);
  await Promise.all(pending.values());
  await core.updateSettings({ bypassCliPermissions: false });
  const manual = core.approval(session.id, { kind: 'provider', title: 'Manual again', detail: '', choices: ['allow', 'deny'] });
  assert.equal(core.approvals.size, 1);
  core.cancelApprovals(session.id); assert.equal((await manual).choice, 'deny');
});

test('CLI and computer bypass expose independent tools and preserve pause, validation and revocation', async t => {
  const { core, session, directory } = await setup(t);
  core.tokens.set('fixture', session.id);
  await core.updateSettings({ profile: 'manual', bypassComputerPermissions: true, scripts: [{ id: 'hello', name: 'Hello', executable: '/usr/bin/printf', args: ['bypass test'], cwd: directory, timeout: 1000 }] });
  let tools = await core.rpc('mcp.tools', { token: 'fixture' });
  assert.ok(tools.some((d: any) => d.name === 'timer.start'));
  assert.ok(!tools.some((d: any) => d.category === 'scripts'));
  await core.action('timer.start', { minutes: 1, label: 'Computer bypass' }, session.id);
  await assert.rejects(core.action('script.run', { id: 'hello' }, session.id), /disabled/);
  await core.updateSettings({ bypassComputerPermissions: false, bypassCliPermissions: true });
  tools = await core.rpc('mcp.tools', { token: 'fixture' });
  assert.ok(tools.every((d: any) => d.category === 'scripts'));
  assert.match((await core.action('script.run', { id: 'hello' }, session.id)).stdout, /bypass test/);
  assert.equal(core.approvals.size, 0);
  await assert.rejects(core.action('timer.start', { minutes: 1, label: 'Blocked' }, session.id), /disabled/);
  await core.updateSettings({ bypassComputerPermissions: true });
  await assert.rejects(core.action('audio.volume', { percent: 101 }, session.id), /percent/);
  await core.updateSettings({ paused: true });
  assert.deepEqual(await core.rpc('mcp.tools', { token: 'fixture' }), []);
  await assert.rejects(core.action('script.run', { id: 'hello' }, session.id), /disabled/);
  await core.updateSettings({ paused: false, bypassCliPermissions: false, bypassComputerPermissions: false });
  assert.deepEqual(await core.rpc('mcp.tools', { token: 'fixture' }), []);
  assert.deepEqual(core.settings.categories, []);
  assert.equal(core.settings.profile, 'manual');
});

test('revocation after automatic approval still prevents execution', async t => {
  const { core, session, directory } = await setup(t);
  await core.updateSettings({ bypassCliPermissions: true, scripts: [{ id: 'hello', name: 'Hello', executable: '/usr/bin/printf', args: ['must not run'], cwd: directory, timeout: 1000 }] });
  const action = core.action('script.run', { id: 'hello' }, session.id);
  await core.updateSettings({ bypassCliPermissions: false });
  await assert.rejects(action, /revoked/);
  assert.equal(core.store.activities().length, 0);
});

test('Claude computer-tool entry approval follows computer bypass independently of shell access', async t => {
  const { core, directory } = await setup(t);
  const session = await core.create({ provider: 'claude', cwd: directory, trusted: true });
  core.tokens.set('claude', session.id);
  await core.updateSettings({ bypassComputerPermissions: true });
  const input = { address: '0x123' };
  assert.deepEqual(await core.rpc('mcp.call', { token: 'claude', name: 'approve', args: { tool_name: 'mcp__cere__windows_focus', input } }), { behavior: 'allow', updatedInput: input });
  const command = core.rpc('mcp.call', { token: 'claude', name: 'approve', args: { tool_name: 'Bash', input: { command: 'printf test' } } });
  assert.equal(core.approvals.size, 1);
  assert.equal(core.snapshot().approvals[0].kind, 'provider');
  await core.updateSettings({ bypassCliPermissions: true });
  assert.equal((await command).behavior, 'allow');
});

test('CLI bypass covers project trust while computer bypass does not grant CLI trust', async t => {
  const { core, directory } = await setup(t);
  await core.updateSettings({ bypassComputerPermissions: true });
  await assert.rejects(core.create({ provider: 'claude', cwd: directory }), /trust/);
  await core.updateSettings({ bypassCliPermissions: true });
  assert.equal((await core.create({ provider: 'claude', cwd: directory })).provider, 'claude');
  await core.updateSettings({ bypassCliPermissions: false });
  await assert.rejects(core.create({ provider: 'codex', cwd: directory }), /trust/);
});
