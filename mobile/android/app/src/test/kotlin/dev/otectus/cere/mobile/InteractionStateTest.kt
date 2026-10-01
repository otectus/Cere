package dev.otectus.cere.mobile

import dev.otectus.cere.mobile.protocol.Agent
import dev.otectus.cere.mobile.protocol.ApprovalOption
import dev.otectus.cere.mobile.protocol.ApprovalQuestion
import dev.otectus.cere.mobile.protocol.Session
import dev.otectus.cere.mobile.protocol.Message
import dev.otectus.cere.mobile.data.SessionScrollPosition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InteractionStateTest {
    @Test fun restoredConversationPositionUsesStableMessageAnchor() {
        fun message(id: String) = Message(id, "session", role = "assistant", text = id, revision = "1")
        val position = SessionScrollPosition("session", anchorMessageId = "middle", itemIndex = 1, offset = 24, following = false)
        assertEquals(2, restoredScrollIndex(position, listOf(message("first"), message("middle")), hasOlder = true))
        assertEquals(3, restoredScrollIndex(position, listOf(message("older"), message("first"), message("middle")), hasOlder = true))
    }

    @Test fun missingScrollAnchorFallsBackToBoundedSavedIndex() {
        val position = SessionScrollPosition("session", anchorMessageId = "forgotten", itemIndex = 40, following = false)
        val messages = listOf(Message("current", "session", role = "assistant", text = "current", revision = "1"))
        assertEquals(1, restoredScrollIndex(position, messages, hasOlder = false))
        assertEquals(0, restoredScrollIndex(position.copy(following = true), messages, hasOlder = false))
    }

    @Test fun activeAgentsOverrideIdleSessionStatus() {
        val session = Session("s", "codex", "Work", status = "idle", agents = listOf(
            Agent("a", "Builder", status = "running"),
            Agent("b", "Done", status = "completed"),
        ))
        assertEquals(1, session.activeAgentCount())
        assertEquals("1 subagent active", sessionDisplayStatus(session))
        assertEquals("Waiting for input", sessionDisplayStatus(session, 1))
    }

    @Test fun multiSelectKeepsOptionsAndOneOtherAnswer() {
        val question = ApprovalQuestion("q", "Targets?", options = listOf(ApprovalOption("A"), ApprovalOption("B")), multiSelect = true)
        val selected = selectQuestionOption(question, emptyList(), "A", true)
        assertEquals(listOf("A", "custom"), updateQuestionOther(question, selected, "custom"))
        assertEquals(listOf("A", "B"), selectQuestionOption(question, listOf("A"), "B", true))
        assertEquals("custom", questionOtherValue(question, listOf("A", "custom")))
    }

    @Test fun optionalQuestionAllowsEmptyButRequiredQuestionExplainsError() {
        assertNull(questionError(ApprovalQuestion("q", "Optional?", required = false), emptyList()))
        assertEquals("Choose or enter an answer.", questionError(ApprovalQuestion("q", "Required?"), emptyList()))
        assertEquals("Select at least one answer.", questionError(ApprovalQuestion("q", "Many?", multiSelect = true), emptyList()))
    }
}
