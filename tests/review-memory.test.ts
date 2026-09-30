import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Canonical } from "../broker/graph-memory/canonical.ts";
import { schema, migrations } from "../broker/graph-memory/schema.ts";

// Regressions for the canonical-engine findings of docs/REVIEW.md.
function fixture(t: any, directory = mkdtempSync(join(tmpdir(), "cere-review-"))) {
  const c = new Canonical(directory);
  t.after(() => { try { c.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const scope = c.registerScope({ key: "fixture", label: "Fixture" }).id;
  return { c, scope, directory };
}
const tool = (name: string, qualifiers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  subject: { type: "Project", name: "Atlas" }, predicate: "USES_TOOL", object: { type: "Tool", name }, qualifiers, ...extra,
});
const observe = (c: Canonical, scope: string, text: string, extra: Record<string, unknown> = {}) =>
  c.observeText({ scope_id: scope, text, role: "user", ...extra });
const remember = (c: Canonical, scope: string, text: string, claim: any, extra: Record<string, unknown> = {}) => {
  const o = observe(c, scope, text);
  return c.remember({ scope_id: scope, claim, witness: { observation_id: o.id, quote: text }, ...extra });
};
const claims = (c: Canonical, scope: string, text: string) => c.retrieve({ scope_id: scope, text }).assertions.map((a: any) => a.claim);
/** Every table value that could still carry forgotten content. */
function leaks(c: Canonical, needle: string) {
  const found: string[] = [];
  for (const table of ["payloads", "evidence", "retrieval_documents", "entities", "assertion_versions", "artifacts", "embedding_records"])
    if (JSON.stringify(c.all(`SELECT * FROM ${table} WHERE ${table === "assertion_versions" ? "erased=0" : "1"}`)).includes(needle)) found.push(table);
  return found;
}

test("F-003 forgetting an edited note by its visible ID removes every revision, witness and derived fact", (t) => {
  const { c, scope } = fixture(t);
  const note = c.saveText({ scope_id: scope, text: "Atlas uses Black for formatting." });
  const listed = c.list({ scope_id: scope, kind: "saved" }).rows[0];
  assert.equal(listed.id, note.id);
  c.saveText({ scope_id: scope, id: note.id, text: "Atlas uses Ruff for formatting.", expected_revision: listed.revision });
  const second = c.list({ scope_id: scope, kind: "saved" }).rows[0];
  c.saveText({ scope_id: scope, id: note.id, text: "Atlas uses Biome for formatting.", expected_revision: second.revision });
  // Extract from each revision as extraction would, and index an embedding for the latest note.
  for (const text of ["Atlas uses Ruff for formatting.", "Atlas uses Biome for formatting."]) {
    const source = c.one("SELECT o.id FROM observations o JOIN payloads p ON p.id=o.payload_id WHERE p.body=?", text).id;
    c.remember({ scope_id: scope, claim: tool(text.split(" ")[2]), witness: { observation_id: source, quote: text } });
  }
  const artifact = c.one("SELECT * FROM artifacts WHERE kind='saved' AND record_id=? AND known_to_revision IS NULL", note.id);
  c.run("INSERT INTO embedding_records VALUES (?,?,?,?,?,?)", artifact.id, artifact.content_revision, "fingerprint", "1", "point", "[1,0]");
  const erased = c.forget({ scope_id: scope, id: c.list({ scope_id: scope, kind: "saved" }).rows[0].id });
  assert.equal(erased.suppressed, true);
  for (const needle of ["Black", "Ruff", "Biome"]) {
    assert.deepEqual(leaks(c, needle), [], needle);
    assert.deepEqual(claims(c, scope, needle), []);
  }
  assert.equal(c.one("SELECT COUNT(*) AS n FROM observations WHERE erased=0 AND id IN (SELECT observation_id FROM note_revisions WHERE note_id=?)", note.id).n, 0);
  const registry = readFileSync(join(c.directory, "erasure-registry.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual(registry.selector, { kind: "note", id: note.id });
});

test("F-003 a logical assertion ID removes every occurrence; an observation keeps independent support", (t) => {
  const { c, scope } = fixture(t);
  remember(c, scope, "Atlas uses Ruff.", tool("Ruff"));
  const current = remember(c, scope, "Atlas uses Ruff.", tool("Ruff"));
  const logical = c.one("SELECT logical_id FROM assertion_versions WHERE version_id=?", current.id).logical_id;
  assert.equal(c.inspect({ scope_id: scope, id: logical }).record.version_id, current.id);
  c.forget({ scope_id: scope, id: logical });
  assert.deepEqual(claims(c, scope, "Ruff"), []);
  assert.deepEqual(leaks(c, "Atlas uses Ruff"), []);
  // Deleting only one explicitly selected occurrence still preserves an independently supported fact.
  const first = observe(c, scope, "Atlas uses Zed.");
  c.remember({ scope_id: scope, claim: tool("Zed"), witness: { observation_id: first.id, quote: "Atlas uses Zed." } });
  remember(c, scope, "Atlas uses Zed.", tool("Zed"));
  c.forget({ scope_id: scope, id: first.id });
  assert.match(claims(c, scope, "Zed").join(), /Zed/);
});

test("F-003 a pre-erasure backup replayed with the current registry suppresses every note revision", async (t) => {
  const { c, scope, directory } = fixture(t);
  const note = c.saveText({ scope_id: scope, text: "Atlas uses Black for formatting." });
  c.saveText({ scope_id: scope, id: note.id, text: "Atlas uses Ruff for formatting.", expected_revision: c.list({ scope_id: scope, kind: "saved" }).rows[0].revision });
  const backup = join(directory, "before.sqlite");
  await c.backup({ output: backup });
  c.forget({ scope_id: scope, id: note.id });
  const staging = join(directory, "restored");
  await c.restore({ input: backup, staging });
  const restored = new Canonical(staging);
  try {
    assert.deepEqual(leaks(restored, "Ruff"), []);
    assert.equal(restored.retrieve({ scope_id: scope, text: "Ruff formatting" }).results.length, 0);
  } finally { restored.close(); }
});

/** Rebuilds the database written by the pinned engine (see tests/fixtures/memory/legacy-v1.json). */
function legacyDatabase() {
  const data = JSON.parse(readFileSync(new URL("./fixtures/memory/legacy-v1.json", import.meta.url), "utf8"));
  const directory = mkdtempSync(join(tmpdir(), "cere-legacy-"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "memory.sqlite"));
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec(schema);
  for (const [table, rows] of Object.entries(data.tables) as [string, any[]][]) {
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k]));
    }
  }
  db.close();
  writeFileSync(join(directory, "erasure-registry.jsonl"), data.registry.join("\n") + "\n", { mode: 0o600 });
  return { directory, ids: data.ids, registry: data.registry as string[] };
}

