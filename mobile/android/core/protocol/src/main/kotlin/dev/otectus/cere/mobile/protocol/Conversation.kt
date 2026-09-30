package dev.otectus.cere.mobile.protocol

/** Provider reasoning and tool output belong in Activity, never in reply bubbles. */
fun Message.isConversationMessage(): Boolean = role in setOf("user", "assistant") &&
    kind in setOf("text", "message", "")

/** Keep streamed revisions when a slower history request returns an older copy. */
fun mergeMessages(current: List<Message>, incoming: List<Message>): List<Message> {
    val merged = current.associateBy(Message::id).toMutableMap()
    incoming.forEach { message ->
        val old = merged[message.id]
        if (old == null || (message.revision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) >=
            (old.revision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)) merged[message.id] = message
    }
    return merged.values.sortedBy(Message::time)
}
