import type { Session, Settings } from './types.ts';

// This provenance is broker-owned. It is never taken from a network DTO.
export type RemoteExecution = {
  deviceId: string; projectId: string; scopeVersion: string; expiresAt: number;
  caps: string[]; categories: string[]; scriptIds: string[];
  memoryHosts?: string[];
};
export function ordinarySettings(settings: Settings, execution?: RemoteExecution): Settings {
  if (!execution) return settings;
  return { ...settings, bypassCliPermissions: false, bypassComputerPermissions: false,
    categories: settings.categories.filter(c => execution.categories.includes(c) && (c === 'providers' ? execution.caps.includes('providers.execute') : execution.caps.includes('desktop.control'))),
    grants: settings.grants.filter(g => execution.categories.includes(g.category)),
    scripts: settings.scripts.filter(s => execution.scriptIds.includes(s.id)),
    webSearch: { ...settings.webSearch, enabled: settings.webSearch.enabled && execution.caps.includes('web') },
    memory: { ...settings.memory, enabled: settings.memory.enabled && execution.caps.includes('memory.read') },
  };
}
export function busy(session: Session) { return ['starting','working','waiting','stopping'].includes(session.status); }
/** Messages passed here are written for people and may be shown verbatim on a paired phone. */
export function remoteError(code: string, message: string): Error & {code: string; remote: true} { return Object.assign(new Error(message), {code, remote: true as const}); }