test("F-003 upgrading a pinned database repairs leaked edits and logical facts idempotently", (t) => {
  const legacy = legacyDatabase();
  t.after(() => rmSync(legacy.directory, { recursive: true, force: true }));
  const open = () => new Canonical(legacy.directory);
  let c = open();
  try {
    assert.equal(c.one("SELECT MAX(id) AS n FROM schema_migrations").n, migrations.at(-1)!.id);
    assert.equal(c.one("SELECT erased FROM observations WHERE id=?", legacy.ids.replacement).erased, 1, "leaked replacement is suppressed");
    assert.deepEqual(claims(c, legacy.ids.scope, "Ruff").filter((x: string) => /Ruff/.test(x)), []);
    assert.deepEqual(claims(c, legacy.ids.scope, "Kitty").filter((x: string) => /Kitty/.test(x)), []);
    // The independently supported occurrence deletion is ambiguous for a legacy entry: exposed, not widened.
    assert.match(claims(c, legacy.ids.scope, "Zed").join(), /Zed/);
    const health = c.health();
    assert.equal(health.erasure_registry.supplemented, 2);
    assert.equal(health.erasure_registry.unresolved.length, 1);
    assert.equal(health.erasure_registry.unresolved[0].reason, "LEGACY_SELECTOR_AMBIGUOUS");
    assert.ok(c.one("SELECT COUNT(*) AS n FROM outbox WHERE state='pending'").n > 0, "repair is queued for purge");
  } finally { c.close(); }
  const lines = readFileSync(join(legacy.directory, "erasure-registry.jsonl"), "utf8").trim().split("\n");
  assert.deepEqual(lines.slice(0, legacy.registry.length), legacy.registry, "original entries stay immutable");
  for (let reopen = 0; reopen < 2; reopen++) {
    c = open();
    try { assert.equal(c.health().erasure_registry.supplemented, 0); } finally { c.close(); }
  }
  assert.equal(readFileSync(join(legacy.directory, "erasure-registry.jsonl"), "utf8").trim().split("\n").length, lines.length, "reopening appends nothing");
});

