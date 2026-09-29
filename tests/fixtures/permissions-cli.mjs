#!/usr/bin/env node
// Captures CLI protocol and argv without authentication, inference or tool execution.
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = value => appendFileSync(process.env.CERE_PERMISSION_TEST_LOG, JSON.stringify(value) + '\n');
const args = process.argv.slice(2);
log({ args });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args.includes('app-server')) {
  createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line); log(m);
    const reply = result => send({ id: m.id, result });
    if (m.method === 'initialize') reply({});
    if (m.method === 'config/read') reply({ config: { approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write', developer_instructions: 'Existing project guidance must survive.' } });
    if (m.method === 'thread/start' || m.method === 'thread/resume') reply({ thread: { id: 'permission-thread' }, approvalPolicy: m.params.approvalPolicy, approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
    if (m.method === 'turn/start') { reply({ turn: { id: 'turn' } }); send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } }); }
  });
} else if (args.includes('-p')) {
  const promptIndex=args.indexOf('--append-system-prompt-file');
  if(promptIndex>=0){const path=args[promptIndex+1];log({personality:readFileSync(path,'utf8'),path,mode:statSync(path).mode&0o777});}
  process.stdin.resume();
  process.stdin.on('end', () => send({ type: 'result', session_id: 'claude-permission-thread', is_error: false }));
}
