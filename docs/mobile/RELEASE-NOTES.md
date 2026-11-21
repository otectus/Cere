# Cere Mobile 0.1.5

[Download the Android APK](https://github.com/otectus/Cere/releases/download/mobile-dev-v0.1.5/cere-mobile-v0.1.5-dev.apk) for Android 11 or later. If you already use the development app, open the APK and choose **Update** to keep your pairing, encrypted conversations, and drafts. Update your PC to Cere desktop 0.1.5 for the matching broker.

## What changed

- Chats, Inbox, Desktop, and Settings share light and dark themes, readable layouts at large font sizes, and navigation that adapts to landscape and tablets.
- Pairing starts with scanning the desktop QR code. You can also enter the offer manually. The phone shows the six verification words and what to do if camera access or the connection fails.
- Long conversations keep your reading position when new text arrives. Replies support selectable Markdown, copyable code, and scrollable tables. The composer supports multiline text, an explicit Send action, and image review before upload.
- The phone recognizes its own delayed autosaves and changes to desktop attachments. It keeps your typing, and asks which version to keep when the text really differs across devices.
- The launcher icon uses a cyan C and a cream diamond on navy. Android 13 and later can display it in your themed-icon colors.

## Compatibility and verification

This is the optimized development package `dev.otectus.cere.mobile.debug`, version code `1005`. It uses the same signing certificate as 0.1.4 and speaks mobile protocol 1. Older compatible desktops expose their supported features through negotiation. The desktop must be awake and reachable over your LAN or VPN.

The published 0.1.4 APK upgraded in place on Android 11. The same phone identity signed in, the selected chat and its unsent draft survived, and sending the draft produced exactly one message. The 0.1.5 release APK also paired through its own screen on Android 15. The companion debug build passed 20 standalone instrumentation tests there, with five fixture-dependent cases skipped, and passed all five paired-broker checkpoints in a separate run.

The APK SHA-256 is `72874f29f9aad347a570d3e3e1024f0312773b8296c00227a07670fdb2da8acc`. The release includes the checksum, signing certificate fingerprint, build provenance, and test summary. Validation used emulators. Physical-device camera, biometrics, Doze, and Wi-Fi/cellular roaming remain unverified for these bytes.