test("migrations apply in order, reject tampering, and roll back a failed step", (t) => {
  const legacy = legacyDatabase();
  t.after(() => rmSync(legacy.directory, { recursive: true, force: true }));
  migrations.push({ id: migrations.at(-1)!.id + 1, sql: "CREATE TABLE migration_probe(id INTEGER) STRICT; INSERT INTO no_such_table VALUES (1);" });
  try { assert.throws(() => new Canonical(legacy.directory), /no such table/); }
  finally { migrations.pop(); }
  const db = new DatabaseSync(join(legacy.directory, "memory.sqlite"));
  try {
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='migration_probe'").get(), undefined);
    assert.equal((db.prepare("SELECT MAX(id) AS n FROM schema_migrations").get() as any).n, migrations.at(-1)!.id);
  } finally { db.close(); }
  const c = new Canonical(legacy.directory); c.close();
  const tampered = new DatabaseSync(join(legacy.directory, "memory.sqlite"));
  tampered.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE id=2").run(); tampered.close();
  assert.throws(() => new Canonical(legacy.directory), /modified memory migration/);
});

test("F-006 a forget confirmation is bound to the previewed record and targets", (t) => {
  const { c, scope } = fixture(t);
  const alpha = c.saveText({ scope_id: scope, text: "Alpha note." }), beta = c.saveText({ scope_id: scope, text: "Beta note." });
  const preview = c.forgetPreview({ scope_id: scope, id: alpha.id });
  assert.throws(() => c.forget({ scope_id: scope, id: beta.id, expected_revision: preview.revision, selection: preview.selection }), /differs from the previewed/);
  assert.equal(c.one("SELECT erased FROM observations WHERE id=?", alpha.id).erased, 0);
  assert.equal(c.one("SELECT erased FROM observations WHERE id=?", beta.id).erased, 0);
  c.saveText({ scope_id: scope, text: "Unrelated change." });
  assert.throws(() => c.forget({ scope_id: scope, id: alpha.id, expected_revision: preview.revision, selection: preview.selection }), /changed since forget preview/);
  const fresh = c.forgetPreview({ scope_id: scope, id: beta.id });
  c.forget({ scope_id: scope, id: beta.id, expected_revision: fresh.revision, selection: fresh.selection });
  assert.equal(c.one("SELECT erased FROM observations WHERE id=?", beta.id).erased, 1);
  assert.equal(c.one("SELECT erased FROM observations WHERE id=?", alpha.id).erased, 0);
});

test("F-009 forgetting or a benign policy edit never strands unrelated extraction work", (t) => {
  const { c, scope } = fixture(t);
  c.policyUpdate({ policy: { enabled: true } });
  const other = c.registerScope({ key: "other", label: "Other" }).id;
  const forget = observe(c, scope, "Forget me");
  const keep = observe(c, other, "Keep me");
  const inFlight = c.extractionNext()!;
  assert.equal(inFlight.observation_id, forget.id);
  c.forget({ scope_id: scope, id: forget.id });
  // The stale in-flight result stays rejected, and cannot be marked retryable either.
  assert.throws(() => c.extractionResult({ id: inFlight.id, identity: {} }), /changed/);
  assert.throws(() => c.extractionResult({ id: inFlight.id, error: "MODEL_UNAVAILABLE_OR_INVALID" }), /changed/);
  let next = c.extractionNext()!;
  assert.equal(next.observation_id, keep.id, "the surviving source is rescheduled under the new epoch");
  c.policyUpdate({ policy: { half_life_days: 100 } });
  assert.throws(() => c.applyExtraction({ id: next.id, proposals: [] }), /changed/);
  next = c.extractionNext()!;
  assert.equal(next.observation_id, keep.id, "a ranking edit reschedules rather than revokes");
  c.extractionResult({ id: next.id, identity: { model: "fixture" } });
  assert.deepEqual(c.applyExtraction({ id: next.id, proposals: [] }), []);
  // Disabled capture dispatches nothing; re-enabling resumes permitted backlog.
  const later = observe(c, other, "Keep me too");
  c.policyUpdate({ policy: { enabled: false } });
  assert.equal(c.extractionNext(), null);
  c.policyUpdate({ policy: { enabled: true } });
  assert.equal(c.extractionNext()!.observation_id, later.id);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM extraction_runs WHERE status='revoked'").n, 0);
});

