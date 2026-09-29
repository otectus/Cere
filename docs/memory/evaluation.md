# Memory evaluation and benchmark results

Validation date: 2026-09-29. The checked-in reports contain synthetic identifiers and aggregate measurements only.

## Reproduction

Generate the annotated corpus, type-check the tools, and run the large workload:

```sh
node benchmarks/memory/generate-cases.ts
npx tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --allowImportingTsExtensions --erasableSyntaxOnly --skipLibCheck \
  benchmarks/memory/*.ts
node benchmarks/memory/run.ts
```

The workload is rebuilt at `/tmp/cere-memory-benchmark` by default. Set `CERE_MEMORY_BENCH_DIR` to use another private location. Bulk generation uses SQLite `synchronous=NORMAL`; measured correction commits switch to `FULL`. The generated database is disposable and is not a Cere canonical database.

The corpus in `tests/fixtures/memory/retrieval-cases.json` contains 70 cases: 10 each for exact identifiers, single-hop relationships, multi-hop relationships, temporal changes, historical views, interrupted tasks, and contradiction/abstention. There are 35 development and 35 held-out cases. Twenty questions require relationship paths. Every case records its source timeline, eligible scope, world time, knowledge revision, expected facts, required assertion/evidence IDs and paths, forbidden facts, abstention decision, repeated sources, and any deletion or policy change.

Run the separately authorized real cloud extraction sample with:

```sh
CERE_ALLOW_CLOUD_EVAL=1 node benchmarks/memory/evaluate-extraction.ts
```

This command dispatches five synthetic statements to the configured `gpt-oss:20b-cloud` model. It never uses user or local-only sources. The environment flag is required to prevent accidental cloud execution.

## 100k workload

`benchmarks/memory/results.json` is the complete machine-readable result. The run generated 100,000 assertion versions, 10,000 entities, and 10,000 episodes, including corrections, four independent scopes, expired and erased records, disputed records, blocked-task edges, and high-degree entities. Synthetic assertion text was 40–66 UTF-8 bytes (mean 41.49). Deterministic hash embeddings used 64 dimensions and are suitable only for repeatable plumbing comparisons.

Machine: 13th Gen Intel Core i7-13700HX, 24 logical CPUs, 31.1 GiB RAM, Linux x64, Node v26.8.2. Generation took 1.436 seconds. The SQLite database was 37,150,720 bytes and process peak RSS was 177,135,616 bytes. GPU/VRAM was not sampled.

| Retrieval mode | All evidence recall@10 | Relational recall@10 | MRR@10 | Abstention | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Vector only | 98.6% | 100.0% | 0.896 | 100% | 8.36 ms | 9.93 ms | 18.81 ms |
| Exact + lexical + vector | 88.6% | 73.3% | 0.861 | 100% | 6.18 ms | 8.67 ms | 12.91 ms |
| Hybrid + graph | 88.6% | 73.3% | 0.861 | 100% | 6.06 ms | 6.47 ms | 26.28 ms |
| Hybrid + graph ranker | 88.6% | 73.3% | 0.871 | 100% | 6.06 ms | 6.31 ms | 6.47 ms |

All modes applied the same scope, erased/status, knowledge interval, world interval, and expiry eligibility checks before scoring. Temporal answer accuracy, provenance coverage, estimated token use, unsupported-claim rate, false merges, and cold/warm timings are in the JSON report. The evidence metric uses the fixture's one-to-one assertion/evidence mapping.

The graph ranker **failed** both relational quality gates: 73.3% recall is below the 90% target, and it did not improve on vector-only by five percentage points. The expected outputs were left unchanged. This corpus makes the case identifier explicit in query and source text, favoring the hash-vector ablation; it also exposes graph candidate crowding around high-degree anchors. These results cannot support a graph-quality claim. Production embedding, Neo4j/Qdrant end-to-end retrieval, and a calibrated ranker still need evaluation before release.

Two hundred small `FULL`-synchronous correction transactions measured p50 0.010 ms, p95 0.018 ms, and p99 0.029 ms. This passes the local 100 ms correction target for the synthetic fixture SQL. It excludes the canonical validation/outbox path and is not an end-to-end correction latency claim. Projection catch-up, sustained queues, UI responsiveness, GPU/VRAM, cold model loading, model swapping, and live backend erasure purge remain unmeasured by this workload.

## Real cloud extraction

`benchmarks/memory/extraction-results.json` preserves two actual five-case runs against `gpt-oss:20b-cloud`, digest `9a01793d9ef8de5309f157c06dbcbadfb598001b4a6f13cbc699cdff5042eaae`. The expected labels were unchanged between runs.

The v1 baseline returned five assertions, of which three used the registered expected predicates. Predicate-level precision and case recall were 60%, below the 95% target. The two failures used unsupported predicate names (`PREFERS` and `IS_A_CHECKOUT_OF`) instead of `PREFERS_TOOL` and `CHECKOUT_OF`. Latency was p50 7.354 seconds and p95/max 13.170 seconds.

The v2 prompt and closed ontology schema returned five assertions with all five expected predicates. Predicate-level precision and case recall were 100% on this sample, and all proposals passed the adapter's closed schema and exact-quote validation. Latency was p50 7.749 seconds and p95/max 11.965 seconds. This clears the predicate-level 95% target for this five-case sample and fixes both observed v1 failure modes.

The sample is too small to estimate production-domain quality. The evaluator did not submit these proposals through `Canonical.remember`, so it does not establish canonical accepted-assertion precision or exercise every predicate-specific qualifier and authority rule. Canonical validation remains required, and a larger held-out accepted-precision evaluation remains an unmet release check.
