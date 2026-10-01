package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Session
import dev.otectus.cere.mobile.protocol.WireCodec
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MobileCapabilitiesTest {
    @Test fun olderBrokerDoesNotPretendDesktopAttachmentsAreAbsent() {
        val legacy = WireCodec.json.decodeFromString(Session.serializer(), """{"id":"s","provider":"ollama","title":"Chat","status":"idle"}""")
        assertNull(legacy.draftAttachmentCount)
        val current = WireCodec.json.decodeFromString(Session.serializer(), """{"id":"s","provider":"ollama","title":"Chat","status":"idle","draftAttachmentCount":0}""")
        assertEquals(0, current.draftAttachmentCount)
    }

    @Test fun unrelatedSettingsCanBeSavedWithoutAnOllamaGrant() {
        val denied = assistantSettingsPatch(buildJsonObject { put("ollamaHost", "") }, "4", "New personality", "", "auto")
        assertFalse(denied.containsKey("defaultModel"))
        assertEquals("New personality", denied.getValue("personality").jsonPrimitive.content)
        val allowed = assistantSettingsPatch(buildJsonObject { put("ollamaHost", "http://127.0.0.1:11434") }, "4", "New personality", "model", "auto")
        assertEquals("model", allowed.getValue("defaultModel").jsonPrimitive.content)
    }

    @Test fun searchNeedsAllOfProviderCapabilitySettingAndConnection() {
        val session = Session("s", "ollama", "Chat", status = "idle")
        val state = MobileState(connection = ConnectionState.Online("Desktop", setOf("sessions.send"), 0),
            settings = buildJsonObject { put("webSearch", buildJsonObject { put("enabled", true) }) },
            permissions = buildJsonObject { put("caps", JsonArray(listOf(JsonPrimitive("web")))) })
        assertTrue(state.canSearchWeb(session))
        assertFalse(state.copy(permissions = JsonObject(emptyMap())).canSearchWeb(session))
        assertFalse(state.copy(settings = JsonObject(emptyMap())).canSearchWeb(session))
        assertFalse(state.copy(connection = ConnectionState.Offline("Disconnected", null)).canSearchWeb(session))
        assertFalse(state.canSearchWeb(session.copy(provider = "codex")))
    }

    @Test fun newerAttachmentDraftSurvivesOlderSummary() {
        val current = Session("s", "ollama", "Chat", status = "idle", revision = "9", draftRevision = "4", draftAttachmentCount = 2)
        val older = current.copy(revision = "8", draftRevision = "3", draftAttachmentCount = 0, draftIncluded = false)
        assertEquals(2, CacheReconciler.mergeSession(current, older).draftAttachmentCount)
        assertEquals(0, CacheReconciler.mergeSession(current, current.copy(revision = "10", draftRevision = "5", draftAttachmentCount = 0)).draftAttachmentCount)
    }
}
