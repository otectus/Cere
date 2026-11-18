import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** A detached child owns its process group, including descendants after leader exit.
 * Zombies have no executable work. Escaped groups cannot be proven owned by this mechanism.
 */
export async function terminateProcessGroup(pid: number | undefined, graceMs = 3000): Promise<void> {
  if (!pid) return; // spawn failed before acquiring a process identity
  const signal = (value: NodeJS.Signals) => { try { process.kill(-pid, value); } catch (e: any) { if (e.code !== 'ESRCH') throw e; } };
  const alive = async () => {
    if (process.platform !== 'linux') { try { process.kill(-pid, 0); return true; } catch (e: any) { if(e.code==='ESRCH')return false;throw e; } }
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const value = await readFile(`/proc/${entry}/stat`, 'utf8').catch((e: any) => { if(e.code==='ENOENT'||e.code==='ESRCH')return '';throw e; });
      const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
    }
    return false;
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (await alive()) {
    if (Date.now() >= deadline) break;
    await delay(25);
  }
  if (!(await alive())) return;
  signal('SIGKILL');
  const killDeadline = Date.now() + 1000;
  while (await alive()) {
    if (Date.now() >= killDeadline) throw new Error('Owned process group termination is unconfirmed');
    await delay(25);
  }
}
