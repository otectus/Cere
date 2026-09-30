package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Serializable
data class LocalDraft(
    val sessionId: String,
    val text: String,
    val baseRevision: String,
    val remoteRevision: String = baseRevision,
    val dirty: Boolean,
    val conflict: Boolean = false,
    val remoteText: String? = null,
)

@Serializable
data class PendingCommand(
    val commandId: String,
    val method: String,
    @Transient val params: JsonObject = JsonObject(emptyMap()),
    val createdAt: Long,
    val status: String = "pending",
    val paramsDigest: String = "",
    val scopeVersion: String? = null,
    val sessionId: String? = null,
    val projectId: String? = null,
)

data class ReconciledCache(
    val sessions: List<Session>,
    val messages: List<Message>,
    val approvals: List<Approval>,
    val drafts: Map<String, LocalDraft>,
)

object CacheReconciler {
    private fun older(incoming: String, current: String) =
        (incoming.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) < (current.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)

    /** A slow snapshot or session fetch cannot roll back an acknowledged edit. */
    fun mergeSession(current: Session?, incoming: Session): Session {
        if (current == null) return incoming
        val latest = if (older(incoming.revision, current.revision)) current else incoming
        val draft = if (older(incoming.draftRevision, current.draftRevision) ||
            (incoming.draftRevision == current.draftRevision && !incoming.draftIncluded && current.draftIncluded)) current else incoming
        return latest.copy(draft = draft.draft, draftRevision = draft.draftRevision, draftIncluded = draft.draftIncluded)
    }

    fun mergeDraft(local: LocalDraft?, remote: Session): LocalDraft = when {
        local != null && (older(remote.draftRevision, local.remoteRevision) || !remote.draftIncluded) -> local
        !remote.draftIncluded -> LocalDraft(remote.id, "", remote.draftRevision, remote.draftRevision, dirty = false)
        local == null || !local.dirty || local.text == remote.draft -> LocalDraft(remote.id, remote.draft, remote.draftRevision, remote.draftRevision, dirty = false)
        local.baseRevision == remote.draftRevision -> local.copy(remoteRevision = remote.draftRevision, conflict = false, remoteText = null)
        else -> local.copy(remoteRevision = remote.draftRevision, conflict = true, remoteText = remote.draft)
    }
    /** A save acknowledgment applies to the text sent, not to edits made in flight. */
    fun acknowledgeDraft(current: LocalDraft, sentText: String, revision: String): LocalDraft {
        if ((current.remoteRevision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) >
            (revision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)) return current
        return current.copy(baseRevision = revision, remoteRevision = revision,
            dirty = current.text != sentText, conflict = false, remoteText = null)
    }
    /** Keeps outcome IDs only for authorized resources and redacts in-memory request data across a scope revision. */
    fun retainAuthorizedCommands(commands: List<PendingCommand>, sessionIds: Set<String>, projectIds: Set<String>, scopeVersion: String?): List<PendingCommand> = commands
        .filter { command -> command.sessionId?.let { it in sessionIds } != false && command.projectId?.let { it in projectIds } != false }
        .map { command -> if (command.scopeVersion != null && command.scopeVersion != scopeVersion) command.copy(params = JsonObject(emptyMap())) else command }

    fun merge(current: MobileState, snapshot: SyncSnapshot, selectedSessionId: String?): ReconciledCache {
        val authorized = snapshot.sessionIds?.toSet() ?: snapshot.sessions.mapTo(mutableSetOf(), Session::id)
        val existing = current.sessions.associateBy(Session::id)
        val incoming = snapshot.sessions.map { mergeSession(existing[it.id], it) }.associateBy(Session::id)
        val sessions = (current.sessions.filter { it.id in authorized && it.id !in incoming } + incoming.values)
        val drafts = sessions.associate { remote ->
            val local = current.drafts[remote.id]
            remote.id to mergeDraft(local, remote)
        }
        val retained = current.messages.filter { it.sessionId in authorized && (it.sessionId != selectedSessionId || !it.isConversationMessage()) }
        val selected = if (selectedSessionId != null) snapshot.messages.filter { it.sessionId == selectedSessionId } else emptyList()
        // An ordinary status refresh replaces the newest page, not the older
        // history the user explicitly loaded. Erasure resets the cache first.
        val boundary = selected.firstOrNull()?.id?.let { id -> current.messages.indexOfFirst { it.id == id } } ?: -1
        val older = if (snapshot.messagesBefore != null && boundary >= 0) current.messages.take(boundary)
            .filter { it.sessionId == selectedSessionId && it.isConversationMessage() } else emptyList()
        val live = current.messages.filter { cached -> selected.any { it.id == cached.id } }
        // A push can be reduced while the coroutine applying its earlier
        // snapshot is waiting for the state mutex. Keep those newly arrived rows.
        val pushed = current.messages.filter { it.sessionId == selectedSessionId && it.isConversationMessage() &&
            it.time >= (selected.lastOrNull()?.time ?: 0) && selected.none { remote -> remote.id == it.id } }
        return ReconciledCache(sessions, mergeMessages(retained + older + live + pushed, selected), snapshot.approvals, drafts)
    }
}
