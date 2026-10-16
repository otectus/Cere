/**
 * M09: managing models on the user's own Ollama server. Cere does not own the server process: it
 * lists models, pulls one at a time with progress and cancellation, loads or unloads a model, and
 * deletes one only after an explicit confirmation, never while a conversation is using it or while
 * it is the default chat, embedding or extraction model.
 */
import { ollamaHost, ollamaJson } from './ollama.ts';
import type { Core } from './core.ts';

const modelName = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,199}$/.test(value)) throw new Error('Enter an Ollama model name such as llama3.2 or qwen3:8b');
  return value;
};
const same = (a: string, b: string) => a === b || a + ':latest' === b || a === b + ':latest';
export type PullJob = { model: string; status: string; completed: number; total: number; started: number; error?: string; done?: boolean };

export class LocalModels {
  core: Core; job?: PullJob & { controller: AbortController };
  constructor(core: Core) { this.core = core; }
  private host() { return ollamaHost(this.core.settings.ollama.host); }
  /** What every state snapshot carries: only the pull in progress. */
  snapshot() { const job = this.job; return job ? { model: job.model, status: job.status, completed: job.completed, total: job.total, error: job.error || '', done: !!job.done } : null; }
  /** Why a model cannot be deleted now, or which idle conversations still name it. */
  usage(model: string) {
    const settings = this.core.settings, blocking: string[] = [];
    if (same(settings.ollama.model, model)) blocking.push('It is the default Ollama chat model.');
    if (same(settings.memory.model, model)) blocking.push('It is the memory embedding model.');
    if (same(settings.memory.extractionModel || '', model)) blocking.push('It is the memory extraction model.');
    const sessions = this.core.store.sessions().filter(session => session.provider === 'ollama' && same(session.model, model));
    if (sessions.some(session => ['starting', 'working', 'waiting', 'stopping'].includes(session.status))) blocking.push('A conversation is using it right now.');
    return { blocking, conversations: sessions.length };
  }
  async list() {
    const [tags, running] = await Promise.all([ollamaJson(this.host(), 'tags'), ollamaJson(this.host(), 'ps').catch(() => ({ models: [] }))]);
    const loaded = new Map<string, any>((running.models || []).map((entry: any) => [entry.model || entry.name, entry]));
    return { host: this.host(), models: (tags.models || []).map((entry: any) => {
      const name = entry.model || entry.name, usage = this.usage(name), live = loaded.get(name);
      return { name, size: entry.size || 0, modified: entry.modified_at || '', family: entry.details?.family || '', parameters: entry.details?.parameter_size || '', quantization: entry.details?.quantization_level || '',
        remote: !!(entry.remote_host || entry.remote_model), loaded: !!live, vram: live?.size_vram || 0, expires: live?.expires_at || '', inUse: usage.blocking, conversations: usage.conversations };
    }).sort((a: any, b: any) => a.name.localeCompare(b.name)) };
  }
  /** Starts one pull; progress arrives in the state snapshot. Cancel stops the download. */
  pull(value: unknown) {
    const model = modelName(value);
    if (this.job && !this.job.done) throw new Error(`Already pulling ${this.job.model}. Wait for it or cancel it first.`);
    const controller = new AbortController();
    this.job = { model, status: 'starting', completed: 0, total: 0, started: Date.now(), controller };
    this.core.changed();
    void this.run(this.job).catch(() => {});
    return this.snapshot();
  }
  private async run(job: PullJob & { controller: AbortController }) {
    const listed = this.core.jobs.add('model-pull', 'Downloading ' + job.model, () => this.cancel(), () => job.total ? { done: job.completed, total: job.total } : undefined);
    const finish = (patch: Partial<PullJob>) => { listed(); Object.assign(job, patch, { done: true }); this.core.changed(); };
    try {
      const response = await fetch(this.host() + '/api/pull', { method: 'POST', redirect: 'error', signal: job.controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: job.model, stream: true }) });
      if (!response.ok || !response.body) throw new Error(`Ollama refused the pull (${response.status})`);
      let buffer = '', last = 0;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          const value = JSON.parse(line);
          if (value.error) throw new Error(String(value.error).slice(0, 300));
          job.status = String(value.status || job.status).slice(0, 120);
          if (Number.isFinite(value.total)) job.total = value.total;
          if (Number.isFinite(value.completed)) job.completed = value.completed;
          // Progress is paced: one snapshot per half second is plenty for a progress bar.
          if (Date.now() - last > 500) { last = Date.now(); this.core.changed(); }
        }
      }
      finish({ status: 'success' });
      void this.core.refreshProviderModels('ollama').catch(() => {});
    } catch (error: any) {
      finish(job.controller.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: String(error?.message || error).slice(0, 300) });
    }
  }
  cancel() { if (this.job && !this.job.done) this.job.controller.abort(new Error('Pull cancelled')); return true; }
  dismiss() { if (this.job?.done) { this.job = undefined; this.core.changed(); } return true; }
  /** Deletion needs confirmation and is refused while the model is in use or chosen as a default. */
  async remove(value: unknown, confirmed: unknown) {
    const model = modelName(value), usage = this.usage(model);
    if (usage.blocking.length) throw new Error('Cannot delete ' + model + ': ' + usage.blocking.join(' '));
    if (confirmed !== true) throw new Error('Confirm deleting this model from the Ollama server');
    const response = await fetch(this.host() + '/api/delete', { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    if (!response.ok) throw new Error(`Ollama could not delete ${model} (${response.status})`);
    void this.core.refreshProviderModels('ollama').catch(() => {});
    return { deleted: model, conversations: usage.conversations };
  }
  /** Loads a model into memory for ten minutes, or unloads it now. */
  async keepAlive(value: unknown, load: boolean) {
    const model = modelName(value);
    if (!load && this.usage(model).blocking.includes('A conversation is using it right now.')) throw new Error('A conversation is using this model right now');
    // Loading a large model can take minutes; the shared JSON helper's 20-second limit is too short here.
    const response = await fetch(this.host() + '/api/generate', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(load ? 300_000 : 30_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: load ? '10m' : 0, stream: false }) });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`Ollama could not ${load ? 'load' : 'unload'} ${model} (${response.status})`);
    return { model, loaded: load };
  }
}
