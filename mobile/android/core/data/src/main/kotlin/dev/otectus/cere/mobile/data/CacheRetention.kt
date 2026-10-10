package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Message

/**
 * Two separate budgets. The encrypted cache written to storage keeps the 200 most
 * recently updated sessions (plus any with local work), messages from the last seven
 * days, and at most 20 MiB. What the app shows is never cut by age or session count:
 * history loaded from the desktop stays readable, and only a much larger memory budget
 * drops the oldest messages of conversations that are not open.
 */
object CacheRetention {
    const val PERSISTED_SESSIONS = 200
    const val PERSISTED_BYTES = 20L * 1024 * 1024
    const val PERSISTED_AGE_MS = 7L * 24 * 60 * 60 * 1000
    const val LIVE_MESSAGE_BYTES = 48L * 1024 * 1024
    private const val MESSAGE_OVERHEAD = 256L

    private fun Message.bytes() = text.toByteArray().size + MESSAGE_OVERHEAD

    /** The subset of [state] written to the encrypted cache. */
    fun persistable(state: MobileState, now: Long): MobileState {
        val cutoff = now - PERSISTED_AGE_MS
        val protected = state.drafts.filterValues { it.dirty || it.conflict }.keys + state.attachments.map { it.sessionId } +
            state.pendingCommands.mapNotNull(PendingCommand::sessionId) + listOfNotNull(state.selectedSessionId)
        val keepIds = (protected + state.sessions.sortedByDescending { it.updated }.take(PERSISTED_SESSIONS).map { it.id }).toSet()
        val fixedBytes = state.attachments.sumOf { it.size.toLong() } + state.drafts.filterKeys { it in keepIds }.values.sumOf { it.text.toByteArray().size.toLong() }
        var remaining = (PERSISTED_BYTES - fixedBytes - 512 * 1024).coerceAtLeast(0)
        val retained = ArrayList<Message>()
        state.messages.asReversed().forEach { message ->
            val bytes = message.bytes()
            if (message.sessionId in keepIds && (message.time == 0L || message.time >= cutoff) && bytes <= remaining) { retained += message; remaining -= bytes }
        }
        return state.copy(
            sessions = state.sessions.filter { it.id in keepIds },
            messages = retained.asReversed(),
            drafts = state.drafts.filterKeys { it in keepIds },
            scrollPositions = state.scrollPositions.filterKeys { it in keepIds },
        )
    }

    /**
     * Keeps the open conversation whole and, if the total grows past the live budget,
     * drops the oldest messages of other conversations. A trimmed conversation keeps a
     * cursor so its earlier messages can be loaded again.
     */
    fun liveBound(messages: List<Message>, messagesBefore: Map<String, String>, selectedSessionId: String?, budget: Long = LIVE_MESSAGE_BYTES): Pair<List<Message>, Map<String, String>> {
        var total = messages.sumOf { it.bytes() }
        if (total <= budget) return messages to messagesBefore
        val dropped = HashSet<String>()
        // Oldest first across the conversations that are not open.
        for (message in messages.filter { it.sessionId != selectedSessionId }.sortedBy(Message::time)) {
            if (total <= budget) break
            dropped += message.id; total -= message.bytes()
        }
        val kept = messages.filterNot { it.id in dropped }
        val trimmed = messages.filter { it.id in dropped }.mapTo(HashSet(), Message::sessionId)
        val cursors = messagesBefore.toMutableMap()
        for (sessionId in trimmed) {
            val oldest = kept.filter { it.sessionId == sessionId }.minByOrNull(Message::time)
            if (oldest != null) cursors[sessionId] = oldest.id else cursors.remove(sessionId)
        }
        return kept to cursors
    }
}
