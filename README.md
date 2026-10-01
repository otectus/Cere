# Cere

Workspace telemetry is available as an opt-in Linux feature under Settings.
See [setup, privacy boundaries, shell hooks and measurements](docs/workspace-telemetry.md).

A native desktop companion for Arch Linux and Hyprland. Click Cere for chat and desktop controls; drag her to move. Her transparent avatar uses a rigid cutout skeleton with independently jointed artwork. The original animation GIFs are not distributed with this repository. Always-on-top is enabled initially, including above fullscreen application windows. Disable it for normal floating-window behavior.

## Run from this workspace

```sh
./tools/run.sh
```

Use `./tools/run.sh --show` to open the expanded workspace immediately. The tray opens or hides Cere and offers separate quit options for stopping sessions or leaving them running. Only one interface instance runs per runtime directory.

Build the application first using the instructions below. Generated binaries, local dependency bundles, user state, and credentials are not included in the repository. If `.local-deps` is present locally, `tools/run.sh` configures its library paths.

## Build and install on Arch

Local speech uses bundled Piper and `en_US-amy-medium`. Install Python 3.12+,
`alsa-utils`, `sox` and `pipewire-alsa` (or PulseAudio's ALSA plugin) alongside the build
dependencies below. The first build downloads checksum-pinned speech assets;
installed playback is offline. See [voice settings, `/tts-test`, custom voices and
Speech Dispatcher setup](docs/tts.md).

Voice settings also offer **ElevenLabs · API**, with a private API key, account
voice/model selection and streamed playback. **Speak replies from** lets you
enable automatic speech separately for each conversation provider, including
pinned conversations. See [voice and API setup](docs/tts.md#elevenlabs-api-speech).

**Settings → Voice → Speech provider → IndexTTS** adds optional local voice cloning,
multilingual IndexTTS-2.5 and an optional IndexTTS-2 checkpoint. Its pinned Python,
Torch and model files live in an isolated per-user runtime. Review the license
before downloading; allow about 30 GiB for setup. See the [IndexTTS installation,
voices, hardware limits and troubleshooting](docs/tts.md#indextts-voice-cloning).

Install `base-devel cmake ninja qt6-base qt6-declarative layer-shell-qt nodejs npm`. Desktop controls additionally use `hyprland gtk3 xdg-utils wireplumber libnotify grim satty systemd`. Qt 6.8 or newer is required for the avatar renderer. Node 26.8.2 is the validated runtime (see `.node-version`). Graph memory additionally requires Node’s linked SQLite to be 3.51.3 or newer with FTS5; startup rejects an older SQLite build. Install and authenticate Codex CLI and Claude Code separately; Cere uses those installed executables and their own authentication/configuration.

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

- Click Cere to open her compact panel; the message box is ready for typing as soon as it opens. Dragging suppresses the click. Right-click for size, roaming, quiet mode, and visibility. With always-on-top disabled, the compact panel is a normal window that Hyprland floats beside her at its compact size.
- On short screens the compact panel folds **Model**, **Handoff**, **Inbox**, **Memory review** and **Context** into a **More** menu beside Send, and the conversation page scrolls rather than hiding controls, so every part of the panel stays reachable.
- Chat supports streaming replies, selectable CommonMark/GitHub Markdown (headings, emphasis, nested lists, task lists, tables, links, images and fenced/indented code), image attachments, Stop, and provider approvals. Tool activity stays in the expandable **Activity Panel** below the conversation; click its bar again to hide it. Ctrl+Enter sends; Ctrl+N creates a session; Ctrl+K opens desktop search; Ctrl+, opens Settings; Escape closes the panel.
- Codex and Claude questions appear as dedicated forms with option descriptions, single or multiple selections, and written answers. Required answers are checked before submission. Desktop question drafts survive navigation and unrelated progress updates in the same UI process; private answers are masked and redacted from Cere's conversation history. Permission bypass never supplies an answer.
- **Activity** shows native subagents and delegated conversations, including their current task, progress, result, and interruption or failure. Active agent counts remain visible when the panel is closed. Parent conversations stay busy while tracked background work remains, and child replies stay in Activity. Stop includes active child work.
- Expand opens an ordinary resizable workspace. Selecting a session restores its draft. Moving between the compact panel and the workspace keeps the draft and its attachments, the cursor and selection, the **Search web** choice, the Activity Panel and the message you were reading, even though the two windows lay the conversation out at different widths. New output does not force scrolling while you read earlier messages, whether you scroll with the wheel, by dragging, or with the scrollbar.
- New sessions offer Codex, Claude, and Ollama. CLI model and effort dropdowns use each provider’s catalog; their default choices retain the CLI’s settings. Ollama offers its available chat models and a saved default.
- When both Cere windows are closed or minimized, pending permissions appear in a speech bubble beside the visible pet, with the same response buttons and session labels as the workspace. Every request names its provider and session ID, the full session title and the project folder on separate lines, so a long title never hides which project is asking. The bubble remains available in quiet mode and disappears when requests end or a Cere window opens.
- Sessions creates managed conversations or imports completed CLI history. Confirm that the external session is stopped before resuming it. The terminal launcher only reports lifecycle and offers terminal navigation; it does not scrape or remotely type into the terminal.
- Handoff lets you choose another provider and creates an editable draft using recent conversation text. Nothing is sent until you review and submit it.
- Desktop groups controls into responsive cards, with category filters and search across actions, applications, and windows. It launches applications, opens files/folders, focuses or moves windows, changes workspaces, controls media and live output volume, opens captures in Satty, creates timers, and runs saved executables with explicit arguments. Long names have tooltips; every section remains reachable by scrolling in the compact panel.
- Capture in Satty opens the focused display in the crop/annotation editor. Enter saves the edited image and returns to Cere’s preview; Escape cancels. The temporary original is removed. An explicit sharing choice precedes giving an AI session the saved image.
- Media controls prefer Spotify when it is open, otherwise the playing MPRIS application. Cere displays the target and playback state, pins button commands to that target, and disables unavailable actions. Closing the target does not silently redirect an in-flight button press to a browser.

Roaming starts disabled. When enabled, Cere slowly follows the mouse across your displays, easing into motion at up to 75 logical pixels per second and stopping short of the pointer. Small pointer movements do not make her shuffle constantly. Hovering or using her menu, opening either interface, dragging, fullscreen apps, task activity, approvals, hiding, quiet mode, and reduced motion pause following. The old roaming-area presets are replaced by following across the available screens.

Cere acts through her eyes, head, hands and stance, keeping her glasses, mask and established outfit. An additional eight-pose sheet supplies skeptical side-eye, smug confidence, disbelief, curious leaning, an affectionate wink, reassurance, explanation and a planted fist-pump. Focus in the editable chat composer means listening (there is no microphone); live provider activity distinguishes thinking, reply streaming and tool work. Permission requests and problems interrupt casual gestures, and reactions settle into the latest state. Confirmed turn completion gets a brief celebration; interrupted, cancelled and failed turns do not. A short cancellable completion delay prevents an adjacent fault or new task from flashing a victory pose. Background completions do not interrupt active work.

Animation follows Qt's display animation clock. A cutout skeleton gives her separate head, back hair, torso, shoulders, upper arms, elbows, hips, thighs and knees. Each painted part rotates and translates rigidly around an explicit joint: waving cannot stretch her face or pull nearby hair into an arm. Breathing lifts the torso, hair follows head velocity with restrained lag, and two-axis hover gaze takes precedence over wandering attention. Exact damped springs preserve each joint's position and velocity when a gesture is interrupted. Roaming is frame-paced with fractional-pixel compensation, and output-seam mirrors consume the primary avatar's exact sample. Carrying her adds inertia, and release settles into a soft landing.

The 32-stance, 74-clip catalog includes intermediate joint presets for releasing and gathering hands, offering palms, a half-wave, adjusting glasses, tucking hair, a soft reset and attentive rest. Stance transitions prepare, release, transfer, arrive and settle; urgent reactions take a short route. Waves visibly raise and lower the arm around continuous elbow movement. Idle acting includes glances, weight shifts and shoulder rolls every few seconds, asymmetric varied breaths, and hair that follows head velocity. The **Idle energy** setting defaults to **Lively**: 21 longer gestures, including in-place steps, open-palm explaining, heel rocks, small rebounds, a surveying turn and a larger stretch, with a 5–10 second pause after each gesture at default intensity. **Calm** retains the original 14-gesture pool, idle acting strengths and roughly 13–26 second pause. Both use a shuffled bag with no immediate repeats. Lively keeps these gestures available while an open conversation or reply bubble is being read; an empty focused composer no longer holds her in listening indefinitely. A focused draft or attachment still means listening. Hovering or interacting with the avatar and active work continue to pause longer idle gestures. Calm retains its original open-panel suppression. Timing bounds, micro-acting intervals and profile strengths live in `assets/motions.json`; intensity still divides the longer-gesture delay with a floor of 0.35. The extra steps never move the window; roaming remains opt-in. Automatic blinks use the existing frame clock during gestures and entries as well as loops. The shared head-mounted eye overlay needs no per-stance artwork. Occluded eyes defer an overdue blink until eligible, while authored winks and closed-eye clips retain control. Eligible eyes never wait more than eight active seconds; hidden or still states do not accrue blink time. **Settings → Motion & expressions** includes a local captioned preview, the full gesture catalog and quick previews. Lower intensity softens acting and spaces out longer idle gestures. Reduced motion and zero intensity use still state poses with no animation clock; quiet mode uses a neutral still pose and suppresses ordinary notifications. Permission messages remain available. Hidden hosts discard reactions. Animation cues do not use sound; spoken replies are configured separately under **Settings → Voice**.

GPU and software scene graphs use the same joint hierarchy and ordinary layered images. The renderer caches atlas crops and updates rigid transforms without a deforming mesh, custom blending shader or render-to-texture layer. The base head stays opaque beneath localized eye expressions.

The compact panel and workspace headers use a dedicated twelve-frame head portrait, with blinks, subtle head movement, pointer attention and a click-to-wink greeting. Connection problems, permissions and task activity take priority. A small speech indicator follows actual voice playback. Quiet mode, reduced motion and zero intensity stop the portrait's animation; hidden and minimized windows stop its animation clock.

The portrait estimates the tone of Cere's current English replies locally, using weighted phrases, negation, contrast, recent clauses and expressive punctuation. It excludes tools, code and quotations, fades old replies and resets when you switch conversations or send a new message. Short holds smooth changes during streaming. Ambiguous, unsupported-language and over-12,000-character replies stay neutral. This is a best-guess expression, not a reliable interpretation of sarcasm or proof of task success. **Respond to conversational tone** disables it independently of activity expressions. The portrait and full body consume one settled QML mood source, shared between UI and overlay hosts through attention updates. The existing 650 ms hold for competing non-neutral moods remains; body reactions occur at most once every six seconds. Busy activity, permissions, problems, disconnects and dragging take precedence, and blocked reactions are discarded rather than queued. The tone toggle governs both reactions and idle tinting. Conservative opening-phrase matching remains for user support and as a fallback if the shared QML source is unavailable; it never overrides a valid neutral classification. Mood-weighted selection favors matching gestures among the remaining bag entries (3:1) without duplicating entries or inventing task success. The generated portrait atlas is `assets/cere-portrait-expressions.png`; its built-in imagegen prompt is in `artwork/portrait-expressions-prompt.txt`.

Mood behavior is authored in `motions.json → bodyMoods`. Life multipliers below apply relative to the selected idle profile; unlisted channels stay unchanged. Preferred gestures bias order within the bag, not the total number of appearances across a complete bag.

| Mood | One-shot body reaction | Preferred idle gestures | Idle life multipliers |
| --- | --- | --- | --- |
| Neutral / ambiguous | None: no reliable cue | Normal pool | Unchanged |
| Curious | `curious` | `idleCurious`, `headTilt`, `surveyTurn` | Head ×1.15 |
| Thinking | `ponder` | `ponder`, `glassesAdjust` | Hands, sway ×0.8 |
| Happy | `buoyantBounce` | `buoyantBounce`, `heelRock`, `easySway` | Presence, sway, hands ×1.15 |
| Cheeky | `cheeky` | `idleSmug`, `explainSweep` | Head, hands ×1.1 |
| Skeptical | `skeptical` | `ponder`, `headTilt` | Sway, hands ×0.75 |
| Tender | `tender` | `idleSoft`, `attentiveRest`, `deepBreath` | Sway, hands ×0.65 |
| Concerned | `attentiveRest` | `attentiveRest`, `idleSoft`, `deepBreath` | Sway, hands ×0.55; head ×0.75 |
| Surprised | `doubleTake` | `lookAround`, `headTilt` | Head ×1.1 |
| Focused | `glassesAdjust` | `glassesAdjust`, `ponder`, `explainOpen` | Sway ×0.7; hands ×0.85 |
| Sleepy | `doze` | `deepBreath`, `idleSoft`, `attentiveRest` | Pace ×0.7; sway, head, hands ×0.6 |

Animation authoring is split into three small responsibilities:

- `assets/cere-rig.json` defines the atlas cutouts, parent joints, bind pivots, drawing order, channel limits/spring tuning and named stance presets. Its `articulation.arms` pairs each shoulder with its elbow and a mirrored `liftSign`; `foldLead` controls how far the elbow leads a lift and follows a lowering shoulder. Resting and conversational stances use relaxed supporting arms and asymmetry. The head and hair share no arm ancestors. A new limb or accessory is an explicit part attached to a bone.
- `assets/motions.json` defines gesture timing and intent: priorities, entry duration (`entryMs`), stance segments (`pose`, `ms`), interpolation duration (`easeMs`), per-key joint offsets (`rig`) and continuous `life` profiles. Optional `joints` override selected stance values without scaling them by intensity: `{"pose":27,"ms":300,"joints":{"leftHandOpen":0}}` keeps a closed hand throughout the lift. Frame families and `transitionRoutes` select intermediate stances. `eyesVisible:false` defers automatic blinks at occluded stances; the sampler also protects any clip authoring `eyeClose` or `wink`. `idleProfiles`, `microActing`, `blink` and `bodyMoods` own profile timing, weights, mappings and tuning. The shared mood owner moves the portrait's existing debounce/refresh timers; it adds no second animation or blink loop. For example, `{"pose":4,"ms":320,"phase":"greet","rig":{"leftElbow":12}}` holds the wave stance and adds a twelve-degree elbow sweep. Omitted offsets settle toward zero; pose angles keep their meaning at lower intensity.
- `qml/Motion.js` samples the choreography, attention, breathing and blinks, then smooths joint targets. Joint-specific quintic curves stagger elbow/shoulder travel, interrupted entries begin from the current joint values, and running counter-swings the arms. Conversational loops alternate gesture, release and rest instead of holding outstretched hands indefinitely. `native/avatarpuppet.cpp` only validates and renders the skeleton. New gestures normally need only JSON edits; new channel names are discovered from the rig.

Use **Settings → Motion & expressions** to inspect a gesture, and run `node --test tests/avatar-animation.test.ts` plus `ctest --test-dir build --output-on-failure` after authoring. These check catalog references, finite joint limits, interruption continuity, rigid transforms and real artwork on GPU/software renderers. `assets/cere-puppet-v2.png` is the production cutout sheet, refined with the built-in image generator against the original character reference. It restores full cargo trousers, large boots/gloves and loose off-shoulder sleeves; `artwork/puppet-silhouette-prompt.txt` preserves the edit prompts. The earlier cutout sheet and its initial prompt remain available as references. Original artwork and supplemental expression/inbetween sheets are retained as references.

**Settings → Personality** controls Cere’s voice in all managed Codex, Claude, and Ollama conversations. The default is a warm, sharp-tongued rogue; edit the multiline text and choose **Save personality** to replace it, or save an empty field for a neutral voice. **Restore default** fills the editor with the original text for review before saving. Changes persist across restarts and apply on the next turn, including existing conversations; running turns keep their current personality. Personality does not change permissions or project instructions. External linked terminals retain their own configuration until handed to Cere.

## Sessions, workflows, and companion tools

- **Ctrl+K** opens unified navigation for sessions, folders, projects, settings, saved actions, transcript matches, bookmarks, and decisions, with favorites and recent commands. **Ctrl+N** opens a conversation; **Ctrl+,** opens settings. Settings search and interface scaling work independently of pet size.
- **Sessions → New folder** creates an organizational folder. Rename it, move sessions between folders or back to Unfiled, pin, archive, and filter by working directory or unread status. Deleting a folder preserves its sessions. Folder membership never changes a project path, permissions, or memory scope.
- The composer supports reviewed file/image attachments with previews and individual removal, drag-and-drop, explicit clipboard import, revisioned draft recovery, quote-to-reply, and message bookmarks. Private attachment copies are removed once no draft, uncertain submission, or active turn needs them. **Context** shows attachments, destination, rough text usage, and recent memory evidence; native CLI history and filesystem access remain additional context Cere cannot fully measure.
- **Branch** creates a new conversation with selected, editable context. A separate Codex native-fork option requests an actual provider history fork and reports failure if unsupported; it never silently substitutes a text copy. Temporary conversations retain Cere transcript/drafts only in memory and exclude durable workflows, memory, and mobile access. They currently accept text only; external providers retain their own policies.
- **Project workflows** provides editable, revisioned capsules scoped to the exact project directory. Resuming creates an editable draft from the reviewed capsule. Four built-in recipes have typed inputs, pinned instructions, versioned definitions, exact previews, a one-turn limit and a 30–600 second deadline. Recipes do not grant access or send automatically. Substantial edits remain in the chosen editor.
- The result hub separates provider completion from verification, links observed artifacts and transcript evidence, and can run an explicitly reviewed saved check in the result’s project. Only its observed exit code establishes that check’s pass/fail; it does not certify the whole task.
- **Memory review** proposes decisions or constraints from a message with its supporting passage and source role visible. Confirm, correct, keep local, or discard the proposal. Existing inspector correction/forgetting controls remain available inline, including **Why was this recalled?**.
- Local push-to-talk records at most 60 seconds into a private temporary file and uses a user-configured local transcription executable/model. The transcript enters an editable review before the composer; there is no always-listening mode or automatic model download. Speech supports selected-text playback, rate adjustment, and an optional brief reading that preserves the full written response.
- **Offline tools** provides notes, tasks, arithmetic, conversions, and pause/resume/repeating timers. Reviewed workspace routines use exact previews; undo is offered only for created timers. Focus, Gaming, and Presentation profiles combine visibility, speech, animation and ordinary notification preferences while retaining approval access. Home positions are per monitor; edge docking is explicit.
- **Health and recovery** distinguishes provider/authentication/protocol/network, memory, and speech problems. Diagnostics use an allowlist and must be previewed before export. Reviewed backups exclude credentials, device keys, active grants, executable actions and temporary conversations by default. Restore preserves the current forgetting registry, pauses tools, marks restored sessions interrupted, and never replays a turn. If forgetting records differ, old conversation/draft/attachment/notes payloads are omitted conservatively. Restoration stages a new profile and restarts the broker; the previous private profile is retained.

## AntiGravity and direct APIs

**New session** offers **AntiGravity**, **OpenAI API**, **Claude API**, and **Google AI API** alongside Codex, Claude Code, and Ollama. They also appear in reviewed handoffs and branches. These four integrations currently execute on the desktop; mobile can read their conversations but cannot start or send their turns.

- **AntiGravity:** install the `agy` CLI and sign in interactively once. Cere discovers models with `agy models`, streams replies and tool activity, and resumes the conversation by its own ID. `CERE_ANTIGRAVITY_BIN` overrides the executable. Headless actions requiring approval are soft-denied by the CLI unless allowed in its settings or Cere's CLI permission bypass is enabled. Cere does not change global AntiGravity configuration. Text attachments are supported; image input and interactive permission questions are unavailable in this adapter.
  Model IDs ending in an effort, such as `gemini-3.1-pro-high`, already select that effort. Use **Provider default** or the matching effort under **Model**; conflicting saved selections are rejected before dispatch. Provider failures include the CLI's error details.
- **API providers:** add a key in **Settings → Connections**, then connect to load the account's models. Select a model or enter an explicit model ID when creating a session. Standard broker environment variables also work: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). Saved keys take precedence; removing one restores any environment key. Keys are stored in an owner-only file under Cere's state directory, separate from SQLite, snapshots and reviewed backups. Replacing or removing a key stops its active API turns. API usage is billed by the provider, separately from chat subscriptions.
- APIs support streaming, local conversation history, image/text attachments, optional desktop tools and Codex/Claude delegation, web search, and shared memory under the existing cloud-sharing setting. Tool availability also depends on the selected model. Requests use each provider's native API and do not follow redirects or automatically retry ambiguous failures. OpenAI responses use `store:false`. Cere keeps a bounded working context; API models without advertised context limits use a conservative 32,768-token budget. Model reasoning settings use provider defaults.

OpenAI, Claude API, Google AI API and Ollama requests automatically retry HTTP **429, 500, 502, 503 and 504** up to three times, waiting 1, 2 and 4 seconds plus up to 25% random jitter. `Retry-After` is honored within the request deadline and a 60-second maximum wait; a longer server requirement fails without retrying early. Other statuses, including 400/401/403/404, fail immediately. Transport failures with uncertain outcomes and streams that have already started are never replayed. **Stop** cancels pending waits. Broker retry logs contain the status, retry count and delay; cloud API conversations also show retry progress in activity. The reusable `withHttpRetry` wrapper lives in `broker/http-retry.ts`.

Use **Model** below the conversation composer to choose a model for your next message. This works within the current provider for Codex, Claude Code, AntiGravity, the three cloud APIs, and Ollama. Wait for the current response or press **Stop** first. The conversation, draft, attachments and CLI conversation ID stay in place; other sessions and defaults are unaffected. CLI reasoning options follow the selected model. API conversations also accept a custom model ID when the catalog is unavailable; changing models keeps readable history and recorded tool results while discarding model-specific reasoning/signatures from the working context. The new API model must support the images and tools you use. Mobile model changes remain limited to Ollama.

Protocol references: [AntiGravity headless mode](https://www.antigravity.google/docs/cli/headless/), [OpenAI Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses), [Claude Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), and [Google GenerateContent](https://ai.google.dev/api/generate-content). AntiGravity receives recalled memory context when cloud sharing is enabled; Cere's automatic MCP tool installation remains specific to Codex and Claude Code.

## Ollama

Run an Ollama server, then open **Settings → Connections**. The default address is `http://127.0.0.1:11434`; **Connect** accepts another HTTP(S) server or reverse-proxy base URL. **Refresh** reloads its chat models. Choose a **Default model for new conversations**, or select a model when opening each session. Pull models with Ollama itself; Cere does not download or delete models automatically. Embedding-only models are excluded and cloud-backed models are labeled **Cloud**. Cloud authentication stays with your Ollama server.

Choose **Ollama** in a new session for streaming conversation. The project folder is optional in conversation mode. The **Model** button changes an idle conversation’s model or enables assistance; existing context is retained. Defaults affect new sessions, and each session keeps its server address even if the connection setting changes. Image-capable models accept explicitly attached PNG, JPEG and WebP files (10 MB each, 20 MB combined, up to four). Thinking uses the model’s defaults and is retained in provider context without cluttering the transcript.

For orchestration, select a model marked **Tools**, enable **desktop tools and delegation**, and trust the project folder. Under **Settings → AI assistance**, enable the categories you want:

- **Provider orchestration** lets Ollama start Codex or Claude tasks in the same project, send follow-ups, wait for and read results, and stop its delegated sessions. Unless a project power session grants CLI access, each task or follow-up asks you to review the exact prompt and provider first, including under Broad control. Delegated sessions appear in Sessions and retain their provider’s own approvals. Ollama can manage only sessions it created.
- **Saved scripts** lets it list and run explicitly configured executables with their saved arguments, including other CLIs. Execution follows the same approval and grant rules as Cere’s existing script controls.
- Desktop categories allow application/window discovery, desktop actions, media and volume controls, timers, and approved captures. Captures require a separate sharing approval before an image-capable model receives the image, unless that session has active computer-control power access.

**Stop** cancels the Ollama request and active delegated turns started during that turn. Turning off assistance categories or pausing AI actions prevents further tool execution. Tool loops stop after 24 model responses (up to 16 requested tools per response), and a stalled HTTP request times out after three minutes. On broker restart, incomplete turns stay interrupted; unresolved tool calls are recorded as having an unknown outcome and are never replayed automatically.

Cere uses Ollama’s [native chat API](https://docs.ollama.com/api/chat) and [streaming tool protocol](https://docs.ollama.com/capabilities/streaming). Conversation content and approved attachments go to the configured server; **Cloud** models are processed through Ollama Cloud. `CERE_OLLAMA_HOST`, then `OLLAMA_HOST`, supplies the initial address when no connection has been saved. Existing installations gain these settings without a database migration.

## Web search

Enable **Settings → Web search** for Ollama conversations. It works in Conversation mode and Assistant mode without desktop permissions. Models with native tool support receive `web_search` and `web_read` and are instructed to use them when asked, for current facts, or when their knowledge is uncertain. Tool use still depends on the model. Check **Search web** beside the message box (**Web** in compact windows) to search first with any chat model, including models without tool support. This sends your next message as a public query, up to 500 characters; the choice resets after sending.

Choose **DuckDuckGo**, **Brave**, **Mojeek**, or **SearXNG**. The first three read public search pages without an account or API key. **Automatic** tries DuckDuckGo first, then Brave and Mojeek on failure or unusable results, and reports fallback. Selecting an individual provider keeps queries with it. For SearXNG, enter its base URL and enable `json` in its `search.formats`. Cere uses only that instance; it does not choose a random public server. Search starts disabled.

Replies include clickable source buttons; the Activity Panel shows queries, results, and errors. Public providers sometimes return CAPTCHA pages or rate limits; Cere reports these failures instead of treating a blocked page as evidence. The reader accepts public HTTP(S) HTML/text, strips scripts and navigation, and bounds page size and returned text. It checks resolved addresses and every redirect, refusing private, loopback, link-local, shared, multicast, reserved, documentation and benchmarking IPv4 ranges. It also refuses the IANA protocol-assignment block 192.0.0.0/24, including its anycast services, and the deprecated 6to4 relay range 192.88.99.0/24; the rest of 192.0.0.0/16 is public. IPv6 is limited to global unicast outside the special-purpose, 6to4 and documentation ranges. The explicitly configured SearXNG endpoint can be local. Reading a source contacts its website. Stop cancels research, and pausing AI actions or disabling search prevents further tool use. Research is limited to eight tool calls per turn. Pages and snippets are untrusted reference material.

## Shared project memory

Graph memory is integrated into the broker and native inspector. **It remains experimental:** the full reference design’s release criteria have not all passed. See [implementation status](docs/memory/implementation-report.md) and [evaluation results](docs/memory/evaluation.md) for measured results and remaining work.

Enable **Settings → Memory → Remember and recall conversations**. Memory starts disabled. The extraction model is **`gpt-oss:20b-cloud`**; the default embedding model is **`nomic-embed-text`**. Both must already be registered with the configured Ollama server. Cere does not download models automatically. Cloud-backed embedding models are refused, so memory text is never sent to a cloud-backed model for embedding. Cloud extraction and sharing recalled memory with a cloud chat model are separate settings: cloud extraction is configured for the selected model, while cloud recall starts disabled. Sources marked local-only cannot be dispatched to cloud extraction.

Managed Codex, Claude and Ollama conversations share the same memories for the same project and memory server. Codex and Claude use the Ollama server selected in **Connections** for embeddings; existing Ollama conversations retain their saved server. Enable **Share recalled memory with Codex, Claude and cloud models** to supply recalled context to these providers. Cere supplies bounded context before each turn and records completed replies with their source roles. Native providers also receive the shared memory tools through Cere's session-scoped MCP connection. Standalone CLI sessions outside Cere do not automatically receive this connection. Existing project/server scope keys are preserved; changing providers does not copy or migrate the data.

Canonical observations, exact source witnesses, entities, typed assertions, correction history, episodes, and erasure records live in private SQLite at `$XDG_STATE_HOME/cere/graph-memory/memory.sqlite`. Neo4j and Qdrant are rebuildable local projections. Their pointers are checked against canonical scope, time, revision, policy, and erasure state before text is recalled. See [operations](docs/memory/operations.md) for authenticated dependency setup, Fish integration, backup, restoration, and reindexing.

**Manage project memory** opens saved notes and conversation passages for the selected conversation’s project folder and Ollama server. The **Graph, evidence and workspace inspector** adds temporal queries, provenance, structured corrections, conflicts, collector policy, indexing status, and forgetting progress. Structured corrections require an exact source quotation and the inspected revision. Uncertain effective dates remain candidates for review. Identity decisions (same, not the same, possible) are recorded and reversible, but they do not yet merge or split entities. Model text alone cannot establish that an action succeeded.

Writes commit before embedding, so saved decisions are available to lexical recall even while indexing is unavailable. Retrieval degrades with explicit coverage when a model or projection is down. Memory enters the prompt as delimited untrusted data, with separate records of evidence supplied to the model and evidence actually cited. Recent chat context still uses a bounded prompt window with complete tool request/result pairs.

Forgetting suppresses use immediately, scrubs matching passages from Cere’s managed conversation history, and reports physical deletion separately while projection acknowledgements are pending. Keep the current external erasure registry when restoring any backup; an older backup alone must not resurrect forgotten content. External provider histories and copies exported outside Cere are not managed by this workflow. Disabling memory stops normal capture and recall without deleting retained records.

Architecture, configuration boundaries, and pinned versions are documented in [architecture](docs/memory/architecture.md), [policy](docs/memory/policy.md), and [versions](docs/memory/versions.md).

## Permissions and persistence

Desktop AI categories start disabled. Scoped assistance enables chosen categories and asks before sensitive tools. Broad control is optional and requires project-specific, expiring grants. Pause and revoke remain available. Cere’s grants govern its own MCP tools; they do not sandbox unrelated shell access already granted to a CLI.

**Permissions** opens a single center for effective access, provider state, project grants, expiry, revocation, and separate controls for pausing Cere actions and stopping provider work. Legacy global bypass settings are disabled at startup and cannot be enabled again.

**Power sessions** deliberately grant CLI full access, computer control, or both to selected idle, locally managed sessions in one canonical project directory. Leases last 1–120 minutes, remain visible, are never persisted, and must be renewed deliberately. Temporary, remote, and linked sessions cannot start one. Enabling power does not accept existing pending requests; questions always require answers. Ending or expiring a lease revokes new authority immediately and stops owned provider work, reporting confirmed or unconfirmed termination. Linked terminals use their ordinary permission configuration.

CLI full access can control the desktop through shell commands. Cere’s desktop permission categories do not contain unrestricted CLI processes. **Pause Cere actions** blocks Cere tools; **Stop provider** interrupts provider work. External provider or administrator restrictions still apply. Editing a saved executable invalidates review of its previous definition.

Markdown renders during streaming and when stored sessions reopen. Message Copy preserves the original Markdown; text selection copies the rendered text. Links open only on activation, and file links resolve against the session’s project directory. Tool output remains literal text. Wide tables can scroll horizontally.

Provider approvals remain separate from Cere’s desktop approvals. Unknown provider requests fail closed with an explanation. MCP forms support strings, booleans, numbers, integers, and multiple selections from string lists, including optional fields. URL requests show the destination and require explicit browser opening and confirmation. Other complex forms are declined with an explanation. The adapters are checked against the [Codex app-server protocol](https://developers.openai.com/codex/app-server/) and [Claude Agent SDK events and input](https://platform.claude.com/docs/en/agent-sdk/typescript). CLI versions used for schema validation: Codex 0.158.0 and Claude Code 2.1.284. Authentication and billing remain with each CLI.

State is stored in `$XDG_STATE_HOME/cere/cere.sqlite` (normally `~/.local/state/cere`), using private filesystem permissions. It includes settings, drafts, conversation messages, recent action metadata, and timers. Screenshots live in the sibling `captures` directory. Codex and Claude transcripts remain in their native locations. Ollama’s full conversation context, tool results, and explicitly shared images are stored in Cere’s private database. Enabled graph memory also publishes eligible projections to the configured local Neo4j and Qdrant services; selected cloud extraction uses Ollama Cloud.

Cere IPC uses a private Unix socket at `$XDG_RUNTIME_DIR/cere/broker.sock`; enabled Fish collection uses `$XDG_RUNTIME_DIR/cere-memory/memory.sock`. Connections require the same OS user. Cere opens no TCP listener by default. The optional Android companion gateway listens only on explicitly selected LAN/WireGuard addresses after local offline pairing; see [mobile setup](docs/mobile/SETUP.md) and [implementation limits](docs/mobile/TESTING.md). Configured Ollama and memory dependencies use HTTP(S) or Bolt, with the packaged database ports restricted to loopback. MCP subprocesses receive session-scoped random capability tokens. A UI restart leaves broker work running. A broker restart marks incomplete turns interrupted and never silently replays them. Restart the installed broker with `systemctl --user restart cere-broker` only when you intend to interrupt its active work.

For isolated development, set `CERE_STATE_DIR` and `CERE_RUNTIME_DIR`. Set `CERE_CODEX_BIN` or `CERE_CLAUDE_BIN` to an executable path when testing a different provider build. Managed conversations, provider detection, model catalogs and Codex history import all use that executable; `cere terminal` still runs the CLI found on `PATH`.

## Validation

```sh
npm test
npm run typecheck
npm run build
./build/cere-motion-check
QT_QPA_PLATFORM=offscreen ./build/cere-avatar-check "$PWD"
QT_QUICK_CONTROLS_STYLE=Basic ./build/cere-ui-check
node --test tests/portrait-mood.test.ts tests/portrait-state.test.ts
QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software /usr/lib/qt6/bin/qmltestrunner -input tests/qml -import qml
```

For the locally extracted dependencies, prefix the UI test with `LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib" QT_PLUGIN_PATH="$PWD/.local-deps/usr/lib/qt6/plugins"`. Native tests briefly open isolated test windows and write screenshots to `/tmp/cere-ui-evidence`.

`tools/live-check.ts` runs real provider calls in a temporary project, including a named harmless printf script, approval, another turn, and a process disconnect/resume. It consumes normal CLI usage. Run it only with isolated `CERE_STATE_DIR` and `CERE_RUNTIME_DIR` values. `tools/probe-providers.ts` is a smaller no-tool connectivity check.

`node tools/check-ollama.ts MODEL [codex|claude]` exercises real Ollama conversation, recall after disconnect, an approved saved `printf` command, and optional provider delegation. It creates its own isolated broker/project, uses normal provider usage, and prints the evidence directory containing `report.json`, `broker.log`, and the test database. Only the known test command and exact test delegation are approved. Backend tests and native UI checks use local Ollama fixtures with no inference usage.

Re-extracting the legacy atlas requires the original combined animation, `all-states.gif`, which is not distributed with this repository. Supply an authorized copy with `python tools/prepare-assets.py --input PATH` (Pillow). Without it the command stops before writing anything, and `--check` verifies a supplied file against `assets/animations.json` without writing. The current artwork is rebuilt with `python tools/clean-artwork.py` (Pillow and NumPy), using `artwork/cere-clean-white.png`. This removes the exterior white matte, preserves enclosed eye highlights, and packs equal cells with transparent gutters. It also retains a legacy full-body icon preview. Desktop branding uses the separate `assets/cere-emblem.png` head emblem for the tray and window icon; the build generates transparent launcher icons from 16 to 512 pixels with `tools/prepare-icons.mjs`. The emblem’s built-in imagegen prompt is in `artwork/emblem-prompt.txt`. Neither artwork command modifies its source artwork or the head emblem. Artwork prompts are recorded in `assets/artwork-prompts.txt`; gesture timing and transforms are in `assets/motions.json`.

`node tools/check-knowledge.ts [MODEL]` checks real `nomic-embed-text` recall, restart persistence, public search, and source reading in a temporary project. Supplying a model also tests native search/memory tools and the use of recalled context, with synthetic facts only. `MODEL --memory-only` or `MODEL --web-only` repeats just that model tool check. The script prints its private evidence directory. `build/cere-ui-check searchAndMemory` exercises settings, the embedding check, memory editing, explicit search with a plain chat model, and source links against local fixtures. Production HTML-parser dependencies are bundled with installed Cere.

See `VALIDATION.md` for the checks performed on this machine and the remaining platform coverage limits.
