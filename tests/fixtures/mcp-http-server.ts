/**
 * A Streamable HTTP MCP server for tests, built on the official SDK's server so Cere's client is
 * checked against the reference implementation. It requires a bearer token when one is given, offers
 * tools (one returns an image), resources and a prompt, and has a route that redirects elsewhere.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function server(calls: string[]) {
  const mcp = new McpServer({ name: 'fixture-http', version: '1.0.0' });
  mcp.registerTool('echo', { description: 'Echo text back.', inputSchema: { text: z.string() } }, async ({ text }) => { calls.push('echo:' + text); return { content: [{ type: 'text', text: 'echo: ' + text }] }; });
  mcp.registerTool('picture', { description: 'Return a tiny picture.', inputSchema: {} }, async () => { calls.push('picture'); return { content: [{ type: 'text', text: 'Here it is.' }, { type: 'image', data: pixel, mimeType: 'image/png' }] }; });
  mcp.registerResource('readme', 'fixture://docs/readme.md', { title: 'Read me', description: 'Fixture documentation', mimeType: 'text/markdown' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Fixture\nResource text.' }] }));
  mcp.registerPrompt('review', { title: 'Review a file', description: 'Ask for a review', argsSchema: { file: z.string() } },
    ({ file }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Please review ${file} carefully.` } }] }));
  return mcp;
}
export async function httpMcpFixture(options: { token?: string } = {}) {
  const calls: string[] = [], sessions = new Map<string, StreamableHTTPServerTransport>(), seen: { method: string; authorization?: string; path: string }[] = [];
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    seen.push({ method: req.method || '', path: req.url || '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
    if (req.url === '/elsewhere') { res.writeHead(307, { location: 'http://example.invalid/mcp' }); return res.end(); }
    if (req.url !== '/mcp') { res.writeHead(404); return res.end(); }
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) { res.writeHead(401, { 'www-authenticate': 'Bearer' }); return res.end('unauthorized'); }
    const id = req.headers['mcp-session-id'];
    let transport = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!transport) {
      if (req.method !== 'POST') { res.writeHead(400); return res.end('no session'); }
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, onsessioninitialized: sid => { sessions.set(sid, transport!); } });
      transport.onclose = () => { if (transport!.sessionId) sessions.delete(transport!.sessionId); };
      await server(calls).connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as any).port;
  return { url: `http://127.0.0.1:${port}/mcp`, redirectUrl: `http://127.0.0.1:${port}/elsewhere`, calls, seen, sessions,
    async close() { for (const transport of sessions.values()) await transport.close().catch(() => {}); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}
