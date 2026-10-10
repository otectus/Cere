# Mobile implementation and validation

This is a development implementation of the mobile plan, not a claim that every roadmap phase or external-release gate is complete. Unsupported operations are omitted from capability negotiation. Use the matching broker; a desktop without this gateway cannot pair.

## Review remediation (0.1.4 / 1004, 2026-10-09)

Addresses the 2026-10-09 completeness review. A request timeout no longer ends snapshot reconciliation; a 30-second WebSocket ping detects a stalled desktop; only certificate/pin mismatches, revocation, incompatible versions and persistent refusals stop reconnection, and clock skew no longer fails sign-in. Unknown outcomes are listed in Settings for review; an uncertain answer blocks only its own request and is dropped after the next snapshot. Camera access is requested in context and captures are full size; discarded uploads return to Upload; shares ask for a conversation. The app shows full desktop history, searches the desktop, and clears Unread on open. Notification permission is requested at pairing; request alerts post once; replies, problems and timers have their own channels; a request notification opens that request. Cache writes are batched and I/O moved off the main thread. The `dev` build type produces a non-debuggable R8 development snapshot, the update check is channel-aware, and CI gains an emulator job. Desktop controls, provider disconnect and readable errors complete the phone surface; the broker adds `sessions.read`, `notice` forwarding and a pairing-response file loader.

Validation from the current source:

- `/home/otectus/Projects/.mcmod-tools/gradlew-quiet.sh mobile/android :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug :app:lintRelease :app:lintDev :app:assembleDebug :app:assembleDebugAndroidTest :app:assembleRelease :app:assembleDev`: passed. **53 unit tests** (10 protocol, 38 data, 5 app), 0 failures; lint reported 0 errors on all three variants (30 warnings, mostly newer dependency versions). Log `~/.cache/cere-mobile-review/logs/gradle-android-:core:protocol:test-20261009-185255.log`.
- `npx tsc -p tsconfig.mobile.json`, `node tools/mobile-contract.ts --check`, and `CERE_TTS_DISABLED=1 node --test` over the nine files the mobile CI job runs: **140/140 passed**. Log `~/.cache/cere-mobile-review/logs/final-broker-gate.log`. `qmllint` passed for `qml/RemoteSettings.qml`.
- APKs (SHA-256): debug `a6e221f04144010fbc8682943951be6e2ef96025144044e8d51c7fb2de8d6804`, development `fa440714ec98d2412188a96d7fb825c859cf94be98b432ded4863448680892b8`, unsigned release `1a2b2a4a2a1301dc416e2a51c994a2f1ac5fe4e4990fe25b75f906d729d07c45`. The development APK is not debuggable, exports no debug-only activities, is signed by the same certificate as 0.1.3 (`3aac2955…562b`) and passes 16 KB `zipalign -P 16`.
- Android 17 / API 37 x86_64 emulator with 16 KB pages, an isolated broker and fixture providers, trusted-phone pairing over `adb reverse`:
  - 0.1.3 upgraded in place to 0.1.4: pairing, open conversation and unsent draft kept; no StrictMode violation at startup. The development build then upgraded the debug build in place, sent and received a reply, and its update check reported no newer development snapshot.
  - Frozen broker: the phone left Online about 50 s after the freeze (previously still Online at 127 s); after the broker was killed and restarted it reconnected unaided in 21 s, and a desktop rename appeared in about 5 s. A Deny sent during the freeze left no stuck request; a new request in the same conversation was answerable. An access reduction sent during a freeze was listed under Unconfirmed desktop actions and blocked replacement until acknowledged.
  - Phone clock 150 s ahead and 300 s behind: Online. Background monitoring off: the open app stayed Online, disconnected about 30 s after leaving the screen and reconnected on return.
  - A request notification was posted once and not re-posted during a 40-chunk stream (previously 11 times in 25 s); reply, problem and timer notices arrived on their own channels; tapping a request opened it highlighted in the Inbox; Deny from the notification during a freeze reported "Deny not confirmed yet" without an ANR. The same stream wrote the encrypted cache 8 times in 16 s (previously 44 times).
  - Camera with access denied showed a message instead of crashing; with access allowed a 1392×1856 capture was imported and its temporary file deleted. After the desktop cleared retained images, Send reported it, the image returned to Upload, and re-upload and send succeeded. Web search turned off after an accepted send.
  - Messages back-dated eight days displayed; with 221 extra sessions, search found `Bulk 001` and all ten `Bulk 01x`; opening an unread conversation cleared Unread on the desktop.
  - Share reached the running activity, asked for a conversation, survived rotation and did not replay after cancel. Back returned from the scanner, Memory and replacement pairing. The New conversation dialog and its title survived rotation.
  - 200% text with the keyboard open kept the top bar, part of the conversation and the message field visible (the window had previously been panned as well as padded; the activity now uses `adjustResize`); approval actions wrapped; the pairing offer's Verify button scrolled above the keyboard.
  - Desktop tab: status, timers, saved scripts, windows and apps loaded independently; the saved echo script ran through a signed action; a timer was started, cancelled, started again and fired. Volume, playback, window, workspace, app and file actions were not run because they would act on the live desktop session.
  - `:app:connectedDebugAndroidTest`: 11 tests, 7 passed, 4 hardware-only tests skipped by design, 0 failures. A fresh development install asked for notification and local-network permission while pairing and reached Online with monitoring running.
