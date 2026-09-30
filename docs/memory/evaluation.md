# Memory evaluation and benchmark results

Validation date: 2026-09-29. The checked-in reports contain synthetic identifiers and aggregate measurements only.

## Reproduction

Generate the annotated corpus, type-check the tools, and run both benchmarks:

```sh
node benchmarks/memory/generate-cases.ts
npx tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --allowImportingTsExtensions --erasableSyntaxOnly --skipLibCheck \
  benchmarks/memory/*.ts
node benchmarks/memory/run.ts
node benchmarks/memory/canonical-run.ts
node --test tests/review-benchmark.test.ts
```

`run.ts` is a disposable SQL microbenchmark and writes `benchmarks/memory/results.json`. Its workload is rebuilt at `/tmp/cere-memory-benchmark` by default. Set `CERE_MEMORY_BENCH_DIR` to use another private location. Bulk generation uses SQLite `synchronous=NORMAL`; measured correction commits switch to `FULL`. The generated database is not a Cere canonical database.

`canonical-run.ts` is the release check for the memory engine itself and writes `benchmarks/memory/canonical-results.json`. It loads the corpus into a temporary canonical store and evaluates it with `Canonical.retrieve`. Neither runner calls a model or any network service. The regression test replaces `fetch` and fails if either runner calls it.

The corpus in `tests/fixtures/memory/retrieval-cases.json` (schema version 2) contains 70 cases: 10 each for exact identifiers, single-hop relationships, multi-hop relationships, temporal changes, historical views, interrupted tasks, and contradiction/abstention. There are 35 development and 35 held-out cases. Twenty questions require relationship paths. Every case records its source timeline, eligible scope, world time, knowledge revision, expected facts, required assertion/evidence IDs and paths, forbidden facts, abstention decision, repeated sources, and any deletion or policy change. The temporal cases carry an actual correction timeline. Each temporal change adds pre-change and old-knowledge views, and each historical view adds a current-knowledge view. Together with each case's main view, 50 temporal views are evaluated.

Run the separately authorized real cloud extraction sample with:

```sh
CERE_ALLOW_CLOUD_EVAL=1 node benchmarks/memory/evaluate-extraction.ts
```

This command dispatches five synthetic statements to the configured `gpt-oss:20b-cloud` model. It never uses user or local-only sources. The environment flag is required to prevent accidental cloud execution.

## Metric status

Both reports mark every gate `passed`, `failed` or `unmeasured`. A metric the workload cannot evaluate is reported as `null` and `unmeasured`, never as a success value.

## 100k SQL microbenchmark

`benchmarks/memory/results.json` is the complete machine-readable result. The run generated 100,000 assertion versions, 10,000 entities, and 10,000 episodes. It builds the corpus timelines as rows: corrections close knowledge intervals, and historical facts are superseded at their recorded revision. Each non-abstaining case also gets one ineligible look-alike of the anchor fact. The look-alikes rotate through six exclusion rules: future-bound, expired, erased, out-of-scope, not-yet-known and disputed. Relationship cases add an expired relation one hop past the first object. Its text shares no query term, so exact and lexical recall cannot reach it and only graph expansion can. Deleted copies, other-scope copies and repeated sources follow the corpus annotations. Synthetic assertion text was 27–72 UTF-8 bytes (mean 41.50). Deterministic hash embeddings used 64 dimensions and are suitable only for repeatable plumbing comparisons.

Machine: 13th Gen Intel Core i7-13700HX, 24 logical CPUs, 31.1 GiB RAM, Linux x64, Node v26.8.2. Generation took 1.595 seconds. The SQLite database was 38,367,232 bytes and process peak RSS was 182,018,048 bytes. GPU/VRAM was not sampled.

| Retrieval mode | Fact recall@10 | Relational recall@10 | Evidence recall@10 | MRR@10 | Temporal views | Unsupported | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Vector only | 98.6% | 100.0% | 98.6% | 0.896 | 100% | 0% | 6.66 ms | 9.09 ms | 15.81 ms |
| Exact + lexical + vector (RRF) | 100.0% | 100.0% | 100.0% | 0.892 | 100% | 0% | 6.60 ms | 7.15 ms | 26.75 ms |
| Hybrid + graph (RRF) | 100.0% | 100.0% | 100.0% | 0.889 | 100% | 0% | 6.67 ms | 7.12 ms | 7.42 ms |
| Hybrid + graph + relational ranker | 100.0% | 100.0% | 100.0% | 0.889 | 100% | 0% | 7.01 ms | 7.51 ms | 7.68 ms |

