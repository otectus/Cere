# Cere desktop UI/UX review

Date: 2026-10-01. Scope: compact panel, expanded workspace, pet ↔ panel ↔ workspace transitions, pending-approval bubble and tray as entry/exit points. Everything below was run against the workspace build with isolated `CERE_STATE_DIR`/`CERE_RUNTIME_DIR` (the UI-check harness creates them under `/tmp`), the local Ollama and Codex fixtures only, and the real Hyprland session for layer-shell behaviour. The user's broker, state and running client were not touched.

Evidence tags: **Observed** = reproduced with a screenshot or log; **Code-inferred** = read in source, not reproduced; **Assumed** = neither.

Evidence directories: `docs/ui-review/baseline/` (PNG captures and JSON notes copied from `/tmp/cere-ui-evidence`), run logs `/tmp/cere-ui-review-baseline-existing.log`, `/tmp/cere-ui-review-baseline-b.log`, `/tmp/cere-ui-review-live2.log`, `/tmp/cere-ui-review-offscreen2.log`, `/tmp/cere-ui-review-render-timing.log`.

## 1. Implementation map

### Files

| Surface | QML | Native | Notes |
| --- | --- | --- | --- |
| Pet | `qml/Pet.qml`, `qml/GesturePlayer.qml`, `qml/EmoticonBadge.qml` | `native/controller.cpp` (`syncPet`, `placePet`), `native/placement.h` | Click → `App.togglePanel()`; right-click menu (`Pet.qml:50-62`). |
| Compact panel | `qml/Panel.qml` → `qml/Shell.qml` (`expanded:false`) | `Controller::togglePanel` (`controller.cpp:540`), `positionPanel` (`:548`), `Placement::compactPanel` (`placement.h:18`) | Preferred 440×860, clamped to the output's available area minus 12/40/12/12 px. |
| Workspace | `qml/Workspace.qml` → `qml/Shell.qml` (`expanded:true`) | `Controller::showWorkspace` (`controller.cpp:610`) | 1040×780 default, minimum 720×580; sidebar only when width ≥ 920 (`Shell.qml:62`). |
| Bubble | `qml/ApprovalBubble.qml`, `qml/ApprovalCard.qml`, `qml/CompletionCard.qml`, `qml/CompanionCard.qml` | `syncApprovalBubble` (`:551`), `positionApprovalBubble` (`:586`) | 392 px wide, height ≤ 460, placed beside the pet's head. |
| Tray | — | `Controller::start` (`controller.cpp` ~line 150) | Trigger → `expand()`; menu: Open, Show/hide, Pause, Disable remote, Quit ×2. |

Pages inside both panels: `Chat.qml` (conversation, composer, tools, dialogs), `SessionList.qml`, `Projects.qml`, `Desktop.qml`, `Settings.qml`; overlays `CommandPalette.qml`, `NewSession.qml`, `PermissionCenter.qml`, `Workflows.qml`.

### Shared vs duplicated

- Shared controls: `CButton`, `CField`, `CCheckBox`, `CComboBox`, `CSpinBox`, `CSlider`, `CScrollBar`, `CDialog`, `CSection`, `CActionRow`, `CText`, `CIcon`, `SectionLabel`, `PageScroll`. Every page uses them; this is a solid base.
- One `Shell.qml` serves both panels; the compact and wide layouts are branches on `shell.wide` (header row + icon tab row vs sidebar). `HeaderPortrait` is an inline component used twice.
- Duplicated: the "requester" identity string is built in `ApprovalCard.qml:163-167` and again in `CompletionCard.qml:11-13`; the status/footer row and toast banner are inline in `Shell.qml:220-236`; the question "other answer" editor exists twice (secret field + TextArea); provider-name capitalisation is repeated in `Chat.qml:146`, `SessionList.qml:212`, `CommandPalette.qml`.
- Dialog-local `Menu`/`MenuItem` use the default Basic style with the C++ palette from `main.cpp:49-53`, not `Theme` tokens (visible in `baseline/context-open-sidebarSessionList.png`).

### Colour, spacing and type

- `qml/Theme.qml` is the only token source: 15 colours, one font, `radius: 12`, `reducedMotion`. There is **one theme** (dark); `main.cpp:22` forces `QT_QUICK_CONTROLS_STYLE=Basic`, so the installed style equals the test style.
- Scattered literals (Observed by grep): 40 distinct hex colours outside `Theme.qml` across 15 files; 16 `font.pixelSize` values (9–28; 12 is used 218 times, 11 is used 90 times); 11 corner radii (2–16); spacing values 2–24 chosen per file. `motionIntensity` is never consulted by UI transitions; the page slide (`Shell.qml:33`) only checks reduced motion/quiet.

### Surfaces on Wayland

