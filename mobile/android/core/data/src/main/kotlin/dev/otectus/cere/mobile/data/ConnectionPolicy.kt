package dev.otectus.cere.mobile.data

import java.security.cert.CertificateException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlin.math.min

/** Why the phone is not connected; the UI words each case differently. */
enum class OfflineKind { NotConnected, Unreachable, MonitoringOff, PairingChange }

/** How a closed socket should be handled. */
internal enum class CloseAction { Revoked, Terminal, AuthRejected, Retry }

/**
 * Decides which connection failures stop reconnecting. Only failures that a retry
 * cannot fix are terminal: a desktop certificate or key that no longer matches the
 * pairing, an incompatible protocol, and revocation. Network drops, handshakes the
 * peer closed, and a few generic sign-in refusals in a row are retried with backoff.
 */
internal object ConnectionPolicy {
    const val BASE_DELAY_MS = 1_000L
    const val MAX_DELAY_MS = 60_000L
    const val LONG_OUTAGE_MS = 10 * 60_000L
    const val LONG_OUTAGE_DELAY_MS = 5 * 60_000L
    const val AUTH_REJECTION_LIMIT = 4
    const val AUTH_REJECTION_WINDOW_MS = 3 * 60_000L

    /** A certificate or pin mismatch means the pairing itself no longer matches the desktop. */
    fun isTerminalFailure(error: Throwable): Boolean = generateSequence(error) { it.cause }.take(8).any {
        it is SSLPeerUnverifiedException || it is CertificateException || it is java.security.cert.CertPathValidatorException
    }

    fun closeAction(reason: String): CloseAction = when {
        reason.contains("AUTH_REVOKED") || reason.contains("DEVICE_REVOKED") -> CloseAction.Revoked
        reason.contains("INCOMPATIBLE") -> CloseAction.Terminal
        reason.contains("UNAUTHENTICATED") -> CloseAction.AuthRejected
        else -> CloseAction.Retry
    }

    /**
     * Full-jitter backoff ceiling: 1 s doubling to 60 s, then one attempt every five
     * minutes once the desktop has been unreachable for ten minutes.
     */
    fun backoffCeiling(attempt: Int, unreachableSince: Long?, now: Long): Long =
        if (unreachableSince != null && now - unreachableSince >= LONG_OUTAGE_MS) LONG_OUTAGE_DELAY_MS
        else min(MAX_DELAY_MS, BASE_DELAY_MS * (1L shl min(attempt, 6)))

    /**
     * The desktop sets each challenge to expire 30 s after issuing it, so its expiry also
     * tells the phone how far its clock is from the desktop's. Expiry itself is enforced
     * by the desktop; the phone only uses the offset for its own timers.
     */
    fun serverClockOffset(challengeExpiresAt: Long, receivedAt: Long): Long = (challengeExpiresAt - 30_000L) - receivedAt

    /** Reconnect a minute before the desktop ends the session, measured on the desktop's clock. */
    fun refreshDelay(welcomeExpiresAt: Long, serverOffset: Long, now: Long): Long =
        (welcomeExpiresAt - serverOffset - now - 60_000L).coerceIn(1_000L, 14 * 60_000L)
}

/**
 * The desktop answers a revoked phone and a phone with too many half-open sockets the
 * same way. A few refusals in a row over several minutes means the pairing is gone;
 * fewer is treated as a transient desktop condition and retried.
 */
internal class AuthRejections(private val limit: Int = ConnectionPolicy.AUTH_REJECTION_LIMIT, private val windowMs: Long = ConnectionPolicy.AUTH_REJECTION_WINDOW_MS) {
    private var first: Long? = null
    private var count = 0

    @Synchronized fun record(now: Long): Boolean {
        if (first == null) first = now
        count++
        return count >= limit && now - first!! >= windowMs
    }

    @Synchronized fun reset() { first = null; count = 0 }
}
