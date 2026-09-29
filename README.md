# Cere

A native desktop companion for Arch Linux and Hyprland. Click Cere for chat and desktop controls; drag her to move. She uses a polished transparent sprite sheet; the four original GIFs remain intact. Always-on-top is enabled initially, including above fullscreen application windows. Disable it for normal floating-window behavior.

## Run from this workspace

```sh
./tools/run.sh
```

Use `./tools/run.sh --show` to open the expanded workspace immediately. The tray opens or hides Cere and offers separate quit options for stopping sessions or leaving them running. Only one interface instance runs per runtime directory.

Build the application first using the instructions below. Generated binaries, local dependency bundles, user state, and credentials are not included in the repository. If `.local-deps` is present locally, `tools/run.sh` configures its library paths.

## Build and install on Arch

Install `base-devel cmake ninja qt6-base qt6-declarative layer-shell-qt nodejs npm`. Desktop controls additionally use `hyprland gtk3 xdg-utils wireplumber libnotify grim satty systemd`. Node 26.8.2 is the validated runtime (see `.node-version`). Graph memory additionally requires Node’s linked SQLite to be 3.51.3 or newer with FTS5; startup rejects an older SQLite build. Install and authenticate Codex CLI and Claude Code separately; Cere uses those installed executables and their own authentication/configuration.

```sh
npm ci
npm run build
npm test
npm run typecheck
makepkg -si
```

The package installs `cere`, its desktop entry, and `cere-broker.service`. The installed UI starts the user service on demand. Login startup is opt-in in Settings. Removing the package preserves user data.

For a per-user installation after building, run `python3 tools/install-user.py`. This installs the application, menu entry, icon and user service beneath `~/.local`, and preserves an existing login-startup preference. It bundles the optional LayerShellQt library/plugin when local build dependencies were used; Qt and Node remain system dependencies. No project-folder launcher is needed. Use `--prefix build/user-install` to stage and inspect the installation first. Open **Cere** from your application menu, or run `~/.local/bin/cere --show`.

After installation:

```sh
cere                 # show the pet
cere show            # open the full workspace
cere toggle          # toggle the compact panel, recovering a hidden pet
cere terminal codex  # register a terminal session, then run the normal CLI
cere terminal claude
```

Use your compositor’s configuration interface to bind `cere toggle` to a convenient shortcut. Cere does not replace your existing keybindings. The legacy Hyprland configuration equivalent is `bind = SUPER, C, exec, cere toggle`; newer Lua-based configurations use their own binding syntax.

## Interaction

- Click Cere to open her compact panel. Dragging suppresses the click. Right-click for size, roaming, quiet mode, and visibility.
- Chat supports streaming replies, selectable CommonMark/GitHub Markdown (headings, emphasis, nested lists, task lists, tables, links, images and fenced/indented code), image attachments, Stop, and provider approvals. Tool activity stays in the expandable **Activity Panel** below the conversation; click its bar again to hide it. Ctrl+Enter sends; Ctrl+N creates a session; Ctrl+K opens desktop search; Ctrl+, opens Settings; Escape closes the panel.
- Expand opens an ordinary resizable workspace. Selecting a session restores its draft. New output does not force scrolling while you read earlier messages.
- New sessions offer Codex, Claude, and Ollama. CLI model and effort dropdowns use each provider’s catalog; their default choices retain the CLI’s settings. Ollama offers its available chat models and a saved default.
- When both Cere windows are closed or minimized, pending permissions appear in a speech bubble beside the visible pet, with the same response buttons and session labels as the workspace. The bubble remains available in quiet mode and disappears when requests end or a Cere window opens.
- Sessions creates managed conversations or imports completed CLI history. Confirm that the external session is stopped before resuming it. The terminal launcher only reports lifecycle and offers terminal navigation; it does not scrape or remotely type into the terminal.
- Handoff lets you choose another provider and creates an editable draft using recent conversation text. Nothing is sent until you review and submit it.
- Desktop groups controls into responsive cards, with category filters and search across actions, applications, and windows. It launches applications, opens files/folders, focuses or moves windows, changes workspaces, controls media and live output volume, opens captures in Satty, creates timers, and runs saved executables with explicit arguments. Long names have tooltips; every section remains reachable by scrolling in the compact panel.
- Capture in Satty opens the focused display in the crop/annotation editor. Enter saves the edited image and returns to Cere’s preview; Escape cancels. The temporary original is removed. An explicit sharing choice precedes giving an AI session the saved image.
- Media controls prefer Spotify when it is open, otherwise the playing MPRIS application. Cere displays the target and playback state, pins button commands to that target, and disables unavailable actions. Closing the target does not silently redirect an in-flight button press to a browser.

