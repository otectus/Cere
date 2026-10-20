# Cere desktop and phone feature matrix

Reconciled against source on 2026-10-20 (branch `ui-overhaul`, protocol `cere.mobile.v1` 1.1). Source is the authority: when this file and the code disagree, the code is right and this file is out of date. `tests/feature-matrix.test.ts` checks that every phone operation in `broker/remote/schemas.ts` is listed in the operation index below with its permission, that every F01–F98 row of `mobile/MOBILE_PLAN.md` appears exactly once, and that every test file named here exists.

**Status vocabulary.** *Both*: the same broker operation and semantics on desktop and phone. *Phone adapted*: the same capability with phone-specific presentation. *Phone read*: the phone reads; changes stay on the desktop for the stated reason. *Desktop only*: a deliberate local-administration boundary, with its reason. *Withheld*: the capability exists but is not offered to a phone until the stated condition holds. *Not built*: planned, not implemented; the next action names the work.

**Permissions** are the per-phone grants the desktop issues at pairing (`chat.read`, `chat.write`, `providers.execute`, `providers.api`, `approvals.answer`, `approvals.provider`, `attachments.write`, `capture.preview`, `desktop.control`, `settings.write`, `memory.read`, `memory.write`, `web`) intersected with the desktop's own categories (apps, files, windows, audio, media, timers, capture, scripts, providers). A phone's turn runs under `ordinarySettings` (`broker/execution.ts`): desktop bypasses never apply to it.

**State and revisions.** Sessions carry `revision` (metadata), `draftRevision` (text and attachments) and `configRevision` (provider/model/effort/tools); messages carry `revision`; settings carry `settingsRevision`; memory records carry their graph revision; schedules carry `revision`. A phone mutation names the revision it reviewed and is refused with `REVISION_CONFLICT` when it changed. Signed mutations are bound to their exact parameters and command ID (`broker/remote/server.ts`); an unknown outcome is never replayed (`CommandOutcomes.kt`).

## 1. Product surfaces

