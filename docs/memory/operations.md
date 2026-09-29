# Graph memory operations

Build and install Cere using the root README. From a source checkout, invoke `node broker/memory-cli.ts`; after installation use `cere memory`. The existing Cere broker hosts memory; there is no separate memory daemon to start. CLI operations do not auto-start an absent broker.

## Local dependencies

The source deployment profile is `packaging/memory-compose.yml`. Installed files are under the installation prefix's `share/cere/packaging` and `share/cere/tools`; memory documentation is under `share/doc/cere/memory`.

Create a private environment file outside the repository from `packaging/memory.env.example`, replace both placeholders with independently generated secrets, and set mode 0600. Point `CERE_MEMORY_ENV_FILE` to that file. `tools/memory-dependencies.sh up` starts the pinned authenticated containers using Docker Compose or Podman Compose. Published ports bind only to loopback.

Without containers, set `CERE_MEMORY_DEPS_HOME` to a private dependency directory, then run:

```sh
tools/memory-dependencies.sh local-install
tools/memory-dependencies.sh local-start
tools/memory-dependencies.sh check
```

The native path requires curl, tar, SHA-256 utilities, and compatible Java. It downloads checksum-locked Neo4j/Qdrant binaries. `check` uses an isolated synthetic dataset and stops/restarts these services; run it against disposable validation dependencies, not a shared production database. Use `down` for Compose or `local-stop` for native dependencies.

The broker needs the same secrets in a private JSON file whose keys are `graph` (Neo4j password) and `qdrant` (Qdrant API key). Set `CERE_MEMORY_CREDENTIALS_FILE` to its absolute path and keep mode 0600. This is separate from the shell environment file used by the launcher. Broker endpoint overrides are `CERE_NEO4J_URI`, `CERE_NEO4J_USER`, and `CERE_QDRANT_URL`; defaults are `bolt://127.0.0.1:7687`, `neo4j`, and `http://127.0.0.1:6333`.

For an installed broker, add the credential-file path through a `systemctl --user edit cere-broker` service environment override. A service restart interrupts active conversations; schedule it when idle. Do not put the passwords themselves into command-line arguments or the repository.

## Inspection and recovery

```sh
cere memory health
cere memory doctor
cere memory query --session SESSION_ID --text "project formatting"
cere memory inspect --session SESSION_ID --id RECORD_ID
cere memory forget-preview --session SESSION_ID --id RECORD_ID
cere memory erasure-status --job JOB_ID
cere memory rebuild --backend graph --dry-run
cere memory rebuild --backend graph
cere memory rebuild --backend vector
```

Structured commands (`remember`, `correct`, `resolve-conflict`, `identity`, `policy-update`, and `forget`) accept `--file request.json` or `--stdin`. The session selects the authorized project scope. Corrections require a current slot revision and an exact quote from an existing observation. The inspector exposes the same operations. `health` shows canonical/projection revisions, queues, erasure epochs, and memory counts. Backend failures leave canonical writes available and display degraded coverage; suppression is immediate, but a purge cannot complete while its required backend is unavailable.

Back up with `cere memory backup --output /private/path/memory.sqlite`. Preserve its manifest and the **current** `$XDG_STATE_HOME/cere/graph-memory/erasure-registry.jsonl` independently. The backup command covers graph memory, not the separate main `cere.sqlite` conversation/settings database.

Restore with `cere memory restore --input /private/path/memory.sqlite --staging /private/empty-directory`. It refuses the serving directory and a nonempty staging directory. The current registry is applied before staged queries or projection rebuilds. It does not switch the live profile automatically. Stop the broker before an operator-controlled replacement, preserve private modes and both databases, and retain the newest registry. Do not overwrite a newer registry with the backup's older copy. Projection rebuilds are staged and catch up before becoming active.

## Fish and desktop collectors

Enable the desired collector and approved roots in the graph inspector. Fish handlers can be sourced from the checkout's `broker/graph-memory/adapters/fish/cere-memory.fish` or the installed `share/cere/broker/graph-memory/adapters/fish/cere-memory.fish`. Add that explicit source command to your Fish configuration to enable it in new interactive shells. The adjacent Python emitter must remain executable. Remove the source command and restart shells to uninstall. Events fail quietly if the private socket is absent. `CERE_MEMORY_SOCKET` overrides the socket for isolated testing.

Hyprland uses the session's instance socket; title capture is opt-in. Kitty requires an explicitly configured read-only Unix inspection endpoint via `CERE_KITTY_INSPECT_ENDPOINT`; `CERE_KITTY_INSTANCE_ID` supplies a stable configured instance label. Cere never enables broad Kitty remote control automatically. Live Kitty validation remains pending on this development machine. Do not interpret an unknown pane, CWD, or checkout mapping as verified context.

## Diagnostics and limits

Logs should contain opaque IDs and error codes, not raw rejected source text or credentials. Development tests use temporary isolated state and runtime directories. Generated databases, logs, packages, dependency bundles, and snapshots are ignored by Git. The erasure registry itself contains opaque identifiers and is runtime state, not a repository deliverable.

See [implementation status](implementation-report.md) for incomplete workflows and [evaluation](evaluation.md) for failed or unmeasured release targets. A successful compilation does not establish those targets.

Validate a staged installation without touching user state using `python3 tools/check-memory-install.py --root build/publish-install/share/cere`. It uses a local Ollama fixture and unavailable projection endpoints; no cloud request is made. It checks the installed native helper, broker socket, CLI, saved-note recall, and forgetting while backends are down.