Roaming starts disabled. When enabled, Cere slowly follows the mouse across your displays, easing into motion at up to 75 logical pixels per second and stopping short of the pointer. Small pointer movements do not make her shuffle constantly. Hovering or using her menu, opening either interface, dragging, fullscreen apps, task activity, approvals, hiding, quiet mode, and reduced motion pause following. The old roaming-area presets are replaced by following across the available screens.

Cere acts through her eyes, head, hands and stance, keeping her glasses, mask and established outfit. An additional eight-pose sheet supplies skeptical side-eye, smug confidence, disbelief, curious leaning, an affectionate wink, reassurance, explanation and a planted fist-pump. Focus in the editable chat composer means listening (there is no microphone); live provider activity distinguishes thinking, reply streaming and tool work. Permission requests and problems interrupt casual gestures, and reactions settle into the latest state. Confirmed turn completion gets a brief celebration; interrupted, cancelled and failed turns do not. A short cancellable completion delay prevents an adjacent fault or new task from flashing a victory pose. Background completions do not interrupt active work.

Subtle breathing and irregular blinks accompany supported resting poses. Six quiet idle gestures use a shuffled pool with no immediate repeats, roughly 26–51 seconds apart at the default intensity; large legacy gestures remain available as explicit previews. Hover gaze uses pointer events inside the pet, with no additional desktop polling. **Settings → Motion & expressions** offers gesture previews, motion intensity, reduced motion and optional conversational cues. Intensity softens movement and spaces out idle gestures. Reduced motion and zero intensity use still state poses with no animation timers; quiet mode uses a neutral still pose and suppresses ordinary notifications. Approval messages remain available. Hidden pet hosts discard reactions. Sound is not used.

Conversational cues are a small, conservative, local English phrase matcher on the opening of fresh user/assistant messages. Clear reassurance gets softer acting; cheeky, skeptical or curious openings can prompt one brief reaction, with a shared cooldown. History, tools, quoted/code openings and unknown cues stay neutral. This is a tone hint, not sentiment detection or evidence that a task succeeded. Disable it independently of state acting.

Acting remains data-driven in `assets/motions.json`: clips define priorities, poses, holds (`ms`), optional transition duration (`easeMs`) and bounded transforms; resting clips opt into breathing and frames can name a matching blink pose. Frames may reference a supplemental texture, keeping the original atlas intact. `assets/cere-expressions.png` is the only added runtime artwork; its built-in image-generation prompt is recorded in `artwork/expressions-prompt.txt`. Additional matching closed-eye cels would extend blinking to the new poses; they are not required for the shipped behavior.

**Settings → Personality** controls Cere’s voice in all managed Codex, Claude, and Ollama conversations. The default is a warm, sharp-tongued rogue; edit the multiline text and choose **Save personality** to replace it, or save an empty field for a neutral voice. **Restore default** fills the editor with the original text for review before saving. Changes persist across restarts and apply on the next turn, including existing conversations; running turns keep their current personality. Personality does not change permissions or project instructions. External linked terminals retain their own configuration until handed to Cere.

## Ollama