| Surface | Desktop entry | Phone entry | Broker operations | Permission | State / revision | Tests | Status | Limitation and next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chat, streaming, Stop | `qml/Chat.qml` composer, Stop | Chat screen composer, Stop | `sessions.send`, `sessions.stop`, `sessions.messages`, `message.upsert` events | `chat.write` (send), `chat.read` (stop, read) | `draftRevision` + `configRevision` bound to the signed send; one provider writer | `remote.test.ts` ("provider acceptance followed by lost acknowledgement…", "remote Ollama and Claude sessions…"), `ConnectedDesktopTest.kt` | Both | — |
| Sessions, search, Unread | `qml/SessionList.qml` | Sessions screen, "Search conversations", Load more | `sessions.list` (filter, `withIds`), `sessions.batch`, `sessions.read` | `chat.read` | `revision`; search names every match ID (no silent page cap) | `mobile-conformance.test.ts`, `remote.test.ts` ("phones clear Unread…") | Both | — |
| Drafts, including desktop attachments | Chat composer chips | Composer; "From the desktop draft" strip, Review, Remove | `drafts.put` (`desktopAttachmentIds`), `drafts.get`, `drafts.attachmentPreview`, `sessions.send` (`desktopAttachments`) | `chat.write`; `attachments.write` to send attachments; `capture.preview` to preview images | `draftRevision` covers text and attachment set; send binds each attachment's SHA-256 | `remote.test.ts` ("the phone reviews a desktop draft's attachments…", "session metadata is scoped…"), `MobileCapabilitiesTest.kt` | Both | Queued messages carry text only: a draft with desktop attachments waits for an idle turn (explicit hint). An older phone keeps the earlier refusal. |
| Approvals, questions, MCP forms | `qml/ApprovalCard.qml`, completion inbox | Inbox, notification Deny | `approvals.answer`, `approvals.preview`, snapshot/events | `approvals.answer` (+ `approvals.provider` for provider requests) | approval `revision` + `digest`; exactly one winner | `remote.test.ts` ("approval answers retire exactly once…", "changed capture approvals…"), `InteractionStateTest.kt` | Both | Complex MCP forms and unknown provider requests fail closed on both (F28). |
| Child tasks and agents | `qml/AgentCard.qml`, Activity | Activity panel, agents, approvals of descendants | snapshot `agents` (opaque `agentId`), `activity.page` | `chat.read` | agent refs are HMACs, never native thread IDs | `mobile-conformance.test.ts`, `ConversationContentTest.kt` | Both | — |
| Provider creation and configuration | `qml/NewSession.qml`, `qml/SessionModelDialog.qml` | New conversation, Conversation settings | `sessions.create`, `sessions.configure`, `providers.models`; snapshot `providerTraits` | `chat.write`; `providers.execute` (CLI), `providers.api` + provider grant (hosted/compatible API) | `configRevision`; endpoint origin bound to the grant | `remote.test.ts` ("native remote session configuration…", "hosted API providers run from a phone only…"), `ProviderTraitsTest.kt` | Both (by provider, §3) | AntiGravity is Withheld (§3). |
| Pin, archive | Session menu | Conversation settings | `sessions.organize` | `chat.write` | `revision` | `remote.test.ts` ("session metadata is scoped, CAS-organized…") | Both | — |
| Folders | `qml/FolderDialog.qml` | Folder name shown on each conversation | session DTO `folderName` | `chat.read` | folder `revision` | `remote.test.ts` ("session metadata is scoped…") | Phone read | Folder names are global across projects and can describe work outside the phone's scope, so the phone cannot list, create or assign folders. |
| Projects | `qml/Projects.qml` | New conversation project choice | snapshot `projects` | `chat.read` | project `revision` | `projects.test.ts`, `remote.test.ts` | Phone read | Choosing which folders a phone may use is part of pairing (desktop). |
| Branching | `qml/BranchDialog.qml` | Handoff (reviewed draft of recent messages) | `sessions.handoffPreview`, `sessions.handoffCreate` | `chat.write` | source digest of revisions | `remote.test.ts` ("handoff creates a reviewed draft only…") | Phone adapted | Message-level branch points stay on the desktop; a native Codex fork refuses phone-run sessions in code (`forkCodex` rejects `session.remote`). |
| Export | `qml/ConversationExport.qml` | Copy message (Markdown) | — | — | — | `ConversationContentTest.kt` | Desktop only | Export writes a file to a desktop path the user chooses; phone paths are not desktop paths. |
| Pinned replies (bookmarks) | Message menu "Bookmark" | Star on a message, "Pinned" sheet | `messages.bookmark`, `messages.bookmarks` | `chat.write` / `chat.read` | shared bookmark table; message `revision` unchanged | `remote.test.ts` ("the phone pins and unpins replies…"), `ConformanceTest.kt` | Both | A pin made on the desktop appears on the phone when the conversation's messages reload. |
| One-shot web search | Composer "Search web" | Composer "Search the web" | `sessions.send` `webSearch` | `web` + desktop web search enabled | per message only | `remote.test.ts`, `MobileCapabilitiesTest.kt` | Both | Same 500-character query limit; no hidden provider fallback (refused when unavailable). |
| Personality and assistant identity | `qml/PersonalitySettings.qml` | Settings → Defaults (personality, labelled global); assistant name in composer | `settings.get`, `settings.patch` | `settings.write` | `settingsRevision` | `remote.test.ts` ("the phone reads a conversation's style source…") | Both | The assistant's name and avatar are chosen on the desktop. |
| Behavior styles and postures | `qml/SessionBehavior.qml`, `qml/BehaviorProfileEditor.qml` | Conversation settings → Style (source: this conversation, this project, or everywhere) | `sessions.behavior` | `chat.read` | resolved at next turn | `remote.test.ts` ("the phone reads a conversation's style source…") | Phone read | Styles carry tool ceilings; choosing them stays on the desktop. |
| Memory and evidence | `qml/GraphMemoryInspector.qml`, `qml/MemoryDialog.qml` | Settings → Project memory | `memory.*` (index §4) | `memory.read` / `memory.write` + granted memory server | graph revisions; erasure receipts | `remote.test.ts` ("project memory is shared across provider conversations…", "the phone reviews an assertion history…", "phone operations without a dedicated test…"), `CacheIntegrityTest.kt` | Both (typed, scoped) | Representative evaluation is not done (W09; see `docs/memory/implementation-report.md`). |
| Capture | `qml/Desktop.qml` capture card | Desktop → Capture | `captures.*`, `capture.updated` events | `desktop.control` + capture category; `capture.preview`; `attachments.write` to attach | digest of the immutable image | `remote.test.ts` ("a phone-started capture is previewed…") | Both | Satty editing waits for someone at the desktop; the phone says so and can cancel. |
| Desktop controls | `qml/Desktop.qml` | Desktop screen | `desktop.status`, `desktop.apps`, `desktop.windows`, `desktop.execute`, `timers.cancel` | `desktop.control` + category | target revalidated before acting | `desktop-hyprland.test.ts`, `desktop-services.test.ts`, `remote.test.ts`, `review-core.test.ts` | Both | — |
| Workflows, recipes, capsules | `qml/Workflows.qml` | — | — | — | recipe version + revision | `workflows.test.ts` | Desktop only | Recipes run under reviewed authorization tied to the desktop; preparing or saving them from a phone would bypass that review. |
| Result verification | `qml/Workflows.qml` results | Conversation settings → Results and schedules | `workflows.status` | `chat.read` | provider outcome kept apart from Cere's verification | `remote.test.ts` ("…results and schedules and can only pause a schedule") | Phone read | Running verification stays on the desktop (it runs reviewed scripts). |
| Schedules | `qml/Workflows.qml` schedules | Results and schedules → Pause | `workflows.status`, `workflows.pauseSchedule` | `chat.read` / `chat.write` | schedule `revision` | `remote.test.ts`, `schedules.test.ts` | Phone read + pause | Turning a schedule on again needs a fresh desktop review (`schedules.ts` refuses re-enabling a paused one). |
| Job, activity and completion status | `qml/CompletionInbox.qml`, `qml/ActivityPanel.qml` | Activity, completion notices, queued count | `activity.page`, `notice` events | `chat.read` | message revisions | `remote.test.ts` ("phones clear Unread, receive scoped completion and timer notices…") | Both (scoped) | Background jobs of other projects (indexing, model pulls) are not shown. |
| Notes vault | `qml/KnowledgeSettings.qml` | Phone-started turns use read-only notes tools | provider tools (`core.notesToolsFor`) | desktop vault and cloud policy | — | `knowledge.test.ts` | Phone adapted | Note edits are not offered to phone-started turns; vault path and cloud policy stay on the desktop. |
| Knowledge collections | `qml/KnowledgeCollections.qml` | Bound collections feed phone-started turns | turn context (`collections.context`) | per-collection cloud consent | collection `revision` | `knowledge.test.ts` | Phone adapted | Adding sources and indexing name desktop paths: desktop only. |
| TTS, dictation, transcription, voice commands | `qml/VoiceSettings.qml`, `qml/VoiceInput.qml` | — | — | — | — | `tts.test.ts`, `transcription.test.ts`, `voice-commands.test.ts`, `pinned-replies.test.ts` | Desktop only | Replies to phone-started turns are never read aloud on the desktop (fixed for pinned conversations in this pass). Phone voice input is not a prerequisite and is not built. |
| Health and recovery diagnostics | `qml/Health.qml`, `qml/Recovery.qml` | Desktop → "Unavailable on the desktop"; memory health line | `desktop.status` `missing`, `memory.health` | `desktop.control` / `memory.read` | — | `remote.test.ts`, `desktop.test.ts` | Phone read (sanitized) | Error text, endpoints and model names stay on the desktop. |
| Workspace telemetry | `qml/TelemetrySettings.qml`, workspace card | Desktop → Desktop workspace | `desktop.workspace` | `desktop.control` | fresh observations only; unknowns named | `remote.test.ts` ("…reads scoped workspace and memory health") | Phone read (scoped) | Only this project's state; no window titles, commands or outside paths. |
| Pet, motion, appearance | `qml/Pet.qml`, `qml/MotionSettings.qml` | Still status portrait (Settings → On this phone) | `desktop.portrait` | `chat.read` | portrait sheet digest | `remote.test.ts`, `portrait-state.test.ts`, `PortraitStateTest.kt` | Phone adapted | The phone never animates; window roaming and pet placement are desktop behaviors. |
| Credentials, pairing, grants, trust | `qml/RemoteSettings.qml`, `qml/ConnectionsSettings.qml` | Settings → access summary, Reduce access, Pause, Forget | `permissions.get`, `permissions.reduce`, `permissions.pause`, `devices.self`, `devices.selfRevoke` | any paired phone | `scopeVersion` | `remote.test.ts` ("mobile permission reduction is revision-bound…", "trusted replacement…", "phone operations without a dedicated test…") | Phone read + reduce | A phone can only reduce or pause; enrolment, keys and expanding trust stay on the desktop. |
| Executable editing (saved scripts, tool servers, custom tools) | `qml/ScriptsSettings.qml`, `qml/ToolServers.qml`, `qml/CustomTools.qml` | Run a granted saved script | `desktop.execute` `script.run` | `desktop.control` + scripts + script ID grant | script definition digest | `review-core.test.ts` ("W10 a saved script changed…"), `remote.test.ts` ("partially executed scripts are unknown…") | Desktop only (editing) | Editing an executable from a phone would let a phone define what the desktop runs. |
| Backup, restore, memory infrastructure | `qml/Recovery.qml`, memory settings | — | — | — | — | `memory-migration-backup.test.ts` | Desktop only | Local administration of the desktop's files and services. |