- Not covered: physical devices and Android 11–16, biometric-mode pairing and key invalidation, TalkBack, Doze and lock-screen delivery, a real share-sheet sender (Android refused the shell-granted media URI and the app showed that refusal), the update check's positive path, desktop UI interaction with **Load response file…**, and a run of the new CI emulator job. Background monitoring still does not restart by itself after an app update or reboot; Settings shows it off.

Correction to the review: it stated that CI built only `assembleDebug`. `mobile-check.yml` already ran `lintRelease` and the R8 `assembleRelease`; what was missing was any emulator or instrumentation run.

## Approval recovery and desktop rate limits (0.1.3 / 1003, 2026-10-01)

Android now retires the exact signed approval after a confirmed answer or `APPROVAL_GONE`, filters delayed snapshots so they cannot restore that request, and refreshes revision conflicts without replaying the action. Capture previews and validation state reset when the proposal digest changes. The broker distinguishes changed captures from ended requests and removes time-based read, action, reconnect, history and memory limits; concurrent-operation limits, signature checks and scopes remain enforced.

- Isolated `npm test`: **463 passed, 0 failed, 1 skipped** (the optional IndexTTS inference test), `/tmp/cere-permission-fix/full-tests-final.log`. The initial run exposed a missing model in the new rate-limit fixture; that fixture was corrected before this passing full run. Focused `node --test --test-reporter=tap tests/remote-rate-limits.test.ts tests/remote.test.ts tests/remote-process.test.ts tests/send-queue.test.ts`: **44/44 passed**, `/tmp/cere-permission-fix/final-broker-tests.log`.
- `npm run typecheck`, `node tools/mobile-contract.ts --check`, `git diff --check`, and `npm run build`: passed. Desktop build log: `/tmp/cere-permission-fix/desktop-build.log`.
- Offscreen Basic-style `build/cere-ui-check activityAndPermissionBubble approvalsIdentifyTheirRequester`: **4/4 passed** including setup/cleanup, `/tmp/cere-permission-fix/ui-check.txt`.
- From `mobile/android`, `./gradlew --offline --gradle-user-home /tmp/cere-android-gradle -Dorg.gradle.java.home=/usr/lib/jvm/java-17-openjdk :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest`: passed, including the final rebuild after independent review caught a stale preview cache. **40 unit tests, 0 failures**; XML evidence is under each module's `build/test-results/`, lint under `app/build/reports/lint-results-debug.html`.
- APK package `dev.otectus.cere.mobile.debug`, version **0.1.3 / 1003**; the verified signing certificate matches the preceding development APK. The download is a development prerelease, separate from stable signing/update-checker gates. Physical upgrade/instrumentation is unverified for this build because no Android device was attached. The running broker was not restarted by this publication task; desktop rate-limit changes require loading the updated broker.

