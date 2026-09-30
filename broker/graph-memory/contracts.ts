import { z } from "zod";
export const PROTOCOL_VERSION = 1;
export const ONTOLOGY_VERSION = 1;
export const id = z.string().uuid();
export const entityTypes = [
  "User",
  "Project",
  "Task",
  "Tool",
  "Document",
  "Directory",
  "Checkout",
  "Repository",
  "Action",
  "Outcome",
  "Topic",
] as const;
export const entitySchema = z
  .object({
    id: id.optional(),
    type: z.enum(entityTypes),
    name: z.string().trim().min(1).max(500),
    external_id: z.string().max(1000).optional(),
  })
  .strict();
export const predicates = [
  "WORKS_ON",
  "USES_TOOL",
  "PREFERS_TOOL",
  "BELONGS_TO",
  "CHECKOUT_OF",
  "IMPLEMENTS",
  "DEPENDS_ON",
  "BLOCKED_BY",
  "LOCATED_AT",
  "HAS_STATE",
  "RELATED_TO",
] as const;
export const claimSchema = z
  .object({
    subject: entitySchema,
    predicate: z.enum(predicates),
    object: entitySchema.optional(),
    value: z
      .union([z.string().max(2000), z.number().finite(), z.boolean()])
      .optional(),
    qualifiers: z
      .record(
        z.string(),
        z.union([z.string().max(500), z.number().finite(), z.boolean()]),
      )
      .default({}),
    polarity: z.enum(["positive", "negative"]).default("positive"),
    modality: z
      .enum(["actual", "planned", "hypothetical", "reported", "inferred"])
      .default("actual"),
    epistemic_type: z
      .enum([
        "explicit_user",
        "instrumented",
        "document_claim",
        "inference",
        "derived_summary",
      ])
      .default("explicit_user"),
    valid_mode: z
      .enum(["bounded", "known_current", "atemporal", "unknown"])
      .default("known_current"),
    valid_from_us: z.number().int().safe().nullable().default(null),
    valid_to_us: z.number().int().safe().nullable().default(null),
    time_precision: z
      .enum(["instant", "date", "approximate", "unknown"])
      .default("unknown"),
    time_zone: z.string().max(100).default("UTC"),
    time_expression: z.string().max(500).default(""),
    extraction_confidence: z.number().min(0).max(1).default(1),
  })
  .strict()
  .superRefine((v, c) => {
    if(v.valid_mode!=='bounded'&&(v.valid_from_us!==null||v.valid_to_us!==null))c.addIssue({code:'custom',message:'Uncertain and atemporal modes cannot invent validity bounds'});
    if ((v.object === undefined) === (v.value === undefined))
      c.addIssue({
        code: "custom",
        message: "Exactly one object or literal required",
      });
    if (v.valid_mode === "bounded" && v.valid_from_us === null)
      c.addIssue({
        code: "custom",
        message: "Bounded validity requires a start",
      });
    if (
      v.valid_to_us !== null &&
      (v.valid_from_us === null || v.valid_to_us <= v.valid_from_us)
    )
      c.addIssue({ code: "custom", message: "Invalid half-open interval" });
  });
export type Claim = z.infer<typeof claimSchema>;
export const witnessSchema = z
  .object({
    observation_id: id,
    quote: z.string().min(1).max(16000),
    occurrence: z.number().int().min(0).default(0),
  })
  .strict();
export const policySchema = z
  .object({
    enabled: z.boolean().default(false),
    allow_cloud_memory: z.boolean().default(false),
    history_enabled: z.boolean().default(false),
    capture_titles: z.boolean().default(false),
    // Titles are captured only for these exact application classes, and only with capture_titles.
    title_applications: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
    hyprland_enabled: z.boolean().default(false),
    fish_enabled: z.boolean().default(false),
    kitty_enabled: z.boolean().default(false),
    filesystem_enabled: z.boolean().default(false),
    approved_roots: z.array(z.string().min(1)).max(64).default([]),
    read_file_content: z.boolean().default(false),
    retain_evidence: z.boolean().default(true),
    raw_turn_days: z.number().int().min(1).max(3650).default(30),
    candidate_days: z.number().int().min(1).max(365).default(7),
    half_life_days: z.number().min(1).max(36500).default(90),
    memory_token_budget: z.number().int().min(128).max(16000).default(4000),
    deadline_ms: z.number().int().min(25).max(10000).default(500),
    max_nodes: z.number().int().min(1).max(200).default(200),
    max_edges: z.number().int().min(1).max(500).default(500),
    max_neighbors: z.number().int().min(1).max(20).default(20),
    semantic_depth: z.number().int().min(0).max(3).default(2),
    relational_ranker: z.boolean().default(true),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;
export class MemoryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}
export function fail(code: string, message: string): never {
  throw new MemoryError(code, message);
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    fail(
      "INVALID_ARGUMENT",
      "Memory request does not match the versioned schema",
    );
  return r.data;
}
export function strict(value: unknown, keys: string[]): Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail("INVALID_ARGUMENT", "Unknown or invalid memory request fields");
  return value as Record<string, any>;
}
export function safeText(value: unknown, max = 16000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value).length > max ||
    value.includes("\0")
  )
    fail("INVALID_ARGUMENT", "Invalid memory text");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b|(?:password|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*\S+/i.test(
      value,
    )
  )
    fail(
      "POLICY_DENIED",
      "Sensitive source content was rejected before persistence",
    );
  return value;
}
