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
    val baseTextHash: String? = null,
    // The text of our own compare-and-set write may arrive via snapshot before its reply.
    val pendingTextHash: String? = null,
) {
    internal fun edited(value: String, session: Session): LocalDraft {
        if (value == text) return this
        if (pendingTextHash == null && session.draftIncluded && value == session.draft)
            return LocalDraft(sessionId, value, session.draftRevision, dirty = false)
        val baseline = baseTextHash ?: if (session.draftIncluded && session.draftRevision == baseRevision)
            draftHash(session.draft) else null
        return copy(text = value, dirty = true, baseTextHash = baseline)
    }
}

private fun draftHash(text: String) = CanonicalJson.sha256(JsonPrimitive(text))

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
    /** The exact request an approval answer targets; other requests in the session stay answerable. */
    val approvalId: String? = null,
    val approvalDigest: String? = null,
    /** Short, non-sensitive label shown when the outcome needs review (a session title, a control name). */
    val label: String? = null,
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
        return latest.copy(draft = draft.draft, draftRevision = draft.draftRevision, draftIncluded = draft.draftIncluded,
            draftAttachmentCount = draft.draftAttachmentCount, draftAttachments = draft.draftAttachments)
    }

    fun mergeDraft(local: LocalDraft?, remote: Session, previous: Session? = null): LocalDraft {
        val revision = remote.draftRevision
        if (!remote.draftIncluded) {
            if (local?.dirty == true && local.baseTextHash == null && previous?.draftIncluded == true &&
                previous.draftRevision == local.baseRevision) return local.copy(baseTextHash = draftHash(previous.draft))
            return local ?: LocalDraft(remote.id, "", revision, dirty = false)
        }
        if (local != null && older(revision, local.remoteRevision)) return local
        if (local?.pendingTextHash != null && revision == local.baseRevision) return local
        if (local == null || !local.dirty || local.text == remote.draft)
            return LocalDraft(remote.id, remote.draft, revision, dirty = false)
        if (revision == local.baseRevision) return local
        val remoteHash = draftHash(remote.draft)
        // The previously hydrated session supplies the baseline for pre-upgrade drafts.
        val unchangedText = local.baseTextHash == remoteHash || previous != null && previous.draftIncluded &&
            previous.draftRevision == local.baseRevision && previous.draft == remote.draft
        val ownWrite = local.pendingTextHash == remoteHash &&
            local.baseRevision.toBigIntegerOrNull()?.inc() == revision.toBigIntegerOrNull()
        if (unchangedText || ownWrite) return acknowledgeDraft(local, remote.draft, revision)
        return local.copy(remoteRevision = revision, conflict = true, remoteText = remote.draft, pendingTextHash = null)
    }

    fun awaitingDraftWrite(local: LocalDraft, text: String) = local.copy(pendingTextHash = draftHash(text))

    /** Keep the accepted send's expected clear across a delayed snapshot or process restart. */
    fun afterAcceptedSend(local: LocalDraft, sentText: String, submittedRevision: String): LocalDraft {
        if (local.conflict && local.baseRevision == submittedRevision && local.remoteText == "" &&
            submittedRevision.toBigIntegerOrNull()?.inc() == local.remoteRevision.toBigIntegerOrNull())
            return acknowledgeDraft(local, "", local.remoteRevision)
        if (local.remoteRevision != submittedRevision || local.conflict) return local
        val text = if (local.text == sentText) "" else local.text
        return awaitingDraftWrite(local.copy(text = text, dirty = text.isNotEmpty()), "")
    }
    /** A save acknowledgment applies to the text sent, not to edits made in flight. */
    fun acknowledgeDraft(current: LocalDraft, sentText: String, revision: String): LocalDraft {
        if ((current.remoteRevision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) >
            (revision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)) return current
        val dirty = current.text != sentText
        return LocalDraft(current.sessionId, current.text, revision, dirty = dirty,
            baseTextHash = if (dirty) draftHash(sentText) else null)
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
            remote.id to mergeDraft(local, remote, existing[remote.id])
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
