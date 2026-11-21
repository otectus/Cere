package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Welcome
import dev.otectus.cere.mobile.protocol.WireCodec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** MOB-008: the connected build is kept from welcome, an older welcome stays unknown, and the summary leaks nothing. */
class ConnectionDiagnosticsTest {
    private fun welcome(extra: String) = WireCodec.json.decodeFromString(Welcome.serializer(), """{"v":1,"type":"welcome","authSessionId":"a","expiresAt":1,"epoch":"e","desktopId":"d","scopeVersion":"1","protocol":{"major":1,"minor":1},"operations":["sync.open"]$extra}""")

    @Test fun anOlderWelcomeWithoutBuildFieldsIsUnknownNotGuessed() {
        val seen = ConnectionDiagnostics.seen(welcome(""), 5)
        assertEquals("unknown", seen.version); assertNull(seen.commit); assertEquals("1.1", ConnectionDiagnostics.protocolText(seen))
        assertEquals("unknown · commit unknown", ConnectionDiagnostics.buildText(seen)); assertEquals("unknown", ConnectionDiagnostics.buildText(null))
    }

    @Test fun aReconnectToAnotherBuildReplacesTheOneShown() {
        val first = ConnectionDiagnostics.seen(welcome(""","build":{"version":"0.1.1","commit":"2775325cef9fbd3818a29e5d22bf6364a0dc93ca","dirty":false},"brokerBuild":"0.1.1+2775325""""), 5)
        assertEquals("0.1.1 · 2775325cef9f", ConnectionDiagnostics.buildText(first))
        val second = ConnectionDiagnostics.seen(welcome(""","build":{"version":"0.1.2","commit":"abcdef0123456789","dirty":true}"""), 9)
        assertEquals("0.1.2 · abcdef012345 (with local changes)", ConnectionDiagnostics.buildText(second)); assertEquals(9, second.seenAt)
    }

    @Test fun theSummaryNamesVersionsAndStateButNoIdsAddressesOrContent() {
        val providers = Json.parseToJsonElement("""{"ollama":{"available":true,"remoteExecution":true},"openai":{"available":true,"remoteExecution":false},"claude":{"available":false}}""").jsonObject
        val state = MobileState(connection = ConnectionState.Offline("Failed to connect to /100.64.0.10:8443", 1, OfflineKind.Unreachable), providers = providers,
            desktopBuild = DesktopBuildSeen("0.1.1", "2775325cef9fbd38", false, null, 1, 1, 1_700_000_000_000))
        val summary = ConnectionDiagnostics.summary(AppIdentity("0.1.4", 1004, "dev.otectus.cere.mobile.debug", "15", 35), state, 1_700_000_000_000)
        assertTrue(summary.contains("Cere Mobile 0.1.4 (1004) · development channel")); assertTrue(summary.contains("offline · desktop unreachable"))
        assertTrue(summary.contains("0.1.1 · 2775325cef9f · last seen")); assertTrue(summary.contains("ollama usable here")); assertTrue(summary.contains("openai desktop only")); assertTrue(summary.contains("claude unavailable"))
        assertFalse("no address from the failure text", summary.contains("100.64.0.10"))
        assertFalse(summary.contains("dev.otectus.cere.mobile.debug"))
    }
}
