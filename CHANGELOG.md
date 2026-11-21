# Changelog

Notable changes to Cere, the desktop application and its broker, and to Cere Mobile, its Android companion. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The desktop version is set in `package.json` and the phone's in `mobile/android/app/build.gradle.kts`. Phone builds are released under `mobile-vX.Y.Z` tags, whose GitHub release notes come from [docs/mobile/RELEASE-NOTES.md](docs/mobile/RELEASE-NOTES.md); [docs/mobile/RELEASES.md](docs/mobile/RELEASES.md) describes that process.

## [Unreleased]

Fixes from the Cere Mobile compatibility audit (`Cere_Mobile_APK_Desktop_Compatibility_Audit_and_Handoff.md`, findings MOB-001–MOB-008) and simpler pairing. The phone side is published as the Cere Mobile 0.1.4 development snapshot (`mobile-dev-v0.1.4`); its validation is recorded in [docs/mobile/TESTING.md](docs/mobile/TESTING.md). Phones need the desktop broker from this source for the new behaviour.

### Added

- **Pairing without copying.** Desktop Settings → Cere Mobile lists this computer's Tailscale and local-network addresses and the projects Cere knows, offers grant presets, and shows the pairing QR. The phone sends its signed answer back to the PC by itself, the PC shows the six words, and confirming there finishes the phone. For the QR's five minutes the gateway listens and accepts only that offer's answer; two different answers cancel it. Copying or sharing the answer remains as a fallback.
- **Connection details** on the phone: the connected or last-seen desktop build, protocol, app version and channel, last synchronization, and a copyable summary without keys, addresses, IDs or messages.
- **Typed API model IDs** on the phone, for new conversations, settings and handoffs; an endpoint without a model list is shown as such.
- `tools/mobile-upgrade-check.ts` (in-place update from a previous development snapshot) and `tools/mobile-ui-pairing-check.ts` (an R8 build paired through its own screen); `tools/mobile-paired-check.ts --pairing network`; `tools/mobile-release.ts` accepts `mobile-dev-vX.Y.Z` and writes `mobile-development.json`.

### Changed

- **Named compatible connections and phones (MOB-001).** A conversation is authorized against its own connection's origin and key, before every provider request; a conversation on a saved connection the phone isn't granted can be read but not sent to, configured or listed. A compatible grant can name a chosen saved connection.
- **Desktop tools for API conversations (MOB-003).** The phone sees the stored choice; changing only the model keeps it; compatible endpoints follow their declared tool support.
- **Files, Images and Analysis under phone control (MOB-005).** Continuing such a conversation from the phone first names what pauses; the desktop keeps the selection and restores it when it detaches the phone. Their results appear on the phone as cards to view on the desktop.
- The phone's "Desktop confirmed" step for manual pairing now checks with the desktop before saving the pairing.
- CI retries only plugin resolution before the mobile gates (MOB-007); the paired API 35 job pairs by network return.

### Fixed

- Conversation settings on the phone failed for conversations without a style (MOB-002).
- A newly staged phone pairing could lose its keys, leaving "Phone pairing keys are missing" after the desktop confirmed.
- `tools/mobile-release.ts` rejected APKs whose minimum SDK aapt2 reports as `minSdkVersion`.

## [0.1.1] - 2026-11-20

The Workbench: files, images and analysis for Ollama and API conversations, built from `Cere_Workbench_Files_Images_and_API_Expansion_Handoff.md`. The user guide is [docs/WORKBENCH.md](docs/WORKBENCH.md), and [VALIDATION.md](VALIDATION.md) records its checks. This release also carries the work listed below, which was previously unreleased.

Repository remediation adds revision-safe policy commits, cancellable turn preparation, consent-bound private context, journaled collection ingestion, complete bounded operation review, process-group cleanup, byte-bounded desktop hydration, and Android stale-response fencing. Zod is pinned to 4.6.7. See [implementation and remaining gates](docs/remediation-2026-11-17.md); exhaustive audit and release validation are not complete.

The desktop and mobile review, implemented in October 2026 as work packages W01–W16. Finding IDs F01–F18 are the review's; [docs/REVIEW-VALIDATION.md](docs/REVIEW-VALIDATION.md) records the commit, tests and evidence for each, and [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) shows what the phone and the desktop each offer. The phone build from this source has not been published; a stable phone release still needs the device gates in [docs/mobile/TESTING.md](docs/mobile/TESTING.md).

### Added

