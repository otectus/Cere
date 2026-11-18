# Repository remediation implementation record

This work applies `Cere_Repository_Remediation_Spec.md` to the existing `ui-overhaul` checkout at `c99b682af7fe6b8316400201369117b3a64f71b3`, preserving its pre-existing uncommitted changes. The audit baseline is `c65798e21338b4cbec9f686e6e2fb619e8b141ef`. This record describes the fixes and their evidence; it does **not** certify exhaustive repository coverage or release readiness.

## Implemented finding corrections

| Finding | Implementation and regression evidence |
| --- | --- |
| AUD-001 | Settings preparation commits a validated narrow patch into current state, rechecks revision/identity, and persists settings plus revision in one synchronous transaction. Nested explicit changes and validation-induced changes merge; arrays replace. Telemetry reconfiguration is ordered. Mobile forwards its expected revision. `tests/core.test.ts` exercises delayed validation, pause preservation, and competing revisions. |
| AUD-002 | Admission owns an AbortController before preparation awaits, including mobile disconnect. Stop and shutdown abort preparation; attachment, preflight, extension, memory, collection and dispatch continuations check it. The preflight barrier regression verifies zero sends and retained text, then a new explicit send. |
| AUD-003 | Deletion reserves admission before disconnect. Send, model changes and queue draining refuse that reservation. Close failure retains the owned adapter and an explicit incomplete-deletion error; sends stay fenced and deletion can be retried. Late callbacks retain generation fencing. |
| AUD-004 | Notes use actual host/model route evidence, refreshed on execution and each outgoing round containing new note results. Unknown/cloud routes require explicit cloud consent. `tests/notes-route.test.ts` uses two fake servers with one alias and changes the alias's route after reading. |
| AUD-005 | Collection packets carry collection revisions, scope identities, binding generation and route evidence. Retrieval, CLI dispatch and every HTTP/tool round validate authority; actual HTTP acceptance checks it again synchronously. |
| AUD-006 | Durable ingestion journals precede canonical observation calls. Cancellation/restart reconciliation accounts for unpublished generations. Deletion waits for indexing, fences new publication, and issues exact-scope Forget with its real receipt. |
| AUD-007 | File proposals serialize commits per canonical target, recheck confinement and content, use no-replace creation, and run async validation plus a synchronous authorization check immediately before writing. Conflicts preserve the target; temporary files are cleaned. |
| AUD-008 | `process-group.ts` signals detached owned groups, escalates independently of leader exit and bounds verification. RPC providers, custom commands and extension processes use it. A real descendant ignoring TERM is killed after its leader exits. Confirmation is explicitly limited to the process group; detached descendants and remote work remain unconfirmed. |
| AUD-009 | Unselected snapshot rows omit draft content, while `session.hydrate` returns it intact. The composer waits for hydration; revision checks protect text and view state. Whole snapshots have a 12 MiB UTF-8 budget; oversized fields use revision-bound `state.field` pages. Session pages reject changed-order cursors. Native framing drains legal frames before enforcing the residual limit. Tests cover 210 maximum Unicode drafts, oversized aggregate fields, combined legal frames exceeding 16 MiB, and oversized unfinished frames. |
| AUD-010 | Extension operation digests bind configuration, credentials, process generation, tool schema and arguments. Changes retire pending approvals. Custom tools also bind definition and credential revisions. |
| AUD-011 | Normal operations have complete previews and immutable digests. Oversized operations are rejected before approval: note diffs above 1,500 lines or 64 KiB; extension/custom previews above 48 KiB. File/extension/custom Allow requires explicit review completeness in the backend and desktop. Older incomplete requests remain declineable. |
| AUD-012 | Zod is pinned to 4.6.7 with matching lockfile/version documentation. A bounded subprocess verifies over-limit arrays, sets and maps reject before element traversal; remote error output remains bounded. Clean installation and npm audit pass. |
| AUD-013 | Collection catalog commits serialize and recheck revisions after preparation. Creation reservations enforce name/count constraints; ingestion manifest commits cannot restore revoked consent. |
| AUD-014 | Document revision generations are separate from content hashes. Retries are idempotent within a generation; new A→B→A revisions have new identities. Erased/rejected receipts never count as accepted chunks. |
| AUD-015 | Credential reads/writes share a 256 KiB UTF-8 budget; rejected writes preserve the old file. Owner-only stores up to 2 MiB can be selectively shrunk during recovery without exposing plaintext. Permission, corruption and capacity errors differ. |
| AUD-016 | Command option checks inspect the final expanded argv entry. Adjacent empty placeholders cannot move a leading option into an operand. Configured literal options remain allowed; variable-leading negative numbers are refused under the existing operand rule. No shell is introduced. |
| AUD-017 | Android remote commits carry connection, desktop, epoch and authoritative-generation fences into a shared mutex-protected commit gate. Invalidation happens before revocation/forget/pairing/scope transitions wait for the mutex. Hydration, counters, related cleanup and cache writes cannot publish stale results. Deterministic coroutine tests exercise a response already queued for the mutex. |

