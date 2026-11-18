package dev.otectus.cere.mobile.data

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RepositoryCommitGateTest {
    private enum class Transition { REVOKE, FORGET, PAIRING, NEW_SCOPE, NEW_EPOCH }

    @Test fun completedResponseQueuedForStateMutexCannotWriteAfterAuthorityTransition() = runBlocking {
        for (transition in Transition.entries) {
            val mutex = Mutex()
            val gate = RepositoryCommitGate(mutex)
            var connection = 7L
            var state = MobileState(cacheEpoch = "epoch-1")
            var authorized = true
            val origin = gate.capture(state.desktop?.desktopId, connection, state.cacheEpoch)
            val releaseMutex = kotlinx.coroutines.CompletableDeferred<Unit>()
            val holder = launch(start = CoroutineStart.UNDISPATCHED) {
                gate.serialized { releaseMutex.await() }
            }
            val stateWrites = AtomicInteger()
            val cacheWrites = AtomicInteger()

            // UNDISTPATCHED runs through the completed response continuation until withLock suspends.
            // This remote commit is now ahead of the transition in the mutex wait queue.
            val staleCommit = async(start = CoroutineStart.UNDISPATCHED) {
                gate.commit(origin, {
                    authorized && origin.holds(state, connection)
                }) {
                    stateWrites.incrementAndGet()
                    state = state.copy(sessionsNotLoaded = 99)
                    cacheWrites.incrementAndGet()
                    true
                }
            }

            when (transition) {
                Transition.REVOKE, Transition.FORGET, Transition.PAIRING -> gate.invalidate()
                Transition.NEW_SCOPE, Transition.NEW_EPOCH -> check(gate.advance(origin) != null)
            }
            val authorityTransition = async(start = CoroutineStart.UNDISPATCHED) {
                gate.serialized {
                    when (transition) {
                        Transition.REVOKE, Transition.FORGET, Transition.PAIRING -> {
                            authorized = false
                            connection = HeldUpserts.NONE
                            state = MobileState(restoreReady = true)
                        }
                        Transition.NEW_SCOPE -> authorized = false
                        Transition.NEW_EPOCH -> state = state.copy(cacheEpoch = "epoch-2")
                    }
                }
            }

            releaseMutex.complete(Unit)
            assertNull("$transition must reject the old response", staleCommit.await())
            authorityTransition.await()
            holder.join()
            assertEquals("$transition made a stale state write", 0, stateWrites.get())
            assertEquals("$transition rewrote stale data to the cache", 0, cacheWrites.get())
            assertEquals("$transition must not publish old hydration counters", 0, state.sessionsNotLoaded)
        }
    }

    @Test fun currentAuthorizedResponseCommitsStateAndCacheExactlyOnce() = runBlocking {
        val gate = RepositoryCommitGate(Mutex())
        val state = MobileState(cacheEpoch = "epoch")
        val origin = gate.capture(null, 3, state.cacheEpoch)
        val stateWrites = AtomicInteger()
        val cacheWrites = AtomicInteger()
        val result = gate.commit(origin, { origin.holds(state, 3) }) {
            stateWrites.incrementAndGet()
            cacheWrites.incrementAndGet()
            "saved"
        }
        assertEquals("saved", result)
        assertEquals(1, stateWrites.get())
        assertEquals(1, cacheWrites.get())
    }

    @Test fun routineSnapshotDoesNotInvalidateSameAuthorityReadButStillOrdersStateCommits() = runBlocking {
        val gate = RepositoryCommitGate(Mutex())
        val state = MobileState(cacheEpoch = "epoch")
        val catalogRead = gate.capture(null, 3, state.cacheEpoch)

        // sync.open publishing its ordinary snapshot is not a revocation, socket replacement,
        // scope change or erasure. CereRepository.read may therefore return a catalog result.
        val snapshot = gate.advance(catalogRead)
        assertTrue("snapshot must publish", snapshot != null)
        assertTrue("same desktop read remains authorized", gate.authorityCurrent(catalogRead))
        assertTrue(catalogRead.holds(state, 3))

        // The identical fence cannot write state after that snapshot: hydration and summaries
        // retain their stricter serialization fence.
        var committed = false
        assertNull(gate.commit(catalogRead, { gate.authorityCurrent(catalogRead) }) { committed = true })
        assertFalse(committed)

        gate.invalidate()
        assertFalse("a real authority transition still invalidates the catalog", gate.authorityCurrent(catalogRead))
    }

    @Test fun catalogReadMustRecheckItsRequestedSessionAgainstTheNewSnapshotScope() {
        val authorizedBefore = setOf("kept", "removed")
        val authorizedAfter = setOf("kept")
        fun stillAuthorized(requested: String?, scope: Set<String>, visible: Set<String>) =
            requested == null || (requested in scope && requested in visible)

        assertTrue(stillAuthorized("removed", authorizedBefore, authorizedBefore))
        // Same socket and cache epoch are insufficient after sync.open removes this session.
        assertFalse(stillAuthorized("removed", authorizedAfter, authorizedAfter))
        assertTrue(stillAuthorized("kept", authorizedAfter, authorizedAfter))
        assertTrue(stillAuthorized(null, authorizedAfter, authorizedAfter))
    }
}