| Surface | always-on-top **on** (default; overlay process) | always-on-top **off** (ui process) | Keyboard | Size control |
| --- | --- | --- | --- | --- |
| Pet | layer-shell `overlay`, scope `cere-pet`, anchors top-left + margins (`controller.cpp:365-380`) | xdg `Tool` window, floated and moved via `hyprctl` dispatch (`:399`) | none | fixed 192×208 × scale |
| Compact panel | layer-shell `overlay`, `cere-panel`, keyboard **on-demand**, activate on show | xdg `Tool` window; **no float/move dispatch**, so Hyprland tiles it (Observed: 944×1145, 944×567) | on-demand / normal | `Placement::compactPanel` (overlay) / compositor (ui) |
| Workspace | — | ordinary xdg toplevel in both modes (`view("Workspace.qml", false, "Cere")`) | normal | 1040×780, min 720×580 |
| Bubble | layer-shell `overlay`, `cere-approval`, on-demand, no activate-on-show | xdg `Tool`, floated via dispatch; accepts focus only while approvals are pending (`:575`) | on-demand / normal | width 392, height = content ≤ 460 |

A toplevel cannot set its own position on Wayland, so only the layer-shell (on-top) mode controls placement: anchors + margins per output, output chosen from the pet's remembered output. Both panels are destroyed and recreated on every switch (`togglePanel` deletes the workspace view, `showWorkspace` deletes the compact view); in the default mode they even live in different processes (overlay host vs ui host).

### State ownership

- Transcript (`TranscriptModel`), selection, approvals and attention are owned by `Controller` per process and shared by the panel and bubble of that process.
- Draft text, attachment ids and `scroll` (raw `contentY`) are persisted through `session.draft` (`Chat.qml:117`, `broker/core.ts:169`) on a 600 ms debounce and on `flushDrafts`; the new surface reloads them (`Chat.qml:116`, `:124`).
- Not carried anywhere: cursor position, selection, the **Search web** checkbox, Activity Panel expansion, which message was at the top of the viewport, keyboard focus. Question-form drafts are kept in `Controller::m_questionDrafts` (same process only).
- Consequence: any transition can lose the cursor/selection, drop a Web-search intent, and restore the scroll to a different message (see F-01).

### Existing `cere-ui-check` coverage and VALIDATION.md gaps

Relevant slots (45 total): `navigationAndScreenshots`, `markdownMessages` (markdown features, wide table, compact 440×720 resize), `questionsAndAgentActivity` (question drafts in workspace and compact), `activityAndPermissionBubble` (bubble ↔ panel hand-over, multiple approvals, cancellation), `compactSessionNavigation` (360/440/1040 sizes), `responsiveLayoutsAndDesktopActions` (4 sizes × 4 pages, control bounds), `approvalsIdentifyTheirRequester`, `completionBubbles`, `pinnedConversationBubbles`, `compactProjectsAndEnterToSend`, `compactComposerClipboard`, `foldersAttachmentsAndPalette`, `sessionContextActions`, `draftsStayCoherentAcrossComposers`, `compactPanelFitsEveryOutput`, `reconnectRecoversTranscriptAndFailsPendingRequests`. Not covered before this review: cursor/selection/toggle survival across surfaces, scroll anchoring, keyboard-only paths, Enter-vs-approve, 200+ message sessions, long replies with code/tables/long URLs, fractional output scales, frame pacing, broker restart in the real broker. `VALIDATION.md` records no screen-reader, multi-scale, or keyboard-only UI verification; its listed limits are TTS/GPU and provider-usage items. Baseline run of the existing subset: 15 of 17 passed; `compactPanelFitsEveryOutput` asserts height ≤ 720 while `togglePanel` now requests 860 (stale assertion), and `sessionContextActions` failed once on timing and passed alone.

## 2. Audit evidence

Environment: Hyprland 0.56.2 (Lua config), Qt 6.11.2, three physical outputs at scale 1 (DP-1 1920×1080 above, eDP-1 1920×1200, HDMI-A-1 1920×1080) plus a temporary `HEADLESS-1` 1920×1080 at scale 1.5 created for the run and removed afterwards; offscreen platform with `tests/fixtures/offscreen-scales.json` (dpr 1, 1.25, 1.5, 2 and a 1366×768 @1.5 output). Captures are device pixels, so dpr-2 images are 2× the logical size.

### Baseline captures (before any change)

| Capture | Scenario | Logical size |
| --- | --- | --- |
| `baseline/chat-empty.png`, `sessions.png`, `settings.png`, `desktop.png` | workspace pages, no sessions | 944×1145 (tiled by Hyprland) |
| `baseline/compact-clean-composer.png` | compact chat, idle session | 440×860 |
| `baseline/compact-before-select-{360,440,1040}.png` | compact sessions page | 360×560 / 440×720 / 1040×780 |
| `baseline/desktop-*-top/bottom.png`, `settings-*-top/bottom.png` | compact pages at 4 sizes | 360×560 … 1040×780 |
| `baseline/markdown-formatted.png`, `markdown-compact.png`, `markdown-wide-table.png` | markdown rendering, 30-column table | 944 wide |
| `baseline/question-form.png`, `question-form-compact.png` | question approval in workspace / compact | 944×1145 / 944×566 |
| `baseline/permission-bubble.png`, `review-approvals-bubble.png`, `review-live-bubble-HEADLESS-1.png` | bubble with 1 and 6 approvals; bubble beside the pet on a 1.5× output | 392×250 / 392×460 / grim crop |
| `baseline/review-empty-*.png` | empty states (no sessions; Ollama unreachable) | both panels |
| `baseline/review-long-session-*.png`, `review-rich-reply-*.png` | 220-message session; long reply with code, lists, 12-column table, image, long URL and path | workspace 1040/720, compact |
| `baseline/review-approvals-{workspace,compact}.png` | six simultaneous approvals | 1040×780, compact |
| `baseline/review-transition-*.png`, `review-streaming-transition-*.png` | transition cycles, mid-stream | both |
| `baseline/review-live-compact-{DP-1,eDP-1,HDMI-A-1,HEADLESS-1}.png` | layer-shell compact panel on every output incl. 1.5× | 440×860 / 440×668 |
| `baseline/review-scale-*.png` | compact and workspace at dpr 1 / 1.25 / 1.5 / 2 and on 1366×768 @1.5 | see §2.5 |
| `baseline/review-workflow-*.png`, `review-midstream-*.png`, `review-broker-*.png` | workflows, streaming, broker restart | both |