## Remote access and trusted-phone mode (0.1.2 / 1002, 2026-10-01)

Implemented desktop-selected signed trusted-device pairing, separate prompt-free Android action keys, negotiated policy checks, same-identity replacement with encrypted staged recovery, pending-operation migration gates, and recoverable broker ownership transfer. Gateway listeners now retry transient interface/bind failures without disabling access or cancelling accepted turns. Desktop settings can renew the certificate/endpoints while retaining the desktop and TLS keys.

Validation completed before runtime activation:

- `CERE_TTS_DISABLED=1 node --test tests/remote.test.ts tests/remote-process.test.ts`: **32/32 passed**, including listener outage/recovery, retired-listener errors, trusted signature enforcement, active-session replacement and simulated restart recovery. Log `/tmp/cere-remote-access/broker-tests.log`.
- `npm run typecheck`, `node tools/mobile-contract.ts --check`, and `/usr/lib/qt6/bin/qmllint --unqualified disable -I qml qml/RemoteSettings.qml`: passed. The disabled QML category is the existing injected `App` context warning.
- Android protocol/data/app unit tests, debug lint, debug APK and instrumentation APK assembly: **37 tests passed**. Exact Gradle command and output: `/tmp/cere-remote-access/android-build.log`.
- Installed **0.1.2 / 1002** and its test APK on the Pixel. All **five ConversationContent** hardware tests passed after updating Espresso 3.7.0 and runner 1.7.0. The combined run's old-pairing connection check failed: Wi-Fi was disabled; reconnect then obtained `.224` while the legacy LAN firewall grant still targeted `.221`. This is not recorded as a successful online compatibility run. Logs `/tmp/cere-remote-access/phone-compatibility.log` and `/tmp/cere-remote-access/phone-existing-pairing.log`.
- Both devices joined Tailscale. Phone-to-PC TCP 8443 passed on Wi-Fi and with Wi-Fi disabled on cellular; a listening TCP 8444 was blocked. This is transport/firewall evidence only. Log `/tmp/cere-remote-access/network-check.log`.

Runtime delivery completed on the owner's Pixel 10 Pro on 2026-10-01. The first deferred activation updated the broker but lost USB device enumeration before pairing; recovery now waits for ADB and resumes an already active broker without another restart. Restarting the phone's Tailscale process cleared its stale disconnected UI while preserving its account. Excess diagnostic reconnects also hit the gateway's five-attempts-per-minute limit; the delivery checks now allow that budget to refill.

- `UsbPairingSetupTest#resumeStagedPairing`: passed, including recovery after deliberate app process death between desktop confirmation and phone commit. Log `/tmp/cere-remote-access/pairing-resume.log` (the final rerun additionally verified the already committed identity).
- `UsbPairingSetupTest#verifyExistingPairing`, with `cereRequireCellular=true` and a synthetic `sessions.create`: passed. Validated cellular and VPN networks were required, Wi-Fi was off, and the separate trusted action key signed without user authentication. Log `/tmp/cere-remote-access/cellular-keys-and-action.log`.
- `ConnectedDesktopTest`, with `cereRequireCellular=true` and the new synthetic session: passed. Pinned TLS reads, live `CERE_MOBILE_OK` reply, command reconciliation, revision-bound pin/archive and restore, and disconnect/reconnect passed. The check now waits up to 45 seconds for asynchronous ledger reconciliation after message delivery. `:app:assembleDebugAndroidTest` passed; log `/tmp/cere-remote-access/test-rebuild.log`. Hardware log `/tmp/cere-remote-access/cellular-live-send.log`.
- Background monitoring passed, temporary instrumentation was removed, and the normal app displayed **Online / Connected to Cere Desktop**. Desktop `remote.status.connected` matched the trusted replacement device. Wi-Fi remained off, matching its state before this recovery.

