# Cere Mobile for Android

Cere Mobile is a native Android client for a paired Cere desktop broker. It does not run providers, desktop tools, or memory databases on the phone. The app uses the negotiated operation list from the authenticated broker welcome frame to decide which controls exist.

The version is set in `app/build.gradle.kts`. The earlier device results and artifact hashes below describe previous builds; the current source still needs its physical-device validation gates, listed in [TESTING.md](../../docs/mobile/TESTING.md).

## What is implemented

- Offline two-way pairing by manual `cere-pair://v1/…` import or CameraX/ZXing QR scan, signed response text and QR output, and the six-word comparison from the protocol SAS list.
- Separate non-exportable Android Keystore P-256 keys for background connection authentication and exact-command action signatures. A signed pairing offer selects either biometric action authentication or trusted-device mode. Trusted-device action keys are generated with Android Keystore user authentication disabled, so explicit reviewed actions need no fingerprint or PIN; legacy offers and welcomes remain biometric. The phone accepts trusted-device actions only when the stored pairing and authenticated broker welcome agree on that mode.
- Same-desktop replacement pairing for certificate/endpoint renewal, including Tailscale `wss://` endpoints. The signed offer must name the existing desktop and device, retain the pinned TLS key and desktop identity, and pass the usual offline response/SAS confirmation. Encrypted sessions, drafts, and local images are retained; unresolved commands and active uploads block replacement, and old phone keys remain until the replacement cache is sealed.
- A dedicated pinned-TLS OkHttp WebSocket client. It trusts only the paired certificate, separately verifies the pinned SPKI and certificate validity, retains normal SAN/hostname checks, and accepts only signed pairing endpoints.
- Protocol 1.0 hello/challenge/auth/welcome, authoritative `sync.open` reconciliation, snapshot scope replacement, revision-aware whole-message upserts, cursor acknowledgement after encrypted persistence, command IDs, command-status reconciliation, and reconnect backoff. A 30-second WebSocket ping detects a desktop that stopped answering; only a pairing that no longer matches the desktop, revocation, an incompatible version or refusals that persist for minutes stop reconnection, and only a broken pairing suggests pairing again.
- AES-256-GCM private state in Android credential-encrypted app storage, backed by an Android Keystore key. Cached scoped sessions/messages/approvals and drafts never touch disk as plaintext and disappear on Forget desktop. A temporarily unavailable private cache is never treated as an empty install: verified in-memory state remains active, cursor acknowledgement waits for a sealed write, and persistence retries after unlock. Ordinary updates are written about once a second and when the app leaves the screen; command IDs, uploads and a draft being sent are written immediately. The cache keeps the 200 most recently updated conversations (plus any with local work) and seven days of messages within 20 MiB, while the app shows the history it loads from the desktop regardless of age.
- Native dark Compose UI using the desktop palette and Cere face artwork for searchable sessions (search also queries the desktop), catalog-backed signed session creation, table/link/style-aware Markdown chat, local and synchronized drafts, signed Send, Stop, literal/copyable Activity output, typed approval cards, Inbox, capability-gated Desktop/Memory/Settings controls, connection status, and safe device forgetting. Opening a conversation clears Unread on every client. Settings lists desktop actions whose outcome is unknown so they can be checked on the PC and released; nothing is replayed.
- Authoritative scoped snapshot reconciliation with selected-session hydration, paged session summaries, cache purging by authoritative session IDs, independent divergent draft conflict handling, persisted command IDs, unknown-outcome reconciliation, and bounded on-demand loading for large message parts.
- Encrypted image drafts from Android Photo Picker, SAF, full-size system camera capture (camera access is requested when Camera is chosen), or an `ACTION_SEND`/`ACTION_SEND_MULTIPLE` share, which asks which conversation receives the images. Imports are decoded and re-encoded without source metadata, bounded to four images and the private 20 MiB cache, uploaded in acknowledged 256 KiB binary chunks with signed begin/commit actions, and never sent automatically. An image the desktop has discarded returns to Upload, and removing an image always works on the phone. Image approvals require a fully downloaded SHA-256-verified preview and its exact image digest before Allow is enabled.
- Capability-gated Desktop controls for volume and mute, playback, window focus and move, workspace switching, app launch, file open, timers and reviewed saved scripts, with each list loading on its own; session handoff, provider disconnect and stopped Codex history import; project memory browse/recall/saved-fact edit/forget/clear; permissions pause; and CAS-protected assistant settings with local-edit conflict handling. Project paths and pinned Ollama routing are shown before memory and transcript-copy actions.
- A bounded GitHub release metadata check, battery-optimization status, and direct system settings entry. Stable builds follow stable releases and development builds follow development snapshots. The app only opens a validated Cere release page; it never downloads or installs an APK itself.
- Pairing starts a `connectedDevice` foreground service, switchable in Settings, with a private connection notification. Requests, finished replies, conversation problems and timers alert on separate channels; each request alerts once, and lock-screen copies are redacted. Notification permission is requested while pairing, Settings shows whether request alerts are on, and Android 17 local-network permission is requested in context. Without background monitoring the app connects only while it is open.
- Debug StrictMode, disabled backups/data transfer, no cleartext traffic, no broad storage/location/overlay/accessibility permissions, and no external Markdown image loading.

