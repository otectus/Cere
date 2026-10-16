export const providerIds = ['codex', 'claude', 'ollama', 'antigravity', 'openai', 'anthropic', 'google', 'compatible'] as const;
/** M13: 'compatible' is one user-configured OpenAI-compatible chat endpoint. */
export type ApiProvider = 'openai' | 'anthropic' | 'google' | 'compatible';
export const apiProviders: ApiProvider[] = ['openai', 'anthropic', 'google', 'compatible'];
export function isApiProvider(value: unknown): value is ApiProvider { return apiProviders.includes(value as ApiProvider); }
export const providerLabels: Record<typeof providerIds[number], string> = {
  codex: 'Codex', claude: 'Claude Code', ollama: 'Ollama', antigravity: 'AntiGravity',
  openai: 'OpenAI API', anthropic: 'Claude API', google: 'Google AI API', compatible: 'Compatible endpoint',
};
