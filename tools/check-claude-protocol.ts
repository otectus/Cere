/**
 * W08: checks the installed Claude Code against the print-mode flags and stream-json control
 * protocol Cere's adapter uses, without a model turn or any billed request. For the ordinary and the
 * restricted (phone) argument sets it starts `claude -p` with Cere's flags, sends the stream-json
 * `initialize` control request and expects a successful control response listing models; an unknown
 * flag or a changed handshake fails. Run after a Claude Code update:
 *
 *   node tools/check-claude-protocol.ts           # exit 1 names the argument set that failed
 *
 * A pass shows the flags and handshake are still accepted. It does not prove turn semantics; the
 * fixture tests (tests/providers.test.ts) and a live check cover those.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
const version = (await promisify(execFile)('claude', ['--version'], { timeout: 10_000, env })).stdout.trim();
const common = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--forward-subagent-text',
  '--system-prompt-snapshot', 'off', '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__cere__approve', '--mcp-config', JSON.stringify({ mcpServers: {} })];
const sets: Record<string, string[]> = { ordinary: [...common, '--permission-mode', 'manual'], restricted: [...common, '--restricted', '--strict-mcp-config', '--permission-mode', 'manual'] };
const cwd = await mkdtemp(join(tmpdir(), 'cere-claude-check-'));
const results: Record<string, string> = {};
try {
  for (const [name, args] of Object.entries(sets)) {
    results[name] = await new Promise<string>(resolve => {
      const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '';
      const done = (value: string) => { clearTimeout(timer); child.kill(); resolve(value); };
      const timer = setTimeout(() => done('timeout'), 30_000);
      child.stdout.on('data', data => {
        output += data;
        for (const line of output.split('\n')) {
          try {
            const message = JSON.parse(line);
            if (message.type === 'control_response' && message.response?.request_id === 'cere-check')
              done(message.response.subtype === 'success' && Array.isArray(message.response.response?.models) ? 'ok' : 'unexpected response: ' + JSON.stringify(message.response).slice(0, 200));
          } catch {}
        }
      });
      child.stderr.on('data', data => { errors += data; });
      child.once('exit', code => done(`exited ${code}: ${errors.trim().slice(0, 300)}`));
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'cere-check', request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [] } }) + '\n');
    });
  }
} finally { await rm(cwd, { recursive: true, force: true }); }
console.log(JSON.stringify({ claude: version, ...results }));
if (Object.values(results).some(result => result !== 'ok')) process.exitCode = 1;