## 2. Mobile plan rows F01–F98

Treatments are the plan's (`mobile/MOBILE_PLAN.md` §2). Phone entry names are screens of the Android app (Chat, Sessions, Inbox, Desktop, Settings).

| ID | Capability | Desktop entry | Phone entry | Broker operation | Permission | State / revision | Tests | Status | Limitation / next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | Chat/Sessions/Desktop/Settings layout | `qml/Shell.qml`, `Panel.qml`, `Workspace.qml` | Bottom navigation | — | — | — | `ConversationContentTest.kt` | Phone adapted | — |
| F02 | Connection and policy banners | `qml/Shell.qml` | Connection banner, "Cached · actions unavailable" | welcome, `snapshot.changed` | — | connection generation + cache epoch | `ConnectionPolicyTest.kt`, `InboundFramesTest.kt` | Phone adapted | — |
| F03 | Session list, search, status labels | `qml/SessionList.qml` | Sessions, Search conversations | `sessions.list`, `sessions.batch` | `chat.read` | `revision` | `mobile-conformance.test.ts`, `remote.test.ts` | Both | — |
| F04 | Managed session creation | `qml/NewSession.qml` | New conversation | `sessions.create` | `chat.write` + provider grant | — | `remote.test.ts` | Both | AntiGravity withheld (§3). |
| F05 | Project selection, realpath, trust | `qml/NewSession.qml` | Project chips | `sessions.create` `projectId` | granted projects | canonical path | `remote.test.ts` | Phone adapted | First trust stays on the desktop. |
| F06 | CLI model/effort catalogs | `qml/SessionModelDialog.qml` | Conversation settings → Model | `providers.models` | `chat.read` | session's saved endpoint | `remote.test.ts` | Both | — |
| F07 | Ollama server-pinned models and labels | `qml/NewSession.qml` | Model list | `providers.models` | granted Ollama host | host pinned per session | `remote.test.ts` | Both | — |
| F08 | Idle model/tools configuration | `qml/SessionModelDialog.qml` | Conversation settings | `sessions.configure` | `chat.write` | `configRevision` | `remote.test.ts` | Both | — |
| F09 | CLI history import/resume | `qml/SessionList.qml` history (Codex, Claude) | Sessions → Import desktop history (Codex, Claude Code) | `sessions.history` (`provider`), `sessions.import` | `providers.execute` + `chat.write`; Claude needs restricted mode | single-use ticket | `remote.test.ts` ("phone operations without a dedicated test…") | Both | AntiGravity has no history listing on either device. A Claude conversation imported from the phone runs in restricted mode. |
| F10 | Linked terminal restriction | `qml/Chat.qml` | "Linked terminal session · continue on the PC" | session `mode` | `chat.read` | — | `remote.test.ts` | Both | — |
| F11 | Focus linked terminal | `qml/Chat.qml` "Open terminal" | "Open on desktop" | `sessions.focusTerminal` | `desktop.control` + windows | window revalidated | `remote.test.ts` ("…opens a linked terminal…") | Both | — |
| F12 | Cross-provider handoff | `qml/BranchDialog.qml` | Handoff draft | `sessions.handoffPreview`, `sessions.handoffCreate` | `chat.write` | source digest | `remote.test.ts` | Both | — |
| F13 | Rename, disconnect/resume | Session menu | Conversation settings | `sessions.rename`, `sessions.disconnect` | `chat.write` | `revision` | `remote.test.ts` | Both | — |
| F14 | Streaming and status | `qml/Chat.qml` | Chat timeline | `message.upsert`, session upserts | `chat.read` | message `revision` | `ConversationContentTest.kt`, `fanout.test.ts` | Both | — |
| F15 | Stop and delegated cancellation | Stop | Stop | `sessions.stop` | `chat.read` | — | `remote.test.ts`, `jobs.test.ts` | Both | — |
| F16 | Saved drafts and debounce | Composer | Composer | `drafts.put` | `chat.write` | `draftRevision` | `remote.test.ts`, `ReconciliationTest.kt` | Both | — |
| F17 | Scroll and follow | `qml/Chat.qml` | Chat timeline | — | — | per-phone position | `ConversationContentTest.kt` | Phone adapted (on-device) | — |
| F18 | Image attachments (four) | Composer | Attach → Photo, Screenshot or file, Camera | `attachments.*` | `attachments.write` | SHA-256 + offsets | `remote.test.ts` ("media binary upload validates…"), `CacheIntegrityTest.kt` | Both | — |
| F19 | Markdown rendering | `qml/MessageCard.qml` | Markdown | — | — | — | `ConversationContentTest.kt`, `CitationsTest.kt` | Both | — |
| F20 | Copy and selection | Message menu | Copy | — | — | — | `ConversationContentTest.kt` | Both | — |
| F21 | Links and sources | `qml/MessageCard.qml` | Links, Sources | message `sources` | — | — | `mobile-conformance.test.ts`, `ConformanceTest.kt` | Phone adapted | Desktop file links are not opened on the phone (they name desktop paths). |
| F22 | Activity panel | `qml/ActivityPanel.qml` | Activity | `activity.page` | `chat.read` | continuation cursor | `mobile-conformance.test.ts`, `ConversationContentTest.kt` | Both | — |
| F23 | Global approvals queue | `qml/CompletionInbox.qml` | Inbox | snapshot approvals | `approvals.answer` | approval `revision` | `remote.test.ts` | Both | — |
| F24 | Codex command/file approvals | `qml/ApprovalCard.qml` | Inbox card | `approvals.answer` | `approvals.provider` | digest | `remote.test.ts` | Both | — |
| F25 | Codex extra permissions | `qml/ApprovalCard.qml` | Inbox card | `approvals.answer` | `approvals.provider` | digest | `remote.test.ts` | Both | — |
| F26 | Provider questions | `qml/ApprovalCard.qml` | Inbox card | `approvals.answer` | `approvals.answer` | digest | `remote.test.ts` | Both | — |
| F27 | Primitive MCP elicitation | `qml/ApprovalCard.qml` | Inbox form | `approvals.answer` | `approvals.answer` | digest | `remote.test.ts` | Both | — |
| F28 | Unsupported requests fail closed | `qml/ApprovalCard.qml` | "Answer on the desktop" | — | — | — | `remote.test.ts` | Both (fail closed) | — |
| F29 | Claude permission bridge | `qml/ApprovalCard.qml` | Inbox card | `approvals.answer` | `approvals.provider` | digest | `remote.test.ts` | Both | — |
| F30 | Capture-sharing approval | `qml/ApprovalCard.qml` | Inbox preview | `approvals.preview`, `attachments.read` | `capture.preview` | image digest | `remote.test.ts` ("changed capture approvals stay reviewable…") | Both | — |
| F31 | Requests when the desktop UI is closed | `qml/Pet.qml` bubble | Notifications | notice events | `approvals.answer` | — | `InteractionStateTest.kt` | Phone adapted | Delivery while the screen is off depends on monitoring (W12). |
| F32 | Completion/error/timer notices | Desktop notices | Notifications | `notice` events | `chat.read` | — | `remote.test.ts` ("phones clear Unread, receive scoped completion and timer notices…") | Phone adapted | — |
| F33 | Desktop search/filters/cards | `qml/Desktop.qml` | Desktop screen | `desktop.status` | `desktop.control` | — | `remote.test.ts` | Phone adapted | — |
| F34 | App discovery | `qml/Desktop.qml` | Desktop → Apps | `desktop.apps` | `desktop.control` + apps | — | `remote.test.ts`, `desktop-services.test.ts` | Both | — |
| F35 | Launch app | `qml/Desktop.qml` | Desktop → Launch | `desktop.execute` `apps.launch` | apps | entry revalidated | `desktop-services.test.ts` | Both | — |
| F36 | Open file/folder | `qml/Desktop.qml` | Desktop → Open | `desktop.execute` `files.open` | files | realpath inside project | `desktop-services.test.ts`, `remote.test.ts` | Both | Phone limited to granted projects. |
| F37 | List/focus windows | `qml/Desktop.qml` | Desktop → Windows | `desktop.windows`, `desktop.execute` | windows | address revalidated | `desktop-hyprland.test.ts` | Both | — |
| F38 | Move window, switch workspace | `qml/Desktop.qml` | Desktop → Move, Workspace | `desktop.execute` | windows | — | `desktop-hyprland.test.ts` | Both | — |
| F39 | Volume and mute | `qml/Desktop.qml` | Desktop → Sound | `desktop.execute` `audio.*` | audio | read back | `desktop-services.test.ts` | Both | — |
| F40 | MPRIS status | `qml/Desktop.qml` | Desktop → Media | `desktop.status` | media | player identity | `desktop-services.test.ts` | Both | — |
| F41 | Playback | `qml/Desktop.qml` | Desktop → Media | `desktop.execute` `media.control` | media | exact player | `desktop-services.test.ts` | Both | — |
| F42 | Timers | `qml/Desktop.qml` | Desktop → Timers | `desktop.execute` `timer.start`, `timers.cancel` | timers | project-scoped timers | `remote.test.ts` | Both | The desktop owns firing; the phone mirrors notices. |
| F43 | Capture with grim/Satty | `qml/Desktop.qml` | Desktop → Capture | `captures.start`, `captures.status` | capture | job state | `remote.test.ts` | Both | — |
| F44 | Capture preview/attach/dismiss | `qml/Desktop.qml` | Capture review | `captures.preview`, `captures.attach`, `captures.discard` | `capture.preview`, `attachments.write` | image digest | `remote.test.ts` | Both | — |
| F45 | Run saved scripts | `qml/Desktop.qml` | Desktop → Scripts | `desktop.execute` `script.run` | scripts + ID grant | definition digest | `remote.test.ts`, `review-core.test.ts` | Both | — |
| F46 | Edit saved scripts | `qml/ScriptsSettings.qml` | — | — | — | — | `review-core.test.ts` | Desktop only | Executable editing is local administration. |
| F47 | Provider orchestration | Agent cards | Agents in Activity; Stop | Cere tools in phone turns | `providers.execute` | child inherits phone caps | `remote.test.ts` | Both | — |
| F48 | Ollama tool loops and recovery | `qml/Chat.qml` | Chat | `sessions.send` | `chat.write` | — | `ollama.test.ts`, `remote.test.ts` | Both | — |
| F49 | Permission profiles and categories | `qml/PermissionCenter.qml` | Settings → access summary | `permissions.get` | any | `scopeVersion` | `mobile-conformance.test.ts` | Phone read | — |
| F50 | Change profile/categories | `qml/PermissionCenter.qml` | — | — | — | — | `review-core.test.ts` | Desktop only | Expanding authority is local. |
| F51 | Broad grants list/revoke | `qml/PermissionCenter.qml` | Settings → Reduce access | `permissions.get`, `permissions.reduce` | any | `scopeVersion` | `remote.test.ts` ("mobile permission reduction…") | Phone read + reduce | — |
| F52 | Create/extend grants | `qml/PermissionCenter.qml` | — | — | — | — | `review-core.test.ts` | Desktop only | — |
| F53 | Pause and revocation | `qml/PermissionCenter.qml` | Pause desktop actions, Forget this desktop | `permissions.pause`, `devices.selfRevoke` | any | — | `remote.test.ts` ("phone operations without a dedicated test…") | Both | — |
| F54 | Resume privileges | `qml/PermissionCenter.qml` | — | — | — | — | `power.test.ts` | Desktop only | — |
| F55 | Bypasses | `qml/PermissionCenter.qml` | — | — | — | — | `remote.test.ts` | Desktop only | Never applied to phone turns (`ordinarySettings`). |
| F56 | MCP capability token | — | — | — | — | — | `providers.test.ts` | Desktop only | Never leaves the desktop. |
| F57 | Personality | `qml/PersonalitySettings.qml` | Settings → Defaults | `settings.patch` | `settings.write` | `settingsRevision` | `remote.test.ts` | Both | — |
| F58 | Provider availability/models | `qml/ApplicationSettings.qml` | New conversation | snapshot `providers`, `providers.models` | `chat.read` | — | `remote.test.ts` | Both | — |
| F59 | Endpoint and CLI auth editing | `qml/OllamaConnection.qml`, `qml/ApiConnection.qml` | — | — | — | — | `api-providers.test.ts` | Desktop only | Credentials and endpoints stay on the desktop. |
| F60 | Web search enable/provider | `qml/AssistanceSettings.qml` | Settings → Web search provider | `settings.patch` `searchProvider` | `settings.write` | `settingsRevision` | `remote.test.ts` | Phone read + provider choice | Turning web search on widens outbound use: desktop only. |
| F61 | Search web toggle | Composer | Composer | `sessions.send` | `web` | per message | `MobileCapabilitiesTest.kt` | Both | — |
| F62 | Automatic web tools and sources | Chat | Chat sources | tools in turns | `web` | — | `web-trace.test.ts`, `ConformanceTest.kt` | Both | — |
| F63 | Public HTTP reader limits | — | — | broker `web.ts` | — | — | `web-plan.test.ts` | Both (same broker) | — |
| F64 | SearXNG endpoint | `qml/AssistanceSettings.qml` | — | — | — | — | `web-plan.test.ts` | Desktop only | Endpoint editing. |
| F65 | Graph memory scope | `qml/GraphMemoryInspector.qml` | Project memory | `memory.list` | `memory.read` + memory server | project + server scope | `remote.test.ts` ("project memory is shared…") | Both (all providers) | — |
| F66 | Observations, facts, provenance | Inspector | Project memory, "Show history and evidence" | `memory.list`, `memory.timeline` | `memory.read` | graph revision | `remote.test.ts` | Both | `memory.inspect` exists in the protocol but the phone shows evidence through history. |
| F67 | Lists and filters | Inspector | Browse | `memory.list` | `memory.read` | offset pages | `remote.test.ts` | Both | — |
| F68 | Save/edit note | `qml/MemoryDialog.qml` | Remember a fact, Review & save | `memory.save` | `memory.write` | expected revision | `remote.test.ts`, `memory-providers.test.ts` | Both | — |
| F69 | Recall and coverage | Inspector | Recall | `memory.retrieve` | `memory.read` | — | `remote.test.ts` | Both | — |
| F70 | Temporal history | Inspector | Show history and evidence | `memory.timeline` | `memory.read` | — | `remote.test.ts` | Both | — |
| F71 | Correct/resolve conflict | Inspector | Correct, This one is right | `memory.correct`, `memory.resolveConflict` | `memory.write` | expected revision + statement | `remote.test.ts` | Both | Structured new claims from the phone are not offered (notes only). |
| F72 | Identity decisions | Inspector | Same/not same/possible | `memory.identity` | `memory.write` | statement witness | `remote.test.ts` | Both | — |
| F73 | Identity merge/split, task binding | — | — | — | — | — | — | Not built | Incomplete in the memory design itself (`docs/memory/implementation-report.md`); next action is the memory workstream, not the phone. |
| F74 | Episodes | Inspector | Freeze this episode | `memory.freezeEpisode` | `memory.write` | — | `remote.test.ts` | Both (freeze) | Consolidate, archive and topics stay on the desktop inspector. |
| F75 | Forget preview and receipts | Inspector | Preview what will be forgotten, receipts | `memory.forgetPreview`, `memory.forget`, `memory.erasureStatus` | `memory.write` | selection + revision | `remote.test.ts`, `CacheIntegrityTest.kt` | Both | — |
| F76 | Clear project memory | Inspector | Clear this project | `memory.clear` | `memory.write` | project confirmation | `remote.test.ts` | Both | — |
| F77 | Memory diagnostics | `qml/Health.qml` | Memory health line | `memory.health` | `memory.read` | — | `remote.test.ts` | Phone read (sanitized) | — |
| F78 | Model and cloud policy | Memory settings | — | — | — | — | `memory-providers.test.ts` | Desktop only | — |
| F79 | Collector/retention policy | Memory settings | — | — | — | — | `workspace.test.ts` | Desktop only | — |
| F80 | Workspace snapshot | Workspace card | Desktop → Desktop workspace | `desktop.workspace` | `desktop.control` | fresh only | `remote.test.ts` | Phone read (scoped) | — |
| F81 | Hyprland collector | — | — | desktop collectors | — | — | `workspace.test.ts` | Desktop only | Observations never leave the desktop raw. |
| F82 | Fish lifecycle events | — | — | desktop hook | — | — | `workspace.test.ts` | Desktop only | — |
| F83 | Kitty inspection | — | — | desktop endpoint | — | — | `workspace.test.ts` | Desktop only | — |
| F84 | Repository metadata | — | — | desktop roots | — | — | `workspace.test.ts` | Desktop only | — |
| F85 | Editor collector | — | — | — | — | — | — | Not built | Not implemented on the desktop either; next action belongs to the telemetry workstream. |
| F86 | Reindex/rebuild | Memory settings | — | — | — | — | `memory-optimization.test.ts` | Desktop only | — |
| F87 | Memory backup/restore | `qml/Recovery.qml` | — | — | — | — | `memory-migration-backup.test.ts` | Desktop only | — |
| F88 | Graph-memory CLI and services | `tools/` | — | — | — | — | `memory-adapters.test.ts` | Desktop only | — |
| F89 | Persistence | — | Encrypted cache | snapshot/reconcile | — | cache epoch | `CacheIntegrityTest.kt`, `ReconciliationTest.kt` | Both (desktop authoritative) | — |
| F90 | Restart behavior | — | Reconcile after reconnect | `commands.status` | — | command ledger | `broker-restart.test.ts`, `shutdown.test.ts` | Both | — |
| F91 | Pet scale/position | `qml/MotionSettings.qml` | — | — | — | — | `ui.cpp` | Desktop only | Window placement. |
| F92 | Roaming/drag/gaze | `qml/Pet.qml` | — | — | — | — | `ui.cpp` | Desktop only | — |
| F93 | Expression from state | `qml/CerePortrait.qml` | Still status portrait | `desktop.portrait` | `chat.read` | sheet digest | `portrait-state.test.ts`, `PortraitStateTest.kt`, `remote.test.ts` | Phone adapted | Static only. |
| F94 | Desktop quiet/motion/cues | `qml/MotionSettings.qml` | — | — | — | — | `ui.cpp` | Desktop only | — |
| F95 | Phone presentation choices | — | Settings → On this phone | — | — | on-device | `PortraitStateTest.kt` | Phone adapted (on-device) | Desktop quiet never suppresses phone approvals. |
| F96 | Autostart and onboarding | `README.md`, installer | — | — | — | — | — | Desktop only | — |
| F97 | Tray quit vs Stop and quit | `qml/Shell.qml` | — | — | — | — | `shutdown.test.ts` | Desktop only | — |
| F98 | Keyboard shortcuts, tooltips | `qml/Shell.qml` | — | — | — | — | `ui.cpp` | Desktop only | Touch equivalents exist for every phone action. |