`/tmp/cere-remote-access/delivery-result.json` records `complete: true`, cellular verification, trusted sensitive action, live reply, reconnect and background connection. Recovery transcript: `/tmp/cere-remote-access/activation-recovery.log`. This validates remote access on the owner's installed development build; the broader release gates below remain separate.

## Desktop compatibility update (0.1.1 / 1001, 2026-09-30)

Android now shows desktop pin/archive/unread/folder state, filters archived conversations, and offers revision-bound rename, pin and archive controls. A conversation settings dialog supports model/effort changes for phone-owned Codex/Claude/Ollama sessions and Ollama tool settings. The broker rechecks ownership, scope, revision, busy state, active agents and pending approvals; configuration cannot elevate an unbound desktop conversation's tool authority. API providers and AntiGravity retain their explicit desktop-only execution policy.

Per-turn web search is available for granted Ollama conversations when enabled on the desktop. Personality/search settings can be saved without an Ollama-host grant. Desktop attachment drafts are identified and blocked from phone overwrite/send until reviewed on the PC. An older broker that does not report attachment state requires a restart before phone sends; local edits remain on the phone. The app reports its installed version in the handshake.

Validation run from the current source:

- `ANDROID_HOME=$PWD/.android-sdk GRADLE_USER_HOME=/tmp/cere-android-gradle JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest :app:lintRelease :app:assembleRelease` — passed, **33 unit tests**, both lint variants and debug/test/unsigned R8 release APKs. Log: `/tmp/cere-mobile-compat-final-android.log`.
- `CERE_TTS_DISABLED=1 node --test tests/remote.test.ts` — **26/26 passed**, including ownership/CAS, async revocation and attachment refusal. `npm run typecheck` and `node tools/mobile-contract.ts --check` passed. Log: `/tmp/cere-mobile-compat-remote.log`.
- `CERE_TTS_DISABLED=1 node --test tests/session-models.test.ts tests/core.test.ts tests/interactions.test.ts tests/run-completions.test.ts` — **50/50 passed**. Log: `/tmp/cere-mobile-compat-core.log`.
- Independent review identified and corrected a local-session tools authority issue before final validation.

The existing Pixel 10 Pro pairing reconnected to the running desktop after its disabled gateway was enabled and an administrator-authenticated UFW rule allowed `192.168.1.218 → 192.168.1.204:8443` on `wlan0`. The phone subsequently disconnected from USB **before installation**. Version 0.1.1 has **not yet been installed or instrumented on the phone**. The debug APK is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`, SHA-256 `dab7f54ed09e729fe2870f41bc91dc9b2c8fb86f86e5ebb9f16b9de57da408b7`.

Matching broker files are staged under `~/.local/share/cere`; the previous files are backed up in `/tmp/cere-mobile-compat-runtime-backup`. Activation requires restarting `cere-broker.service` after this agent turn because the broker owns the current provider process. Remaining delivery checks: reconnect/unlock the phone, restart the broker, install the debug and instrumentation APKs with `adb install -r`, then run `UsbPairingSetupTest#verifyExistingPairing`, `ConversationContentTest`, and the explicitly invoked `ConnectedDesktopTest`. The latter accepts `cereExpectedDesktopId` and an optional `cereSmokeSessionId` for an unused, tools-disabled Ollama conversation whose title starts with `Cere mobile validation `; it checks scoped reads, an actual phone-signed send/reply, organization round-trip and reconnect. These physical and live-provider checks have not been run for 0.1.1. Existing roadmap and hardware limitations below remain.

## Session continuity, reduced grants, and attachment review (2026-09-30)

