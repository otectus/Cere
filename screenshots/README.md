# Screenshots

These images come from Cere's real interface, captured by
[`tools/screenshots/run.sh`](../tools/screenshots/run.sh) with a scripted demo profile:

- The QML interface and broker are the ones in this repository, rendered offscreen with Qt's software
  renderer at 1× scale.
- Conversations, projects and folders are seeded demo content. Codex, Claude Code, AntiGravity and
  Ollama are local scripted fixtures, so replies show what the interface does, not real model output.
  Windows, volume and media playback on the Desktop page are simulated.
- Desktop scenes draw Cere's own windows (pet, compact panel and bubbles) at their real positions over a
  generated wallpaper, with drop shadows added. The avatar, theme and gesture strips place several
  captures side by side on the same wallpaper. The other images are single-window captures.

## Regenerate

```sh
cmake --build build --target cere cere-screenshots
tools/screenshots/run.sh
```

The run takes about three minutes and overwrites the images in this folder; set `CERE_SCREENSHOTS_DIR`
to write elsewhere. It needs a build configured with tests (the default), unprivileged user namespaces
(`unshare`) and `ip` from iproute2. Everything runs in private user, mount, process and network
namespaces with `/home/demo` as the home folder. It reads nothing from your Cere profile, compositor,
media players or provider accounts, and it cannot reach the network.

To retake some images, name their slots from
[`tools/screenshots/capture.cpp`](../tools/screenshots/capture.cpp), for example
`tools/screenshots/run.sh settingsPages`. Slots that reuse earlier conversations need those slots as
well, for example `compactPanel themesAndAvatars`.

## On the desktop

<table>
<tr>
<td width="50%" valign="top"><a href="desktop-companion.png"><img src="desktop-companion.png" alt="Cere standing on the desktop beside her compact panel, which shows a Codex conversation about a flaky login test"></a><br><b>Desktop companion.</b> Cere beside her compact panel after a Codex run tracked down a flaky test.</td>
<td width="50%" valign="top"><a href="desktop-approval-bubble.png"><img src="desktop-approval-bubble.png" alt="A bubble beside Cere listing two permission requests: a file change with its diff and a deploy command"></a><br><b>Approvals beside the pet.</b> With every Cere window closed, a file change and a deploy command wait in a bubble that names each provider, session and project.<br><br><a href="desktop-reply-bubble.png"><img src="desktop-reply-bubble.png" alt="A bubble beside Cere showing the latest reply from a pinned conversation"></a><br><b>Pinned replies.</b> The latest reply from a pinned Ollama conversation appears beside Cere.</td>
</tr>
</table>

<table>
<tr>
<td width="33%" valign="top"><a href="compact-conversation.png"><img src="compact-conversation.png" alt="The compact panel showing a conversation"></a><br><b>Compact panel.</b> Header portrait, navigation, the conversation, Activity and the composer.</td>
<td width="33%" valign="top"><a href="compact-approval.png"><img src="compact-approval.png" alt="A command approval card in the compact panel"></a><br><b>Approval in the compact panel.</b> The command, folder and reason, with Allow once, Decline and Cancel turn.</td>
<td width="33%" valign="top"><a href="compact-desktop.png"><img src="compact-desktop.png" alt="The Desktop page in the compact panel"></a><br><b>Desktop controls.</b> Quick actions, output volume and Spotify playback in the compact panel.</td>
</tr>
</table>

## Avatars and themes

<a href="avatars.png"><img src="avatars.png" alt="Cere, Daemona, Jade, Nova and Soap standing side by side"></a>

**Five avatars.** Cere, Daemona, Jade, Nova and Soap in their reference poses.

<a href="themes.png"><img src="themes.png" alt="The compact panel in each avatar's color theme"></a>

**Matching themes.** Saving an avatar recolors the panels, menus, conversation cards and portrait frame.

<a href="gestures.png"><img src="gestures.png" alt="Cere in six gestures with their expression badges"></a>

**Gestures.** Wave, thinking, open-hand presentation, celebration, timid blush and the pickup flail, each
with its expression badge.

## Conversations

<table>
<tr>
<td width="50%" valign="top"><a href="workspace-conversation.png"><img src="workspace-conversation.png" alt="The expanded workspace showing a Claude Code release plan with a table and a task list"></a><br><b>Workspace.</b> A Claude Code release plan with a table and task lists.</td>
<td width="50%" valign="top"><a href="workspace-activity.png"><img src="workspace-activity.png" alt="The Activity panel listing two working subagents and test output"></a><br><b>Activity.</b> Two Codex subagents still at work after the reply, with the tool trail below.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workspace-question.png"><img src="workspace-question.png" alt="A Codex question form with selected options"></a><br><b>Questions.</b> The first of three Codex questions, with option descriptions and room for another answer.</td>
<td width="50%" valign="top"><a href="workspace-web-sources.png"><img src="workspace-web-sources.png" alt="An Ollama reply with two web source buttons"></a><br><b>Web sources.</b> An Ollama reply with source buttons, in a pinned conversation.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="new-session.png"><img src="new-session.png" alt="The Start a conversation dialog"></a><br><b>New session.</b> Provider, project folder, model, effort, trust and temporary conversations.</td>
<td width="50%" valign="top"><a href="handoff.png"><img src="handoff.png" alt="The handoff review dialog with an editable draft"></a><br><b>Handoff.</b> Review the draft that would continue this work with another provider. Nothing is sent until you submit it.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="context-drawer.png"><img src="context-drawer.png" alt="The Conversation context dialog"></a><br><b>Context.</b> Destination, a rough token estimate and the memory recalled for the latest turn.</td>
<td width="50%" valign="top"><a href="completion-inbox.png"><img src="completion-inbox.png" alt="The completion inbox listing four finished runs"></a><br><b>Completion inbox.</b> Finished runs from every conversation.</td>
</tr>
</table>

