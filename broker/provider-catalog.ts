export const providerIds = ['codex', 'claude', 'ollama', 'antigravity', 'openai', 'anthropic', 'google'] as const;
export type ApiProvider = 'openai' | 'anthropic' | 'google';
export const apiProviders: ApiProvider[] = ['openai', 'anthropic', 'google'];
export function isApiProvider(value: unknown): value is ApiProvider { return apiProviders.includes(value as ApiProvider); }
export const providerLabels: Record<typeof providerIds[number], string> = {
  codex: 'Codex', claude: 'Claude Code', ollama: 'Ollama', antigravity: 'AntiGravity',
  openai: 'OpenAI API', anthropic: 'Claude API', google: 'Google AI API',
};
