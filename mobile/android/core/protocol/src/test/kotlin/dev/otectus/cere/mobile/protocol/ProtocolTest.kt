package dev.otectus.cere.mobile.protocol

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class ProtocolTest {
    @Test fun queuedSendIsAcceptedButUnknownOutcomesStayUnresolved() {
        for (status in listOf("queued", "accepted", "completed")) {
            val result = WireCodec.json.parseToJsonElement("""{"status":"$status","turnId":"turn"}""")
            assertEquals(status, acceptedSendStatus(result))
        }
        for (result in listOf("{}", "null", "[]", """{"status":"unknown"}""", """{"status":"failed"}""")) {
            assertNull(acceptedSendStatus(WireCodec.json.parseToJsonElement(result)))
        }
    }

    @Test fun sessionAndQuestionMetadataDecodeWithSafeDefaults() {
        val session = WireCodec.json.decodeFromString<Session>("""{"id":"s","provider":"codex","title":"Work","status":"working","agents":[{"id":"a","name":"Scout","task":"Inspect","status":"waiting","detail":"Needs input","updated":4}]}""")
        assertEquals("Scout", session.agents.single().name)
        assertEquals("Needs input", session.agents.single().detail)
        val question = WireCodec.json.decodeFromString<ApprovalQuestion>("""{"id":"q","question":"Pick targets","header":"Targets","options":[{"label":"A","description":"First"}],"multiSelect":true,"isSecret":true,"allowOther":false,"required":false}""")
        assertEquals("Targets", question.header)
        assertTrue(question.multiSelect)
        assertTrue(question.isSecret)
        assertFalse(question.allowOther)
        assertFalse(question.required)
        val legacy = WireCodec.json.decodeFromString<ApprovalQuestion>("""{"id":"q","question":"Continue?"}""")
        assertTrue(legacy.allowOther)
        assertTrue(legacy.required)
    }

    @Test fun welcomeNegotiatesPasswordlessSendsWithoutAssumingOldBrokerSupport() {
        val legacy = """{"v":1,"type":"welcome","authSessionId":"auth","expiresAt":1,"epoch":"1","desktopId":"desktop","scopeVersion":"1","protocol":{"major":1,"minor":0},"operations":["sessions.send"]}"""
        val legacyWelcome = WireCodec.json.decodeFromString<Welcome>(legacy)
        assertEquals("action-key", legacyWelcome.sendAuthentication)
        assertEquals(ActionAuthentication.BIOMETRIC, legacyWelcome.actionAuthentication)
        val current = legacy.dropLast(1) + """, "sendAuthentication":"connection-key"}"""
        assertEquals("connection-key", WireCodec.json.decodeFromString<Welcome>(current).sendAuthentication)
        val trusted = legacy.dropLast(1) + """, "actionAuthentication":"trusted-device"}"""
        assertEquals(ActionAuthentication.TRUSTED_DEVICE, WireCodec.json.decodeFromString<Welcome>(trusted).actionAuthentication)
    }

    @Test fun conversationExcludesToolsThinkingAndSystemActivity() {
        val reply = Message("id", "session", role = "assistant", text = "Hello", revision = "1")
        assertTrue(reply.isConversationMessage())
        assertTrue(reply.copy(role = "user").isConversationMessage())
        listOf("question", "answer", "queued", "queue-cancelled").forEach { kind ->
            assertTrue(kind, reply.copy(kind = kind).isConversationMessage())
        }
        assertFalse(reply.copy(role = "tool").isConversationMessage())
        assertFalse(reply.copy(kind = "tool").isConversationMessage())
        assertFalse(reply.copy(kind = "thinking").isConversationMessage())
        assertFalse(reply.copy(role = "system").isConversationMessage())
    }

    @Test fun olderHistoryCannotReplaceStreamedText() {
        val live = Message("id", "session", role = "assistant", text = "Hello world", revision = "12")
        val history = live.copy(text = "Hello", revision = "9")
        assertEquals(listOf(live), mergeMessages(listOf(live), listOf(history)))
    }
    @Test fun canonicalJsonSortsKeysAndPreservesIntegers() {
        val value = buildJsonObject { put("z", 2); put("a", "hello") }
        assertEquals("{\"a\":\"hello\",\"z\":2}", CanonicalJson.encode(value))
        assertEquals(43, CanonicalJson.sha256(value).length)
    }

    @Test fun reducerIgnoresOlderMessageRevision() {
        val newest = Message("opaque", "s", role = "assistant", text = "new", revision = "10")
        val old = newest.copy(text = "old", revision = "9")
        val first = ReducedState(messages = mapOf(newest.id to newest))
        val event = Event(1, "event", "c", "e", "message.upsert", "9", WireCodec.json.encodeToJsonElement(Message.serializer(), old).let { it as kotlinx.serialization.json.JsonObject })
        assertEquals("new", EventReducer.apply(first, event).messages.getValue("opaque").text)
    }

    @Test fun rejectsUnknownFrameType() {
        assertTrue(runCatching { WireCodec.decodeFrame("{\"v\":1,\"type\":\"surprise\"}") }.isFailure)
    }

    @Test fun authenticationTranscriptMatchesNodeCanonicalizeFixture() {
        val challenge = AuthChallenge(1, "auth.challenge", "11111111-1111-4111-8111-111111111111", "AAECAwQFBgcICQ", "42", "desktop-fixture", 1_893_456_000_000)
        val transcript = SigningTranscripts.authentication("hello_fixture_digest", challenge, "desktop-fixture", "22222222-2222-4222-8222-222222222222", 1)
        // Generated by Node 24 + canonicalize 2.1.0, the exact implementation used by the broker.
        assertEquals("{\"challenge\":{\"audience\":\"desktop-fixture\",\"challengeId\":\"11111111-1111-4111-8111-111111111111\",\"epoch\":\"42\",\"expiresAt\":1893456000000,\"serverNonce\":\"AAECAwQFBgcICQ\"},\"desktopId\":\"desktop-fixture\",\"deviceId\":\"22222222-2222-4222-8222-222222222222\",\"domain\":\"cere.mobile.auth.v1\",\"epoch\":\"42\",\"helloDigest\":\"hello_fixture_digest\",\"keyVersion\":1}", CanonicalJson.encode(transcript))
        assertEquals("CrdyObL51vV791UqoqBDsVsB5xXd93nC5qb4S-SLmlw", CanonicalJson.sha256(transcript))
    }

    @Test fun canonicalNullMatchesNodeCanonicalizeFixture() {
        val value = buildJsonObject { put("a", JsonNull); put("b", buildJsonArray { add(JsonNull); add(JsonPrimitive(true)); add(JsonPrimitive(2)) }) }
        assertEquals("{\"a\":null,\"b\":[null,true,2]}", CanonicalJson.encode(value))
        assertEquals("VEl91tnzJPCWEUgplRDeleNQ2RWDJR4NjP-YRfPCXNk", CanonicalJson.sha256(value))
    }
}