The modules are `:app` for Android UI and service entry points, pure Kotlin `:core:protocol` for wire types/signing/reduction, and Android `:core:data` for pairing, transport, encrypted storage, and repositories. The wire implementation follows `protocol/mobile/v1/CONTRACT.json` in the Cere repository.

## Build

The checked-in wrapper uses Gradle 9.5.0 with its distribution SHA-256, AGP 9.3.3 with built-in Kotlin 2.2.10, JDK 17, `compileSdk`/`targetSdk` 37, Build Tools 36.0.0, and `minSdk` 30. No SDK location or signing key is checked in.

From this directory:

```sh
ANDROID_HOME=/path/to/android-sdk \
GRADLE_USER_HOME=/path/to/cere-gradle-cache \
./gradlew :core:protocol:test :app:lintDebug :app:assembleDebug
```

`./gradlew :app:assembleDev` builds the development snapshot at `app/build/outputs/apk/dev/app-dev.apk`: the release build's R8 optimization, not debuggable, under the `.debug` package and the debug signing key, so it upgrades earlier development installs in place (see [RELEASES.md](../../docs/mobile/RELEASES.md)).

The local implementation build uses the dedicated SDK at `mobile/android/.android-sdk` and cache at `/tmp/cere-android-gradle`. The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk` and is signed only with the generated debug key. `app/build/outputs/apk/release/app-release-unsigned.apk` is the R8/resource-shrunk unsigned release package; no owner release key was supplied.

## Validation and hardware gates

Protocol unit tests cover canonical JSON ordering/hashing (including Node 24 `canonicalize` 2.1.0 authentication and null fixtures), unknown-frame rejection, and lower-revision event rejection. Data tests cover divergent draft preservation, authoritative scope purging, selected-history replacement, paged summaries that omit drafts, indirect pending-command scope binding, and omission of sensitive command parameters from persistence. The final build gate ran:

```sh
./gradlew :core:protocol:test :core:data:testDebugUnitTest \
  :app:lintDebug :app:lintRelease :app:assembleDebug \
  :app:assembleDebugAndroidTest :app:assembleRelease
