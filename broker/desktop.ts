import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, mkdir, realpath, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Settings, ToolDefinition } from './types.ts';
import { paths } from './paths.ts';
export const exec = promisify(execFile);
export const actionDefinitions: ToolDefinition[] = [
  { name: 'apps.list', title: 'List applications', category: 'apps', description: 'List installed application names and desktop IDs', schema: {}, readOnly: true },
  { name: 'windows.list', title: 'List windows', category: 'windows', description: 'List open window titles, addresses and workspaces', schema: {}, readOnly: true },
  { name: 'audio.status', title: 'Read volume', category: 'audio', description: 'Read the current output volume and mute status', schema: {}, readOnly: true },
  { name: 'media.status', title: 'Read media status', category: 'media', description: 'Read the active media player and playback status', schema: {}, readOnly: true },
  { name: 'script.list', title: 'List saved scripts', category: 'scripts', description: 'List saved executable commands and IDs. Run only a saved ID with script_run.', schema: {}, readOnly: true },
  { name: 'timer.list', title: 'List timers', category: 'timers', description: 'List pending Cere timers', schema: {}, readOnly: true },
  { name: 'apps.launch', title: 'Launch application', category: 'apps', description: 'Launch an installed desktop application', schema: { desktopId: { type: 'string' } } },
  { name: 'files.open', title: 'Open file or project', category: 'files', description: 'Open an absolute local path in its default application', schema: { path: { type: 'string' } } },
  { name: 'windows.focus', title: 'Focus window', category: 'windows', description: 'Focus an existing Hyprland window', schema: { address: { type: 'string' } } },
  { name: 'windows.move', title: 'Move window', category: 'windows', description: 'Move an existing window to a numbered workspace', schema: { address: { type: 'string' }, workspace: { type: 'integer', minimum: 1, maximum: 99 } } },
  { name: 'workspace.switch', title: 'Switch workspace', category: 'windows', description: 'Switch to a numbered Hyprland workspace', schema: { workspace: { type: 'integer', minimum: 1, maximum: 99 } } },
  { name: 'audio.volume', title: 'Set volume', category: 'audio', description: 'Set the default output volume from 0 to 100', schema: { percent: { type: 'integer', minimum: 0, maximum: 100 } } },
  { name: 'audio.mute', title: 'Toggle mute', category: 'audio', description: 'Toggle mute on the default output', schema: {} },
  { name: 'media.control', title: 'Media playback', category: 'media', description: 'Control an MPRIS player. Defaults to Spotify when available, otherwise the active player.', required:['command'], schema: { command: { type: 'string', enum: ['PlayPause', 'Next', 'Previous', 'Stop'] }, player: {type:'string',description:'Optional MPRIS bus name, for example org.mpris.MediaPlayer2.spotify'} } },
  { name: 'screenshot.capture', title: 'Capture in Satty', category: 'capture', description: 'Open a capture of the focused display in Satty for cropping and annotation. Return only the image explicitly saved by the user.', schema: {} },
  { name: 'timer.start', title: 'Set a timer', category: 'timers', description: 'Create a local reminder', schema: { minutes: { type: 'integer', minimum: 1, maximum: 10080 }, label: { type: 'string' } } },
  { name: 'script.run', title: 'Run saved script', category: 'scripts', description: 'Run a script explicitly saved in Cere settings', schema: { id: { type: 'string' } } },
];
export function validateAction(name: string, args: any) {
  const def = actionDefinitions.find(d => d.name === name);
  if (!def || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown action or invalid arguments');
  for (const key of Object.keys(args)) if (!(key in def.schema)) throw new Error(`Unexpected argument: ${key}`);
  for (const [key, rule] of Object.entries(def.schema) as [string, any][]) {
    const v = args[key];
    if(v===undefined&&def.required&&!def.required.includes(key))continue;
    if (rule.type === 'string' && (typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) throw new Error(`Invalid ${key}`);
    if (rule.type === 'integer' && (!Number.isInteger(v) || v < rule.minimum || v > rule.maximum)) throw new Error(`Invalid ${key}`);
    if (rule.enum && !rule.enum.includes(v)) throw new Error(`Invalid ${key}`);
  }
  if (args.address && !/^0x[0-9a-f]+$/i.test(args.address)) throw new Error('Invalid window address');
  if (args.player && !/^org\.mpris\.MediaPlayer2\.[\w.-]+$/.test(args.player)) throw new Error('Invalid media player');
  if (name === 'files.open' && !isAbsolute(args.path)) throw new Error('Choose an absolute local path');
  if (name === 'apps.launch' && !/^[\w. -]+\.desktop$/.test(args.desktopId)) throw new Error('Invalid application ID');
  return def;
}
/**
 * Desktop entry files beneath one applications root, with their desktop IDs: the
 * root-relative path with '/' replaced by '-', as the Desktop Entry specification
 * defines. Traversal is depth- and count-bounded and follows each real directory
 * once, so symlink loops terminate. Sorted paths make conflicting IDs deterministic.
 */
async function desktopEntries(root: string) {
  const entries: { id: string; path: string }[] = [], visited = new Set<string>();
  const walk = async (directory: string, prefix: string, depth: number) => {
    if (depth > 8 || entries.length >= 5000) return;
    const real = await realpath(directory).catch(() => '');
    if (!real || visited.has(real)) return;
    visited.add(real);
    const names = (await readdir(directory).catch(() => [] as string[])).sort();
    for (const name of names) {
      if (entries.length >= 5000) return;
      const path = join(directory, name), info = await stat(path).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) await walk(path, prefix + name + '-', depth + 1);
      else if (info.isFile() && name.endsWith('.desktop')) entries.push({ id: prefix + name, path });
    }
  };
  await walk(root, '', 0);
  return entries;
}
export async function applications() {
  const roots = [join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'applications'), ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').map(p => join(p, 'applications'))];
  const found = new Map<string, any>();
  for (const root of roots) {
    // Earlier roots take precedence by desktop ID, including Hidden tombstones.
    for (const { id, path } of await desktopEntries(root)) {
      if (found.has(id)) continue;
      const data = await readFile(path, 'utf8').catch(() => '');
      const group = data.split('[Desktop Entry]')[1]?.split(/\n\[/)[0] || '';
      if (/^(Hidden|NoDisplay)=true$/m.test(group)) { found.set(id, null); continue; }
      const title = /^Name=(.*)$/m.exec(group)?.[1];
      if (title && /^Type=Application$/m.test(group)) found.set(id, { id, name: title, icon: /^Icon=(.*)$/m.exec(group)?.[1] || '' });
      else found.set(id, null);
    }
  }
  return [...found.values()].filter(Boolean).sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export async function windows() { return JSON.parse((await exec('hyprctl', ['-j', 'clients'], { timeout: 5000 })).stdout); }
let luaDispatch: Promise<boolean> | undefined;
async function dispatch(lua: string, legacy: string[], signal?: AbortSignal, authorize?: () => void) {
  luaDispatch ??= exec('hyprctl', ['eval', 'assert(hl and hl.dsp)'], {timeout:3000})
    .then(r=>r.stdout.trim()==='ok', ()=>false);
  const supported=await luaDispatch;
  authorize?.();signal?.throwIfAborted();
  return effect(exec('hyprctl', supported ? ['dispatch', lua] : ['dispatch', ...legacy], {timeout:5000,signal}));
}
/** A started process can act before its acknowledgement is lost or it exits. */
async function effect<T>(operation:Promise<T>):Promise<T> {
  try { return await operation; }
  catch(error:any) { if(['ENOENT','EACCES'].includes(error?.code))throw error;throw Object.assign(new Error(error?.message||'Action completion could not be confirmed.'),{code:'OUTCOME_UNKNOWN'}); }
}
export async function audioStatus() {
  try {
    const {stdout}=await exec('wpctl',['get-volume','@DEFAULT_AUDIO_SINK@'],{timeout:3000,maxBuffer:4096});
    const match=/Volume:\s*([0-9.]+)/.exec(stdout);
    if(!match||!Number.isFinite(Number(match[1])))return {available:false};
    return {available:true,percent:Math.round(Number(match[1])*100),muted:stdout.includes('[MUTED]')};
  } catch { return {available:false}; }
}
const mediaPath='/org/mpris/MediaPlayer2', mediaInterface='org.mpris.MediaPlayer2.Player';
async function bus(...args:string[]) {
  const result=await exec('busctl',['--user','--json=short',...args],{timeout:3000,maxBuffer:1024*1024});
  return result.stdout.trim()?JSON.parse(result.stdout).data:null;
}
export async function mediaStatus(preferred?:string) {
  if(preferred&&!/^org\.mpris\.MediaPlayer2\.[\w.-]+$/.test(preferred))throw new Error('Invalid media player');
  const names:string[]=(await bus('call','org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ListNames'))[0];
  const players=(await Promise.all(names.filter(n=>n.startsWith('org.mpris.MediaPlayer2.')).map(async player=>{
    try {
      const [props,identity]=await Promise.all([
        bus('call',player,mediaPath,'org.freedesktop.DBus.Properties','GetAll','s',mediaInterface),
        bus('get-property',player,mediaPath,'org.mpris.MediaPlayer2','Identity')
      ]);
      const p=props[0], canControl=p.CanControl?.data===true;
      return {available:true,player,name:String(identity),status:p.PlaybackStatus?.data||'Stopped',
        canPlayPause:canControl&&(p.PlaybackStatus?.data==='Playing'?p.CanPause?.data:p.CanPlay?.data)===true,
        canNext:canControl&&p.CanGoNext?.data===true,canPrevious:canControl&&p.CanGoPrevious?.data===true,canStop:canControl};
    } catch { return null; } // A player can disappear between enumeration and inspection.
  }))).filter(p=>p!==null);
  players.sort((a,b)=>Number(/\.spotify(?:\.|$)/i.test(b.player))-Number(/\.spotify(?:\.|$)/i.test(a.player))||Number(b.status==='Playing')-Number(a.status==='Playing')||a.player.localeCompare(b.player));
  return (preferred?players.find(p=>p.player===preferred):players[0])||{available:false};
}
let capturing=false;
/**
 * Every step honors cancellation, including the open Satty editor: Stop or shutdown
 * terminates it, removes the raw image and releases the capture lock.
 */
async function captureInSatty(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if(capturing)throw new Error('A capture is already open in Satty. Save it or close it before starting another.');
  capturing=true;
  const directory=join(paths().state,'captures'), id=randomUUID();
  const raw=join(directory,`.capture-${id}.png`), path=join(directory,`${id}.png`);
  try {
    await exec('satty',['--version'],{timeout:3000,signal}).catch(()=>{signal?.throwIfAborted();throw new Error('Satty is required for captures. Install the satty package and try again.');});
    await mkdir(directory,{recursive:true,mode:0o700});
    const monitors=JSON.parse((await exec('hyprctl',['-j','monitors'],{timeout:3000,signal})).stdout);
    const monitor=monitors.find((m:any)=>m.focused&&!m.disabled)||monitors.find((m:any)=>!m.disabled);
    if(!monitor)throw new Error('No active display is available to capture.');
    // Let the dismissed Cere panel finish unmapping before capturing its display.
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},200);
      const abort=()=>{clearTimeout(timer);reject(signal!.reason);};
      signal?.addEventListener('abort',abort,{once:true});
    });
    await exec('grim',['-o',monitor.name,raw],{timeout:10000,signal});
    // Separate input/output means Escape can never accidentally share the unedited capture.
    await exec('satty',['--filename',raw,'--output-filename',path,'--initial-tool','crop',
      '--app-id',`org.satty.cere.capture_${id.replaceAll('-','_')}`,
      '--save-after-copy','--early-exit','all','--actions-on-enter','save-to-file,exit','--actions-on-escape','exit'],{maxBuffer:1024*1024,signal});
    signal?.throwIfAborted();
    if(!(await stat(path).catch(()=>null))?.size)return {cancelled:true,message:'Capture cancelled'};
    return {path,message:'Capture saved from Satty'};
  } finally {
    await unlink(raw).catch(()=>{});
    capturing=false;
  }
}
export async function desktopAction(name: string, args: any, settings: Settings, signal?: AbortSignal, authorize?: () => void) {
  validateAction(name, args);
  signal?.throwIfAborted();
  const run = (file: string, argv: string[], timeout = 10000) => { authorize?.();signal?.throwIfAborted();return effect(exec(file, argv, { timeout, signal, maxBuffer: 1024 * 1024 })); };
  switch (name) {
    case 'apps.list': return applications();
    case 'windows.list': return (await windows()).map((w: any) => ({ address: w.address, title: w.title, class: w.class, workspace: w.workspace }));
    case 'audio.status': return audioStatus();
    case 'media.status': return mediaStatus();
    case 'script.list': return settings.scripts;
    case 'apps.launch': {
      if (!(await applications()).some(a => a.id === args.desktopId)) throw new Error('Application is no longer installed');
      await run('gtk-launch', [args.desktopId]); return 'Application launched';
    }
    case 'files.open': {args.path=await realpath(args.path);authorize?.();await run('xdg-open', [args.path]); return 'Opened';}
    case 'windows.focus': await dispatch(`hl.dsp.focus({window="address:${args.address}"})`, ['focuswindow', `address:${args.address}`],signal,authorize); return 'Window focused';
    case 'windows.move': await dispatch(`hl.dsp.window.move({window="address:${args.address}",workspace="${args.workspace}",follow=false})`, ['movetoworkspacesilent', `${args.workspace},address:${args.address}`],signal,authorize); return 'Window moved';
    case 'workspace.switch': await dispatch(`hl.dsp.focus({workspace="${args.workspace}"})`, ['workspace', String(args.workspace)],signal,authorize); return 'Workspace switched';
    case 'audio.volume': await run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${args.percent}%`]); return `Volume ${args.percent}%`;
    case 'audio.mute': await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']); return 'Mute toggled';
    case 'media.control': {
      const player=await mediaStatus(args.player);
      if(!('player' in player))throw new Error(args.player?'This media player is no longer available. Refresh and try again.':'No media player is running. Open Spotify or another music player first.');
      const allowed={PlayPause:player.canPlayPause,Next:player.canNext,Previous:player.canPrevious,Stop:player.canStop};
      if(!allowed[args.command as keyof typeof allowed])throw new Error(`${player.name} cannot perform ${args.command} right now.`);
      await run('busctl',['--user','--json=short','call',player.player,mediaPath,mediaInterface,args.command],3000);
      return {message:`${player.name}: ${args.command==='PlayPause'?(player.status==='Playing'?'Pause':'Play'):args.command} requested`,player:player.player};
    }
    case 'screenshot.capture': {
      return captureInSatty(signal);
    }
    case 'script.run': {
      const script = settings.scripts.find(s => s.id === args.id);
      if (!script) throw new Error('Script no longer exists');
      authorize?.();signal?.throwIfAborted();
      const result = await effect(exec(script.executable, script.args, { cwd: script.cwd, timeout: script.timeout, signal, maxBuffer: 1024 * 1024 }));
      return { stdout: result.stdout, stderr: result.stderr };
    }
    default: throw new Error('Action is handled by the broker');
  }
}