Conversation reading positions are now stored per session in the encrypted private cache. The saved record uses a stable message ID plus its pixel offset, so switching conversations, process recreation, and loading an older page restore the same reading anchor. Sessions still in follow mode return to the newest message. Scope reconciliation removes positions for sessions the phone can no longer access.

Settings can reduce this phone's current capabilities, action categories, scripts, projects, and Ollama hosts when the broker negotiates `permissions.reduce`. The form starts with the authoritative `devices.self` grants, allows only subsets, shows every removal before submission, and binds the request to `expectedScopeVersion`. The durable command ledger handles a disconnect during the scope change; the UI stays pending until reconnect and command reconciliation. Access can only be added from the desktop.

Photo Picker images, camera photos, shared images, and screenshots or image files selected through Android's document UI remain encrypted locally and must be reviewed from the exact optimized private copy before upload is enabled. Upload and send enforce the reviewed marker in the repository as well as the UI. The attachment still uses the existing bounded `attachments.begin` / binary chunks / `attachments.commit` pipeline.

Focused automated checks cover stable-anchor restoration, bounded fallback when an anchor was forgotten, encrypted-cache round trips, and migration of existing attachments to an unreviewed state. Hardware validation still needs to exercise session switching and process recreation, each capture source and rejection path, TalkBack labels, and a real scope reduction that disconnects and reconnects the phone.

Validation for this change:

- `./gradlew :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest`: passed; **29/29 unit tests**, debug lint, the debug APK, and the instrumentation APK all completed. Lint report: `mobile/android/app/build/reports/lint-results-debug.html`.
- `./gradlew :app:lintRelease :app:assembleRelease`: passed, including R8. Log: `/tmp/cere-mobile-parity-release.log`; lint report: `mobile/android/app/build/reports/lint-results-release.html`.
- `node tools/mobile-contract.ts --check`: passed with the negotiated `permissions.reduce` contract.
- `adb devices -l` reported no attached device. Instrumentation, physical capture sources, TalkBack, process-death restoration, and live permission-reduction reconnect were not run for this change.

## Mobile refinement and connection diagnosis (2026-09-29)

The owner's failed mobile Ollama sends were confirmed in the installed broker's command ledger as `REVISION_CONFLICT`, interleaved with successful `drafts.put` operations. The phone now serializes draft saves before signing, preserves newer typing during acknowledgements, and prevents delayed snapshots/session hydration from rolling draft revisions backward. The broker reports send acceptance only after provider acceptance; preflight failures preserve the draft, and post-dispatch uncertainty is retained without replay.

Ordinary message sends no longer invoke BiometricPrompt: the phone signs the exact challenge using its existing connection key. Other sensitive actions keep per-use authentication. Welcome negotiation detects an older broker and asks for its update/restart without clearing the draft.

Chat and Activity now use separate filtered pages/surfaces with live revision merging, latest-first expandable tool output, complete-output loading, initial/streaming chat follow, and a Latest control that respects reading older messages. New conversations open immediately; model discovery can be refreshed after failures, and Claude availability is gated by actual restricted-mode CLI support.

Validation for this refinement:

