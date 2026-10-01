package dev.otectus.cere.mobile.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Turn acceptance differs from an in-progress command-ledger acknowledgement. */
fun acceptedSendStatus(result: JsonElement): String? =
    ((result as? JsonObject)?.get("status") as? JsonPrimitive)?.contentOrNull
        ?.takeIf { it in setOf("accepted", "completed", "queued") }

/** Provider reasoning and tool output belong in Activity, never in reply bubbles. */
fun Message.isConversationMessage(): Boolean = role in setOf("user", "assistant") &&
    kind in setOf("text", "message", "", "question", "answer", "queued", "queue-cancelled")

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
