package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Message
import org.junit.Assert.*
import org.junit.Test

class InboundFramesTest {
    private fun message(id: String, revision: Int, text: String = "x") = Message(id = id, sessionId = "s", role = "assistant", text = text, revision = revision.toString())

    @Test fun frameSizeIsCheckedInUtf8BytesWithoutCountingPastTheLimit() {
        assertTrue(FrameLimits.fits("a".repeat(1000), 1000))
        assertFalse(FrameLimits.fits("a".repeat(1001), 1000))
        // Three bytes per BMP character: 334 of them are 1002 bytes.
        assertTrue(FrameLimits.fits("漢".repeat(333), 1000))
        assertFalse(FrameLimits.fits("漢".repeat(334), 1000))
        // A surrogate pair is four bytes, not six.
        assertTrue(FrameLimits.fits("🦊".repeat(250), 1000))
        assertFalse(FrameLimits.fits("🦊".repeat(251), 1000))
        assertTrue(FrameLimits.fits("é".repeat(500), 1000))
        assertFalse(FrameLimits.fits("é".repeat(501), 1000))
        assertFalse(FrameLimits.fits("x".repeat(FrameLimits.MAX_TEXT_BYTES + 1)))
    }

    @Test fun manyRevisionsOfOneMessageHoldOneCopyAtTheNewestRevision() {
        val held = HeldUpserts()
        held.begin(1)
        for (revision in 1..500) assertTrue(held.offer(1, message("m", revision, "t$revision"), "c$revision"))
        assertTrue(held.offer(1, message("m", 3, "stale"), "late"))
        assertEquals(1, held.size())
        val batch = held.drain()!!
        assertEquals(listOf("500"), batch.messages.map(Message::revision))
        assertEquals("c500", batch.cursor)
        assertFalse(batch.overflowed)
        assertNull(held.drain())
    }

    @Test fun pastTheCountOrTextBudgetTheBacklogIsDroppedForAResnapshot() {
        val byCount = HeldUpserts(maxMessages = 8)
        byCount.begin(1)
        for (n in 0 until 100) byCount.offer(1, message("m$n", 1), "c$n")
        assertEquals(0, byCount.size())
        val dropped = byCount.drain()!!
        assertTrue(dropped.overflowed); assertTrue(dropped.messages.isEmpty()); assertNull(dropped.cursor)
        // After the drain, updates are held normally again.
        byCount.offer(1, message("next", 1), "c")
        assertEquals(1, byCount.size())

        val byText = HeldUpserts(maxChars = 10_000)
        byText.begin(1)
        byText.offer(1, message("a", 1, "x".repeat(6_000)), "c1")
        assertEquals(1, byText.size())
        byText.offer(1, message("b", 1, "x".repeat(6_000)), "c2")
        assertEquals(0, byText.size())
        assertTrue(byText.drain()!!.overflowed)
    }

    @Test fun aNewConnectionDiscardsTheOldBacklogAndRefusesItsLateUpdates() {
        val held = HeldUpserts()
        held.begin(1)
        held.offer(1, message("old", 1), "c1")
        held.begin(2)
        assertEquals(0, held.size())
        assertFalse("a late update from the closed connection is refused", held.offer(1, message("old", 2), "c2"))
        assertTrue(held.offer(2, message("new", 1), "c3"))
        assertEquals(2L, held.drain()!!.generation)
        held.discard()
        assertFalse(held.offer(2, message("after", 1), "c4"))
        assertNull(held.drain())
    }
}
