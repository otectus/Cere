/**
 * M12: typed search constraints, compiled for each provider, and a bounded cache of public results.
 * A provider gets only the filters it supports: site rules are sent as query operators and are also
 * enforced on the returned results, so they hold even when a provider ignores them. A date filter is
 * a request to the provider; result dates are not checked, and the trace says so. A provider without
 * a date filter is labelled as not filtering by date rather than claimed to. The cache lives in
 * memory only, keys on a hash of the normalized query, constraints and provider settings, is skipped
 * for fresh or past-day searches, and never keeps a result set that links to a private address.
 */
import { createHash } from 'node:crypto';
import type { SearchProvider } from './types.ts';

export type Recency = 'day' | 'week' | 'month' | 'year';
export type SearchConstraints = { sites?: string[]; exclude?: string[]; recency?: Recency; fresh?: boolean };
export type CompiledSearch = { query: string; params: Record<string, string>; applied: string[]; approximated: string[] };
export const recencies: Recency[] = ['day', 'week', 'month', 'year'];
export const planLimits = { sites: 5, cacheEntries: 100, cacheMs: 15 * 60_000 };

const hostname = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('Name sites by their domain, such as docs.python.org');
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host)) throw new Error(`“${value}” is not a site domain such as docs.python.org`);
  return host;
};
const hosts = (value: unknown, label: string) => {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : null;
  if (!list || list.length > planLimits.sites) throw new Error(`List up to ${planLimits.sites} ${label}`);
  const result = [...new Set(list.map(hostname))];
  return result.length ? result : undefined;
};

/** Validated constraints; omitted fields mean no constraint. */
export function validConstraints(value: unknown): SearchConstraints {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid search constraints');
  const p = value as Record<string, unknown>;
  for (const key of Object.keys(p)) if (!['sites', 'exclude', 'recency', 'fresh'].includes(key)) throw new Error(`Unknown search constraint: ${key}`);
  if (p.recency !== undefined && !recencies.includes(p.recency as Recency)) throw new Error('Choose day, week, month or year');
  if (p.fresh !== undefined && typeof p.fresh !== 'boolean') throw new Error('Choose whether the search must skip cached results');
  const sites = hosts(p.sites, 'sites'), exclude = hosts(p.exclude, 'excluded sites');
  if (sites && exclude?.some(host => sites.includes(host))) throw new Error('A site cannot be both required and excluded');
  return { ...(sites ? { sites } : {}), ...(exclude ? { exclude } : {}), ...(p.recency ? { recency: p.recency as Recency } : {}), ...(p.fresh ? { fresh: true } : {}) };
}

const dateParams: Partial<Record<SearchProvider, (recency: Recency) => [string, string]>> = {
  duckduckgo: recency => ['df', recency[0]],
  brave: recency => ['tf', 'p' + recency[0]],
  searxng: recency => ['time_range', recency],
};

/** What a provider is sent for these constraints, and what is enforced or only requested. */
export function compile(provider: SearchProvider, query: string, constraints: SearchConstraints): CompiledSearch {
  const terms = [query.trim()], params: Record<string, string> = {}, applied: string[] = [], approximated: string[] = [];
  if (constraints.sites?.length) {
    terms.push(constraints.sites.length === 1 ? `site:${constraints.sites[0]}` : '(' + constraints.sites.map(site => `site:${site}`).join(' OR ') + ')');
    applied.push(`only ${constraints.sites.join(', ')} (query operator and result filter)`);
  }
  if (constraints.exclude?.length) {
    terms.push(...constraints.exclude.map(site => `-site:${site}`));
    applied.push(`excluding ${constraints.exclude.join(', ')} (query operator and result filter)`);
  }
  if (constraints.recency) {
    const date = dateParams[provider];
    if (date) { const [key, value] = date(constraints.recency); params[key] = value; approximated.push(`past ${constraints.recency} requested from ${provider} (${key}=${value}); result dates are not checked`); }
    else approximated.push(`${provider} has no date filter; results are not limited to the past ${constraints.recency}`);
  }
  return { query: terms.join(' '), params, applied, approximated };
}

/** A result URL's host, for the site rules. */
export function allowedBySites(url: string, constraints: SearchConstraints) {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); } catch { return false; }
  const within = (site: string) => host === site || host.endsWith('.' + site);
  if (constraints.sites?.length && !constraints.sites.some(within)) return false;
  return !constraints.exclude?.some(within);
}

/** The same page under different tracking parameters, fragments or a trailing slash counts once. */
export function dedupeKey(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$)/i.test(key)) parsed.searchParams.delete(key);
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return parsed.href.replace(/\/(?=$|\?)/, '');
  } catch { return url; }
}

type Entry<T> = { value: T; stored: number };
/** In-memory, least recently used, time bounded. Keys are hashes; no query text is kept. */
export class SearchCache<T> {
  entries = new Map<string, Entry<T>>(); hits = 0; misses = 0; limit: number; lifetimeMs: number; now: () => number;
  constructor(limit = planLimits.cacheEntries, lifetimeMs = planLimits.cacheMs, now = () => Date.now()) { this.limit = limit; this.lifetimeMs = lifetimeMs; this.now = now; }
  static key(query: string, constraints: SearchConstraints, config: unknown) {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
    return createHash('sha256').update(JSON.stringify([normalized, constraints.sites || [], constraints.exclude || [], constraints.recency || '', config])).digest('hex');
  }
  /** Fresh and past-day searches never read the cache. */
  static usable(constraints: SearchConstraints) { return !constraints.fresh && constraints.recency !== 'day'; }
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry || this.now() - entry.stored > this.lifetimeMs) { if (entry) this.entries.delete(key); this.misses++; return undefined; }
    this.entries.delete(key); this.entries.set(key, entry); this.hits++;
    return { value: entry.value, ageMs: this.now() - entry.stored };
  }
  set(key: string, value: T) {
    this.entries.delete(key); this.entries.set(key, { value, stored: this.now() });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() { this.entries.clear(); }
}
