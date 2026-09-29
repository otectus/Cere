# Memory adapter validation

Validation date: 2026-09-29. Operational evidence below is content-free: it records versions, counts, timing, and boolean outcomes without source excerpts, prompts, titles, paths observed by collectors, credentials, or model responses.

## Repeatable checks

Run the deterministic adapter fixtures:

```sh
node --test tests/memory-adapters.test.ts
```

Result: 9 tests passed, 0 failed. These are protocol fixtures and validation tests; they do not certify a live database or model.

Run the focused adapter type check:

```sh
npx tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --allowImportingTsExtensions --erasableSyntaxOnly --skipLibCheck \
  tools/check-memory-adapters.ts broker/graph-memory/adapters/*.ts
```

Result: passed with no diagnostics.

Run syntax checks for the dependency launcher and Fish emitter:

```sh
bash -n tools/memory-dependencies.sh
fish -n broker/graph-memory/adapters/fish/cere-memory.fish
python3 -m py_compile broker/graph-memory/adapters/fish/cere-memory-emitter.py
```

Result: all passed.

For a real dependency check, create a mode `0600` environment file from `packaging/memory.env.example`, install the checksum-locked archives once, and run:

```sh
CERE_MEMORY_DEPS_HOME=/path/to/private/state \
CERE_MEMORY_ENV_FILE=/path/to/private/dependencies.env \
tools/memory-dependencies.sh local-install

CERE_MEMORY_DEPS_HOME=/path/to/private/state \
CERE_MEMORY_ENV_FILE=/path/to/private/dependencies.env \
tools/memory-dependencies.sh check
```

`check` starts both services on loopback, writes synthetic projection data, retries the writes, stops both services, starts them again, verifies persistence and lifecycle behavior, removes the synthetic graph/vector data, and stops both services. It prints only content-free JSON results.

## Real dependency result

The repeatable check passed against the downloaded, checksum-verified Neo4j Community 5.26.31 and Qdrant 1.19.1 releases. The services were stopped after validation.

Prepare phase:

```json
{"phase":"prepare","neo4jVersion":"Neo4j/5.26.31","qdrantVersion":"1.19.1","arbitraryBaselineRevision":true,"reconstructedReplayNoOp":true,"graphNodes":3,"vectorRetryCount":1}
```

Verification phase after stopping and restarting both dependency processes:

```json
{"phase":"verify","neo4jVersion":"Neo4j/5.26.31","qdrantVersion":"1.19.1","dependencyRestartPersistence":true,"correctionRetainedHistory":true,"erasureRemovedHistory":true,"generationIsolation":true,"revisionGapRejected":true,"vectorCorrectionAndRetirement":true,"vectorCrossGenerationErasure":true}
```

This live check covers backend-success retry, a reconstructed same-revision graph replay, correction with historical graph retention, erasure, contiguous revision rejection, persisted state after process restart, concurrent graph generations, immutable vector revision publication, point retirement, isolated vector generations, and erasure across vector generations.

Runtime logs from this run are at `/tmp/cere-memory-integration-deps/neo4j/logs/neo4j.log` and `/tmp/cere-memory-integration-deps/run/qdrant.log`. They show the two starts, persisted collection recovery, cleanup, and graceful shutdown. The temporary test credential file was removed after the run.

The deployment profile pins:

- `neo4j:5.26.31-community@sha256:5eb12ad77fa46ab73e23df9ea1f43f5c0f2a79523435577648e046be042b9b93`
- `qdrant/qdrant:v1.19.1@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10`
- Neo4j archive SHA-256 `f8fc23340561405f1ff10ca6ac2d317d095d3c74509a616883c45d7a61f5cfec`
- Qdrant x86_64 archive SHA-256 `eef986e769d4d3e806dd2d546e1b4ecdd416211e54d34b4ed764fac7c58e1085`
- Qdrant AArch64 archive SHA-256 `0e607c11705fab22f7d667f4749bc0b6b60a8fa9e91de71880a6ebafbbda1b26`

## Real model result

The live Ollama adapter check used Ollama 0.34.4 and the authorized `gpt-oss:20b-cloud` model digest `9a01793d9ef8de5309f157c06dbcbadfb598001b4a6f13cbc699cdff5042eaae`. Its complex structured-schema probe and one synthetic extraction completed in 17.0 seconds. Strict parsing accepted three entity proposals and one assertion proposal with an exact source occurrence and the expected explicit-user epistemic type. No local-only source was dispatched. Fixture tests separately verify that cloud extraction requires both adapter authorization and a `cloud_allowed` source route, and that repair is attempted at most once.

The live embedding check used local `nomic-embed-text:latest` digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`. Query and document templates produced finite 768-dimensional vectors with `truncate:false`; the resulting adapter identity fingerprint was `b750a1ef6553717d6d2e0d1eb26fe010c55dc2c17408d6220a96b91473712401`.

## Live collector result

The Hyprland collector was exercised against the active compositor socket. It emitted nine observations including seven reconciled snapshots, identified the focused window, kept title capture disabled, reported fresh monotonic observations, and changed state to unknown when stopped.

The Fish integration was exercised in a pseudo-terminal with the real sourced handlers. Across 30 frames, a failed pipeline was reported as shell status `0` with pipeline statuses `[1,0]`, the post-execution event was emitted without command text, and the asynchronous handler returned in 1.823 ms on average without prompt output. Direct Python emitter startup measured over 50 runs had p50 30.4 ms, p95 34.3 ms, and maximum 50.8 ms; the Fish handler remains nonblocking because it launches the emitter asynchronously.

Kitty was installed but no remote-control socket was configured in the live session, so live pane/CWD inspection was unavailable. Recorded parser fixtures passed and show that environment, command line, title, and terminal content are discarded before observations are produced. This does not certify live Kitty integration.
