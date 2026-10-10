package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Message
import dev.otectus.cere.mobile.protocol.Session
import org.junit.Assert.*
import org.junit.Test

class CacheRetentionTest {
    private val day = 24 * 60 * 60 * 1000L
    private val now = 100 * day
    private fun message(id: String, session: String, ageDays: Long, text: String = "hello") = Message(id, session, role = "assistant", text = text, revision = "1", time = now - ageDays * day)
    private fun session(id: String, updated: Long) = Session(id, "ollama", id, status = "idle", updated = updated)

    @Test fun oldHistoryStaysReadableButIsNotWrittenToTheCache() {
        val state = MobileState(sessions = listOf(session("s", now)), messages = listOf(message("old", "s", 30), message("new", "s", 1)))
        val (live, _) = CacheRetention.liveBound(state.messages, emptyMap(), selectedSessionId = null)
        assertEquals(listOf("old", "new"), live.map(Message::id))
        assertEquals(listOf("new"), CacheRetention.persistable(state, now).messages.map(Message::id))
    }

    @Test fun theCacheKeepsRecentSessionsAndAnySessionWithLocalWork() {
        val sessions = (1..250).map { session("s$it", it.toLong()) }
        val draft = LocalDraft("s1", "unsent", "1", "1", true)
        val state = MobileState(sessions = sessions, drafts = mapOf("s1" to draft), selectedSessionId = "s2")
        val persisted = CacheRetention.persistable(state, now)
        assertEquals(202, persisted.sessions.size)
        assertTrue(persisted.sessions.any { it.id == "s1" } && persisted.sessions.any { it.id == "s2" } && persisted.sessions.any { it.id == "s250" })
        assertFalse(persisted.sessions.any { it.id == "s40" })
        assertEquals("unsent", persisted.drafts.getValue("s1").text)
        // The live list is never cut by count.
        assertEquals(250, state.sessions.size)
    }

    @Test fun overTheLiveBudgetOnlyClosedConversationsLoseTheirOldestMessagesAndKeepACursor() {
        val text = "x".repeat(1_000)
        val messages = listOf(message("a1", "a", 5, text), message("a2", "a", 4, text), message("b1", "b", 6, text), message("b2", "b", 1, text))
        val (kept, cursors) = CacheRetention.liveBound(messages, emptyMap(), selectedSessionId = "b", budget = 4_000)
        assertEquals(listOf("a2", "b1", "b2"), kept.map(Message::id))
        assertEquals("a2", cursors["a"])
        assertNull(cursors["b"])
    }

    @Test fun anUploadTheDesktopDiscardedIsNoLongerReady() {
        val upload = LocalAttachment("00000000-0000-0000-0000-000000000001", "s", "image", "image/webp", 1, "hash", 1, 1, false,
            remoteAttachmentId = "remote", remoteStatus = "ready", remoteExpiresAt = 1_000)
        assertTrue(upload.readyAt(999))
        assertFalse(upload.readyAt(1_000))
        val again = upload.withoutRemote()
        assertEquals("local", again.remoteStatus)
        assertNull(again.remoteAttachmentId)
        assertFalse(again.readyAt(0))
    }
}