### 2.1 Contrast (WCAG 2.2 AA; computed from `Theme.qml` and confirmed by sampling rendered pixels)

| Pair | Ratio | Threshold | Result |
| --- | --- | --- | --- |
| text `#edf5fc` on background / surface / raised / selected | 17.1 / 15.8 / 13.8 / 11.9 | 4.5 | pass |
| muted `#9aafc2` on background / surface / raised / selected | 8.3 / 7.7 / 6.7 / 5.8 | 4.5 | pass |
| cyan / success / danger / amber on background | 11.9 / 11.7 / 9.6 / 13.4 | 4.5 (3 for icons) | pass |
| accent `#149cff` on background | 6.5 | 4.5 | pass |
| **line `#263848` (control borders) on background / surface** | **1.56 / 1.44** | 3 | **fail** (Observed: sampled `#263848` at the composer edge) |
| **subtle `#192937` (separators) on background / surface** | **1.27 / 1.17** | 3 | **fail** (Observed: sampled under the tab row and the sidebar divider) |
| **raised / surface cards on background** | **1.24 / 1.08** | 3 | fail as a boundary; cards rely on fill only |
| **scrollbar thumb `#344c60` / hover `#658196`** | **2.1** / 4.6 | 3 | **fail** at rest |
| **primary button border `#235677`, danger `#704452`, dialog border `#36536a`, field hover `#426078`** | **2.2 / 2.2 / 2.3 / 2.8** | 3 | **fail** |
| composer focus border `#3275a0`, approval border `#867148` | 3.5 / 3.1 | 3 | pass |
| focus ring cyan 2 px (`CButton`, `CField`, `CCheckBox`, `CComboBox`) | ≥ 8.3 | 3 | pass |
| user bubble border `#203e54` on background | 1.7 | 3 | fail |
| 10 px footer text (muted) | 8.3 | 4.5 | pass, but 10 px is below any comfortable minimum |

### 2.2 Keyboard, focus and approvals (Observed, `review-approvals-keyboard.json`)

| Check | Result |
| --- | --- |
| Tab from the composer (compact) | **Stays in the composer and inserts `\t` five times** (focus trap) |
| Enter on a focused **Allow once** button | does not approve (6 → 6 pending) |
| Space on a focused **Allow once** | approves (expected keyboard activation) |
| Bubble initial focus | no control focused (root item), but the bubble **became the active window** when always-on-top is off |
| First Tab inside the bubble | read-only detail `TextArea`, not a button; Enter there does nothing |
| Escape with the rename dialog open | closes the dialog only |
| Escape on Settings | returns to Chat; Escape on Chat hides the window (documented) |
| Escape while a turn runs | turn continues (status stayed `waiting`/`working`) |
| Draft after Escape → reopen | retained |
| Compact panel initial focus on open | Shell root; the composer is not focused |
| Six pending approvals | every requester identified on workspace, compact and bubble |

### 2.3 Transitions (Observed, 10 cycles workspace → compact → workspace, always-on-top off so one process owns both; `review-transitions.json`)

| State | Before | After each switch |
| --- | --- | --- |
| Draft text | "Draft kept across surfaces" | kept (cycles 1–10) |
| Attachment | 1 | kept |
| Cursor / selection | 10, 6–10 | **0, none** on every switch |
| Search web checkbox | on | **off** after the first switch, never restored |
| Activity Panel expanded | on | **collapsed** (recreated Shell) |
| Top message at the viewport | message A | **different message in the compact panel** (pixel offset reused at another width), same message when returning to the same width |
| Focus | composer | **Shell root** (`focus:true`), i.e. nowhere useful |
| Other-session approval card | 1 | 1 on both; bubble hidden while a panel is visible |
| Visible windows | 1 | 1 (no duplicates, no orphaned bubble) |
| Mid-stream (reply streaming, user typing) | — | see §2.7 |

### 2.4 Responsiveness (Observed; `review-responsiveness.json`, frame-swap intervals on the 220-message workspace at 1040×780, reduced motion on; second sample from the earlier run with scene-graph logging in parentheses)

