import { defaultPersonality } from './personality.ts';

export type Provider = 'codex' | 'claude' | 'ollama';
export type EffortOption = { id: string; displayName: string; description?: string };
export type ModelOption = {
  id: string; displayName: string; description: string; efforts: EffortOption[];
  defaultEffort: string; isDefault: boolean; resolvedModel?: string;
  capabilities?: string[]; cloud?: boolean; contextLength?: number;
};
export type Status = 'idle' | 'starting' | 'working' | 'waiting' | 'stopping' | 'error' | 'interrupted' | 'disconnected';
export type SessionActivity = 'thinking' | 'speaking' | 'working';
export type Session = {
  id: string; provider: Provider; nativeId: string | null; title: string; cwd: string;
  mode: 'managed' | 'linked' | 'historical'; status: Status; created: number; updated: number;
  draft: string; scroll: number; model: string; effort?: string; error?: string; activity?: SessionActivity;
  ollama?: { host: string; tools: boolean }; parentId?: string;
};
export type Source = { title: string; url: string };
export type Message = { id: string; sessionId: string; role: string; text: string; time: number; kind?: string; sources?: Source[] };
export type SearchProvider = 'auto' | 'duckduckgo' | 'brave' | 'mojeek' | 'searxng';
export type Settings = {
  personality: string;
  ollama: { host: string; model: string };
  webSearch: { enabled: boolean; provider: SearchProvider; searxngUrl: string };
  memory: { enabled: boolean; model: string; extractionModel?: string; allowCloudMemory?: boolean; allowCloudExtraction?: boolean };
  topmost: boolean; scale: number; roaming: boolean; quiet: boolean; reducedMotion: boolean;
  motionIntensity: number; expressiveCues: boolean;
  hidden: boolean; profile: 'manual' | 'scoped' | 'broad'; paused: boolean;
  bypassCliPermissions: boolean; bypassComputerPermissions: boolean;
  categories: string[]; grants: { category: string; cwd: string; expires: number }[];
  position: { output: string; x: number; y: number }; roamArea: { left: number; right: number; top: number; bottom: number };
  onboarding: boolean; scripts: { id: string; name: string; executable: string; args: string[]; cwd: string; timeout: number }[];
};
export type Approval = {
  id: string; sessionId: string; kind: string; title: string; detail: string;
  choices: string[]; questions?: { id: string; question: string; options?: { label: string; description?: string }[] }[];
  time: number;
  nativeRequestId?: string | number;
  image?: string;
  fields?: Record<string, any>;
};
export type ProviderEvent = { type: string; id?: string; text?: string; data?: any };
export interface Adapter {
  send(text: string, images?: string[], options?: { webSearch?: boolean }): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export const defaultSettings: Settings = {
  personality: defaultPersonality,
  ollama: { host: 'http://127.0.0.1:11434', model: '' },
  webSearch: { enabled: false, provider: 'auto', searxngUrl: '' },
  memory: { enabled: false, model: 'nomic-embed-text' },
  topmost: true, scale: 1, roaming: false, quiet: false, reducedMotion: false, motionIntensity: .7, expressiveCues: true, hidden: false,
  profile: 'scoped', paused: false, bypassCliPermissions: false, bypassComputerPermissions: false, categories: [], grants: [],
  position: { output: '', x: 0.86, y: 0.78 }, roamArea: { left: 0.05, right: 0.95, top: 0.5, bottom: 0.95 },
  onboarding: true, scripts: [],
};

export type ToolDefinition = { name: string; title: string; category: string; description: string; schema: Record<string, any>; required?: string[]; readOnly?: boolean };
