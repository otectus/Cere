package dev.otectus.cere.mobile.data

/**
 * What to do with a command whose outcome the desktop can no longer confirm.
 *
 * Nothing here replays a command. Commands whose effect the next snapshot shows anyway
 * (draft saves, titles, pins, read markers, Stop) are simply forgotten. An approval
 * answer is forgotten once a snapshot is applied: if the request still exists the answer
 * never took effect and the person can answer again; if it ended there is nothing left
 * to answer. Every other unknown outcome stays listed until the person checks the PC
 * and acknowledges it.
 */
object CommandOutcomes {
    private val selfHealing = setOf(
        "drafts.put", "sessions.rename", "sessions.organize", "sessions.read", "sessions.stop",
        "sessions.disconnect", "attachments.begin", "attachments.commit", "attachments.abort",
        "permissions.pause", "devices.selfRevoke",
    )

    /** Unknown outcomes the next snapshot makes irrelevant; drop them instead of waiting for review. */
    fun dropsWhenUnknown(method: String): Boolean = method in selfHealing

    /** Unknown outcomes a person must check on the PC before the phone forgets them. */
    fun needsReview(command: PendingCommand): Boolean = command.status == "unknown" && !dropsWhenUnknown(command.method) && command.method != "approvals.answer"

    /** Applied after an authoritative snapshot: unknown approval answers can be answered again or have ended. */
    fun afterSnapshot(commands: List<PendingCommand>): List<PendingCommand> =
        commands.filterNot { it.status == "unknown" && (it.method == "approvals.answer" || dropsWhenUnknown(it.method)) }

    /** An answer in flight for this exact request blocks a second answer; other requests stay answerable. */
    fun answering(commands: List<PendingCommand>, approvalId: String, digest: String): Boolean =
        commands.any { it.method == "approvals.answer" && it.approvalId == approvalId && it.approvalDigest == digest && it.status != "unknown" }

    /** Plain-language name for an unresolved command. */
    fun describe(command: PendingCommand): String = when (command.method) {
        "sessions.send" -> "Send a message"
        "sessions.create" -> "Create a conversation"
        "sessions.handoffCreate" -> "Hand off a conversation"
        "sessions.import" -> "Import desktop history"
        "sessions.configure" -> "Change a conversation's model"
        "approvals.answer" -> "Answer a request"
        "desktop.execute" -> "Run a desktop control"
        "timers.cancel" -> "Cancel a timer"
        "settings.patch" -> "Update assistant settings"
        "memory.save" -> "Save a memory note"
        "memory.forget" -> "Forget a memory record"
        "memory.clear" -> "Clear project memory"
        "permissions.reduce" -> "Reduce this phone's access"
        else -> command.method
    } + (command.label?.let { " · $it" } ?: "")
}