## 3. Providers

| Provider | Desktop | Phone create | Phone send | Configure | Images | Tools | Import / resume | Tested by | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | managed, linked | yes (`providers.execute`) | yes, Codex's restricted sandbox | model/effort when idle | yes | native | import (Codex), resume | `providers.test.ts`, `remote.test.ts` | Both |
| Claude Code | managed, linked | yes when `--restricted` is supported | yes, restricted mode | model/effort when idle | yes (copied into a private directory) | native, code-running tools off on phone | import (restricted on phone), resume | `providers.test.ts`, `remote.test.ts` | Both (restricted) |
| Ollama | managed | yes (granted host) | yes, queue while busy | model/tools when idle | per model | Cere tools limited to grants | — | `ollama.test.ts`, `remote.test.ts` | Both |
| OpenAI, Claude, Google APIs | managed | yes with `providers.api` + that provider | yes | model/tools | yes | Cere tools limited to grants | — | `api-providers.test.ts`, `remote.test.ts` ("hosted API providers…") | Both (billed; per-provider grant) |
| Compatible endpoint | managed | yes when the granted origin matches | yes | model/tools | per endpoint declaration | Cere tools | — | `api-providers.test.ts`, `remote.test.ts` | Both (origin-bound) |
| AntiGravity | managed | no | no | — | no | native | resume | `antigravity.test.ts` | Withheld: its headless mode cannot prove restricted execution; reading stays available. |

