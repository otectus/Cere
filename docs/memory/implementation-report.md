# Implementation and publication status

Date: 2026-09-29. This initial repository publication contains an integrated, experimental graph-memory implementation. It does **not** satisfy every completion criterion in `docs/Cere_Graph_Memory_Implementation.md` yet.

## Implemented and exercised

- Worker-owned canonical SQLite, strict ontology/DTOs, exact Unicode evidence, scoped entity resolution, atomic FTS changes, mutation revisions, ordered outbox, and read tokens.
- Bitemporal corrections, bounded exceptions, conflicts, source trust, strict extraction proposals, and `gpt-oss:20b-cloud` configuration. The extraction schema now uses the canonical predicate registry rather than free-form predicate names.
- Real Neo4j/Qdrant adapters, immutable embedding identities/generations, stale-pointer rejection, replay/restart behavior, and staged rebuilds.
- Canonical retrieval, context packets, evidence supplied/cited tracking, graph inspector, CLI, transient desktop collectors, and existing broker integration.
- Erasure registry, suppression, lineage cleanup, source-specific independent-support rederivation, raw-retention cleanup, pending projection acknowledgements, and guarded backup restoration. Managed conversation scrubbing records an opaque retry intent before canonical deletion so a restart can complete an interrupted erase.
- Packaged native peer-credential helper, deployment files, operation instructions, pinned dependencies, and isolated installation smoke tooling.

## Checks run for publication

| Command/check | Actual result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 98 passed, 0 failed |
| `node --test tests/memory.test.ts tests/knowledge.test.ts` | 32 passed, 0 failed |
| `npm run build` | Passed, including native peer-credential module and UI check binary |
| `python3 tools/install-user.py --prefix build/publish-install` | Passed; isolated staging only |
| `python3 tools/check-memory-install.py --root build/publish-install/share/cere` | Passed: installed broker/CLI, peer credentials, immediate recall with projections unavailable, guarded forgetting, immediate suppression, pending purge |
| `build/cere-motion-check` with local dependency library path | 15 passed, 0 failed |
| `build/cere-ui-check searchAndMemory` with local Qt library/plugin paths and Basic style | 3 passed, 0 failed; native graph inspector included |
| Full `build/cere-ui-check` with the same environment | Final run: 18 passed, 2 failed. `mouseFollowingAcrossOutputs` failed its target-output expectation; `expressiveActing` failed its composer-focus timeout. These desktop interaction checks remain unresolved. An earlier inspector Escape failure was fixed and passed the subsequent focused and full runs. |
| `tools/memory-dependencies.sh local-install` then `check` against isolated native dependencies | Passed with Neo4j 5.26.31 / Qdrant 1.19.1 across stop/start: replay, revision gaps, historical correction, erasure, generation isolation, vector retirement and cross-generation deletion |
| Cloud extraction v2 five-case evaluation | 5/5 expected predicates with exact quotes; this is not a production accepted-assertion precision estimate |
| Publication scan | No credential-shaped tokens or private keys found in publishable source; runtime/build data excluded by Git ignore rules |

The full UI command was:

```sh
LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
QT_PLUGIN_PATH="$PWD/.local-deps/usr/lib/qt6/plugins" \
QT_QUICK_CONTROLS_STYLE=Basic ./build/cere-ui-check
```

Machine-local evidence logs are `/tmp/cere-publish-tests.log`, `/tmp/cere-publish-memory-tests.log`, `/tmp/cere-publish-build.log`, `/tmp/cere-publish-install.log`, `/tmp/cere-publish-installed-smoke.log`, `/tmp/cere-publish-motion.log`, `/tmp/cere-publish-inspector.log`, `/tmp/cere-publish-ui-final.log`, and `/tmp/cere-publish-adapters.log`. These are historical local paths, not artifacts downloadable from GitHub. Reproduction commands and aggregate evaluation results are committed; private state and credentials are not.

## Outstanding reference-design gates

1. The 70-case corpus now has two runners (see [evaluation](evaluation.md)). The disposable 100k-row SQL microbenchmark applies one eligibility predicate to every route and calls the engine's `rrf` and `relationalRank`. Relational recall@10 was 100% in every mode, so the ranker showed no improvement over vector-only (0.0 points, gate failed); the synthetic fact text repeats each query. The canonical-engine runner, `benchmarks/memory/canonical-run.ts`, passes its eligibility, temporal-view, abstention and integrity gates, and its ranker-improvement gate also fails at 0.0 points. Production canonical retrieval with real embeddings and complete Neo4j/Qdrant service integration still needs the representative performance/quality evaluation. No production throughput, VRAM, or end-to-end latency claim is made.
2. The five-case v2 cloud result improved on the preserved v1 60% baseline, but the 95% precision gate for **accepted production assertions** has not been established on a sufficiently representative held-out corpus. Ambiguous natural-language effective dates remain reviewable candidates; structured corrections are the tested path.
3. Explicit task creation/binding and active-task structural relationships are incomplete. Identity decisions are recorded and reversible only. Decision and reversion responses, including the CLI's printed result, report `applied: false` and `recorded_only: true`. Effective merge/split remapping remains an outstanding feature. Project-specific versus inherited-scope precedence needs its complete acceptance fixture.
4. Live Kitty inspection was unavailable because no endpoint was configured. Compositor-to-Kitty instance mapping, lock/suspend reconciliation, durable desktop-history capture, and editor RPC integration need completion and live acceptance. Current desktop observations remain transient; unknown context must not be treated as a verified working directory.
5. Strict end-to-end deadlines, all intermediate hydration quotas, comprehensive policy revocation/intake behavior, repeated-source independence, and all required M01–M36 failure combinations need further validation. Existing passing fixtures do not certify the entire matrix.
6. The two desktop UI failures above are from that run. Current full-suite UI results are recorded in [VALIDATION.md](../../VALIDATION.md). Local build/package success and the focused memory inspector test do not replace those checks.

Memory is opt-in, and its README labels these limits. Publishing this source is separate from enabling collectors or restarting an installed user broker. This work staged an installation and exercised disposable dependency services; it did not replace or restart the user's installed Cere application.
