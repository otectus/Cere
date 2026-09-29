// Only used for isolated validation instances; the broker writes its own PID.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const directory=process.argv[2];
if(!directory?.startsWith('/tmp/'))throw new Error('Test runtime must be under /tmp');
try{const pid=Number(await readFile(join(directory,'broker.pid'),'utf8'));if(Number.isInteger(pid)&&pid>1)process.kill(pid,'SIGTERM')}catch{}