test("F-009 restart reconciles stale queued runs and retry revalidates revoked ones", (t) => {
  const { c, scope, directory } = fixture(t);
  c.policyUpdate({ policy: { enabled: true } });
  const source = observe(c, scope, "Keep this source");
  c.run("UPDATE extraction_runs SET status='revoked',policy_epoch=-1 WHERE observation_id=?", source.id);
  c.close();
  const reopened = new Canonical(directory);
  try {
    assert.equal(reopened.extractionNext()!.observation_id, source.id);
  } finally { reopened.close(); }
});

test("F-010 retained-witness expiration is idempotent and drains more than one batch", (t) => {
  const { c, scope, directory } = fixture(t);
  const text = "Atlas uses Ruff for formatting. Unrelated private detail.";
  const source = observe(c, scope, text);
  c.remember({ scope_id: scope, claim: tool("Ruff", { purpose: "formatting" }), witness: { observation_id: source.id, quote: "Atlas uses Ruff for formatting." } });
  c.run("UPDATE payloads SET expires_us=1 WHERE id=(SELECT payload_id FROM observations WHERE id=?)", source.id);
  assert.equal(c.expire().expired, 1);
  const state = () => ({ revision: c.revision, epoch: c.epoch("erasure"), outbox: c.one("SELECT COUNT(*) AS n FROM outbox").n,
    registry: readFileSync(join(directory, "erasure-registry.jsonl"), "utf8").length });
  const before = state();
  assert.equal(c.expire().expired, 0);
  assert.deepEqual(state(), before);
  assert.match(claims(c, scope, "formatting").join(), /Ruff/);
  // Sixty retained sources and one unretained source all drain across repeated passes.
  for (let i = 0; i < 60; i++) {
    const retained = observe(c, scope, `Atlas uses Tool${i} for formatting. Private ${i}.`);
    c.remember({ scope_id: scope, claim: tool(`Tool${i}`), witness: { observation_id: retained.id, quote: `Atlas uses Tool${i} for formatting.` } });
  }
  const plain = observe(c, scope, "Just a passing remark.");
  c.run("UPDATE payloads SET expires_us=2 WHERE erased=0 AND expires_us IS NOT NULL");
  let passes = 0;
  while (c.expire().expired && passes < 5) passes++;
  assert.equal(passes, 2);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM payloads WHERE erased=0 AND expires_us IS NOT NULL AND expires_us<?", Date.now() * 1000).n, 0);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM evidence WHERE witness LIKE '%Private%' AND erased=0").n, 0);
  assert.equal(c.one("SELECT erased FROM observations WHERE id=?", plain.id).erased, 1);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM evidence WHERE erased=0 AND witness LIKE 'Atlas uses Tool%for formatting.'").n, 60);
});

test("F-011 opposite polarity for the same member of a multivalued slot is a dispute", (t) => {
  for (const order of [["positive", "negative"], ["negative", "positive"]]) {
    const { c, scope } = fixture(t, mkdtempSync(join(tmpdir(), "cere-polarity-")));
    remember(c, scope, "Atlas uses Kitty.", tool("Kitty"));
    const text = (p: string) => p === "negative" ? "Atlas does not use Ruff." : "Atlas uses Ruff.";
    remember(c, scope, text(order[0]), tool("Ruff", {}, { polarity: order[0] }));
    remember(c, scope, text(order[1]), tool("Ruff", {}, { polarity: order[1] }));
    const result = c.retrieve({ scope_id: scope, text: "Atlas" });
    assert.ok(!result.assertions.some((a: any) => /Ruff/.test(a.claim)), "no settled Ruff fact");
    assert.equal(result.conflicts.filter((a: any) => /Ruff/.test(a.claim) && a.status === "disputed").length, 2);
    assert.ok(result.assertions.some((a: any) => /Kitty/.test(a.claim)), "unrelated member stays accepted");
    // Explicit resolution closes the contradictory set and leaves Kitty alone.
    const disputed = result.conflicts.find((a: any) => /Ruff/.test(a.claim) && a.polarity === "positive")!;
    const slot = c.one("SELECT aggregate_revision FROM fact_slots WHERE id=?", disputed.slot_id).aggregate_revision;
    const quote = observe(c, scope, "Atlas uses Ruff.");
    c.remember({ scope_id: scope, id: disputed.version_id, expected_revision: slot, claim: tool("Ruff"), witness: { observation_id: quote.id, quote: "Atlas uses Ruff." } }, "resolve");
    const resolved = c.retrieve({ scope_id: scope, text: "Atlas" });
    assert.equal(resolved.conflicts.filter((a: any) => /Ruff/.test(a.claim)).length, 0);
    assert.ok(resolved.assertions.some((a: any) => /Atlas USES_TOOL Ruff/.test(a.claim)));
    assert.ok(resolved.assertions.some((a: any) => /Kitty/.test(a.claim)));
  }
});