## Contracts and limits

Settings callers without a revision merge explicitly supplied fields into the current settings; validation-induced changes (such as clearing a model when its host changes) also apply. A caller providing a stale revision gets `REVISION_CONFLICT`. Identity drafts retain their three-field baseline comparison. A failed side effect does not roll back committed policy.

Snapshot hydration contract version 1 is additive to desktop state version 1. `hydration.fields` names omitted top-level fields. Read `state.field` with `{revision, field, offset:0}` and concatenate `text` until `next:null`; restart from a current snapshot on revision conflict. Each page is at most 32,768 UTF-16 code units, never splits a surrogate pair, and stays below 256 KiB serialized. `session.hydrate` returns `{version:1,session}` containing only identity, revision and composer fields (not unbounded agent history); stored draft text is never truncated. A native consumer accepts draft content only at the matching draft revision, and view state only at the matching session revision.

Collection cleanup uses canonical tombstones. Physical Neo4j/Qdrant purge is asynchronous; `purge_complete:false` is not presented as completed physical deletion. Canonical memory has no scope-delete command: an unexpected catalog persistence failure after scope allocation may retain empty scope metadata, with exact-scope Forget attempted. Ownership-ambiguous historical data must not be erased speculatively.

The file lock guarantees no lost update among Cere writers. External editors do not participate in that lock; near-commit checks detect observed changes, but a portable filesystem compare-and-swap against an uncooperative writer is not claimed. Process supervision proves only the original owned process group; it cannot prove termination of descendants that escape with `setsid`, or work dispatched to remote services.

## Current validation

Runtime: Node 26.13.1 (package minimum 24.22.0; `.node-version` remains the existing 26.8.2 pin).

- Clean installation: `npm ci --prefix /tmp/cere-remediation-install-20261117` — passed, including install scripts; 73 packages installed.
- `npm audit --json` — zero reported vulnerabilities, including GHSA-mrhx-c7xc-m3w5.
- `npm run typecheck` and `git diff --check` — passed after integration.
- `cmake --build build --parallel 4` — passed.
- `QT_QPA_PLATFORM=offscreen QT_QPA_PLATFORMTHEME= QT_QUICK_BACKEND=software ctest --test-dir build --output-on-failure` — 5/6 passed. The OpenGL avatar check fails silhouette/ground comparisons under the forced offscreen platform. CMake explicitly excludes offscreen as a valid GL readback platform, and historical `VALIDATION.md` documents the same failure. Motion, registration, software avatar, catalog and QML pass. The subsequent private Xvfb run passed the OpenGL test (155.24 seconds): all six native/QML checks have therefore passed across their intended display configurations.
- Focused offscreen `cere-ui-check`: `draftsStayCoherentAcrossComposers reconnectRecoversTranscriptAndFailsPendingRequests draftSurvivesUnconfirmedSave approvalsIdentifyTheirRequester` — 6 passed including setup/cleanup, zero failures/skips. Reconnect includes the new framing regression.
- `./gradlew :core:data:testDebugUnitTest` — passed, including two new coroutine scheduling tests in `RepositoryCommitGateTest`.
- Initial full Node run: 852 tests, 844 passed, two settings-merge regressions, six skipped. Both regressions were corrected; affected integration tests passed 133/133.
- Subsequent full Node run: 868 tests, 861 passed, one misconfigured fake-server fixture, six skipped. The fixture was corrected; its focused rerun passed. Final integrated gate results follow below.

