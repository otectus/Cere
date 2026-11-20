// An MCP server over stdio whose one tool returns an image, structured content and a resource link,
// for the Workbench's typed-result handling.
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const image = process.argv[2];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'media', version: '1' } } });
    else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'render', description: 'Renders a chart.', inputSchema: { type: 'object', properties: {} } }] } });
    else if (message.method === 'tools/call') send({ id: message.id, result: { content: [{ type: 'text', text: 'Rendered.' }, { type: 'image', data: image, mimeType: 'image/png' }, { type: 'resource_link', uri: 'https://example.com/data.csv', name: 'data.csv' }], structuredContent: { points: 3, max: 30 } } });
    else if (message.id !== undefined) send({ id: message.id, result: {} });
  }
});
