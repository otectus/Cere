package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Message

/** Inbound frame size checks, done before a frame is decoded or retained. */
internal object FrameLimits {
    /** The protocol's authenticated frame limit, also advertised in welcome. */
    const val MAX_TEXT_BYTES = 1_048_576
    /** A binary preview chunk: 24 header bytes and at most 256 KiB of data. */
    const val MAX_BINARY_BYTES = 24 + 256 * 1024

    /** True when [text] encodes to at most [limit] UTF-8 bytes; stops counting once past it. */
    fun fits(text: String, limit: Int = MAX_TEXT_BYTES): Boolean {
        // A UTF-16 unit encodes to at most three bytes; a surrogate pair (two units) to four.
        if (text.length.toLong() * 3 <= limit) return true
        if (text.length > limit) return false
        var bytes = 0L
        var index = 0
        while (index < text.length) {
            val unit = text[index]
            bytes += when {
                unit.code < 0x80 -> 1
                unit.code < 0x800 -> 2
                unit.isHighSurrogate() && index + 1 < text.length && text[index + 1].isLowSurrogate() -> { index++; 4 }
                else -> 3
            }
            if (bytes > limit) return false
            index++
        }
        return true
    }
}

/**
 * Message updates waiting to be applied, for one connection at a time. Updates to the same message
 * are coalesced to the newest revision. Past [maxMessages] distinct messages or [maxChars] of text,
 * every held update is dropped and the batch says so: the repository then requests an authoritative
 * snapshot instead of retaining an unbounded backlog. Updates that arrived on an older connection
 * ([begin] was called since) are refused, so a dead socket's backlog never reaches the cache.
 */
internal class HeldUpserts(private val maxMessages: Int = 256, private val maxChars: Long = 4L * 1024 * 1024) {
    data class Batch(val generation: Long, val messages: List<Message>, val cursor: String?, val overflowed: Boolean)
    private class Held(val message: Message, val cursor: String)
    private val lock = Any()
    private var generation = NONE
    private val held = LinkedHashMap<String, Held>()
    private var chars = 0L
    private var overflowed = false

    /** Starts holding updates for [connection]; whatever was held for an earlier connection is discarded. */
    fun begin(connection: Long) = synchronized(lock) { generation = connection; clearLocked(); overflowed = false }
    /** The connection ended: discard its backlog and refuse its late updates. */
    fun discard() = begin(NONE)

    /** Holds [message]; false when it belongs to a connection that is no longer current. */
    fun offer(connection: Long, message: Message, cursor: String): Boolean = synchronized(lock) {
        if (connection == NONE || connection != generation) return false
        if (overflowed) return true
        val previous = held[message.id]
        if (previous != null && !atLeast(message.revision, previous.message.revision)) return true
        if (previous != null) { chars -= previous.message.text.length; held.remove(message.id) }
        held[message.id] = Held(message, cursor); chars += message.text.length
        if (held.size > maxMessages || chars > maxChars) { clearLocked(); overflowed = true }
        true
    }

    /** Takes everything held. The cursor is the newest one among the held updates. */
    fun drain(): Batch? = synchronized(lock) {
        if (held.isEmpty() && !overflowed) return null
        val batch = Batch(generation, held.values.map { it.message }, held.values.lastOrNull()?.cursor, overflowed)
        clearLocked(); overflowed = false
        batch
    }

    fun size(): Int = synchronized(lock) { held.size }

    private fun clearLocked() { held.clear(); chars = 0 }
    private fun atLeast(incoming: String, existing: String): Boolean {
        val next = incoming.toBigIntegerOrNull(); val current = existing.toBigIntegerOrNull()
        return if (next != null && current != null) next >= current else true
    }

    companion object { const val NONE = -1L }
}