| Phase | Frames | p50 | p95 | max | > 33 ms |
| --- | --- | --- | --- | --- | --- |
| Streaming: 200 revisions of the last reply at 16 ms | 200 | 18.3 ms (16.7) | 25.6 ms (18.8) | 29.6 ms (25.9) | 0 |
| Scrolling: 120 programmatic steps across the transcript | 120 | 16.6 (16.7) | 27.1 (17.1) | 37.5 (25.5) | 1 (0) |
| Flick from top to end | 90 | 19.3 (18.6) | 25.2 (25.3) | 30.8 (26.5) | 0 |
| Resizing the workspace in 40 steps | 81 | 16.7 (16.7) | 20.2 (20.5) | 20.4 (24.8) | 0 |
| Key press → next frame (30 samples) | — | 1.3 ms (4.1) | 2.1 ms (19.3) | 8.9 ms (19.4) | — |
| Scene-graph render thread (`qt.scenegraph.time.renderloop`, 397 frames): frame total p95 12 ms, max 32 ms; swap p95 11 ms; sync max 13 ms; render max 10 ms | | | | | |

Frame pacing is healthy at scale 1 with the portrait/pet animation paused: one frame above 33 ms in 491 measured, no clusters. The animated (lively) case was not measured.

### 2.5 Sizes and scales (Observed)

| Output | Compact panel | Workspace | Notes |
| --- | --- | --- | --- |
| 1920×1080 @1 | 440×860 | 1040×780; 720×580 min OK | all controls inside horizontal bounds |
| 1920×1080 @1.25 (offscreen) | 440×812 | OK | — |
| 1920×1080 @1.5 (live HEADLESS-1 and offscreen) | 440×668 | 1040×640 | Qt reported `QScreen::devicePixelRatio` 2 on the live 1.5× output; text in the grim crop is crisp |
| 2560×1440 @2 (offscreen) | 440×668 | 1040×640 | — |
| **1366×768 @1.5 (offscreen "Short150", 910×512 logical)** | **440×460: conversation area ~30 px, tools row clipped and unreachable** (`review-scale-Short150-dpr2.25-compact.png`) | **831×432 forced below the 720×580 minimum; tools row clipped** | the minimum height exceeds the output |
| Tiled compact panel (always-on-top off) | 944×567 / 944×1145 | — | `question-form-compact.png` shows the question form hidden inside a 36 px conversation strip |
| Layer-shell panel follows the pet across DP-1 (y −1040), eDP-1, HDMI-A-1 and HEADLESS-1; bubble placed left of the pet with the tail at head height on the 1.5× output | | | `review-live-outputs.json` |

### 2.6 Long content (Observed)

- 220 messages load in one page (`hasOlder=0`, page budget 1 MiB) and scroll smoothly.
- The rich reply (60-line fenced code, 12-column table, 300-char URL, 250-char path, image): the message body is widened to the widest unbreakable line (1309 px) in all three sizes (viewport 700 / 648 / 366). **All prose lines in that message reflow to 1309 px**, so reading needs horizontal scrolling and the horizontal scrollbar is the default style, visible only on hover (`review-rich-reply-workspace-1040.png`).
- Long session title (≥ 80 chars) elides in the compact header with a tooltip only on the edit button; the sessions list elides with a tooltip (OK).

### 2.7 Workflows (Observed in the clean rerun; `review-workflows.json`, `review-workflow-*.png`)

| Workflow | Compact | Workspace | Notes |
| --- | --- | --- | --- |
| Compose with an attachment and **Search web** on, send | sent, composer/attachments cleared, Web reset | same | `review-workflow-compose-{compact,workspace}.png`; the attachment strip has no scrollbar and the third chip is cut at the edge (`review-workflow-attachment-limit-compact.png`) |
| Eight attachments, ninth refused | 8 kept, "Choose up to eight attachments." | — | limit message appears above the strip |
| Attachment near 20 MiB / over 20 MiB | 16.7 MB PNG accepted; 21 MiB file refused with "Choose a file smaller than 20 MiB" | — | `review-workflow-attachment-error-compact.png` |
| Read earlier messages while a reply streams | no forced scroll (`follow` turns off on movement, "↓ Latest messages" button) | same | `Chat.qml:198-202` |
| Stop mid-stream | Stop visible while working; turn ends `interrupted` | same | `review-workflow-interrupted-*.png` |
| Provider error | status `error`, red banner "Fixture failure" **and** the same text as a toast | same | duplicated message (F-25) |
| Answer an approval | Allow/Decline/Cancel on all surfaces; Enter does not approve | same | §2.2 |
| Create / switch sessions | `compactSessionNavigation`, `sessionContextActions` pass | pass | baseline |
| Handoff | dialog with provider, trust box, editable draft; creates the new session with the draft in the composer | same | `review-workflow-handoff-{,draft-}compact.png` |
| Change a setting | reduce-motion toggle round-trips | same | `review-workflow-settings-compact.png` |
| Desktop control | 1-minute timer started, feedback banner shown | same | `review-workflow-desktop-feedback-compact.png` |
| Broker disconnect mid-turn and restart | header "Reconnecting…", footer "Offline", toast "Cere is reconnecting to her session broker."; Stop and "Writing a response…" stay visible (stale) and the composer stays editable while Send is disabled; after the restart the turn is `interrupted` with the banner "Cere restarted. The previous turn was not replayed." | same | `review-broker-disconnected-{workspace,compact}.png`; the post-reconnect capture is missing because the harness expands through the broker (`review-broker-disconnect.json` has the state) |

### 2.8 Accessibility inventory (Observed with `QAccessible` active; `review-accessibility.json`)

