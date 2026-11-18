import { createHash } from 'node:crypto';
import { apiJson, type ApiAccess } from '../../api-providers.ts';
import { ExtractionPolicyError, MutationProposalBatchSchema, SYSTEM_PROMPT, exactOccurrence, EXTRACTION_PROMPT_VERSION, EXTRACTION_SCHEMA_VERSION, EXTRACTION_PARSER_VERSION } from './ollama.ts';
import type { ExtractionAdapter, ExtractionSource, ExtractionRun } from './contracts.ts';

export class ApiExtractionAdapter implements ExtractionAdapter {
  readonly config: { provider: 'google' | 'anthropic'; model: string; allowCloud: boolean };
  readonly access: ApiAccess;
  constructor(config: ApiExtractionAdapter['config'], access: ApiAccess) { this.config = config; this.access = access; }
  private authorize() {
    if (!this.config.allowCloud) throw new ExtractionPolicyError('CLOUD_EXTRACTION_DISABLED', 'Enable cloud memory extraction before using an API');
  }
  private async generate(content: string, signal?: AbortSignal) {
    this.authorize();
    const guard = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
    const { provider, model } = this.config;
    if (provider === 'anthropic') {
      const result = await apiJson(provider, this.access, 'messages', { model, max_tokens: 4096, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] }, guard);
      if (result.stop_reason !== 'end_turn') throw new Error('Claude memory extraction did not finish');
      return { text: (result.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''), model: result.model || model };
    }
    const result = await apiJson(provider, this.access, `models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: 'user', parts: [{ text: content }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 },
    }, guard);
    const candidate = result.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw new Error('Gemini memory extraction did not finish');
    return { text: (candidate.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join(''), model: result.modelVersion || model };
  }
  private identity(model: string) {
    // API vendors expose model IDs, not weight digests. This identifies the route/version only.
    return createHash('sha256').update(JSON.stringify(['api-model-identity-v1', this.config.provider, model])).digest('hex');
  }
  async probe(signal?: AbortSignal) {
    const response = await this.generate('Return exactly {"entities":[],"assertions":[]}.', signal);
    const result = MutationProposalBatchSchema.parse(JSON.parse(response.text));
    if (result.entities.length || result.assertions.length) throw new Error('Extraction capability probe failed');
    return { model: response.model, digest: this.identity(response.model), capabilities: ['completion'] };
  }
  async extract(source: ExtractionSource, signal?: AbortSignal): Promise<ExtractionRun> {
    this.authorize();
    if (source.modelRoute !== 'cloud_allowed') throw new ExtractionPolicyError('LOCAL_ONLY_CLOUD_ROUTE', 'Local-only source cannot be sent to an API');
    if ([...source.text].length > 32768) throw new TypeError('Extraction source exceeds the configured input bound');
    const input = JSON.stringify({ sourceRecordId: source.sourceRecordId, sourceRole: source.sourceRole, sourceText: source.text });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.generate(input + (attempt ? '\nReturn a fresh JSON object matching the schema exactly, with exact source quotations.' : ''), signal);
      if (response.text.length > 64000) throw new Error('Extraction response exceeded the configured output bound');
      let parsed: unknown;
      try { parsed = JSON.parse(response.text); } catch { continue; }
      const result = MutationProposalBatchSchema.safeParse(parsed);
      if (!result.success) continue;
      for (const assertion of result.data.assertions) for (const quote of assertion.quotes) {
        if (quote.sourceRecordId !== source.sourceRecordId || !exactOccurrence(source.text, quote.quote, quote.occurrenceIndex)) throw new Error('Extraction model returned a fabricated or mismatched evidence quotation');
      }
      return { proposals: result.data, model: response.model, modelDigest: this.identity(response.model), endpointClass: this.config.provider === 'google' ? 'google_api' : 'anthropic_api', promptVersion: EXTRACTION_PROMPT_VERSION, schemaVersion: EXTRACTION_SCHEMA_VERSION, parserVersion: EXTRACTION_PARSER_VERSION };
    }
    throw new Error('Extraction model returned invalid structured proposals after one repair attempt');
  }
}

/** Fixed Gemini endpoint; callers must enforce source eligibility before supplying text. */
export async function googleEmbeddings(access: ApiAccess, model: string, texts: string[], kind: 'query' | 'document', signal: AbortSignal): Promise<number[][]> {
  const id = model.replace(/^models\//, '');
  const response = await apiJson('google', access, `models/${encodeURIComponent(id)}:batchEmbedContents`, {
    requests: texts.map(text => ({ model: `models/${id}`, content: { parts: [{ text }] }, taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' })),
  }, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
  return response.embeddings?.map((e: any) => e.values);
}