Run an Ollama server, then open **Settings → Connections**. The default address is `http://127.0.0.1:11434`; **Connect** accepts another HTTP(S) server or reverse-proxy base URL. **Refresh** reloads its chat models. Choose a **Default model for new conversations**, or select a model when opening each session. Pull models with Ollama itself; Cere does not download or delete models automatically. Embedding-only models are excluded and cloud-backed models are labeled **Cloud**. Cloud authentication stays with your Ollama server.

Choose **Ollama** in a new session for streaming conversation. The project folder is optional in conversation mode. The **Model** button changes an idle conversation’s model or enables assistance; existing context is retained. Defaults affect new sessions, and each session keeps its server address even if the connection setting changes. Image-capable models accept explicitly attached PNG, JPEG and WebP files (10 MB each, 20 MB combined, up to four). Thinking uses the model’s defaults and is retained in provider context without cluttering the transcript.

For orchestration, select a model marked **Tools**, enable **desktop tools and delegation**, and trust the project folder. Under **Settings → AI assistance**, enable the categories you want:

- **Provider orchestration** lets Ollama start Codex or Claude tasks in the same project, send follow-ups, wait for and read results, and stop its delegated sessions. Unless CLI permission bypass is enabled, each task or follow-up asks you to review the exact prompt and provider first, including under Broad control. Delegated sessions appear in Sessions and retain their provider’s own approvals. Ollama can manage only sessions it created.
- **Saved scripts** lets it list and run explicitly configured executables with their saved arguments, including other CLIs. Execution follows the same approval and grant rules as Cere’s existing script controls.
- Desktop categories allow application/window discovery, desktop actions, media and volume controls, timers, and approved captures. Captures require a separate sharing approval before an image-capable model receives the image, unless computer-control permission bypass is enabled.

**Stop** cancels the Ollama request and active delegated turns started during that turn. Turning off assistance categories or pausing AI actions prevents further tool execution. Tool loops stop after 24 model responses (up to 16 requested tools per response), and a stalled HTTP request times out after three minutes. On broker restart, incomplete turns stay interrupted; unresolved tool calls are recorded as having an unknown outcome and are never replayed automatically.

