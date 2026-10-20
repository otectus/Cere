package dev.otectus.cere.mobile.protocol

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every frame in protocol/mobile/v1/conformance.json was recorded from a real gateway by
 * tests/mobile-conformance.test.ts. Each must decode with the phone's models; the checks below pin
 * the semantics the phone relies on (scoped references, paging, citations, sources, truncation).
 */
class ConformanceTest {
    private val fixture = WireCodec.json.parseToJsonElement(SharedFixtures.text("protocol/mobile/v1/conformance.json")).jsonObject
    private fun cases(key: String) = fixture.getValue(key).jsonArray.map { it.jsonObject }
    private fun frame(case: JsonObject) = WireCodec.decodeFrame(case.getValue("frame").toString())
    private fun result(case: JsonObject): JsonElement = (frame(case) as Frame.Reply).value.let { assertNull(case.toString(), it.error); checkNotNull(it.result) }
    private inline fun <reified T> decode(element: JsonElement): T = WireCodec.json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), element)
    private fun named(name: String) = cases("cases").single { it.getValue("name").jsonPrimitive.content == name }

    @Test fun everyRecordedFrameDecodesWithThePhonesModels() {
        val recorded = cases("cases")
        assertTrue(recorded.size >= 20)
        for (case in recorded) {
            val name = case.getValue("name").jsonPrimitive.content
            when (val kind = case.getValue("decode").jsonPrimitive.content) {
                "Welcome" -> assertTrue(name, frame(case) is Frame.Accepted)
                "SyncSnapshot" -> decode<SyncSnapshot>(result(case))
                "Session" -> decode<Session>(result(case))
                "SessionPage", "SessionBatch" -> decode<List<Session>>(result(case).jsonObject.getValue("items"))
                "MessagePage" -> decode<List<Message>>(result(case).jsonObject.getValue("items"))
                "MessageList" -> decode<List<Message>>(result(case))
                "Message" -> decode<Message>(result(case))
                "MessagePart" -> assertNotNull(result(case).jsonObject["content"])
                "ApprovalList" -> decode<List<Approval>>(result(case))
                "ProjectList" -> decode<List<Project>>(result(case))
                "JsonObject" -> result(case).jsonObject
                "Error" -> (frame(case) as Frame.Reply).value.error.let { error ->
                    assertNotNull(name, error); assertTrue(name, error!!.code.matches(Regex("^[A-Z_]+$"))); assertTrue(name, error.message.isNotBlank())
                }
                "Event" -> (frame(case) as Frame.Push).value.let { event -> if (event.name == "message.upsert") decode<Message>(event.data) }
                else -> error("Unknown decode kind $kind in $name")
            }
        }
    }

    @Test fun pinnedRepliesAndDesktopDraftAttachmentsDecode() {
        assertTrue(decode<Message>(result(named("messages.bookmark"))).bookmarked)
        val pins = decode<List<Message>>(result(named("messages.bookmarks")).jsonObject.getValue("items"))
        assertTrue(pins.single().bookmarked); assertNotNull(pins.single().sessionTitle)
        val draft = decode<Session>(result(named("sessions.get with desktop draft attachments")))
        assertEquals(listOf("notes ✓.txt"), draft.draftAttachments.map(DraftAttachment::name))
        assertEquals(draft.draftAttachmentCount, draft.draftAttachments.size)
    }

    @Test fun welcomeNegotiatesProtocolFeaturesAndNamesTheBuild() {
        val welcome = (frame(named("welcome")) as Frame.Accepted).value
        assertEquals(1, welcome.protocol.major)
        assertTrue(welcome.protocol.minor >= 1)
        assertTrue(welcome.features.containsAll(setOf("activity.page", "sessions.batch", "search.ids", "message.sources", "citations.display", "agent.refs")))
        assertNotNull(welcome.build)
        assertTrue(welcome.operations.containsAll(setOf("activity.page", "sessions.batch")))
    }

    @Test fun snapshotCarriesScopedReferencesSourcesCitationsAndTruncation() {
        val snapshot = decode<SyncSnapshot>(result(named("sync.open")))
        val session = snapshot.sessions.single { it.title == "Ünïcode 🦊 conformance" }
        val agent = session.agents.single()
        val approval = snapshot.approvals.single()
        // The request names its agent by an opaque reference, never the native thread ID.
        assertEquals(agent.id, approval.agentId)
        assertFalse(agent.id.contains("native"))
        assertEquals(false, snapshot.settings["showMemoryCitations"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull())
        val messages = snapshot.messages.associateBy(Message::id)
        val table = messages.getValue("11111111-1111-4111-8111-000000000002")
        assertEquals(listOf("Ruff docs", "Unsafe"), table.sources.map { it.getValue("title").jsonPrimitive.content })
        assertTrue(table.text.contains("[evidence:"))
        assertFalse(Citations.shown(table.text, showCitations = false).contains("evidence:"))
        val long = messages.getValue("11111111-1111-4111-8111-000000000004")
        assertTrue(long.contentTruncated)
        assertEquals(20004L, long.contentChars)
        assertEquals("unicode-scalar", long.textParts?.encoding)
        assertTrue(long.text.length < 20004)
    }

    @Test fun pagesContinueAndBatchesNameWhatLeftScope() {
        val activity = result(named("activity.page")).jsonObject
        assertEquals(2, decode<List<Message>>(activity.getValue("items")).size)
        assertNotNull(activity["before"]?.jsonPrimitive?.contentOrNull)
        val continued = decode<List<Message>>(result(named("activity.page continued")).jsonObject.getValue("items"))
        assertEquals(1, continued.size)
        assertTrue(continued.none(Message::isConversationMessage))
        val list = result(named("sessions.list withIds")).jsonObject
        assertEquals(list.getValue("total").jsonPrimitive.int, list.getValue("ids").jsonArray.size)
        val batch = result(named("sessions.batch")).jsonObject
        assertEquals(1, batch.getValue("items").jsonArray.size)
        assertEquals(1, batch.getValue("missing").jsonArray.size)
        val part = result(named("sessions.messagePart")).jsonObject
        assertEquals("unicode-scalar", part.getValue("encoding").jsonPrimitive.content)
    }

    @Test fun framesFromANewerDesktopStillDecode() {
        for (case in cases("forwardCompatible")) {
            val name = case.getValue("name").jsonPrimitive.content
            when (val decoded = frame(case)) {
                is Frame.Reply -> decode<Session>(checkNotNull(decoded.value.result)).let { assertEquals(name, "future-status", it.status); assertEquals("123456789012345678901234567890", it.revision) }
                is Frame.Push -> if (decoded.value.name == "message.upsert") decode<Message>(decoded.value.data).let { assertEquals(name, "future-kind", it.kind); assertFalse(it.isConversationMessage()) }
                else -> error("Unexpected frame in $name")
            }
        }
    }
}
