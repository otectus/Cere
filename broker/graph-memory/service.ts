import { join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { GraphMemory, pointId } from "./client.ts";
import { Neo4jGraphRepository } from "./adapters/neo4j.ts";
import { QdrantVectorRepository } from "./adapters/qdrant.ts";
import { OllamaExtractionAdapter, ExtractionPolicyError } from "./adapters/ollama.ts";
import { LiveWorkspaceState } from "./adapters/live.ts";
import { HyprlandCollector } from "./adapters/hyprland.ts";
import { KittyCollector } from "./adapters/kitty.ts";
import {
  FilesystemMetadataCollector,
  RepositoryCollector,
} from "./adapters/workspace.ts";
import type {
  LiveCollector,
  LiveObservation,
  VectorArtifactMetadata,
} from "./adapters/contracts.ts";
import { ollamaJson, ollamaHost, isCloudModel } from "../ollama.ts";
import { createHash } from "node:crypto";
import { fail, entityTypes } from "./contracts.ts";
import { CollectorRpc } from "./collector-rpc.ts";
import { paths } from "../paths.ts";

type Row = Record<string, any>;
export interface MemoryConfiguration {
  enabled: boolean;
  paused: boolean;
  host: string;
  embedding_model: string;
  extraction_model: string;
  allow_cloud_extraction: boolean;
  allow_cloud_memory: boolean;
}
export class MemoryService {
  canonical: GraphMemory;
  configuration: MemoryConfiguration = {
    enabled: false,
    paused: false,
    host: "http://127.0.0.1:11434",
    embedding_model: "nomic-embed-text",
    extraction_model: "gpt-oss:20b-cloud",
    allow_cloud_extraction: true,
    allow_cloud_memory: false,
  };
  live = new LiveWorkspaceState();
  collectors: LiveCollector[] = [];
  collectorRpc?: CollectorRpc;
  graph?: Neo4jGraphRepository;
  vectors = new Map<string, QdrantVectorRepository>();
  extractor?: OllamaExtractionAdapter;
  timer: NodeJS.Timeout;
  busy = false;
  recoveryFrozen = false;
  closed = false;
  foreground = 0;
  lastMaintenance = 0;
  controller = new AbortController();
  notify: (event: Row) => void;
  lastError = "";
  /** Collector generation: callbacks from a stopped generation are discarded. */
  collectorGeneration = 0;
  /** Current collector policy with resolved approved roots, used to filter every live read. */
  livePolicy: { policy: Row; roots: string[] } = { policy: { enabled: false }, roots: [] };
  constructor(directory: string, notify: (event: Row) => void = () => {}) {
    this.notify = notify;
    this.canonical = new GraphMemory(directory, (event) => {
      if (event.type === "invalidate") {
        this.controller.abort(new Error("Memory context invalidated"));
        this.controller = new AbortController();
      }
      notify(event);
    });
    this.timer = setInterval(() => {
      void this.maintain();
    }, 1000);
    this.timer.unref();
  }
  async configure(p: MemoryConfiguration) {
    const changed = JSON.stringify(this.configuration) !== JSON.stringify(p);
    const extractionChanged = ["host", "extraction_model", "allow_cloud_extraction"].some(
      (key) => (this.configuration as any)[key] !== (p as any)[key],
    );
    this.configuration = { ...p };
    if (!changed) return;
    this.controller.abort(new Error("Memory configuration changed"));
    this.controller = new AbortController();
    this.extractor = undefined;
    const current = await this.canonical.call("policy_get");
    if (
      current.policy.enabled !== p.enabled ||
      current.policy.allow_cloud_memory !== p.allow_cloud_memory
    )
      await this.canonical.call("policy_update", {
        policy: {
          enabled: p.enabled,
          allow_cloud_memory: p.allow_cloud_memory,
        },
      });
    // Runs denied under the previous extraction route are re-evaluated at dispatch.
    if (extractionChanged)
      await this.canonical.call("extraction_reconcile", { include_denied: true });
    await this.startCollectors();
  }
  async startCollectors() {
    const generation = ++this.collectorGeneration;
    await this.collectorRpc?.close();
    this.collectorRpc = undefined;
    for (const c of this.collectors) await c.stop();
    this.collectors = [];
    const { policy } = await this.canonical.call("policy_get");
    const roots = (
      await Promise.all(
        (policy.approved_roots as string[]).map((root) => realpath(root).catch(() => "")),
      )
    ).filter(Boolean);
    // Configuration and canonical policy must both allow collection; otherwise nothing survives.
    const enabled = !this.recoveryFrozen && this.configuration.enabled && !this.configuration.paused && policy.enabled;
    this.livePolicy = { policy: enabled ? policy : { ...policy, enabled: false }, roots };
    // Revocation takes effect before any new collector starts: revoked sources, roots
    // and titles leave the live state immediately.
    this.live.redact((o) => this.permitted(o));
    this.notify({ type: "workspace", generation: this.live.snapshot().generation });
    if (!enabled || generation !== this.collectorGeneration) return;
    const accept = (o: LiveObservation) => {
      if (generation !== this.collectorGeneration || this.closed) return false;
      const permitted = this.permitted(o);
      if (!permitted) return false;
      this.live.apply(permitted);
      this.notify({
        type: "workspace",
        generation: this.live.snapshot().generation,
      });
      return true;
    };
    if (policy.fish_enabled) {
      this.collectorRpc = new CollectorRpc(
        process.env.CERE_RUNTIME_DIR
          ? join(paths().runtime, "memory")
          : join(process.env.XDG_RUNTIME_DIR || paths().runtime, "cere-memory"),
        {
          apply: accept,
          snapshot: () => this.live.snapshot(),
          markSourceUnknown: (source, reason) =>
            generation === this.collectorGeneration ? this.live.markSourceUnknown(source, reason) : 0,
        },
        () => this.canonical.call("policy_get"),
      );
      try {
        await this.collectorRpc.start();
      } catch {
        this.lastError = "COLLECTOR_UNAVAILABLE";
      }
    }
    if (policy.hyprland_enabled)
      this.collectors.push(
        new HyprlandCollector({
          captureTitles: policy.capture_titles,
          titleApplicationAllowlist: policy.title_applications,
        }),
      );
    if (policy.kitty_enabled && process.env.CERE_KITTY_INSPECT_ENDPOINT)
      this.collectors.push(
        new KittyCollector({
          endpoint: process.env.CERE_KITTY_INSPECT_ENDPOINT,
          instanceId: process.env.CERE_KITTY_INSTANCE_ID || randomUUID(),
          approvedCwdRoots: policy.approved_roots,
        }),
      );
    if (policy.filesystem_enabled)
      this.collectors.push(
        new FilesystemMetadataCollector({
          approvedRoots: policy.approved_roots,
        }),
      );
    if (policy.approved_roots.length)
      this.collectors.push(new RepositoryCollector(policy.approved_roots));
    for (const c of this.collectors)
      try {
        await c.start((o) => void accept(o));
      } catch {
        this.lastError = "COLLECTOR_UNAVAILABLE";
      }
  }
  /**
   * Applies the current collector policy to one live observation: the kept
   * observation, a copy with revoked properties removed, or null when its source,
   * root or collector is no longer approved. Freshness is never authorization.
   */
  permitted(o: LiveObservation): LiveObservation | null {
    const { policy, roots } = this.livePolicy;
    if (!policy.enabled) return null;
    const within = (path: unknown) =>
      typeof path === "string" &&
      roots.some((root) => {
        const delta = relative(root, path);
        return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
      });
    const properties: Record<string, any> = { ...o.properties };
    const enabled: Record<string, boolean> = {
      hyprland: policy.hyprland_enabled,
      fish: policy.fish_enabled,
      kitty: policy.kitty_enabled,
      filesystem: policy.filesystem_enabled,
      repository: roots.length > 0,
      editor: false,
    };
    if (!enabled[o.source]) return null;
    if (o.source === "hyprland" && "title" in properties &&
      !(policy.capture_titles && (policy.title_applications || []).includes(String(properties.appClass))))
      delete properties.title;
    if ((o.source === "fish" || o.source === "kitty") && "cwd" in properties && !within(properties.cwd))
      delete properties.cwd;
    if (o.source === "filesystem" && o.freshness !== "unknown" && !(within(properties.path) && within(properties.root)))
      return null;
    if (o.source === "repository" && o.freshness !== "unknown") {
      const checkout = properties.checkoutRoot;
      const overlaps = within(checkout) || (typeof checkout === "string" && roots.some((root) => {
        const delta = relative(checkout, root);
        return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
      }));
      if (!overlaps) return null;
    }
    return { ...o, properties };
  }
  /**
   * Production embedding identity. The route is validated from current /tags and
   * /show metadata before any memory text is embedded: cloud-backed embedding
   * models are refused, so local-only sources never leave through indexing. A
   * user-configured remote Ollama server remains supported; it is not cloud.
   */
  async identity(host: string, signal: AbortSignal) {
    const model = this.configuration.embedding_model;
    const tags = await ollamaJson(host, "tags", undefined, signal);
    const m = tags.models?.find((m: Row) =>
      [model, model + ":latest"].includes(m.name || m.model),
    );
    if (!m?.digest)
      fail("BACKEND_UNAVAILABLE", "Embedding model digest is unavailable");
    const shown = await ollamaJson(host, "show", { model: m.model || m.name }, signal).catch((error: any) => {
      signal.throwIfAborted();
      fail("BACKEND_UNAVAILABLE", `Embedding model metadata is unavailable: ${String(error?.message || error).slice(0, 200)}`);
    });
    if (isCloudModel(model, m, shown))
      fail("POLICY_DENIED", "Memory embedding requires a local model; cloud-backed embedding models are not used");
    if (Array.isArray(shown?.capabilities) && shown.capabilities.length && !shown.capabilities.includes("embedding"))
      fail("BACKEND_UNAVAILABLE", "Configured memory model does not advertise embedding capability");
    const key = JSON.stringify([
      ollamaHost(host),
      model,
      m.digest,
      "unit",
      "Cosine",
      "nomic-prefix-v1",
      "codepoint-chunks-480-v1",
    ]);
    return { key, digest: m.digest };
  }
  async embed(
    host: string,
    texts: string[],
    kind: "query" | "document",
    signal: AbortSignal,
  ) {
    const model = this.configuration.embedding_model,
      prefix = /(?:^|\/)nomic-embed-text(?::|$)/.test(model)
        ? kind === "query"
          ? "search_query: "
          : "search_document: "
        : "";
    const chunks = texts.map((t) => {
      const points = Array.from(t),
        out: string[] = [];
      for (let i = 0; i < points.length; i += 480)
        out.push(points.slice(i, i + 480).join(""));
      return out;
    });
    const flat = chunks.flat(),
      vectors: number[][] = [];
    for (let i = 0; i < flat.length; i += 16) {
      const result = await ollamaJson(
        host,
        "embed",
        {
          model,
          input: flat.slice(i, i + 16).map((t) => prefix + t),
          truncate: false,
          keep_alive: "5m",
        },
        signal,
      );
      if (
        !Array.isArray(result.embeddings) ||
        result.embeddings.length !== flat.slice(i, i + 16).length
      )
        fail("BACKEND_UNAVAILABLE", "Embedding response count mismatch");
      for (const v of result.embeddings) {
        if (
          !Array.isArray(v) ||
          !v.length ||
          v.length > 16384 ||
          v.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))
        )
          fail("BACKEND_UNAVAILABLE", "Invalid embedding");
        const norm = Math.hypot(...v);
        if (!norm) fail("BACKEND_UNAVAILABLE", "Empty embedding");
        vectors.push(v.map((n) => n / norm));
      }
    }
    if (!vectors.length || vectors.some((v) => v.length !== vectors[0].length))
      fail("BACKEND_UNAVAILABLE", "Inconsistent embedding dimensions");
    let at = 0;
    return chunks.map((parts) => {
      const sum = Array(vectors[0].length).fill(0);
      for (const part of parts) {
        const v = vectors[at++];
        v.forEach((n, i) => (sum[i] += n * Array.from(part).length));
      }
      const norm = Math.hypot(...sum);
      return sum.map((n) => n / norm);
    });
  }
  fingerprint(identity: { key: string }, dimension: number) {
    return createHash("sha256")
      .update(identity.key + ":" + dimension)
      .digest("hex");
  }
  async vectorRepo(fingerprint: string, dimension: number, signal?: AbortSignal) {
    let repo = this.vectors.get(fingerprint);
    if (!repo) {
      repo = new QdrantVectorRepository({
        endpoint: process.env.CERE_QDRANT_URL || "http://127.0.0.1:6333",
        apiKey: await this.secret("qdrant"),
        collectionPrefix: "cere_" + fingerprint.slice(0, 12),
        dimension,
        distance: "Cosine",
        requestTimeoutMs: 1000,
      });
      await repo.initialize(signal);
      await this.canonical.call("embedding_space", { fingerprint, dimension }, signal);
      this.vectors.set(fingerprint, repo);
    }
    return repo;
  }
  async secret(kind: string) {
    const path = process.env.CERE_MEMORY_CREDENTIALS_FILE;
    if (path) {
      const { stat } = await import("node:fs/promises");
      const s = await stat(path);
      if (s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0)
        fail("POLICY_DENIED", "Memory credentials file must be private");
      const values = JSON.parse(await readFile(path, "utf8"));
      return String(values[kind] || "");
    }
    return kind === "graph"
      ? process.env.CERE_NEO4J_PASSWORD || ""
      : process.env.CERE_QDRANT_API_KEY || "";
  }
  async graphRepo() {
    if (!this.graph) {
      this.graph = new Neo4jGraphRepository({
        uri: process.env.CERE_NEO4J_URI || "bolt://127.0.0.1:7687",
        username: process.env.CERE_NEO4J_USER || "neo4j",
        password: await this.secret("graph"),
        connectionTimeoutMs: 1000,
        maxTransactionRetryTimeMs: 0,
      });
      try {
        await this.graph.initialize();
      } catch (e) {
        await this.graph.close();
        this.graph = undefined;
        throw e;
      }
    }
    return this.graph;
  }
  async project(backend: "graph" | "vector") {
    const job = await this.canonical.call("claim_job", { backend });
    if (!job) return;
    try {
      const data = await this.canonical.call("projection_data", { id: job.id });
      if (backend === "graph") {
        const { artifacts, owner_id, ...mutation } = data;
        const graph = await this.graphRepo();
        await graph.apply({ ...mutation, generation: Number(data.generation) });
        if (data.deletedIds.length)
          await graph.eraseAllGenerations(data.deletedIds, data.erasureEpoch);
      } else {
        const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(15000),
        ]);
        // Physical purge needs only Qdrant and the persisted embedding spaces; it never
        // waits on an embedding model. The job is acknowledged only after every
        // generation's deletion and every publication in it succeeded.
        if (data.deletedIds.length) {
          for (const space of await this.canonical.call("embedding_spaces"))
            await this.vectorRepo(space.fingerprint, space.dimension, signal);
          for (const repo of this.vectors.values())
            await repo.deleteByArtifacts(data.deletedIds, data.erasureEpoch, signal);
        }
        const byHost = new Map<string, Row[]>();
        for (const artifact of data.artifacts) {
          const host = artifact.embedding_host || this.configuration.host;
          const group = byHost.get(host) || [];
          group.push(artifact);
          byHost.set(host, group);
        }
        // A projection job can contain many artifacts after rebuild. Probe a route once
        // per host and embed bounded batches instead of issuing one model request per row.
        for (const [host, artifacts] of byHost) {
          const identity = await this.identity(host, signal);
          for (let offset = 0; offset < artifacts.length; offset += 64) {
            const batch = artifacts.slice(offset, offset + 64);
            const vectors = await this.embed(
              host,
              batch.map((artifact) => artifact.text),
              "document",
              signal,
            );
            for (let index = 0; index < batch.length; index++) {
              const artifact = batch[index],
                vector = vectors[index],
                fingerprint = this.fingerprint(identity, vector.length),
                generation = Number(data.generation),
                point = pointId(
                  artifact.id,
                  artifact.content_revision,
                  fingerprint,
                  generation,
                ),
                repo = await this.vectorRepo(fingerprint, vector.length, signal),
                record = {
                  artifact_id: artifact.id,
                  content_revision: artifact.content_revision,
                  erasure_epoch: artifact.erasure_epoch,
                  fingerprint,
                  generation: data.generation,
                  point_id: point,
                  vector,
                },
                metadata: VectorArtifactMetadata = {
                  ownerId: data.owner_id,
                  scopeId: artifact.scope_id,
                  artifactKind: artifact.kind,
                  artifactId: artifact.id,
                  contentRevision: artifact.content_revision,
                  embeddingFingerprint: fingerprint,
                  generation,
                  sensitivity: artifact.sensitivity,
                  validFromUs: null,
                  validToUs: null,
                  sourceGeneration: artifact.source_generation,
                  erasureEpoch: data.erasureEpoch,
                  expiresAtUs: artifact.expires_us,
                };
              // Recheck canonical eligibility immediately before the remote write.
              await this.canonical.call("embedding_save", record);
              await repo.publish({ pointId: point, vector, metadata });
              try {
                // A changed/erased artifact cannot leave a usable late point behind.
                await this.canonical.call("embedding_save", record);
              } catch (e) {
                await repo.retire([point]);
                throw e;
              }
            }
          }
        }
      }
      await this.canonical.call("finish_job", { id: job.id });
    } catch {
      await this.canonical.call("finish_job", {
        id: job.id,
        error: "BACKEND_UNAVAILABLE",
      });
    }
  }
  async extraction() {
    if (!this.configuration.extraction_model) return;
    const run = await this.canonical.call("extraction_next");
    if (!run) return;
    try {
      const extractionHost=run.embedding_host||this.configuration.host;
      if(this.extractor?.config.endpoint!==extractionHost)this.extractor=undefined;
      this.extractor ??= new OllamaExtractionAdapter({
        endpoint: extractionHost,
        model: this.configuration.extraction_model,
        allowCloud: this.configuration.allow_cloud_extraction,
        timeoutMs: 45000,
        probeTimeoutMs: 30000,
      });
      const result = await this.extractor.extract(
        {
          sourceRecordId: run.observation_id,
          sourceRevision: run.source_revision,
          sourceRole: run.role,
          modelRoute: run.sensitivity,
          text: run.text,
        },
        this.controller.signal,
      );
      await this.canonical.call("extraction_result", {
        id: run.id,
        identity: {
          model: result.model,
          digest: result.modelDigest,
          endpoint: result.endpointClass,
        },
        prompt_version: result.promptVersion,
        parser_version: result.parserVersion,
      });
      const entities = new Map(
        result.proposals.entities.map((e) => [e.temporaryRef, e]),
      );
      const proposals:Row[]=[];
      for (const a of result.proposals.assertions) {
        const s = entities.get(a.subjectRef),
          o =
            "entityRef" in a.object
              ? entities.get(a.object.entityRef)
              : undefined;
        if (!s || !s.aliases[0] || ("entityRef" in a.object && !o)) throw new Error('Unresolved extraction entity');
        const quote = a.quotes[0];
        if (!quote || quote.sourceRecordId !== run.observation_id) throw new Error('Unsupported extraction quote');
        // An uncertain or unparseable interpretation never becomes an exact boundary.
        const parsed =
          !a.temporal.uncertain &&
          a.temporal.interpretation &&
          /^\d{4}-\d\d-\d\dT/.test(a.temporal.interpretation)
            ? Date.parse(a.temporal.interpretation) * 1000
            : NaN;
        const temporal = Number.isSafeInteger(parsed) ? parsed : null;
        const uncertain = a.temporal.uncertain || (!!a.temporal.interpretation && temporal === null);
        const claim = {
          subject: { type: entityTypes.find(type=>type.toUpperCase()===s.kind), name: s.aliases[0] },
          predicate: a.predicate,
          ...(o
            ? { object: { type: entityTypes.find(type=>type.toUpperCase()===o.kind), name: o.aliases[0] } }
            : { value: "literal" in a.object ? a.object.literal : null }),
          qualifiers: a.qualifiers,
          polarity: a.polarity,
          modality: a.modality,
          epistemic_type: a.epistemicType,
          valid_mode:
            temporal !== null
              ? "bounded"
              : uncertain
                ? "unknown"
                : "known_current",
          valid_from_us: temporal,
          valid_to_us: null,
          time_precision: temporal !== null ? "instant" : uncertain ? "approximate" : "unknown",
          time_expression: a.temporal.expression || "",
          extraction_confidence: 1,
        };
        // Unresolved natural-language corrections remain reviewable candidates; resolved inspector APIs apply intervals.
        if (a.operation === "changes" || a.operation === "corrects")
          claim.modality = "reported";
        proposals.push({
            claim,
            witness: {
              observation_id: run.observation_id,
              quote: quote.quote,
              occurrence: quote.occurrenceIndex,
            },
          });
      }
      await this.canonical.call('apply_extraction',{id:run.id,proposals});
    } catch (error) {
      // Route and consent denials are terminal until configuration changes; they are not outages.
      const denied = error instanceof ExtractionPolicyError ? error.code : undefined;
      await this.canonical
        .call("extraction_result", denied ? { id: run.id, denied } : {
          id: run.id,
          error: "MODEL_UNAVAILABLE_OR_INVALID",
        })
        .catch(() => {});
      this.lastError = denied ? "EXTRACTION_DENIED" : "EXTRACTION_RETRYABLE";
    }
  }
  async maintain() {
    if (
      this.busy ||
      this.recoveryFrozen ||
      this.closed ||
      !this.configuration.enabled ||
      this.configuration.paused ||
      this.foreground
    )
      return;
    this.busy = true;
    try {
      await Promise.allSettled([this.project("graph"), this.project("vector")]);
      if (!this.foreground) await this.extraction();
      if(Date.now()-this.lastMaintenance>60000){this.lastMaintenance=Date.now();await this.canonical.call('maintenance');}
    } finally {
      this.busy = false;
    }
  }
  /** Reserve the current memory profile before recovery starts reading or replacing it. */
  async freezeForRecovery(){
    if(this.busy)throw new Error('Wait for memory maintenance to finish before restoring');
    this.recoveryFrozen=true;this.collectorGeneration++;
    this.controller.abort(new Error('Memory paused for recovery'));
    await this.collectorRpc?.close();this.collectorRpc=undefined;
    for(const collector of this.collectors)await collector.stop();this.collectors=[];
  }
  async resumeAfterRecovery(){
    if(!this.recoveryFrozen)return;
    this.recoveryFrozen=false;this.controller=new AbortController();await this.startCollectors();
  }
  async retrieve(p: Row, signal?: AbortSignal) {
    const time = performance.now(),
      policy = await this.canonical.call("policy_get"),
      deadline = policy.policy.deadline_ms;
    const guard = AbortSignal.any([
      ...(signal ? [signal] : []),
      this.controller.signal,
      AbortSignal.timeout(deadline),
    ]);
    let semantic: Row[] = [],
      coverage: string[] = [];
    const {host: _host,...seedQuery}=p;
    // Inherited scopes are authorized for every retrieval route, not only lexical recall.
    const scopeIds: string[] = await this.canonical.call("effective_scopes", { scope_id: p.scope_id }, guard);
    const graphPromise=(async()=>{
      if(!this.graph)return [];
      const seedPacket=await this.canonical.call('retrieve',seedQuery,guard),seeds=[...new Set<string>(seedPacket.assertions.flatMap((a:Row)=>[a.subject_id,a.object_entity_id].filter(Boolean)))];
      if(!seeds.length)return [];
      const projection=seedPacket.snapshot.projections.find((v:Row)=>v.backend==='graph');
      const expanded=await this.graph.expand({seedIds:seeds,generation:Number(projection?.generation||1),scopeIds,depth:3,deadline:guard});
      return this.canonical.call('graph_pointers',{scope_id:p.scope_id,seeds,nodes:expanded.nodes,edges:expanded.edges,known_revision:seedQuery.known_revision,world_at_us:seedQuery.world_at_us,model_route:seedQuery.model_route});
    })().catch(()=>{coverage.push('graph_degraded');return [];});
    try {
      const host = p.host || this.configuration.host,
        identity = await this.identity(host, guard),
        [vector] = await this.embed(host, [p.text], "query", guard),
        fingerprint = this.fingerprint(identity, vector.length);
      const pending = await this.canonical.call("pending_artifacts", {
        scope_id: p.scope_id,
        fingerprint,
      }, guard);
      if (pending.length) {
        const vectors = await this.embed(
          host,
          pending.map((a: Row) => a.text),
          "document",
          guard,
        );
        for (let i = 0; i < pending.length; i++) {
          const a = pending[i];
          if (vectors[i].length !== vector.length)
            throw new Error("Embedding dimension changed");
          await this.canonical.call("embedding_save", {
            artifact_id: a.id,
            content_revision: a.content_revision,
            erasure_epoch: a.erasure_epoch,
            fingerprint,
            generation: "1",
            point_id: pointId(a.id, a.content_revision, fingerprint, 1),
            vector: vectors[i],
          });
        }
      }
      // Preserve the durable overlay before optional projection setup/query can
      // exhaust the deadline. An unavailable projection must not discard local hits.
      semantic = await this.canonical.call("embedding_search", {
        scope_id: p.scope_id,
        fingerprint,
        vector,
      }, guard);
      try {
        const health = await this.canonical.call("health", {}, guard);
        // Collection preparation shares the retrieval deadline; expiry degrades to canonical recall.
        const repo = await this.vectorRepo(fingerprint, vector.length, guard);
        const generation = Number(
          health.projections.find((b: Row) => b.backend === "vector")
            ?.generation || 1,
        );
        const hits = await repo.query({
          vector,
          ownerId: health.owner_id,
          scopeIds,
          embeddingFingerprint: fingerprint,
          generation,
          currentErasureEpoch: health.erasure_epoch,
          nowUs: Date.now() * 1000,
          deadline: guard,
        });
        semantic = [...hits.map((h) => ({ ...h.metadata, score: h.score })), ...semantic];
      } catch {
        coverage.push("semantic_projection_unavailable");
      }
    } catch (error: any) {
      signal?.throwIfAborted();
      coverage.push(error?.code === "POLICY_DENIED" ? "semantic_route_denied" : "semantic_degraded");
    }
    const { host, ...query } = p;
    const graphIds=await graphPromise;
    // Setup that outlived the deadline must not keep the foreground waiting on stragglers.
    if (guard.aborted && !signal?.aborted && !coverage.includes("deadline_partial")) coverage.push("deadline_partial");
    const result = await this.canonical.call(
      "retrieve",
      {
        ...query,
        semantic_ids: semantic,
        graph_ids:graphIds,
        backend_coverage: coverage,
        deadline_ms: Math.max(25, deadline - (performance.now() - time)),
      },
      signal,
    );
    const epochs = await this.canonical.call("health");
    if (
      epochs.policy_epoch !== result.snapshot.policy_epoch ||
      epochs.erasure_epoch !== result.snapshot.erasure_epoch
    )
      fail("SOURCE_CHANGED", "Memory changed during retrieval");
    await this.canonical.call("validate_packet", {
      snapshot_revision: result.snapshot.revision,
      policy_epoch: result.snapshot.policy_epoch,
      erasure_epoch: result.snapshot.erasure_epoch,
      record_ids: [
        ...result.assertions.map((a: Row) => a.version_id),
        ...result.conflicts.map((a: Row) => a.version_id),
        ...result.results.map((a: Row) => a.artifact_id),
      ],
    });
    result.workspace = p.model_route === 'cloud' && !policy.policy.allow_cloud_memory ? {generation:0,current:{freshness:'unknown'},unknown:['cloud_workspace_denied'],observations:[]} : this.workspace();
    result.snapshot.live_generation = result.workspace.generation;
    return result;
  }
  /** Live state filtered against the current collector policy at every read. */
  liveSnapshot() {
    const snapshot = this.live.snapshot();
    return {
      generation: snapshot.generation,
      observations: snapshot.observations.flatMap((o) => {
        const kept = this.permitted(o);
        return kept ? [kept] : [];
      }),
    };
  }
  workspace() {
    const snapshot = this.liveSnapshot(),
      fresh = snapshot.observations.filter((o) => o.freshness === "fresh");
    const focus = fresh.find((o) => o.kind === "WINDOW_FOCUS"),
      address = focus?.properties.address;
    const window = address
      ? fresh.find(
          (o) =>
            o.source === "hyprland" &&
            o.properties.address === address &&
            !o.kind.endsWith("CLOSED"),
        )
      : undefined;
    const panes = fresh.filter(
      (o) =>
        o.kind === "TERMINAL_PANE" &&
        o.properties.osWindowFocused &&
        o.properties.tabActive &&
        o.properties.paneFocused,
    );
    let pane =
      window &&
      /kitty/i.test(String(window.properties.appClass)) &&
      panes.length === 1
        ? panes[0]
        : undefined;
    const shells = pane
      ? fresh.filter(
          (o) =>
            o.kind === "SHELL_STATE" &&
            o.properties.kittyPaneId === pane!.properties.paneId,
        )
      : [];
    const shell = shells.length === 1 ? shells[0] : undefined,
      cwd = shell?.properties.cwd || pane?.properties.cwd;
    const checkouts = cwd
      ? fresh.filter(
          (o) =>
            o.source === "repository" &&
            typeof o.properties.checkoutRoot === "string" &&
            (() => {
              const delta = relative(o.properties.checkoutRoot, String(cwd));
              return (
                delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))
              );
            })(),
        )
      : [];
    return {
      ...snapshot,
      current: {
        window: window || null,
        pane: pane || null,
        shell: shell || null,
        cwd: cwd || null,
        checkout: checkouts.length === 1 ? checkouts[0] : null,
        freshness: window ? "fresh" : "unknown",
      },
      unknown: [
        ...(!window ? ["focused_window"] : []),
        ...(!pane ? ["terminal_pane"] : []),
        ...(!cwd ? ["working_directory"] : []),
        ...(checkouts.length !== 1 ? ["verified_checkout"] : []),
      ],
    };
  }
  async call(method: string, p: Row = {}, signal?: AbortSignal): Promise<any> {
    if (method === "configure") return this.configure(p as MemoryConfiguration);
    if (method === "retrieve") return this.retrieve(p, signal);
    if (method === "workspace") return this.workspace();
    if (method === "foreground") {
      this.foreground = Math.max(0, this.foreground + (p.active ? 1 : -1));
      return { foreground: this.foreground };
    }
    if (method === "health" || method === "doctor")
      return {
        ...(await this.canonical.call("health")),
        extraction_model: this.configuration.extraction_model,
        extraction_error: this.lastError,
        workspace: this.liveSnapshot(),
        collectors: this.collectors.length,
      };
    const result = await this.canonical.call(method, p, signal);
    if (method === "policy_update") await this.startCollectors();
    return result;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.collectorRpc?.close();
    this.controller.abort(new Error("Memory service closed"));
    for (const c of this.collectors) await c.stop();
    while (this.busy) await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([
      this.graph?.close(),
      ...[...this.vectors.values()].map((v) => v.close()),
    ]);
    await this.canonical.close();
  }
}
