package dev.otectus.cere.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Network-return pairing frames, as the gateway sends them (tests/mobile-compatibility.test.ts). */
class PairingReturnTest {
    @Test fun theDesktopsRepliesAreUnderstoodAndUnknownOnesIgnored() {
        assertEquals(PairingReply.Received, PairingReturnFrames.parse("""{"v":1,"type":"pair.received","pairingId":"p","expiresAt":1}"""))
        assertEquals(PairingReply.Confirmed, PairingReturnFrames.parse("""{"v":1,"type":"pair.confirmed"}"""))
        val contested = PairingReturnFrames.parse("""{"v":1,"type":"pair.closed","reason":"contested"}""") as PairingReply.Closed
        assertEquals("contested", contested.reason); assertTrue(contested.message.contains("Another phone"))
        val refused = PairingReturnFrames.parse("""{"v":1,"type":"pair.closed","reason":"refused","message":"This offer takes its answer on the desktop."}""") as PairingReply.Closed
        assertEquals("This offer takes its answer on the desktop.", refused.message)
        assertNull(PairingReturnFrames.parse("""{"v":1,"type":"welcome"}""")); assertNull(PairingReturnFrames.parse("""{"v":2,"type":"pair.confirmed"}""")); assertNull(PairingReturnFrames.parse("not json"))
    }

    @Test fun theAnswerFrameCarriesOnlyThePublicResponse() {
        val frame = PairingReturnFrames.request("cere-pair://v1/abc")
        assertEquals("""{"v":1,"type":"pair.response","response":"cere-pair://v1/abc"}""", frame)
    }
}
