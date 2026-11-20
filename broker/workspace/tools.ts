/**
 * Model-facing file tools. A model names a root by ID and a path relative to it; it receives bounded,
 * line-numbered excerpts with exact versions, and can propose a change set that only the user (or a
 * bounded edit grant the user gave) can apply. Every call re-checks that the folder still allows this
 * operation and that this conversation's model is a permitted processing destination for its contents.
 */
import { z } from 'zod';
import { completed, declined, failed, routeAllowed, routeLabels, workspaceLimits, type ToolResultV1 } from '../tools/contracts.ts';
import type { ToolSpec } from '../tools/registry.ts';
import type { Workbench } from '../workbench.ts';
import { WorkspaceError } from './fsclient.ts';
import { find, list, readExcerpt, readable, search, statPath } from './files.ts';
import { rootArgs, run as helper } from './fsclient.ts';
import { extractOptions } from '../workbench.ts';
import { normalizePath } from './policy.ts';
import type { WorkspaceRoot } from './roots.ts';

const rootId = z.string().max(64).optional().describe('Workspace folder ID from files_roots; the primary folder when omitted');
const relPath = z.string().max(workspaceLimits.pathChars);
const cursor = z.string().max(8192).optional().describe('Cursor from the previous page');

export function registerFileTools(workbench: Workbench) {
  const { registry } = workbench;
  /** A root this conversation's current model may read, or the reason it may not. */
  const usable = async (sessionId: string, id: string | undefined, signal: AbortSignal) => {
    const root = id ? workbench.roots.get(sessionId, id) : workbench.roots.primary(sessionId);
    if (!root) throw new WorkspaceError('no-root', 'This conversation has no workspace folder yet. Ask the user to choose one in the Workbench.');
    const route = await workbench.route(sessionId, signal);
    if (!routeAllowed(route.route, root.policy.destinations)) throw new WorkspaceError('destination', `${root.name} may only be read by models on ${root.policy.destinations.remote ? 'this computer or your own servers' : 'this computer'}; this conversation’s model runs on ${routeLabels[route.route]}.`);
    const status = await workbench.roots.status(root);
    if (status === 'missing') throw new WorkspaceError('root-missing', `${root.name} is not available right now (was a drive removed?)`);
    if (status === 'replaced') throw new WorkspaceError('root-changed', `${root.name} was replaced since it was chosen; the user needs to choose it again`);
    return root;
  };
  const guard = (run: (context: Parameters<ToolSpec['run']>[0], args: any) => Promise<ToolResultV1>) => async (context: Parameters<ToolSpec['run']>[0], args: any) => {
    try { return await run(context, args); }
    catch (error: any) {
      if (context.signal.aborted) throw error;
      if (error instanceof WorkspaceError) return failed(error.code, error.message, ['missing', 'stale', 'invalid-path', 'no-match', 'ambiguous', 'exists', 'invalid-query', 'invalid-pattern', 'not-file'].includes(error.code) ? 'explicit' : 'never');
      throw error;
    }
  };
  const reads = (session: any) => workbench.filesAvailable(session, 'read');
  const releases = (sessionId: string, turnId: string, value: unknown) => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (!workbench.spendEvidence(sessionId, turnId, bytes)) throw new WorkspaceError('evidence-budget', `This turn already received ${workspaceLimits.turnEvidenceBytes / 1024} KiB of file content, the most Cere releases in one turn. Work with what you have, or tell the user to continue in a new message.`);
  };
  const policyOf = (root: WorkspaceRoot) => root.policy.destinations;

  registry.register({
    name: 'files_roots', family: 'files', core: true, effects: { read: true },
    description: 'List the workspace folders this conversation may use, with their IDs and what each allows (read, create/edit text, organize). Paths are always relative to a folder.',
    input: z.strictObject({}), available: reads,
    run: guard(async ({ sessionId, signal }) => {
      const route = await workbench.route(sessionId, signal);
      const roots = workbench.roots.list(sessionId).map(root => ({ rootId: root.id, name: root.name, primary: root.primary, kind: root.kind,
        allows: ['read', ...(root.policy.write ? ['create_text', 'patch_text'] : []), ...(root.policy.organize ? ['mkdir', 'copy', 'move', 'trash'] : [])],
        ...(routeAllowed(route.route, root.policy.destinations) ? {} : { unavailable: `Its contents are limited to models on ${root.policy.destinations.remote ? 'this computer or your own servers' : 'this computer'}` }) }));
      return completed(roots.length ? `${roots.length} workspace folder${roots.length === 1 ? '' : 's'}.` : 'No workspace folders yet. Ask the user to choose one in the Workbench.', { roots, modelRunsOn: routeLabels[route.route] });
    }),
  });
  registry.register({
    name: 'files_list', family: 'files', core: true, effects: { read: true },
    description: 'List one folder (not recursive), a page at a time: names, types, sizes and modification times. Hidden files appear only if the folder allows them.',
    input: z.strictObject({ rootId, path: relPath.optional().describe('Folder relative to the workspace folder; the folder itself when omitted'), cursor, limit: z.int().min(1).max(workspaceLimits.listPageMax).optional() }),
    available: reads,
    run: guard(async ({ sessionId, signal }, args) => {
      const root = await usable(sessionId, args.rootId, signal), rel = normalizePath(args.path, root.path);
      const value = await list(root, rel, { cursor: args.cursor, limit: args.limit }, signal);
      return completed(`${value.entries.length} of ${value.total} entries in ${rel || root.name}${value.nextCursor ? '; more with nextCursor' : ''}.`, { rootId: root.id, ...value }, value.nextCursor ? { truncated: { field: 'entries', returned: value.entries.length, total: value.total, nextCursor: value.nextCursor } } : {});
    }),
  });
  registry.register({
    name: 'files_search', family: 'files', core: true, effects: { read: true },
    description: 'Search file contents under a folder. Literal text by default (case-insensitive unless caseSensitive); mode "regex" uses ripgrep syntax. Returns file, line number, line text and each file’s version. Reports when the search was bounded.',
    input: z.strictObject({ rootId, path: relPath.optional(), query: z.string().min(1).max(1000), mode: z.enum(['literal', 'regex']).optional(), caseSensitive: z.boolean().optional(), cursor, limit: z.int().min(1).max(workspaceLimits.searchPageMax).optional() }),
    available: reads,
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = await usable(sessionId, args.rootId, signal), rel = normalizePath(args.path, root.path);
      const value = await search(root, rel, args.query, { mode: args.mode, caseSensitive: args.caseSensitive, cursor: args.cursor, limit: args.limit }, signal);
      releases(sessionId, turnId, value.files);
      const count = value.files.reduce((sum, file) => sum + file.matches.length, 0);
      return workbench.restricted(completed(`${count} matching line${count === 1 ? '' : 's'} in ${value.files.length} file${value.files.length === 1 ? '' : 's'}${value.complete ? '' : `; stopped at ${value.stoppedBecause}, so this is not exhaustive`}.`, { rootId: root.id, ...value },
        { citations: value.files.slice(0, 20).map(file => ({ sourceId: `${root.id}:${file.path}`, sourceVersion: file.version, locator: { line: file.matches[0]?.line || 1 } })), ...('nextCursor' in value && value.nextCursor ? { truncated: { field: 'files', returned: value.files.length, nextCursor: value.nextCursor as string } } : {}) }), policyOf(root));
    }),
  });
  registry.register({
    name: 'files_read', family: 'files', core: true, effects: { read: true },
    description: `Read a UTF-8 text file as numbered lines ("12| text"), up to ${workspaceLimits.readLines} lines or ${workspaceLimits.readBytes / 1024} KiB at a time, with its exact version for later edits. Continue with nextStartLine. Binary files are reported, not read.`,
    input: z.strictObject({ rootId, path: relPath.min(1), startLine: z.int().min(1).optional(), lineCount: z.int().min(1).max(workspaceLimits.readLines).optional(), expectedVersion: z.string().max(80).optional() }),
    available: reads,
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = await usable(sessionId, args.rootId, signal), rel = normalizePath(args.path, root.path);
      const value: any = await readExcerpt(root, rel, { startLine: args.startLine, lineCount: args.lineCount, expectedVersion: args.expectedVersion }, signal);
      if (value.binary) return completed(`${rel} is ${value.kind}, not text.`, { rootId: root.id, ...value });
      releases(sessionId, turnId, value.text);
      return workbench.restricted(completed(`Lines ${value.startLine}–${value.endLine} of ${value.totalLines} in ${rel}${value.truncated ? '; more from nextStartLine' : ''}.`, { rootId: root.id, ...value },
        { citations: [{ sourceId: `${root.id}:${rel}`, sourceVersion: value.version, locator: { startLine: value.startLine, endLine: value.endLine } }], ...(value.truncated ? { truncated: { field: 'text', returned: value.endLine - value.startLine + 1, total: value.totalLines, nextCursor: String(value.nextStartLine) } } : {}) }), policyOf(root));
    }),
  });
  registry.register({
    name: 'files_stat', family: 'files', effects: { read: true },
    description: 'Metadata for one file or folder: type, size, modification time, permissions, hard links, and the content version of files up to 16 MiB.',
    input: z.strictObject({ rootId, path: relPath.min(1) }), available: reads,
    run: guard(async ({ sessionId, signal }, args) => {
      const root = await usable(sessionId, args.rootId, signal), rel = normalizePath(args.path, root.path);
      readable(root, rel);
      const info = await statPath(root, rel, signal);
      return completed(`${rel}: ${info.type}.`, { rootId: root.id, ...info });
    }),
  });
  registry.register({
    name: 'files_find', family: 'files', effects: { read: true },
    description: 'Find files and folders by name under a folder. namePattern is a substring, or a glob with * and ?. Version-control internals, dependency caches, build outputs and credential files are skipped.',
    input: z.strictObject({ rootId, path: relPath.optional(), namePattern: z.string().min(1).max(200), cursor }), available: reads,
    run: guard(async ({ sessionId, signal }, args) => {
      const root = await usable(sessionId, args.rootId, signal), rel = normalizePath(args.path, root.path);
      const value = await find(root, rel, args.namePattern, { cursor: args.cursor }, signal);
      return completed(`${value.matches.length} match${value.matches.length === 1 ? '' : 'es'}${value.complete ? '' : `; stopped at ${value.stoppedBecause}, so this is not exhaustive`}.`, { rootId: root.id, ...value });
    }),
  });
  const operation = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('create_text'), rootId: z.string().max(64).optional(), path: relPath.min(1), content: z.string().max(workspaceLimits.proposalBytes) }),
    z.strictObject({ kind: z.literal('patch_text'), rootId: z.string().max(64).optional(), path: relPath.min(1), baseVersion: z.string().max(80).describe('The version files_read returned'),
      edits: z.array(z.strictObject({ oldText: z.string().min(1).max(64 * 1024).describe('Exact text to replace, copied without line-number prefixes; must match exactly once'), newText: z.string().max(64 * 1024) })).min(1).max(50).optional(),
      content: z.string().max(workspaceLimits.proposalBytes).optional().describe('The complete new content, instead of edits') }),
    z.strictObject({ kind: z.literal('mkdir'), rootId: z.string().max(64).optional(), path: relPath.min(1) }),
    z.strictObject({ kind: z.enum(['copy', 'move']), rootId: z.string().max(64).optional(), from: relPath.min(1), toRootId: z.string().max(64).optional(), to: relPath.min(1), collision: z.enum(['refuse', 'unique']).optional() }),
    z.strictObject({ kind: z.literal('trash'), rootId: z.string().max(64).optional(), path: relPath.min(1) }),
  ]);
  registry.register({
    name: 'files_propose_changes', family: 'files', core: true, effects: { write: true },
    description: 'Propose exact file changes for the user to review. To change text in an existing file use patch_text with edits [{oldText, newText}] (oldText copied exactly from files_read, without line numbers); create_text only makes new files; mkdir, copy, move and trash organize files. Nothing changes until the user accepts (or an edit permission they gave covers it). Returns what was applied, declined or failed, per operation.',
    input: z.strictObject({ operations: z.array(operation).min(1).max(workspaceLimits.changeOperations), reason: z.string().min(1).max(500).describe('One sentence the user will see: why these changes') }),
    available: session => workbench.filesAvailable(session, 'change'),
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const primary = workbench.roots.primary(sessionId);
      for (const op of args.operations) { const ids = [op.rootId || primary?.id, 'toRootId' in op ? op.toRootId : undefined].filter(Boolean) as string[]; for (const id of ids) await usable(sessionId, id, signal); }
      const operations = args.operations.map((op: any) => ({ ...op, rootId: op.rootId || primary?.id }));
      const outcome = await workbench.proposeAndDecide(sessionId, turnId, operations, args.reason, signal);
      return outcome;
    }),
  });
  // 11.2: one focused edit for models that struggle with the general change-set schema; same review path.
  registry.register({
    name: 'files_replace_text', family: 'files', core: true, effects: { write: true },
    description: 'Propose replacing exact text in one existing file, for the user to review. oldText must be copied exactly from files_read (without line numbers) and appear exactly once in the file. Nothing changes until the user accepts.',
    input: z.strictObject({ path: relPath.min(1), oldText: z.string().min(1).max(64 * 1024), newText: z.string().max(64 * 1024), reason: z.string().min(1).max(500).describe('One sentence the user will see: why this change'), rootId: z.string().max(64).optional() }),
    available: session => workbench.filesAvailable(session, 'change'),
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = await usable(sessionId, args.rootId, signal);
      const info = await statPath(root, args.path, signal);
      if (info.type !== 'file' || !('version' in info) || !info.version) return failed('not_a_text_file', `${args.path} is not a file Cere can edit as text`, 'never');
      return workbench.proposeAndDecide(sessionId, turnId, [{ kind: 'patch_text', rootId: root.id, path: args.path, baseVersion: info.version, edits: [{ oldText: args.oldText, newText: args.newText }] }], args.reason, signal);
    }),
  });
  /** An immutable snapshot of a workspace file, carrying its folder's processing permissions; reused when unchanged. */
  const snapshot = async (sessionId: string, root: WorkspaceRoot, rel: string, signal: AbortSignal, maxBytes = 100 * 1024 * 1024) => {
    readable(root, rel);
    const value = await helper(['read', ...rootArgs(workbench.roots.handle(root)), rel, '--max-bytes', String(maxBytes)], { signal, timeoutMs: 60_000, maxOutput: maxBytes * 2 });
    for (const row of workbench.core.store.db.prepare("SELECT data FROM artifact_versions WHERE sha256=? ORDER BY created DESC LIMIT 20").all(value.sha256)) {
      const version = JSON.parse(String(row.data));
      if (version.sessionId === sessionId && version.provenance?.kind === 'workspace' && version.provenance.rootId === root.id && version.provenance.path === rel) return version;
    }
    return workbench.artifacts.install({ sessionId, bytes: Buffer.from(value.data, 'base64'), name: rel.split('/').pop()!, source: 'tool-output', policy: root.policy.destinations,
      provenance: { kind: 'workspace', rootId: root.id, root: root.name, path: rel, sourceVersion: 'sha256:' + value.sha256 } });
  };
  const id = z.string().regex(/^[0-9a-f-]{36}$/);
  registry.register({
    name: 'files_attach', family: 'files', effects: { read: true },
    description: 'Keep an immutable snapshot of a workspace file as an artifact, so it can be used as an image reference, a Code Lab input, or extracted later. The snapshot does not change if the file does.',
    input: z.strictObject({ rootId, path: relPath.min(1) }), available: reads,
    run: guard(async ({ sessionId, signal }, args) => {
      const root = await usable(sessionId, args.rootId, signal), rel = normalizePath(args.path, root.path);
      const version = await snapshot(sessionId, root, rel, signal);
      return completed(`Kept a snapshot of ${rel} (${version.bytes.toLocaleString('en-US')} bytes, ${version.mime}).`, { artifactId: version.artifactId, versionId: version.versionId, name: version.name, mime: version.mime, sourceVersion: version.provenance.sourceVersion },
        { artifacts: [{ artifactId: version.artifactId, versionId: version.versionId, purpose: 'snapshot' }] });
    }),
  });
  registry.register({
    name: 'files_extract', family: 'files', core: true, effects: { read: true },
    description: 'Read a document as text with locations: PDF (pages), DOCX (paragraphs and tables), XLSX (sheets and cells, formulas shown as written, never recalculated), CSV/TSV (rows), HTML (sections), JSON/XML/text (lines), ZIP (member list). Give a workspace path or an artifact. Returns the first parts and warnings (scanned pages, hidden sheets, macros not run).',
    input: z.strictObject({ rootId, path: relPath.optional(), artifactId: id.optional(), versionId: id.optional(), fromPage: z.int().min(1).optional(), toPage: z.int().min(1).optional(), delimiter: z.enum([',', '\t', ';', '|']).optional(), includeHiddenSheets: z.boolean().optional() }),
    available: reads,
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      let version;
      if (args.artifactId) version = workbench.artifacts.version(sessionId, args.artifactId, args.versionId);
      else if (args.path) { const root = await usable(sessionId, args.rootId, signal); version = await snapshot(sessionId, root, normalizePath(args.path, root.path), signal, 25 * 1024 * 1024); }
      else return failed('invalid_arguments', 'Give a workspace path or an artifact ID', 'explicit');
      const route = await workbench.route(sessionId, signal);
      if (!routeAllowed(route.route, version.policy)) return failed('destination', `${version.name} may not be sent to this conversation’s model`, 'never');
      const { data } = await workbench.artifacts.bytes(sessionId, version.artifactId, version.versionId);
      const result = await workbench.extractor.extract(workbench.artifacts, sessionId, version, data, extractOptions({ ...(args.fromPage ? { fromPage: args.fromPage } : {}), ...(args.toPage ? { toPage: args.toPage } : {}), ...(args.delimiter ? { delimiter: args.delimiter } : {}), ...(args.includeHiddenSheets !== undefined ? { includeHidden: args.includeHiddenSheets } : {}) }), signal);
      const shown: any[] = []; let bytes = 0;
      for (const unit of result.extraction.units) { const size = Buffer.byteLength(unit.text); if (bytes + size > 24 * 1024 && shown.length) break; shown.push(unit); bytes += size; }
      if (!workbench.spendEvidence(sessionId, turnId, bytes)) return failed('evidence-budget', 'This turn already received the most file content Cere releases in one turn', 'never');
      const extraction = result.extraction;
      const summary = extraction.status === 'empty' ? `No text was found in ${version.name}. That is not the same as the document being empty${extraction.warnings.length ? ': ' + extraction.warnings[0] : ''}.` : `${extraction.units.length} part${extraction.units.length === 1 ? '' : 's'} read from ${version.name}${extraction.status === 'partial' ? ' (partly; see warnings)' : ''}.`;
      return workbench.restricted(completed(summary, { extractionId: result.artifact.artifactId, extractionVersion: result.artifact.versionId, status: extraction.status, warnings: extraction.warnings, stats: extraction.stats, parts: shown, ...(shown.length < extraction.units.length ? { nextPart: shown.length } : {}) },
        { citations: shown.slice(0, 20).map(unit => ({ sourceId: version.artifactId, sourceVersion: version.versionId, locator: unit.locator })) }), version.policy);
    }),
  });
  registry.register({
    name: 'files_read_extraction', family: 'files', effects: { read: true },
    description: 'Read more parts of an extraction from files_extract, by part number, with their locations.',
    input: z.strictObject({ extractionId: id, fromPart: z.int().min(0), count: z.int().min(1).max(100).optional() }), available: reads,
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const { version, data } = await workbench.artifacts.bytes(sessionId, args.extractionId);
      if (version.provenance?.kind !== 'extraction') return failed('not_extraction', 'That ID is not an extraction', 'never');
      if (!routeAllowed((await workbench.route(sessionId, signal)).route, version.policy)) return failed('destination', 'This extraction may not be sent to this conversation’s model', 'never');
      const extraction = JSON.parse(data.toString('utf8')), parts = extraction.units.slice(args.fromPart, args.fromPart + (args.count || 20));
      const shown: any[] = []; let bytes = 0;
      for (const unit of parts) { const size = Buffer.byteLength(unit.text); if (bytes + size > 48 * 1024 && shown.length) break; shown.push(unit); bytes += size; }
      if (!workbench.spendEvidence(sessionId, turnId, bytes)) return failed('evidence-budget', 'This turn already received the most file content Cere releases in one turn', 'never');
      const next = args.fromPart + shown.length;
      return workbench.restricted(completed(`Parts ${args.fromPart}–${next - 1} of ${extraction.units.length}.`, { parts: shown, ...(next < extraction.units.length ? { nextPart: next } : {}), source: extraction.source.name },
        { citations: shown.slice(0, 20).map((unit: any) => ({ sourceId: extraction.source.artifactId, sourceVersion: extraction.source.versionId, locator: unit.locator })) }), version.policy);
    }),
  });
  registry.register({
    name: 'files_export_artifact', family: 'files', effects: { write: true },
    description: 'Propose writing an artifact (a generated image, a Code Lab output, a document) into a workspace folder as a new file. The user reviews it like any other change; nothing is overwritten.',
    input: z.strictObject({ artifactId: id, versionId: id, rootId, path: relPath.min(1), reason: z.string().min(1).max(500) }),
    available: session => workbench.filesAvailable(session, 'change'),
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = await usable(sessionId, args.rootId, signal);
      return workbench.proposeAndDecide(sessionId, turnId, [{ kind: 'export', rootId: root.id, path: args.path, artifactId: args.artifactId, versionId: args.versionId }], args.reason, signal);
    }),
  });
  registry.register({
    name: 'files_change_status', family: 'files', effects: { read: true },
    description: 'The recorded outcome of a change set, per operation. Checking status never applies anything again.',
    input: z.strictObject({ changeSetId: z.string().max(64) }), available: reads,
    run: guard(async ({ sessionId }, args) => {
      const set = workbench.changes.get(args.changeSetId);
      if (set.sessionId !== sessionId) return declined('That change set belongs to another conversation.');
      const review = workbench.changes.review(set.id);
      return completed(`Change set ${set.status}.`, { changeSetId: set.id, status: set.status, reason: set.reason, operations: review.operations.map(op => ({ index: op.index, kind: op.kind, path: op.path, ...(op.from ? { from: op.from } : {}), outcome: op.outcome.state, ...(op.outcome.message ? { message: op.outcome.message } : {}), ...(op.outcome.sha256 ? { version: 'sha256:' + op.outcome.sha256 } : {}) })) });
    }),
  });
}