| Surface | Controls | Missing name | < 24 px |
| --- | --- | --- | --- |
| workspace chat / desktop / settings / sessions | 42 / 68 / 154 / 44 | scrollbars only / scrollbars / **3 API key fields** + scrollbars / scrollbar | scrollbars only |
| compact chat / desktop | 53 / 58 | scrollbars | scrollbars |
| `CScrollBar` (every list and page) | 10 px track, 6 px thumb, no accessible name | | below 24 px |

Every button, field, checkbox, slider, spin box, combo box, session row, tab and the portrait has an accessible name and role; the attachment "Clear" button is named "×" below 480 px width. No screen reader was available (Orca/Accerciser not installed), so names were read through Qt's accessibility interface, not a real AT.

## 3. Findings

Severity: S1 workflow blocked / data lost / approval clarity; S2 accessibility failure or major friction on a common path; S3 inconsistency or friction on less common paths; S4 polish. Effort: S < 1 h, M hours, L ≥ 1 day. Frequency: how often a user meets it.

| ID | Surface | Category | Sev | Freq | Effort | Evidence | Capture | Files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-01 | transitions | state preservation | S1 | every switch | M | Observed | `review-transition-*.png`, `review-transitions.json` | `qml/Chat.qml:116-125`, `native/controller.cpp:540,610`, `broker/core.ts:169` |
| F-02 | approvals (all) | approval clarity | S1 | long titles | S | Observed | `permission-bubble.png`, `review-live-bubble-HEADLESS-1.png` | `qml/ApprovalCard.qml:159-174` |
| F-03 | compact | reachability / density | S1 | short outputs, HiDPI laptops, tiled mode | M | Observed | `review-scale-Short150-dpr2.25-compact.png`, `question-form-compact.png` | `qml/Chat.qml:169-300`, `qml/Shell.qml:137-237` |
| F-04 | compact (on-top off) | window behaviour | S2 | always, that mode | S | Observed | `review-empty-compact-chat.png` (944×567) | `native/controller.cpp:540-549,399,581` |
| F-05 | both | keyboard | S2 | every keyboard user | S | Observed | `review-approvals-keyboard.json` | `qml/Chat.qml:234-247` (+ other `TextArea`s) |
| F-06 | both | contrast | S2 | always | S | Observed | §2.1 | `qml/Theme.qml`, `CButton`, `CField`, `CScrollBar`, `CDialog`, `MessageCard` |
| F-07 | workspace | minimum size | S2 | HiDPI laptops | S | Observed | `review-scale-Short150-dpr2.25-workspace.png` | `native/controller.cpp:610` |
| F-08 | settings | accessible names | S2 | screen-reader users | S | Observed | `review-accessibility.json` | `qml/ApiConnection.qml:15` |
| F-09 | bubble (on-top off) | focus stealing | S2 | each approval | S | Observed | `review-approvals-keyboard.json` | `native/controller.cpp:575-584` |
| F-10 | both | long content | S2 | any reply with a long URL/path | M | Observed | `review-rich-reply-*.png` | `qml/MessageCard.qml:26-60`, `native/controller.cpp` `formatMessage` |
| F-11 | compact | density | S2 | always | M | Observed | `compact-clean-composer.png` | `qml/Shell.qml:141-236`, `qml/Chat.qml:128-160,290-300` |
| F-12 | both | discoverability / docs | S2 | always | S | Observed + Code-inferred | `compact-clean-composer.png`; `README.md:66` vs `Chat.qml:241-247` | `qml/Chat.qml:259,268`, `README.md` |
| F-13 | compact | focus on open | S2 | every open | S | Observed | `review-empty-states.json` | `qml/Shell.qml`, `native/controller.cpp:540` |
| F-14 | both | draft loss (race) | S2 | rare | S | Code-inferred | — | `qml/Chat.qml:117-125` |
| F-15 | settings | consistency | S3 | each visit | S | Observed | `settings-440x720-top.png` | `qml/Settings.qml:10-22,55-60` |
| F-16 | both | tokens / consistency | S3 | always | M | Observed (grep) | — | 15 QML files, `qml/Theme.qml` |
| F-17 | bubble | timing glitch | S3 | after closing a panel | S | Code-inferred + flake log | `/tmp/cere-ui-review-baseline-existing.log` | `qml/ApprovalBubble.qml:30-33` |
| F-18 | both | scrollbars | S3 | always | S | Code-inferred | `markdown-wide-table.png` | `qml/CScrollBar.qml`, `qml/MessageCard.qml:34` |
| F-19 | both | toast pushes layout | S3 | each toast | S | Observed | `markdown-wide-table.png`, `question-form.png` | `qml/Shell.qml:220-224` |
| F-20 | compact sessions | density | S3 | each visit | S | Observed | `compact-before-select-440.png` | `qml/SessionList.qml:182-228` |
| F-21 | tests | stale regression | S3 | CI | S | Observed | `/tmp/cere-ui-review-baseline-b.log` | `tests/ui.cpp` `compactPanelFitsEveryOutput` |
| F-22 | compact chat | truncation | S4 | long names | S | Observed | `context-drawer.png` | `qml/Chat.qml:211-224` (attachment chip) |
| F-23 | compact desktop | layout | S4 | narrow widths | S | Observed | `desktop-360x560-top.png` | `qml/Desktop.qml:60-87` |
| F-25 | both | duplicate messaging | S4 | each provider error | S | Observed | `review-workflow-error-compact.png` | `qml/Chat.qml:155-158`, `qml/Shell.qml:220-224` |
| F-26 | both | attachment strip | S3 | ≥ 3 attachments | S | Observed | `review-workflow-attachment-limit-compact.png` | `qml/Chat.qml:211-224` |
| F-27 | compact | accessible name | S3 | < 480 px | S | Observed | `review-workflow-attachment-limit-compact.png` | `qml/Chat.qml:254` ("×" Clear button) |
| F-28 | both | disconnected state | S4 | broker restarts | S | Observed + Code-inferred | `review-broker-disconnected-workspace.png` | `qml/Chat.qml` (`busy`, `saveDraft` guard), `qml/Shell.qml:63` |