Every route and the final top 10 pass through one eligibility predicate: scope, erasure, status, knowledge interval, world interval and expiry. The final selection is rehydrated and deduplicated by fact before it is scored. Unsupported-claim rate counts any selected fact that is forbidden or ineligible for the view. The fused modes use the engine's `rrf`, and the ranker mode orders graph candidates with the engine's `relationalRank`. Path recall and abstention were 100% in every mode. Estimated tokens, repeated-row merges, and cold/warm timings are in the JSON report. The regression test also runs the workload with eligibility disabled as a negative control, and requires planted rows to raise the unsupported-claim rate and fail its gate.

The relational-recall, unsupported-claim and temporal-view gates passed. The ranker **failed** the gate requiring a five-point relational-recall improvement over vector-only; the difference was 0.0 points. Synthetic fact text repeats the case query, so vector-only already reaches every required fact. This corpus therefore cannot show whether graph expansion or the ranker helps. False merges are **unmeasured** because the SQL workload has no entity resolution. The expected outputs were left unchanged. Production embedding, Neo4j/Qdrant end-to-end retrieval, and a calibrated ranker still need evaluation before release.

Two hundred small `FULL`-synchronous correction transactions measured p50 0.011 ms, p95 0.017 ms, and p99 0.031 ms. This passes the local 100 ms correction target for the synthetic fixture SQL. It excludes the canonical validation/outbox path and is not an end-to-end correction latency claim. Projection catch-up, sustained queues, UI responsiveness, GPU/VRAM, cold model loading, model swapping, and live backend erasure purge remain unmeasured by this workload.

## Canonical-engine corpus run

`benchmarks/memory/canonical-results.json` is the machine-readable result. The runner writes each case through `observeText` and `remember`. Timelines are applied with the `correct` operation, and erased look-alikes are removed with `forget`. It then retrieves each view with the case's anchor entity, known revision and world time. Lexical, anchor and graph recall run through the engine's own eligibility, temporal, conflict and ranking code. No embedding model, Neo4j or Qdrant is involved. The store reached revision 425.

Each non-abstaining case plants one look-alike of the anchor fact: future-bound, planned, erased, out-of-scope, a question-derived proposal, or disputed. The runner also proves that each look-alike is live. A future-bound one is returned for a later world time, and an out-of-scope one is returned in its own scope. Planned, questioned and disputed look-alikes appear as conflicts, and an erased one has no remaining support. All 60 look-alikes met this check.

| Mode | Fact recall@10 | Relational recall@10 | Evidence recall@10 | Path recall | MRR@10 | Temporal views | Abstention | Unsupported | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Relational ranker | 100% | 100% | 100% | 100% | 0.900 | 100% (50) | 100% | 0% | 6.06 ms | 14.57 ms | 20.85 ms |
| Fusion without ranker | 100% | 100% | 100% | 100% | 0.900 | 100% (50) | 100% | 0% | 5.62 ms | 13.07 ms | 23.04 ms |

Integrity fixtures run in a separate store. They check that a positive and negative claim for the same member are both disputed (F-011), and that one extraction batch commits merged and disputed versions (F-012). They also check that a question-derived proposal stays a candidate (F-013), that a child scope resolves an inherited anchor (F-025), and that an uncertain date stays a candidate (F-034). All five hold.

The relational ranker **failed** its improvement gate against fusion without the ranker. The difference was 0.0 points because the corpus graphs are at most two hops deep, with no competing neighbours in the top 10. Accepted-assertion precision on real extraction output and production semantic quality are **unmeasured**. The corpus text is synthetic and anchored by known entity IDs, so this run measures eligibility, temporal and conflict behaviour, not natural-language recall. Latencies are in-process timings on a small store and are not comparable with the 100k workload.

## Real cloud extraction

`benchmarks/memory/extraction-results.json` preserves two actual five-case runs against `gpt-oss:20b-cloud`, digest `9a01793d9ef8de5309f157c06dbcbadfb598001b4a6f13cbc699cdff5042eaae`. The expected labels were unchanged between runs.

The v1 baseline returned five assertions, of which three used the registered expected predicates. Predicate-level precision and case recall were 60%, below the 95% target. The two failures used unsupported predicate names (`PREFERS` and `IS_A_CHECKOUT_OF`) instead of `PREFERS_TOOL` and `CHECKOUT_OF`. Latency was p50 7.354 seconds and p95/max 13.170 seconds.

The v2 prompt and closed ontology schema returned five assertions with all five expected predicates. Predicate-level precision and case recall were 100% on this sample, and all proposals passed the adapter's closed schema and exact-quote validation. Latency was p50 7.749 seconds and p95/max 11.965 seconds. This clears the predicate-level 95% target for this five-case sample and fixes both observed v1 failure modes.

The sample is too small to estimate production-domain quality. The evaluator did not submit these proposals through `Canonical.remember`, so it does not establish canonical accepted-assertion precision or exercise every predicate-specific qualifier and authority rule. Canonical validation remains required, and a larger held-out accepted-precision evaluation remains an unmet release check.
