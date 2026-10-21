Cere Mobile pairs with a Cere desktop broker that speaks mobile protocol 1 (`/mobile/v1`). The features new in protocol 1.1 need a desktop broker built from the same source as this release (its commit is in `mobile-release.json`); with an older desktop those options are left out. Android 11 or newer is required; the build targets Android 17.

The native companion includes Cere's face icon and desktop palette, the desktop avatar's still status portrait, scoped conversations, Markdown with sources, drafts, reviewed actions and approvals, image uploads, desktop controls, project memory and settings. New with protocol 1.1:

- Start a capture of the desktop display, preview it and attach exactly that image to a conversation.
- Review a desktop draft's attachments, keep or remove each one, and send them exactly as reviewed.
- Project memory in every provider's conversations, with history, corrections, conflict resolution, identity decisions, episode freezing and a memory health line.
- Pinned replies, shared with the desktop's bookmarks.
- A conversation's style, results and schedules; pausing a schedule is the only change offered.
- A workspace card, the programs missing on the desktop, and **Open on desktop** for linked terminal conversations.
- Codex and Claude Code history import, and OpenAI, Claude, Google and compatible-endpoint API conversations under per-provider grants. API requests use the desktop's keys and may be billed.

The desktop must remain awake and reachable over your LAN or existing VPN. Monitoring uses a foreground notification, without Google Play services; battery/profile/force-stop restrictions can delay or prevent delivery.

Before publishing this draft, attach the exact physical-device, signed install/upgrade and compatibility evidence described in `docs/mobile/TESTING.md`, together with the release evidence record that certified the signed APK. Replace this paragraph with release-specific evidence and limitations. Check each claim against `docs/FEATURE-MATRIX.md`; do not describe phone-side capture editing, identity merge or split, other graph administration, AntiGravity turns from the phone or automatic certificate rotation as included.
