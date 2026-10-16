# Validated memory versions

| Component | Version / contract |
| --- | --- |
| Node | 26.8.2, recorded in `.node-version` |
| Linked SQLite | 3.53.4 in the validated Node runtime; startup requires at least 3.51.3 and FTS5 |
| Neo4j Community | 5.26.31 |
| Qdrant | 1.19.1 |
| Neo4j driver | 6.2.0, exact package lock |
| Zod | 4.6.5, exact package lock |
| Ollama | 0.34.4 in live adapter validation |
| Extraction default | `glm-5.3-flash:cloud`; evaluated 2026-10-16, see [evaluation](evaluation.md) |
| Extraction evaluated | `glm-5.3-flash:cloud`, `nemotron-3-super:cloud` and `gpt-oss:20b-cloud` (EV-01, 2026-10-16); `glm-5.3-flash:cloud` again the same day, at the same digest, once undated statements could be accepted |
| Extraction digests tested | `3e780905abc0e7240dd1489935ec1e3c7fcf1854a6f4e7f8688f9bb0bdacb1a5` (`glm-5.3-flash:cloud`), `c6398e09afd407f9988333b6e48629c0afb143c1116f5f79e877552b68a684e4` (`nemotron-3-super:cloud`), `9a01793d9ef8de5309f157c06dbcbadfb598001b4a6f13cbc699cdff5042eaae` (`gpt-oss:20b-cloud`) |
| Extraction prompt / parser | `cere-extraction-v2` / `zod-4-v2` |
| Protocol / ontology / SQLite schema | 1 / 1 / checksum-verified migrations 1–5, pinned by `tests/memory-migrations.test.ts` |

The deployment Compose file pins image digests. The native fallback launcher verifies archive SHA-256 hashes. Java 21 or newer is needed by the native Neo4j distribution. See the [adapter validation](adapters-validation.md) for exact live evidence and upstream references.

Extraction verifies the configured model's registered digest and schema capability before accepting proposals; model identity is recorded with extraction jobs. The selected model name is configurable, not an assertion that its mutable cloud alias will always resolve to the tested digest. The adapter supports an expected digest when used directly.

Embedding identity includes server, model name/digest, dimensions, normalization, query/document templates, and chunking version. Retrieval prompts come from `broker/graph-memory/prompts.ts`. Every nomic-embed-text version uses `search_query:` and `search_document:`. mxbai-embed-large and qwen3-embedding prompt queries only, and embeddinggemma prompts both. Other models are embedded as given. Giving a model prompts changes its embedding identity, so its memories are embedded again in the background. Requests disable server truncation; bounded chunks are averaged and normalized. Incompatible fingerprints use separate collections/generations. Retired generations remain subject to erasure cleanup.

Node upgrades must validate both linked SQLite and the peer-credential helper: the broker currently obtains the socket descriptor through Node's private `_handle.fd` interface and fails closed if it is unavailable. Do not reuse a native binary built for an incompatible platform; rebuild through CMake.
