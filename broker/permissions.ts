import type { Approval, Provider, Settings } from './types.ts';

export function bypassCategory(settings: Settings, category: string): boolean {
  return category === 'scripts' || category === 'providers' ? settings.bypassCliPermissions : settings.bypassComputerPermissions;
}
export function categoryEnabled(settings: Settings, category: string): boolean {
  return !settings.paused && (bypassCategory(settings, category) || (settings.profile !== 'manual' && settings.categories.includes(category)));
}
export function autoApprove(settings: Settings, approval: Pick<Approval, 'kind' | 'choices'>): boolean {
  if (settings.paused || !approval.choices.includes('allow')) return false;
  if (['provider', 'permissions', 'cli'].includes(approval.kind)) return settings.bypassCliPermissions;
  if (['desktop', 'image'].includes(approval.kind)) return settings.bypassComputerPermissions;
  return false; // Questions and unknown protocols require an actual response.
}
export function cliBypassArgs(provider: Provider): string[] {
  return provider === 'codex' ? ['--dangerously-bypass-approvals-and-sandbox']
    : provider === 'claude' ? ['--dangerously-skip-permissions', '--settings', JSON.stringify({ sandbox: { enabled: false } })] : [];
}
