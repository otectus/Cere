// Image backend fixtures: OpenAI and Google answered by an injected fetch (no network), and a local fake
// ComfyUI server with a shared queue, so cancellation can be tested next to another user's job.
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';

export const png = (width = 64, height = 48, color = '#3366cc', alpha = 1) => sharp({ create: { width, height, channels: 4, background: { ...hex(color), alpha } } }).png().toBuffer();
function hex(value: string) { return { r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16) }; }
export type Call = { url: string; method: string; body: any; headers: Record<string, string> };

/** A fetch that answers provider URLs from handlers and records every call; anything else is refused. */
export function providerFetch(handlers: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetcher = (async (input: any, init: any = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    let body: any = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    const call = { url, method: init.method || 'GET', body, headers };
    calls.push(call);
    init.signal?.throwIfAborted();
    for (const [prefix, handler] of Object.entries(handlers)) if (url.startsWith(prefix)) return handler(call);
    throw new Error('Unexpected network request in test: ' + url);
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
export const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

/** A fake ComfyUI server: /prompt, /queue, /history, /view, /upload/image, /object_info, /system_stats, /interrupt and /ws. */
export async function fakeComfy(t: any, options: { targetedInterrupt?: boolean; runMs?: number; fail?: string; others?: { id: string; running: boolean }[] } = {}) {
  const state = { prompts: [] as any[], uploads: [] as string[], deletes: [] as string[], interrupts: [] as any[], history: {} as Record<string, any>, pending: [] as string[], running: [] as string[], images: new Map<string, Buffer>(), finishedOthers: [] as string[] };
  for (const other of options.others || []) (other.running ? state.running : state.pending).push(other.id);
  const finish = async (id: string) => {
    state.running = state.running.filter(item => item !== id);
    if (options.fail) { state.history[id] = { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: options.fail }]] } }; return; }
    const name = `cere_${id.slice(0, 8)}_00001_.png`;
    state.images.set(name, await png(80, 60, '#cc3366'));
    state.history[id] = { outputs: { '9': { images: [{ filename: name, subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } };
  };
  const advance = () => {
    // One job at a time, like a ComfyUI server: the oldest pending job runs when nothing else does.
    if (state.running.length || !state.pending.length) return;
    const id = state.pending.shift()!;
    if (!state.prompts.some(prompt => prompt.prompt_id === id)) { state.running.push(id); return; } // another user's job keeps running
    state.running.push(id);
    setTimeout(() => void finish(id).then(advance), options.runMs ?? 150);
  };
  const read = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const send = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/system_stats') return send({ system: { comfyui_version: 'fixture' }, devices: [{ name: 'Fixture GPU', vram_total: 6 * 2 ** 30, vram_free: 5 * 2 ** 30 }] });
    if (url.pathname === '/object_info') return send(Object.fromEntries(['KSampler', 'CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'VAEDecode', 'SaveImage', 'LoadImage', 'LoadImageMask', 'VAEEncode', 'SetLatentNoiseMask'].map(type => [type, { input: { required: type === 'CheckpointLoaderSimple' ? { ckpt_name: [['fixture.safetensors']] } : {} } }])));
    if (url.pathname === '/upload/image' && req.method === 'POST') { await read(req); const name = `upload-${state.uploads.length + 1}.png`; state.uploads.push(name); return send({ name, subfolder: 'cere', type: 'input' }); }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const body = JSON.parse(String(await read(req)));
      state.prompts.push(body);
      const id = body.prompt_id; state.pending.push(id); advance();
      return send({ prompt_id: id, number: state.prompts.length, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) { const id = decodeURIComponent(url.pathname.slice(9)); return send(state.history[id] ? { [id]: state.history[id] } : {}); }
    if (url.pathname === '/queue' && req.method === 'GET') return send({ queue_running: state.running.map((id, n) => [n, id, {}, {}, []]), queue_pending: state.pending.map((id, n) => [n, id, {}, {}, []]) });
    if (url.pathname === '/queue' && req.method === 'POST') { const body = JSON.parse(String(await read(req))); for (const id of body.delete || []) { state.deletes.push(id); state.pending = state.pending.filter(item => item !== id); } if (body.clear) state.pending = []; return send({}); }
    if (url.pathname === '/interrupt' && req.method === 'POST') {
      const raw = String(await read(req)), body = raw ? JSON.parse(raw) : {};
      state.interrupts.push(body);
      // A server with targeted interrupt stops only the named running job; an old one stops whatever runs.
      const target = options.targetedInterrupt ? (state.running.includes(body.prompt_id) ? body.prompt_id : undefined) : state.running[0];
      if (target) { state.running = state.running.filter(item => item !== target); state.history[target] = { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', {}]] } }; advance(); }
      return send({});
    }
    if (url.pathname === '/view') { const image = state.images.get(url.searchParams.get('filename') || ''); if (!image) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', 'image/png'); return res.end(image); }
    res.statusCode = 404; res.end('{}');
  });
  const sockets = new WebSocketServer({ server, path: '/ws' });
  sockets.on('connection', socket => socket.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: state.pending.length } } } })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { sockets.close(); server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: `http://127.0.0.1:${(server.address() as any).port}`, state, advance, finish };
}
/** A minimal API-format text-to-image workflow (and its image-to-image variant). */
export function workflow(edit = false, mask = false) {
  const graph: Record<string, any> = {
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: edit ? 0.6 : 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: [edit ? '10' : '5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'fixture.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'cere', images: ['8', 0] } },
  };
  if (edit) { graph['11'] = { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } }; graph['10'] = { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['4', 2] } }; }
  else graph['5'] = { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } };
  if (mask) graph['12'] = { class_type: 'LoadImageMask', inputs: { image: 'mask.png', channel: 'alpha' } };
  return graph;
}
