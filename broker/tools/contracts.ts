/**
 * Workbench contracts shared by the file, artifact, media, execution and operation services.
 *
 * A model proposes structured arguments; the broker owns authority. Nothing in these types lets a
 * model choose a root, a destination, an approval or an artifact path: artifact references are
 * broker-issued IDs that are resolved, and authorized, on every use.
 */
import type { Session } from '../types.ts';

/** New tool families of the Workbench expansion. The older families (desktop, delegation, web, memory, notes, extensions) keep their own rules. */
export type WorkbenchFamily = 'files' | 'images' | 'analysis';
export const workbenchFamilies: WorkbenchFamily[] = ['files', 'images', 'analysis'];
export type SessionCapabilities = Partial<Record<WorkbenchFamily, boolean>>;

/** A reference to one immutable artifact version, as handed to the renderer and the model. */
export type ArtifactRef = { artifactId: string; versionId: string; purpose: string };
export type Citation = { sourceId: string; sourceVersion: string; locator: Record<string, string | number> };

/**
 * The structured result every Workbench tool returns. The model receives this bounded summary and the
 * authorized content in `data`; renderers receive the artifact references. Image bytes, large outputs
 * and catalogs never ride in a tool result.
 */
export type ToolResultV1 = {
  schema: 1;
  status: 'completed' | 'pending' | 'declined' | 'failed' | 'unknown';
  summary: string;
  data?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
  citations?: Citation[];
  operationId?: string;
  truncated?: { field: string; returned: number; total?: number; nextCursor?: string };
  error?: { code: string; message: string; retry: 'never' | 'explicit' | 'safe-read' };
};
/** Marks a tool result with its source's processing restrictions; never serialized, read by the managed loop. */
export const sourcePolicy = Symbol.for('cere.sourcePolicy');
export function isToolResult(value: unknown): value is ToolResultV1 {
  return !!value && typeof value === 'object' && (value as any).schema === 1 && typeof (value as any).status === 'string' && typeof (value as any).summary === 'string';
}
export const completed = (summary: string, data?: Record<string, unknown>, extra: Partial<ToolResultV1> = {}): ToolResultV1 => ({ schema: 1, status: 'completed', summary, ...(data ? { data } : {}), ...extra });
export const failed = (code: string, message: string, retry: 'never' | 'explicit' | 'safe-read' = 'explicit'): ToolResultV1 => ({ schema: 1, status: 'failed', summary: message, error: { code, message, retry } });
export const declined = (summary: string, data?: Record<string, unknown>): ToolResultV1 => ({ schema: 1, status: 'declined', summary, ...(data ? { data } : {}) });

/**
 * One capability fact with its evidence. `declared` is a user's or configuration's statement Cere did
 * not verify; `unknown` is never treated as supported.
 */
export type CapabilityState = 'supported' | 'unsupported' | 'declared' | 'unknown';
export type CapabilityValue = { state: CapabilityState; source: string; checkedAt: number; note?: string };
export const capability = (state: CapabilityState, source: string, note?: string): CapabilityValue => ({ state, source, checkedAt: Date.now(), ...(note ? { note } : {}) });
/** Effective capability is the intersection of every layer: any unsupported or unknown layer wins. */
export function intersect(...values: (CapabilityValue | undefined)[]): CapabilityValue {
  const order: CapabilityState[] = ['unsupported', 'unknown', 'declared', 'supported'];
  let worst: CapabilityValue | undefined;
  for (const value of values) {
    const current = value || capability('unknown', 'missing');
    if (!worst || order.indexOf(current.state) < order.indexOf(worst.state)) worst = current;
  }
  return worst || capability('unknown', 'missing');
}

/**
 * Where content is processed. `local`: this computer. `remote`: a server the user runs (LAN or their
 * own host). `cloud`: a hosted service. `unknown`: not established, which is never treated as local.
 */
export type ProcessingRoute = 'local' | 'remote' | 'cloud' | 'unknown';
/** Which processing destinations a folder, artifact or project allows. Local is always allowed. */
export type DestinationPolicy = { remote: boolean; cloud: boolean };
export const localOnly: DestinationPolicy = { remote: false, cloud: false };
/** Unknown routes need the broadest permission: a destination that cannot be verified is treated as cloud. */
export function routeAllowed(route: ProcessingRoute, policy: DestinationPolicy) {
  return route === 'local' || (route === 'remote' && (policy.remote || policy.cloud)) || ((route === 'cloud' || route === 'unknown') && policy.cloud);
}
/** The strictest of several policies, for derived data that inherits every source's restrictions. */
export function strictest(...policies: DestinationPolicy[]): DestinationPolicy {
  return { remote: policies.every(policy => policy.remote || policy.cloud), cloud: policies.every(policy => policy.cloud) };
}
export const routeLabels: Record<ProcessingRoute, string> = { local: 'this computer', remote: 'your own server', cloud: 'a cloud service', unknown: 'an unverified destination' };

/** The Workbench families this session has selected. Absent means off: an upgrade never adds a family. */
export function sessionCapabilities(session: Pick<Session, 'capabilities' | 'temporary' | 'remote' | 'provider'>): Record<WorkbenchFamily, boolean> {
  const managed = session.provider === 'ollama' || ['openai', 'anthropic', 'google', 'compatible'].includes(session.provider);
  const allowed = managed && !session.temporary && !session.remote;
  return { files: allowed && session.capabilities?.files === true, images: allowed && session.capabilities?.images === true, analysis: allowed && session.capabilities?.analysis === true };
}
/** Validates a capability selection from a client; unknown keys and non-booleans are refused. */
export function validCapabilities(value: unknown): SessionCapabilities {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capability selection');
  const result: SessionCapabilities = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (!(workbenchFamilies as string[]).includes(key) || typeof enabled !== 'boolean') throw new Error('Invalid capability selection');
    if (enabled) result[key as WorkbenchFamily] = true;
  }
  return result;
}

/** Application defaults, not provider limits. Centralized so the UI can say why something was bounded. */
export const workspaceLimits = {
  rootsPerSession: 8,
  listPage: 100, listPageMax: 500,
  searchPage: 50, searchPageMax: 200,
  readLines: 300, readBytes: 64 * 1024,
  searchCandidates: 10_000, searchDepth: 16, searchMs: 10_000, searchFileBytes: 2 * 1024 * 1024,
  turnEvidenceBytes: 256 * 1024,
  proposalBytes: 256 * 1024,
  changeOperations: 50, changeBytes: 5 * 1024 * 1024,
  proposalLifetimeMs: 15 * 60_000,
  pathChars: 4096,
  readableFileBytes: 16 * 1024 * 1024,
  manifestEntries: 500, manifestBytes: 100 * 1024 * 1024,
  trashBytes: 512 * 1024 * 1024,
} as const;
