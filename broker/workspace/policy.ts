/**
 * Workspace policy: how model-facing paths are normalized, what bulk traversal leaves out, which files
 * are never offered, and where a conversation's model processes what it reads.
 *
 * This is deliberately separate from the notes vault's confinedPath(), which refuses every hidden path
 * component. Ordinary project configuration such as .gitignore or .editorconfig is readable here when a
 * root allows hidden files or the file is named exactly; credential files and Cere's own state never are.
 */
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { paths } from '../paths.ts';
import { isApiProvider } from '../provider-catalog.ts';
import type { Session, Settings } from '../types.ts';
import { modelRoute, ollamaHost } from '../ollama.ts';
import { workspaceLimits, type ProcessingRoute } from '../tools/contracts.ts';
import { WorkspaceError } from './fsclient.ts';

/** Version control internals, dependency caches and build outputs: skipped by search, find and folder manifests. */
export const excludedDirectories = ['.git', '.hg', '.svn', '.jj', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  '.gradle', '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', 'dist', 'build', 'target', 'out', 'coverage', '.terraform', 'bower_components', '.direnv'];
/**
 * Credential and key files. Never read, searched, attached or sent, even when named exactly; the user
 * can still open them in their own editor. Patterns: exact names, "*suffix" or "prefix*".
 */
export const credentialPatterns = ['.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', '*.kdbx', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.htpasswd', 'credentials', 'credentials.json', 'provider-credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml', '*.gpg', 'known_hosts', 'authorized_keys'];
export function credentialName(name: string) {
  const lower = name.toLowerCase();
  return credentialPatterns.some(pattern => pattern.startsWith('*') ? lower.endsWith(pattern.slice(1)) : pattern.endsWith('*') ? lower.startsWith(pattern.slice(0, -1)) : lower === pattern);
}
const registered = new Set<string>();
/** Adds a private location for this process, such as a store directory outside the default state path. */
export function addPrivateLocation(path: string) { registered.add(path); }
/** Private locations that are excluded from any root that contains them, and refused as roots themselves. */
export function privateLocations(): string[] {
  const home = homedir(), state = paths();
  return [...registered, state.state, state.config, state.runtime, join(home, '.ssh'), join(home, '.gnupg'), join(home, '.password-store'), join(home, '.local/share/keyrings'),
    join(home, '.mozilla'), join(home, '.config/google-chrome'), join(home, '.config/chromium'), join(home, '.config/BraveSoftware'), join(home, '.aws'), join(home, '.kube'),
    join(home, '.docker'), join(home, '.config/gh'), join(home, '.codex'), join(home, '.claude'), join(home, '.local/share/cere')];
}
const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel)); };
/** Why a folder cannot be a root, or '' when it can. */
export function forbiddenRoot(path: string) {
  if (path === '/') return 'The whole filesystem cannot be a workspace folder. Choose a project folder.';
  for (const location of privateLocations()) if (inside(location, path)) return 'This folder holds credentials or Cere’s private state and cannot be a workspace folder.';
  return '';
}
/** Private locations inside a root, as root-relative paths for the helper to skip. */
export function excludedInside(root: string) {
  return privateLocations().filter(location => location !== root && inside(root, location)).map(location => relative(root, location).split(sep).join('/'));
}

/**
 * A model- or client-supplied path inside a root, normalized: forward slashes, no "." or empty
 * components, never "..", no control characters. "" is the root itself. Absolute paths are accepted
 * only when they lie inside the root's own location.
 */
export function normalizePath(value: unknown, rootPath?: string): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > workspaceLimits.pathChars) throw new WorkspaceError('invalid-path', 'Use a path of up to 4,096 characters');
  if (/[\x00-\x1f\x7f]/.test(value)) throw new WorkspaceError('invalid-path', 'Paths cannot contain control characters');
  let text = value;
  if (text.startsWith('/')) {
    if (!rootPath) throw new WorkspaceError('escape', 'Use a path relative to the workspace folder');
    const rel = relative(rootPath, text);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new WorkspaceError('escape', 'That path is outside this workspace folder');
    text = rel;
  }
  const parts = text.split(/[\\/]+/).filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) throw new WorkspaceError('escape', 'Paths cannot contain ..');
  return parts.join('/');
}
export const baseName = (rel: string) => rel.split('/').at(-1) || '';
export const parentPath = (rel: string) => rel.split('/').slice(0, -1).join('/');
/** Whether a path passes through a hidden component, which needs a root that allows hidden files unless named exactly. */
export const hiddenPath = (rel: string) => rel.split('/').some(part => part.startsWith('.'));
export function excludedPath(rel: string) { return rel.split('/').slice(0, -1).some(part => excludedDirectories.includes(part)) || excludedDirectories.includes(baseName(rel)); }

/**
 * Where this conversation's model processes what it is given. Ollama on this computer serving a model it
 * reports as local is `local`; another Ollama host is `remote`; Ollama Cloud models and hosted APIs are
 * `cloud`. A compatible endpoint is whatever the user declared for it, `unknown` until then. A route that
 * cannot be verified is `unknown`, which is never treated as local.
 */
const routeCache = new Map<string, { route: ProcessingRoute; evidence: string; until: number }>();
export async function sessionRoute(session: Session, settings: Settings, signal?: AbortSignal, endpoint = settings.compatible): Promise<{ route: ProcessingRoute; evidence: string }> {
  if (session.provider === 'compatible') {
    // The conversation's own connection, when it has one; Settings' endpoint otherwise.
    const declared = endpoint.processing;
    return declared && declared !== 'unknown' ? { route: declared, evidence: 'Declared for the compatible endpoint in Settings; not verified' } : { route: 'unknown', evidence: 'The compatible endpoint’s processing location was not declared' };
  }
  if (isApiProvider(session.provider)) return { route: 'cloud', evidence: 'Hosted API' };
  if (session.provider !== 'ollama' || !session.ollama) return { route: 'unknown', evidence: 'Not a Cere-managed conversation' };
  const host = ollamaHost(session.ollama.host), key = host + '\n' + session.model, cached = routeCache.get(key);
  if (cached && cached.until > Date.now()) return { route: cached.route, evidence: cached.evidence };
  const verified = await modelRoute(host, session.model, signal);
  const loopback = (() => { try { const name = new URL(host).hostname.replace(/^\[|\]$/g, ''); return name === 'localhost' || name === '::1' || /^127\./.test(name); } catch { return false; } })();
  const result: { route: ProcessingRoute; evidence: string } = !verified.verified ? { route: 'unknown', evidence: 'Ollama did not confirm where this model runs' }
    : verified.route === 'cloud' ? { route: 'cloud', evidence: 'Ollama reports this model runs on Ollama Cloud' }
    : loopback ? { route: 'local', evidence: 'Ollama on this computer reports a local model' } : { route: 'remote', evidence: 'A local model on the Ollama server at ' + new URL(host).host };
  routeCache.set(key, { ...result, until: Date.now() + 5000 });
  return result;
}
export function clearRouteCache() { routeCache.clear(); }
