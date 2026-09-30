# Mobile implementation and validation

This is a development implementation of the mobile plan, not a claim that every roadmap phase or external-release gate is complete. Unsupported operations are omitted from capability negotiation. Use the matching broker; a desktop without this gateway cannot pair.

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
| F12–F16 | Reviewed handoff draft, rename/disconnect, streaming/status, Stop and conflict-preserving drafts implemented. |
| F17 | Native list/follow behavior is present; durable per-session pixel/scroll-anchor parity is not complete. |
| F18–F20 | Four-image encrypted drafts/upload, selectable CommonMark, code copy and horizontally scrolling tables implemented. Remote image display is tap-to-open; task syntax remains selectable text. |
| F21–F22 | Safe tapped HTTP(S) links and literal Activity implemented. Mail links and specialized desktop-file link actions are not exposed. |
| F23–F28 | Global Inbox, digest/revision-bound approvals, typed supported question/forms and deny/Stop for unsupported forms implemented. Oversized or unsafe proposals require desktop review. |
| F29–F30 | Claude positive approvals require a remotely owned restricted session and the provider approval grant. Saved capture preview/consent works for immutable Ollama inputs; native image Allow is withheld. |
| F31–F32 | Foreground monitoring/private approval notifications implemented. Complete parity for every desktop notice channel remains to be exercised on hardware. |
| F33–F42 | Capability-gated apps/files/windows/workspaces/audio/media/timers controls implemented. Exact desktop recent-card/search layout is adapted for touch. Real Hyprland/MPRIS action-and-restore checks remain. |
| F43–F44 | Initiating capture jobs and phone crop/annotation are not implemented. Existing saved approval previews are available as above. |
| F45–F46 | Approved immutable scripts can run; adding/editing executables stays desktop-only by design. |
| F47–F49 | Delegated work inherits remote restrictions; ordinary permission summaries and Ollama behavior remain broker-owned. Unsafe native providers are withheld. |
| F50–F56 | No remote privilege expansion/bypass/token exposure. Pause and self-revoke implemented. Individual category/grant reduction UI is not complete; desktop edits/revocation work. |
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

- Owner-device biometric enrollment/invalidation, locked-start/unlock and locked-screen receipt, reboot/profile behavior, camera/SAF and process-killed upload recovery. Pairing authentication, cold-launch key retention and granted API 37 local-network access passed as recorded above.
- Mobile-data WireGuard reconnect, screen-off/doze notifications and measured latency/battery behavior; no-Play validation on the owner's installed OS.
- Real harmless Codex/Ollama approval workflows, simultaneous phone/desktop choices, and provider-policy failure behavior. Never test a real effect by replaying an unknown command.
- Isolated real Hyprland/MPRIS/window/timer/script operations with state restoration; implementation of unported plan features before claiming full parity.
- TalkBack, 200% fonts, landscape/cutouts and lock-screen privacy on target hardware.
- Permanent signing identity, APK signature verification, arm64 R8 fresh install and previous-version update, Obtainium filtering, dependency notices, protected GitHub environment and publication review.

The APK is installable for development. Do not describe it as the complete roadmap or a release-certified build while these limitations remain.
