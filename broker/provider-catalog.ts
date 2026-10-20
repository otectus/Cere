export const providerIds = ['codex', 'claude', 'ollama', 'antigravity', 'openai', 'anthropic', 'google', 'compatible'] as const;
export type ProviderId = typeof providerIds[number];
/** M13: 'compatible' is one user-configured OpenAI-compatible chat endpoint. */
export type ApiProvider = 'openai' | 'anthropic' | 'google' | 'compatible';
export const apiProviders: ApiProvider[] = ['openai', 'anthropic', 'google', 'compatible'];
export function isApiProvider(value: unknown): value is ApiProvider { return apiProviders.includes(value as ApiProvider); }
export const providerLabels: Record<ProviderId, string> = {
  codex: 'Codex', claude: 'Claude Code', ollama: 'Ollama', antigravity: 'AntiGravity',
  openai: 'OpenAI API', anthropic: 'Claude API', google: 'Google AI API', compatible: 'Compatible endpoint',
};

/**
 * W08: one description of what each provider supports, owned by the broker. The desktop and the
 * phone derive controls and explanations from it instead of naming providers; what a provider can do
 * right now (availability, models, a configured key, a phone's grant) is reported alongside it.
 */
export type ProviderTraits = {
  label: string;
  /** cli: a provider's own CLI runs the turn and its tools; local and api: Cere runs the conversation. */
  kind: 'cli' | 'local' | 'api';
  /** A model must be chosen (no provider default), and whether a typed model ID is accepted. */
  modelRequired: boolean; customModel: boolean;
  /** Reasoning-effort choices exist per model. */
  effort: boolean;
  /** Image inputs: always, per model (Ollama vision), per endpoint declaration, or never. */
  images: 'yes' | 'per-model' | 'per-endpoint' | 'no';
  /** cere: Cere's desktop tools and delegation, opt-in per conversation; native: the provider's own tools. */
  tools: 'cere' | 'native';
  /** One-shot web search for a message. */
  webSearch: boolean;
  /** An existing CLI conversation can be brought into Cere; a stopped one can be resumed. */
  importHistory: boolean; resume: boolean;
  /** Messages sent while a turn runs wait in order instead of being refused. */
  queue: boolean;
  /** Model, effort or tools can change after the conversation starts. */
  configure: boolean;
  /** Usage may be billed per request to the owner's account. */
  billed: boolean;
  /**
   * How a turn started from a paired phone runs. restricted: under Cere's remote restrictions (and the
   * provider's own sandbox for a CLI); withheld: not from a phone, for the stated reason.
   */
  remote: 'restricted' | 'withheld';
  remoteNote: string;
};
export const providerTraits: Record<ProviderId, ProviderTraits> = {
  codex: { label: providerLabels.codex, kind: 'cli', modelRequired: false, customModel: false, effort: true, images: 'yes', tools: 'native', webSearch: false, importHistory: true, resume: true, queue: false, configure: true, billed: false,
    remote: 'restricted', remoteNote: 'Runs in Codex’s restricted sandbox; its permission requests come to you.' },
  claude: { label: providerLabels.claude, kind: 'cli', modelRequired: false, customModel: false, effort: true, images: 'yes', tools: 'native', webSearch: false, importHistory: true, resume: true, queue: false, configure: true, billed: false,
    remote: 'restricted', remoteNote: 'Runs only with a Claude Code that supports restricted mode; file tools stay in the project and code-running tools are off.' },
  ollama: { label: providerLabels.ollama, kind: 'local', modelRequired: true, customModel: false, effort: false, images: 'per-model', tools: 'cere', webSearch: true, importHistory: false, resume: false, queue: true, configure: true, billed: false,
    remote: 'restricted', remoteNote: 'Runs on the desktop’s granted Ollama server with Cere’s tools limited to this phone’s grants.' },
  antigravity: { label: providerLabels.antigravity, kind: 'cli', modelRequired: false, customModel: false, effort: false, images: 'no', tools: 'native', webSearch: false, importHistory: false, resume: true, queue: false, configure: false, billed: false,
    remote: 'withheld', remoteNote: 'AntiGravity’s headless mode cannot prove restricted execution, so turns start only on the desktop. Its conversations can still be read here.' },
  openai: { label: providerLabels.openai, kind: 'api', modelRequired: true, customModel: true, effort: false, images: 'yes', tools: 'cere', webSearch: true, importHistory: false, resume: false, queue: false, configure: true, billed: true,
    remote: 'restricted', remoteNote: 'Uses the desktop’s API key; requests may be billed. Cere’s tools stay limited to this phone’s grants.' },
  anthropic: { label: providerLabels.anthropic, kind: 'api', modelRequired: true, customModel: true, effort: false, images: 'yes', tools: 'cere', webSearch: true, importHistory: false, resume: false, queue: false, configure: true, billed: true,
    remote: 'restricted', remoteNote: 'Uses the desktop’s API key; requests may be billed. Cere’s tools stay limited to this phone’s grants.' },
  google: { label: providerLabels.google, kind: 'api', modelRequired: true, customModel: true, effort: false, images: 'yes', tools: 'cere', webSearch: true, importHistory: false, resume: false, queue: false, configure: true, billed: true,
    remote: 'restricted', remoteNote: 'Uses the desktop’s API key; requests may be billed. Cere’s tools stay limited to this phone’s grants.' },
  compatible: { label: providerLabels.compatible, kind: 'api', modelRequired: true, customModel: true, effort: false, images: 'per-endpoint', tools: 'cere', webSearch: true, importHistory: false, resume: false, queue: false, configure: true, billed: true,
    remote: 'restricted', remoteNote: 'Uses the endpoint the desktop granted to this phone; a changed endpoint needs a new grant.' },
};