```

It completed successfully with R8 enabled for release. Android instrumentation also passed on an isolated API 36 x86_64 Pixel 6 AVD (`OK (1 test)`), verifying the fresh-install pairing screen and both manual and scanner entry points. The exact isolated-ADB install and instrumentation output is at `app/build/reports/final-emulator-instrumentation.log`. A separate paired-emulator run used an isolated real Cere broker fixture: Android generated the credential-bound P-256 keys after emulator PIN authentication, the broker verified the offline signed response and six-word SAS, the app authenticated through pinned TLS, and `sync.open` reached Online. The same run created a catalog-backed fixture Codex session, authenticated a Send action, rendered its user message and waiting state, delivered the fixture approval to Inbox, and completed defensive Deny. No personal or live provider inference ran.

The release-runtime inventory also passed separately with configuration caching disabled, as required by the inventory task:

```sh
./gradlew --no-configuration-cache -I ../../tools/mobile-sbom.gradle :app:mobileSbom
```

It produced a CycloneDX 1.5 document with 154 Maven components at `app/build/reports/mobile-sbom.cdx.json`; the exact task output is at `app/build/reports/final-sbom-gate.log`.

Review artifacts:

- `app/build/reports/screenshots/pairing-api36.png` — fresh pairing screen.
- `app/build/reports/screenshots/paired-online-api36.png` — authenticated broker state.
- `app/build/reports/screenshots/fixture-chat-api36.png` — real broker fixture session after signed Send and defensive Deny.
- `app/build/reports/lint-results-debug.html` — Android lint report.
- `app/build/outputs/apk/debug/app-debug.apk` — debug-signed install artifact.
- `app/build/outputs/apk/release/app-release-unsigned.apk` — unsigned shrunk release artifact.

The latest refinement gate passed **22 unit tests** (8 protocol, 14 data), debug/release lint, and debug/instrumentation/R8 release assembly. Log: `app/build/reports/mobile-passwordless-final-gate.log`. The API 36 conversation suite passed **6 instrumentation tests**, covering separate live Activity, initial/streaming chat follow and user scroll preservation; log: `app/build/reports/final-conversation-emulator-instrumentation.log`.

Current SHA-256 values:

- Debug APK: `57d46450de3d492eda6547c9ab7cb94342831f3a71e53d0d0ef51092dc370124`.
- Unsigned release APK: `2ec8b5665adaa8e0ef1f83c8037bb6e26f67e31fad88c00de17b9701e3850d9a`.

The prior 0.1.1 debug APK was upgraded in place on the owner's Pixel 10 Pro/API 37, preserving the paired keys and private cache. Physical instrumentation passed for that biometric-mode build: both keys survived cold launch, the connection key signed without authentication, the sensitive-action key required authentication, and pinned TLS/project synchronization reached Online. Log: `app/build/reports/phone-passwordless-key-and-connection.log` (`OK (1 test)`). The phone's changed DHCP address also required an owner-authenticated scoped firewall rule; reserve that address at the router to avoid recurrence.

The matching broker passed **177 Node tests**, typecheck and protocol-contract checks. A separate real broker over pinned TLS completed connection-key-signed sends and received live replies from **Ollama gemma4:31b-cloud and Claude haiku**, using a synthetic prompt with tools and memory disabled. Log: `/tmp/cere-mobile-passwordless-live-smoke.log`. Existing personal sessions were not used for those live tests. The updated broker files are staged in the installed runtime; activating them requires restarting the desktop broker. An older running broker produces an actionable restart message and preserves the phone draft instead of falling back to an authentication prompt.

The following checks require target hardware or a matching broker and were not simulated as successful:

- Android Keystore enrollment changes, StrongBox availability, action signing beyond the validated pairing flow, and lock-reset invalidation.
- Camera scan/capture optics, denied Android 17 local-network permission behavior, WireGuard connectivity, foreground delivery during screen-off/doze, and lock-screen notification actions. LAN connectivity with permission granted passed.
- Live Codex execution and real provider/tool approval effects. Synthetic live Ollama and Claude sends passed; effectful approval workflows remain a separate hardware gate.
- Full-size physical-camera quality, Photo Picker/SAF document-provider variety, and media resume after a process kill during an active chunk upload.
- Notification and accessibility review with TalkBack, 200% font scale, landscape/cutouts, and the owner's lock-screen privacy settings.
- Release signing, signed-release install/update testing, physical arm64 release testing, and release publication. No release key was supplied, so the installable signed artifact is the debug APK; the release output remains unsigned.

The debug APK is installed and paired on the owner's real phone. No release was published.