- `npm test`: **177/177 passed**; `/tmp/cere-send-auth-node-tests.log`. The remote/process tests passed **24/24**, including exact connection-key sends, rejection of altered/reused proofs, and action-key enforcement for other mutations.
- `npm run typecheck` and `node tools/mobile-contract.ts --check`: passed; `/tmp/cere-mobile-final-typecheck.log`, `/tmp/cere-mobile-final-contract.log`.
- API 36 isolated emulator: **6 instrumentation tests passed**, including chat/activity separation, streaming updates, initial follow, and preserving user scroll before using Latest. Log: `mobile/android/app/build/reports/final-conversation-emulator-instrumentation.log`. Component-only screenshots are in `app/build/reports/screenshots/conversation-timeline-api36.png` and `activity-panel-api36.png`; they are fixture rendering, not the complete production shell.
- Isolated real broker over pinned TLS: authenticated create, draft CAS, passwordless connection-key-signed send, and final replies passed for **Ollama `gemma4:31b-cloud` and Claude `haiku`** using only the synthetic `CERE_MOBILE_OK` prompt, with tools and memory disabled. Log: `/tmp/cere-mobile-passwordless-live-smoke.log`; isolated broker evidence: `/tmp/cere-mobile-live-smoke-qTAjsE/broker.log`. No existing user session was used for inference.
- Final Android gate: **22 unit tests passed**, debug/release lint and debug/test/R8 release assemblies passed. Log: `mobile/android/app/build/reports/mobile-passwordless-final-gate.log`. APK hashes are recorded in `mobile/android/README.md`.
- Upgraded the physical Pixel in place; **1 USB instrumentation test passed**, proving retained pairing, connection-key signing without authentication, sensitive-action key authentication requirements, and LAN Online/project sync. Log: `mobile/android/app/build/reports/phone-passwordless-key-and-connection.log`.
- Build verification initially found five missing parent/BOM metadata checksums. Each cached file was compared byte-for-byte with a fresh Maven Central download before adding its exact SHA-256; strict dependency verification remained enabled for the passing gates.

USB diagnosis of the Pixel 10 Pro found that DHCP changed its Wi-Fi address from `192.168.1.215` to `.216`, while the PC's scoped TCP 8443 rule still allowed only `.215`. After owner-authenticated addition of the matching rule for `.216`, the original phone pairing reconnected and both the app and broker reported Online. A subsequent cold app launch also reached Online automatically, and the latest debug APK was installed with the original pairing/cache intact. No pairing/cache reset was needed. Reserve the phone's address at the router to prevent recurrence.

## Earlier implementation evidence (superseded by the refinement gate above)

On 2026-09-29, `npm test` passed **165/165** tests, including the new remote tests and the concurrently maintained repository regression suites. Output: `/tmp/cere-mobile-full-tests.log`. The focused remote pair of files passed **15/15**: `node --test tests/remote.test.ts tests/remote-process.test.ts`, output `/tmp/cere-mobile-remote-tests.log`.

The remote integration suite runs a real isolated broker process and local peer-credential socket, offline pairing, pinned TLS/P-256 authentication, a fixture Codex approval, disconnect/desktop answer/reconnect, exact Unicode transcript recovery, broker crash during an external effect, durable unknown outcome/deduplication, revocation and listener shutdown. Other regressions cover changed-input signatures, native/global-bypass restrictions, stale drafts, bounded Unicode parts, post-accept failure, media validation, scope-result redaction, handoff draft-only semantics, interrupted history discovery and bounded memory work. It uses temporary state and fixture providers; it performs no billed inference or personal-desktop actions.

`npx tsc -p tsconfig.mobile.json` and `node tools/mobile-contract.ts --check` pass. The general repository `npm run typecheck` currently reports strict-nullability/indexing errors in concurrently added `tests/review-memory.test.ts` and `tests/review-benchmark.test.ts`; those unrelated files are preserved. This is not represented as a passing whole-repository typecheck.

Native desktop builds and focused Qt navigation/draft/personality tests were run during implementation. An unrelated-settings CAS problem in the personality editor was corrected; its rerun passed. Updated artifacts and exact Android gates are recorded in [`mobile/android/README.md`](../../mobile/android/README.md), including API 36 emulator launch/pairing evidence. Do not reuse an artifact hash after subsequent source changes without rebuilding.

The Android gate is:

```sh
./gradlew :core:protocol:test :core:data:testDebugUnitTest \
  :app:lintDebug :app:lintRelease :app:assembleDebug \
  :app:assembleDebugAndroidTest :app:assembleRelease
./gradlew --no-configuration-cache -I ../../tools/mobile-sbom.gradle :app:mobileSbom
```

