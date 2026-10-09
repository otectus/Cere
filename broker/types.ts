import { defaultExtractionModel } from './graph-memory/models.ts';
import { providerIds } from './provider-catalog.ts';
import { defaultElevenConfig, type ElevenConfig } from './elevenlabs.ts';
import { defaultPersonality } from './personality.ts';
import type { RemoteExecution } from './execution.ts';
import { defaultIndexConfig, type IndexConfig } from './indextts-config.ts';

export type Provider = typeof import('./provider-catalog.ts').providerIds[number];
export type EffortOption = { id: string; displayName: string; description?: string };
export type ModelOption = {
  id: string; displayName: string; description: string; efforts: EffortOption[];
  defaultEffort: string; isDefault: boolean; resolvedModel?: string;
  capabilities?: string[]; cloud?: boolean; contextLength?: number;
  /** The provider's advertised output-token ceiling, when its catalog states one. */
  maxOutputTokens?: number;
};
export type Status = 'idle' | 'starting' | 'working' | 'waiting' | 'stopping' | 'error' | 'interrupted' | 'disconnected';
export type SessionActivity = 'thinking' | 'speaking' | 'working' | 'delegating' | 'waitingForAgents' | 'compacting' | 'planning';
export type AgentActivity = {
  id: string; name: string; task?: string;
  status: 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'closed';
  detail?: string; parentId?: string; updated: number;
};
export type Session = {
  id: string; provider: Provider; nativeId: string | null; title: string; cwd: string;
  mode: 'managed' | 'linked' | 'historical'; status: Status; created: number; updated: number;
  draft: string; scroll: number; model: string; effort?: string; error?: string; activity?: SessionActivity;
  ollama?: { host: string; tools: boolean }; parentId?: string;
  api?: { tools: boolean };
  revision?: string; draftRevision?: string; configRevision?: string; turnId?: string;
  remote?: RemoteExecution; effectivePolicy?: 'restricted' | 'unknown';
  agents?: AgentActivity[];
  folderId?: string; pinned?: boolean; archived?: boolean; readAt?: number; unread?:boolean;
  draftAttachments?: Attachment[];
  queuedCount?: number;
  temporary?: boolean;
  view?: DraftView;
};
/** Desktop composer and reading position, carried between the compact panel and the workspace. */
export type DraftView = {
  cursor: number; selectionStart: number; selectionEnd: number;
  webSearch: boolean; activityExpanded: boolean;
  // The message at the top of the conversation; the offset is how far into it, in ten-thousandths of its height.
  anchorId: string; anchorOffset: number; atEnd: boolean;
  focus: '' | 'composer';
};
export type Attachment = { id: string; path: string; name: string; mime: string; kind: 'image' | 'text'; size: number; sha256: string };
export type SessionFolder = { id: string; name: string; revision: string; created: number; updated: number };
export type ProjectDefaults = { provider: Provider; model: string; effort: string; tools: boolean; trusted: boolean; temporary: boolean };
export type Project = { cwd: string; name: string; revision: string; updated: number; favorite: boolean; defaults: ProjectDefaults };
export type Source = { title: string; url: string };
export type Message = { id: string; sessionId: string; role: string; text: string; time: number; kind?: string; sources?: Source[]; revision?: string; turnId?: string };
export type RunCompletion = {
  id: string; sessionId: string; turnId?: string; title: string; provider: Provider; cwd: string; time: number;
  message: Message & { truncated?: boolean };
  companion?: boolean;
  verification?: 'not-run' | 'passed' | 'failed' | 'inconclusive';
  evidence?: { label: string; path?: string; command?: string; exitCode?: number; observedAt: number }[];
};
export type SearchProvider = 'auto' | 'duckduckgo' | 'brave' | 'mojeek' | 'searxng';
export type Settings = {
  telemetry: import('./telemetry/protocol.ts').TelemetryConfig;
  personality: string;
  ttsProvider:'local'|'indextts'|'elevenlabs'; indextts:IndexConfig; elevenlabs:ElevenConfig;
  voice: string; speechEnabled: boolean; speechProviders:Record<Provider,boolean>; speechRate:number; speechPitch:number; speechVolume:number; speechBrief:boolean; transcription:{executable:string;model:string};
  ollama: { host: string; model: string };
  webSearch: { enabled: boolean; provider: SearchProvider; searxngUrl: string };
  memory: { enabled: boolean; model: string; extractionModel?: string; allowCloudMemory?: boolean; allowCloudExtraction?: boolean };
  desktopProfile: 'normal'|'focus'|'gaming'|'presentation'; interfaceScale:number; homePositions:Record<string,{x:number;y:number}>;
  topmost: boolean; scale: number; roaming: boolean; quiet: boolean; reducedMotion: boolean;
  motionIntensity: number; expressiveCues: boolean; idleEnergy: 'calm' | 'lively';
  hidden: boolean; profile: 'manual' | 'scoped' | 'broad'; paused: boolean;
  bypassCliPermissions: boolean; bypassComputerPermissions: boolean;
  categories: string[]; grants: { category: string; cwd: string; expires: number }[];
  position: { output: string; x: number; y: number }; roamArea: { left: number; right: number; top: number; bottom: number };
  onboarding: boolean; scripts: { id: string; name: string; executable: string; args: string[]; cwd: string; timeout: number }[];
};
export type Question = {
  id: string; question: string; header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean; isSecret?: boolean; allowOther?: boolean; required?: boolean;
};
export type Approval = {
  id: string; sessionId: string; kind: string; title: string; detail: string;
  choices: string[]; questions?: Question[];
  time: number;
  nativeRequestId?: string | number;
  nativeThreadId?: string;
  image?: string;
  url?: string;
  fields?: Record<string, any>;
  remoteAllow?: boolean;
};
export type ProviderEvent = { type: string; id?: string; text?: string; data?: any };
export type SendOptions = {
  webSearch?: boolean;
  /** Reauthorize immediately before the provider request can leave the broker. */
  beforeAccept?: () => void;
  /** The request left the broker, so a missing acknowledgement has an unknown outcome. */
  onDispatched?: () => void;
  /** The provider positively acknowledged the turn. */
  onAccepted?: () => void;
  /** The provider positively rejected the dispatched turn without starting it. */
  onRejected?: () => void;
  /** The provider accepted the turn. Unlike onAccepted, send() does not wait for it. */
  acknowledged?: () => void;
};
export interface Adapter {
  /** Refuses input this provider cannot accept, before the turn is recorded or dispatched. */
  preflight?(images: string[], signal: AbortSignal): Promise<void>;
  send(text: string, images?: string[], options?: SendOptions): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export const defaultSettings: Settings = {
  telemetry: { enabled:false, roots:[], ignores:[], commands:false, output:false },
  personality: defaultPersonality,
  ttsProvider:'local', indextts:structuredClone(defaultIndexConfig), elevenlabs:structuredClone(defaultElevenConfig),
  voice: 'en_US-amy-medium', speechEnabled: true, speechProviders:Object.fromEntries(providerIds.map(id=>[id,true])) as Record<Provider,boolean>, speechRate:1, speechPitch:0, speechVolume:1, speechBrief:false, transcription:{executable:'',model:''},
  ollama: { host: 'http://127.0.0.1:11434', model: '' },
  webSearch: { enabled: false, provider: 'auto', searxngUrl: '' },
  memory: { enabled: false, model: 'nomic-embed-text', extractionModel: defaultExtractionModel },
  desktopProfile: 'normal', interfaceScale:1, homePositions:{},
  topmost: true, scale: 1, roaming: false, quiet: false, reducedMotion: false, motionIntensity: .7, expressiveCues: true, idleEnergy: 'lively', hidden: false,
  profile: 'scoped', paused: false, bypassCliPermissions: false, bypassComputerPermissions: false, categories: [], grants: [],
  position: { output: '', x: 0.86, y: 0.78 }, roamArea: { left: 0.05, right: 0.95, top: 0.5, bottom: 0.95 },
  onboarding: true, scripts: [],
};

export type ToolDefinition = { name: string; title: string; category: string; description: string; schema: Record<string, any>; required?: string[]; readOnly?: boolean };