## Organizing work

<table>
<tr>
<td width="50%" valign="top"><a href="sessions.png"><img src="sessions.png" alt="The Sessions page"></a><br><b>Sessions.</b> Filters, folders, pins and row actions.</td>
<td width="50%" valign="top"><a href="projects.png"><img src="projects.png" alt="The Projects page"></a><br><b>Projects.</b> Favorites, unread counts and per-project defaults.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="command-palette.png"><img src="command-palette.png" alt="The command palette showing favorites and recent destinations"></a><br><b>Command palette (Ctrl+K).</b> Favorites and recent destinations.</td>
<td width="50%" valign="top"><a href="command-palette-search.png"><img src="command-palette-search.png" alt="Command palette results for the word release"></a><br><b>Palette search.</b> Transcripts, sessions and open windows in one list.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workflows.png"><img src="workflows.png" alt="The Project workflows dialog showing a project capsule"></a><br><b>Project workflows.</b> A project capsule with goal, decisions, constraints, questions and next steps.</td>
<td width="50%" valign="top"><a href="permissions.png"><img src="permissions.png" alt="The Permission Center"></a><br><b>Permission Center.</b> Power sessions, leases and Cere actions for the selected session.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="desktop.png"><img src="desktop.png" alt="The Desktop page with volume, media playback and a focus timer"></a><br><b>Desktop.</b> Quick actions, volume, media playback and a running focus timer.</td>
<td width="50%" valign="top"><a href="desktop-apps.png"><img src="desktop-apps.png" alt="Open windows with their workspaces on the Desktop page"></a><br><b>Windows and workspaces.</b> Focus open windows or move them to another workspace.</td>
</tr>
</table>

## Memory

<table>
<tr>
<td width="50%" valign="top"><a href="settings-knowledge.png"><img src="settings-knowledge.png" alt="Knowledge settings for web search and memory"></a><br><b>Knowledge.</b> Web search and memory settings.</td>
<td width="50%" valign="top"><a href="memory.png"><img src="memory.png" alt="The Project memory dialog listing four saved facts"></a><br><b>Project memory.</b> Saved facts with Evidence, Edit and Forget.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="memory-review.png"><img src="memory-review.png" alt="Project memory review showing a proposed decision and its supporting passage"></a><br><b>Memory review.</b> A decision proposed from a reply, with its supporting passage and the review choices.</td>
<td width="50%" valign="top"><a href="memory-inspector.png"><img src="memory-inspector.png" alt="The graph memory inspector showing memory health"></a><br><b>Graph memory inspector.</b> Health, workspace, policy, evidence search and structured corrections.</td>
</tr>
</table>

## Settings

<table>
<tr>
<td width="50%" valign="top"><a href="settings-companion.png"><img src="settings-companion.png" alt="Companion settings with avatar cards"></a><br><b>Companion.</b> Avatar and colors.</td>
<td width="50%" valign="top"><a href="settings-personality.png"><img src="settings-personality.png" alt="Personality settings"></a><br><b>Personality.</b> Name and conversation style.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-voice.png"><img src="settings-voice.png" alt="Voice settings"></a><br><b>Voice.</b> Automatic speech for each provider, local voices and voice adjustments.</td>
<td width="50%" valign="top"><a href="settings-motion.png"><img src="settings-motion.png" alt="Motion and expressions settings with a preview of Cere"></a><br><b>Motion & expressions.</b> Idle energy and the motion preview.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-connections.png"><img src="settings-connections.png" alt="Connections settings"></a><br><b>Connections.</b> The Ollama server and the command-line providers.</td>
<td width="50%" valign="top"><a href="settings-assistance.png"><img src="settings-assistance.png" alt="AI assistance settings"></a><br><b>AI assistance.</b> Permission switches and desktop categories.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-scripts.png"><img src="settings-scripts.png" alt="Saved scripts settings"></a><br><b>Saved scripts.</b> Executables Cere may run after review.</td>
<td width="50%" valign="top"><a href="settings-mobile.png"><img src="settings-mobile.png" alt="Cere Mobile settings"></a><br><b>Cere Mobile.</b> Gateway addresses and offline pairing.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-telemetry.png"><img src="settings-telemetry.png" alt="Workspace telemetry settings"></a><br><b>Workspace telemetry.</b> Opt-in shell and file activity for chosen workspaces.</td>
<td width="50%" valign="top"><a href="settings-application.png"><img src="settings-application.png" alt="Application settings"></a><br><b>Application.</b> Shortcut, maintenance and quitting.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-search.png"><img src="settings-search.png" alt="Settings search results for the word voice"></a><br><b>Find a setting.</b> Search across every category.</td>
<td width="50%" valign="top"><a href="health.png"><img src="health.png" alt="The Health and recovery dialog"></a><br><b>Health and recovery.</b> The API providers show network problems here because the demo profile has no network access and no API keys.</td>
</tr>
</table>