**CLI compatibility.** The README records the last full validation (Codex 0.162.1, Claude Code 2.1.296, 2026-10-12) and the minimums Cere enforces (Codex 0.158.0, Claude Code 2.1.259). On 2026-10-20 the installed CLIs were Codex 0.163.0, Claude Code 2.1.303, Ollama 0.34.4 and AntiGravity (`agy`) 1.4.3. Two no-cost checks were added and pass on those versions: `node tools/check-codex-protocol.ts` (all 34 app-server methods Cere uses are in the schema the installed binary generates) and `node tools/check-claude-protocol.ts` (Cere's ordinary and restricted print-mode flags are accepted and the stream-json `initialize` handshake succeeds). They establish names and handshakes, not turn semantics: a live turn per provider (billed for Claude and hosted APIs) remains the owner's choice, and the minimums are not a claim about arbitrary newer releases.

## 4. Phone operation index

Every operation the gateway accepts, regenerated by `node tools/feature-matrix.ts`. *Kind*: read; mutation (no proof) for defensive or organizational changes; signed mutation (per-action key, biometric or device credential unless the phone is trusted). *Android* names the files that call it; *Tests* the files that exercise it.

| Operation | Permission | Kind | Android | Tests |
| --- | --- | --- | --- | --- |
| `sync.open` | chat.read | read | CereRepository | mobile-conformance.test.ts, remote-process.test.ts, remote.test.ts, ConformanceTest.kt |
| `sync.ack` | chat.read | read | CereRepository | remote.test.ts |
| `sessions.list` | chat.read | read | MainActivity, CereRepository | mobile-conformance.test.ts, remote-rate-limits.test.ts, remote.test.ts |
| `sessions.get` | chat.read | read | CereRepository | mobile-conformance.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `sessions.batch` | chat.read | read | CereRepository | mobile-conformance.test.ts, ConformanceTest.kt |
| `projects.list` | chat.read | read | — | conversation-defaults.test.ts, mobile-conformance.test.ts, projects.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `sessions.create` | chat.write | signed mutation | MainActivity, CommandOutcomes | mobile-conformance.test.ts, remote-process.test.ts, remote-rate-limits.test.ts, remote.test.ts |
| `sessions.messages` | chat.read | read | CereRepository | mobile-conformance.test.ts, remote.test.ts |
| `sessions.messagePart` | chat.read | read | MainActivity, CereRepository | mobile-conformance.test.ts, ConformanceTest.kt |
| `sessions.handoffPreview` | chat.read | read | MainActivity, ParitySheets | remote.test.ts |
| `sessions.handoffCreate` | chat.write | signed mutation | MainActivity, ParitySheets, CommandOutcomes | remote.test.ts |
| `sessions.history` | providers.execute | read | MainActivity, ParitySheets | remote-rate-limits.test.ts, remote.test.ts |
| `sessions.import` | chat.write | signed mutation | MainActivity, ParitySheets, CommandOutcomes | remote.test.ts |
| `sessions.send` | chat.write | signed mutation | MainActivity, CereRepository, CommandOutcomes, MobileCapabilities | mobile-conformance.test.ts, remote-process.test.ts, remote.test.ts, ConnectedDesktopTest.kt, CommandOutcomesTest.kt, MobileCapabilitiesTest.kt, ReconciliationTest.kt, ProtocolTest.kt |
| `sessions.stop` | chat.read | mutation (no proof) | MainActivity, CommandOutcomes | remote.test.ts |
| `sessions.disconnect` | chat.write | mutation (no proof) | ConversationSettingsSheet, CommandOutcomes | remote.test.ts |
| `sessions.read` | chat.read | mutation (no proof) | CereRepository, CommandOutcomes | remote.test.ts |
| `sessions.rename` | chat.write | mutation (no proof) | ConversationSettingsSheet, CommandOutcomes | mobile-conformance.test.ts, remote.test.ts, CommandOutcomesTest.kt |
| `sessions.organize` | chat.write | mutation (no proof) | ConversationSettingsSheet, CommandOutcomes | remote.test.ts, ConnectedDesktopTest.kt |
| `drafts.get` | chat.read | read | — | remote.test.ts |
| `drafts.put` | chat.write | mutation (no proof) | MainActivity, CereRepository, CommandOutcomes | mobile-conformance.test.ts, remote.test.ts, CommandOutcomesTest.kt, MobileCapabilitiesTest.kt |
| `drafts.attachmentPreview` | chat.read | read | CereRepository | mobile-conformance.test.ts, remote.test.ts |
| `messages.bookmark` | chat.write | mutation (no proof) | MainActivity, CereRepository, CommandOutcomes | mobile-conformance.test.ts, remote.test.ts, ConformanceTest.kt |
| `messages.bookmarks` | chat.read | read | MainActivity, CereRepository | mobile-conformance.test.ts, remote.test.ts, ConformanceTest.kt |
| `sessions.behavior` | chat.read | read | ConversationSettingsSheet | mobile-conformance.test.ts, remote.test.ts |
| `workflows.status` | chat.read | read | ConversationSettingsSheet | mobile-conformance.test.ts, remote.test.ts |
| `workflows.pauseSchedule` | chat.write | mutation (no proof) | ConversationSettingsSheet, CommandOutcomes | remote.test.ts |
| `desktop.portrait` | chat.read | read | MainActivity, CereRepository | remote.test.ts |
| `sessions.focusTerminal` | desktop.control | signed mutation | MainActivity | remote.test.ts |
| `desktop.workspace` | desktop.control | read | DesktopControls | remote.test.ts |
| `memory.health` | memory.read | read | MainActivity | remote.test.ts |
| `providers.models` | chat.read | read | MainActivity, ParitySheets, CereRepository | remote.test.ts |
| `sessions.configure` | chat.write | signed mutation | ConversationSettingsSheet, CommandOutcomes | remote.test.ts |
| `approvals.list` | approvals.answer | read | — | mobile-conformance.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `approvals.get` | approvals.answer | read | — | remote.test.ts |
| `approvals.answer` | approvals.answer | signed mutation | MainActivity, MonitoringService, CereRepository, CommandOutcomes | feature-matrix.test.ts, mobile-conformance.test.ts, remote-process.test.ts, remote.test.ts, CommandOutcomesTest.kt, ReconciliationTest.kt |
| `approvals.preview` | capture.preview | read | MainActivity, CereRepository | remote.test.ts |
| `attachments.begin` | attachments.write | signed mutation | MainActivity, CommandOutcomes | remote.test.ts |
| `attachments.status` | attachments.write | read | CereRepository | remote.test.ts |
| `attachments.commit` | attachments.write | signed mutation | MainActivity, CereRepository, CommandOutcomes | remote.test.ts |
| `attachments.abort` | attachments.write | mutation (no proof) | CereRepository, CommandOutcomes | remote.test.ts |
| `attachments.read` | capture.preview | read | MainActivity, CereRepository | remote.test.ts |
| `commands.challenge` | any paired phone | read | CereRepository | feature-matrix.test.ts, mobile-conformance.test.ts, remote-process.test.ts, remote-rate-limits.test.ts, remote.test.ts |
| `commands.status` | any paired phone | read | CereRepository | feature-matrix.test.ts, mobile-conformance.test.ts, remote-process.test.ts, remote.test.ts |
| `activity.list` | chat.read | read | MainActivity, CereRepository | mobile-conformance.test.ts, remote.test.ts |
| `activity.page` | chat.read | read | CereRepository | mobile-conformance.test.ts, ConformanceTest.kt |
| `permissions.get` | chat.read | read | — | mobile-conformance.test.ts, ConnectedDesktopTest.kt |
| `permissions.pause` | any paired phone | mutation (no proof) | MainActivity, CommandOutcomes | feature-matrix.test.ts, remote.test.ts |
| `permissions.reduce` | any paired phone | mutation (no proof) | MainActivity, CommandOutcomes | feature-matrix.test.ts, remote.test.ts |
| `devices.self` | any paired phone | read | MainActivity | feature-matrix.test.ts, mobile-conformance.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `devices.selfRevoke` | any paired phone | mutation (no proof) | CereRepository, CommandOutcomes | feature-matrix.test.ts, remote.test.ts |
| `desktop.status` | desktop.control | read | DesktopControls | remote.test.ts, ConnectedDesktopTest.kt |
| `desktop.apps` | desktop.control | read | DesktopControls | remote.test.ts |
| `desktop.windows` | desktop.control | read | DesktopControls | remote.test.ts |
| `desktop.execute` | desktop.control | signed mutation | DesktopControls, CommandOutcomes | remote-process.test.ts, remote.test.ts, CommandOutcomesTest.kt |
| `timers.cancel` | desktop.control | signed mutation | DesktopControls, CommandOutcomes | remote.test.ts |
| `captures.start` | desktop.control | signed mutation | DesktopControls, CommandOutcomes | remote.test.ts |
| `captures.status` | desktop.control | read | CereRepository | remote.test.ts |
| `captures.preview` | capture.preview | read | DesktopControls, CereRepository | remote.test.ts |
| `captures.discard` | desktop.control | mutation (no proof) | CereRepository, CommandOutcomes | remote.test.ts |
| `captures.attach` | attachments.write | signed mutation | DesktopControls, CommandOutcomes | remote.test.ts |
| `settings.get` | chat.read | read | MainActivity | mobile-conformance.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `settings.patch` | settings.write | signed mutation | MainActivity, CommandOutcomes | remote.test.ts |
| `memory.list` | memory.read | read | MainActivity | remote.test.ts, review-core.test.ts, ConnectedDesktopTest.kt |
| `memory.retrieve` | memory.read | read | MainActivity | remote.test.ts |
| `memory.save` | memory.write | signed mutation | MainActivity, ParitySheets, CommandOutcomes | memory-providers.test.ts, remote.test.ts, review-core.test.ts |
| `memory.inspect` | memory.read | read | — | remote-rate-limits.test.ts |
| `memory.forgetPreview` | memory.write | read | MainActivity, ParitySheets | remote.test.ts |
| `memory.forget` | memory.write | signed mutation | ParitySheets, CommandOutcomes | companion-tools.test.ts, remote.test.ts |
| `memory.clear` | memory.write | signed mutation | MainActivity, ParitySheets, CommandOutcomes | remote.test.ts |
| `memory.erasureStatus` | memory.read | read | MainActivity, CereRepository | remote.test.ts |
| `memory.timeline` | memory.read | read | MainActivity, ParitySheets | remote.test.ts |
| `memory.correct` | memory.write | signed mutation | ParitySheets, CommandOutcomes | remote.test.ts |
| `memory.resolveConflict` | memory.write | signed mutation | ParitySheets, CommandOutcomes | remote.test.ts |
| `memory.identity` | memory.write | signed mutation | ParitySheets, CommandOutcomes | remote.test.ts |
| `memory.freezeEpisode` | memory.write | signed mutation | ParitySheets, CommandOutcomes | remote.test.ts |