Details for S1/S2:

- **F-01 Transition state.** Both panels are new `Shell` instances; only draft text, attachment ids and raw `contentY` cross via the broker. Lost on every switch: cursor and selection, the **Search web** choice (a user who toggled it and then expands sends without search), Activity Panel expansion, viewport anchor (compact and workspace differ in width, so the pixel offset lands on another message), and keyboard focus (lands on the Shell root). The fix needs a small per-session UI state record carried with the draft; in the default mode the two surfaces are different processes, so it has to travel through the broker draft payload (`session.draft`), which touches the IPC protocol — flagged for decision.
- **F-02 Approval header.** `ApprovalCard.qml:159-174` renders provider · title · id and the cwd in one `Text` with `maximumLineCount: 2` and `ElideMiddle`; any title that wraps pushes the project path out. In the bubble (`permission-bubble.png`) and compact panel the cwd line is gone; for command approvals it still appears inside the monospace detail, for question approvals it does not appear at all. Provider and session id stay visible. Fix: separate lines for title and path, path elided in the middle only, no line cap on the identity block.
- **F-03 Compact panel height budget.** Fixed chrome in the compact chat page: header 135 px, session title + provider rows 81, composer ≥ 130, tools row 38, footer 30, activity bar 44 when present, toast 44 when present. Measured conversation area (Observed, `review-scales.json`): 343 px at 440×860, 295 px at 812, 216 px at 668 (1.5× and 2× 1080p outputs), **24 px (the layout minimum) at 460** on 1366×768 @1.5 and in the tiled 944×567 window; at that size the tools row sits against the page viewport's clip edge with its icons cut (`review-scale-Short150-dpr2.25-compact.png`) and nothing scrolls to it. Question forms live inside the conversation list's footer, so at these heights a pending question is inside a 24–36 px strip (`question-form-compact.png`).
- **F-04 Tiled compact panel.** With always-on-top off the panel is an xdg `Tool` toplevel and `positionPanel` only calls `setPosition`, which Wayland ignores; unlike the pet (`controller.cpp:399`) and bubble (`:581`) nothing asks Hyprland to float or move it, so it is tiled at the compositor's size. README promises "normal floating-window behavior".
- **F-05 Tab inserts tabs.** `TextArea` keeps Tab as text input; Shift+Tab also stays. Keyboard users cannot reach Attach, Paste, Web, the microphone or Send without a mouse. Same for the handoff editor, question answers, personality and workflow editors.
- **F-06 Boundaries below 3:1.** Every control border, separator and card edge is between 1.1:1 and 2.3:1; the scrollbar thumb at rest is 2.1:1. Text contrast is fine throughout. A single `Theme.border` token at ≥ 3:1 on `background`, `surface`, `raised` and `input` (for example `#5b7189`: 3.7 / 3.5 / 3.0 / 3.6) and a thumb colour such as `#6b839c` (4.8:1) fix all of them in one place.
- **F-07 Workspace minimum.** 720×580 does not fit 1366×768 @1.5 (512 logical rows) or 1920×1080 @2 (540). Below 920 px wide the workspace already uses the compact layout, so a minimum of 720×520 with a scrollable chat column is safe.
- **F-09 Bubble focus.** With always-on-top off the bubble clears `WindowDoesNotAcceptFocus` whenever approvals are pending, and Hyprland focuses the new window: typing in another app lands in the bubble. Enter does not approve and nothing is focused by default, so the risk is interruption rather than accidental approval; in the default on-top mode the layer surface does not take focus.
- **F-10 Unbreakable lines widen the whole message.** `MessageCard.qml:48` widens the body to the widest line so tables and code stay readable, but prose then reflows to that width (1309 px here). Wrapping prose anywhere (`WrapAnywhere` for non-code blocks) while keeping code blocks and tables horizontally scrollable, with an always-visible themed horizontal scrollbar, keeps the documented "wide tables scroll horizontally" behaviour.
- **F-12 Send key.** README says Ctrl+Enter sends; the code sends on Enter (and Ctrl+Enter), Shift+Enter inserts a newline; the only hint is a 10 px "Shift+Enter · new line" shown at ≥ 480 px width, so the compact panel never shows it. Needs a decision (see §6) before either the code or README changes.
- **F-13 Focus on open.** Clicking the pet opens the panel with focus on the Shell root; the quick-ask path needs an extra click into the composer. Focusing the composer on open also starts the "listening" pose, which the README ties to composer focus.
- **F-14 Draft flush race (Code-inferred).** `saveDraft` returns early while a save is in flight (`Chat.qml:118-119`); `flushDrafts`/`Component.onDestruction` call it once, so an edit typed within 600 ms of a previous save and immediately followed by Expand (which deletes the view in the non-on-top mode) is lost until the user types again; `draftsStayCoherentAcrossComposers` does not cover this ordering.

