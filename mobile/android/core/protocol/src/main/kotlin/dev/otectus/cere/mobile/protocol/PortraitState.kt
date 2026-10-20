package dev.otectus.cere.mobile.protocol

/**
 * W11 (F93): the phone's static status portrait follows the desktop's rule in qml/PortraitState.js,
 * for activity only: the phone shows no conversational mood, greeting, hover or listening. Both are
 * checked against tests/fixtures/portrait-states.json.
 */
object PortraitState {
    data class Resolved(val expression: String, val label: String, val tone: String)

    private val thinking = setOf("recalling", "thinking", "planning", "compacting", "")

    fun resolve(connected: Boolean, status: String, activity: String?, approvals: Int, paused: Boolean): Resolved {
        if (!connected) return Resolved("concerned", "Reconnecting", "attention")
        if (approvals > 0) return Resolved("curious", "Waiting for your input", "attention")
        if (status == "waiting") return Resolved("curious", "Waiting for a decision", "attention")
        if (status == "error") return Resolved("concerned", "Something needs attention", "attention")
        if (status == "interrupted") return Resolved("concerned", "Interrupted", "attention")
        if (status == "disconnected") return Resolved("concerned", "Session disconnected", "attention")
        if (paused) return Resolved("sleepy", "Taking a pause", "calm")
        if (status == "stopping") return Resolved("focused", "Stopping", "active")
        if (status == "working" || status == "starting") return when {
            activity == "speaking" -> Resolved("neutral", "Replying", "active")
            (activity ?: "") in thinking -> Resolved("thinking", "Thinking it through", "active")
            else -> Resolved("focused", "Working on it", "active")
        }
        return Resolved("neutral", "Right here", "calm")
    }
}

/**
 * W05: what a working conversation is doing, in the desktop chat's words (qml/Chat.qml
 * activityStatus); both are checked against tests/fixtures/activity-labels.json. Null for an
 * activity this phone does not know, so the caller falls back to its general status line.
 */
fun activityLabel(activity: String?): String? = when (activity) {
    "recalling" -> "Recalling memory…"
    "thinking" -> "Thinking…"
    "speaking" -> "Writing a response…"
    "working" -> "Using tools…"
    "delegating" -> "Delegating work…"
    "waitingForAgents" -> "Waiting for subagents…"
    "compacting" -> "Compacting context…"
    "planning" -> "Planning…"
    else -> null
}
