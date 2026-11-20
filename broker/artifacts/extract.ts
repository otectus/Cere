/**
 * Extraction: a derived, versioned text representation of a document with source locators (lines,
 * rows, pages, paragraphs, tables, sheets and cells, sections, archive members). Shared by artifacts,
 * workspace files and document collections. Parsing runs in a worker thread; PDFs are read by poppler in
 * a separate process, inside Cere's execution boundary when it is available.
 *
 * Extraction is not comprehension. An empty result says no text was found, not that the document says
 * nothing; scanned pages, hidden sheets, macros, embedded objects and external links are reported as
 * warnings. Each extraction records the source hash, extractor and version, options and the derived
 * text's hash; confidence is never invented.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { privateDir } from '../paths.ts';
import type { ArtifactStore, ArtifactVersion } from './store.ts';
import type { Parsed, Unit } from './extract-worker.ts';
import { isolation, sandboxed } from '../execution/runner.ts';

export const extractionLimits = { bytes: 25 * 1024 * 1024, pages: 500, workerIdleMs: 60_000, timeoutMs: 120_000 };
export const extractorVersion = '1';
export type Extraction = Parsed & { schema: 1; extractor: string; extractorVersion: string; source: { artifactId: string; versionId: string; sha256: string; mime: string; name: string }; options: Record<string, unknown>; derivedSha256: string };

export class Extractor {
  private worker?: Worker; private idle?: NodeJS.Timeout; private next = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
  directory: string;
  constructor(directory: string) { this.directory = directory; }
  private start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./extract-worker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 768 } });
    worker.on('message', (message: any) => { const entry = this.pending.get(message.id); if (!entry) return; this.pending.delete(message.id); if (message.ok) entry.resolve(message.value); else entry.reject(Object.assign(new Error(message.message), { code: message.code })); });
    const fail = (error: Error) => { for (const entry of this.pending.values()) entry.reject(error); this.pending.clear(); this.worker = undefined; };
    worker.on('error', fail); worker.on('exit', () => fail(new Error('The document reader stopped unexpectedly')));
    worker.unref();
    return this.worker = worker;
  }
  private parse(bytes: Buffer, mime: string, name: string, options: Record<string, unknown>, signal?: AbortSignal): Promise<Parsed> {
    const worker = this.start(), id = this.next++;
    clearTimeout(this.idle);
    return new Promise<Parsed>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); void worker.terminate(); reject(new Error('Reading the document took too long')); }, extractionLimits.timeoutMs);
      const abort = () => { this.pending.delete(id); clearTimeout(timer); void worker.terminate(); reject(signal!.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(value); }, reject: error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); } });
      worker.postMessage({ id, bytes, mime, name, options });
    }).finally(() => { if (!this.pending.size) { this.idle = setTimeout(() => { void this.worker?.terminate(); this.worker = undefined; }, extractionLimits.workerIdleMs); this.idle.unref(); } });
  }
  /** PDF text by page with poppler; pages without text are named so OCR can be requested for them. */
  private async pdf(bytes: Buffer, options: Record<string, unknown>, signal?: AbortSignal): Promise<Parsed> {
    if (!existsSync('/usr/bin/pdftotext') || !existsSync('/usr/bin/pdfinfo')) throw Object.assign(new Error('Reading PDFs needs poppler (pdftotext and pdfinfo). Install the poppler package.'), { code: 'unavailable' });
    const scratch = await mkdtemp(join(privateDir(join(this.directory, 'extract')), 'pdf-'));
    try {
      await writeFile(join(scratch, 'doc.pdf'), bytes, { mode: 0o600 });
      const status = await isolation();
      const runTool = async (argv: string[]) => {
        if (status.available) {
          const result = await sandboxed({ argv, binds: [{ source: join(scratch, 'doc.pdf'), target: '/work/doc.pdf' }], cwd: '/work', collectOutput: false, limits: { wallMs: 60_000, displayBytes: 24 * 1024 * 1024 }, signal: signal || new AbortController().signal });
          if (result.exitCode !== 0) throw new Error(result.stderr.trim().split('\n').slice(-1)[0] || 'poppler failed');
          return result.stdout;
        }
        return new Promise<string>((resolve, reject) => execFile(argv[0], argv.slice(1).map(arg => arg.replace('/work/doc.pdf', join(scratch, 'doc.pdf'))), { timeout: 60_000, maxBuffer: 24 * 1024 * 1024, env: { PATH: '/usr/bin', LANG: 'C.UTF-8' } }, (error, stdout, stderr) => error ? reject(new Error(String(stderr).trim().split('\n').slice(-1)[0] || error.message)) : resolve(stdout)));
      };
      const info = await runTool(['/usr/bin/pdfinfo', '/work/doc.pdf']).catch((error: Error) => { throw Object.assign(new Error(/Incorrect password|encrypted/i.test(error.message) ? 'The PDF is encrypted; Cere does not open encrypted documents' : 'The PDF could not be read: ' + error.message.slice(0, 200)), { code: /password|encrypted/i.test(error.message) ? 'encrypted' : 'malformed' }); });
      const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] || 0), warnings: string[] = [];
      if (/^Encrypted:\s+yes/m.test(info)) warnings.push('The PDF is marked encrypted; some text may be withheld by its permissions');
      const from = Math.max(1, Number(options.fromPage) || 1), to = Math.min(pages, Number(options.toPage) || pages, from + extractionLimits.pages - 1);
      if (to < pages || from > 1) warnings.push(`Pages ${from}–${to} of ${pages} were read; choose other pages to read more`);
      const text = to >= from ? await runTool(['/usr/bin/pdftotext', '-layout', '-enc', 'UTF-8', '-f', String(from), '-l', String(to), '/work/doc.pdf', '-']) : '';
      const units: Unit[] = [], empty: number[] = [];
      text.split('\f').slice(0, to - from + 1).forEach((page, index) => { const number = from + index; if (page.trim()) units.push({ locator: { page: number }, kind: 'page', text: page.replace(/[ \t]+$/gm, '').trim() }); else empty.push(number); });
      if (empty.length) warnings.push(`No text was found on page${empty.length === 1 ? '' : 's'} ${empty.slice(0, 30).join(', ')}${empty.length > 30 ? ', …' : ''}; ${empty.length === 1 ? 'it is' : 'they are'} probably scanned. Use OCR on ${empty.length === 1 ? 'that page' : 'those pages'} to read ${empty.length === 1 ? 'it' : 'them'}.`);
      return { status: !units.length ? 'empty' : warnings.some(w => /were read|probably scanned/.test(w)) ? 'partial' : 'complete', units, warnings, stats: { pages, read: `${from}-${to}`, scannedPages: empty.slice(0, 200) } };
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  /** Extracts one version, reusing an earlier extraction of the same bytes and options. */
  async extract(store: ArtifactStore, sessionId: string, version: ArtifactVersion, data: Buffer, options: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{ extraction: Extraction; artifact: ArtifactVersion; reused: boolean }> {
    if (data.length > extractionLimits.bytes) throw Object.assign(new Error(`Documents over ${extractionLimits.bytes / 1024 / 1024} MiB are not extracted; choose a smaller file or pages`), { code: 'too_large' });
    const optionsKey = JSON.stringify(Object.keys(options).sort().reduce((out, key) => ({ ...out, [key]: options[key] }), {}));
    for (const row of store.store.db.prepare("SELECT derived_version_id AS id, data FROM artifact_derivations WHERE source_version_id=? AND kind='extraction'").all(version.versionId)) {
      if (JSON.parse(String(row.data)).options !== optionsKey) continue;
      try { const artifact = store.version(sessionId, store.store.db.prepare('SELECT artifact_id FROM artifact_versions WHERE id=?').get(String(row.id))!.artifact_id as string, String(row.id)); const { data: json } = await store.bytes(sessionId, artifact.artifactId, artifact.versionId); return { extraction: JSON.parse(json.toString('utf8')), artifact, reused: true }; } catch { /* re-extract below */ }
    }
    let parsed: Parsed, extractor: string;
    if (version.mime === 'application/pdf') { parsed = await this.pdf(data, options, signal); extractor = 'poppler-pdftotext'; }
    else if (version.kind === 'image') { parsed = { status: 'empty', units: [{ locator: { image: version.versionId }, kind: 'metadata', text: `${version.name}: ${version.image ? `${version.image.width}×${version.image.height} ${version.image.format}` : version.mime}` }], warnings: ['Images have no text layer; use OCR or a vision pass to read their content'], stats: {} }; extractor = 'image-metadata'; }
    else if (/^(audio|video)\//.test(version.mime)) throw Object.assign(new Error('Recordings are read through transcription (More › Transcribe a recording), which keeps timestamps'), { code: 'use_transcription' });
    else if (version.mime === 'application/octet-stream') throw Object.assign(new Error('This file type has no text Cere can extract'), { code: 'unsupported' });
    else { parsed = await this.parse(data, version.mime, version.name, options, signal); extractor = 'cere-extract'; }
    const body = parsed.units.map(unit => unit.text).join('\n');
    const extraction: Extraction = { schema: 1, extractor, extractorVersion, source: { artifactId: version.artifactId, versionId: version.versionId, sha256: version.sha256, mime: version.mime, name: version.name }, options, ...parsed, derivedSha256: createHash('sha256').update(body).digest('hex') };
    const artifact = await store.install({ sessionId, bytes: Buffer.from(JSON.stringify(extraction)), name: version.name.replace(/\.[^.]+$/, '') + ' (extracted).json', mime: 'application/json', source: 'derived', policy: version.policy, label: 'extraction',
      parents: [{ artifactId: version.artifactId, versionId: version.versionId, relation: 'extraction' }], provenance: { kind: 'extraction', extractor, extractorVersion, status: parsed.status, warnings: parsed.warnings.slice(0, 10), units: parsed.units.length } });
    store.store.db.prepare("UPDATE artifact_derivations SET data=? WHERE source_version_id=? AND derived_version_id=? AND kind='extraction'").run(JSON.stringify({ options: optionsKey, extractor, extractorVersion, derivedSha256: extraction.derivedSha256 }), version.versionId, artifact.versionId);
    return { extraction, artifact, reused: false };
  }
  /** Extracts bytes that are not artifacts (a collection's source file), with the same readers and limits. */
  async parseFile(bytes: Buffer, name: string, mime: string, signal?: AbortSignal): Promise<Parsed> {
    if (bytes.length > extractionLimits.bytes) throw Object.assign(new Error(`Larger than ${extractionLimits.bytes / 1024 / 1024} MiB`), { code: 'too_large' });
    return mime === 'application/pdf' ? this.pdf(bytes, {}, signal) : this.parse(bytes, mime, name, {}, signal);
  }
  /** Locator headings let collection chunking keep each excerpt's page, sheet or rows. */
  static asCollectionText(extraction: Extraction) {
    return extraction.units.map(unit => `# ${Object.entries(unit.locator).map(([key, value]) => `${key} ${value}`).join(', ')}\n${unit.text}`).join('\n\n');
  }
  close() { clearTimeout(this.idle); void this.worker?.terminate(); this.worker = undefined; }
}
