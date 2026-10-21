# Desktop and mobile review: implementation and validation record

Implementation of `Cere_Desktop_Mobile_Review_and_Implementation_Instructions.md` (W01–W16) on branch `ui-overhaul`, starting from the reviewed commit `6ea5ce3`, recorded 2026-10-20. Nothing was pushed or published, no repository setting was changed, and the installed Cere application and broker were not touched. The owner's uncommitted work in the same checkout (delegation completion ping, Alia avatar and related edits) stays uncommitted and is not part of these commits or artifacts.

**Machine.** CachyOS rolling, Linux 7.2.11, x86_64, Qt 6.12.0, Hyprland 0.56.2; Node 26.11.1 (system), 24.22.0 and 26.8.2 (official builds, SHA-256 verified); Codex CLI 0.163.0, Claude Code 2.1.303, Ollama 0.34.4, `agy` 1.4.3; Android emulators API 37 and API 36. Desktop checks ran in `tools/test-virtual-desktop.sh` (private Hyprland under Cage on the Intel GPU; no access to the working desktop). The session ran at `SCHED_IDLE` while a game, a JVM and `llama-server` held much of the CPU, and the machine rebooted once at 16:49; timing-sensitive checks were judged against unmodified HEAD under the same conditions.

## Commits

| # | Commit | Subject | Packages |
| --- | --- | --- | --- |
| 1 | `6637073` | Keep the backup-denial and gateway fixtures valid as root and on replacement | W01 (F01, F02) |
| 2 | `ba2ae84` | Bound desktop delivery to slow clients and release job wait listeners | W02, W03 (F03, F04) |
| 3 | `b91298c` | Shut the broker down in order and detect a frozen broker in the interface | W04 (F02, F05) |
| 4 | `2f7c19b` | Give the phone the desktop's semantics with protocol 1.1 | W05, W07–W11, W15 (desktop and broker) |
| 5 | `a6c1a7f` | Bring the Android companion to protocol 1.1 and record the feature matrix | W02, W05–W12, W15 (Android), W11 |
| 6 | `f2cca95` | Check the avatar catalog from atlas headers and isolate broken artwork | W13 (F13) |
| 7 | `3cef010` | Prove chat survives absent services and keep restores from stalling | W14 |
| 8 | `7ee8750` | Gate releases on evidence for the exact APK and make CI results meaningful | W01, W16 (F14, F18) |
| 9 | `7f14fe4` | Document the review implementation for owners and phone users | docs |

## Findings

