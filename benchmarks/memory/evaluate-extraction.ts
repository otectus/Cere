#!/usr/bin/env node
/**
 * Runs the EV-01 extraction evaluation (extraction-eval.ts) against one Ollama model and writes
 * benchmarks/memory/extraction-results-<model>.json. Only the synthetic statements of
 * tests/fixtures/memory/extraction-cases.json are sent. A cloud model receives them only with
 * CERE_ALLOW_CLOUD_EVAL=1 and --approve naming that model.
 *
 *   CERE_ALLOW_CLOUD_EVAL=1 node benchmarks/memory/evaluate-extraction.ts --approve MODEL [--model MODEL] [--digest SHA256] [--endpoint URL]
 *
 * Without --model, the model is the running broker's configured extraction model.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { OllamaExtractionAdapter } from '../../broker/graph-memory/adapters/ollama.ts';
import { evaluate, loadCases, preservedResults, resultsFile } from './extraction-eval.ts';

if (process.env.CERE_ALLOW_CLOUD_EVAL !== '1') throw new Error('Set CERE_ALLOW_CLOUD_EVAL=1 to authorize this synthetic cloud evaluation');
const { values } = parseArgs({ options: { model: { type: 'string' }, digest: { type: 'string' }, endpoint: { type: 'string', default: 'http://127.0.0.1:11434' }, approve: { type: 'string' } } });
let model = values.model;
if (!model) {
  const { request } = await import('../../broker/client.ts');
  model = (await request('state', {}).catch(() => undefined))?.settings?.memory?.extractionModel;
  if (!model) throw new Error('No running broker reported an extraction model; pass --model');
}
if (values.approve !== model) throw new Error(`Approve this model explicitly with --approve ${model}`);
const output = resultsFile(model);
if (output.href === preservedResults.href) throw new Error('Refusing to overwrite the preserved extraction results');
const adapter = new OllamaExtractionAdapter({ endpoint: values.endpoint!, model, expectedDigest: values.digest, allowCloud: true, timeoutMs: 120_000, probeTimeoutMs: 60_000 });
const probe = await adapter.probe();
console.error(`Evaluating ${probe.model} (${probe.digest}) on the synthetic extraction corpus`);
const report = await evaluate(adapter, loadCases(), { progress: (done, total) => console.error(`${done}/${total}`) });
const result = { schemaVersion: 3, evaluatedAt: new Date().toISOString(), requestedModel: model, probe: { model: probe.model, digest: probe.digest }, ...report,
  caveat: 'Synthetic held-out statements; canonical acceptance comes from Canonical.remember in a temporary store. Not an estimate of production-domain quality.' };
await writeFile(output, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ output: output.pathname, gates: result.gates, metrics: { ...result.metrics, perPredicate: undefined } }));
