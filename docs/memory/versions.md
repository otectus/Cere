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
| Extraction | `gpt-oss:20b-cloud` |
| Extraction digest tested | `9a01793d9ef8de5309f157c06dbcbadfb598001b4a6f13cbc699cdff5042eaae` |
| Extraction prompt / parser | `cere-extraction-v2` / `zod-4-v2` |
| Protocol / ontology / SQLite schema | 1 / 1 / checksum-verified migration 1 |

The deployment Compose file pins image digests. The native fallback launcher verifies archive SHA-256 hashes. Java 21 or newer is needed by the native Neo4j distribution. See the [adapter validation](adapters-validation.md) for exact live evidence and upstream references.

Extraction verifies the configured model's registered digest and schema capability before accepting proposals; model identity is recorded with extraction jobs. The selected model name is configurable, not an assertion that its mutable cloud alias will always resolve to the tested digest. The adapter supports an expected digest when used directly.

Embedding identity includes server, model name/digest, dimensions, normalization, query/document templates, and chunking version. Nomic prefixes use `search_query:` and `search_document:`. Requests disable server truncation; bounded chunks are averaged and normalized. Incompatible fingerprints use separate collections/generations. Retired generations remain subject to erasure cleanup.

Node upgrades must validate both linked SQLite and the peer-credential helper: the broker currently obtains the socket descriptor through Node's private `_handle.fd` interface and fails closed if it is unavailable. Do not reuse a native binary built for an incompatible platform; rebuild through CMake.
