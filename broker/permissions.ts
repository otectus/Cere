import type { Approval, Provider, Settings } from './types.ts';

/**
 * Workbench approval kinds. The older CLI and computer bypasses never answer them: each Workbench family
 * has its own bounded grant (an edit grant, an image budget, an execution grant), and a change set,
 * an image job, a run or an export that is not covered by one waits for the user.
 */
export const workbenchApprovalKinds = ['changeset', 'media-job', 'execution', 'export', 'vision'] as const;
/**
 * Workbench families are not desktop categories: settings.categories never holds them and no bypass
 * covers them. They are namespaced because the desktop's own `files` category (opening a file with its
 * application) is unrelated and keeps its existing behavior.
 */
export const workbenchCategories = ['workbench.files', 'workbench.images', 'workbench.analysis'] as const;

export function bypassCategory(settings: Settings, category: string): boolean {
  // An explicit mapping: the computer bypass covers desktop categories only, never a Workbench family.
  if ((workbenchCategories as readonly string[]).includes(category)) return false;
  return category === 'scripts' || category === 'providers' ? settings.bypassCliPermissions : settings.bypassComputerPermissions;
}
export function categoryEnabled(settings: Settings, category: string): boolean {
  if ((workbenchCategories as readonly string[]).includes(category)) return false;
  return !settings.paused && (bypassCategory(settings, category) || (settings.profile !== 'manual' && settings.categories.includes(category)));
}
export function autoApprove(settings: Settings, approval: Pick<Approval, 'kind' | 'choices'>): boolean {
  if (settings.paused || !approval.choices.includes('allow')) return false;
  if ((workbenchApprovalKinds as readonly string[]).includes(approval.kind)) return false;
  if (['provider', 'permissions', 'cli'].includes(approval.kind)) return settings.bypassCliPermissions;
  if (['desktop', 'image'].includes(approval.kind)) return settings.bypassComputerPermissions;
  return false; // Questions and unknown protocols require an actual response.
}
export function cliBypassArgs(provider: Provider): string[] {
  return provider === 'codex' ? ['--dangerously-bypass-approvals-and-sandbox']
    : provider === 'claude' ? ['--dangerously-skip-permissions', '--settings', JSON.stringify({ sandbox: { enabled: false } })] : [];
}
