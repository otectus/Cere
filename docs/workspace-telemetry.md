# Workspace telemetry (Linux)

Workspace telemetry is opt-in and off by default. It keeps shell observations,
Git HEAD metadata and the five newest edited files in memory. Select workspaces
under **Settings → Workspace telemetry**, enable it, then install shell hooks.
Command text and stderr capture each require their own opt-in.

Ollama and direct OpenAI, Anthropic and Google API conversations receive a
request-only situation report beside retrieved context, never in system
instructions. The active workspace is resolved from the destination conversation's
cwd, not the focused terminal or compositor. Internal memory/extraction/embedding
requests and remote conversations do not receive telemetry.

**CLI injection is withheld.** Cere's Codex, Claude Code and AntiGravity adapters
use persistent provider conversations. No verified ephemeral input channel is
implemented for them. This limitation appears in the settings panel and status.
Enabling telemetry does not silently add it to CLI prompts or histories.

## Installation and walkthrough

Build with `npm run build`; normal CMake installation installs `cere-report`,
`cere-run`, `cere-telemetry-hooks`, the Linux native module and shell integration
files. No new npm or system dependency was added. The native reporter avoids a
Python interpreter startup on every prompt; Python 3 remains an existing runtime
dependency for the explicit stderr wrapper and installer.

1. Add an existing project directory in Settings, then enable telemetry.
2. Run `cere-telemetry-hooks install fish` (or `bash` / `zsh`). Open a new shell.
   The installer adds one marked source block; repeated installation is idempotent.
3. Run a command, including `false`, and edit/save a file under the selected root.
   Status should show a listening socket, an active watcher and received events.
4. Enable command capture if desired. Use `cere-run make` to explicitly capture
   the final five stderr lines. Ordinary hooks cannot read terminal scrollback.
5. Send a message in an Ollama or direct API conversation associated with that
   workspace. The context includes only available fields, capped at 600 UTF-16
   units including delimiters. Nothing is added to the visible user message.
6. Pause: ingestion and injection stop, samples and pending work are discarded,
   and filesystem watches close. Hooks can keep running harmlessly. Resume starts
   fresh collection. The application's existing permission pause also suppresses
   injection.
7. Clear: discard samples, queued events and pending debounce work. Configuration
   and listener remain. Asynchronous work from before Clear cannot reinsert data.
8. Run `cere-telemetry-hooks uninstall fish` to remove the marked rc block. Open a
   new shell to remove already-loaded functions. Disable telemetry to close its
   listener and watches. Cere removes only the socket inode it owns; do not delete
   a live socket manually. A harmless empty lock file may remain.

For a source checkout, put `build` and `tools` on PATH before sourcing the hook,
or set `CERE_REPORT` to `build/cere-report` and `CERE_RUN` to `tools/cere-run`.
The shell function named `cere-run` supplies its own session, pid and reserved
sequence numbers to the executable; use the function from an integrated shell.

The wrapper forwards stdout normally and tees stderr back to the terminal while
keeping a bounded ring. **Piping stderr changes `isatty(2)` for the child**, which
can change colors and progress bars. Exit codes and signal-derived exit codes are
preserved. Output events refer to their command sequence; late output never moves
onto a newer command. No managed terminal was added. A future terminal must use
the `ManagedTerminalEventSink` interface and the same validation/capture-policy
queue, rather than modifying state directly.

## State, privacy and bounds

- Canonical roots are persisted configuration. All transient telemetry remains
  in a dedicated worker's memory. Sessions own cwd, command/status, sequence,
  shell pid/start identity and receipt times; workspaces own branch and edits.
  File events never claim a causing shell or process.
- Directory ancestry uses path components and the longest selected ancestor.
  Symlink escapes are rejected; deleted paths use the nearest existing parent.
  Watch traversal does not follow symlinks.
- A shell mints one UUID, replacing inherited identity; re-sourcing preserves it.
  Shell-owned increasing sequence numbers reject delayed reporters. Cwd is last
  observed. Optional `/proc` refresh checks process start identity before and after
  reading cwd. Missing/reused processes are removed. Silent sessions and transient
  fields expire after 30 minutes using monotonic receipt time, never wire `ts`.
- HEAD is read asynchronously, refreshed after 60 seconds and on directory events.
  Linked worktree `.git` files are supported. Only HEAD is read in the referenced
  external directory; no remote/config/object data is inspected there.
