import { constants, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir } from './paths.ts';
import { apiProviders, type ApiProvider } from './provider-catalog.ts';

type CredentialProvider = ApiProvider | 'elevenlabs';
const credentialProviders:CredentialProvider[]=[...apiProviders,'elevenlabs'];
const environment: Record<CredentialProvider, string[]> = { elevenlabs:['ELEVENLABS_API_KEY'], openai: ['OPENAI_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'], google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] };
/** Secrets never enter the shared settings, transcript database, or snapshot. */
export class ProviderCredentials {
  readonly directory: string;
  constructor(directory: string) { this.directory=directory; }
  private saved(): Partial<Record<CredentialProvider, string>> {
    let fd: number;
    try { fd = openSync(join(this.directory, 'provider-credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: any) { if (error.code === 'ENOENT') return {}; throw new Error('Cannot read the private provider credentials file'); }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65536) throw new Error();
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return Object.fromEntries(credentialProviders.flatMap(p => typeof value[p] === 'string' ? [[p, value[p]]] : []));
    } catch { throw new Error('Provider credentials must be a private, owner-only JSON file'); }
    finally { closeSync(fd); }
  }
  key(provider: CredentialProvider) {
    return this.saved()[provider] || environment[provider].map(name => process.env[name]?.trim()).find(Boolean) || '';
  }
  status() {
    const saved = this.saved();
    return Object.fromEntries(credentialProviders.map(p => [p, { configured: !!(saved[p] || environment[p].some(k => process.env[k]?.trim())),
      source: saved[p] ? 'saved' : environment[p].some(k => process.env[k]?.trim()) ? 'environment' : 'missing', environment: environment[p].join(' / ') }]));
  }
  update(provider: unknown, key: unknown) {
    if (!(typeof provider==='string'&&credentialProviders.includes(provider as CredentialProvider)) || typeof key !== 'string' || key.length > 8192 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('Choose an API provider and enter a key without whitespace');
    privateDir(this.directory);
    const saved = this.saved();
    if (key) saved[provider as CredentialProvider] = key; else delete saved[provider as CredentialProvider];
    const temporary = join(this.directory, `.credentials-${randomUUID()}`);
    try { writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' }); renameSync(temporary, join(this.directory, 'provider-credentials.json')); }
    finally { try { unlinkSync(temporary); } catch {} }
    return this.status();
  }
}