## 4. Shared layout and interaction rules (to centralise in `qml/Theme.qml`)

- **Spacing scale:** 4, 8, 12, 16, 24 (`Theme.space1…space5`). Page margins: compact 12, wide 24; card padding 12 (compact) / 16 (wide); row spacing 8.
- **Type scale:** `caption` 11, `secondary` 12, `body` 13 (controls and messages in compact), `message` 14, `section` 15 semibold, `dialog` 18 semibold, `page` 22 semibold. Nothing below 11 px; the 9–10 px labels (approval badge, footer, question counters) move to 11.
- **Radius:** `radiusChip` 6, `radiusControl` 9, `radiusCard` 12, `radiusDialog` 16; the panel keeps 14.
- **Colour tokens to add:** `border` (≥ 3:1 on every surface, proposal `#5b7189`), `borderStrong` for dialogs (`#6b839c`), `scrollThumb` (`#6b839c`), `userBubble`/`userBubbleBorder`, `warningSurface`/`warningBorder` (the `#2b261e`/`#6b5836` family), `dangerSurface`/`dangerBorder` (`#33232e`/`#704452`), `approvalSurface`/`approvalBorder`, `codeSurface` (`#0d131c`), `overlayScrim`. Every literal outside `Theme.qml` maps to one of these.
- **Focus style:** 2 px `cyan` ring on every focusable control, including `TextArea`s, scrollbars, list rows and the portrait; focus never on an invisible root.
- **Keyboard:** Tab/Shift+Tab always leave text editors; Escape closes the innermost popup, then returns to Chat, then hides the panel; Escape never discards a draft or stops a turn; Enter never activates an approval button (Space does).
- **State patterns:** every list/page has loading, empty, error, disabled and interrupted states using the same banner component (one `StatusBanner` replacing the inline toast/paused/recovery/remote rectangles in `Shell.qml`), toasts overlay content instead of pushing it.
- **Minimum sizes:** compact 440×≥ 560 with the chat column scrollable below 640; workspace 720×520; at any size every section stays reachable by scrolling.
- **Motion:** page slide and new transitions respect `Theme.reducedMotion` and scale duration by `motionIntensity` (0 → no animation).

## 5. Staged plan

Each stage is one commit; after each: build (`tools/build.sh`), `npm test`, `npm run typecheck`, `QT_QUICK_CONTROLS_STYLE=Basic ./build/cere-ui-check` (full), new review slots as regressions.

**Stage 1 — S1 fixes**
1. F-01: add a per-session `uiState` (cursor, selection, webSearch, activityExpanded, anchor message id + offset within it) to the draft payload and `Chat.qml` load/save; restore scroll by message id (`positionViewAtIndex` + offset) instead of `contentY`; focus the composer after load. Files: `qml/Chat.qml`, `broker/core.ts` (`draft`), `broker/types.ts`, `broker/store.ts`. Verify: `reviewTransitions` snapshots equal before/after for all fields (new regression), `draftsStayCoherentAcrossComposers` still passes.
2. F-02: restructure the requester block (`ApprovalCard.qml`) into provider · id on line 1, title (elide right) on line 2, cwd (elide middle) on line 3, no line cap; same block reused by `CompletionCard`. Verify: `approvalsIdentifyTheirRequester` extended to assert the cwd text is visible on all three surfaces with a 120-char title.
3. F-03: compact chat column becomes height-aware: merge title + provider into one row, move the five conversation tools into an overflow menu when `chat.height < 640`, cap the activity bar, make the page scrollable when its content exceeds the viewport, and give pending questions a minimum visible height. Verify: new `reviewSurfacesAtScale` assertion that the tools row and composer are inside the window on every fixture output; `compactPanelFitsEveryOutput` updated to the 860 request.
4. F-04 (if approved in §6): float and move "Cere Panel" like the pet/bubble in the non-on-top mode, with min/max size set so Hyprland honours it. Verify: live check that the compact window is `floating` and 440×≤860 via `hyprctl clients`.

**Stage 2 — shared rules and tokens**
5. F-06, F-16, F-18: add the tokens in §4, replace the 40 literals, restyle `CScrollBar` (12 px track, ≥ 3:1 thumb, always-visible horizontal bar in `MessageCard`), apply the type and radius scales. Verify: a small `tests/qml` lint (no hex literals outside `Theme.qml`) and a contrast table recomputed in the report.

**Stage 3 — S2**
6. F-05: Tab/Shift+Tab move focus out of every `TextArea` (a shared `CTextArea` wrapper). Verify: `reviewApprovalsAndKeyboard` tab-chain assertion.
7. F-07: workspace minimum 720×520 and the same height-aware chat column. Verify: offscreen Short150 capture shows the tools row.
8. F-08: `Accessible.name` on the three API key fields. Verify: inventory shows 0 unnamed.
9. F-09: bubble keeps `WindowDoesNotAcceptFocus` until the pointer enters it or the user presses the tray/pet; keyboard answer remains available from the panels. Verify: `bubble is the active window` becomes false.
10. F-10: wrap prose anywhere while keeping code/table overflow; visible horizontal scrollbar. Verify: `review-rich-reply` body width equals viewport width, table viewport still overflows.
11. F-11 + F-19: shrink compact chrome (one header row, status in the header, toast as an overlay). Verify: compact conversation area ≥ 420 px at 860.
12. F-12 + F-13: show "Enter · send, Shift+Enter · new line" in both widths (or the chosen key), focus the composer on open, README updated. Verify: `compactProjectsAndEnterToSend` + new focus assertion.
13. F-14: queue a follow-up save when `saveDraft` is skipped for an in-flight request. Verify: new ordering case in `draftsStayCoherentAcrossComposers`.