- Exclusions are applied before registering inotify watches. Defaults include
  `.git`, dependency directories, build output and caches, plus temp/swap files.
  User patterns use Node path glob syntax. Small root `.gitignore` files contribute
  positive patterns; nested files and negation/re-inclusion semantics are not
  implemented. Reconfigure to reload ignore files. Select the repository root for
  branch reporting; a selected subdirectory does not search outside its boundary.
- Events debounce for 500 ms per canonical path. Rename-over saves record the
  destination. Deletions remove recent entries. Only path, event type and receipt/
  display timestamps are retained for file edits; no edited file content is read.
- Limits: 16 connections, 16 KiB per line, 1-second idle timeout, 256 queued shell
  events, 256 queued filesystem events, 256 sessions/sequence entries, 1,024 pending
  debounce paths, 8,192 directory watches, 64 roots/patterns, and five edits/root.
  Drops and degradation are explicit. These bounds also cover work waiting on
  canonicalization. Native event reads are bounded to 64 KiB.
- `IN_Q_OVERFLOW`, registration/watch limits and debounce exhaustion mark the
  watcher degraded; they do not crash the client or switch to filesystem polling.
  The Linux limit is `fs.inotify.max_user_watches`. Inspect with
  `sysctl fs.inotify.max_user_watches`; changing it is an administrator decision.
  Reducing selected trees/exclusions or raising an appropriate limit, followed by
  Pause/Resume, restores collection. Events dropped during overload cannot be
  reconstructed.
- Socket: `$XDG_RUNTIME_DIR/cere/telemetry.sock`, otherwise
  `/tmp/cere-$UID/telemetry.sock` in a private 0700 directory. The socket is 0600.
  The existing explicit `CERE_RUNTIME_DIR` development/test override is respected
  by the broker; normal shell helpers use the standard XDG/fallback location.
- Startup is serialized with `flock`. Symlink/non-socket/foreign-owned paths are
  refused. Live listeners are left intact and reported as in use. Only refused or
  absent endpoints are eligible for stale cleanup. Peers must pass SO_PEERCRED UID
  checks. Native watches and lock descriptors also close on worker termination.
- The listener provides one small capture-policy JSON line on connection; the
  reporter uses it before sending an event. The backend independently strips
  command text and rejects output when disabled. Unknown/malformed events never
  log contents. `NODE_DEBUG=cere-telemetry` enables rate-limited error-code-only
  debug messages.
- Secret-like assignments/flags, Authorization headers, token patterns and URL
  userinfo are replaced at ingestion before retained state. The wrapper also
  redacts lines before clipping. ANSI/control characters and delimiter characters
  are stripped/escaped for reports; command values are JSON-quoted. Truncation has
  a visible marker. These measures reduce, but do not eliminate, prompt-injection
  risk. Unrecognized secret formats can still occur; keep raw capture disabled
  when working with sensitive commands.

The persistence guarantee concerns the automatically injected telemetry block.
It does not suppress ordinary model replies that mention or paraphrase observed
facts, nor change external providers' retention policies or the shell's own
history. Bash respects history-disabled/ignored commands by omitting unavailable
command text; it does not enable history or install a competing DEBUG trap.
With bash-preexec it uses its preexec/precmd arrays. The report is regenerated for
each chat/tool round, and a pause/clear/configuration change fences HTTP dispatch
and retries. An already-dispatched request cannot be recalled.

## Validation and measurements

Commands (run from the repository root):

```sh
npm run build
npm run typecheck
npm test
CERE_TTS_DISABLED=1 node --test tests/telemetry.test.ts tests/telemetry-persistence.test.ts tests/telemetry-shells.test.ts
python3 tests/telemetry-shells.py
node tools/benchmark-telemetry.ts
LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib" QT_PLUGIN_PATH="$PWD/.local-deps/usr/lib/qt6/plugins" /usr/lib/qt6/bin/qmllint -I qml qml/TelemetrySettings.qml
LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib" QT_PLUGIN_PATH="$PWD/.local-deps/usr/lib/qt6/plugins" QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software QT_QUICK_CONTROLS_STYLE=Basic ./build/cere-ui-check settingsSectionNavigation workspaceTelemetryControls
PATH="$PWD/.local-deps/usr/bin:$PATH" LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib" ctest --test-dir build --output-on-failure
npx tsc -p tsconfig.mobile.json
node tools/mobile-contract.ts --check
git diff --check
```

