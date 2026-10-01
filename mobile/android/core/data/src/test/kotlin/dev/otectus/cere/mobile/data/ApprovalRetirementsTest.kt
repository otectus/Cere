package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Approval
import org.junit.Assert.assertEquals
import org.junit.Test

class ApprovalRetirementsTest {
    private fun approval(id: String = "approval", revision: String, digest: String) = Approval(
        id = id,
        sessionId = "session",
        kind = "command",
        title = "Run command",
        choices = listOf("allow", "deny", "cancel"),
        revision = revision,
        digest = digest,
        canAnswer = true,
    )

    @Test fun snapshotCapturedBeforeTerminalResponseCannotRestoreRetiredApproval() {
        val tracker = ApprovalRetirements()
        val completed = approval(revision = "7", digest = "signed-old")
        val snapshotAlreadyInFlight = listOf(completed)

        tracker.retire(completed.identity())

        assertEquals(emptyList<Approval>(), tracker.visible(snapshotAlreadyInFlight))
    }

    @Test fun reusedIdWithNewSignedIdentityRemainsVisible() {
        val tracker = ApprovalRetirements()
        val completed = approval(revision = "7", digest = "signed-old")
        val revised = approval(revision = "8", digest = "signed-old")
        val redigested = approval(revision = "7", digest = "signed-new")

        tracker.retire(completed.identity())

        assertEquals(listOf(revised, redigested), tracker.visible(listOf(completed, revised, redigested)))
    }
}