| ID | Priority | Status | Commit | Change | Evidence |
| --- | --- | --- | --- | --- | --- |
| F01 | P1 | Fixed; CI confirmation needs a push | `6637073`, `7ee8750` | The backup-denial case skips as root with its reason; deterministic failures through `Canonical.copyStore` (directory cannot be created, disk fills mid-copy, copy is not a database) leave the store unchanged; CI runs application steps as an unprivileged user. | `tests/memory-migration-backup.test.ts` (reproduced under a namespaced uid 0: the old assertion failed; now 6 pass, 1 skipped as root) |
| F02 | P1 | Fixed | `6637073`, `b91298c` | One reverse-order resource stack in the remote fixture; gateway close is idempotent and drains owned work before Core closes; Core keeps its store open until running changes settle. | `tests/remote.test.ts` "a phone that disconnects after Core closed…" (fails without the fence with `database is not open`), "gateway close is idempotent…"; `tests/shutdown.test.ts` |
| F03 | P1 | Fixed | `ba2ae84` | Bounded per-client and global delivery, coalescing, resync event or close at the limit. | `tests/fanout.test.ts` (8 cases; all 8 fail on the old code) |
| F04 | P2 | Fixed | `ba2ae84` | `abortableDelay` removes its listener when either the timer or the abort settles. | `tests/jobs.test.ts` (2 cases; fail on the old code) |
| F05 | P1 | Fixed | `b91298c` | Per-request records, liveness ping, unresponsive state, deadlines; each request ends once; late answers ignored. | `tests/ui.cpp` `frozenBrokerEndsRequestsOnceAndRecovers` |
| F06 | P1 | Fixed | `a6c1a7f` | Bounded inbound frames, size checks before retention, replies on the reader thread, coalesced upserts per connection generation. | `InboundFramesTest` (4) |
| F07 | P2 | Fixed | `2f7c19b`, `a6c1a7f` | `activity.page`, search continuation with every match named, hydration without a silent cap. | `mobile-conformance.test.ts`, `ConformanceTest`, `ConversationContentTest` |
| F08 | P2 | Fixed | `2f7c19b`, `a6c1a7f` | Message sources as accessible actions; the desktop's citation setting applies to display and copy. | `CitationsTest` (shared 35-case corpus), `ConversationContentTest` |
| F09 | P2 | Fixed | `2f7c19b`, `a6c1a7f` | Memory scope is the project on its granted memory server for every provider; typed history, correction, conflict, identity and episode operations. | `remote.test.ts` "project memory is shared across provider conversations…", "the phone reviews an assertion history…" |
| F10 | P2 | Fixed (AntiGravity withheld with reason) | `2f7c19b`, `a6c1a7f` | Hosted and compatible APIs run from a phone with `providers.api` and a per-provider grant bound to the endpoint origin; Claude Code history import in restricted mode. | `remote.test.ts` "hosted API providers run from a phone only with a per-provider grant…"; `ProviderTraitsTest` |
| F11 | P1 investigation | Fixed | `a6c1a7f` | `ReadFence` (desktop, connection generation, cache epoch) on every screen read. | `CacheIntegrityTest.aReadIsCurrentOnlyOnTheSameDesktopConnectionAndTranscriptEpoch`, `ReconciliationTest` |
| F12 | P1 investigation | Fixed except process-death instrumentation | `a6c1a7f` | Durable saves fail visibly, atomic image writes, orphan cleanup on restore, classified cache failures, a late-confirmed send clears only its own text. | `CacheIntegrityTest` (3), `ReconciliationTest`; process-death fault injection on a device is not built |
| F13 | P2 | Fixed | `f2cca95` | Header-only catalog validation; broken artwork set aside only after a full load confirms it. | Measured 8.4–10.0 s / 783 MiB → 9–13 ms / 42 MiB (offscreen, this machine); `avatarpuppet.cpp` `validationOnlyChecks`, `ui.cpp` `avatarFailureReportsNeedConfirmation` |
| F14 | P1 release gate | Fixed; CI confirmation needs a push | `7ee8750` | Paired CI job and `tools/mobile-paired-check.ts` assert every checkpoint. | Local paired check on API 37 (see Android validation) |
| F15 | P1 completion gate | Implemented; hardware gates remain | `2f7c19b`, `a6c1a7f` | Phone captures, desktop draft attachments, memory workflows, diagnostics and the companion views of the feature matrix. | `docs/FEATURE-MATRIX.md`, `tests/feature-matrix.test.ts` |
| F16 | P1 completion gate | Open | — | Memory stays experimental. The recorded rerun's predicate precision is 88.9% against a 95% gate; the representative evaluation needs a production-domain corpus, models and billed cloud calls. | `docs/memory/implementation-report.md`, `docs/memory/evaluation.md` |
| F17 | P2 | Fixed | `2f7c19b`, `a6c1a7f` | Agents and approvals use opaque HMAC references; protocol 1.1 negotiates features and names the build; golden response and event fixtures in both languages. | `mobile-conformance.test.ts`, `ConformanceTest`, `tools/mobile-contract.ts --check` |
| F18 | P1 release gate | Fixed; publication is the owner's | `7ee8750`, `7f14fe4` | Signing requires an evidence record for the exact unsigned APK, signer, commit, desktop build, device and gates. | `tests/mobile-release-evidence.test.ts`; `docs/mobile/release-evidence/README.md` |

## Work packages