There is no repository-wide TypeScript/C++ lint script. `qmllint` covers the added
QML component, while compilation/typechecking and `git diff --check` provide the
existing remaining checks. Interactive shell tests use isolated HOME/rc files and
PTYs; they never install hooks into the user's shell.

September 30 native-reporter sample: 40 prompts per shell. Added p95
latency was Fish **0.54 ms**, Bash **0.86 ms**, Zsh **0.31 ms**; maximum total
enabled prompt latency was 2.06 / 1.06 / 0.59 ms respectively. Scheduling/load can
change these figures; these are measurements, not hard real-time guarantees.

An isolated Node process plus telemetry worker measured **0.22% of one core** over
five idle seconds, with **130.9 MiB RSS**. A 15-second sustained event flood sent
148,000 events while six Git checkouts replaced a 4,096-file fixture and 6,000
ignored dependency files were written. Peak RSS was **178.7 MiB** (first-half peak
177.7, second-half 178.7); 131 watches were registered, and pending work drained to
zero. Excess traffic caused 65,053 counted drops and explicit degradation. The
host event-loop p99 delay was **12.17 ms**, maximum **21.00 ms**, including benchmark
filesystem work. This measures the isolated host, not total Cere UI memory or a
physical compositor's frame time. A separate offscreen Qt test performed 4,096
rename-over saves while the settings view was active: 75 UI heartbeat samples,
maximum gap **23 ms**, below its 150 ms stall assertion.

Evidence files from this implementation are under `/tmp/cere-telemetry-*`:
`build.log`, `types.log`, `focused.log`, `full-tests.log`, `ui.txt`, `qmllint.log`,
`shells.json`, and `load.json`. The final validation record states current suite
results and unrelated concurrent-work blockers. Offscreen UI acceptance is not a
claim of a physical-desktop walkthrough or an installed-client restart.

## Files

- `broker/telemetry/protocol.ts`: event schema, capture enforcement, redaction and future terminal interface.
- `broker/telemetry/paths.ts`: canonical configuration and workspace containment.
- `broker/telemetry/state.ts`: session/workspace ownership, receipt expiry, PID refresh and bounded reports.
- `broker/telemetry/native.ts`: Linux binding loader and event types.
- `broker/telemetry/listener.ts`: private socket lifecycle, framing, peers and content-free counters.
- `broker/telemetry/files.ts`: pruned inotify traversal, debounce and worktree HEAD watching.
- `broker/telemetry/worker.ts`: isolated ingestion, controls and lifecycle.
- `broker/telemetry/service.ts`: bounded broker/worker communication and request invalidation.
- `native/telemetry.cpp`: inotify events and flock descriptors with cleanup hooks.
- `native/report.cpp`: bounded, silent native shell reporter.
- `shell/cere.fish`, `shell/cere.bash`, `shell/cere.zsh`: guarded shell hooks and `cere-run` functions.
- `tools/cere-run`: explicit bounded stderr tee and output-event reporter.
- `tools/cere-telemetry-hooks`: idempotent marked rc-block installer/uninstaller.
- `tools/benchmark-telemetry.ts`: isolated idle/flood/checkout measurements.
- `broker/core.ts`: settings, status, lifecycle, RPC controls and eligible request context.
- `broker/types.ts`, `broker/store.ts`: persisted configuration defaults and merging.
- `broker/ollama.ts`: ephemeral per-round injection and dispatch/error privacy guards shared with direct APIs.
- `qml/TelemetrySettings.qml`, `qml/Settings.qml`: controls and navigation.
- `CMakeLists.txt`: native targets and installation rules.
- `tests/telemetry.test.ts`: state, path, protocol, IPC, watcher and worker regressions.
- `tests/telemetry-persistence.test.ts`: end-to-end transcript/memory-input/backup/diagnostic isolation.
- `tests/telemetry-shells.py`, `tests/telemetry-shells.test.ts`: interactive shell acceptance and latency.
- `tests/ui.cpp`: settings navigation and telemetry controls acceptance.
- `README.md`, `VALIDATION.md`, this document: setup, evidence and limitations.
