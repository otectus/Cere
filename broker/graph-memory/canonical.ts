import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { schema, migrations } from "./schema.ts";
import {
  claimSchema,
  witnessSchema,
  policySchema,
  parse,
  safeText,
  fail,
  strict,
  type Claim,
  type Policy,
} from "./contracts.ts";
import { validateClaim, normalized, stableJSON, span } from "./ontology.ts";
import { overlaps, remainder, eligibleTime } from "./temporal.ts";
import { rrf, relationalRank, ftsQuery, estimateTokens } from "./ranking.ts";

type Row = Record<string, any>;
const uuid = () => randomUUID(),
  now = () => Date.now() * 1000,
  digest = (s: string) => createHash("sha256").update(s).digest("hex");
export class Canonical {
  db: DatabaseSync;
  directory: string;
  owner: string;
  revision = 0;
  effects = new Set<string>();
  batchTransaction = false;
  policy: Policy;
  events: Row[] = [];
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, "memory.sqlite"), {
      timeout: 5000,
    });
    chmodSync(join(directory, "memory.sqlite"), 0o600);
    const version = this.one("SELECT sqlite_version() AS v")
      .v.split(".")
      .map(Number);
    if (
      version[0] < 3 ||
      (version[0] === 3 &&
        (version[1] < 51 || (version[1] === 51 && version[2] < 3)))
    )
      fail(
        "INCOMPATIBLE_SCHEMA",
        "SQLite 3.51.3 or later with the WAL reset fix is required",
      );
    this.db.exec(
      "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;PRAGMA secure_delete=ON;CREATE VIRTUAL TABLE temp.fts_probe USING fts5(text);DROP TABLE temp.fts_probe;",
    );
    if (
      !this.one("SELECT name FROM sqlite_master WHERE name='schema_migrations'")
        .name
    ) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(schema);
        this.run(
          "INSERT INTO schema_migrations VALUES (1,?,?)",
          digest(schema),
          now(),
        );
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    this.migrate();
    this.owner = this.meta("owner_id", "");
    if (!this.owner) {
      this.owner = uuid();
      this.setMeta("owner_id", this.owner);
    }
    this.policy = parse(policySchema, this.meta("policy", {}));
    this.revision = this.one(
      "SELECT COALESCE(MAX(revision),0) AS n FROM commits",
    ).n;
    for (const backend of ["graph", "vector"])
      this.run(
        "INSERT OR IGNORE INTO projection_state(backend,generation) VALUES (?, '1')",
        backend,
      );
    this.run(
      "UPDATE outbox SET state='pending',lease_until_us=NULL WHERE state='leased'",
    );
    this.run("UPDATE extraction_runs SET status='pending' WHERE status='running'");
    // A crash between freeze and archive leaves consolidation for the bounded retry path.
    this.run(
      "UPDATE episodes SET state='retryable',error_code='INTERRUPTED',next_retry_us=0 WHERE state='consolidating' AND erased=0",
    );
    this.reconcileRegistry();
    this.queue(() => this.reconcileExtraction());
  }
  /** Runs queue bookkeeping atomically, joining an enclosing canonical mutation when present. */
  queue<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /**
   * Re-evaluates queued extraction against current source, payload and epochs.
   * Runs claimed under an older epoch are superseded by a fresh run, so a stale
   * in-flight result stays rejected while the surviving source is extracted again.
   */
  reconcileExtraction(includeDenied = false) {
    const policy = this.epoch("policy"),
      erasure = this.epoch("erasure"),
      statuses = ["pending", "running", "revoked", ...(includeDenied ? ["denied"] : [])];
    let rescheduled = 0;
    for (const run of this.all(
      `SELECT x.*,o.erased AS source_erased,o.payload_id,p.erased AS payload_erased FROM extraction_runs x JOIN observations o ON o.id=x.observation_id LEFT JOIN payloads p ON p.id=o.payload_id WHERE x.status IN (${statuses.map(() => "?").join(",")}) ORDER BY x.revision,x.id`,
      ...statuses,
    )) {
      if (run.source_erased) {
        this.run("UPDATE extraction_runs SET status='erased',error_code=NULL WHERE id=?", run.id);
        continue;
      }
      if (!run.payload_id || run.payload_erased) {
        this.run(
          "UPDATE extraction_runs SET status='expired',error_code='SOURCE_PAYLOAD_EXPIRED' WHERE id=?",
          run.id,
        );
        continue;
      }
      if (run.status === "pending" && run.policy_epoch === policy && run.erasure_epoch === erasure)
        continue;
      this.run("UPDATE extraction_runs SET status='superseded' WHERE id=?", run.id);
      this.insert("extraction_runs", {
        id: uuid(),
        observation_id: run.observation_id,
        model_identity: "unconfigured",
        prompt_version: run.prompt_version,
        parser_version: run.parser_version,
        schema_version: run.schema_version,
        status: "pending",
        policy_epoch: policy,
        erasure_epoch: erasure,
        revision: this.revision,
      });
      rescheduled++;
    }
    return { rescheduled };
  }
  /** Verifies every applied migration by checksum, then applies the missing suffix in order. */
  migrate() {
    const known = new Map<number, string>([
      [1, digest(schema)],
      ...migrations.map((m): [number, string] => [m.id, digest(m.sql)]),
    ]);
    const applied = this.all("SELECT * FROM schema_migrations ORDER BY id");
    for (const [index, row] of applied.entries())
      if (row.id !== index + 1 || known.get(row.id) !== row.checksum)
        fail("INCOMPATIBLE_SCHEMA", "Unknown or modified memory migration");
    for (const migration of migrations) {
      if (applied.some((row) => row.id === migration.id)) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration.sql);
        this.run(
          "INSERT INTO schema_migrations VALUES (?,?,?)",
          migration.id,
          digest(migration.sql),
          now(),
        );
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }
  one(sql: string, ...args: any[]): Row {
    return (this.db.prepare(sql).get(...args) as Row) || {};
  }
  all(sql: string, ...args: any[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  insert(table: string, row: Row) {
    const keys = Object.keys(row);
    this.run(
      `INSERT INTO ${table}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      ...keys.map((k) => (row[k] === undefined ? null : row[k])),
    );
  }
  meta<T>(key: string, fallback: T): T {
    const row = this.one("SELECT value FROM meta WHERE key=?", key);
    return row.value === undefined ? fallback : JSON.parse(row.value);
  }
  setMeta(key: string, value: unknown) {
    this.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  epoch(kind: "policy" | "erasure") {
    return this.meta(kind + "_epoch", 0);
  }
  scope(id: string) {
    const row = this.one(
      "SELECT * FROM scopes WHERE id=? AND owner_id=? AND erased=0",
      id,
      this.owner,
    );
    if (!row.id)
      fail(
        "UNAUTHORIZED_SCOPE",
        "Memory scope is not registered for this profile",
      );
    return row;
  }
  effect(id: string) {
    this.effects.add(id);
  }
  tx<T>(fn: (revision: number, time: number) => T): T {
    if(this.db.isTransaction&&this.batchTransaction)return fn(this.revision,this.one('SELECT transaction_us FROM commits WHERE revision=?',this.revision).transaction_us);
    if (this.db.isTransaction)
      fail("REVISION_CONFLICT", "Nested canonical transaction");
    this.db.exec("BEGIN IMMEDIATE");
    const previous = this.revision;
    this.effects = new Set();
    try {
      const wall = now(),
        time = Math.max(
          wall,
          this.one("SELECT COALESCE(MAX(transaction_us),0)+1 AS n FROM commits")
            .n,
        );
      this.revision = Number(
        this.run(
          "INSERT INTO commits(transaction_us,wall_us,clock_discontinuity,mutation_id,schema_version) VALUES (?,?,?,?,1)",
          time,
          wall,
          Number(time > wall),
          uuid(),
        ).lastInsertRowid,
      );
      const result = fn(this.revision, time);
      for (const target of this.effects)
        this.run(
          "INSERT INTO mutation_effects VALUES (?,?,?,?)",
          this.revision,
          target,
          "refresh",
          this.revision,
        );
      for (const p of this.all("SELECT * FROM projection_state WHERE active IN (1,2)"))
        this.insert("outbox", {
          id: uuid(),
          backend: p.backend,
          revision: this.revision,
          generation: p.generation,
          erasure_epoch: this.epoch("erasure"),
          state: "pending",
        });
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.revision = previous;
      throw e;
    }
  }
  /**
   * The authorized scope closure: the scope and its registered ancestors, bounded
   * at sixteen levels. Siblings and unrelated scopes are never included.
   */
  effectiveScopes(scope: string): string[] {
    const scopes: string[] = [scope];
    let parent = this.scope(scope).parent_id;
    while (parent && scopes.length < 16) {
      if (scopes.includes(parent))
        fail("INVALID_ARGUMENT", "Cyclic scope hierarchy");
      scopes.push(parent);
      parent = this.scope(parent).parent_id;
    }
    return scopes;
  }
  receipt(scope: string, targets: string[]) {
    const token = uuid();
    this.insert("read_tokens", {
      token,
      scope_id: scope,
      revision: this.revision,
      targets: JSON.stringify(targets),
      policy_epoch: this.epoch("policy"),
      erasure_epoch: this.epoch("erasure"),
    });
    return {
      mutation_id: this.one(
        "SELECT mutation_id FROM commits WHERE revision=?",
        this.revision,
      ).mutation_id,
      accepted_revision: this.revision,
      affected_ids: targets,
      read_token: token,
      policy_epoch: this.epoch("policy"),
      erasure_epoch: this.epoch("erasure"),
      projections: this.all(
        "SELECT backend,generation,watermark,status FROM projection_state WHERE active=1",
      ),
    };
  }
  registerScope(p: Row) {
    strict(p, ["key", "label", "kind", "parent_id"]);
    const key = safeText(p.key, 2000);
    const old = this.one(
      "SELECT * FROM scopes WHERE external_key=? AND erased=0",
      key,
    );
    if (old.id) return { id: old.id, owner_id: this.owner };
    return this.tx((r) => {
      if (p.parent_id) this.scope(p.parent_id);
      const id = uuid();
      this.insert("scopes", {
        id,
        owner_id: this.owner,
        kind: p.kind || "project",
        parent_id: p.parent_id || null,
        external_key: key,
        label: safeText(p.label || "Project", 1000),
        revision: r,
      });
      return { id, owner_id: this.owner };
    });
  }
  payload(
    scope: string,
    text: string,
    retention = "evidence",
    sensitivity = "cloud_allowed",
    expires: number | null = null,
  ) {
    const id = uuid();
    this.insert("payloads", {
      id,
      scope_id: scope,
      body: text,
      digest: digest(text),
      revision: this.revision,
      sensitivity,
      retention,
      expires_us: expires,
    });
    return id;
  }
  lineage(derived: string, input: string, role = "derived") {
    if (derived === input) fail("INVALID_ARGUMENT", "Cyclic derivation");
    const cycle = this.one(
      "WITH RECURSIVE parents(id) AS (SELECT input_id FROM lineage WHERE derived_id=? UNION SELECT l.input_id FROM lineage l JOIN parents p ON l.derived_id=p.id) SELECT 1 AS n FROM parents WHERE id=?",
      input,
      derived,
    );
    if (cycle.n) fail("INVALID_ARGUMENT", "Cyclic derivation");
    this.run(
      "INSERT OR IGNORE INTO lineage VALUES (?,?,?,?)",
      derived,
      input,
      role,
      this.revision,
    );
  }
  artifact(
    scope: string,
    kind: string,
    record: string,
    text: string,
    inputs: string[],
    session = "",
    sensitivity = "cloud_allowed",
  ) {
    const id = uuid(),
      payload = this.payload(scope, text, kind, sensitivity);
    this.insert("artifacts", {
      id,
      scope_id: scope,
      kind,
      record_id: record,
      payload_id: payload,
      source_generation: this.revision,
      content_revision: this.revision,
      known_from_revision: this.revision,
      sensitivity,
      erasure_epoch: this.epoch("erasure"),
      session_id: session,
    });
    this.insert("retrieval_documents", {
      artifact_id: id,
      scope_id: scope,
      content_revision: this.revision,
      text,
    });
    for (const input of inputs) this.lineage(id, input);
    this.lineage(payload, id, "content");
    this.effect(id);
    return id;
  }
  source(scope: string, role: string, external: string) {
    let source = this.one(
      "SELECT * FROM sources WHERE scope_id=? AND kind=? AND external_identity=?",
      scope,
      role,
      external,
    );
    if (!source.id) {
      const id = uuid();
      this.insert("sources", {
        id,
        scope_id: scope,
        kind: role,
        external_identity: external,
        trust:
          role === "user"
            ? "explicit_user"
            : role === "tool"
              ? "instrumented"
              : role === "document"
                ? "document_claim"
                : "derived_summary",
        epoch: uuid(),
        policy_epoch: this.epoch("policy"),
      });
      source = this.one("SELECT * FROM sources WHERE id=?", id);
    }
    return source;
  }
  observeText(p: Row): Row {
    strict(p, [
      "scope_id",
      "text",
      "role",
      "session_id",
      "source_event_id",
      "source_sequence",
      "occurred_us",
      "kind",
      "sensitivity",
      "storage",
      "task_id",
      "automatic",
    ]);
    this.scope(p.scope_id);
    if(p.automatic && !this.policy.enabled) fail('POLICY_DENIED','Automatic memory capture is disabled');
    if(p.task_id && !this.one('SELECT id FROM tasks WHERE id=? AND scope_id=? AND erased=0',p.task_id,p.scope_id).id)fail('INVALID_ARGUMENT','Task binding is not in this scope');
    const text = safeText(p.text),
      role = p.role || "user";
    if (!["user", "assistant", "tool", "document"].includes(role))
      fail("INVALID_ARGUMENT", "Unsupported source role");
    if (p.storage === "transient")
      return { durable: false, buffer_generation: now() };
    if (
      p.sensitivity &&
      !["local_only", "cloud_allowed"].includes(p.sensitivity)
    )
      fail("INVALID_ARGUMENT", "Unsupported source restriction");
    const external = String(p.session_id || "manual"),
      event = String(p.source_event_id || uuid());
    const old = this.one(
      "SELECT o.* FROM observations o JOIN sources s ON s.id=o.source_id WHERE s.scope_id=? AND s.kind=? AND s.external_identity=? AND o.source_event_id=?",
      p.scope_id,
      role,
      external,
      event,
    );
    if (old.id)
      return {
        id: old.id,
        duplicate: true,
        accepted_revision: old.revision,
        erased: !!old.erased,
      };
    return this.tx((r, time) => {
      const observed = this.recordObservation(p, text, role, external, event, r, time);
      return {
        ...observed,
        durable: true,
        ...this.receipt(p.scope_id, [observed.id]),
      };
    });
  }
  /** Inserts one durable source occurrence inside the caller's canonical mutation. */
  recordObservation(
    p: Row,
    text: string,
    role: string,
    external: string,
    event: string,
    r: number,
    time: number,
  ) {
    const source = this.source(p.scope_id, role, external),
      id = uuid(),
      payload = this.payload(
        p.scope_id,
        text,
        p.kind === "saved" ? "evidence" : "raw_turn",
        p.sensitivity || "cloud_allowed",
        p.kind === "saved" ? null : time + this.policy.raw_turn_days * 864e8,
      ),
      seq =
        p.source_sequence ??
        this.one(
          "SELECT COALESCE(MAX(source_sequence),0)+1 AS n FROM observations WHERE source_id=?",
          source.id,
        ).n;
    this.insert("observations", {
      id,
      scope_id: p.scope_id,
      source_id: source.id,
      source_epoch: source.epoch,
      source_sequence: seq,
      source_event_id: event,
      occurred_us: p.occurred_us || time,
      captured_us: time,
      payload_id: payload,
      role,
      storage_mode: "durable",
      extraction_state: role === "assistant" ? "derived" : "pending",
      revision: r,
    });
    this.lineage(payload, id, "content");
    const evidence = uuid();
    this.insert("evidence", {
      id: evidence,
      scope_id: p.scope_id,
      observation_id: id,
      source_revision: r,
      locator: JSON.stringify({
        start: 0,
        end: Array.from(text).length,
        units: "unicode_code_points",
      }),
      witness: text,
      digest: digest(text),
      trust: source.trust,
      independence_group: id,
      sensitivity: p.sensitivity || "cloud_allowed",
      revision: r,
    });
    this.lineage(evidence, id, "witness");
    this.artifact(
      p.scope_id,
      p.kind || "conversation",
      id,
      (role === "assistant" ? "Assistant (unverified): " : "") + text,
      [evidence],
      external,
      p.sensitivity || "cloud_allowed",
    );
    this.insert("extraction_runs", {
      id: uuid(),
      observation_id: id,
      model_identity: "unconfigured",
      prompt_version: "cere-extract-1",
      parser_version: "1",
      schema_version: 1,
      status: role === "assistant" ? "derived" : "pending",
      policy_epoch: this.epoch("policy"),
      erasure_epoch: this.epoch("erasure"),
      revision: r,
    });
    const eid = uuid(),
      thread = p.task_id || external;
    this.insert("events", {
      id: eid,
      scope_id: p.scope_id,
      observation_id: id,
      task_id: p.task_id || null,
      thread_id: thread,
      kind:
        role === "assistant"
          ? "response"
          : role === "tool"
            ? "result"
            : "statement",
      actor: role,
      occurred_us: p.occurred_us || time,
      captured_us: time,
      stream_sequence: seq,
      payload_id: payload,
      revision: r,
    });
    this.lineage(eid, id);
    // Rebuild source ordering for late arrivals; capture order is never causality.
    const preceding = this.one(
        "SELECT e.id FROM events e JOIN observations o ON o.id=e.observation_id WHERE o.source_id=? AND e.stream_sequence<? AND e.erased=0 ORDER BY e.stream_sequence DESC LIMIT 1",
        source.id,
        seq,
      ),
      following = this.one(
        "SELECT e.id FROM events e JOIN observations o ON o.id=e.observation_id WHERE o.source_id=? AND e.stream_sequence>? AND e.erased=0 ORDER BY e.stream_sequence LIMIT 1",
        source.id,
        seq,
      );
    if (preceding.id && following.id)
      this.run(
        "DELETE FROM event_edges WHERE from_id=? AND to_id=? AND relation='NEXT_IN_STREAM'",
        preceding.id,
        following.id,
      );
    for (const [from, to] of [
      [preceding.id, eid],
      [eid, following.id],
    ])
      if (from && to)
        this.insert("event_edges", {
          id: uuid(),
          from_id: from,
          to_id: to,
          relation: "NEXT_IN_STREAM",
          order_basis: "source_sequence",
          revision: r,
        });
    let episode = this.one(
      "SELECT * FROM episodes WHERE scope_id=? AND thread_id=? AND state='open' AND erased=0 ORDER BY revision DESC LIMIT 1",
      p.scope_id,
      thread,
    );
    if (!episode.id) {
      episode = { id: uuid() };
      this.insert("episodes", {
        id: episode.id,
        scope_id: p.scope_id,
        thread_id: thread,
        state: "open",
        source_generation: r,
        revision: r,
        policy_epoch: this.epoch("policy"),
        erasure_epoch: this.epoch("erasure"),
      });
    }
    this.insert("episode_events", {
      episode_id: episode.id,
      event_id: eid,
      ordering: seq,
    });
    this.run(
      "UPDATE episodes SET source_generation=?,revision=? WHERE id=?",
      r,
      r,
      episode.id,
    );
    this.lineage(episode.id, eid, "member");
    this.effect(id);
    this.effect(eid);
    this.effect(episode.id);
    return { id, evidence_id: evidence };
  }
  saveText(p: Row) {
    strict(p, [
      "scope_id",
      "text",
      "id",
      "expected_revision",
      "session_id",
      "source_role",
      "source_event_id",
    ]);
    this.scope(p.scope_id);
    const text = safeText(p.text, 2000),
      // Every branch keeps the caller's authority: a model-authored edit stays an
      // assistant source even when it replaces a note originally written by the user.
      role = p.source_role || "user",
      external = String(p.session_id || "manual");
    if (!["user", "assistant"].includes(role))
      fail("INVALID_ARGUMENT", "Unsupported saved-note source role");
    const saved = { scope_id: p.scope_id, kind: "saved" };
    if (p.id) {
      const old = this.one(
        "SELECT * FROM artifacts WHERE scope_id=? AND (record_id=? OR id=?) AND kind='saved' AND invalidated=0 AND known_to_revision IS NULL",
        p.scope_id,
        p.id,
        p.id,
      );
      if (!old.id)
        fail("NOT_FOUND", "Saved memory no longer exists in this project");
      if (
        p.expected_revision !== undefined &&
        old.content_revision !== p.expected_revision
      )
        fail(
          "REVISION_CONFLICT",
          "Memory changed; inspect its current revision",
        );
      // The replacement source, its artifact and the stable note identity commit together.
      return this.tx((r, time) => {
        const observed = this.recordObservation(saved, text, role, external, String(p.source_event_id || uuid()), r, time);
        this.run(
          "UPDATE artifacts SET known_to_revision=? WHERE id=?",
          r,
          old.id,
        );
        this.effect(old.id);
        const fresh = this.one(
          "SELECT * FROM artifacts WHERE record_id=? AND kind='saved'",
          observed.id,
        );
        this.run(
          "UPDATE artifacts SET record_id=? WHERE id=?",
          old.record_id,
          fresh.id,
        );
        this.insert("note_revisions", {
          note_id: old.record_id,
          observation_id: observed.id,
          artifact_id: fresh.id,
          revision: r,
          source_role: role,
        });
        return {
          id: old.record_id,
          text,
          saved: true,
          revision: r,
          receipt: this.receipt(p.scope_id, [old.record_id]),
        };
      });
    }
    return this.tx((r, time) => {
      const observed = this.recordObservation(saved, text, role, external, String(p.source_event_id || uuid()), r, time);
      this.insert("note_revisions", {
        note_id: observed.id,
        observation_id: observed.id,
        artifact_id: this.one("SELECT id FROM artifacts WHERE record_id=? AND kind='saved'", observed.id).id,
        revision: r,
        source_role: role,
      });
      const receipt = { ...observed, durable: true, ...this.receipt(p.scope_id, [observed.id]) };
      return {
        id: observed.id,
        text,
        saved: true,
        revision: r,
        receipt,
      };
    });
  }
  entity(scope: string, e: Claim["subject"]) {
    if (e.id) {
      const row = this.one(
        "SELECT * FROM entities WHERE id=? AND scope_id=? AND erased=0",
        e.id,
        scope,
      );
      if (!row.id || row.type !== e.type)
        fail("NOT_FOUND", "Entity is not eligible in this scope");
      return row;
    }
    if (e.external_id) {
      const existing = this.one(
        "SELECT * FROM entities WHERE scope_id=? AND type=? AND external_id=? AND erased=0",
        scope,
        e.type,
        e.external_id,
      );
      if (existing.id) return existing;
    }
    const aliases = this.all(
      "SELECT DISTINCT e.* FROM entities e JOIN entity_aliases a ON a.entity_id=e.id WHERE a.scope_id=? AND a.normalized=? AND e.type=? AND e.erased=0",
      scope,
      normalized(e.name),
      e.type,
    );
    if (
      !e.external_id && aliases.length === 1 &&
      !["Document", "Directory", "Checkout", "Repository"].includes(e.type)
    )
      return aliases[0];
    const id = uuid();
    this.insert("entities", {
      id,
      scope_id: scope,
      type: e.type,
      name: safeText(e.name, 500),
      external_id: e.external_id || null,
      identity_revision: this.revision,
    });
    this.insert("entity_aliases", {
      id: uuid(),
      entity_id: id,
      scope_id: scope,
      kind: e.external_id ? "external" : "name",
      normalized: normalized(e.name),
      revision: this.revision,
    });
    this.effect(id);
    return this.one("SELECT * FROM entities WHERE id=?", id);
  }
  evidence(scope: string, w: ReturnType<typeof witnessSchema.parse>) {
    const obs = this.one(
      "SELECT o.*,p.body,p.sensitivity,s.trust FROM observations o JOIN payloads p ON p.id=o.payload_id JOIN sources s ON s.id=o.source_id WHERE o.id=? AND o.scope_id=? AND o.erased=0 AND p.erased=0",
      w.observation_id,
      scope,
    );
    if (!obs.id)
      fail("SOURCE_CHANGED", "Evidence source is no longer eligible");
    const loc = span(obs.body, w.quote, w.occurrence),
      old = this.one(
        "SELECT * FROM evidence WHERE observation_id=? AND locator=? AND erased=0",
        obs.id,
        JSON.stringify({ ...loc, units: "unicode_code_points" }),
      );
    if (old.id) return old;
    const id = uuid();
    this.insert("evidence", {
      id,
      scope_id: scope,
      observation_id: obs.id,
      source_revision: obs.revision,
      locator: JSON.stringify({ ...loc, units: "unicode_code_points" }),
      witness: w.quote,
      digest: digest(w.quote),
      trust: obs.trust,
      independence_group: obs.id,
      sensitivity: obs.sensitivity,
      revision: this.revision,
    });
    this.lineage(id, obs.id, "witness");
    return this.one("SELECT * FROM evidence WHERE id=?", id);
  }
  assertionText(v: Row) {
    const subject = this.one(
      "SELECT name FROM entities WHERE id=?",
      v.subject_id,
    ).name;
    const object = v.object_entity_id
      ? this.one("SELECT name FROM entities WHERE id=?", v.object_entity_id)
          .name
      : JSON.parse(v.value_json);
    return `${subject} ${v.polarity === "negative" ? "does not " : ""}${v.predicate} ${object}${v.qualifiers !== "{}" ? " " + v.qualifiers : ""} [${v.modality}; ${v.valid_mode}]`;
  }
  newVersion(v: Row, evidence: Row[], time: number, logical = uuid()) {
    const version = uuid();
    const data = {
      ...v,
      version_id: version,
      logical_id: logical,
      known_from_revision: this.revision,
      known_to_revision: null,
      known_from_us: time,
      known_to_us: null,
      aggregate_revision: this.revision,
      erasure_epoch: this.epoch("erasure"),
      erased: 0,
    };
    this.insert("assertion_versions", data);
    for (const e of evidence) {
      this.insert("assertion_evidence", {
        version_id: version,
        evidence_id: e.id,
        relation: "support",
        independence_group: e.independence_group,
      });
      this.lineage(version, e.id, "support");
    }
    this.artifact(
      v.scope_id,
      "assertion",
      version,
      this.assertionText(data),
      [version],
      "",
      v.sensitivity,
    );
    this.effect(version);
    return version;
  }
  closeVersion(v: Row, time: number) {
    this.run(
      "UPDATE assertion_versions SET known_to_revision=?,known_to_us=? WHERE version_id=?",
      this.revision,
      time,
      v.version_id,
    );
    this.run(
      "UPDATE artifacts SET known_to_revision=? WHERE record_id=?",
      this.revision,
      v.version_id,
    );
    this.effect(v.version_id);
    this.invalidateDerived(v.version_id);
  }
  invalidateDerived(input: string) {
    for (const row of this.all(
      "WITH RECURSIVE children(id) AS (SELECT derived_id FROM lineage WHERE input_id=? UNION SELECT l.derived_id FROM lineage l JOIN children c ON l.input_id=c.id) SELECT a.* FROM artifacts a JOIN children c ON a.id=c.id WHERE a.kind IN ('episode','topic')",
      input,
    )) {
      this.run("UPDATE artifacts SET invalidated=1 WHERE id=?", row.id);
      this.run("DELETE FROM retrieval_documents WHERE artifact_id=?", row.id);
      this.effect(row.id);
    }
  }
  remember(p: Row, operation = "assert") {
    strict(p, [
      "scope_id",
      "claim",
      "witness",
      "expected_revision",
      "id",
      "operation",
      "extraction_run_id",
      "model_proposal",
    ]);
    this.scope(p.scope_id);
    const claim = parse(claimSchema, p.claim),
      w = parse(witnessSchema, p.witness),
      rule = validateClaim(claim);
    return this.tx((r, time) => {
      const e = this.evidence(p.scope_id, w),
        subject = this.entity(p.scope_id, claim.subject),
        object = claim.object ? this.entity(p.scope_id, claim.object) : null;
      const qualifiers = stableJSON(claim.qualifiers);
      let slot = this.one(
        "SELECT * FROM fact_slots WHERE scope_id=? AND subject_id=? AND predicate=? AND qualifiers=?",
        p.scope_id,
        subject.id,
        claim.predicate,
        qualifiers,
      );
      if (!slot.id) {
        slot = { id: uuid(), aggregate_revision: 0 };
        this.insert("fact_slots", {
          id: slot.id,
          scope_id: p.scope_id,
          subject_id: subject.id,
          predicate: claim.predicate,
          qualifiers,
          cardinality: rule.single ? "single" : "multiple",
          aggregate_revision: 0,
        });
      }
      if (
        p.expected_revision !== undefined &&
        p.expected_revision !== slot.aggregate_revision
      )
        fail(
          "REVISION_CONFLICT",
          "Assertion changed; inspect the current slot revision",
        );
      if (operation !== "assert" && p.expected_revision === undefined)
        fail("INVALID_ARGUMENT", "A correction requires expected_revision");
      if (p.id) {
        const target = this.one(
          "SELECT * FROM assertion_versions WHERE (version_id=? OR logical_id=? OR slot_id=?) AND scope_id=? AND erased=0",
          p.id,
          p.id,
          p.id,
          p.scope_id,
        );
        if (!target.version_id || target.slot_id !== slot.id)
          fail(
            "INVALID_ARGUMENT",
            "Correction must resolve to the original slot",
          );
      }
      let status = "accepted";
      if (p.model_proposal || p.extraction_run_id) {
        // A quoted span proves words were said, not that the user asserted this
        // relation. Anything short of a grounded direct statement stays a candidate.
        if (!this.grounded(e, claim)) status = "candidate";
        if (
          (claim.valid_mode === "unknown" && claim.time_expression.trim()) ||
          claim.time_precision === "approximate"
        )
          status = "candidate";
      }
      if (
        e.trust === "derived_summary" ||
        claim.epistemic_type === "derived_summary" ||
        claim.epistemic_type === "inference" ||
        claim.modality !== "actual"
      )
        status = "candidate";
      if (e.trust === "document_claim") {
        if (
          claim.epistemic_type !== "document_claim" ||
          claim.modality !== "reported"
        )
          fail("INVALID_ARGUMENT", "Document claims must remain attributed");
        status = "candidate";
      }
      if (e.trust !== "instrumented" && claim.epistemic_type === "instrumented")
        fail(
          "INVALID_ARGUMENT",
          "Only instrumented evidence establishes an execution outcome",
        );
      if (
        e.trust !== "explicit_user" &&
        claim.epistemic_type === "explicit_user"
      )
        fail(
          "INVALID_ARGUMENT",
          "Only a user source establishes a user assertion",
        );
      const current = this.all(
        "SELECT * FROM assertion_versions WHERE slot_id=? AND known_to_revision IS NULL AND erased=0 AND status IN ('accepted','disputed')",
        slot.id,
      ).filter((v) => overlaps(v as any, claim));
      const member = (v: Row) => `${v.object_entity_id ?? ""}\u0000${v.value_json ?? ""}`,
        incoming = `${object?.id ?? ""}\u0000${claim.value === undefined ? "" : JSON.stringify(claim.value)}`;
      const conflicting = current.filter(
        (v) => member(v) !== incoming || v.polarity !== claim.polarity,
      );
      // The same member with opposite polarity over an overlapping interval is a
      // contradiction in any slot; other members of a multivalued slot are unrelated.
      const contradictory = current.filter(
        (v) => member(v) === incoming && v.polarity !== claim.polarity,
      );
      // A multivalued slot correction changes only its explicitly selected member;
      // resolving a dispute closes that member's whole contradictory set.
      const selected = current.find((v) => v.version_id === p.id || v.logical_id === p.id);
      const corrected = operation === 'assert' ? [] : rule.single ? current : current.filter(v=>v===selected||(operation==='resolve'&&!!selected&&member(v)===member(selected)));
      if(operation!=='assert'&&!rule.single&&!corrected.length)fail('INVALID_ARGUMENT','A multivalued correction requires an active assertion ID');
      const targets: string[] = [];
      if(operation!=='assert'&&status==='candidate'&&corrected.length){
        for(const prior of corrected)targets.push(this.amend(prior,{status:'disputed'},time));
      }
      if (operation === "assert" && status === "accepted" && (rule.single ? conflicting : contradictory).length) {
        status = "disputed";
        for (const v of rule.single ? current : contradictory)
          targets.push(this.amend(v, { status: "disputed" }, time));
      } else if (operation !== "assert" && corrected.length && status === "accepted") {
        if (
          e.trust !== "explicit_user" &&
          corrected.some((v) => conflicting.includes(v) && v.epistemic_type === "explicit_user")
        )
          fail(
            "POLICY_DENIED",
            "Weaker evidence cannot override a direct user assertion",
          );
        for (const v of corrected) {
          this.closeVersion(v, time);
          for (const interval of remainder(v as any, claim))
            targets.push(
              this.newVersion(
                { ...v, ...interval },
                this.support(v.version_id),
                time,
                v.logical_id,
              ),
            );
        }
      }
      const v = {
        slot_id: slot.id,
        scope_id: p.scope_id,
        subject_id: subject.id,
        predicate: claim.predicate,
        object_entity_id: object?.id || null,
        value_json:
          claim.value === undefined ? null : JSON.stringify(claim.value),
        qualifiers,
        polarity: claim.polarity,
        modality: claim.modality,
        epistemic_type: claim.epistemic_type,
        status,
        valid_from_us: claim.valid_from_us,
        valid_to_us: claim.valid_to_us,
        valid_mode: claim.valid_mode,
        time_precision: claim.time_precision,
        time_zone: claim.time_zone,
        time_expression: claim.time_expression,
        extraction_run_id: p.extraction_run_id || null,
        extraction_confidence: claim.extraction_confidence,
        retention_class: status === "candidate" ? "candidate" : "evidence",
        sensitivity: e.sensitivity,
        expires_at_us:
          status === "candidate"
            ? time + this.policy.candidate_days * 864e8
            : null,
      };
      const same = operation==='assert' ? current.find(prior=>!conflicting.includes(prior)&&prior.status===status&&prior.modality===v.modality&&prior.epistemic_type===v.epistemic_type&&prior.valid_mode===v.valid_mode&&prior.valid_from_us===v.valid_from_us&&prior.valid_to_us===v.valid_to_us) : undefined;
      // Repetition adds source lineage without creating a competing fact or a confidence boost.
      let version: string;
      if (same) {
        const supports = [...this.support(same.version_id).filter((old) => old.id !== e.id), e];
        if (same.known_from_revision === this.revision) version = this.amend(same, {}, time, supports);
        else {
          this.closeVersion(same, time);
          version = this.newVersion(v, supports, time, same.logical_id);
        }
      } else version = this.newVersion(v, [e], time);
      targets.push(version);
      for (const old of current)
        if (old.known_to_revision === null && operation !== "assert")
          this.lineage(version, old.version_id, "supersedes");
      this.run(
        "UPDATE fact_slots SET aggregate_revision=? WHERE id=?",
        r,
        slot.id,
      );
      this.effect(slot.id);
      if (operation !== "assert" && claim.epistemic_type === 'explicit_user')
        this.events.push({
          type: "invalidate",
          scope_id: p.scope_id,
          policy_epoch: this.epoch("policy"),
          erasure_epoch: this.epoch("erasure"),
          revision: r,
        });
      this.lineage(subject.id, e.id, "identity");
      if (object) this.lineage(object.id, e.id, "identity");
      return {
        ...this.receipt(p.scope_id, [...new Set(targets)]),
        id: version,
        slot_id: slot.id,
        status,
        aggregate_revision: r,
      };
    });
  }
  /**
   * Re-versions a current assertion. One inserted earlier in this same revision
   * (an extraction batch) is amended in place: closing it would create an empty
   * knowledge interval, and nothing outside the batch has observed it yet.
   */
  amend(v: Row, patch: Row, time: number, supports?: Row[]) {
    if (v.known_from_revision !== this.revision) {
      this.closeVersion(v, time);
      return this.newVersion({ ...v, ...patch }, supports ?? this.support(v.version_id), time, v.logical_id);
    }
    const next = { ...v, ...patch };
    this.run(
      "UPDATE assertion_versions SET status=?,retention_class=?,expires_at_us=? WHERE version_id=?",
      next.status,
      next.retention_class,
      next.expires_at_us,
      v.version_id,
    );
    for (const e of supports ?? [])
      if (!this.one("SELECT 1 AS n FROM assertion_evidence WHERE version_id=? AND evidence_id=? AND relation='support'", v.version_id, e.id).n) {
        this.insert("assertion_evidence", {
          version_id: v.version_id,
          evidence_id: e.id,
          relation: "support",
          independence_group: e.independence_group,
        });
        this.lineage(v.version_id, e.id, "support");
      }
    this.effect(v.version_id);
    return v.version_id as string;
  }
  /**
   * Conservative semantic grounding for model-proposed claims: the quoted
   * sentence must be a direct, unquoted, non-interrogative, non-hypothetical
   * first-hand statement whose negation matches the proposal and which contains
   * the named entities and a cue for the registered predicate. This is a
   * candidate gate, not a certificate of natural-language meaning.
   */
  grounded(e: Row, claim: Claim) {
    const body: string = this.one(
      "SELECT p.body FROM observations o JOIN payloads p ON p.id=o.payload_id WHERE o.id=?",
      e.observation_id,
    ).body ?? e.witness;
    const points = Array.from(body);
    let { start, end } = JSON.parse(e.locator);
    if (!Number.isInteger(start) || !Number.isInteger(end)) ({ start, end } = { start: 0, end: points.length });
    while (start > 0 && !/[.!?\n]/u.test(points[start - 1])) start--;
    while (end < points.length && !/[.!?\n]/u.test(points[end - 1] ?? "")) end++;
    if (end < points.length && /[.!?]/u.test(points[end] ?? "")) end++;
    const sentence = normalized(points.slice(start, end).join("")),
      quotation = normalized(e.witness);
    const object = normalized(claim.object?.name ?? String(claim.value));
    if (!quotation.includes(object)) return false;
    if (!quotation.includes(normalized(claim.subject.name)) && !/\bthis project\b/u.test(quotation)) return false;
    // Questions, including interrogative clauses without a terminal question mark.
    if (/\?/u.test(sentence) || /^(?:do|does|did|is|are|was|were|am|can|could|should|would|will|shall|may|might|must|has|have|had|who|whom|whose|what|when|where|why|which|how|whether)\b/u.test(sentence) ||
      /\b(?:i wonder|wondering|not sure (?:if|whether)|asked (?:if|whether)|ask (?:if|whether)|unsure)\b/u.test(sentence)) return false;
    // Hypothetical, planned, reported or quoted statements are not first-hand facts.
    if (/\b(?:if|might|could|would|may|maybe|perhaps|probably|possibly|suppose|supposing|unless|hypothetical|hypothetically|assume|assuming|plan|plans|planning|planned|will|going to|want to|wants to|should|said|says|told|tells|according to|reportedly|reported|claims?|claimed|heard|apparently|ignore|pretend|fabricate|invent)\b/u.test(sentence)) return false;
    if (/["“”«»„]/u.test(sentence)) return false;
    const negated = /\b(?:not|never|no longer|cannot|stopped|without)\b|n['’]t\b/u.test(quotation);
    if (negated !== (claim.polarity === "negative")) return false;
    const cues: Record<string, RegExp> = {
      WORKS_ON: /\b(?:works?|working|worked) on\b|\b(?:build|builds|building|develop|develops|developing|maintain|maintains|maintaining|contribute|contributes|contributing)\b/u,
      USES_TOOL: /\b(?:use|uses|used|using|run|runs|running|ran|adopt|adopts|adopted)\b|\b(?:relies|rely|relied|relying) on\b|\b(?:switched|moved|migrated) to\b|\b(?:formats?|formatted|lints?|linted|built|builds) with\b|\bpowered by\b/u,
      PREFERS_TOOL: /\b(?:prefer|prefers|preferred|preference|favou?rite|like|likes|love|loves|rather|go-to|choose|chooses|chose|pick|picks)\b/u,
      BELONGS_TO: /\b(?:belongs?|belonged) to\b|\bpart of\b|\b(?:in|inside|within|under)\b/u,
      CHECKOUT_OF: /\b(?:checkout|checked out|clone|cloned|worktree|mirror|fork)\b/u,
      IMPLEMENTS: /\b(?:implements?|implemented|implementation|code for|source for|repository for|repo for)\b/u,
      DEPENDS_ON: /\b(?:depends?|depended|depending) on\b|\b(?:dependency|dependencies|requires?|required|needs?|needed)\b|\b(?:relies|rely) on\b/u,
      BLOCKED_BY: /\b(?:blocked|blocking|blocker|stuck|waiting (?:on|for)|until)\b/u,
      LOCATED_AT: /\b(?:located|lives?|stored|kept|at|in|under|path)\b/u,
      HAS_STATE: /./u,
      RELATED_TO: /\b(?:related|relates|relation|connected|linked|associated|about|regarding)\b/u,
    };
    return cues[claim.predicate].test(quotation);
  }
  support(version: string) {
    return this.all(
      "SELECT e.* FROM evidence e JOIN assertion_evidence ae ON ae.evidence_id=e.id WHERE ae.version_id=? AND ae.relation='support' AND e.erased=0",
      version,
    );
  }
  actionEvent(p: Row) {
    strict(p, ['scope_id','session_id','action_id','execution_id','phase','name','exit_code']);
    this.scope(p.scope_id);
    if (!['proposed','authorized','running','succeeded','failed','cancelled'].includes(p.phase)) fail('INVALID_ARGUMENT','Unknown action phase');
    const text = JSON.stringify({action_id:p.action_id,execution_id:p.execution_id,phase:p.phase,name:p.name,exit_code:p.exit_code??null});
    const observation=this.observeText({scope_id:p.scope_id,text,role:'tool',session_id:p.session_id,source_event_id:p.execution_id+':'+p.phase});
    const previous=this.one("SELECT v.version_id,s.aggregate_revision FROM assertion_versions v JOIN entities e ON e.id=v.subject_id JOIN fact_slots s ON s.id=v.slot_id WHERE e.scope_id=? AND e.external_id=? AND v.known_to_revision IS NULL AND v.erased=0 ORDER BY v.known_from_revision DESC LIMIT 1",p.scope_id,p.action_id);
    const result=this.remember({scope_id:p.scope_id,...(previous.version_id?{id:previous.version_id,expected_revision:previous.aggregate_revision}:{}),claim:{subject:{type:'Action',name:p.name,external_id:p.action_id},predicate:'HAS_STATE',value:p.phase,qualifiers:{dimension:'execution'},epistemic_type:'instrumented'},witness:{observation_id:observation.id,quote:text}},previous.version_id?'correct':'assert');
    const event=this.one('SELECT id FROM events WHERE observation_id=?',observation.id);
    this.tx(r=>{this.run('UPDATE events SET kind=? WHERE id=?',p.phase,event.id);if(['succeeded','failed'].includes(p.phase)){const execution=this.one('SELECT e.id FROM events e JOIN observations o ON o.id=e.observation_id WHERE o.source_event_id=? AND e.scope_id=?',p.execution_id+':running',p.scope_id);if(execution.id)this.insert('event_edges',{id:uuid(),from_id:event.id,to_id:execution.id,relation:'RESULT_OF',evidence_id:observation.evidence_id,order_basis:'execution_id',revision:r});}this.effect(event.id);});
    return result;
  }
  snapshot() {
    return {
      revision: this.revision,
      policy_epoch: this.epoch("policy"),
      erasure_epoch: this.epoch("erasure"),
      live_generation: 0,
      projections: this.all(
        "SELECT backend,generation,watermark,status FROM projection_state WHERE active=1",
      ),
    };
  }
  graphPointers(p:Row){
    const scopes=JSON.stringify(this.effectiveScopes(p.scope_id)),k=p.known_revision??this.revision,valid=new Set<string>(),assertions=new Set<string>();
    for(const node of (p.nodes||[]).slice(0,200)){
      if(node.kind==='MemoryEntity'&&this.one('SELECT id FROM entities WHERE id=? AND scope_id IN (SELECT value FROM json_each(?)) AND erased=0',node.id,scopes).id)valid.add(node.id);
      if(node.kind==='MemoryAssertion'){const a=this.one('SELECT * FROM assertion_versions WHERE version_id=? AND scope_id IN (SELECT value FROM json_each(?))',node.id,scopes);if(a.version_id&&this.eligibleAssertion(a,k,p.world_at_us,p.model_route||'local')){valid.add(node.id);assertions.add(node.id);}}
      if(node.kind==='MemoryEvidence'&&this.one('SELECT id FROM evidence WHERE id=? AND scope_id IN (SELECT value FROM json_each(?)) AND erased=0',node.id,scopes).id)valid.add(node.id);
    }
    const reached=new Set<string>((p.seeds||[]).filter((id:string)=>valid.has(id)));
    for(let hop=0;hop<4;hop++)for(const edge of (p.edges||[]).slice(0,500)){
      if(!valid.has(edge.from)||!valid.has(edge.to)||!reached.has(edge.from)&&!reached.has(edge.to))continue;
      const assertion=assertions.has(edge.from)?edge.from:assertions.has(edge.to)?edge.to:null;if(!assertion)continue;
      const a=this.one('SELECT * FROM assertion_versions WHERE version_id=?',assertion),other=edge.from===assertion?edge.to:edge.from;
      if(edge.kind==='SUBJECT'&&a.subject_id===other||edge.kind==='OBJECT'&&a.object_entity_id===other||edge.kind==='SUPPORTED_BY'&&this.support(assertion).some(e=>e.id===other)){reached.add(edge.from);reached.add(edge.to);}
    }
    const ids:string[]=[];for(const id of reached)if(assertions.has(id))for(const a of this.all('SELECT id FROM artifacts WHERE record_id=? AND invalidated=0',id))ids.push(a.id);return ids;
  }
  knowledge(p: Row) {
    if (p.known_revision !== undefined) {
      if (
        !Number.isSafeInteger(p.known_revision) ||
        p.known_revision < 0 ||
        p.known_revision > this.revision
      )
        fail("INVALID_ARGUMENT", "Invalid knowledge revision");
      return p.known_revision;
    }
    if (p.known_at_us !== undefined)
      return this.one(
        "SELECT COALESCE(MAX(revision),0) AS n FROM commits WHERE transaction_us<=?",
        p.known_at_us,
      ).n;
    return this.revision;
  }
  eligibleAssertion(
    v: Row,
    k: number,
    world: number | undefined,
    route: string,
  ) {
    return (
      v &&
      !v.erased &&
      !!this.one(
        "SELECT id FROM entities WHERE id=? AND erased=0",
        v.subject_id,
      ).id &&
      (!v.object_entity_id ||
        !!this.one(
          "SELECT id FROM entities WHERE id=? AND erased=0",
          v.object_entity_id,
        ).id) &&
      ["accepted", "candidate", "disputed"].includes(v.status) &&
      v.known_from_revision <= k &&
      (v.known_to_revision === null || k < v.known_to_revision) &&
      eligibleTime(v as any, world) &&
      (!v.expires_at_us || v.expires_at_us > now()) &&
      (route !== "cloud" ||
        (this.policy.allow_cloud_memory && v.sensitivity !== "local_only")) &&
      this.support(v.version_id).length > 0
    );
  }
  hydrateArtifact(
    id: string,
    scope: string,
    k: number,
    world: number | undefined,
    route: string,
  ) {
    const a = this.one(
      "SELECT a.*,p.body AS text,p.erased AS payload_erased FROM artifacts a JOIN payloads p ON p.id=a.payload_id WHERE a.id=? AND a.scope_id=? AND a.invalidated=0",
      id,
      scope,
    );
    if (
      !a.id ||
      a.payload_erased ||
      a.known_from_revision > k ||
      (a.known_to_revision !== null && k >= a.known_to_revision) ||
      (a.expires_us && a.expires_us <= now()) ||
      (route === "cloud" &&
        (!this.policy.allow_cloud_memory || a.sensitivity === "local_only")) ||
      this.one(
        "SELECT target_id FROM tombstones WHERE target_id IN (?,?)",
        a.id,
        a.record_id,
      ).target_id
    )
      return null;
    if (a.kind === "assertion") {
      const v = this.one(
        "SELECT * FROM assertion_versions WHERE version_id=?",
        a.record_id,
      );
      if (!this.eligibleAssertion(v, k, world, route)) return null;
      a.assertion = v;
      a.evidence = this.support(v.version_id);
    } else {
      a.evidence = this.all(
        "WITH RECURSIVE parents(id) AS (SELECT input_id FROM lineage WHERE derived_id=? UNION SELECT l.input_id FROM lineage l JOIN parents p ON l.derived_id=p.id WHERE l.role!='supersedes') SELECT DISTINCT e.* FROM evidence e JOIN parents p ON p.id=e.id WHERE e.erased=0 AND e.scope_id=?",
        a.id,
        scope,
      );
      if (!a.evidence.length) return null;
      if (world !== undefined && a.kind === "conversation") return null;
    }
    if (
      a.evidence.some(
        (e: Row) => route === "cloud" && e.sensitivity === "local_only",
      )
    )
      return null;
    return a;
  }
  retrieve(p: Row) {
    strict(p, [
      "scope_id",
      "text",
      "token_budget",
      "known_revision",
      "known_at_us",
      "world_at_us",
      "read_token",
      "entity_ids",
      "task_id",
      "model_route",
      "semantic_ids",
      "graph_ids",
      "deadline_ms",
      "intent",
      "backend_coverage",
    ]);
    const scopes = this.effectiveScopes(p.scope_id);
    const lookupScopes = JSON.stringify(scopes);
    const text = safeText(p.text || "memory", 1000),
      route = p.model_route || "local",
      k = this.knowledge(p),
      world = p.world_at_us;
    if (world !== undefined && !Number.isSafeInteger(world))
      fail("INVALID_ARGUMENT", "World time must be UTC microseconds");
    const start = performance.now(),
      deadline =
        start +
        Math.min(
          p.deadline_ms || this.policy.deadline_ms,
          this.policy.deadline_ms,
        ),
      snapshot = this.snapshot(),
      budget = Math.min(
        p.token_budget || this.policy.memory_token_budget,
        this.policy.memory_token_budget,
      );
    const coverage: string[] = [];
    for (const b of snapshot.projections)
      if (b.watermark < snapshot.revision || b.status !== "ready")
        coverage.push(
          b.backend === "graph" ? "graph_degraded" : "semantic_degraded",
        );
    if (p.backend_coverage) coverage.push(...p.backend_coverage);
    const eligible = (a: Row) => {
        const ownerScope = this.one(
          "SELECT scope_id FROM artifacts WHERE id=?",
          a.id,
        ).scope_id;
        return scopes.includes(ownerScope)
          ? this.hydrateArtifact(a.id, ownerScope, k, world, route)
          : null;
      },
      cache = new Map<string, Row>();
    const add = (id: string) => {
      if (cache.has(id)) return cache.get(id)!;
      const a = eligible({ id });
      if (a) cache.set(id, a);
      return a;
    };
    const exact: string[] = [],
      pinned: string[] = [];
    if (p.read_token) {
      const token = this.one(
        "SELECT * FROM read_tokens WHERE token=? AND scope_id=?",
        p.read_token,
        p.scope_id,
      );
      if (!token.token)
        fail("UNAUTHORIZED_SCOPE", "Read token is not valid in this scope");
      for (const target of JSON.parse(token.targets))
        for (const a of this.all(
          "SELECT id FROM artifacts WHERE record_id=? AND scope_id=?",
          target,
          p.scope_id,
        ))
          if (add(a.id)) pinned.push(a.id);
    }
    const aliases = this.all(
      "SELECT DISTINCT e.id FROM entities e JOIN entity_aliases a ON a.entity_id=e.id WHERE e.scope_id IN (SELECT value FROM json_each(?)) AND e.erased=0 AND (a.normalized=? OR e.id=?)",
      lookupScopes,
      normalized(text),
      text,
    );
    const anchors = [
      ...new Set([
        ...aliases.map((a) => a.id),
        ...(Array.isArray(p.entity_ids) ? p.entity_ids : []),
        ...(p.task_id ? [p.task_id] : []),
      ]),
    ].slice(0, 40);
    for (const anchor of anchors) {
      // Anchors use the same authorized closure as lexical and semantic recall.
      const entity = this.one(
        "SELECT id FROM entities WHERE id=? AND scope_id IN (SELECT value FROM json_each(?)) AND erased=0",
        anchor,
        lookupScopes,
      );
      if (!entity.id) continue;
      for (const a of this.all(
        "SELECT a.id FROM artifacts a JOIN assertion_versions v ON a.record_id=v.version_id WHERE a.scope_id IN (SELECT value FROM json_each(?)) AND (v.subject_id=? OR v.object_entity_id=?) AND v.known_from_revision<=? AND (v.known_to_revision IS NULL OR ?<v.known_to_revision) AND v.erased=0 LIMIT 200",
        lookupScopes,
        anchor,
        anchor,
        k,
        k,
      ))
        if (add(a.id)) exact.push(a.id);
    }
    const fts = ftsQuery(text),
      lexical: string[] = [];
    if (fts)
      for (const a of this.all(
        "SELECT a.id FROM memory_fts f JOIN retrieval_documents d ON d.rowid=f.rowid JOIN artifacts a ON a.id=d.artifact_id WHERE memory_fts MATCH ? AND a.scope_id IN (SELECT value FROM json_each(?)) AND a.invalidated=0 AND a.known_from_revision<=? AND (a.known_to_revision IS NULL OR ?<a.known_to_revision) AND (?!='cloud' OR a.sensitivity!='local_only') ORDER BY bm25(memory_fts),a.id LIMIT 240",
        fts,
        lookupScopes,
        k,
        k,
        route,
      )) {
        if (add(a.id)) lexical.push(a.id);
        if (lexical.length >= 40 || performance.now() > deadline) break;
      }
    const semantic: string[] = [];
    for (const hit of (p.semantic_ids || []).slice(0, 120)) {
      const a = add(typeof hit === "string" ? hit : hit.artifactId);
      if (
        a &&
        (typeof hit === "string" ||
          (a.content_revision === hit.contentRevision &&
            a.source_generation === hit.sourceGeneration))
      )
        semantic.push(a.id);
    }
    const projected=(p.graph_ids||[]).slice(0,80).filter((id:string)=>!!add(id));
    const seed = [
        ...new Set([...pinned, ...exact, ...lexical, ...semantic,...projected]),
      ].slice(0, 120),
      nodes = new Set<string>(),
      paths: Row[] = [],
      edges: { from: string; to: string; weight: number }[] = [];
    let frontier: string[] = [];
    for (const a of seed) {
      const v = cache.get(a)?.assertion;
      if (v) {
        if(nodes.size+(nodes.has(v.subject_id)?0:1)+(v.object_entity_id&&!nodes.has(v.object_entity_id)?1:0)>this.policy.max_nodes)break;
        nodes.add(v.subject_id);
        frontier.push(v.subject_id);
        if (v.object_entity_id) {
          nodes.add(v.object_entity_id);
          frontier.push(v.object_entity_id);
        }
      }
    }
    const graph: string[] = [];
    for (
      let depth = 0;
      depth < this.policy.semantic_depth &&
      frontier.length &&
      performance.now() < deadline;
      depth++
    ) {
      const next: string[] = [];
      for (const entity of [...new Set(frontier)]) {
        if (
          nodes.size >= this.policy.max_nodes ||
          edges.length >= this.policy.max_edges
        )
          break;
        const selections = this.all(
          "SELECT v.*,a.id AS artifact_id FROM assertion_versions v JOIN artifacts a ON a.record_id=v.version_id WHERE v.scope_id IN (SELECT value FROM json_each(?)) AND (v.subject_id=? OR v.object_entity_id=?) AND v.erased=0 AND v.known_from_revision<=? AND (v.known_to_revision IS NULL OR ?<v.known_to_revision) AND v.status='accepted' AND v.modality='actual' ORDER BY CASE WHEN v.predicate='BLOCKED_BY' THEN 0 ELSE 1 END,v.version_id LIMIT ?",
          lookupScopes,
          entity,
          entity,
          k,
          k,
          this.policy.max_neighbors * 3,
        );
        let selected = 0;
        for (const v of selections) {
          const a = add(v.artifact_id);
          if (!a || !v.object_entity_id) continue;
          if (++selected > this.policy.max_neighbors) break;
          const other =
            v.subject_id === entity ? v.object_entity_id : v.subject_id;
          if (!nodes.has(other)) {
            if (nodes.size >= this.policy.max_nodes) break;
            nodes.add(other);
            next.push(other);
          }
          graph.push(a.id);
          edges.push({
            from: entity,
            to: other,
            weight:
              v.predicate === "BLOCKED_BY" &&
              /block|stuck|unresolved/i.test(text)
                ? 3
                : 1,
          });
          paths.push({
            from: entity,
            to: other,
            predicate: v.predicate,
            assertion_id: v.version_id,
            evidence_ids: a.evidence.map((e: Row) => e.id),
          });
          if (edges.length >= this.policy.max_edges) break;
        }
      }
      frontier = next;
    }
    let graphRank = graph;
    if (this.policy.relational_ranker && edges.length) {
      const weights = new Map<string, number>();
      for (const aid of seed) {
        const v = cache.get(aid)?.assertion;
        if (v) weights.set(v.subject_id, (weights.get(v.subject_id) || 0) + 1);
      }
      const scores = relationalRank(weights, edges);
      graphRank = [...new Set(graph)].sort((a, b) => {
        const av = cache.get(a)!.assertion,
          bv = cache.get(b)!.assertion;
        return (
          (scores.get(bv.subject_id) || 0) - (scores.get(av.subject_id) || 0) ||
          a.localeCompare(b)
        );
      });
    }
    const ranks = rrf([exact, lexical, semantic, graphRank,projected]);
    if(world===undefined)for(const rank of ranks){const artifact=cache.get(rank[0])!;if(['conversation','episode','topic'].includes(artifact.kind)){const created=this.one('SELECT transaction_us FROM commits WHERE revision=?',artifact.content_revision).transaction_us;rank[1]*=2**(-Math.max(0,now()-created)/(864e8*this.policy.half_life_days));}}
    ranks.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    const ordered = [...new Set([...pinned, ...ranks.map((r) => r[0])])].slice(
      0,
      80,
    );
    const assertions: Row[] = [],
      episodes: Row[] = [],
      conflicts: Row[] = [],
      evidence: Row[] = [],
      results: Row[] = [];
    const evidenceIds = new Set<string>();
    let used = 0,
      trimmed = 0;
    for (const aid of ordered) {
      const a = cache.get(aid)!;
      const witnesses = a.evidence.filter((e: Row) => !evidenceIds.has(e.id));
      const needed = estimateTokens(
        a.text +
          JSON.stringify(
            witnesses.map((e: Row) => ({
              id: e.id,
              witness: e.witness,
              locator: e.locator,
            })),
          ),
      );
      if (used + needed > budget || evidence.length + witnesses.length > 24) {
        trimmed++;
        continue;
      }
      used += needed;
      for (const e of witnesses) {
        evidenceIds.add(e.id);
        evidence.push({
          id: e.id,
          observation_id: e.observation_id,
          source_revision: e.source_revision,
          locator: JSON.parse(e.locator),
          witness: e.witness,
          trust: e.trust,
          independence_group: e.independence_group,
        });
      }
      if (a.assertion) {
        const v = a.assertion,
          item = {
            ...v,
            qualifiers: JSON.parse(v.qualifiers),
            value: v.value_json === null ? null : JSON.parse(v.value_json),
            claim: a.text,
            evidence_ids: a.evidence.map((e: Row) => e.id),
            why: pinned.includes(aid)
              ? "read_after_write"
              : graph.includes(aid)
                ? "eligible_relationship"
                : lexical.includes(aid)
                  ? "lexical"
                  : "semantic",
          };
        delete item.value_json;
        if (
          v.status !== "accepted" ||
          v.modality !== "actual" ||
          v.valid_mode === "unknown"
        )
          conflicts.push(item);
        else assertions.push(item);
      } else
        episodes.push({
          id: a.record_id,
          kind: a.kind,
          text: a.text,
          evidence_ids: a.evidence.map((e: Row) => e.id),
        });
      results.push({
        id: a.record_id,
        artifact_id: a.id,
        kind: a.kind === "assertion" ? "saved" : a.kind,
        text: a.text,
        date: new Date(
          this.one(
            "SELECT transaction_us FROM commits WHERE revision=?",
            a.content_revision,
          ).transaction_us / 1000,
        ).toISOString(),
        sessionId: a.session_id,
        score: ranks.find((r) => r[0] === aid)?.[1] || 1,
        revision: a.content_revision,
      });
    }
    if (performance.now() > deadline) coverage.push("deadline_partial");
    if (trimmed) coverage.push("token_budget_trimmed");
    if (route === "cloud" && !this.policy.allow_cloud_memory)
      coverage.push("cloud_memory_denied");
    return {
      snapshot,
      query_interpretation: {
        text,
        world_at_us: world ?? null,
        known_revision: k,
        anchors,
        effective_scopes: scopes,
        uncertainty: conflicts.length
          ? "Contains disputed, planned or uncertain claims"
          : null,
      },
      workspace: { freshness: "unknown" },
      assertions,
      episodes,
      conflicts,
      paths: paths.filter((path) =>
        assertions.some((a) => a.version_id === path.assertion_id),
      ),
      evidence,
      coverage: [...new Set(coverage)],
      budget: { estimated_tokens: used, limit: budget, trimmed_items: trimmed },
      metrics: {
        latency_ms: performance.now() - start,
        nodes: nodes.size,
        edges: edges.length,
        candidates: cache.size,
      },
      results,
      mode: semantic.length ? "semantic" : "keyword",
      warning: coverage.length
        ? "Memory coverage: " + [...new Set(coverage)].join(", ")
        : "",
      pending: this.one("SELECT COUNT(*) AS n FROM outbox WHERE state!='done'")
        .n,
    };
  }
  /** Formats one assertion from joined subject/object names, without per-row lookups. */
  static claimText(v: Row, subject: string, object: string | null) {
    const target = v.object_entity_id ? object : JSON.parse(v.value_json);
    return `${subject} ${v.polarity === "negative" ? "does not " : ""}${v.predicate} ${target}${v.qualifiers !== "{}" ? " " + v.qualifiers : ""} [${v.modality}; ${v.valid_mode}]`;
  }
  /**
   * One COUNT and one bounded page per view. Only the selected page is
   * materialized and formatted; ordering has a deterministic ID tie-break.
   */
  list(p: Row) {
    strict(p, ["scope_id", "kind", "filter", "offset"]);
    this.scope(p.scope_id);
    const kind = p.kind || "saved",
      offset = p.offset || 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof (p.filter || "") !== "string" ||
      (p.filter || "").length > 200
    )
      fail("INVALID_ARGUMENT", "Invalid memory filter");
    const pattern =
      "%" + String(p.filter || "").replace(/[\\%_]/g, "\\$&") + "%";
    const page = (from: string, columns: string, order: string, ...args: any[]) => ({
      total: this.one(`SELECT COUNT(*) AS n ${from}`, ...args).n as number,
      rows: this.all(`SELECT ${columns} ${from} ORDER BY ${order} LIMIT 25 OFFSET ?`, ...args, offset),
    });
    let result: { total: number; rows: Row[] };
    if (kind === "entities")
      result = page(
        "FROM entities WHERE scope_id=? AND erased=0 AND name LIKE ? ESCAPE '\\'",
        "id,name AS text,type,identity_revision AS revision",
        "name,id",
        p.scope_id,
        pattern,
      );
    else if (kind === "episodes")
      result = page(
        "FROM episodes WHERE scope_id=? AND erased=0 AND thread_id LIKE ? ESCAPE '\\'",
        "id,thread_id AS text,state,revision,source_generation",
        "revision DESC,id",
        p.scope_id,
        pattern,
      );
    else if (kind === "assertions") {
      result = page(
        "FROM assertion_versions v JOIN entities s ON s.id=v.subject_id LEFT JOIN entities o ON o.id=v.object_entity_id WHERE v.scope_id=? AND v.erased=0 AND v.known_to_revision IS NULL AND (s.name LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\' OR v.predicate LIKE ? ESCAPE '\\' OR v.value_json LIKE ? ESCAPE '\\')",
        "v.version_id AS id,v.status,v.predicate,v.aggregate_revision AS revision,v.polarity,v.modality,v.valid_mode,v.qualifiers,v.value_json,v.object_entity_id,s.name AS subject_name,o.name AS object_name",
        "v.aggregate_revision DESC,v.version_id",
        p.scope_id,
        pattern,
        pattern,
        pattern,
        pattern,
      );
      result.rows = result.rows.map(({ polarity, modality, valid_mode, qualifiers, value_json, object_entity_id, subject_name, object_name, ...row }) => ({
        ...row,
        text: Canonical.claimText({ polarity, modality, valid_mode, qualifiers, value_json, object_entity_id, predicate: row.predicate }, subject_name, object_name),
      }));
    } else if (["saved", "conversation"].includes(kind))
      result = page(
        "FROM artifacts a JOIN payloads p ON p.id=a.payload_id JOIN commits c ON c.revision=a.content_revision WHERE a.scope_id=? AND a.kind=? AND a.invalidated=0 AND a.known_to_revision IS NULL AND p.erased=0 AND p.body LIKE ? ESCAPE '\\'",
        "a.record_id AS id,a.kind,p.body AS text,a.content_revision AS revision,c.transaction_us/1000 AS updated,c.transaction_us/1000 AS created",
        "a.content_revision DESC,a.id",
        p.scope_id,
        kind,
        pattern,
      );
    else fail("INVALID_ARGUMENT", "Unsupported memory view");
    return { rows: result.rows, total: result.total, offset };
  }
  inspect(p: Row) {
    strict(p, ["scope_id", "id", "known_revision", "world_at_us"]);
    this.scope(p.scope_id);
    if (
      this.one("SELECT target_id FROM tombstones WHERE target_id=?", p.id)
        .target_id
    )
      fail("NOT_FOUND", "Record was erased");
    let record = this.one(
      "SELECT * FROM assertion_versions WHERE (version_id=? OR logical_id=?) AND scope_id=? AND erased=0 ORDER BY known_from_revision DESC LIMIT 1",
      p.id,
      p.id,
      p.scope_id,
    );
    let history: Row[] = [];
    if (record.version_id) {
      history = this.all(
        "SELECT * FROM assertion_versions WHERE slot_id=? AND erased=0 ORDER BY known_from_revision,valid_from_us",
        record.slot_id,
      ).map((v) => ({
        ...v,
        claim: this.assertionText(v),
        evidence: this.support(v.version_id),
      }));
      if (p.known_revision !== undefined || p.world_at_us !== undefined) {
        const known = this.knowledge(p);
        const selected = history.find((v) =>
          this.eligibleAssertion(v, known, p.world_at_us, "local"),
        );
        if (!selected)
          fail(
            "NOT_FOUND",
            "No supported interpretation at the requested time",
          );
        record = selected;
      }
      record = {
        ...record,
        subject: this.one(
          "SELECT id,type,name FROM entities WHERE id=?",
          record.subject_id,
        ),
        object: record.object_entity_id
          ? this.one(
              "SELECT id,type,name FROM entities WHERE id=?",
              record.object_entity_id,
            )
          : null,
        claim: this.assertionText(record),
        aggregate_revision: this.one(
          "SELECT aggregate_revision FROM fact_slots WHERE id=?",
          record.slot_id,
        ).aggregate_revision,
      };
      record.claim_data = this.claimData(record);
    } else
      for (const table of [
        "entities",
        "episodes",
        "observations",
        "evidence",
        "artifacts",
        "topics",
      ]) {
        record = this.one(
          `SELECT * FROM ${table} WHERE id=? AND scope_id=?`,
          p.id,
          p.scope_id,
        );
        if (record.id && !record.erased) break;
        record = {};
      }
    if (!record.id && !record.version_id)
      fail("NOT_FOUND", "Memory record is not available in this scope");
    const ids = this.descendants([p.id]);
    return {
      record,
      history,
      lineage: this.all(
        "SELECT * FROM lineage WHERE derived_id=? OR input_id=?",
        p.id,
        p.id,
      ),
      evidence: record.version_id
        ? this.support(record.version_id)
        : this.all(
            "SELECT * FROM evidence WHERE observation_id=? AND erased=0",
            p.id,
          ),
      events: record.thread_id
        ? this.all(
            "SELECT e.id,e.kind,e.actor,e.occurred_us,e.stream_sequence FROM events e JOIN episode_events m ON m.event_id=e.id WHERE m.episode_id=? AND e.erased=0 ORDER BY m.ordering",
            p.id,
          )
        : [],
      dependent_count: ids.length,
      projections: this.snapshot().projections,
    };
  }
  /**
   * The complete versioned claim, typed for a correction round trip. Every
   * semantic field is explicit so a client never falls back to schema defaults.
   */
  claimData(v: Row) {
    const entity = (id: string) => {
      const e = this.one("SELECT id,type,name FROM entities WHERE id=?", id);
      return { id: e.id, type: e.type, name: e.name };
    };
    return {
      subject: entity(v.subject_id),
      predicate: v.predicate,
      ...(v.object_entity_id
        ? { object: entity(v.object_entity_id) }
        : { value: JSON.parse(v.value_json) }),
      qualifiers: JSON.parse(v.qualifiers),
      polarity: v.polarity,
      modality: v.modality,
      epistemic_type: v.epistemic_type,
      valid_mode: v.valid_mode,
      valid_from_us: v.valid_from_us,
      valid_to_us: v.valid_to_us,
      time_precision: v.time_precision,
      time_zone: v.time_zone,
      time_expression: v.time_expression,
      extraction_confidence: v.extraction_confidence,
    };
  }
  descendants(ids: string[]) {
    const found = new Set(ids),
      queue = [...ids];
    while (queue.length) {
      const id = queue.shift()!;
      for (const row of this.all(
        "SELECT derived_id FROM lineage WHERE input_id=? AND role NOT IN ('identity','supersedes') UNION SELECT version_id AS derived_id FROM assertion_versions WHERE subject_id=? OR object_entity_id=? UNION SELECT id AS derived_id FROM artifacts WHERE record_id=?",
        id,
        id,
        id,
        id,
      )) {
        if (!found.has(row.derived_id)) {
          found.add(row.derived_id);
          queue.push(row.derived_id);
        }
      }
      if (found.size > 200000)
        fail(
          "BACKEND_UNAVAILABLE",
          "Erasure closure exceeds the maintenance quota",
        );
    }
    return [...found];
  }
  /**
   * Resolves a forget request to its stable identity before descendant closure.
   * A visible saved-note ID selects every revision of the note; a logical
   * assertion ID selects every version and supporting source of that fact; an
   * explicit observation selects only that occurrence, so independently
   * supported facts survive. The same resolver serves preview, transcript
   * scrubbing, suppression and registry replay.
   */
  resolveForget(scope: string, p: Row): { selector: Row; roots: string[] } {
    if (!p.id) {
      const from = p.from_us ?? 0,
        to = p.to_us ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to))
        fail("INVALID_ARGUMENT", "Forget range must use UTC microseconds");
      return {
        selector: { kind: "range", from_us: from, to_us: to },
        roots: this.all(
          "SELECT id FROM observations WHERE scope_id=? AND erased=0 AND captured_us>=? AND captured_us<?",
          scope,
          from,
          to,
        ).map((r) => r.id),
      };
    }
    const id = String(p.id);
    const note = this.one(
      "SELECT record_id FROM artifacts WHERE scope_id=? AND kind='saved' AND (record_id=? OR id=?) LIMIT 1",
      scope,
      id,
      id,
    ).record_id;
    if (note) return { selector: { kind: "note", id: note }, roots: this.noteSources(scope, note) };
    const roots: string[] = [];
    let kind = "";
    const version = this.one(
      "SELECT version_id FROM assertion_versions WHERE version_id=? AND scope_id=?",
      id,
      scope,
    ).version_id;
    const logical = version
      ? []
      : this.all(
          "SELECT version_id FROM assertion_versions WHERE logical_id=? AND scope_id=? ORDER BY known_from_revision",
          id,
          scope,
        ).map((v) => v.version_id);
    if (version) {
      kind = "assertion_version";
      roots.push(version);
    } else if (logical.length) {
      // The logical ID itself stays in the target list as the registry's selector marker.
      kind = "logical_assertion";
      roots.push(...logical);
      for (const v of logical)
        for (const e of this.allSupport(v)) roots.push(e.observation_id);
    } else
      for (const table of [
        "observations",
        "entities",
        "episodes",
        "artifacts",
        "evidence",
        "topics",
      ])
        if (
          this.one(
            `SELECT id FROM ${table} WHERE id=? AND scope_id=?`,
            id,
            scope,
          ).id
        ) {
          kind = table === "observations" ? "observation" : table === "entities" ? "entity" : "record";
          break;
        }
    if (!kind) fail("NOT_FOUND", "Forget target is not in this scope");
    roots.push(id);
    return { selector: { kind, id }, roots };
  }
  /** Every source occurrence and artifact of a saved note, including all edits. */
  noteSources(scope: string, note: string) {
    const roots = new Set<string>([note]);
    for (const row of this.all(
      "SELECT n.observation_id,n.artifact_id FROM note_revisions n JOIN observations o ON o.id=n.observation_id WHERE n.note_id=? AND o.scope_id=?",
      note,
      scope,
    )) {
      roots.add(row.observation_id);
      roots.add(row.artifact_id);
    }
    // Artifact -> evidence lineage also recovers edits recorded before note revisions existed.
    for (const artifact of this.all(
      "SELECT id FROM artifacts WHERE scope_id=? AND kind='saved' AND record_id=?",
      scope,
      note,
    )) {
      roots.add(artifact.id);
      for (const source of this.all(
        "SELECT e.observation_id FROM lineage l JOIN evidence e ON e.id=l.input_id WHERE l.derived_id=? AND l.role='derived'",
        artifact.id,
      ))
        roots.add(source.observation_id);
    }
    return [...roots];
  }
  /** Support rows regardless of prior erasure; closure must include already-suppressed sources. */
  allSupport(version: string) {
    return this.all(
      "SELECT e.* FROM evidence e JOIN assertion_evidence ae ON ae.evidence_id=e.id WHERE ae.version_id=? AND ae.relation='support'",
      version,
    );
  }
  forgetPreview(p: Row) {
    strict(p, ["scope_id", "id", "from_us", "to_us"]);
    this.scope(p.scope_id);
    const { selector, roots } = this.resolveForget(p.scope_id, p);
    const ids = this.closure(roots, !!p.id);
    return {
      scope_id: p.scope_id,
      selector,
      target_ids: ids,
      count: ids.length,
      source_policy:
        "Whole supporting source removed when safe span redaction is not established",
      revision: this.revision,
      // Binds a confirmation to exactly this selector, target set and revision.
      selection: digest(
        JSON.stringify([p.scope_id, selector, [...ids].sort(), this.revision]),
      ),
    };
  }
  /** Descendant erasure closure with independent-survivor and orphan-entity handling. */
  closure(initial: string[], selected = true) {
    const roots = [...initial];
    // Conservative source occurrence removal: entire supporting source when safe span redaction is not established.
    for (const root of [...roots]) {
      for (const e of this.support(root)) roots.push(e.observation_id);
      const ev = this.one(
        "SELECT observation_id FROM evidence WHERE id=?",
        root,
      );
      if (ev.observation_id) roots.push(ev.observation_id);
      const art = this.one("SELECT record_id FROM artifacts WHERE id=?", root);
      if (art.record_id) roots.push(art.record_id);
    }
    if(selected) {
      for(const root of [...roots]) {
        const assertions=this.all('SELECT version_id FROM assertion_versions WHERE version_id=? OR subject_id=? OR object_entity_id=?',root,root,root);
        for(const assertion of assertions)for(const support of this.support(assertion.version_id))roots.push(support.observation_id);
      }
    }
    let ids = this.descendants([...new Set(roots)]);
    const erasedGroups=new Set(this.all('SELECT id,observation_id,independence_group FROM evidence').filter(e=>ids.includes(e.id)||ids.includes(e.observation_id)).map(e=>e.independence_group));
    const survivors=new Set<string>();
    for(const target of ids){const v=this.one('SELECT * FROM assertion_versions WHERE version_id=? AND erased=0 AND known_to_revision IS NULL',target);if(v.version_id&&this.support(target).some(e=>!ids.includes(e.id)&&!ids.includes(e.observation_id)&&!erasedGroups.has(e.independence_group))){survivors.add(v.subject_id);if(v.object_entity_id)survivors.add(v.object_entity_id);}}
    const candidates = new Set<string>();
    for (const target of ids) {
      const v = this.one(
        "SELECT subject_id,object_entity_id FROM assertion_versions WHERE version_id=?",
        target,
      );
      if (v.subject_id) candidates.add(v.subject_id);
      if (v.object_entity_id) candidates.add(v.object_entity_id);
    }
    for (const entity of candidates) {
      const other = this.all(
        "SELECT version_id FROM assertion_versions WHERE (subject_id=? OR object_entity_id=?) AND erased=0",
        entity,
        entity,
      ).some((v) => !ids.includes(v.version_id));
      if (!other && !survivors.has(entity)) ids.push(entity);
    }
    return [...new Set(ids)];
  }
  appendRegistry(intent: Row) {
    const file = join(this.directory, "erasure-registry.jsonl"),
      fd = openSync(file, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(intent) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directory = openSync(this.directory, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  forget(p: Row, reason = "forget") {
    const { expected_revision, selection, ...selector } = p;
    const preview = this.forgetPreview(selector);
    if (
      expected_revision !== undefined &&
      expected_revision !== this.revision
    )
      fail("REVISION_CONFLICT", "Memory changed since forget preview");
    if (selection !== undefined && selection !== preview.selection)
      fail("SELECTION_MISMATCH", "The forget request differs from the previewed record");
    const intent = {
      id: uuid(),
      scope_id: p.scope_id,
      epoch: this.epoch("erasure") + 1,
      selector: preview.selector,
      targets: preview.target_ids,
    };
    this.appendRegistry(intent);
    return this.suppress(intent, reason);
  }
  suppress(intent: Row, reason: string) {
    const existing = this.one(
      "SELECT * FROM erasure_jobs WHERE id=?",
      intent.id,
    );
    if (existing.id) return existing;
    return this.tx((r,time) => {
      this.setMeta(
        "erasure_epoch",
        Math.max(intent.epoch, this.epoch("erasure")),
      );
      this.insert("erasure_jobs", {
        id: intent.id,
        scope_id: intent.scope_id,
        epoch: intent.epoch,
        state: "SUPPRESSED",
        canonical_ack: 1,
        revision: r,
        reason,
      });
      const targetSet=new Set<string>(intent.targets),rederive: {version:Row;evidence:Row[]}[]=[];
      const erasedGroups=new Set(this.all('SELECT id,observation_id,independence_group FROM evidence').filter(e=>targetSet.has(e.id)||targetSet.has(e.observation_id)).map(e=>e.independence_group));
      for(const target of intent.targets){
        const version=this.one('SELECT * FROM assertion_versions WHERE version_id=? AND erased=0 AND known_to_revision IS NULL',target);
        if(!version.version_id||targetSet.has(version.subject_id)||targetSet.has(version.object_entity_id))continue;
        const evidence=this.support(target).filter(e=>!targetSet.has(e.id)&&!targetSet.has(e.observation_id)&&!erasedGroups.has(e.independence_group));
        if(evidence.length)rederive.push({version,evidence});
      }
      for (const target of intent.targets) {
        this.run(
          "INSERT OR IGNORE INTO tombstones VALUES (?,?,?,?)",
          target,
          intent.id,
          intent.epoch,
          r,
        );
        this.effect(target);
        this.run("DELETE FROM retrieval_documents WHERE artifact_id=?", target);
        this.run("DELETE FROM embedding_records WHERE artifact_id=?", target);
        this.run(
          "UPDATE artifacts SET invalidated=1 WHERE id=? OR record_id=?",
          target,
          target,
        );
        this.run(
          "UPDATE payloads SET body='',digest='',erased=1 WHERE id=?",
          target,
        );
        this.run(
          "UPDATE evidence SET witness='',digest='',locator='{}',erased=1 WHERE id=?",
          target,
        );
      this.run(
        "UPDATE observations SET erased=1,extraction_state='erased' WHERE id=?",
          target,
        );
        this.run(
          "UPDATE extraction_runs SET status='erased',model_identity='',error_code=NULL WHERE observation_id=?",
          target,
        );
        this.run(
          "UPDATE assertion_versions SET erased=1,status='erased',object_entity_id=NULL,value_json='null',qualifiers='{}',time_expression='',predicate='ERASED' WHERE version_id=?",
          target,
        );
        this.run(
          "UPDATE entities SET erased=1,name='',external_id=NULL WHERE id=?",
          target,
        );
        this.run("DELETE FROM entity_aliases WHERE entity_id=?", target);
        this.run(
          "DELETE FROM identity_links WHERE left_id=? OR right_id=? OR evidence_id=?",
          target,
          target,
          target,
        );
        this.run(
          "DELETE FROM event_edges WHERE from_id=? OR to_id=? OR evidence_id=?",
          target,
          target,
          target,
        );
        this.run("UPDATE events SET erased=1 WHERE id=?", target);
        this.run(
          "UPDATE episodes SET erased=1,summary_id=NULL WHERE id=?",
          target,
        );
        this.run(
          "UPDATE topics SET erased=1,name='',summary_id=NULL WHERE id=?",
          target,
        );
        this.run(
          "DELETE FROM topic_links WHERE topic_id=? OR target_id=?",
          target,
          target,
        );
        this.run(
          "UPDATE response_records SET erased=1,response_ref='',supplied_evidence_ids='[]',cited_evidence_ids='[]' WHERE id=?",
          target,
        );
      }
      this.run(
        "DELETE FROM retrieval_documents WHERE artifact_id IN (SELECT id FROM artifacts WHERE invalidated=1)",
      );
      this.run("UPDATE fact_slots SET predicate='ERASED:'||id,qualifiers='{}' WHERE NOT EXISTS (SELECT 1 FROM assertion_versions a WHERE a.slot_id=fact_slots.id AND a.erased=0)");
      for(const {version,evidence} of rederive){
        this.run('UPDATE fact_slots SET predicate=?,qualifiers=?,aggregate_revision=? WHERE id=?',version.predicate,version.qualifiers,r,version.slot_id);
        this.newVersion(version,evidence,time,version.logical_id);
      }
      this.run("DELETE FROM read_tokens WHERE scope_id=?", intent.scope_id);
      // The epoch advance and the rescheduling of unrelated queued extraction commit together.
      this.reconcileExtraction();
      this.events.push({
        type: "invalidate",
        scope_id: intent.scope_id,
        policy_epoch: this.epoch("policy"),
        erasure_epoch: this.epoch("erasure"),
      });
      return {
        id: intent.id,
        job_id: intent.id,
        state: "SUPPRESSED",
        suppressed: true,
        purge_complete: false,
        deleted: intent.targets.length,
        revision: r,
      };
    });
  }
  registryRepairs: { supplemented: Row[]; unresolved: Row[] } = { supplemented: [], unresolved: [] };
  reconcileRegistry() {
    const path = join(this.directory, "erasure-registry.jsonl");
    if (!existsSync(path)) {
      if (this.epoch("erasure") > 0)
        fail("INCOMPATIBLE_SCHEMA", "Current erasure registry is missing");
      this.appendRegistry({ registry_version: 1, owner_id: this.owner });
      return;
    }
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    const intents: Row[] = [];
    for (const line of lines) {
      let intent: Row;
      try {
        intent = JSON.parse(line);
      } catch {
        fail(
          "INCOMPATIBLE_SCHEMA",
          "Erasure registry is incomplete; restore requires recovery",
        );
      }
      if (intent.registry_version) {
        if (intent.owner_id !== this.owner)
          fail(
            "INCOMPATIBLE_SCHEMA",
            "Erasure registry belongs to a different profile",
          );
        continue;
      }
      intents.push(intent);
      if (
        !this.one("SELECT id FROM erasure_jobs WHERE id=?", intent.id).id &&
        this.one("SELECT id FROM scopes WHERE id=?", intent.scope_id).id
      )
        this.suppress(
          { ...intent, targets: this.descendants([...intent.targets, ...this.selectorRoots(intent)]) },
          "registry_recovery",
        );
    }
    this.repairRegistry(intents);
  }
  /** Roots a recorded selector still resolves to; used when replaying the registry. */
  selectorRoots(intent: Row): string[] {
    const selector = intent.selector;
    if (!selector?.id || !this.one("SELECT id FROM scopes WHERE id=?", intent.scope_id).id) return [];
    if (selector.kind === "note") return this.noteSources(intent.scope_id, selector.id);
    if (selector.kind === "logical_assertion") {
      const roots: string[] = [];
      for (const v of this.all("SELECT version_id FROM assertion_versions WHERE logical_id=? AND scope_id=?", selector.id, intent.scope_id)) {
        roots.push(v.version_id);
        for (const e of this.allSupport(v.version_id)) roots.push(e.observation_id);
      }
      return roots;
    }
    return [];
  }
  /**
   * Completes erasures recorded before stable-identity resolution existed. Only
   * provable closures are repaired: an erased saved-note artifact proves its own
   * source revision was meant to go, and a logical assertion ID recorded as a
   * target proves whole-fact deletion. Supplementary intents are appended and
   * fsynced before suppression; original entries stay immutable and a reopen
   * after repair finds nothing left to add. Ambiguous legacy entries are exposed
   * for review instead of being widened.
   */
  repairRegistry(intents: Row[]) {
    const tombstoned = (id: string) => !!this.one("SELECT target_id FROM tombstones WHERE target_id=?", id).target_id;
    const repairs = { supplemented: [] as Row[], unresolved: [] as Row[] };
    for (const intent of intents) {
      // Selector-bearing intents were resolved completely when recorded, and replay re-resolves them.
      if (intent.selector || !this.one("SELECT id FROM scopes WHERE id=?", intent.scope_id).id) continue;
      const roots = new Set<string>();
      for (const target of intent.targets as string[]) {
        const artifact = this.one("SELECT record_id FROM artifacts WHERE id=? AND kind='saved'", target);
        if (artifact.record_id) for (const root of this.noteSources(intent.scope_id, artifact.record_id)) roots.add(root);
        const logical = this.one("SELECT 1 AS n FROM assertion_versions WHERE logical_id=? AND version_id!=? LIMIT 1", target, target).n;
        if (logical) for (const root of this.selectorRoots({ ...intent, selector: { kind: "logical_assertion", id: target } })) roots.add(root);
      }
      const missing = roots.size ? this.closure([...roots]).filter((id) => !tombstoned(id)) : [];
      if (missing.length) {
        const supplement = {
          id: uuid(),
          scope_id: intent.scope_id,
          epoch: this.epoch("erasure") + 1,
          supplements: intent.id,
          selector: { kind: "registry_repair", of: intent.id },
          targets: missing,
        };
        this.appendRegistry(supplement);
        this.suppress(supplement, "registry_repair");
        repairs.supplemented.push({ intent_id: intent.id, supplement_id: supplement.id, count: missing.length });
      }
      if (this.one("SELECT reason FROM erasure_jobs WHERE id=?", intent.id).reason === "expiration") continue;
      // A legacy target list cannot say whether a surviving version of a touched fact
      // was an intended independent survivor or a missed whole-fact deletion.
      const live = new Set<string>();
      for (const target of intent.targets as string[]) {
        const version = this.one("SELECT logical_id FROM assertion_versions WHERE version_id=?", target);
        if (version.logical_id && !(intent.targets as string[]).includes(version.logical_id) &&
          this.one("SELECT 1 AS n FROM assertion_versions WHERE logical_id=? AND erased=0 AND known_to_revision IS NULL LIMIT 1", version.logical_id).n)
          live.add(version.logical_id);
      }
      if (live.size) repairs.unresolved.push({ intent_id: intent.id, logical_ids: [...live], reason: "LEGACY_SELECTOR_AMBIGUOUS" });
    }
    this.registryRepairs = repairs;
  }
  policyUpdate(p: Row) {
    strict(p, ["policy", "expected_epoch"]);
    if (
      p.expected_epoch !== undefined &&
      p.expected_epoch !== this.epoch("policy")
    )
      fail("REVISION_CONFLICT", "Policy changed");
    const next = parse(policySchema, { ...this.policy, ...p.policy });
    return this.tx(() => {
      this.policy = next;
      this.setMeta("policy", next);
      this.setMeta("policy_epoch", this.epoch("policy") + 1);
      // Stale in-flight work stays rejected by its epoch; retained eligible sources are
      // rescheduled under the new policy instead of being stranded as revoked.
      this.reconcileExtraction();
      this.events.push({
        type: "invalidate",
        policy_epoch: this.epoch("policy"),
        erasure_epoch: this.epoch("erasure"),
      });
      return { policy: next, epoch: this.epoch("policy") };
    });
  }
  freezeEpisode(p: Row) {
    strict(p, ["scope_id", "id"]);
    this.scope(p.scope_id);
    const e = this.one(
      "SELECT * FROM episodes WHERE id=? AND scope_id=? AND erased=0",
      p.id,
      p.scope_id,
    );
    if (!e.id) fail("NOT_FOUND", "Episode does not exist");
    if (e.state === "archived") return e;
    if (["consolidating", "retryable"].includes(e.state))
      // A retry revalidates the already-frozen membership under current epochs. The
      // successor created at the first freeze keeps every late event.
      return this.tx((r) => {
        this.run(
          "UPDATE episodes SET state='consolidating',revision=?,source_generation=?,policy_epoch=?,erasure_epoch=? WHERE id=?",
          r,
          r,
          this.epoch("policy"),
          this.epoch("erasure"),
          e.id,
        );
        this.effect(e.id);
        return this.one("SELECT * FROM episodes WHERE id=?", e.id);
      });
    return this.tx((r) => {
      const cutoff = this.one(
        "SELECT COALESCE(MAX(ev.revision),0) AS n FROM episode_events m JOIN events ev ON ev.id=m.event_id WHERE m.episode_id=?",
        e.id,
      ).n;
      this.run(
        "UPDATE episodes SET state='consolidating',event_cutoff=?,revision=?,policy_epoch=?,erasure_epoch=? WHERE id=?",
        cutoff,
        r,
        this.epoch("policy"),
        this.epoch("erasure"),
        e.id,
      );
      const successor = uuid();
      this.insert("episodes", {
        id: successor,
        scope_id: p.scope_id,
        thread_id: e.thread_id,
        state: "open",
        source_generation: r,
        revision: r,
        policy_epoch: this.epoch("policy"),
        erasure_epoch: this.epoch("erasure"),
        previous_id: e.id,
      });
      this.effect(e.id);
      return this.one("SELECT * FROM episodes WHERE id=?", e.id);
    });
  }
  archiveEpisode(p: Row) {
    strict(p, [
      "scope_id",
      "id",
      "source_generation",
      "policy_epoch",
      "erasure_epoch",
      "claims",
      "topic_names",
    ]);
    this.scope(p.scope_id);
    const e = this.one(
      "SELECT * FROM episodes WHERE id=? AND scope_id=? AND erased=0",
      p.id,
      p.scope_id,
    );
    if (
      !e.id ||
      !["consolidating", "retryable"].includes(e.state) ||
      e.source_generation !== p.source_generation ||
      this.epoch("policy") !== p.policy_epoch ||
      this.epoch("erasure") !== p.erasure_epoch
    )
      fail("SOURCE_CHANGED", "Frozen episode changed before publication");
    if (!Array.isArray(p.claims) || p.claims.length > 50)
      fail("INVALID_ARGUMENT", "Invalid structured summary");
    const members = new Set(
      this.all(
        "SELECT e.id FROM evidence e JOIN events ev ON ev.observation_id=e.observation_id JOIN episode_events m ON m.event_id=ev.id WHERE m.episode_id=? AND e.erased=0",
        e.id,
      ).map((r) => r.id),
    );
    for (const claim of p.claims) {
      strict(claim, ["text", "evidence_ids"]);
      safeText(claim.text, 2000);
      if (
        !Array.isArray(claim.evidence_ids) ||
        !claim.evidence_ids.length ||
        claim.evidence_ids.some((id: string) => !members.has(id))
      )
        fail(
          "INVALID_ARGUMENT",
          "Summary claim lacks an eligible member witness",
        );
      // Deterministic extractive summaries preserve attribution and cannot invent a claim.
      if (
        !claim.evidence_ids.some((id: string) =>
          this.one(
            "SELECT witness FROM evidence WHERE id=?",
            id,
          ).witness.includes(claim.text),
        )
      )
        fail("INVALID_ARGUMENT", "Summary must quote a supported source claim");
    }
    return this.tx((r) => {
      const text = p.claims.map((c: Row) => c.text).join("\n"),
        inputs = [
          ...new Set<string>(p.claims.flatMap((c: Row) => c.evidence_ids)),
        ];
      if (!text)
        fail("INVALID_ARGUMENT", "An empty episode cannot be archived");
      const sensitivity = inputs.some(
        (id) =>
          this.one("SELECT sensitivity FROM evidence WHERE id=?", id)
            .sensitivity === "local_only",
      )
        ? "local_only"
        : "cloud_allowed";
      const artifact = this.artifact(
        p.scope_id,
        "episode",
        e.id,
        text,
        inputs,
        "",
        sensitivity,
      );
      this.run(
        "UPDATE episodes SET state='archived',summary_id=?,revision=? WHERE id=?",
        artifact,
        r,
        e.id,
      );
      for (const name of (p.topic_names || []).slice(0, 5)) {
        safeText(name, 100);
        let topic = this.one(
          "SELECT * FROM topics WHERE scope_id=? AND name=? AND erased=0",
          p.scope_id,
          name,
        );
        if (!topic.id) {
          topic = { id: uuid() };
          this.insert("topics", {
            id: topic.id,
            scope_id: p.scope_id,
            name,
            revision: r,
          });
        }
        this.insert("topic_links", {
          id: uuid(),
          topic_id: topic.id,
          target_id: e.id,
          kind: "episode",
          weight: 1,
          revision: r,
        });
        this.lineage(topic.id, artifact, "association");
        if (topic.summary_id) {
          this.run('UPDATE artifacts SET known_to_revision=? WHERE id=?',r,topic.summary_id);
          this.effect(topic.summary_id);
        }
        const summary=this.artifact(p.scope_id,'topic',topic.id,text,[artifact],'',sensitivity);
        this.run('UPDATE topics SET summary_id=?,revision=? WHERE id=?',summary,r,topic.id);
        for(const nearby of this.all('SELECT DISTINCT topic_id FROM topic_links WHERE target_id=? AND topic_id!=? LIMIT 5',e.id,topic.id)) {
          const link=uuid();this.insert('topic_links',{id:link,topic_id:topic.id,target_id:nearby.topic_id,kind:'RELATED_TO',weight:1,revision:r});this.lineage(link,artifact,'association');this.effect(link);
        }
        this.effect(topic.id);
      }
      this.effect(e.id);
      this.events.push({ type: "episode_archived", id: e.id });
      return this.receipt(p.scope_id, [e.id, artifact]);
    });
  }
  consolidate(p: Row) {
    const frozen = this.freezeEpisode(p);
    if (frozen.state === "archived") return frozen;
    const witnesses = this.all(
      "SELECT e.* FROM evidence e JOIN events ev ON ev.observation_id=e.observation_id JOIN episode_events m ON m.event_id=ev.id WHERE m.episode_id=? AND e.erased=0 AND ev.erased=0 AND ev.actor!='assistant' ORDER BY m.ordering LIMIT 32",
      p.id,
    );
    if (!witnesses.length)
      // Assistant-only or fully erased membership has nothing citable to publish.
      return this.tx((r) => {
        this.run(
          "UPDATE episodes SET state='archived',summary_id=NULL,revision=?,error_code='EMPTY_EPISODE' WHERE id=?",
          r,
          p.id,
        );
        this.effect(p.id);
        return { id: p.id, state: "archived", empty: true };
      });
    return this.archiveEpisode({
      scope_id: p.scope_id,
      id: p.id,
      source_generation: frozen.source_generation,
      policy_epoch: frozen.policy_epoch,
      erasure_epoch: frozen.erasure_epoch,
      claims: witnesses.map((e) => ({
        text: Array.from(e.witness).slice(0, 1900).join(""),
        evidence_ids: [e.id],
      })),
      topic_names: this.all("SELECT DISTINCT en.name FROM entities en JOIN assertion_versions a ON a.subject_id=en.id JOIN assertion_evidence ae ON ae.version_id=a.version_id JOIN evidence ev ON ev.id=ae.evidence_id JOIN events e ON e.observation_id=ev.observation_id JOIN episode_events m ON m.event_id=e.id WHERE m.episode_id=? AND a.erased=0 AND en.erased=0 LIMIT 5",p.id).map(row=>row.name),
    });
  }
  validatePacket(p: Row) {
    if (
      p.policy_epoch !== this.epoch("policy") ||
      p.erasure_epoch !== this.epoch("erasure")
    )
      fail("SOURCE_CHANGED", "Memory context was invalidated");
    if (p.snapshot_revision > this.revision)
      fail("INVALID_ARGUMENT", "Invalid snapshot revision");
    const ids = [...new Set<string>(p.record_ids || [])];
    for (const id of ids) {
      if (
        this.one("SELECT target_id FROM tombstones WHERE target_id=?", id)
          .target_id ||
        this.one(
          "SELECT target_id FROM mutation_effects WHERE target_id=? AND revision>? LIMIT 1",
          id,
          p.snapshot_revision,
        ).target_id
      )
        fail("SOURCE_CHANGED", "Memory record changed after retrieval");
    }
    return { valid: true, revision: this.revision };
  }

  recordResponse(p: Row) {
    strict(p, [
      "scope_id",
      "response_ref",
      "supplied_evidence_ids",
      "cited_evidence_ids",
      "snapshot_revision",
      "policy_epoch",
      "erasure_epoch",
    ]);
    this.scope(p.scope_id);
    this.validatePacket({
      policy_epoch: p.policy_epoch,
      erasure_epoch: p.erasure_epoch,
      snapshot_revision: p.snapshot_revision,
      record_ids: (p.supplied_evidence_ids || []).flatMap((id: string) => [
        id,
        ...this.all(
          "SELECT version_id FROM assertion_evidence WHERE evidence_id=?",
          id,
        ).map((v) => v.version_id),
      ]),
    });
    const supplied = p.supplied_evidence_ids || [],
      cited = p.cited_evidence_ids || [];
    if (
      !Array.isArray(supplied) ||
      !Array.isArray(cited) ||
      supplied.length > 24 ||
      cited.some((id: string) => !supplied.includes(id))
    )
      fail("INVALID_ARGUMENT", "Response cited evidence that was not supplied");
    // Evidence recalled from an ancestor scope is recorded with its owner scope.
    const scopes = JSON.stringify(this.effectiveScopes(p.scope_id)),
      owners: Record<string, string> = {};
    for (const id of supplied) {
      const owner = this.one(
        "SELECT scope_id FROM evidence WHERE id=? AND scope_id IN (SELECT value FROM json_each(?)) AND erased=0",
        id,
        scopes,
      ).scope_id;
      if (!owner) fail("SOURCE_CHANGED", "Response evidence is no longer eligible");
      if (owner !== p.scope_id) owners[id] = owner;
    }
    return this.tx(() => {
      const id = uuid();
      this.insert("response_records", {
        id,
        scope_id: p.scope_id,
        response_ref: p.response_ref || uuid(),
        supplied_evidence_ids: JSON.stringify(supplied),
        cited_evidence_ids: JSON.stringify(cited),
        snapshot_revision: p.snapshot_revision,
        policy_epoch: p.policy_epoch,
        erasure_epoch: p.erasure_epoch,
        evidence_scopes: JSON.stringify(owners),
      });
      for (const source of supplied) this.lineage(id, source, "supplied");
      if (
        this.one(
          "SELECT id FROM observations WHERE id=? AND scope_id=?",
          p.response_ref,
          p.scope_id,
        ).id
      )
        this.lineage(p.response_ref, id, "response");
      return { id, supplied: supplied.length, cited: cited.length };
    });
  }
  extractionNext() {
    if (!this.policy.enabled) return null;
    const run = this.one(
      "SELECT x.*,o.scope_id,o.role,o.revision AS source_revision,o.payload_id,p.body AS text,p.sensitivity FROM extraction_runs x JOIN observations o ON o.id=x.observation_id JOIN payloads p ON p.id=o.payload_id WHERE x.status='pending' AND o.erased=0 AND p.erased=0 AND x.policy_epoch=? AND x.erasure_epoch=? ORDER BY x.revision LIMIT 1",
      this.epoch("policy"),
      this.epoch("erasure"),
    );
    if (!run.id) return null;
    try { run.embedding_host=JSON.parse(this.scope(run.scope_id).external_key)[0]; } catch {}
    this.run(
      "UPDATE extraction_runs SET status='running',attempts=attempts+1 WHERE id=?",
      run.id,
    );
    return run;
  }
  extractionResult(p: Row) {
    const run = this.one(
      "SELECT x.*,o.scope_id,o.erased,o.revision AS source_revision FROM extraction_runs x JOIN observations o ON o.id=x.observation_id WHERE x.id=?",
      p.id,
    );
    if (
      !run.id ||
      run.erased ||
      run.status !== "running" ||
      run.policy_epoch !== this.epoch("policy") ||
      run.erasure_epoch !== this.epoch("erasure")
    )
      fail("SOURCE_CHANGED", "Extraction source or policy changed");
    if (p.denied) {
      // Policy denial is terminal until the extraction configuration changes.
      this.run(
        "UPDATE extraction_runs SET status='denied',error_code=? WHERE id=?",
        String(p.denied).slice(0, 100),
        p.id,
      );
      return { denied: true };
    }
    if (p.error) {
      this.run(
        "UPDATE extraction_runs SET status='retryable',error_code=? WHERE id=?",
        p.error,
        p.id,
      );
      return { retryable: true };
    }
    this.run(
      "UPDATE extraction_runs SET model_identity=?,prompt_version=?,parser_version=?,status='validated' WHERE id=?",
      JSON.stringify(p.identity),
      p.prompt_version || "cere-extract-1",
      p.parser_version || "1",
      p.id,
    );
    return { observation_id: run.observation_id, scope_id: run.scope_id };
  }
  applyExtraction(p:Row){
    const run=this.one('SELECT x.*,o.scope_id,o.erased FROM extraction_runs x JOIN observations o ON o.id=x.observation_id WHERE x.id=?',p.id);
    if(!run.id||run.erased||!['running','validated'].includes(run.status)||run.policy_epoch!==this.epoch('policy')||run.erasure_epoch!==this.epoch('erasure'))fail('SOURCE_CHANGED','Extraction source changed');
    if(!Array.isArray(p.proposals)||p.proposals.length>32)fail('INVALID_ARGUMENT','Extraction batch exceeds quota');
    return this.tx(()=>{this.batchTransaction=true;try{const results=p.proposals.map((proposal:Row)=>this.remember({...proposal,scope_id:run.scope_id,extraction_run_id:run.id}));this.run("UPDATE extraction_runs SET status='complete' WHERE id=?",run.id);return results;}finally{this.batchTransaction=false;}});
  }
  retry(p:Row){
    if(p.scope_id)this.scope(p.scope_id);
    return this.queue(()=>{
      this.run("UPDATE extraction_runs SET status='pending',error_code=NULL,policy_epoch=?,erasure_epoch=? WHERE status='retryable' AND observation_id IN (SELECT id FROM observations WHERE erased=0 AND (? IS NULL OR scope_id=?))",this.epoch('policy'),this.epoch('erasure'),p.scope_id||null,p.scope_id||null);
      // Stale, revoked and policy-denied runs are revalidated rather than blindly requeued.
      const {rescheduled}=this.reconcileExtraction(true);
      this.run("UPDATE outbox SET next_retry_us=0 WHERE state='retryable'");
      const episodes=Number(this.run("UPDATE episodes SET next_retry_us=0,consolidation_attempts=0 WHERE state='retryable' AND erased=0 AND (? IS NULL OR scope_id=?)",p.scope_id||null,p.scope_id||null).changes);
      return {scheduled:true,rescheduled,episodes};
    });
  }
  maintenance(){
    const result=this.expire();
    const episodes=[
      ...this.all("SELECT ep.id,ep.scope_id FROM episodes ep JOIN episode_events m ON m.episode_id=ep.id JOIN events e ON e.id=m.event_id WHERE ep.state='open' AND ep.erased=0 AND e.erased=0 GROUP BY ep.id HAVING COUNT(e.id)>=500 OR MAX(e.captured_us)<? LIMIT 4",now()-600e6),
      // Failed or interrupted consolidation retries with backoff and a bounded attempt count.
      ...this.all("SELECT id,scope_id FROM episodes WHERE state='retryable' AND erased=0 AND next_retry_us<=? AND consolidation_attempts<8 ORDER BY next_retry_us,id LIMIT 4",now()),
    ];
    let archived=0,empty=0,failed=0;
    for(const episode of episodes){
      try{const outcome:Row=this.consolidate({scope_id:episode.scope_id,id:episode.id});if(outcome.empty)empty++;else archived++;}
      catch(e:any){
        failed++;
        const attempts=this.one('SELECT consolidation_attempts AS n FROM episodes WHERE id=?',episode.id).n+1;
        this.run("UPDATE episodes SET state='retryable',consolidation_attempts=?,next_retry_us=?,error_code=? WHERE id=? AND state IN ('open','consolidating','retryable')",attempts,now()+Math.min(36e8,1e6*2**attempts),String(e.code||'CONSOLIDATION_FAILED').slice(0,100),episode.id);
      }
    }
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');return {...result,archived,empty,failed};
  }
  claimJob(p: Row) {
    if (!["graph", "vector"].includes(p.backend))
      fail("INVALID_ARGUMENT", "Unknown backend");
    const job = this.one(
      "SELECT o.* FROM outbox o JOIN projection_state s ON s.backend=o.backend AND s.generation=o.generation WHERE o.backend=? AND s.active IN (1,2) AND o.state!='done' AND o.state!='rejected' ORDER BY o.revision LIMIT 1",
      p.backend,
    );
    if (
      !job.id ||
      job.next_retry_us > now() ||
      (job.state === "leased" && job.lease_until_us > now())
    )
      return null;
    this.run(
      "UPDATE outbox SET state='leased',lease_until_us=?,attempts=attempts+1 WHERE id=?",
      now() + 30e6,
      job.id,
    );
    return { ...job, state: "leased", attempts: job.attempts + 1 };
  }
  finishJob(p: Row) {
    const job = this.one("SELECT * FROM outbox WHERE id=?", p.id);
    if (!job.id) fail("NOT_FOUND", "Projection job does not exist");
    if (p.error) {
      this.run(
        "UPDATE outbox SET state='retryable',error_code=?,lease_until_us=NULL,next_retry_us=? WHERE id=?",
        String(p.error).slice(0, 100),
        now() +
          Math.min(300e6, 1e6 * 2 ** Math.min(job.attempts, 8)) *
            (0.8 + Math.random() * 0.4),
        p.id,
      );
      this.run(
        "UPDATE projection_state SET status='degraded',error_code=? WHERE backend=? AND generation=?",
        "BACKEND_UNAVAILABLE",
        job.backend,
        job.generation,
      );
      return { pending: true };
    }
    this.run(
      "UPDATE outbox SET state='done',error_code=NULL,lease_until_us=NULL WHERE id=?",
      p.id,
    );
    const first = this.one(
        "SELECT MIN(revision) AS n FROM outbox WHERE backend=? AND generation=? AND state!='done'",
        job.backend,
        job.generation,
      ).n,
      watermark = first === null ? this.revision : first - 1;
    this.run(
      "UPDATE projection_state SET watermark=MAX(watermark,?),status='ready',error_code=NULL WHERE backend=? AND generation=?",
      watermark,
      job.backend,
      job.generation,
    );
    if(watermark>=this.revision&&this.one('SELECT active FROM projection_state WHERE backend=? AND generation=?',job.backend,job.generation).active===2){this.run('UPDATE projection_state SET active=0 WHERE backend=? AND active=1',job.backend);this.run('UPDATE projection_state SET active=1 WHERE backend=? AND generation=?',job.backend,job.generation);}
    const column = job.backend === "graph" ? "graph_ack" : "vector_ack";
    this.run(
      `UPDATE erasure_jobs SET ${column}=1 WHERE revision<=?`,
      watermark,
    );
    this.run(
      "UPDATE erasure_jobs SET state=CASE WHEN graph_ack=1 AND vector_ack=1 THEN 'COMPLETE' ELSE 'PURGING' END",
    );
    this.events.push({
      type: "projection_progress",
      backend: job.backend,
      watermark,
    });
    return { watermark };
  }
  projectionData(p: Row) {
    const job = this.one("SELECT * FROM outbox WHERE id=?", p.id);
    if (!job.id) fail("NOT_FOUND", "Unknown outbox job");
    const ids = this.all(
        "SELECT target_id FROM mutation_effects WHERE revision=?",
        job.revision,
      ).map((r) => r.target_id),
      nodes: Row[] = [],
      edges: Row[] = [],
      artifacts: Row[] = [],
      deleted = new Set<string>();
    for (const target of ids) {
      if (
        this.one("SELECT target_id FROM tombstones WHERE target_id=?", target)
          .target_id
      ) {
        deleted.add(target);
        continue;
      }
      const entity = this.one(
        "SELECT * FROM entities WHERE id=? AND erased=0",
        target,
      );
      if (entity.id)
        nodes.push({
          id: target,
          kind: "MemoryEntity",
          properties: { ...entity, owner_id: this.owner },
        });
      const a = this.one(
        "SELECT * FROM assertion_versions WHERE version_id=? AND erased=0",
        target,
      );
      if (a.version_id) {
        nodes.push(
          {
            id: a.subject_id,
            kind: "MemoryEntity",
            properties: {
              ...this.one(
                "SELECT * FROM entities WHERE id=? AND erased=0",
                a.subject_id,
              ),
              owner_id: this.owner,
            },
          },
          {
            id: target,
            kind: "MemoryAssertion",
            properties: { ...a, owner_id: this.owner },
          },
        );
        edges.push({
          id: target + ":subject",
          from: target,
          to: a.subject_id,
          kind: "SUBJECT",
          properties: { scope_id: a.scope_id, assertion_id: target },
        });
        if (a.object_entity_id) {
          nodes.push({
            id: a.object_entity_id,
            kind: "MemoryEntity",
            properties: {
              ...this.one(
                "SELECT * FROM entities WHERE id=? AND erased=0",
                a.object_entity_id,
              ),
              owner_id: this.owner,
            },
          });
          edges.push({
            id: target + ":object",
            from: target,
            to: a.object_entity_id,
            kind: "OBJECT",
            properties: { scope_id: a.scope_id, assertion_id: target },
          });
        }
        for (const e of this.support(target)) {
          nodes.push({
            id: e.id,
            kind: "MemoryEvidence",
            properties: {
              id: e.id,
              scope_id: e.scope_id,
              owner_id: this.owner,
              source_revision: e.source_revision,
              trust: e.trust,
            },
          });
          edges.push({
            id: target + ":support:" + e.id,
            from: target,
            to: e.id,
            kind: "SUPPORTED_BY",
            properties: { scope_id: a.scope_id, assertion_id: target },
          });
        }
      }
      for (const table of ["events", "episodes", "topics"]) {
        const row = this.one(
          `SELECT * FROM ${table} WHERE id=? AND erased=0`,
          target,
        );
        if (row.id)
          nodes.push({
            id: row.id,
            kind:
              table === "events"
                ? "MemoryEvent"
                : table === "episodes"
                  ? "MemoryEpisode"
                  : "MemoryTopic",
            properties: { ...row, owner_id: this.owner },
          });
      }
      const artifact = this.one(
        "SELECT a.*,p.body AS text FROM artifacts a JOIN payloads p ON p.id=a.payload_id WHERE a.id=? AND a.invalidated=0 AND p.erased=0",
        target,
      );
      if (artifact.id) {
        const key = this.one(
          "SELECT external_key FROM scopes WHERE id=?",
          artifact.scope_id,
        ).external_key;
        try {
          artifact.embedding_host = JSON.parse(key)[0];
        } catch {}
        artifacts.push(artifact);
      } else if (this.one("SELECT id FROM artifacts WHERE id=?", target).id)
        deleted.add(target);
    }
    return {
      revision: job.revision,
      erasureEpoch: this.epoch("erasure"),
      generation: job.generation,
      nodes,
      edges,
      deletedIds: [...deleted],
      artifacts,
      owner_id: this.owner,
    };
  }
  embeddingSave(p: Row) {
    const a = this.one(
      "SELECT * FROM artifacts WHERE id=? AND invalidated=0 AND content_revision=? AND erasure_epoch=?",
      p.artifact_id,
      p.content_revision,
      p.erasure_epoch,
    );
    if (
      !a.id ||
      this.one(
        "SELECT target_id FROM tombstones WHERE target_id=?",
        p.artifact_id,
      ).target_id
    )
      fail("SOURCE_CHANGED", "Artifact changed before embedding publication");
    this.run(
      "INSERT OR REPLACE INTO embedding_records VALUES (?,?,?,?,?,?)",
      p.artifact_id,
      p.content_revision,
      p.fingerprint,
      p.generation,
      p.point_id,
      JSON.stringify(p.vector),
    );
    return { eligible: true };
  }
  embeddingSearch(p: Row) {
    const scopes = JSON.stringify(this.effectiveScopes(p.scope_id));
    const scores: Row[] = [];
    for (const row of this.db
      .prepare(
        "SELECT e.*,a.source_generation FROM embedding_records e JOIN artifacts a ON a.id=e.artifact_id WHERE a.scope_id IN (SELECT value FROM json_each(?)) AND a.invalidated=0 AND e.content_revision=a.content_revision AND e.fingerprint=? ORDER BY e.content_revision DESC LIMIT 256",
      )
      .iterate(scopes, p.fingerprint) as Iterable<Row>) {
      const v = JSON.parse(row.vector);
      if (v.length !== p.vector.length) continue;
      scores.push({
        artifactId: row.artifact_id,
        contentRevision: row.content_revision,
        sourceGeneration: row.source_generation,
        score: v.reduce(
          (s: number, n: number, i: number) => s + n * p.vector[i],
          0,
        ),
      });
    }
    return scores
      .sort((a, b) => b.score - a.score)
      .filter((v) => v.score >= 0.4)
      .slice(0, 40);
  }
  pendingArtifacts(p: Row) {
    return this.all(
      "SELECT a.*,p.body AS text FROM artifacts a JOIN payloads p ON p.id=a.payload_id WHERE a.scope_id IN (SELECT value FROM json_each(?)) AND a.invalidated=0 AND p.erased=0 AND a.known_to_revision IS NULL AND NOT EXISTS (SELECT 1 FROM embedding_records e WHERE e.artifact_id=a.id AND e.content_revision=a.content_revision AND e.fingerprint=?) ORDER BY a.content_revision DESC LIMIT 8",
      JSON.stringify(this.effectiveScopes(p.scope_id)),
      p.fingerprint,
    );
  }
  rebuild(p: Row) {
    strict(p, ["backend", "dry_run"]);
    if (!["graph", "vector"].includes(p.backend))
      fail("INVALID_ARGUMENT", "Unknown backend");
    const count = this.one(
      "SELECT COUNT(*) AS n FROM artifacts WHERE invalidated=0",
    ).n;
    if (p.dry_run) return { backend: p.backend, records: count, dry_run: true };
    return this.tx((r) => {
      const generation = String(r);
      this.insert("projection_state", {
        backend: p.backend,
        generation,
        active: 2,
        status: "building",
      });
      for (const table of ["entities", "events", "episodes", "topics"])
        for (const row of this.all(`SELECT id FROM ${table} WHERE erased=0`))
          this.effect(row.id);
      for (const row of this.all(
        "SELECT version_id AS id FROM assertion_versions WHERE erased=0 UNION SELECT id FROM artifacts WHERE invalidated=0 UNION SELECT target_id AS id FROM tombstones",
      ))
        this.effect(row.id);
      return { backend: p.backend, generation, revision: r, records: count };
    });
  }
  health() {
    return {
      ...this.snapshot(),
      sqlite: this.one("SELECT sqlite_version() AS version").version,
      owner_id: this.owner,
      counts: {
        observations: this.one(
          "SELECT COUNT(*) AS n FROM observations WHERE erased=0",
        ).n,
        assertions: this.one(
          "SELECT COUNT(*) AS n FROM assertion_versions WHERE erased=0",
        ).n,
        artifacts: this.one(
          "SELECT COUNT(*) AS n FROM artifacts WHERE invalidated=0 AND known_to_revision IS NULL",
        ).n,
        saved: this.one(
          "SELECT COUNT(*) AS n FROM artifacts WHERE kind='saved' AND invalidated=0 AND known_to_revision IS NULL",
        ).n,
      },
      queues: {
        outbox: this.one("SELECT COUNT(*) AS n FROM outbox WHERE state!='done'")
          .n,
        extraction: this.one(
          "SELECT COUNT(*) AS n FROM extraction_runs WHERE status IN ('pending','running','retryable')",
        ).n,
        consolidation: this.one(
          "SELECT COUNT(*) AS n FROM episodes WHERE state IN ('retryable','consolidating') AND erased=0",
        ).n,
        extraction_denied: this.one(
          "SELECT COUNT(*) AS n FROM extraction_runs WHERE status='denied'",
        ).n,
      },
      erasure_registry: {
        // Unresolved legacy selectors need an explicit review; they are never widened silently.
        supplemented: this.registryRepairs.supplemented.length,
        unresolved: this.registryRepairs.unresolved,
      },
      wal_bytes: existsSync(join(this.directory, "memory.sqlite-wal"))
        ? statSync(join(this.directory, "memory.sqlite-wal")).size
        : 0,
      process: process.memoryUsage(),
    };
  }
  expire() {
    // Only live raw payloads qualify: a retained witness keeps its observation live after
    // its payload is erased, and must not be selected again. Deterministic expiry order
    // lets a bounded batch drain without starving later sources.
    const expired = this.all(
      "SELECT o.scope_id,o.id FROM observations o JOIN payloads p ON p.id=o.payload_id WHERE o.erased=0 AND p.erased=0 AND p.expires_us IS NOT NULL AND p.expires_us<? ORDER BY p.expires_us,o.id LIMIT 50",
      now(),
    );
    let count = 0;
    for (const row of expired) {
      const retained=this.policy.retain_evidence?this.all("SELECT DISTINCT e.id FROM evidence e JOIN assertion_evidence ae ON ae.evidence_id=e.id JOIN assertion_versions a ON a.version_id=ae.version_id WHERE e.observation_id=? AND e.erased=0 AND a.erased=0 AND a.status='accepted'",row.id).map(e=>e.id):[];
      if(retained.length){
        // The exact supporting quotations have their own evidence retention.
        // Expire every full-turn copy, including its FTS/vector document, in a journaled deletion.
        const roots=[this.one('SELECT payload_id FROM observations WHERE id=?',row.id).payload_id,
          ...this.all("SELECT id FROM artifacts WHERE record_id=? AND kind='conversation'",row.id).map(a=>a.id),
          ...this.all('SELECT id FROM evidence WHERE observation_id=? AND erased=0',row.id).filter(e=>!retained.includes(e.id)).map(e=>e.id)];
        const intent={id:uuid(),scope_id:row.scope_id,epoch:this.epoch('erasure')+1,selector:{kind:'raw_expiration',id:row.id},targets:this.descendants(roots)};
        this.appendRegistry(intent);this.suppress(intent,'expiration');count++;continue;
      }
      this.forget({ scope_id: row.scope_id, id: row.id }, "expiration");
      count++;
    }
    for(const candidate of this.all("SELECT version_id,scope_id FROM assertion_versions WHERE erased=0 AND expires_at_us IS NOT NULL AND expires_at_us<? ORDER BY expires_at_us,version_id LIMIT 50",now())){
      const intent={id:uuid(),scope_id:candidate.scope_id,epoch:this.epoch('erasure')+1,selector:{kind:'candidate_expiration',id:candidate.version_id},targets:this.descendants([candidate.version_id])};
      this.appendRegistry(intent);this.suppress(intent,'expiration');count++;
    }
    return { expired: count };
  }
  async backup(p: Row) {
    strict(p, ["output"]);
    const output = resolve(safeText(p.output, 4096));
    if (existsSync(output))
      fail("INVALID_ARGUMENT", "Backup output already exists");
    await backup(this.db, output);
    chmodSync(output, 0o600);
    const manifest = {
      schema_version: 1,
      owner_id: this.owner,
      ...this.snapshot(),
      erasure_registry_required: true,
    };
    const fd = openSync(output + ".manifest.json", "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(manifest));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { output, manifest };
  }
  async restore(p: Row) {
    strict(p, ["input", "staging"]);
    const input = resolve(safeText(p.input, 4096)),
      staging = resolve(safeText(p.staging, 4096));
    if (
      staging === this.directory ||
      (existsSync(staging) && readdirSync(staging).length)
    )
      fail(
        "INVALID_ARGUMENT",
        "Restore requires an empty non-serving staging directory",
      );
    const registry = join(this.directory, "erasure-registry.jsonl");
    if (!existsSync(registry))
      fail(
        "INCOMPATIBLE_SCHEMA",
        "Restore requires the current erasure registry",
      );
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(input, { readOnly: true });
    try {
      await backup(source, join(staging, "memory.sqlite"));
    } finally {
      source.close();
    }
    const fd = openSync(join(staging, "erasure-registry.jsonl"), "wx", 0o600);
    try {
      writeSync(fd, readFileSync(registry));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const restored = new Canonical(staging);
    try {
      restored.rebuild({ backend: "graph" });
      restored.rebuild({ backend: "vector" });
      return {
        staging,
        serving: false,
        erasure_epoch: restored.epoch("erasure"),
        integrity: restored.one("PRAGMA integrity_check").integrity_check,
      };
    } finally {
      restored.close();
    }
  }
  identity(p: Row) {
    strict(p, [
      "scope_id",
      "left_id",
      "right_id",
      "decision",
      "witness",
      "expected_revision",
      "revert_id",
    ]);
    this.scope(p.scope_id);
    return this.tx((r) => {
      if (p.revert_id) {
        const link = this.one(
          "SELECT i.* FROM identity_links i JOIN entities e ON e.id=i.left_id WHERE i.id=? AND e.scope_id=?",
          p.revert_id,
          p.scope_id,
        );
        if (!link.id || link.revision !== p.expected_revision)
          fail("REVISION_CONFLICT", "Identity decision changed");
        this.run(
          "UPDATE identity_links SET reverted_revision=? WHERE id=?",
          r,
          link.id,
        );
        // Decisions are history only: entity, anchor and slot resolution do not consume them yet.
        return { id: link.id, reverted_revision: r, applied: false, recorded_only: true };
      }
      const left = this.one(
          "SELECT * FROM entities WHERE id=? AND scope_id=? AND erased=0",
          p.left_id,
          p.scope_id,
        ),
        right = this.one(
          "SELECT * FROM entities WHERE id=? AND scope_id=? AND erased=0",
          p.right_id,
          p.scope_id,
        );
      if (
        !left.id ||
        !right.id ||
        left.type !== right.type ||
        left.id === right.id
      )
        fail("INVALID_ARGUMENT", "Incompatible identity candidates");
      if (!["possible", "same", "not_same"].includes(p.decision))
        fail("INVALID_ARGUMENT", "Unknown identity decision");
      const evidence = this.evidence(
        p.scope_id,
        parse(witnessSchema, p.witness),
      );
      const id = uuid();
      this.insert("identity_links", {
        id,
        left_id: left.id,
        right_id: right.id,
        decision: p.decision,
        evidence_id: evidence.id,
        revision: r,
      });
      this.effect(left.id);
      this.effect(right.id);
      return { id, revision: r, decision: p.decision, applied: false, recorded_only: true };
    });
  }
  async call(method: string, p: Row = {}): Promise<any> {
    // Remote inspection/erasure shares the canonical semantics, with a bounded
    // work envelope checked inside the worker before materializing a closure.
    // Large stores remain available through the desktop maintenance interface.
    if(['mobile_inspect','mobile_forget_preview','mobile_forget_sources','mobile_forget'].includes(method)) {
      this.scope(p.scope_id);
      let count=0;
      for(const table of ['observations','assertion_versions','evidence','events','entities','artifacts','episodes','lineage','assertion_evidence']) {
        count+=this.all(`SELECT 1 FROM ${table} LIMIT 2049`).length;
        if(count>2048)fail('LIMIT_EXCEEDED','This memory graph exceeds the mobile inspection quota; use desktop maintenance.');
      }
      const payload=this.one('SELECT COALESCE(SUM(size),0) AS size,COALESCE(MAX(size),0) AS largest FROM (SELECT length(CAST(body AS BLOB)) AS size FROM payloads WHERE erased=0 LIMIT 2049)');
      if(payload.size>8*1024*1024||payload.largest>256*1024)fail('LIMIT_EXCEEDED','This memory graph exceeds the mobile payload quota; use desktop maintenance.');
      return this.call(method.slice('mobile_'.length),p);
    }
    switch (method) {
      case "scope":
        return this.registerScope(p);
      case "observe_text":
        return this.observeText(p);
      case "action_event":
        return this.actionEvent(p);
      case "save_text":
        return this.saveText(p);
      case "remember":
        return this.remember(p);
      case "correct":
        return this.remember(p, "correct");
      case "resolve_conflict":
        return this.remember(p, "resolve");
      case "identity":
        return this.identity(p);
      case "retrieve":
        return this.retrieve(p);
      case "graph_pointers":
        return this.graphPointers(p);
      case "list":
        return this.list(p);
      case "inspect":
        return this.inspect(p);
      case "forget_preview":
        return this.forgetPreview(p);
      case "forget_sources": {
        const preview=this.forgetPreview(p),texts=new Set<string>();
        for(const id of preview.target_ids){const payload=this.one('SELECT body FROM payloads WHERE id=? AND erased=0',id);if(payload.body)texts.add(payload.body);const witness=this.one('SELECT witness FROM evidence WHERE id=? AND erased=0',id);if(witness.witness)texts.add(witness.witness);}
        return {texts:[...texts],revision:preview.revision,selection:preview.selection};
      }
      case "forget":
        return this.forget(p);
      case "erasure_status": {
        const row = this.one("SELECT * FROM erasure_jobs WHERE id=?", p.job_id);
        if (!row.id) fail("NOT_FOUND", "Unknown erasure job");
        return { ...row, purge_complete: row.state === "COMPLETE" };
      }
      case "health":
      case "stats":
      case "doctor":
        return this.health();
      case "policy_get":
        return { policy: this.policy, epoch: this.epoch("policy") };
      case "policy_update":
        return this.policyUpdate(p);
      case "freeze_episode":
        return this.freezeEpisode(p);
      case "archive_episode":
        return this.archiveEpisode(p);
      case "consolidate":
        return this.consolidate(p);
      case "record_response":
        return this.recordResponse(p);
      case "validate_packet":
        return this.validatePacket(p);
      case "claim_job":
        return this.claimJob(p);
      case "finish_job":
        return this.finishJob(p);
      case "projection_data":
        return this.projectionData(p);
      case "embedding_save":
        return this.embeddingSave(p);
      case "pending_artifacts":
        return this.pendingArtifacts(p);
      case "embedding_spaces":
        return this.meta("embedding_spaces", []);
      case "embedding_space": {
        const spaces = this.meta<Row[]>("embedding_spaces", []);
        if (!spaces.some((s) => s.fingerprint === p.fingerprint)) {
          spaces.push(p);
          this.setMeta("embedding_spaces", spaces);
        }
        return true;
      }
      case "embedding_search":
        return this.embeddingSearch(p);
      case "extraction_next":
        return this.extractionNext();
      case "extraction_result":
        return this.extractionResult(p);
      case "apply_extraction":
        return this.applyExtraction(p);
      case "retry":
        return this.retry(p);
      case "extraction_reconcile":
        return this.queue(() => this.reconcileExtraction(p.include_denied === true));
      case "effective_scopes":
        return this.effectiveScopes(p.scope_id);
      case "maintenance":
        return this.maintenance();
      case "rebuild":
        return this.rebuild(p);
      case "backup":
        return this.backup(p);
      case "restore":
        return this.restore(p);
      case "expire":
        return this.expire();
      case "import_legacy": {
        let count = 0;
        for (const row of p.rows || []) {
          const scope = this.registerScope({
            key: row.scope,
            label: "Imported project",
          });
          this.observeText({
            scope_id: scope.id,
            text: row.text,
            role: row.text.startsWith("Assistant") ? "assistant" : "user",
            session_id: row.session_id,
            source_event_id: "legacy:" + row.id,
            kind: row.kind,
          });
          count++;
        }
        return { imported: count };
      }
      default:
        fail("INVALID_ARGUMENT", "Unknown memory method");
    }
  }
  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
