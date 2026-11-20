/**
 * The execution boundary for Code Lab and command runs: Bubblewrap on Linux, chosen as the one primary
 * isolation profile. A run gets new user, mount, PID, IPC, UTS and network namespaces; the system's /usr
 * read-only; selected inputs read-only; a size-limited private output folder; an empty /tmp; no home
 * folder, no Cere data, no credentials, no session bus, no display sockets and no inherited environment.
 * Network stays off unless a command run explicitly asks for it.
 *
 * Limits are reported as enforced only when they are. Wall-clock time, displayed output, output files and
 * their total size are always enforced. Memory and process count are enforced through a systemd user scope
 * when one is available; otherwise memory falls back to an address-space limit (not the same as memory
 * use) and the process count is reported as not enforced. When Bubblewrap cannot start, execution is
 * unavailable: there is no fallback to running unconfined.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
export type Limits = { wallMs: number; memoryBytes: number; processes: number; displayBytes: number; outputBytes: number; files: number };
export const defaultLimits: Limits = { wallMs: 60_000, memoryBytes: 2 * 1024 ** 3, processes: 32, displayBytes: 256 * 1024, outputBytes: 100 * 1024 ** 2, files: 20 };
export type Enforcement = { wallClock: string; displayedOutput: string; outputFiles: string; filesystem: string; network: string; memory: string; processes: string };
export type Isolation = { available: boolean; problem?: string; cgroup: boolean; prlimit: boolean; enforced: Enforcement };

let cached: Promise<Isolation> | undefined;
/** Checks once whether the boundary can be established here, and how each limit is enforced. */
export function isolation(refresh = false): Promise<Isolation> {
  if (cached && !refresh) return cached;
  cached = (async () => {
    const base = { cgroup: false, prlimit: existsSync('/usr/bin/prlimit') };
    const unavailable = (problem: string): Isolation => ({ available: false, problem, ...base, enforced: { wallClock: 'n/a', displayedOutput: 'n/a', outputFiles: 'n/a', filesystem: 'not established', network: 'not established', memory: 'n/a', processes: 'n/a' } });
    if (!existsSync('/usr/bin/bwrap')) return unavailable('Code Lab needs Bubblewrap (the bubblewrap package). Install it to run analysis code.');
    try { await run('/usr/bin/bwrap', [...systemBinds(), '--unshare-all', '--die-with-parent', '--', '/usr/bin/true'], { timeout: 10_000, env: {} }); }
    catch (error: any) { return unavailable('Bubblewrap could not create its sandbox here (' + String(error?.stderr || error?.message || '').trim().slice(0, 200) + '). Code Lab stays off rather than running unconfined.'); }
    let cgroup = false;
    try { await run('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'TasksMax=8', '-p', 'MemoryMax=64M', '/usr/bin/true'], { timeout: 10_000 }); cgroup = true; } catch { /* no user manager here */ }
    return { available: true, cgroup, prlimit: base.prlimit, enforced: {
      wallClock: 'enforced: the run is stopped at the time limit', displayedOutput: 'enforced: output beyond the limit is cut', outputFiles: 'enforced: a size-limited private folder and a file count check',
      filesystem: 'enforced: only /usr and the selected inputs are visible, read-only', network: 'enforced: no network unless a command run asks for it',
      memory: cgroup ? 'enforced by a systemd scope (memory in use)' : base.prlimit ? 'address-space limit only (not the same as memory use)' : 'not enforced on this system',
      processes: cgroup ? 'enforced by a systemd scope' : 'not enforced on this system (the time limit and process-group stop still apply)' } };
  })();
  return cached;
}
/** The read-only system view every run gets: programs and libraries, fonts and certificates, nothing personal. */
function systemBinds() {
  return ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/bin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache', '--ro-bind-try', '/etc/fonts', '/etc/fonts', '--ro-bind-try', '/etc/ssl', '/etc/ssl', '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--ro-bind-try', '/etc/localtime', '/etc/localtime', '--proc', '/proc', '--dev', '/dev'];
}

export type Bind = { source: string; target: string; writable?: boolean };
export type SandboxResult = { exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean; stdout: string; stderr: string; truncated: boolean; durationMs: number;
  outputs: { name: string; bytes: Buffer }[]; outputProblem?: string; enforced: Enforcement };
/**
 * Runs argv inside the boundary. Outputs written to /work/output are returned (bounded); everything
 * else the run wrote disappears with its namespaces. The caller's signal stops it; only this run's
 * process group and namespaces are affected.
 */
export async function sandboxed(p: { argv: string[]; binds: Bind[]; cwd: string; env?: Record<string, string>; network?: boolean; limits?: Partial<Limits>; signal: AbortSignal; collectOutput?: boolean; onOutput?: (stream: 'stdout' | 'stderr', text: string) => void }): Promise<SandboxResult> {
  const status = await isolation();
  if (!status.available) throw Object.assign(new Error(status.problem || 'Isolation is unavailable'), { code: 'isolation_unavailable' });
  const limits = { ...defaultLimits, ...p.limits };
  const env = { PATH: '/usr/bin', LANG: 'C.UTF-8', HOME: '/work/home', TMPDIR: '/tmp', MPLBACKEND: 'Agg', MPLCONFIGDIR: '/tmp/matplotlib', PYTHONDONTWRITEBYTECODE: '1', OPENBLAS_NUM_THREADS: '2', OMP_NUM_THREADS: '2', ...(p.env || {}) };
  const args = [...systemBinds(), '--unshare-all', '--unshare-user', ...(p.network ? ['--share-net', '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind-try', '/etc/hosts', '/etc/hosts'] : []),
    '--die-with-parent', '--new-session', '--disable-userns', '--hostname', 'cere-lab', '--size', String(256 * 1024 * 1024), '--tmpfs', '/tmp', '--dir', '/work', '--size', String(32 * 1024 * 1024), '--tmpfs', '/work/home',
    ...(p.collectOutput !== false ? ['--size', String(limits.outputBytes), '--tmpfs', '/work/output'] : []),
    ...p.binds.flatMap(bind => [bind.writable ? '--bind' : '--ro-bind', bind.source, bind.target]), '--chdir', p.cwd, '--clearenv', ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value]), '--'];
  // After the program ends, the output folder is packed onto descriptor 3 (bounded and parsed here, untrusted).
  const inner = p.collectOutput !== false ? ['/usr/bin/sh', '-c', '"$@"; status=$?; cd /work/output && /usr/bin/tar -cf - --format=ustar . >&3 2>/dev/null; exit $status', 'cere-run', ...p.argv] : p.argv;
  let command = '/usr/bin/bwrap', commandArgs = [...args, ...inner];
  if (status.cgroup) { commandArgs = ['--user', '--scope', '--quiet', '--collect', '-p', `TasksMax=${limits.processes}`, '-p', `MemoryMax=${limits.memoryBytes}`, '-p', 'MemorySwapMax=0', command, ...commandArgs]; command = 'systemd-run'; }
  else if (status.prlimit) { commandArgs = [`--as=${limits.memoryBytes + 1024 ** 3}`, `--fsize=${limits.outputBytes}`, '--core=0', '--', command, ...commandArgs]; command = '/usr/bin/prlimit'; }
  const started = Date.now();
  return new Promise<SandboxResult>((resolve, reject) => {
    const child = spawn(command, commandArgs, { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...(status.cgroup ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '', DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '' } : {}) } });
    let stdout = '', stderr = '', truncated = false, timedOut = false, cancelled = false, archive: Buffer[] = [], archiveBytes = 0, archiveOverflow = false;
    const take = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8'), used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      if (used >= limits.displayBytes) { truncated = true; return; }
      const piece = text.slice(0, limits.displayBytes - used);
      if (piece.length < text.length) truncated = true;
      if (stream === 'stdout') stdout += piece; else stderr += piece;
      p.onOutput?.(stream, piece);
    };
    child.stdout!.on('data', chunk => take('stdout', chunk)); child.stderr!.on('data', chunk => take('stderr', chunk));
    (child.stdio[3] as any)?.on('data', (chunk: Buffer) => { archiveBytes += chunk.length; if (archiveBytes > limits.outputBytes + 1024 * 1024) archiveOverflow = true; else archive.push(chunk); });
    // Only this run's process group is stopped; bwrap's namespaces take the rest of the run with it.
    const stop = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, limits.wallMs);
    const abort = () => { cancelled = true; stop(); };
    p.signal.addEventListener('abort', abort, { once: true });
    child.on('error', error => { clearTimeout(timer); p.signal.removeEventListener('abort', abort); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); p.signal.removeEventListener('abort', abort);
      let outputs: { name: string; bytes: Buffer }[] = [], outputProblem: string | undefined;
      try { if (archiveOverflow) throw new Error('The run produced more than the output limit; its files were discarded'); outputs = untar(Buffer.concat(archive), limits); }
      catch (error: any) { outputProblem = error.message; outputs = []; }
      resolve({ exitCode: code, signal, timedOut, cancelled, stdout, stderr, truncated, durationMs: Date.now() - started, outputs, ...(outputProblem ? { outputProblem } : {}), enforced: status.enforced });
    });
  });
}
/** Reads the ustar stream of the output folder: regular files only, safe relative names, bounded count and size. */
export function untar(data: Buffer, limits: Pick<Limits, 'files' | 'outputBytes'>) {
  const files: { name: string; bytes: Buffer }[] = [];
  let offset = 0, total = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = (field(345, 155) ? field(345, 155) + '/' : '') + field(0, 100), size = parseInt(field(124, 12).trim() || '0', 8), type = String.fromCharCode(header[156] || 48);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('The run’s output could not be read');
    offset += 512;
    const clean = name.replace(/^\.\//, '');
    if (type === '0' || type === '\0') {
      if (!clean || clean.startsWith('/') || clean.split('/').some(part => part === '..' || part === '') || /[\x00-\x1f]/.test(clean)) throw new Error('The run produced a file with an unsafe name');
      if (files.length >= limits.files) throw new Error(`The run produced more than ${limits.files} files; none were kept`);
      total += size; if (total > limits.outputBytes) throw new Error('The run produced more than the output size limit; none were kept');
      files.push({ name: clean, bytes: Buffer.from(data.subarray(offset, offset + size)) });
    } else if (type !== '5') throw new Error('The run produced links or special files, which are not kept');
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}
/** The Python runtime Code Lab uses, as installed on this system; recorded with every run. */
let runtime: Promise<{ python: string; packages: Record<string, string> }> | undefined;
export function pythonRuntime() {
  runtime ||= run('/usr/bin/python3', ['-I', '-c', 'import json,sys,importlib.metadata as m\nout={}\nfor n in ["numpy","matplotlib","pillow","pandas","scipy"]:\n  try: out[n]=m.version(n)\n  except Exception: pass\nprint(json.dumps({"python":sys.version.split()[0],"packages":out}))'], { timeout: 15_000, env: { PATH: '/usr/bin' } })
    .then(result => JSON.parse(result.stdout), () => ({ python: 'unavailable', packages: {} }));
  return runtime;
}
