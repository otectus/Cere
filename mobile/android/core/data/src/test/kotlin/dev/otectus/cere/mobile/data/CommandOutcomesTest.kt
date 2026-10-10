package dev.otectus.cere.mobile.data

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class CommandOutcomesTest {
    private fun command(id: String, method: String, status: String = "pending", approvalId: String? = null, digest: String? = null, sessionId: String? = "s", label: String? = null) =
        PendingCommand(id, method, JsonObject(emptyMap()), 1, status = status, sessionId = sessionId, approvalId = approvalId, approvalDigest = digest, label = label)

    @Test fun anUncertainAnswerBlocksOnlyItsOwnRequest() {
        val lost = command("a", "approvals.answer", status = "unknown", approvalId = "old", digest = "d1")
        val inFlight = command("b", "approvals.answer", approvalId = "current", digest = "d2")
        // The lost Deny no longer blocks a new request in the same conversation.
        assertFalse(CommandOutcomes.answering(listOf(lost), "next", "d3"))
        assertFalse(CommandOutcomes.answering(listOf(lost), "old", "d1"))
        assertTrue(CommandOutcomes.answering(listOf(inFlight), "current", "d2"))
        // A changed request (new digest) can be answered again.
        assertFalse(CommandOutcomes.answering(listOf(inFlight), "current", "d9"))
    }

    @Test fun aSnapshotSettlesAnswersAndSelfCorrectingCommandsButKeepsOthersForReview() {
        val commands = listOf(
            command("answer", "approvals.answer", status = "unknown", approvalId = "x", digest = "d"),
            command("draft", "drafts.put", status = "unknown"),
            command("send", "sessions.send", status = "unknown"),
            command("control", "desktop.execute", status = "unknown"),
            command("pending", "approvals.answer", approvalId = "y", digest = "d"),
        )
        assertEquals(listOf("send", "control", "pending"), CommandOutcomes.afterSnapshot(commands).map(PendingCommand::commandId))
        assertTrue(CommandOutcomes.needsReview(commands[3]))
        assertFalse(CommandOutcomes.needsReview(commands[0]))
        assertFalse(CommandOutcomes.needsReview(commands[4]))
        assertTrue(CommandOutcomes.dropsWhenUnknown("sessions.rename"))
        assertFalse(CommandOutcomes.dropsWhenUnknown("sessions.send"))
    }

    @Test fun unresolvedActionsAreDescribedInPlainLanguage() {
        assertEquals("Run a desktop control · Set desktop volume to 40%", CommandOutcomes.describe(command("c", "desktop.execute", label = "Set desktop volume to 40%")))
        assertEquals("Send a message", CommandOutcomes.describe(command("s", "sessions.send")))
    }

    @Test fun replacementWaitsForPendingWorkAndPointsToTheList() {
        val blocker = ReplacementPolicy.blocker(MobileState(pendingCommands = listOf(command("c", "desktop.execute", status = "unknown"))))!!
        assertTrue(blocker.contains("pending command"))
        assertTrue(blocker.contains("Settings"))
        assertNull(ReplacementPolicy.blocker(MobileState()))
    }
}
