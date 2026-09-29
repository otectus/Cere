# Cere graph memory integration

Cere is a Node/TypeScript broker with a Qt Quick client. The broker already owns a private Unix socket and supervises conversation and desktop actions. Graph memory therefore reuses the broker rather than introducing a Python application or another privileged action path.

* `broker/graph-memory/client.ts` isolates canonical SQLite work in a worker. `canonical.ts` owns its sole writer, migrations, FTS, revisions, evidence, outbox, and erasure registry. The database is separate from conversation persistence.
* `broker/memory.ts` adapts the existing project/server scope and memory APIs. Existing memories migrate as attributed source passages, never as unsupported graph assertions.
* `broker/core.ts` authenticates the conversation scope before forwarding memory RPC and tools. `broker/ollama.ts` supplies current turns and receives bounded evidence context. Existing action permissions remain authoritative.
* `qml/MemoryDialog.qml` and `KnowledgeSettings.qml` provide the native inspector and configuration through asynchronous broker RPC.
* `broker/graph-memory/adapters` contains production Neo4j, Qdrant, Ollama and desktop adapters. Their results are pointers; canonical eligibility decides whether content may be served.
* `broker/memory-cli.ts` uses the existing private broker socket. Packaging already installs the recursive broker/QML trees and locked production dependencies.

The inspected workspace has no `.git` directory or project-specific AGENTS/CLAUDE files. Runtime at implementation start: Node 26.8.2, linked SQLite 3.53.4. Memory starts disabled, preserving Cere's existing opt-in. Desktop observation/history and cloud routing require separate memory policy.