test("F-011 disjoint bounded intervals keep both historical answers", (t) => {
  const { c, scope } = fixture(t);
  const day = (d: string) => Date.parse(d + "T00:00:00Z") * 1000;
  remember(c, scope, "Atlas uses Ruff.", tool("Ruff", {}, { valid_mode: "bounded", valid_from_us: day("2026-01-01"), valid_to_us: day("2026-02-01") }));
  remember(c, scope, "Atlas does not use Ruff.", tool("Ruff", {}, { polarity: "negative", valid_mode: "bounded", valid_from_us: day("2026-02-01") }));
  const at = (d: string) => c.retrieve({ scope_id: scope, text: "Ruff", world_at_us: day(d) }).assertions.map((a: any) => a.polarity);
  assert.deepEqual(at("2026-01-15"), ["positive"]);
  assert.deepEqual(at("2026-03-01"), ["negative"]);
});

test("F-012 one extraction batch deduplicates, disputes competing values and keeps unrelated slots", (t) => {
  const { c, scope } = fixture(t);
  c.policyUpdate({ policy: { enabled: true } });
  const text = "Atlas uses Ruff and Black for formatting. Atlas uses Kitty.";
  const source = observe(c, scope, text);
  const run = c.extractionNext()!;
  c.extractionResult({ id: run.id, identity: { model: "fixture" } });
  const quote = (q: string) => ({ observation_id: source.id, quote: q });
  const proposal = (name: string, q: string, qualifiers: Record<string, string> = { purpose: "formatting" }) => ({ claim: tool(name, qualifiers), witness: quote(q) });
  const results = c.applyExtraction({ id: run.id, proposals: [
    proposal("Ruff", "Atlas uses Ruff and Black for formatting."),
    proposal("Ruff", "Atlas uses Ruff and Black for formatting."),
    proposal("Black", "Atlas uses Ruff and Black for formatting."),
    proposal("Kitty", "Atlas uses Kitty.", {}),
  ] });
  assert.equal(results.length, 4);
  const versions = c.all("SELECT * FROM assertion_versions WHERE erased=0");
  for (const v of versions) assert.ok(v.known_to_revision === null || v.known_to_revision > v.known_from_revision);
  const current = versions.filter((v) => v.known_to_revision === null);
  const named = (name: string) => current.filter((v) => c.one("SELECT name FROM entities WHERE id=?", v.object_entity_id).name === name);
  assert.equal(named("Ruff").length, 1, "duplicates are merged");
  assert.equal(named("Ruff")[0].status, "disputed");
  assert.equal(named("Black")[0].status, "disputed");
  assert.equal(named("Kitty")[0].status, "accepted");
  assert.equal(c.one("SELECT status FROM extraction_runs WHERE id=?", run.id).status, "complete");
  // An invalid witness anywhere still rolls back the whole batch.
  const again = observe(c, scope, "Atlas uses Zed.");
  const next = c.extractionNext()!; assert.equal(next.observation_id, again.id);
  c.extractionResult({ id: next.id, identity: {} });
  assert.throws(() => c.applyExtraction({ id: next.id, proposals: [
    { claim: tool("Zed"), witness: { observation_id: again.id, quote: "Atlas uses Zed." } },
    { claim: tool("Helix"), witness: { observation_id: again.id, quote: "fabricated" } },
  ] }), /quotation/);
  assert.equal(c.all("SELECT * FROM assertion_versions WHERE erased=0").filter((v) => c.one("SELECT name FROM entities WHERE id=?", v.object_entity_id).name === "Zed").length, 0);
});

