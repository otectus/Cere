package dev.otectus.cere.mobile.data

import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The serialization and authorization boundary for state derived from desktop responses.
 *
 * Destructive/local authority transitions invalidate the generation before waiting for [mutex].
 * Therefore a completed remote response already queued for the mutex cannot win the queue and
 * publish stale state: when it acquires the lock, [commit] rejects it before [block] can mutate or
 * persist anything.
 */
internal class RepositoryCommitGate(private val mutex: Mutex) {
    // Authority changes (disconnect, revocation, pairing and erasure) make every remote response
    // unusable. A routine sync snapshot is different: it orders state writes, but must not turn a
    // completed catalog read for the same authenticated desktop into a false stale result.
    private val authorityCounter = AtomicLong()
    private val snapshotCounter = AtomicLong()
    val generation: Long get() = authorityCounter.get()
    val snapshotGeneration: Long get() = snapshotCounter.get()

    fun capture(desktopId: String?, connection: Long, cacheEpoch: String?) =
        ReadFence(desktopId, connection, cacheEpoch, authorityCounter.get(), snapshotCounter.get())

    /** Ends every outstanding remote commit, before the transition waits for the state lock. */
    fun invalidate(): Long {
        snapshotCounter.incrementAndGet()
        return authorityCounter.incrementAndGet()
    }

    fun authorityCurrent(origin: ReadFence): Boolean = origin.authorityGeneration == authorityCounter.get()

    /**
     * Starts a newer authoritative snapshot only if [origin] is still current. This advances the
     * state-write order, not the authority order used by display-only reads.
     */
    fun advance(origin: ReadFence): ReadFence? {
        if (!authorityCurrent(origin)) return null
        val next = origin.snapshotGeneration + 1
        return if (snapshotCounter.compareAndSet(origin.snapshotGeneration, next) && authorityCurrent(origin))
            origin.copy(snapshotGeneration = next)
        else null
    }

    suspend fun <T> commit(origin: ReadFence, authorized: () -> Boolean, block: suspend () -> T): T? = mutex.withLock {
        if (!authorityCurrent(origin) || origin.snapshotGeneration != snapshotCounter.get() || !authorized()) return@withLock null
        block()
    }

    suspend fun <T> serialized(block: suspend () -> T): T = mutex.withLock { block() }
}
