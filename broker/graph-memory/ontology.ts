import { fail, type Claim } from "./contracts.ts";
const rules: Record<
  string,
  {
    subjects: string[];
    objects: string[];
    single: boolean;
    qualifiers: string[];
  }
> = {
  WORKS_ON: {
    subjects: ["User"],
    objects: ["Project", "Task"],
    single: false,
    qualifiers: [],
  },
  USES_TOOL: {
    subjects: ["Project", "User"],
    objects: ["Tool"],
    single: false,
    qualifiers: ["purpose"],
  },
  PREFERS_TOOL: {
    subjects: ["User"],
    objects: ["Tool"],
    single: true,
    qualifiers: ["category", "purpose"],
  },
  BELONGS_TO: {
    subjects: ["Document", "Directory"],
    objects: ["Checkout", "Project"],
    single: true,
    qualifiers: [],
  },
  CHECKOUT_OF: {
    subjects: ["Checkout"],
    objects: ["Repository"],
    single: true,
    qualifiers: [],
  },
  IMPLEMENTS: {
    subjects: ["Repository"],
    objects: ["Project"],
    single: false,
    qualifiers: [],
  },
  DEPENDS_ON: {
    subjects: ["Task", "Project"],
    objects: ["Task", "Project", "Tool"],
    single: false,
    qualifiers: [],
  },
  BLOCKED_BY: {
    subjects: ["Task"],
    objects: ["Task", "Document", "Outcome"],
    single: false,
    qualifiers: [],
  },
  LOCATED_AT: {
    subjects: ["Document", "Checkout"],
    objects: ["Directory"],
    single: true,
    qualifiers: ["device"],
  },
  HAS_STATE: {
    subjects: ["Task", "Action"],
    objects: [],
    single: true,
    qualifiers: ["dimension"],
  },
  RELATED_TO: {
    subjects: ["Topic"],
    objects: ["Topic"],
    single: false,
    qualifiers: [],
  },
};
export function validateClaim(c: Claim) {
  const r = rules[c.predicate];
  if (
    !r.subjects.includes(c.subject.type) ||
    (c.object && !r.objects.includes(c.object.type)) ||
    (!c.object && !["LOCATED_AT", "HAS_STATE"].includes(c.predicate))
  )
    fail("INVALID_ARGUMENT", "Predicate entity or literal type mismatch");
  if (Object.keys(c.qualifiers).some((k) => !r.qualifiers.includes(k)))
    fail("INVALID_ARGUMENT", "Unregistered identity qualifier");
  if (
    c.predicate === "HAS_STATE" &&
    ![
      "open",
      "blocked",
      "running",
      "proposed",
      "authorized",
      "succeeded",
      "failed",
      "cancelled",
      "closed",
      "unknown",
    ].includes(String(c.value))
  )
    fail("INVALID_ARGUMENT", "Unregistered state");
  return {
    ...r,
    single: r.single || (c.predicate === "USES_TOOL" && !!c.qualifiers.purpose),
  };
}
export const normalized = (s: string) =>
  s.normalize("NFC").trim().toLocaleLowerCase("und");
export function stableJSON(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
export function span(text: string, quote: string, occurrence: number) {
  const chars = Array.from(text),
    needle = Array.from(quote);
  let n = 0;
  for (let i = 0; i <= chars.length - needle.length; i++) {
    if (needle.every((c, j) => chars[i + j] === c)) {
      if (n++ === occurrence) return { start: i, end: i + needle.length };
    }
  }
  fail(
    "INVALID_ARGUMENT",
    "Evidence quotation is absent from sanitized source",
  );
}