test("F-013 model proposals are accepted only for grounded, direct, first-hand statements", (t) => {
  const { c, scope } = fixture(t);
  const cases: [string, string, any, string][] = [
    ["direct statement", "Atlas uses Ruff for formatting.", tool("Ruff"), "accepted"],
    ["direct denial", "Atlas does not use Black.", tool("Black", {}, { polarity: "negative" }), "accepted"],
    ["question", "Does Atlas use Ruff for formatting?", tool("Ruff"), "candidate"],
    ["question without mark", "Does Atlas use Ruff for formatting", tool("Ruff"), "candidate"],
    ["rhetorical question", "Why would Atlas use Ruff?", tool("Ruff"), "candidate"],
    ["quoted question", "He asked \"Does Atlas use Ruff?\"", tool("Ruff"), "candidate"],
    ["third-party report", "Bob said Atlas uses Ruff.", tool("Ruff"), "candidate"],
    ["hypothetical", "If Atlas uses Ruff, formatting is fast.", tool("Ruff"), "candidate"],
    ["co-occurrence only", "Atlas and Ruff came up in the meeting.", tool("Ruff"), "candidate"],
    ["affirmative source, negative proposal", "Atlas uses Ruff.", tool("Ruff", {}, { polarity: "negative" }), "candidate"],
    ["negated source, positive proposal", "Atlas never uses Ruff.", tool("Ruff"), "candidate"],
  ];
  for (const [name, text, claim, expected] of cases) {
    const scoped = c.registerScope({ key: "case:" + name, label: name }).id;
    const o = observe(c, scoped, text);
    const result = c.remember({ scope_id: scoped, claim, witness: { observation_id: o.id, quote: text }, model_proposal: true });
    assert.equal(result.status, expected, name);
    if (expected === "candidate") assert.equal(c.retrieve({ scope_id: scoped, text: "Ruff Black" }).assertions.length, 0, name);
  }
  assert.ok(scope);
});

test("F-017 a model edit of a saved note stays assistant evidence and cannot become a user fact", (t) => {
  const { c, scope } = fixture(t);
  const note = c.saveText({ scope_id: scope, text: "Jade prefers Black.", source_role: "user" });
  const revision = c.list({ scope_id: scope, kind: "saved" }).rows[0].revision;
  c.saveText({ scope_id: scope, id: note.id, text: "Jade prefers Ruff.", source_role: "assistant", expected_revision: revision });
  const replacement = c.one("SELECT o.id,o.role,e.trust FROM observations o JOIN payloads p ON p.id=o.payload_id JOIN evidence e ON e.observation_id=o.id WHERE p.body='Jade prefers Ruff.'");
  assert.equal(replacement.role, "assistant");
  assert.equal(replacement.trust, "derived_summary");
  assert.throws(() => c.remember({ scope_id: scope, model_proposal: true, witness: { observation_id: replacement.id, quote: "Jade prefers Ruff." },
    claim: { subject: { type: "User", name: "Jade" }, predicate: "PREFERS_TOOL", object: { type: "Tool", name: "Ruff" } } }), /user source/);
  // A direct user edit keeps user attribution.
  c.saveText({ scope_id: scope, id: note.id, text: "Jade prefers Biome.", expected_revision: c.list({ scope_id: scope, kind: "saved" }).rows[0].revision });
  assert.equal(c.one("SELECT o.role FROM observations o JOIN payloads p ON p.id=o.payload_id WHERE p.body='Jade prefers Biome.'").role, "user");
  assert.throws(() => c.saveText({ scope_id: scope, text: "x", source_role: "tool" }), /source role/);
});

test("F-019 inspection exposes the complete claim, and a correction round trip preserves it", (t) => {
  const { c, scope } = fixture(t);
  const text = "Atlas does not plan to use Ruff for formatting.";
  const claim = { subject: { type: "User", name: "Atlas" }, predicate: "PREFERS_TOOL", object: { type: "Tool", name: "Ruff" }, qualifiers: { purpose: "formatting" },
    polarity: "negative", modality: "planned", epistemic_type: "explicit_user", valid_mode: "bounded", valid_from_us: Date.parse("2026-09-01T04:00:00Z") * 1000,
    valid_to_us: null, time_precision: "date", time_zone: "America/New_York", time_expression: "from September", extraction_confidence: 0.5 };
  const created = remember(c, scope, text, claim);
  const inspected = c.inspect({ scope_id: scope, id: created.id }).record;
  const { subject, object, ...rest } = inspected.claim_data;
  assert.deepEqual({ ...rest, subject: { type: subject.type, name: subject.name }, object: { type: object.type, name: object.name } }, claim);
  const witness = observe(c, scope, text);
  const corrected = c.remember({ scope_id: scope, id: created.id, expected_revision: inspected.aggregate_revision, claim: inspected.claim_data, witness: { observation_id: witness.id, quote: text } }, "correct");
  const stored = c.inspect({ scope_id: scope, id: corrected.id }).record.claim_data;
  assert.deepEqual(stored, inspected.claim_data);
  // Literal false and zero survive as well.
  const action = observe(c, scope, "{\"state\":\"closed\"}", { role: "tool" });
  const state = c.remember({ scope_id: scope, witness: { observation_id: action.id, quote: "{\"state\":\"closed\"}" },
    claim: { subject: { type: "Action", name: "Build" }, predicate: "HAS_STATE", value: "closed", qualifiers: { dimension: "execution" }, epistemic_type: "instrumented" } });
  assert.equal(c.inspect({ scope_id: scope, id: state.id }).record.claim_data.value, "closed");
});