The owner's **Pixel 10 Pro, API 37**, was updated and paired over LAN on 2026-09-29. Physical Keystore authentication, matching six-word SAS, pinned TLS authentication and an authoritative project/session sync passed. A separate cold-process verification passed with both signing aliases intact. After removing the temporary instrumentation package, the normal app showed **Online** and desktop `remote.status.connected` contained the same phone. Logs: `/tmp/cere-phone-install/usb-pairing-repaired.log` and `/tmp/cere-phone-install/usb-connection-verified.log`, each `OK (1 test)`. No live provider inference or desktop effect was invoked.

Hardware validation found and fixed a startup race: the pairing screen could prune committed keys before encrypted cache restore finished. Cleanup now requires restored state, restore is serialized and published atomically, and monitoring/network callbacks preserve an existing connection attempt. Missing keys produce terminal recovery guidance before opening a socket. Protocol tests passed **5/5**, data tests **8/8**, and debug/release lint plus debug/test/R8 release assembly all passed in `mobile/android/app/build/reports/phone-fix-android-gate.log`. The final debug APK SHA-256 is `8ee806353ec6be9337c4417a09d5d7061cf9c01c79a6e480fcf4e4a2502c56d5`.

Setup also required an owner-authenticated UFW rule restricted to the phone's LAN IP, desktop interface/address and TCP 8443. The device received all supported capabilities/categories and project grants for `/home/otectus/Projects`, `/home/otectus/Projects/cere`, and `/home/otectus/Projects/cere/mobile`. File/provider access beneath a granted directory is recursive; visibility of existing sessions currently requires an exact granted working directory. This does not automatically grant every future nested session. Ordinary desktop policy still applies.

## Plan inventory disposition

IDs refer to [`MOBILE_PLAN.md`](../../mobile/MOBILE_PLAN.md). “Implemented” here describes source behavior, not a substitute for hardware/provider validation.