- **Workbench.** Files, Preview, Changes, Images, Runs and Shelf tabs beside the conversation (**Ctrl+Shift+W**). In the compact panel they appear as one sheet. **Files**, **Images** and **Analysis** switches decide what the model is offered; you can always use the Workbench yourself. Temporary and phone-controlled conversations stay text-only.
- **Workspace folders and reviewed changes.** Each conversation can have up to 8 folders with their own permissions and processing destinations. A confined helper (`cere-workspacefs`) refuses `..`, symlinks and paths outside the folder. Browse, search, preview and edit files. Changes are applied only after review, with per-operation results, version checks, a private trash, and an undo that never overwrites a newer edit. Edit permissions can be granted for a set time.
- **Conversation files.** Imports, images, extractions and run outputs are kept as immutable, hashed versions with provenance, thumbnails, pins, project sharing and reviewed exports. Documents are extracted with locations: PDF pages, DOCX paragraphs and tables, XLSX cells, CSV, JSON, XML and HTML. Macros never run and links are never fetched. Recordings transcribed from a file also keep a timestamped WebVTT transcript.
- **Images.** Generation and edits through OpenAI, Google and your own ComfyUI server, as durable jobs. Billing must be acknowledged, and daily budgets apply. A job whose outcome is unknown is never resubmitted. An editor offers crop, annotations, masks, comparison, resize, format conversion, and versions that never change the original. A vision helper, local OCR with Tesseract, and a review helper for narrow document, change-set and research reviews are also available.
- **Code Lab, commands and Git.** Python runs isolated with bubblewrap, without network, on read-only inputs; its outputs become conversation files. Commands in a folder always ask. Git inspection is read-only. The Runs tab shows which limits are enforced on this computer.
- **References with @.** The composer's `@` picker references files, folders, conversation files, project shares, collections and other conversations in the project. Each reference is resolved and authorized at send time, with a preview line before sending. Referenced content travels apart from your words, so a later model that may not receive it loses the content but keeps your message.
- **Project shelf and Workbench recipes.** The Shelf lists what the project has collected. Eight new recipes take typed folder, file, artifact and collection inputs: Explain this project, Review configuration change, Folder cleanup plan, Document briefing, Image asset kit, Screenshot to issue report, Data to report, and Release materials.
- **Saved connections.** More Ollama hosts and OpenAI-compatible endpoints can be kept under names. Each conversation stays on its connection; moving one asks you to confirm the new destination. Per-conversation model controls cover temperature, maximum reply, context window and keep-alive.
- **HTTP tool servers.** MCP servers can be reached over Streamable HTTP, with an origin-bound bearer token and an address policy. Resources and prompt templates are browsed by the user. Image results from tools become conversation files.

