/**
 * M13: one user-configured OpenAI-compatible chat endpoint. The base URL is validated here; https is
 * required outside this computer and the local network. Its key is bound to the endpoint's origin
 * (credentials.ts), and the capabilities are the user's declaration: Cere sends only what is declared
 * and labels the declaration as unverified.
 */
import { isIP } from 'node:net';
import { publicAddress } from './web.ts';
import type { CompatibleEndpoint } from './types.ts';

const flags = ['requiresKey', 'tools', 'images', 'streaming', 'usage'] as const;
const limits = { contextLength: [2048, 10_000_000], maxOutputTokens: [256, 1_000_000] } as const;

/** A loopback or private address, or localhost: plain http is allowed only there. */
const local = (host: string) => host === 'localhost' || host.endsWith('.localhost') || (!!isIP(host) && !publicAddress(host));

/** The normalized base URL, or '' to leave the endpoint unset. */
export function endpointUrl(value: unknown): string {
  if (value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('Enter the endpoint’s base URL, such as http://127.0.0.1:1234/v1');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter the endpoint’s base URL, such as http://127.0.0.1:1234/v1'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https endpoint');
  if (url.username || url.password) throw new Error('Put the key in the key field, not in the URL');
  if (url.search || url.hash) throw new Error('Use the base URL without a query or fragment');
  if (url.protocol === 'http:' && !local(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Use https for an endpoint outside this computer and your local network');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** The origin a saved key is bound to; '' when no endpoint is set. */
export const endpointOrigin = (baseUrl: string) => baseUrl ? new URL(baseUrl).origin : '';

/** A validated endpoint after applying a settings patch; fields left out keep their values. */
export function validEndpoint(patch: unknown, current: CompatibleEndpoint): CompatibleEndpoint {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid compatible endpoint settings');
  for (const key of Object.keys(patch)) if (!['baseUrl', 'label', ...flags, ...Object.keys(limits)].includes(key)) throw new Error(`Unknown compatible endpoint setting: ${key}`);
  const next = { ...current, ...(patch as Partial<CompatibleEndpoint>) };
  for (const key of flags) if (typeof next[key] !== 'boolean') throw new Error(`Choose whether the endpoint ${key === 'requiresKey' ? 'needs a key' : `supports ${key}`}`);
  if (typeof next.label !== 'string' || next.label.trim().length > 60 || /[\x00-\x1f\x7f]/.test(next.label)) throw new Error('Name the endpoint with up to 60 printable characters');
  next.label = next.label.trim();
  next.baseUrl = endpointUrl(next.baseUrl);
  for (const [key, [min, max]] of Object.entries(limits) as [keyof typeof limits, readonly [number, number]][])
    if (!Number.isInteger(next[key]) || next[key] !== 0 && (next[key] < min || next[key] > max)) throw new Error(`${key === 'contextLength' ? 'A context window' : 'An output limit'} is 0 (not declared) or ${min.toLocaleString('en-US')}–${max.toLocaleString('en-US')} tokens`);
  return next;
}

/** The declaration as the interface shows it: what is sent, and that none of it is verified. */
export function declared(endpoint: CompatibleEndpoint) {
  return { tools: endpoint.tools, images: endpoint.images, streaming: endpoint.streaming, usage: endpoint.usage, contextLength: endpoint.contextLength, maxOutputTokens: endpoint.maxOutputTokens, verified: false };
}
