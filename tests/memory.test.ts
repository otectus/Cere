import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Canonical } from "../broker/graph-memory/canonical.ts";
import { span } from "../broker/graph-memory/ontology.ts";
import { relationalRank, ftsQuery } from "../broker/graph-memory/ranking.ts";
const date = (s: string) => Date.parse(s + "T00:00:00-04:00") * 1000;
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "cere-graph-"));
  const c = new Canonical(directory);
  t.after(() => {
    c.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = c.registerScope({ key: "fixture", label: "Fixture" }).id;
  return { c, scope, directory };
}
function assertion(
  c: Canonical,
  scope: string,
  tool: string,
  from: number | null = date("2026-09-01"),
  to: number | null = null,
  extra: any = {},
) {
  const text = `Atlas uses ${tool} for formatting.`;
  const observation = c.observeText({ scope_id: scope, text, role: "user" });
  return {
    scope_id: scope,
    claim: {
      subject: { type: "Project", name: "Atlas" },
      predicate: "USES_TOOL",
      object: { type: "Tool", name: tool },
      qualifiers: { purpose: "formatting" },
      valid_mode: from === null ? "known_current" : "bounded",
      valid_from_us: from,
      valid_to_us: to,
      time_precision: "date",
      time_zone: "America/New_York",
      ...extra,
    },
    witness: { observation_id: observation.id, quote: text },
  };
}
function toolsAt(c: Canonical, scope: string, world: string, k?: number) {
  return c
    .retrieve({
      scope_id: scope,
      text: "formatting",
      world_at_us: date(world),
      ...(k ? { known_revision: k } : {}),
    })
    .assertions.map((a: any) => a.claim);
}
test('source erasure rederives a repeated claim only from independent surviving evidence',t=>{
  const {c,scope}=fixture(t),first=assertion(c,scope,'Ruff');c.remember(first);
  const second=assertion(c,scope,'Ruff');c.remember(second);
  const before=c.retrieve({scope_id:scope,text:'formatting'});assert.equal(before.assertions.length,1);assert.equal(before.assertions[0].evidence_ids.length,2);
  c.forget({scope_id:scope,id:first.witness.observation_id});
  const after=c.retrieve({scope_id:scope,text:'formatting'});assert.equal(after.assertions.length,1);assert.match(after.assertions[0].claim,/Ruff/);
  assert.equal(after.assertions[0].evidence_ids.length,1);assert.equal(c.support(after.assertions[0].version_id)[0].observation_id,second.witness.observation_id);
});
test('raw retention expires conversation copies and keeps only supporting witnesses',t=>{
  const {c,scope}=fixture(t),text='Atlas uses Ruff for formatting. Unrelated private detail.';
  const observation=c.observeText({scope_id:scope,text});
  const proposal=assertion(c,scope,'Ruff');proposal.witness={observation_id:observation.id,quote:'Atlas uses Ruff for formatting.'};c.remember(proposal);
  c.run('UPDATE payloads SET expires_us=1 WHERE id=(SELECT payload_id FROM observations WHERE id=?)',observation.id);
  const priorRevision=c.revision;assert.equal(c.expire().expired,1);assert.ok(c.revision>priorRevision);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM payloads WHERE body LIKE '%Unrelated private detail%'").n,0);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM evidence WHERE witness LIKE '%Unrelated private detail%'").n,0);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM retrieval_documents WHERE text LIKE '%Unrelated private detail%'").n,0);
  assert.ok(c.retrieve({scope_id:scope,text:'formatting'}).assertions.some((a:any)=>a.claim.includes('Ruff')));
  c.forget({scope_id:scope,id:observation.id});assert.equal(c.retrieve({scope_id:scope,text:'formatting'}).assertions.length,0);
});
test('multivalued correction replaces its target and preserves other slot members',t=>{
  const {c,scope}=fixture(t),base=assertion(c,scope,'Ruff',null,null,{qualifiers:{}});const first=c.remember(base);
  c.remember(assertion(c,scope,'Kitty',null,null,{qualifiers:{}}));
  const revision=c.one('SELECT aggregate_revision FROM fact_slots WHERE id=?',first.slot_id).aggregate_revision;
  c.remember({...assertion(c,scope,'Black',null,null,{qualifiers:{}}),id:first.id,expected_revision:revision},'correct');
  const claims=c.retrieve({scope_id:scope,text:'Atlas'}).assertions.map((a:any)=>a.claim).join();assert.match(claims,/Black/);assert.match(claims,/Kitty/);assert.doesNotMatch(claims,/Ruff/);
});
test("M01 duplicate observation has one durable revision and source identity", (t) => {
  const { c, scope } = fixture(t);
  const p = {
    scope_id: scope,
    text: "Atlas uses Ruff.",
    role: "user",
    source_event_id: "turn-1",
    session_id: "one",
  };
  const a = c.observeText(p),
    b = c.observeText(p);
  assert.equal(a.id, b.id);
  assert.equal(a.accepted_revision, b.accepted_revision);
  assert.equal(c.health().counts.observations, 1);
});
test("M07 bitemporal correction preserves all four specified date answers", (t) => {
  const { c, scope } = fixture(t);
  const original = c.remember(assertion(c, scope, "Black"));
  const changed = assertion(c, scope, "Ruff", date("2026-09-20"));
  const corrected = c.remember(
    {
      ...changed,
      id: original.id,
      expected_revision: original.aggregate_revision,
    },
    "correct",
  );
  assert.match(toolsAt(c, scope, "2026-09-25").join(), /Ruff/);
  assert.match(
    toolsAt(c, scope, "2026-09-25", original.accepted_revision).join(),
    /Black/,
  );
  assert.match(toolsAt(c, scope, "2026-09-10").join(), /Black/);
  assert.match(toolsAt(c, scope, "2026-09-20").join(), /Ruff/);
  assert.equal(
    c.inspect({ scope_id: scope, id: corrected.id }).history.length,
    3,
  );
});
test("M08 bounded exception returns to prior value and keeps old knowledge", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "Black"));
  c.remember(
    {
      ...assertion(c, scope, "Ruff", date("2026-09-20"), date("2026-09-27")),
      id: a.id,
      expected_revision: a.aggregate_revision,
    },
    "correct",
  );
  assert.match(toolsAt(c, scope, "2026-09-21").join(), /Ruff/);
  assert.match(toolsAt(c, scope, "2026-09-28").join(), /Black/);
  assert.match(
    toolsAt(c, scope, "2026-09-21", a.accepted_revision).join(),
    /Black/,
  );
});
test("M09 unknown start is never historical proof and plans are not actual facts", (t) => {
  const { c, scope } = fixture(t);
  c.remember(assertion(c, scope, "Black", null));
  assert.deepEqual(toolsAt(c, scope, "2026-09-10"), []);
  c.remember(
    assertion(c, scope, "Ruff", date("2026-10-01"), null, {
      modality: "planned",
    }),
  );
  assert.ok(!toolsAt(c, scope, "2026-10-02").some((s) => s.includes("Ruff")));
});
test("M10 disagreement is versioned and explicit resolution closes all conflicts", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "Black"));
  const b = c.remember(assertion(c, scope, "Ruff"));
  let q = c.retrieve({ scope_id: scope, text: "formatting" });
  assert.equal(q.assertions.length, 0);
  assert.equal(q.conflicts.length, 2);
  assert.match(
    toolsAt(c, scope, "2026-09-25", a.accepted_revision).join(),
    /Black/,
  );
  c.remember(
    {
      ...assertion(c, scope, "Ruff"),
      id: b.id,
      expected_revision: b.aggregate_revision,
    },
    "resolve",
  );
  q = c.retrieve({ scope_id: scope, text: "formatting" });
  assert.equal(q.conflicts.length, 0);
  assert.equal(q.assertions.length, 1);
});
test("M12 scoped document aliases never falsely merge same basenames", (t) => {
  const { c, scope } = fixture(t);
  const other = c.registerScope({ key: "other", label: "Other" }).id;
  let a: any, b: any, d: any;
  c.tx(() => {
    a = c.entity(scope, { type: "Document", name: "config.json" });
    b = c.entity(scope, { type: "Document", name: "config.json" });
    d = c.entity(other, { type: "Document", name: "config.json" });
  });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, d.id);
});
test("M13 M24 evidence quotes use exact Unicode code point spans and strict proposals", (t) => {
  assert.deepEqual(span("😄\r\nRuff Ruff", "Ruff", 1), { start: 8, end: 12 });
  assert.throws(() => span("Ruff", "ruff", 0));
  const { c, scope } = fixture(t);
  const p = assertion(c, scope, "Black");
  p.witness.quote = "fabricated";
  assert.throws(() => c.remember(p), /quotation/);
  const good = assertion(c, scope, "Ruff");
  assert.throws(() =>
    c.remember({ ...good, claim: { ...good.claim, predicate: "EXECUTE" } }),
  );
  assert.equal(c.health().counts.assertions, 0);
});
test("M02 M03 M04 durable outbox leases repeat and contiguous watermark never skips a gap", (t) => {
  const { c, scope } = fixture(t);
  c.observeText({ scope_id: scope, text: "decision", role: "user" });
  const jobs = c.all(
    "SELECT * FROM outbox WHERE backend='graph' ORDER BY revision",
  );
  c.finishJob({ id: jobs[1].id });
  assert.equal(
    c.health().projections.find((p) => p.backend === "graph")!.watermark,
    0,
  );
  c.finishJob({ id: jobs[0].id });
  assert.equal(
    c.health().projections.find((p) => p.backend === "graph")!.watermark,
    2,
  );
  c.finishJob({ id: jobs[0].id });
  assert.equal(
    c.health().projections.find((p) => p.backend === "graph")!.watermark,
    2,
  );
});
test("M05 M27 stale semantic pointers are hydrated and isolated before ranking", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "Black"));
  const old = c.one("SELECT * FROM artifacts WHERE record_id=?", a.id);
  const b = c.remember(
    {
      ...assertion(c, scope, "Ruff"),
      id: a.id,
      expected_revision: a.aggregate_revision,
    },
    "correct",
  );
  const result = c.retrieve({
    scope_id: scope,
    text: "formatting",
    semantic_ids: [
      {
        artifactId: old.id,
        contentRevision: old.content_revision,
        sourceGeneration: old.source_generation,
      },
    ],
    read_token: b.read_token,
  });
  assert.ok(!result.assertions.some((x) => x.claim.includes("Black")));
  assert.match(result.assertions[0].claim, /Ruff/);
  const other = c.registerScope({ key: "other", label: "Other" }).id;
  assert.equal(
    c.retrieve({ scope_id: other, text: "formatting", semantic_ids: [old.id] })
      .results.length,
    0,
  );
});
test("M06 M25 forgotten sources, witnesses and projections are suppressed before purge", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "SecretTool"));
  const preview = c.forgetPreview({ scope_id: scope, id: a.id });
  assert.ok(preview.count > 1);
  const erased = c.forget({ scope_id: scope, id: a.id });
  assert.equal(erased.suppressed, true);
  assert.equal(erased.purge_complete, false);
  assert.equal(
    c.retrieve({ scope_id: scope, text: "SecretTool" }).results.length,
    0,
  );
  assert.throws(() => c.inspect({ scope_id: scope, id: a.id }), /erased/);
  for (const table of [
    "payloads",
    "evidence",
    "entities",
    "retrieval_documents",
  ])
    assert.ok(
      !JSON.stringify(c.all(`SELECT * FROM ${table}`)).includes("SecretTool"),
    );
  assert.ok(
    !readFileSync(join(c.directory, "erasure-registry.jsonl"), "utf8").includes(
      "SecretTool",
    ),
  );
});
test("M28 pre-erasure backup restoration applies current external registry before serving", async (t) => {
  const { c, scope, directory } = fixture(t);
  const a = c.remember(assertion(c, scope, "ForgottenTool"));
  const backup = join(directory, "before.sqlite");
  await c.backup({ output: backup });
  c.forget({ scope_id: scope, id: a.id });
  const staging = join(directory, "restored");
  await c.restore({ input: backup, staging });
  const restored = new Canonical(staging);
  try {
    assert.equal(
      restored.retrieve({ scope_id: scope, text: "ForgottenTool" }).results
        .length,
      0,
    );
    assert.throws(() => restored.inspect({ scope_id: scope, id: a.id }));
  } finally {
    restored.close();
  }
});
test("M21 M22 M23 assistant text cannot establish successful instrumented outcome", (t) => {
  const { c, scope } = fixture(t);
  const o = c.observeText({
    scope_id: scope,
    text: "I fixed it successfully.",
    role: "assistant",
  });
  assert.throws(
    () =>
      c.remember({
        scope_id: scope,
        claim: {
          subject: { type: "Action", name: "Build" },
          predicate: "HAS_STATE",
          value: "succeeded",
          epistemic_type: "instrumented",
        },
        witness: { observation_id: o.id, quote: "I fixed it successfully." },
      }),
    /instrumented/,
  );
  const before = c.revision;
  c.retrieve({ scope_id: scope, text: "fixed" });
  assert.equal(c.revision, before);
});
test("M31 FTS punctuation/operators are escaped and hostile text cannot execute queries", (t) => {
  const { c, scope } = fixture(t);
  c.saveText({ scope_id: scope, text: "config.json has Unicode Ω and Ruff" });
  for (const text of [
    "config.json",
    '" OR AND "',
    "Ω",
    "Ruff); DROP TABLE entities;--",
  ])
    assert.doesNotThrow(() => c.retrieve({ scope_id: scope, text }));
  assert.ok(ftsQuery('" OR "').includes('"OR"'));
  assert.equal(c.health().counts.observations, 1);
});
test("M33 stale corrections fail without lost update", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "Black"));
  c.remember(
    {
      ...assertion(c, scope, "Ruff"),
      id: a.id,
      expected_revision: a.aggregate_revision,
    },
    "correct",
  );
  assert.throws(
    () =>
      c.remember(
        {
          ...assertion(c, scope, "Other"),
          id: a.id,
          expected_revision: a.aggregate_revision,
        },
        "correct",
      ),
    /changed/,
  );
  assert.match(toolsAt(c, scope, "2026-09-25").join(), /Ruff/);
});
test("M34 episode publication refuses erased sources after freeze", (t) => {
  const { c, scope } = fixture(t);
  const o = c.observeText({
    scope_id: scope,
    text: "A decision was made.",
    role: "user",
    session_id: "thread",
  });
  const episode = c.one("SELECT id FROM episodes WHERE scope_id=?", scope);
  const frozen = c.freezeEpisode({ scope_id: scope, id: episode.id });
  c.forget({ scope_id: scope, id: o.id });
  assert.throws(
    () =>
      c.archiveEpisode({
        scope_id: scope,
        id: episode.id,
        source_generation: frozen.source_generation,
        policy_epoch: frozen.policy_epoch,
        erasure_epoch: frozen.erasure_epoch,
        claims: [
          { text: "A decision was made.", evidence_ids: [o.evidence_id] },
        ],
      }),
    /changed/,
  );
});
test("M35 M36 supplied evidence and citations remain separate, revoked epochs reject response", (t) => {
  const { c, scope } = fixture(t);
  const o = c.observeText({
    scope_id: scope,
    text: "Ruff decision",
    role: "user",
  });
  const q = c.retrieve({ scope_id: scope, text: "Ruff" });
  const args = {
    scope_id: scope,
    response_ref: "response",
    supplied_evidence_ids: [o.evidence_id],
    cited_evidence_ids: [],
    snapshot_revision: q.snapshot.revision,
    policy_epoch: q.snapshot.policy_epoch,
    erasure_epoch: q.snapshot.erasure_epoch,
  };
  const record = c.recordResponse(args);
  assert.equal(record.cited, 0);
  assert.throws(
    () => c.recordResponse({ ...args, cited_evidence_ids: ["invented"] }),
    /not supplied/,
  );
  c.policyUpdate({ policy: { allow_cloud_memory: false } });
  assert.throws(() => c.recordResponse(args), /invalidated/);
});
test("query-conditioned ranker conserves probability with dangling nodes and bounded cycles", () => {
  const p = relationalRank(new Map([["a", 1]]), [
    { from: "a", to: "b", weight: 1 },
    { from: "b", to: "a", weight: 1 },
    { from: "b", to: "c", weight: 2 },
  ]);
  assert.ok(Math.abs([...p.values()].reduce((s, v) => s + v, 0) - 1) < 1e-8);
  assert.equal(relationalRank(new Map(), []).size, 0);
});
