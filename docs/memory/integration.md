# Cere graph memory integration

Cere is a Node/TypeScript broker with a Qt Quick client. The broker already owns a private Unix socket and supervises conversation and desktop actions. Graph memory therefore reuses the broker rather than introducing a Python application or another privileged action path.

* `broker/graph-memory/client.ts` isolates canonical SQLite work in a worker. `canonical.ts` owns its sole writer, migrations, FTS, revisions, evidence, outbox, and erasure registry. The database is separate from conversation persistence.
* `broker/memory.ts` adapts the existing project/server scope and memory APIs. Existing memories migrate as attributed source passages, never as unsupported graph assertions.
* `broker/core.ts` authenticates the conversation scope before forwarding memory RPC and tools. All three managed providers receive bounded context and record completed replies; `broker/ollama.ts` handles Ollama's model-specific context budget, while the core prepares Codex/Claude turns. Native providers use the same memory tools through the session-authenticated `broker/mcp.ts` bridge. Stop cancels preparation and in-flight memory tools. Existing action permissions remain authoritative.
* `qml/MemoryDialog.qml` and `KnowledgeSettings.qml` provide the native inspector and configuration through asynchronous broker RPC.
* `broker/graph-memory/adapters` contains production Neo4j, Qdrant, Ollama and desktop adapters. Their results are pointers; canonical eligibility decides whether content may be served.
* `broker/memory-cli.ts` uses the existing private broker socket. Packaging already installs the recursive broker/QML trees and locked production dependencies.

Codex and Claude select the configured Ollama server's existing project scope, while Ollama retains each conversation's saved server. Cloud recall permission applies to both native providers; local-only evidence remains withheld. Remote native sessions additionally need a grant for the memory server and the applicable memory read/write capabilities. Runtime at implementation start: Node 26.8.2, linked SQLite 3.53.4. Memory starts disabled, preserving Cere's existing opt-in. Desktop observation/history and cloud routing require separate memory policy.