- **Mobile protocol 1.1.** The desktop's welcome names the protocol (1.1), the features it offers and its exact build (version, commit and whether the source was modified). The phone uses a new option only when the desktop offers its feature, so with an older desktop those options stay hidden; a version mismatch says which side to update, and drafts stay on the phone. Response and event frames recorded from a real gateway are decoded by the Android tests, and `node tools/mobile-contract.ts --check` fails when `protocol/mobile/v1/CONTRACT.json` leaves out an operation or feature (F17).
- **Screen capture from the phone.** With Desktop control and the capture category, the phone's Desktop tab starts a capture of the desktop display (**Capture now**, or **Capture and edit on the desktop** to finish it in Satty there), previews a reduced copy and attaches exactly that image to one conversation. Nothing reaches a provider until the message is sent.
- **Desktop draft attachments on the phone.** An open conversation lists its desktop draft's attachments by name, kind, size and digest, never a path. The phone previews a text file's opening or a reduced image, keeps or removes each attachment explicitly and sends them exactly as reviewed; an attachment that changed or was not reviewed is refused.
- **Memory for every provider on the phone (F09).** Project memory follows the conversation's project on its granted memory server for Codex, Claude Code, Ollama and API conversations alike, as on the desktop. The phone adds assertion history, corrections, conflict resolution, identity decisions and episode freezing, each revision-bound and witnessed by your own statement, and a memory health line that says when recall may be incomplete while chat keeps working.
- **Pinned replies.** Star a reply on the phone to pin it. Pins are the desktop's bookmarks, and **Pinned replies** lists them across the conversations the phone can see.
- **Style and results views.** A conversation's settings on the phone show which style it uses and whether that is set for the conversation, its project or everywhere, and list its results and schedules, keeping the provider's report apart from Cere's own verification. The phone can pause a schedule, nothing more.
- **Status portrait.** The phone's header shows the desktop avatar's still portrait with the expression for the conversation's state, such as thinking, waiting for you, interrupted or reconnecting. **Settings → On this phone → Show the assistant's portrait** turns it off on that phone.
- **Workspace card and missing desktop programs.** The phone's Desktop tab shows whether the desktop is working in this project right now, from fresh workspace observations while workspace telemetry and memory are on. An **Unavailable on the desktop** panel names the desktop programs that are missing for the controls the phone may use.
- **Open on desktop.** A linked terminal conversation offers **Open on desktop**, which brings its terminal window forward on the desktop (Desktop control with the windows category).
- **Claude Code history import from the phone.** **Import desktop history** offers stopped Claude Code conversations as well as Codex ones; an imported Claude conversation continues in Claude's restricted mode.
- **Hosted APIs from the phone (F10).** OpenAI API, Claude API, Google AI API and the compatible endpoint run from a phone that holds `providers.api` and that provider's grant (desktop **Settings → Cere Mobile**). Requests use the desktop's keys and may be billed. A compatible endpoint is granted by its origin, so changing it needs a new grant. AntiGravity turns still start only on the desktop, and the phone says why.
- **Feature matrix.** [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) lists every desktop surface and the mobile plan's rows F01–F98 with the phone's status and the reason for anything that stays on the desktop, plus an operation index generated from the gateway. `tests/feature-matrix.test.ts` keeps it in step with the code.
- **Conversation states and the services gate.** [docs/CONVERSATION-STATES.md](docs/CONVERSATION-STATES.md) defines the states, outcomes and activity words both clients use, and [docs/SERVICES-GATE.md](docs/SERVICES-GATE.md) lists the check behind each secondary desktop service.
- **Health additions.** Health names missing desktop programs and the feature each one affects (**Unavailable until installed**), and says when the previous stop could not confirm that everything Cere was running had finished.
- **Checks for installs and providers.** `node tools/check-install.ts DIR [commit]` checks a staged install against its source. `node tools/check-codex-protocol.ts` and `node tools/check-claude-protocol.ts` check the installed CLIs' methods, flags and handshake without a billed turn. `node tools/mobile-paired-check.ts` pairs an emulator or device with an isolated broker and fails unless every paired test passes.

### Changed

- Backups with content include conversation files and verify their hashes on restore. Folder access, pending changes, runs and grants are never restored. Restores keep this computer's image-backend keys, usage records and saved connections. Forgetting a memory also removes conversation files whose text holds it.
- The Settings Ollama host and compatible endpoint become default named connections, migrated once without moving any key.
- Schedules for conversations that use the Workbench also check its folders, policies, image backends and Code Lab. Any change pauses the schedule.
- The broker identifies itself to Codex, Claude and MCP servers with the version from `package.json`.
- Every avatar's portrait and surface atlases were regenerated with two consistency passes. The first keeps painted details registered to the neutral illustration as the head turns and the arms and legs move (`tools/avatar-appearance.h`). The second keeps expression changes within the face (`tools/portrait-consistency.mjs`).
- New dependency: `@modelcontextprotocol/sdk` 1.32.2, pinned and loaded only for HTTP tool servers. The package lists the Workbench's optional system packages (bubblewrap, ripgrep, poppler, tesseract, numpy, matplotlib).