| Plan rows | Current disposition |
| --- | --- |
| F01–F03 | Native desktop-colored navigation, connection banners and searchable sessions implemented. |
| F04–F08 | Scoped create/catalog/model/effort/Ollama tools controls implemented. Claude creation is gated on detected restricted-mode, strict MCP configuration, and manual permission support. |
| F09–F10 | Single-use stopped-Codex history import and linked-session read-only restrictions implemented. Claude historical import is withheld. |
| F11 | Linked-terminal focus shortcut is not implemented. |
| F12–F16 | Reviewed handoff draft, rename and idle provider disconnect, streaming/status, Stop and conflict-preserving drafts implemented. |
| F17 | Native list/follow behavior and encrypted per-session message-anchor/pixel-offset restoration are implemented. |
| F18–F20 | Four-image encrypted drafts/upload with exact local preview before upload, selectable CommonMark, code copy and horizontally scrolling tables implemented. Remote image display is tap-to-open; task syntax remains selectable text. |
| F21–F22 | Safe tapped HTTP(S) links and literal Activity implemented. Mail links and specialized desktop-file link actions are not exposed. |
| F23–F28 | Global Inbox, digest/revision-bound approvals, typed supported question/forms and deny/Stop for unsupported forms implemented. Oversized or unsafe proposals require desktop review. |
| F29–F30 | Claude positive approvals require a remotely owned restricted session and the provider approval grant. Saved capture preview/consent works for immutable Ollama inputs; native image Allow is withheld. |
| F31–F32 | Foreground monitoring and private request alerts implemented; each request alerts once. Completion, error/interruption and timer notices use separate Android channels with redacted lock-screen copies, and the conversation open on screen is not alerted. Delivery during screen-off/Doze remains to be exercised on hardware. |
| F33–F42 | Capability-gated controls implemented: app launch, file open by path inside the project, window focus and non-following move, workspace switch, volume slider and mute, playback, and timer list/start/cancel. Each list loads on its own. Desktop recent-action cards are not ported; search filters apps, windows and scripts. Real Hyprland/MPRIS action-and-restore checks remain. |
| F43–F44 | Initiating capture jobs and phone crop/annotation are not implemented. Existing saved approval previews are available as above. |
| F45–F46 | Approved immutable scripts are listed with their exact command, folder and time limit and run bound to the reviewed definition digest; adding/editing executables stays desktop-only by design. |
| F47–F49 | Delegated work inherits remote restrictions; ordinary permission summaries and Ollama behavior remain broker-owned. Unsafe native providers are withheld. |
| F50–F56 | No remote privilege expansion/bypass/token exposure. Pause, self-revoke, and revision-bound subset reduction for device/project grants are implemented; adding grants remains desktop-only. |
| F57–F64 | Personality/default-model revision editing, one-shot search and existing broker research controls implemented. Server/credential/private-endpoint edits stay desktop-only. Dedicated search-provider Settings UI is incomplete. |
| F65–F69 | Scoped browse/recall, saved-note create/edit and source records implemented. Existing desktop collectors/retrieval remain authoritative. |
| F70–F74 | Full temporal claim/witness/correction/conflict/identity/episode forms are not implemented. Generic graph/admin forwarding is deliberately unavailable. |
| F75–F76 | Reviewed forget/clear, exact selection/revision, transcript/cache invalidation and scoped erasure-status backend implemented. Large graph maintenance is rejected by a conservative worker quota. |
| F77–F80 | Full sanitized diagnostics/workspace cards are not implemented. Backend configuration, collector/privacy expansion and maintenance stay desktop-only. |
| F81–F84 | Existing desktop collectors continue under their desktop policy; no phone collectors or additional collection authority are introduced. Their complete diagnostics UI is not ported. |
| F85–F88 | Desktop-only/dependency-deferred administrative features remain so. |
| F89–F90 | Authoritative desktop persistence and no-replay crash recovery implemented; encrypted phone cache is derivative. |
| F91–F98 | Desktop pet/window/roaming/autostart/quit behavior remains local. Cere's generated static face and touch controls are implemented. Foreground animated gestures and independent animation preference controls are not implemented. |

Architecture adaptations: AES-GCM Keystore-encrypted bounded file cache instead of Room/SQLCipher; authoritative resnapshot instead of incremental journal replay; on-demand Unicode text parts instead of atomic event-fragment assembly; local identity reset/re-pair instead of signed online certificate rotation. Long desktop/memory commands retain their RPC while the durable ledger handles uncertain disconnections; generalized accepted background jobs remain future work.

## External release gates still required

- Owner-device biometric enrollment/invalidation, locked-start/unlock and locked-screen receipt, reboot/profile behavior, camera/Photo Picker/SAF attachment review and process-killed upload recovery. Pairing authentication, cold-launch key retention and granted API 37 local-network access passed as recorded above.
- Per-session scroll restoration across process death and older-page insertion, TalkBack review of capture and permission controls, and an actual grant reduction followed by command-ledger reconciliation and reconnect.
- Mobile-data WireGuard reconnect, screen-off/doze notifications and measured latency/battery behavior; no-Play validation on the owner's installed OS.
- Real harmless Codex/Ollama approval workflows, simultaneous phone/desktop choices, and provider-policy failure behavior. Never test a real effect by replaying an unknown command.
- Real Hyprland/MPRIS window, workspace, volume, playback, app and file actions with state restoration (timers and saved scripts were exercised against the isolated review broker only); implementation of unported plan features before claiming full parity.
- TalkBack, 200% fonts, landscape/cutouts and lock-screen privacy on target hardware.
- Permanent signing identity, APK signature verification, arm64 R8 fresh install and previous-version update, Obtainium filtering, dependency notices, protected GitHub environment and publication review.

The APK is installable for development. Do not describe it as the complete roadmap or a release-certified build while these limitations remain.
