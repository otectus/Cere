package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.WireCodec
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderTraitsTest {
    @Test fun controlsComeFromTheDesktopsDescriptionWithTheOldAssumptionsAsFallback() {
        val providers = WireCodec.json.parseToJsonElement("""{"openai":{"remoteExecution":true,"traits":{"label":"OpenAI API","kind":"api","modelRequired":true,"tools":"cere","webSearch":true,"billed":true,"remoteNote":"May be billed","future":1}},"codex":{"remoteExecution":true}}""").jsonObject
        val state = MobileState(providers = providers)
        val api = state.traits("openai")
        assertEquals("OpenAI API", api.label); assertTrue(api.cereTools); assertTrue(api.billed); assertTrue(api.webSearch)
        // An older desktop sends no description: the phone keeps what it assumed before.
        val codex = state.traits("codex")
        assertFalse(codex.cereTools); assertTrue(codex.effort)
        assertTrue(state.traits("ollama").queue)
        assertEquals("Unknown", state.traits("unknown").label)
    }
}