- **Providers are described in one place.** `broker/provider-catalog.ts` holds each provider's traits (models, effort, images, tools, web search, history import, queueing, billing and how a turn from a phone runs). The desktop and the phone build their controls and explanations from it, in the order the broker sends.
- **Faster avatar startup (F13).** The interface checks the avatar catalog from each atlas's PNG header instead of decoding all twenty atlases at startup. Offscreen on the development machine, building the interface's controller (catalog, avatars and themes) took 8.4–10.0 s with a 783 MiB memory peak before, and 9–13 ms with 42 MiB after. The shown avatar is decoded when it is displayed; artwork that then fails is set aside only after a full load confirms the failure, the next usable avatar is shown with a notice, and chat is unaffected.
- **Ordered, bounded broker shutdown (F02).** On stop, the broker refuses new local and phone changes, lets the phone gateway finish the operations it is running, then stops providers, workers, memory and speech and closes its database last, within ten seconds. The result is saved in `last-shutdown.json`, so a stop that could not confirm its work is never reported as clean.
- **Shared conversation semantics.** Both clients use the same conversation states, outcome words and activity labels, and an approval answered on either one retires exactly once.
- **Phone browsing beyond page limits (F07, F08).** Activity loads older pages, search continues past its first page and names every match, and session loading no longer stops silently after 40 pages. Replies show their sources, and the desktop's **Show memory citations in replies** setting applies to the phone's display and copy.
- **Phone robustness (F06, F11, F12).** The phone bounds inbound frames before keeping them, checks that each screen's read still belongs to the same desktop connection and transcript, makes saves durable and image writes atomic, and reports cache failures. A send that is confirmed late clears only its own text. Losing a network that does not carry the connection no longer ends it.
- **Node 24.22.0 is the minimum** (was 24), the oldest release the full suite was run on (`package.json`, the Arch package). CI pins 26.8.2.
- **Meaningful CI (F01, F14).** `desktop-check` runs the broker, native and interface jobs separately behind one final gate, runs build and test steps as an unprivileged user, uploads reports even when a step fails and lists every skipped test with its reason. `mobile-check` adds a paired job on API 30 and 35 that runs the paired-desktop tests against an isolated broker and fails unless every checkpoint passes; the emulator job alone skipped them.
- **Evidence-gated phone signing (F18).** The release workflow signs only an APK certified by a committed record, `docs/mobile/release-evidence/mobile-vX.Y.Z.json`: the unsigned APK's SHA-256, the signer, the tested commit (later commits may only add records), the desktop build, the device and OS, the tester, a test date at most 45 days old and every required gate. It also checks 16 KiB page alignment, and `mobile-release.json` names the protocol, the source commit and the evidence record.

### Fixed

- **F01:** the backup-denial test failed in CI's root container, which ignores permission bits; it now skips there with its reason, and the failure paths use faults that hold for any user.
- **F02:** test cleanup could close Core before a replacement phone gateway. Gateway close is now idempotent and lets its running operations settle before Core closes, and Core keeps its database open until running changes finish.
- **F03:** delivery to slow desktop interface clients could exceed its memory budget. It is now bounded per client and overall; a client that falls behind receives one `resync` event, or is closed, instead of an unbounded queue.
- **F04:** background indexing left an abort listener behind after each wait for foreground work.
- **F05:** a broker that stayed connected but stopped answering left controls pending indefinitely. The interface now pings the broker every 5 seconds and shows **Cere is not responding** after 15 seconds without an answer: pending requests end once with an explanation and are never resent, drafts stay, and the interface recovers when the broker answers again. Every request also has a 30-minute deadline.
- A Hyprland window action reported "window not found" as success; dispatch now requires Hyprland's `ok`.
- A pinned conversation read replies to phone-started turns aloud on the desktop.
- Restoring a backup could wait 30 seconds for an asynchronous SQLite backup under load; restore staging now uses `VACUUM INTO`.
- Claude Code was described as having no history import although the desktop imports it.

### Removed

- The `MOBILE_HARDWARE_GATES` release variable. Its mutable `passed` value could certify new code; the evidence record replaces it.

### Security

- Agents and approvals name agents by opaque HMAC references instead of native thread IDs (F17).
- A phone's grant for the compatible endpoint is bound to the granted origin, and provider keys never leave the desktop.
- Desktop draft attachments reach the phone as name, kind, size and digest only; their content is shown on request and sent only as reviewed.
- The workspace card, memory health and the list of missing programs leave out window titles, commands, paths outside the project, endpoints, model names and error text.

### Known limitations

- The Workbench's live OpenAI, Google and ComfyUI image paths and its API chat turns were verified with fixtures only; they were not run against the billed services. Small local models need the focused `files_replace_text` tool to make edits.
- Tool servers that need an OAuth sign-in are not supported; use a bearer token. Interactive HTML previews need an optional isolated module that is not included, so HTML files show their source.
- Budgets cover images per day only. There are no call, token or concurrency budgets and no price estimates.

- Device-only gates have not run: biometrics, network moves, desktop sleep and Doze, notifications, TalkBack and large text, camera and picker uploads, behavior without Google Play services, and the upgrade from the published 0.1.3 development build. Process-death fault injection on a device is not built.
- Memory remains experimental (F16): predicate precision is 88.9% against a 95% gate, and a representative evaluation is still needed.
- Phone-side capture cropping and annotation, and identity merge and split, are not built.
