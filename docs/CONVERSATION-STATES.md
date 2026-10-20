# Conversation states and outcomes

One table for the desktop and the phone. The broker owns the state (`Session.status` and `Session.activity` in `broker/types.ts`); both clients only present it. Where a label differs between the two, the difference is deliberate and stated. Checked by `tests/portrait-state.test.ts`, `tests/activity-labels.test.ts`, the Android `PortraitStateTest`, `InteractionStateTest` and `ConversationContentTest`.

## Session states

| State | Meaning | Desktop line (`qml/Chat.qml`) | Phone line | Portrait | Stop | Send from the same client | Enters from → leaves to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `idle` | No turn is running. | — | — | "Right here" | — | yes | any finished turn → `starting` |
| `starting` | A turn was accepted; the provider is being started or resumed. | the activity line below, else "Working on it…" | the activity line below, else "Starting the provider…" | "Thinking it through" | yes | Ollama: queued follow-up; others: wait | `idle` → `working`, `error`, `interrupted` |
| `working` | The provider is producing the turn. | the activity line | the activity line | "Thinking it through", "Working on it" or "Replying" | yes | Ollama: queued follow-up; others: wait | `starting` → `waiting`, `idle`, `error`, `interrupted`, `stopping` |
| `waiting` with a request | A request in the Approvals/Inbox needs a person. | "Waiting for your answer…" / "Waiting for permission…" | "Input needed: …" with Review | "Waiting for your input" | yes | no | `working` → `working` after the answer |
| `waiting` without a request this client can answer | The provider waits on a decision taken elsewhere (another client, the desktop, a provider-side prompt). | "Waiting for a decision…" | "Waiting for a decision on the desktop…" (and "this phone cannot answer requests" without that grant) | "Waiting for a decision" | yes | no | `working` → `working` |
| waiting for agents | The turn is working and child agents are active (`activity` `waitingForAgents`, or active agents). | "N subagents active · M waiting…" | "N subagents are working…"; their requests are listed with their ancestry | "Thinking it through" | yes (stops children) | no | `working` → `working`, `idle` |
| `stopping` | Stop was requested; the provider is ending the turn. | "Stopping…" | "Stopping…" | "Stopping" | — | no | any busy state → `interrupted`, `idle` |
| `interrupted` | The turn ended without completing (Stop, broker restart, provider exit). Unsent text stays in the draft. | error line | error line | "Interrupted" | — | yes | busy states → `starting` |
| `disconnected` | The provider adapter was closed while idle (Disconnect); history stays. | — | Provider connection note | "Session disconnected" | — | yes (reconnects) | `idle` → `starting` |
| `error` | The turn failed; the message says why. The draft is retained. | error line | error line | "Something needs attention" | — | yes | busy states → `starting` |

**Activity line** (both clients, shared words in `tests/fixtures/activity-labels.json`): recalling "Recalling memory…", thinking "Thinking…", speaking "Writing a response…", working "Using tools…", delegating "Delegating work…", waitingForAgents "Waiting for subagents…", compacting "Compacting context…", planning "Planning…". An activity the phone does not know keeps its general line.

**Precedence.** A lost connection is shown first ("Connection lost — reconnecting…" on the desktop, "Reconnecting" in the phone portrait and the cached-state banner), then an unresponsive broker (desktop: "Cere is not responding — waiting for it…"), then Stopping, then a request this client can answer, then agents, then the activity. "Your input" is said only when an actionable request is on screen (W05.2).

**Ownership.** One provider writer per turn. A phone-started turn runs under the phone's grants (`ordinarySettings`), never desktop bypasses; a desktop-started Ollama turn cannot be taken over by a phone, which says so and offers Stop. Delegated child requests appear on the parent conversation on both clients.

## Message and command outcomes

| Outcome | Where | Meaning | Repeated automatically? |
| --- | --- | --- | --- |
| queued | `sessions.send` result `status: 'queued'`; queue rows in the transcript | Accepted into the conversation's follow-up queue; runs after the current turn. | no |
| accepted | `sessions.send` result `status: 'accepted'`; command ledger `accepted` | The provider accepted the turn. | no |
| running | command ledger `running` | A desktop action started and has not reported. | no |
| completed | command ledger `completed` | The operation finished and its result is retained. | no |
| failed | command ledger `failed` with an authored message | Refused or failed before any effect. | no |
| cancelled | `queue-cancelled` transcript rows; capture `cancelled` | Removed before it ran; its text is kept to send again. | no |
| unknown | command ledger `unknown` (`OUTCOME_UNKNOWN`) | It may have taken effect (lost acknowledgement, restart during dispatch). The phone lists it until a person reviews it on the desktop. | never |
| interrupted | command ledger `interrupted` | The gateway closed while the operation ran. | no |

A send later confirmed by `commands.status` clears only the text it sent from the phone draft; newer typing stays (`acceptedLater`, `clearAcceptedDraft`). Self-healing outcomes (drafts, titles, pins, read markers, Stop, schedule pauses) are dropped once the next snapshot shows the truth (`CommandOutcomes.kt`).