| Package | Status | Done | Not done, and why |
| --- | --- | --- | --- |
| W01 CI | Done locally | Unprivileged application steps, split jobs behind gates, reports and skip reasons, paired emulator job, root-proof fixtures, reverse-order teardown; `actionlint` clean | Both workflows green on one commit needs a push (owner) |
| W02 Delivery bounds | Done | Bounded desktop fan-out with resync; bounded Android receive with generation-bound coalescing | Gateway-side coalescing for slow phones: a phone over 8 MiB buffered is closed and reconciles on reconnect (unchanged design) |
| W03 Job waits | Done | `abortableDelay`; other waits audited | — |
| W04 Shutdown and liveness | Done | Ordered bounded shutdown with a recorded result; gateway drain; liveness, deadlines, exactly-once request endings | — |
| W05 Shared semantics | Done | State/outcome table (`docs/CONVERSATION-STATES.md`), shared activity words, waiting labels, delegated ancestry, exactly-once retirement, queue explanations | Attributed queue admission into a desktop-owned Ollama turn is explained, not implemented (by design: one writer per turn) |
| W06 Android fencing and recovery | Done except fault injection | Read fences, durable saves, atomic blobs, orphan cleanup, cache failure classes, late-confirmed sends | Process-death fault injection on a device; repository split into components |
| W07 Browsing and rendering | Done | Activity paging, search and hydration continuation, sources, citation setting, copy | — |
| W08 Provider policy | Done | Broker-owned traits and order; API providers on the phone with per-provider, origin-bound grants; AntiGravity withheld with reason; no-cost CLI protocol checks | Live provider turns per CLI version (billed for Claude and the APIs) |
| W09 Memory | Done except evaluation | Shared scope for all providers; typed history, correction, conflict, identity, episode; receipts | Representative evaluation (F16): corpus, models and billed calls needed |
| W10 Attachments, capture, controls | Done | Phone captures, desktop draft attachments, dispatch fix, dependency diagnostics, private Hyprland/PipeWire/MPRIS fixtures, script revalidation | Camera, Photo Picker and file-picker uploads on the target device |
| W11 Feature matrix | Done | `docs/FEATURE-MATRIX.md` with every surface and F01–F98, generated operation index, consistency test; gaps implemented (pins, style, results/schedules, portrait, workspace, health, Open on desktop, Claude history) | Rows marked desktop-only or not built carry their reasons |
| W12 Pairing and connectivity | Partial | Network loss handled per network (`ConnectionPolicyTest`); existing pairing, replacement and command-ledger behavior retained and tested | Target-phone checks: biometrics, LAN/VPN/cellular moves, sleep/wake, Doze, notification channels, GrapheneOS/no-Play, API 30–37 permission matrix |
| W13 Desktop UI and avatar | Done for startup and isolation | Header-only catalog validation (measured), confirmed broken-avatar isolation, offscreen UI suite at several scales | Multi-output hotplug, compositor restart and accessibility review on target hardware |
| W14 Services gate | Done | `docs/SERVICES-GATE.md`; `degraded-services.test.ts`; restore stall fixed | Items needing hardware listed there (Bluetooth, Kitty, suspend) |
| W15 Protocol | Done | 1.1 with features and build identity, opaque agent refs, golden fixtures decoded in Kotlin, contract completeness check | — |
| W16 Release gate | Done except owner steps | Evidence-bound signing, 16 KiB check, metadata, staged install check, Node floor tested, candidate artifacts with hashes and SBOM | Release signing, device gates, fresh install/upgrade on the target phone, package install/rollback on the desktop, publication |

## Integration scenarios (brief §6)

*Verified* means an automated check exercises the scenario end to end against real broker code (fixture providers, private desktop or emulator); *partial* names what is covered and what is not; *blocked* needs hardware, accounts or owner action.