Cere uses Ollama’s [native chat API](https://docs.ollama.com/api/chat) and [streaming tool protocol](https://docs.ollama.com/capabilities/streaming). Conversation content and approved attachments go to the configured server; **Cloud** models are processed through Ollama Cloud. `CERE_OLLAMA_HOST`, then `OLLAMA_HOST`, supplies the initial address when no connection has been saved. Existing installations gain these settings without a database migration.

## Web search

Enable **Settings → Web search** for Ollama conversations. It works in Conversation mode and Assistant mode without desktop permissions. Models with native tool support receive `web_search` and `web_read` and are instructed to use them when asked, for current facts, or when their knowledge is uncertain. Tool use still depends on the model. Check **Search web** beside the message box (**Web** in compact windows) to search first with any chat model, including models without tool support. This sends your next message as a public query, up to 500 characters; the choice resets after sending.

Choose **DuckDuckGo**, **Brave**, **Mojeek**, or **SearXNG**. The first three read public search pages without an account or API key. **Automatic** tries DuckDuckGo first, then Brave and Mojeek on failure or unusable results, and reports fallback. Selecting an individual provider keeps queries with it. For SearXNG, enter its base URL and enable `json` in its `search.formats`. Cere uses only that instance; it does not choose a random public server. Search starts disabled.

Replies include clickable source buttons; the Activity Panel shows queries, results, and errors. Public providers sometimes return CAPTCHA pages or rate limits; Cere reports these failures instead of treating a blocked page as evidence. The reader accepts public HTTP(S) HTML/text, strips scripts and navigation, checks DNS and redirects against private networks, and bounds page size and returned text. The explicitly configured SearXNG endpoint can be local. Reading a source contacts its website. Stop cancels research, and pausing AI actions or disabling search prevents further tool use. Research is limited to eight tool calls per turn. Pages and snippets are untrusted reference material.

## Ollama memory

Graph memory is integrated into the broker and native inspector. **It remains experimental:** the full reference design’s release criteria have not all passed. See [implementation status](docs/memory/implementation-report.md) and [evaluation results](docs/memory/evaluation.md) for measured results and remaining work.

Enable **Settings → Memory → Remember and recall conversations**. Memory starts disabled. The extraction model is **`gpt-oss:20b-cloud`**; the default embedding model is **`nomic-embed-text`**. Both must already be registered with the configured Ollama server. Cere does not download models automatically. Cloud extraction and sharing recalled memory with a cloud chat model are separate settings: cloud extraction is configured for the selected model, while cloud recall starts disabled. Sources marked local-only cannot be dispatched to cloud extraction.

Canonical observations, exact source witnesses, entities, typed assertions, correction history, episodes, and erasure records live in private SQLite at `$XDG_STATE_HOME/cere/graph-memory/memory.sqlite`. Neo4j and Qdrant are rebuildable local projections. Their pointers are checked against canonical scope, time, revision, policy, and erasure state before text is recalled. See [operations](docs/memory/operations.md) for authenticated dependency setup, Fish integration, backup, restoration, and reindexing.

**Manage project memory** opens saved notes and conversation passages for the selected conversation’s project folder and Ollama server. The **Graph, evidence and workspace inspector** adds temporal queries, provenance, structured corrections, conflicts, collector policy, indexing status, and forgetting progress. Structured corrections require an exact source quotation and the inspected revision. Uncertain effective dates remain candidates for review. Model text alone cannot establish that an action succeeded.

Writes commit before embedding, so saved decisions are available to lexical recall even while indexing is unavailable. Retrieval degrades with explicit coverage when a model or projection is down. Memory enters the prompt as delimited untrusted data, with separate records of evidence supplied to the model and evidence actually cited. Recent chat context still uses a bounded prompt window with complete tool request/result pairs.

Forgetting suppresses use immediately, scrubs matching passages from Cere’s managed conversation history, and reports physical deletion separately while projection acknowledgements are pending. Keep the current external erasure registry when restoring any backup; an older backup alone must not resurrect forgotten content. External provider histories and copies exported outside Cere are not managed by this workflow. Disabling memory stops normal capture and recall without deleting retained records.

Architecture, configuration boundaries, and pinned versions are documented in [architecture](docs/memory/architecture.md), [policy](docs/memory/policy.md), and [versions](docs/memory/versions.md).

## Permissions and persistence

Desktop AI categories start disabled. Scoped assistance enables chosen categories and asks before sensitive tools. Broad control is optional and requires project-specific, expiring grants. Pause and revoke remain available. Cere’s grants govern its own MCP tools; they do not sandbox unrelated shell access already granted to a CLI.

**Settings → AI assistance** has two persistent, independent bypass toggles, both off by default:

- **Bypass all CLI permissions** automatically accepts project trust, provider permissions, saved-script execution and delegation. Codex turns use `approvalPolicy: never` with `dangerFullAccess`; Claude launches with `--dangerously-skip-permissions` and its optional sandbox disabled. New `cere terminal codex|claude` launches inherit the setting. Saved scripts and provider orchestration become available regardless of the assistance profile or category selections.
- **Bypass all computer-control permissions** enables all Cere desktop categories and accepts their action and capture-sharing requests without category grants. Saved scripts and delegation remain governed by the CLI toggle.

Enabling a toggle also accepts matching pending requests. Actual questions still need answers. CLI sandbox changes take effect on the next turn; stop active work to end its existing access, and restart linked terminals to change launch permissions. Disabling bypass restores the configured Codex sandbox and Claude’s normal permission mode on the next turn. Your saved categories and grants are preserved. Pause blocks Cere tools even with bypass enabled; it does not interrupt unrestricted provider shell access. CLI full access can itself control the desktop through shell commands. Provider or administrator restrictions outside Cere still apply.

Markdown renders during streaming and when stored sessions reopen. Message Copy preserves the original Markdown; text selection copies the rendered text. Links open only on activation, and file links resolve against the session’s project directory. Tool output remains literal text. Wide tables can scroll horizontally.

Provider approvals remain separate from Cere’s desktop approvals. Unknown provider requests fail closed with an explanation. MCP form elicitation supports primitive fields; URL and complex forms require terminal continuation. CLI versions used for validation: Codex 0.158.0 and Claude Code 2.1.284. Authentication and billing remain with each CLI.

State is stored in `$XDG_STATE_HOME/cere/cere.sqlite` (normally `~/.local/state/cere`), using private filesystem permissions. It includes settings, drafts, conversation messages, recent action metadata, and timers. Screenshots live in the sibling `captures` directory. Codex and Claude transcripts remain in their native locations. Ollama’s full conversation context, tool results, and explicitly shared images are stored in Cere’s private database. Enabled graph memory also publishes eligible projections to the configured local Neo4j and Qdrant services; selected cloud extraction uses Ollama Cloud.

Cere IPC uses a private Unix socket at `$XDG_RUNTIME_DIR/cere/broker.sock`; enabled Fish collection uses `$XDG_RUNTIME_DIR/cere-memory/memory.sock`. Connections require the same OS user. Cere opens no TCP listener; configured Ollama and memory dependencies use HTTP(S) or Bolt, with the packaged database ports restricted to loopback. MCP subprocesses receive session-scoped random capability tokens. A UI restart leaves broker work running. A broker restart marks incomplete turns interrupted and never silently replays them. Restart the installed broker with `systemctl --user restart cere-broker` only when you intend to interrupt its active work.

For isolated development, set `CERE_STATE_DIR` and `CERE_RUNTIME_DIR`. Set `CERE_CODEX_BIN` or `CERE_CLAUDE_BIN` to an executable path when testing a different provider build.

## Validation

```sh
npm test
npm run typecheck
npm run build
./build/cere-motion-check
QT_QUICK_CONTROLS_STYLE=Basic ./build/cere-ui-check
```

For the locally extracted dependencies, prefix the UI test with `LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib" QT_PLUGIN_PATH="$PWD/.local-deps/usr/lib/qt6/plugins"`. Native tests briefly open isolated test windows and write screenshots to `/tmp/cere-ui-evidence`.

`tools/live-check.ts` runs real provider calls in a temporary project, including a named harmless printf script, approval, another turn, and a process disconnect/resume. It consumes normal CLI usage. Run it only with isolated `CERE_STATE_DIR` and `CERE_RUNTIME_DIR` values. `tools/probe-providers.ts` is a smaller no-tool connectivity check.

`node tools/check-ollama.ts MODEL [codex|claude]` exercises real Ollama conversation, recall after disconnect, an approved saved `printf` command, and optional provider delegation. It creates its own isolated broker/project, uses normal provider usage, and prints the evidence directory containing `report.json`, `broker.log`, and the test database. Only the known test command and exact test delegation are approved. Backend tests and native UI checks use local Ollama fixtures with no inference usage.

The original atlas can still be extracted with `python tools/prepare-assets.py` (Pillow). The current artwork is rebuilt with `python tools/clean-artwork.py` (Pillow and NumPy), using `artwork/cere-clean-white.png`. This removes the exterior white matte, preserves enclosed eye highlights, and packs equal cells with transparent gutters. It also generates the tray icon. Neither command alters the original GIFs. Artwork prompts are recorded in `assets/artwork-prompts.txt`; gesture timing and transforms are in `assets/motions.json`.

`node tools/check-knowledge.ts [MODEL]` checks real `nomic-embed-text` recall, restart persistence, public search, and source reading in a temporary project. Supplying a model also tests native search/memory tools and the use of recalled context, with synthetic facts only. `MODEL --memory-only` or `MODEL --web-only` repeats just that model tool check. The script prints its private evidence directory. `build/cere-ui-check searchAndMemory` exercises settings, the embedding check, memory editing, explicit search with a plain chat model, and source links against local fixtures. Production HTML-parser dependencies are bundled with installed Cere.

See `VALIDATION.md` for the checks performed on this machine and the remaining platform coverage limits.
