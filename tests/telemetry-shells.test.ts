import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
test('Fish, Bash and Zsh interactive hooks preserve status, coexist and remain silent', {timeout:60000}, async()=>{
  const {stdout}=await promisify(execFile)('python3',['tests/telemetry-shells.py'],{timeout:55000,maxBuffer:1024*1024});
  const results=JSON.parse(stdout);for(const shell of ['fish','bash','zsh'])assert.ok(results[shell].events>0);
});