**Stage 4 — S3/S4**
14. F-15 section order; F-17 bubble uses its own process's panel visibility; F-20 compact session rows use the context menu only; F-21 test assertion; F-22 chip name width; F-23 desktop header at narrow widths; F-25 one error surface (banner, no toast) per provider error; F-26 attachment strip with a visible scrollbar and wrap on wide panels; F-27 accessible name "Clear attachments" on the narrow Clear button; F-28 while disconnected, show the turn as "connection lost" instead of a live Stop/"Writing a response…" and flush the offline draft on reconnect.

## 6. Decisions needed before implementation

1. **Send key.** README documents Ctrl+Enter; the code sends on Enter. Keep Enter-to-send (and fix README + hint), or switch to Ctrl+Enter (and make Enter insert a newline)?
2. **F-01 transport.** Carrying cursor/selection/Web/activity/anchor across surfaces in the default mode requires extending the `session.draft` payload (broker IPC, listed out of scope). Approve that extension, or limit the fix to same-process transitions (always-on-top off) plus message-id scroll anchoring?
3. **Escape in the workspace.** Today Escape on the Chat page hides the whole workspace window. Keep (documented), or make Escape only clear selection/focus in the workspace and hide only the compact panel?
4. **Compact tools row.** Move Model / Handoff / Inbox / Memory review / Context into an overflow menu in the compact panel (frees 38 px and fixes reachability), or keep the row and make the page scroll?
5. **Non-on-top compact panel (F-04).** Float and size it through Hyprland dispatch like the pet, or document that it is an ordinary tiled window in that mode?
6. **Bubble focus (F-09).** Make the bubble never take keyboard focus on appearance when always-on-top is off (keyboard users answer from the panel), or keep today's behaviour?
7. **Focus on open (F-13).** Auto-focus the composer when the compact panel opens; this starts the "listening" pose immediately.
8. **Toast behaviour (F-19).** Overlay the toast on the content instead of inserting a banner that shifts the page.

## 7. Out-of-scope issues recorded (not fixed)

- `tests/ui.cpp` cascade crashes: a failed `click()` leaves `window` null and the next slot dereferences it (`ui.cpp:668`, `:55`); harness hardening only.
- QSG_RENDER_TIMING in Qt 6.11 prints through the `qt.scenegraph.time.*` logging categories; the README's instruction still works but the output format is the logging-category one.
- The Ollama fixture returns one fixed two-chunk reply, so streaming pacing was measured with incremental transcript revisions, not through the broker.
- `broker/core.ts` clears the draft after `session.send` whenever the draft revision is unchanged; sending via the API while a draft exists therefore empties the composer on all surfaces (matches the UI's own send path; noted for API users).
- Peer-session overlap: a second Claude session (cere-24) briefly ran the same harness at 10:37–10:39 and truncated `/tmp/cere-ui-review-live.log`; it removed its edits, and every number above comes from the clean rerun or from runs it did not overlap.

## 8. Not verified

- No screen reader (Orca/Accerciser not installed): names and roles were read through Qt's accessibility interface only.
- Only one theme and one style exist, so no cross-theme contrast run was possible.
- Mixed scale on the live compositor used a headless 1.5× output next to three 1.0× physical outputs; a physical fractional-scale display was not available. Qt reported an integer DPR on that output; sharpness was judged from a grim crop.
- Frame timing was measured with reduced motion on (quiet mode) to keep the pet/portrait animation out of the numbers; the animated case is not measured here.
- Attachments near the 20 MiB limit were tested with a generated PNG; real camera images were not used.

## 9. Harness changes made during Phase 2 (no product behaviour changed)

- `tests/ui.cpp`: ten `review*` slots (empty states, long content, approvals and keyboard, transitions, workflows, responsiveness, accessibility inventory, live outputs, surfaces at scale, broker restart) plus null guards in `item()`/`capture()`; they write `review-*.json` and `review-*.png` to `/tmp/cere-ui-evidence` and become the regression scenarios for Stage 1–3.
- `tests/fixtures/ui-codex.mjs`: `completion-rich[:imagePath]` prompt producing the long reply used above. `tests/fixtures/offscreen-scales.json`: dpr 1 / 1.25 / 1.5 / 2 outputs and a 1366×768 @1.5 output.
- Inert `objectName` hooks: `messageList` (`Chat.qml`), `activityPanel` (`Chat.qml`), `messageActions_<id>` (`MessageCard.qml`), `globalApprovals` (`Shell.qml`).
- Baseline captures copied to `docs/ui-review/baseline/`; after-captures will go to `docs/ui-review/after/` at the same sizes, scales and theme.