test("F-025 inherited evidence is equally reachable by text, anchor and provenance; siblings stay isolated", (t) => {
  const { c, scope } = fixture(t);
  const parentFact = remember(c, scope, "Atlas uses Ruff.", tool("Ruff"));
  const child = c.registerScope({ key: "child", label: "Child", kind: "task", parent_id: scope }).id;
  const sibling = c.registerScope({ key: "sibling", label: "Sibling", kind: "task", parent_id: scope }).id;
  const project = c.one("SELECT subject_id FROM assertion_versions WHERE version_id=?", parentFact.id).subject_id;
  const byText = c.retrieve({ scope_id: child, text: "Ruff" });
  const byAnchor = c.retrieve({ scope_id: child, text: "NoLexicalMatch", entity_ids: [project] });
  assert.equal(byText.assertions.length, 1);
  assert.equal(byAnchor.assertions.length, 1);
  const supplied = byText.evidence.map((e: any) => e.id);
  const record = c.recordResponse({ scope_id: child, response_ref: "reply", supplied_evidence_ids: supplied, cited_evidence_ids: supplied,
    snapshot_revision: byText.snapshot.revision, policy_epoch: byText.snapshot.policy_epoch, erasure_epoch: byText.snapshot.erasure_epoch });
  assert.equal(record.supplied, 1);
  assert.deepEqual(JSON.parse(c.one("SELECT evidence_scopes FROM response_records WHERE id=?", record.id).evidence_scopes), { [supplied[0]]: scope });
  const siblingEvidence = observe(c, sibling, "Sibling only.").evidence_id;
  const snapshot = c.retrieve({ scope_id: child, text: "Ruff" }).snapshot;
  assert.throws(() => c.recordResponse({ scope_id: child, response_ref: "x", supplied_evidence_ids: [siblingEvidence], cited_evidence_ids: [],
    snapshot_revision: snapshot.revision, policy_epoch: snapshot.policy_epoch, erasure_epoch: snapshot.erasure_epoch }), /no longer eligible/);
  c.forget({ scope_id: scope, id: parentFact.id });
  assert.equal(c.retrieve({ scope_id: child, text: "Ruff" }).assertions.length, 0);
  c.run("UPDATE scopes SET parent_id=? WHERE id=?", child, scope);
  assert.throws(() => c.retrieve({ scope_id: child, text: "Ruff" }), /Cyclic/);
});

test("F-026 failed or interrupted consolidation retries and archives exactly once", (t) => {
  const { c, scope, directory } = fixture(t);
  observe(c, scope, "A decision was made.", { session_id: "thread" });
  const episode = c.one("SELECT id FROM episodes WHERE scope_id=?", scope).id;
  // Freeze, then fail publication as maintenance does, then add a late event to the successor.
  c.freezeEpisode({ scope_id: scope, id: episode });
  c.run("UPDATE episodes SET state='retryable',consolidation_attempts=1 WHERE id=?", episode);
  observe(c, scope, "A late follow-up.", { session_id: "thread" });
  c.policyUpdate({ policy: { half_life_days: 60 } }); // stale frozen epochs must be revalidated, not fatal
  let result = c.maintenance();
  assert.equal(result.archived, 1);
  assert.equal(c.one("SELECT state FROM episodes WHERE id=?", episode).state, "archived");
  result = c.maintenance();
  assert.equal(result.archived, 0, "archived exactly once");
  const successor = c.one("SELECT id FROM episodes WHERE previous_id=?", episode).id;
  assert.equal(c.one("SELECT COUNT(*) AS n FROM episode_events WHERE episode_id=?", successor).n, 1, "late event stays with the successor");
  // A crash between freeze and archive is recovered at startup.
  observe(c, scope, "Another decision.", { session_id: "second" });
  const second = c.one("SELECT id FROM episodes WHERE thread_id='second'").id;
  c.freezeEpisode({ scope_id: scope, id: second });
  c.close();
  const reopened = new Canonical(directory);
  try {
    assert.equal(reopened.one("SELECT state FROM episodes WHERE id=?", second).state, "retryable");
    assert.equal(reopened.maintenance().archived, 1);
    // Assistant-only membership is terminal rather than retried forever.
    reopened.observeText({ scope_id: scope, text: "Assistant only reply.", role: "assistant", session_id: "assistant-thread" });
    const empty = reopened.one("SELECT id FROM episodes WHERE thread_id='assistant-thread'").id;
    assert.deepEqual(reopened.consolidate({ scope_id: scope, id: empty }), { id: empty, state: "archived", empty: true });
  } finally { reopened.close(); }
});