| Scenario | Status | Evidence |
| --- | --- | --- |
| Desktop creates a conversation; the phone opens it, sends; the desktop continues | Verified | `remote.test.ts` (scoped snapshots, sends, ordered transcript); paired emulator check (`ConnectedDesktopTest`, synthetic Ollama conversation) |
| Phone creates a restricted conversation; the desktop changes settings while the phone edits | Verified | `remote.test.ts` "native remote session configuration is explicit, revision-bound, and reauthorized"; `ReconciliationTest` draft conflicts |
| Rapid sends while Ollama works; an agent needs input | Verified | `remote.test.ts` "mobile Ollama follow-ups queue with signed deduplication…"; `send-queue.test.ts` |
| Both clients answer the same request | Verified | `remote.test.ts` "approval answers retire exactly once across the phone, the desktop, withdrawal, digests, retries and reconnects" |
| The desktop withdraws or changes a request during the phone's biometric prompt | Verified (fixture); biometric prompt itself on device only | same test (digest conflict), "changed capture approvals stay reviewable…" |
| CLI bypass on/off with remote grants present/absent | Verified | `send-queue.test.ts` "remote CLI bypass approves only authorized permission requests, keeps launch restrictions, and never answers questions" |
| A desktop draft with attachments; the phone edits or sends | Verified | `remote.test.ts` "the phone reviews a desktop draft's attachments, keeps or removes them explicitly, and sends them by digest" |
| Phone process dies during send, upload or approval | Partial | `ReconciliationTest` (staged replacement survives process death), `CacheIntegrityTest` (crash leaves orphans that restore removes); an instrumented kill during each stage is not built |
| Network drops after an external effect, before acknowledgement | Verified | `remote.test.ts` "provider acceptance followed by lost acknowledgement is unknown…", "partially executed scripts are unknown…" |
| Broker crashes before/after the ledger commit and provider dispatch | Verified | `remote.test.ts` "accepted operations become unknown after restart"; `send-queue.test.ts` restart recovery; `broker-restart.test.ts` |
| The interface closes while the broker continues | Verified | `ui.cpp` `reconnectRecoversTranscriptAndFailsPendingRequests`; `broker-restart.test.ts` |
| The broker stays connected but freezes | Verified | `ui.cpp` `frozenBrokerEndsRequestsOnceAndRecovers` |
| A slow desktop client, or a phone overwhelmed by streaming | Verified | `fanout.test.ts` (slow and frozen clients, many messages, revisions of one, two clients), `InboundFramesTest` |
| Search or Activity beyond page limits | Verified | `mobile-conformance.test.ts`, `ConversationContentTest`, `remote.test.ts` |
| Memory forgotten during a full-message, memory or page load | Verified | `remote.test.ts` "erasure epoch also removes retained command content…"; `CacheIntegrityTest` read fences; `workspace.test.ts` "forgetting scrubs derived drafts…" |
| A grant reduced or revoked during reads, uploads or actions | Verified | `remote.test.ts` "mobile permission reduction is revision-bound…", "media binary upload validates content and scope; revoke purges submitted files"; `review-core.test.ts` F-001 |
| Missing provider, expired credentials, removed model, malformed stream | Verified | `api-providers.test.ts` (HTTP failures, credentials, malformed tool arguments, context ceilings), `remote.test.ts` "provider failure before acceptance preserves draft…" |
| Memory, projection or embedding service down | Verified | `degraded-services.test.ts`, `core.test.ts` recall deadline, `knowledge.test.ts` embedding outages |
| Bluetooth or output device change during speech | Partial | `audio-devices.test.ts` (a new speaker stops speech without replaying it); real Bluetooth hardware not exercised |
| Window, player, file or script changes after review | Verified | `desktop-hyprland.test.ts`, `desktop-services.test.ts` (private Hyprland, PipeWire, MPRIS), `review-core.test.ts` changed or stopped script |
| The desktop sleeps; the phone changes LAN, VPN or cellular route | Blocked (device) | `ConnectionPolicyTest` covers losing an unrelated network only |
| Phone notifications disabled, screen locked, Doze | Blocked (device) | — |
| Foreground monitoring explicitly stopped | Blocked (device) | — |
| Large font, TalkBack, keyboard, mixed DPI, rotation | Partial | desktop mixed scales in the offscreen UI suite (`offscreen-scales.json`); phone accessibility on the target device not run |
| Migration, backup or restore with a disk fault | Verified | `memory-migration-backup.test.ts`, `recovery-races.test.ts` |
| Upgrade from the previous distributed desktop build and APK | Blocked (owner) | needs the distributed 0.1.3 install on a device and the release signer |