- Final full broker gate: `CERE_TTS_DISABLED=1 node --test --test-concurrency=4 tests/*.test.ts` — **870 tests, 864 passed, zero failed, six skipped**. Five skips require the private compositor/audio desktop; one requires opt-in installed IndexTTS synthesis. Four final targeted hydration/deletion/commit-guard regressions also passed after the final narrow edits.
- Complete configured Android compile/unit/lint/build gate passed: `./gradlew --no-daemon :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug :app:lintRelease :app:lintDev :app:assembleDebug :app:assembleDebugAndroidTest :app:assembleRelease :app:assembleDev` (257 tasks, 2m 58s). This is build evidence, not device execution or release signing evidence.

Built APK SHA-256 values (no device installation performed):

| Artifact under `mobile/android/app/build/outputs/apk/` | SHA-256 |
| --- | --- |
| `debug/app-debug.apk` | `47fc1ea062ae5f8d6535ea46e18defbabd8018051f1414a4cc562984717431a6` |
| `release/app-release-unsigned.apk` | `3d6e0b3fae77ecb982f1aad98523957fe1964a2c4040ca23e3ab8e70897c0b85` |
| `dev/app-dev.apk` | `6c5066ef46034219996371a77ef7682b3f587dcdb4ce9126d218ad11f82985aa` |

Machine-local logs: `/tmp/cere-remediation-install.log`, `/tmp/cere-remediation-audit.json`, `/tmp/cere-remediation-native.log`, `/tmp/cere-remediation-ctest.log`, `/tmp/cere-remediation-ui.log`, `/tmp/cere-remediation-suite-verified.log`, `/tmp/cere-remediation-android-gates.log`. Android XML results are under `mobile/android/core/data/build/test-results/testDebugUnitTest/`. These are local evidence, not published release artifacts.

The OpenGL rerun used temporary Xvfb/Xauth packages under `.local-deps/remediation-xvfb`: `PATH="$PWD/.local-deps/remediation-xvfb/usr/bin:$PATH" QT_QPA_PLATFORM=xcb QT_QPA_PLATFORMTHEME= .local-deps/remediation-xvfb/usr/bin/xvfb-run -a ctest --test-dir build --output-on-failure -R '^avatar$'` passed 1/1. Evidence: `/tmp/cere-remediation-gl.log`. No renderer assertions were weakened.

The private-compositor rerun was attempted with a temporary Cage package extracted under `.local-deps/remediation-cage` (no host installation). Hyprland failed before tests with `xdg_wm_base: expected at most 5, got 6`. Logs are `/tmp/cere-remediation-compositor.log` and `build/remediation-desktop/`. This environment failure does not count as a passed compositor gate.

## Spec work not completed

The spec's section 5 and final audit/release gates are not all complete. In particular:

- The 496 unread text files, four partial-file gaps and complete binary-asset review have not been closed. Changed-file review and passing tests are not a substitute for those reads.
- Canonical graph task creation/binding, identity merge/split with correction history, editor RPC, lock/suspend reconciliation, Kitty instance mapping and durable desktop history remain separate feature work. Existing identity decisions and project-capsule tasks are not represented as completing these features.
- A representative held-out memory quality/performance corpus with actual model/service measurements has not been completed. Synthetic regressions establish neither production accuracy nor real-provider cancellation guarantees.
- Physical-device fresh install/upgrade, pairing/replacement, accessibility, no-Play, notification, attachment and process-death release evidence on exact signed release bytes has not been collected. No release evidence, signature, publication, installed desktop restart or phone installation was fabricated or performed.
- The complete supported-Hyprland integration gate and physical-device mobile gate are still required before release readiness can be asserted. The OpenGL avatar gate itself now passes on private Xvfb.

These outstanding items prevent describing the **entire remediation specification** as complete, despite implementation of the confirmed-finding corrections above.