test("F-027 inspector pages materialize and format only the requested rows", (t) => {
  const { c, scope } = fixture(t);
  for (let i = 0; i < 60; i++) remember(c, scope, `Atlas uses Tool${String(i).padStart(2, "0")}.`, tool(`Tool${String(i).padStart(2, "0")}`));
  const statements: string[] = []; let rows = 0;
  const all = c.all.bind(c), one = c.one.bind(c);
  c.all = (sql: string, ...args: any[]) => { statements.push(sql); const result = all(sql, ...args); rows += result.length; return result; };
  c.one = (sql: string, ...args: any[]) => { statements.push(sql); rows++; return one(sql, ...args); };
  const pages = [0, 25, 50].map((offset) => c.list({ scope_id: scope, kind: "assertions", offset }));
  c.all = all; c.one = one;
  assert.deepEqual(pages.map((p) => p.rows.length), [25, 25, 10]);
  assert.ok(pages.every((p) => p.total === 60));
  const ids = pages.flatMap((p) => p.rows.map((r: any) => r.id));
  assert.equal(new Set(ids).size, 60, "pages do not overlap");
  assert.ok(pages[0].rows.every((r: any) => /^Atlas USES_TOOL Tool\d\d \[actual; known_current\]$/.test(r.text)));
  const perPage = statements.filter((s) => !/FROM scopes/.test(s)).length / 3;
  assert.equal(perPage, 2, "one COUNT and one page query per view");
  assert.ok(rows <= 3 * (25 + 2 + 1), `materialized ${rows} rows`);
});

test("F-029 identity decisions report that resolution is unchanged", (t) => {
  const { c, scope } = fixture(t);
  let left: any, right: any;
  c.tx(() => { left = c.entity(scope, { type: "Document", name: "config.json" }); right = c.entity(scope, { type: "Document", name: "config.json" }); });
  const witness = observe(c, scope, "Both config.json files are the same document.");
  for (const decision of ["possible", "same", "not_same"]) {
    const result = c.identity({ scope_id: scope, left_id: left.id, right_id: right.id, decision, witness: { observation_id: witness.id, quote: "Both config.json files are the same document." } });
    assert.equal(result.applied, false); assert.equal(result.recorded_only, true);
    const reverted = c.identity({ scope_id: scope, revert_id: result.id, expected_revision: result.revision });
    assert.equal(reverted.applied, false); assert.equal(reverted.recorded_only, true);
  }
});

test("F-034 uncertain effective dates from model proposals remain reviewable candidates", (t) => {
  const { c, scope } = fixture(t);
  const text = "Jade prefers Ruff since around September.";
  const o = observe(c, scope, text);
  const claim = { subject: { type: "User", name: "Jade" }, predicate: "PREFERS_TOOL", object: { type: "Tool", name: "Ruff" },
    valid_mode: "unknown", time_precision: "approximate", time_expression: "around September" };
  const result = c.remember({ scope_id: scope, claim, witness: { observation_id: o.id, quote: text }, model_proposal: true });
  assert.equal(result.status, "candidate");
  const stored = c.one("SELECT * FROM assertion_versions WHERE version_id=?", result.id);
  assert.equal(stored.valid_from_us, null); assert.equal(stored.valid_mode, "unknown");
  assert.equal(c.retrieve({ scope_id: scope, text: "Ruff" }).assertions.length, 0);
});