## Validation of the final candidate

Final tree `7f14fe4` (tree `92014389`), built and tested in a clean worktree holding only these commits. Commands ran inside `tools/test-virtual-desktop.sh` unless marked *host*.

| Check | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | Passed (incremental, 24 s) |
| Types | `npm run typecheck`; `npx tsc -p tsconfig.mobile.json` (*host*) | Both exit 0 |
| Protocol contract | `node tools/mobile-contract.ts --check` (*host*) | Exit 0; also enforces that `CONTRACT.json` documents all 76 operations and 16 features |
| Test suite, Node 26.11.1 | `npm test` | 783 tests: 760 passed, 0 failed, 23 skipped |
| Test suite, Node 24.22.0 | `node --test tests/*.test.ts` | 783 tests: 760 passed, 0 failed, 23 skipped |
| Test suite, Node 26.8.2 (CI pin) | `node --test tests/*.test.ts` | 783 tests: 760 passed, 0 failed, 23 skipped |
| Native tests | `ctest --test-dir build --output-on-failure` | 4 of 5 passed; `avatar` (GPU) fails as on unmodified HEAD |
| Offscreen interface suite | `QT_QPA_PLATFORM=offscreen:configfile=tests/fixtures/offscreen-scales.json QT_QUICK_BACKEND=software ./build/cere-ui-check` | 100 passed, 1 failed (`reviewTransitions`, fails identically on HEAD under the same load), 9 skipped (need the live compositor or a real Spotify player); 52.5 min |
| Workflow lint | `actionlint -shellcheck=…` on `.github/workflows/*.yml`; `shellcheck tools/ci-user.sh tools/build-node-addons.sh` | Clean |
| Android gates | `gradlew-quiet.sh mobile/android :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug :app:lintRelease :app:lintDev :app:assembleDebug :app:assembleDebugAndroidTest :app:assembleRelease :app:assembleDev` (*host*) | 76 unit tests (22 protocol, 48 data, 6 app), 0 failures; lint 0 errors (29, 30, 30 warnings); 4 APKs |
| SBOM | `--no-configuration-cache -I ../../tools/mobile-sbom.gradle :app:mobileSbom` (*host*) | CycloneDX 1.5, 154 components |
| Instrumentation, API 37 | `:app:connectedDebugAndroidTest` on emulator `cere_review_api37` | 30 tests, 0 failures, 8 skipped (paired tests without arguments) |
| Paired phone-to-broker, API 37 | `node tools/mobile-paired-check.ts --serial emulator-5600` | Passed: SAS matched, USB pairing and `ConnectedDesktopTest`, 5 of 5 checkpoints, one desktop user row for the send |
| Instrumentation and paired check, API 36 | same, emulator `cere_review_api36` | 30 tests, 0 failures, 8 skipped; paired check passed 5 of 5 |
| Optimized build | install and launch the R8 dev APK on API 36 | `MainActivity` resumed, no fatal exception, not debuggable, versionCode 1004, minSdk 30, targetSdk 37 |
| Staged install | `python3 tools/install-user.py --prefix build/review-stage`; `node tools/check-install.ts build/review-stage 7f14fe4…` (*host*) | No problems; build identity `7f14fe4`, not modified |
| Installed broker | staged broker on a private profile: start, `cli.ts state`, `health.inspect`, `cere remote status`, SIGTERM | Socket in ~1 s; provider order present; health names build `7f14fe4`, `source: installed`, no missing programs; SIGTERM exit 0 with `last-shutdown.json` confirmed |
| Package | `makepkg -d -f` (dependency check skipped: LayerShellQt is a local build here); `check-install.ts` on the package root | Built in 55 s; no problems; `nodejs>=24.22.0` |

The 23 skipped suite tests are 22 artwork checks that need the local, git-ignored `artwork/` sources and the opt-in IndexTTS synthesis test.

