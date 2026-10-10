package dev.otectus.cere.mobile.data

import java.io.IOException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import org.junit.Assert.*
import org.junit.Test

class ConnectionPolicyTest {
    @Test fun onlyCertificateAndPinFailuresEndReconnection() {
        assertTrue(ConnectionPolicy.isTerminalFailure(SSLPeerUnverifiedException("Certificate pinning failure")))
        assertTrue(ConnectionPolicy.isTerminalFailure(SSLHandshakeException("handshake").apply { initCause(CertificateException("untrusted")) }))
        // A broker restart behind adb reverse or a dropped VPN path ends the handshake early; that is retried.
        assertFalse(ConnectionPolicy.isTerminalFailure(SSLHandshakeException("connection closed")))
        assertFalse(ConnectionPolicy.isTerminalFailure(IOException("Connection reset")))
    }

    @Test fun closeReasonsMapToRevocationRefusalOrRetry() {
        assertEquals(CloseAction.Revoked, ConnectionPolicy.closeAction("AUTH_REVOKED"))
        assertEquals(CloseAction.Revoked, ConnectionPolicy.closeAction("DEVICE_REVOKED"))
        assertEquals(CloseAction.Terminal, ConnectionPolicy.closeAction("INCOMPATIBLE"))
        assertEquals(CloseAction.AuthRejected, ConnectionPolicy.closeAction("UNAUTHENTICATED"))
        assertEquals(CloseAction.Retry, ConnectionPolicy.closeAction("AUTH_EXPIRED"))
        assertEquals(CloseAction.Retry, ConnectionPolicy.closeAction(""))
    }

    @Test fun backoffDoublesToAMinuteThenSlowsDuringALongOutage() {
        assertEquals(1_000L, ConnectionPolicy.backoffCeiling(0, null, 0))
        assertEquals(8_000L, ConnectionPolicy.backoffCeiling(3, 0, 60_000))
        assertEquals(60_000L, ConnectionPolicy.backoffCeiling(30, 0, 60_000))
        assertEquals(5 * 60_000L, ConnectionPolicy.backoffCeiling(30, 0, 10 * 60_000L))
    }

    @Test fun clockOffsetComesFromTheChallengeAndBoundsTheRefresh() {
        // The phone is two minutes ahead: the desktop issued a challenge "two minutes ago" by the phone's clock.
        val phoneNow = 1_000_000L; val desktopNow = phoneNow - 120_000L
        val offset = ConnectionPolicy.serverClockOffset(desktopNow + 30_000L, phoneNow)
        assertEquals(-120_000L, offset)
        // A 15-minute sign-in refreshes a minute early on the desktop's clock.
        assertEquals(14 * 60_000L, ConnectionPolicy.refreshDelay(desktopNow + 15 * 60_000L, offset, phoneNow))
        assertEquals(1_000L, ConnectionPolicy.refreshDelay(desktopNow, offset, phoneNow))
    }

    @Test fun onlyRefusalsThatPersistForMinutesMeanThePairingIsGone() {
        val refusals = AuthRejections(limit = 4, windowMs = 180_000)
        // A burst of refusals, such as stale half-open sockets after a network switch, keeps retrying.
        assertFalse(refusals.record(0)); assertFalse(refusals.record(10_000)); assertFalse(refusals.record(20_000))
        assertFalse(refusals.record(30_000))
        // Still refused three minutes later: the desktop no longer accepts this phone.
        assertTrue(refusals.record(200_000))
        // A successful sign-in resets the count.
        refusals.reset()
        assertFalse(refusals.record(300_000))
        // Few refusals over a long time are not enough.
        val sparse = AuthRejections(limit = 4, windowMs = 180_000)
        assertFalse(sparse.record(0)); assertFalse(sparse.record(400_000))
    }
}
