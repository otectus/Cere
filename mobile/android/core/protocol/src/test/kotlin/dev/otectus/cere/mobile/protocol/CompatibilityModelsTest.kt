package dev.otectus.cere.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** MOB-002, MOB-003, MOB-005: the payloads the desktop actually sends decode without failing. */
class CompatibilityModelsTest {
    private fun behavior(json: String) = WireCodec.json.decodeFromString(ConversationBehavior.serializer(), json)

    @Test fun theDesktopsDefaultStyleAnswerWithExplicitNullsDecodes() {
        // The exact answer a conversation without a style gets (broker/remote/router.ts sessions.behavior).
        val value = behavior("""{"source":"global","profile":null,"posture":null,"standingInstructions":false,"warnings":[]}""")
        assertNull(value.profile); assertNull(value.posture); assertEquals("global", value.source); assertFalse(value.standingInstructions)
    }

    @Test fun everyMixOfProfileAndPostureDecodes() {
        assertEquals("Concise", behavior("""{"source":"project","profile":{"label":"Concise"},"posture":null,"standingInstructions":false,"warnings":[]}""").profile?.label)
        val posture = behavior("""{"source":"session","profile":null,"posture":{"label":"Careful","pinned":true},"standingInstructions":true,"warnings":["Tool ceiling applies"]}""")
        assertNull(posture.profile); assertEquals("Careful", posture.posture?.label); assertTrue(posture.posture!!.pinned); assertEquals(listOf("Tool ceiling applies"), posture.warnings)
        val both = behavior("""{"source":"session","profile":{"label":"Teacher"},"posture":{"label":"Brief","pinned":false},"standingInstructions":false,"warnings":[]}""")
        assertEquals("Teacher", both.profile?.label); assertEquals("Brief", both.posture?.label)
        // An older or trimmed answer that leaves optional fields out.
        val sparse = behavior("""{"source":"global"}""")
        assertNull(sparse.profile); assertNull(sparse.posture); assertTrue(sparse.warnings.isEmpty())
    }

    @Test fun sessionsCarryToolsRouteAndWorkbenchStateAndOlderOnesDefault() {
        val api = WireCodec.json.decodeFromString(Session.serializer(), """{"id":"s","provider":"openai","title":"t","status":"idle","tools":true,"toolsAvailable":true,"workbenchFamilies":["files","images"],"workbenchTakeover":"acknowledge","workbenchNote":"Pauses"}""")
        assertTrue(api.tools); assertEquals(true, api.toolsAvailable); assertEquals(listOf("files", "images"), api.workbenchFamilies); assertEquals("acknowledge", api.workbenchTakeover)
        val compatible = WireCodec.json.decodeFromString(Session.serializer(), """{"id":"s","provider":"compatible","title":"t","status":"idle","tools":false,"toolsAvailable":false,"toolsUnavailableReason":"Not declared","routeRevision":"connection:abc:2","imagesAvailable":true,"connectionName":"Workstation","workbenchFamilies":[],"workbenchTakeover":null}""")
        assertEquals("connection:abc:2", compatible.routeRevision); assertEquals("Workstation", compatible.connectionName); assertNull(compatible.workbenchTakeover)
        val older = WireCodec.json.decodeFromString(Session.serializer(), """{"id":"s","provider":"ollama","title":"t","status":"idle"}""")
        assertNull(older.toolsAvailable); assertNull(older.routeRevision); assertTrue(older.workbenchFamilies.isEmpty())
    }

    @Test fun workbenchResultsStayInTheConversationAsDesktopOnlyReferences() {
        val card = WireCodec.json.decodeFromString(Message.serializer(), """{"id":"m","sessionId":"s","role":"workbench","kind":"changes","text":"Proposed file changes · view this result on the desktop.","revision":"1","desktopOnly":{"kind":"changes","label":"Proposed file changes"}}""")
        assertTrue(card.isDesktopOnlyResult()); assertTrue(card.isConversationMessage()); assertEquals("Proposed file changes", card.desktopOnly?.label)
        val tool = WireCodec.json.decodeFromString(Message.serializer(), """{"id":"t","sessionId":"s","role":"tool","kind":"tool","text":"ran","revision":"1"}""")
        assertFalse(tool.isConversationMessage()); assertFalse(tool.isDesktopOnlyResult())
        val listing = WireCodec.json.decodeFromString(ModelListing.serializer(), """{"items":[],"unlisted":true}""")
        assertTrue(listing.unlisted)
    }
}