**Each commit on its own.** Every commit was archived and checked standalone (typecheck, contract from commit 4, full suite in the private desktop): commit 1, 739 tests, 0 failed; 2, 747, 0; 3, 754, 0 (plus a native build and the frozen-broker UI test); 4, 776, 0; 5, 779, 1 (the fan-out pacing test, hardened in commit 7); 6, 779, 0 (plus a native build, the software avatar check and the new avatar-failure UI test); 7, 780, 0; 8, its committed tree's run stalled (below); its code is the final tree's, which differs only in documentation.

**Unresolved observations.** Under the same foreground load, two full-suite runs of these commits (of about twenty) stalled: once in `audio-devices.test.ts` (commit 4) and once after all 16 `review-core.test.ts` tests had reported (commit 8), when a diagnostic report showed one worker thread still alive and keeping the process from exiting. That commit-8 run also reported a failure of this work's new test "W10 a saved script changed or stopped after review never runs", whose details were lost when the stalled run was stopped. Alone, `audio-devices.test.ts` passed, `review-core.test.ts` passed 3 of 3 and the W10 test 15 of 15; four full runs of HEAD and six of the final tree (three Node versions, three comparison runs) did not stall; the cause is not determined. An idle-machine run and CI will show whether either recurs.

## Artifacts

In `build/review-impl/artifacts/` of the checkout (git-ignored; not published), built from `7f14fe4`. `SHA256SUMS` there lists:

| File | SHA-256 | Notes |
| --- | --- | --- |
| `cere-desktop-7f14fe49c3c1-x86_64-staged.tar.gz` | `3c826e9593ad735e316d94ec81b604e43f8312a0736de7ca4fd089bb2bd456fa` | Staged per-user install (`install-user.py --prefix`), 1.44 GB |
| `cere-0.1.0-1-x86_64.pkg.tar.zst` | `c153e3139f687284878f0752708e721803a5db1b4d418e630a0d798deb2f0b7e` | Arch package (built, not installed) |
| `cere-mobile-7f14fe49c3c1-release-unsigned.apk` | `997b785f4f832cb1f0fa1d76e09e2fff59a3dbd109a45fde6848a46f7a02defc` | `dev.otectus.cere.mobile` 0.1.4 (1004), minSdk 30, target 37, unsigned, 16 KiB aligned |
| `cere-mobile-7f14fe49c3c1-dev.apk` | `605948191897ca2e92d1ddd44066f721527048ab25421f7c12be0b62ac251b62` | R8, `…mobile.debug`, debug signer `3aac2955…562b` |
| `cere-mobile-7f14fe49c3c1-debug.apk` | `fb4a926d8c75ced2fc148013a7a5bafb52e3c9228b9345cea40ca92f0568e1cc` | debug signer `3aac2955…562b` |
| `cere-mobile-7f14fe49c3c1-debug-androidTest.apk` | `06032f3dfa74f86baf18acd72f0099eda5262b69bc79b5554032d0698d51ba77` | instrumentation |
| `cere-mobile-7f14fe49c3c1-sbom.cdx.json` | `5af173a7b911f49995b6954d7fbe20b119f8bd898397b3359c2938946d42dc7e` | CycloneDX 1.5 |
| `release-evidence-template-mobile-v0.1.4.json` | `cae5c8164e9a345eed85d9ba62392ac49f6d65b8b3ee1177859a434f41302173` | every gate `not-run`; to be completed on the target phone |

Logs of every check above are in `artifacts/logs/`; paired-check evidence in `build/review-impl/paired-api37-final/` and `paired-api36-final/`.

## Defects found while implementing and validating

Each was reproduced, fixed and covered by a test that fails without the fix, unless noted.

