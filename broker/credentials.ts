import { constants, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir } from './paths.ts';
import { apiProviders, type ApiProvider } from './provider-catalog.ts';

type CredentialProvider = ApiProvider | 'elevenlabs';
const credentialProviders:CredentialProvider[]=[...apiProviders,'elevenlabs'];
const environment: Record<CredentialProvider, string[]> = { elevenlabs:['ELEVENLABS_API_KEY'], openai: ['OPENAI_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'], google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], compatible: [] };
/**
 * Secrets never enter the shared settings, transcript database, or snapshot. M13: the compatible
 * endpoint's key is saved together with the origin it was entered for, and is used only for that
 * origin; changing the endpoint's host never forwards the key there.
 */
export class ProviderCredentials {
  readonly directory: string;
  constructor(directory: string) { this.directory=directory; }
  private saved(): Partial<Record<CredentialProvider, string>> & { origins?: Partial<Record<CredentialProvider, string>> } {
    let fd: number;
    try { fd = openSync(join(this.directory, 'provider-credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: any) { if (error.code === 'ENOENT') return {}; throw new Error('Cannot read the private provider credentials file'); }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65536) throw new Error();
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const origins = value.origins && typeof value.origins === 'object' && !Array.isArray(value.origins) ? Object.fromEntries(Object.entries(value.origins).filter(([, origin]) => typeof origin === 'string')) : {};
      return { ...Object.fromEntries(credentialProviders.flatMap(p => typeof value[p] === 'string' ? [[p, value[p]]] : [])), origins };
    } catch { throw new Error('Provider credentials must be a private, owner-only JSON file'); }
    finally { closeSync(fd); }
  }
  /** A key bound to an origin is returned only for that origin. */
  key(provider: CredentialProvider, origin?: string) {
    const saved = this.saved(), bound = saved.origins?.[provider];
    if (bound !== undefined && bound !== origin) return '';
    return saved[provider] || environment[provider].map(name => process.env[name]?.trim()).find(Boolean) || '';
  }
  status(origin?: string) {
    const saved = this.saved();
    return Object.fromEntries(credentialProviders.map(p => {
      const bound = saved.origins?.[p], usable = !!saved[p] && (bound === undefined || bound === origin);
      return [p, { configured: usable || environment[p].some(k => process.env[k]?.trim()),
        source: usable ? 'saved' : environment[p].some(k => process.env[k]?.trim()) ? 'environment' : 'missing', environment: environment[p].join(' / '), ...(bound !== undefined ? { boundTo: bound } : {}) }];
    }));
  }
  update(provider: unknown, key: unknown, origin?: string) {
    if (!(typeof provider==='string'&&credentialProviders.includes(provider as CredentialProvider)) || typeof key !== 'string' || key.length > 8192 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('Choose an API provider and enter a key without whitespace');
    if (provider === 'compatible' && key && !origin) throw new Error('Set the compatible endpoint before saving its key');
    privateDir(this.directory);
    const saved = this.saved();
    saved.origins = { ...(saved.origins || {}) };
    if (key) saved[provider as CredentialProvider] = key; else delete saved[provider as CredentialProvider];
    if (provider === 'compatible' && key) saved.origins.compatible = origin; else if (provider === 'compatible') delete saved.origins.compatible;
    const temporary = join(this.directory, `.credentials-${randomUUID()}`);
    try { writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' }); renameSync(temporary, join(this.directory, 'provider-credentials.json')); }
    finally { try { unlinkSync(temporary); } catch {} }
    return this.status(origin);
  }
}
