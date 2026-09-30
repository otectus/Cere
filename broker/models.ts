import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RpcProcess } from './wire.ts';
import { ollamaModels } from './ollama.ts';
import { providerExecutable } from './providers.ts';
import type { ModelOption, Provider } from './types.ts';

function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function effort(value: unknown) {
  const id = text(value);
  return id ? { id, displayName: id === 'xhigh' ? 'Extra high' : id[0].toUpperCase()+id.slice(1) } : null;
}

export function normalizeCodexModels(values: unknown[]): ModelOption[] {
  return values.flatMap((value: any) => {
    const id = text(value?.id || value?.model); if (!id) return [];
    const efforts = Array.isArray(value.supportedReasoningEfforts)
      ? value.supportedReasoningEfforts.flatMap((entry: any) => {
          const option = effort(entry?.reasoningEffort); return option ? [{ ...option, description: text(entry?.description) }] : [];
        }) : [];
    const defaultEffort = text(value.defaultReasoningEffort);
    return [{ id, displayName: text(value.displayName) || id, description: text(value.description), efforts,
      defaultEffort: efforts.some((option: { id: string }) => option.id === defaultEffort) ? defaultEffort : '', isDefault: value.isDefault === true }];
  });
}

export function normalizeClaudeModels(values: unknown[]): ModelOption[] {
  return values.flatMap((value: any) => {
    const id = text(value?.value); if (!id) return [];
    const efforts = Array.isArray(value.supportedEffortLevels)
      ? value.supportedEffortLevels.flatMap((entry: unknown) => { const option=effort(entry); return option ? [option] : []; }) : [];
    return [{ id, displayName: text(value.displayName) || id, description: text(value.description), efforts,
      defaultEffort: '', isDefault: id === 'default', resolvedModel: text(value.resolvedModel) || undefined }];
  });
}

async function codexModels(command: string): Promise<ModelOption[]> {
  const process = new RpcProcess(command, ['app-server'], homedir());
  process.on('fault', () => {});
  try {
    await process.request('initialize', { clientInfo: { name: 'cere', title: 'Cere', version: '0.1.0' }, capabilities: { experimentalApi: false } }, 20000);
    process.write({ method: 'initialized', params: {} });
    const values: unknown[] = []; let cursor: string | null = null;
    do {
      const response = await process.request('model/list', cursor ? { cursor } : {}, 20000);
      if (!Array.isArray(response?.data)) throw new Error('Codex returned an invalid model catalog');
      values.push(...response.data); cursor = text(response.nextCursor) || null;
    } while (cursor);
    const models = normalizeCodexModels(values);
    if (!models.length) throw new Error('Codex returned no selectable models');
    return models;
  } catch (error: any) {
    const detail = process.stderr.trim();
    throw new Error(detail ? `Codex model discovery failed: ${detail}` : `Codex model discovery failed: ${error.message}`);
  } finally { await process.close(); }
}

async function claudeModels(command: string): Promise<ModelOption[]> {
  const process = new RpcProcess(command, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'], homedir());
  process.on('fault', () => {});
  const requestId = `cere-models-${randomUUID()}`;
  try {
    const response = await new Promise<any>((resolve,reject) => {
      const timer=setTimeout(() => { cleanup(); reject(new Error('Claude model discovery timed out')); },20000);
      const message=(value:any) => {
        if(value?.type!=='control_response'||value.response?.request_id!==requestId)return;
        cleanup(); value.response.subtype==='success' ? resolve(value.response.response) : reject(new Error(value.response.error || 'Claude rejected model discovery'));
      };
      const exit=() => { cleanup(); reject(new Error('Claude exited before returning its model catalog')); };
      const cleanup=() => { clearTimeout(timer); process.off('message',message); process.off('exit',exit); };
      process.on('message',message); process.on('exit',exit);
      process.write({ type:'control_request', request_id:requestId, request:{ subtype:'initialize', hooks:{}, sdkMcpServers:[] } });
    });
    if (!Array.isArray(response?.models)) throw new Error('Claude returned an invalid model catalog');
    const models=normalizeClaudeModels(response.models);
    if (!models.length) throw new Error('Claude returned no selectable models');
    return models;
  } catch (error:any) {
    const detail=process.stderr.trim();
    throw new Error(detail ? `Claude model discovery failed: ${detail}` : `Claude model discovery failed: ${error.message}`);
  } finally { await process.close(); }
}

export function discoverProviderModels(provider: Provider, command?: string) {
  if (provider === 'ollama') return ollamaModels(command || process.env.CERE_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
  if (provider === 'codex') return codexModels(command || providerExecutable('codex'));
  return claudeModels(command || providerExecutable('claude'));
}