| Defect | Where | Fix | Test |
| --- | --- | --- | --- |
| Hyprland dispatch reported "window not found" (exit status 0) as success | `broker/desktop.ts` | Dispatch output must be `ok` | `desktop-hyprland.test.ts` (vanished window refused, focus unchanged) |
| A pinned conversation read replies to phone-started turns aloud on the desktop | `broker/core.ts` `finishReply` | No speech for `session.remote` | `pinned-replies.test.ts` (failed on the old code: the reply was spoken) |
| Claude Code was described as having no history import although the desktop imports it | `broker/provider-catalog.ts` | Trait corrected; phone import added in restricted mode | `remote.test.ts` (Claude history ticket, restricted policy) |
| Restore staging could wait 30 s for an asynchronous SQLite backup under load | `broker/graph-memory/canonical.ts` | Synchronous `VACUUM INTO`, as backups already used | `recovery-races.test.ts` (seen once on Node 26.8.2 under load; passes since) |
| The broken-avatar hook set healthy avatars aside during ordinary switching (introduced and caught within this work) | `qml/GesturePlayer.qml`, `native/controller.cpp` | Report only persistent errors; the controller acts only for the shown avatar after a full load confirms | `ui.cpp` `avatarFailureReportsNeedConfirmation` (fails on the earlier code with two spurious switches); `avatarThemeSwitching` |
| The new-conversation dialog ordered providers alphabetically (introduced and caught within this work): the state reaches QML as a key-sorted map | `qml/NewSession.qml`, `broker/core.ts` | The broker sends `providerOrder` as a list | `ui.cpp` `apiProviderSetup` (failed on the earlier code, passes on HEAD and now); `provider-traits.test.ts` |
| A test-file write clobbered `tests/activity-labels.test.ts` in the working tree during implementation | — | Restored from HEAD before committing; additions appended | `activity-labels.test.ts` (both cases) |

## Pre-existing failures and load-dependent flakes

| Check | Result | Evidence that it is not caused by this work |
| --- | --- | --- |
| `ctest` `avatar` (GPU) | Fails: "wider cards must preserve silhouette and ground", once per avatar | Fails identically (20 times) on unmodified HEAD built and run under the same private desktop (`head-ctest-avatar.log`); `avatar-software` passes |
| `state fan-out is paced…` (`core.test.ts`) | Occasionally saw a third, unrelated snapshot under load | Commit 7 keeps the test's intent (no intermediate burst title, one trailing snapshot) while tolerating one late background snapshot |
| `A04 transcribing a file…` (`jobs.test.ts`), `F-005 recall and chat prompts…` (`review-service.test.ts`) | Failed once each in a full run while a game, a JVM and `llama-server` held the CPU and the session ran at `SCHED_IDLE` | Both pass 3 of 3 alone; neither file's subject is changed by this work; F-005's flake is recorded from 2026-10-17 |
| Long offscreen UI runs | Rows of `avatarThemeSwitching` timed out waiting for a message body after many switches under the same load | The same rows pass on HEAD and on the final tree when run as a shorter selection |

## Owner steps

1. **Review and push** `ui-overhaul` (`6637073`..`7f14fe4`, plus this record) when satisfied; CI then shows whether both workflows pass on one commit (W01) and runs the paired emulator job on API 30 and 35, the minimum and an intermediate level this machine had no image for.
2. **Install on the desktop** when no reply is running: quit the interface (`node broker/cli.ts ui.quit`), `python3 tools/install-user.py`, `systemctl --user restart cere-broker.service`, then start the interface. The working tree also contains your uncommitted delegation-ping and Alia work; installing from the working tree includes it, installing from a checkout of `7f14fe4` does not.
3. **Phone:** install the dev or debug APK on the target phone and run the hardware gates in `docs/mobile/TESTING.md` (biometrics, LAN/WireGuard/cellular moves, sleep/wake, Doze and notifications, TalkBack and large fonts, camera and picker uploads, no-Play behavior, upgrade from 0.1.3). Record them in `docs/mobile/release-evidence/mobile-vX.Y.Z.json` from the template; the release job signs nothing without it.
4. **Release:** configure the protected `mobile-release` environment and signing secrets, then tag. Publication stays your decision.
5. **Memory:** a representative extraction evaluation (production-domain corpus, models, billed calls) is still needed before memory loses its experimental label.
6. **Disk:** this btrfs volume has no unallocated space (data chunks hold about 116 GiB free; metadata 7 of 10 GiB), and metadata exhaustion stopped writes once during this work. A filtered balance such as `sudo btrfs balance start -dusage=20 /` returns unallocated space so metadata can grow.
