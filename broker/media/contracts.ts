/**
 * Image backend contracts. Understanding, generation, editing, masks, references and deterministic
 * transforms are separate capabilities: a backend states each one with its evidence, and a request is
 * validated against them before anything is submitted. The broker resolves bytes and credentials; a
 * model supplies neither a path nor an endpoint.
 */
import type { CapabilityValue, ProcessingRoute } from '../tools/contracts.ts';

export type ImageOperation = 'generate' | 'edit' | 'masked-edit' | 'extend' | 'reference';
export type ImageCapabilities = {
  backend: 'openai' | 'google' | 'comfyui';
  model: string;
  route: ProcessingRoute;
  generate: CapabilityValue; edit: CapabilityValue; mask: CapabilityValue;
  /** How a mask is honored: exact (the backend preserves outside pixels), guide (prompt-like guidance) or none. */
  maskBehavior: 'exact' | 'guide' | 'none';
  maxReferences: number;
  formats: ('png' | 'jpeg' | 'webp')[];
  transparency: CapabilityValue;
  sizes: string[];
  customSize?: { multiple: number; minAspect: number; maxAspect: number; maxWidth: number; maxHeight: number };
  aspectRatios?: string[];
  imageSizes?: string[];
  qualities?: string[];
  maxCount: number;
  partials: CapabilityValue;
  seed: CapabilityValue;
  negativePrompt: CapabilityValue;
  usage: CapabilityValue;
  cancel: CapabilityValue;
  query: CapabilityValue;
  /** Plain notes shown before use: cost, preview status, watermarking. */
  notes: string[];
  billed: boolean;
};
export type ImageReference = { artifactId: string; versionId: string; role: 'edit-base' | 'subject' | 'composition' | 'style' | 'mask' };
export type ImageRequest = {
  operation: ImageOperation;
  prompt: string;
  negativePrompt?: string;
  references: ImageReference[];
  /** The mask as Cere stores it: grayscale where 255 edits and 0 preserves, the base's exact size. */
  mask?: { artifactId: string; versionId: string; feather?: number };
  size?: string; aspectRatio?: string; imageSize?: string;
  format: 'png' | 'jpeg' | 'webp';
  background?: 'transparent' | 'opaque' | 'auto';
  quality?: string;
  count: number;
  seed?: number;
  /** Keep pixels outside the mask exactly as they were, by compositing the result over the original. */
  protectOutside?: boolean;
  partials?: boolean;
};
/** A request the backend accepted after validation, with any visible adjustment it required. */
export type ValidatedImageRequest = ImageRequest & { adjustments: string[]; connectionId: string; connectionRevision: number };
export type ImageEvent =
  | { type: 'accepted'; remoteId?: string }
  | { type: 'queued'; position?: number }
  | { type: 'progress'; value?: number; max?: number; note?: string }
  | { type: 'partial'; bytes: Buffer; index: number }
  | { type: 'image'; bytes: Buffer; mime: string; revisedPrompt?: string; index: number }
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Record<string, number> }
  | { type: 'warning'; message: string }
  | { type: 'continuation'; id: string };
/** Inputs the service resolved for one submission: bytes never leave the broker except to the chosen backend. */
export type ResolvedInputs = { references: { bytes: Buffer; mime: string; width: number; height: number; role: ImageReference['role'] }[]; mask?: { bytes: Buffer; width: number; height: number } };
export interface ImageBackend {
  describe(): ImageCapabilities;
  validate(request: ImageRequest): { request: ImageRequest; adjustments: string[] };
  /** Submits once and streams what the backend reports. A thrown error after dispatch is an unknown outcome unless marked otherwise. */
  run(request: ValidatedImageRequest, inputs: ResolvedInputs, context: BackendContext): AsyncIterable<ImageEvent>;
  query?(remoteId: string, context: Pick<BackendContext, 'fetch' | 'signal'>): Promise<{ state: 'queued' | 'running' | 'completed' | 'failed' | 'missing'; images?: { bytes: Buffer; mime: string }[]; error?: string }>;
  cancel?(remoteId: string, context: Pick<BackendContext, 'fetch' | 'signal'>): Promise<{ confirmed: boolean; note: string }>;
}
export type BackendContext = {
  signal: AbortSignal;
  /** Re-checks authorization immediately before the request leaves the broker. */
  beforeDispatch(): void;
  /** Records that the request left the broker; from here an interruption is an unknown outcome. */
  dispatched(remoteId?: string): void;
  fetch: typeof fetch;
  key(): string;
};
/** A refusal the backend reported without doing the work: known, not unknown. */
export class BackendRefusal extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
