package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.*
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class ReconciliationTest {
    @Test fun privateCacheRoundTripKeepsScrollAnchorAndRequiresLegacyAttachmentsToBeReviewed() {
        val cached = CachedState(scrollPositions = mapOf("s" to SessionScrollPosition("s", "message", 4, 31, false)))
        val restored = WireCodec.json.decodeFromString(CachedState.serializer(), WireCodec.json.encodeToString(CachedState.serializer(), cached))
        assertEquals("message", restored.scrollPositions.getValue("s").anchorMessageId)
        assertEquals(31, restored.scrollPositions.getValue("s").offset)
        val legacy = """{"id":"00000000-0000-0000-0000-000000000001","sessionId":"s","displayName":"old","mime":"image/jpeg","size":1,"sha256":"hash","width":1,"height":1,"transformed":false}"""
        assertNull(WireCodec.json.decodeFromString(LocalAttachment.serializer(), legacy).reviewedAt)
    }

    private fun session(id: String, draft: String, revision: String) = Session(id, "ollama", id, status = "idle", draft = draft, draftRevision = revision)
    private fun snapshot(vararg sessions: Session, messages: List<Message> = emptyList()) = SyncSnapshot("cursor", sessions.toList(), messages = messages)

    @Test fun snapshotStartedBeforeAutosaveCannotRollBackTheRevisionUsedToSend() {
        val saved = session("a", "send this", "4").copy(revision = "8")
        val state = MobileState(sessions = listOf(saved), drafts = mapOf("a" to LocalDraft("a", "send this", "4", "4", false)))
        val delayed = session("a", "old", "3").copy(revision = "9")
        val merged = CacheReconciler.merge(state, snapshot(delayed), "a")
        assertEquals("4", merged.sessions.single().draftRevision)
        assertEquals("send this", merged.sessions.single().draft)
        assertEquals("4", merged.drafts.getValue("a").remoteRevision)
        assertEquals("send this", merged.drafts.getValue("a").text)
    }

    @Test fun lateHydrationAndSummaryDoNotEraseCurrentDraftOrBusyStatus() {
        val current = session("a", "new", "5").copy(revision = "12", status = "working")
        val stale = session("a", "old", "4").copy(revision = "11")
        assertEquals(current, CacheReconciler.mergeSession(current, stale))
        val summary = current.copy(draft = "", draftIncluded = false)
        assertEquals(current, CacheReconciler.mergeSession(current, summary))
    }

    @Test fun messagePushedAfterSnapshotReadIsNotLostWhenSnapshotIsApplied() {
        val a = session("a", "", "0")
        val user = Message("user", "a", role = "user", text = "prompt", revision = "1", time = 1)
        val pushed = Message("answer", "a", role = "assistant", text = "live reply", revision = "1", time = 2)
        val state = MobileState(sessions = listOf(a), messages = listOf(user, pushed))
        assertEquals(listOf(user, pushed), CacheReconciler.merge(state, snapshot(a, messages = listOf(user)), "a").messages)
    }

    @Test fun saveAcknowledgmentPreservesTypingThatArrivedDuringRequest() {
        val latest = LocalDraft("a", "hello world", "1", "1", true)
        val ack = CacheReconciler.acknowledgeDraft(latest, "hello", "2")
        assertEquals("hello world", ack.text)
        assertEquals("2", ack.baseRevision)
        assertTrue(ack.dirty)
        assertFalse(CacheReconciler.acknowledgeDraft(ack, "hello world", "3").dirty)
    }

    @Test fun oldAcknowledgmentCannotEraseNewerDesktopConflict() {
        val latest = LocalDraft("a", "phone", "1", "4", true, true, "desktop")
        assertEquals(latest, CacheReconciler.acknowledgeDraft(latest, "phone", "2"))
    }

    @Test fun ordinaryRefreshPreservesActivityOlderPagesAndNewerStreamingRevision() {
        val a = session("a", "", "0")
        val older = Message("older", "a", role = "user", text = "older", revision = "1", time = 1)
        val tool = Message("tool", "a", role = "tool", kind = "tool", text = "output", revision = "1", time = 2)
        val live = Message("live", "a", role = "assistant", text = "full reply", revision = "4", time = 3)
        val state = MobileState(sessions = listOf(a), messages = listOf(older, tool, live))
        val fresh = snapshot(a, messages = listOf(live.copy(text = "partial", revision = "3"))).copy(messagesBefore = "live")
        val merged = CacheReconciler.merge(state, fresh, "a")
        assertEquals(listOf("older", "tool", "live"), merged.messages.map { it.id })
        assertEquals("full reply", merged.messages.last().text)
    }

    @Test fun divergentLocalDraftSurvivesAuthoritativeSnapshotAndConflicts() {
        val state = MobileState(sessions = listOf(session("a", "server old", "1")), drafts = mapOf("a" to LocalDraft("a", "phone edit", "1", "1", true)))
        val merged = CacheReconciler.merge(state, snapshot(session("a", "desktop edit", "2")), "a")
        assertEquals("phone edit", merged.drafts.getValue("a").text)
        assertTrue(merged.drafts.getValue("a").conflict)
        assertEquals("desktop edit", merged.drafts.getValue("a").remoteText)
    }

    @Test fun snapshotPurgesUnauthorizedDataButRetainsOtherAuthorizedHistory() {
        val a = session("a", "", "0"); val b = session("b", "", "0")
        val state = MobileState(sessions = listOf(a, b, session("gone", "", "0")),
            messages = listOf(Message("a1", "a", role="user", text="cached", revision="1"), Message("old", "gone", role="user", text="secret", revision="1")),
            drafts = mapOf("gone" to LocalDraft("gone", "secret", "0", dirty=true)))
        val fresh = Message("b1", "b", role="assistant", text="fresh", revision="1")
        val merged = CacheReconciler.merge(state, snapshot(a, b, messages=listOf(fresh)), "b")
        assertEquals(setOf("a1", "b1"), merged.messages.map { it.id }.toSet())
        assertFalse(merged.drafts.containsKey("gone"))
    }

    @Test fun matchingRemoteDraftSettlesDirtyLocalDraft() {
        val state = MobileState(drafts = mapOf("a" to LocalDraft("a", "same", "1", "1", true)))
        val merged = CacheReconciler.merge(state, snapshot(session("a", "same", "2")), "a")
        assertFalse(merged.drafts.getValue("a").dirty)
        assertEquals("2", merged.drafts.getValue("a").baseRevision)
    }

    @Test fun pagedSummaryKeepsAuthorizedSessionAndNeverOverwritesLocalDraft() {
        val first = session("first", "summary", "9").copy(draft = "", draftIncluded = false)
        val older = session("older", "server", "2")
        val state = MobileState(sessions = listOf(older, session("gone", "", "0")), drafts = mapOf(
            "first" to LocalDraft("first", "phone edit", "3", "3", true),
            "older" to LocalDraft("older", "cached", "2", "2", false),
            "gone" to LocalDraft("gone", "private", "0", "0", true),
        ))
        val snapshot = SyncSnapshot("cursor", sessions = listOf(first), sessionIds = listOf("first", "older"), nextSessionOffset = 50)
        val merged = CacheReconciler.merge(state, snapshot, null)
        assertEquals(setOf("first", "older"), merged.sessions.map { it.id }.toSet())
        assertEquals("phone edit", merged.drafts.getValue("first").text)
        assertFalse(merged.drafts.containsKey("gone"))
    }

    @Test fun authoritativeScopePrunesDirectAndIndirectPendingCommands() {
        fun command(id: String, params: JsonObject, sessionId: String? = null, projectId: String? = null) = PendingCommand(id, "test.$id", params, 1L, paramsDigest = "digest-$id", scopeVersion = "4", sessionId = sessionId, projectId = projectId)
        val kept = command("kept", buildJsonObject { put("sessionId", "allowed"); put("projectId", "project-a") }, "allowed", "project-a")
        val removedSession = command("session", buildJsonObject { put("sourceSessionId", "removed") }, "removed", "project-a")
        val removedProject = command("project", buildJsonObject { put("confirmProjectId", "project-b") }, "allowed", "project-b")
        val indirectApproval = command("approval", buildJsonObject { put("approvalId", "opaque"); put("answers", buildJsonObject { put("secret", "private answer") }) }, "removed", "project-a")
        val unscoped = command("unscoped", buildJsonObject { put("value", "safe") })

        assertEquals(
            listOf("kept", "unscoped"),
            CacheReconciler.retainAuthorizedCommands(listOf(kept, removedSession, removedProject, indirectApproval, unscoped), setOf("allowed"), setOf("project-a"), "4").map { it.commandId },
        )
    }

    @Test fun pendingCommandPersistenceOmitsSensitiveParameters() {
        val command = PendingCommand("id", "approvals.answer", buildJsonObject { put("answers", buildJsonObject { put("secret", "private answer") }) }, 1L, paramsDigest = "digest", scopeVersion = "3", sessionId = "session")
        val encoded = WireCodec.json.encodeToString(PendingCommand.serializer(), command)
        assertFalse(encoded.contains("private answer"))
        assertFalse(encoded.contains("answers"))
        assertEquals(JsonObject(emptyMap()), WireCodec.json.decodeFromString(PendingCommand.serializer(), encoded).params)
    }
}
