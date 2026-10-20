package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CacheIntegrityTest {
    @Test fun filesWithoutRecordsAndRecordsWithoutFilesAreFoundAfterACrash() {
        val (orphans, dangling) = CacheIntegrity.blobs(recorded = setOf("kept", "lost"), files = setOf("kept", "leftover"), filesListed = true)
        assertEquals(setOf("leftover"), orphans)
        assertEquals(setOf("lost"), dangling)
        // When the directory cannot be listed nothing is judged missing.
        assertEquals(emptySet<String>(), CacheIntegrity.blobs(setOf("kept"), emptySet(), filesListed = false).second)
    }

    @Test fun unreadableCachesAreClassifiedByWhatCanFixThem() {
        assertEquals(PrivateCacheFailure.KeyLost, PrivateCacheFailure.classify(IllegalStateException("no key"), keyPresent = false))
        assertEquals(PrivateCacheFailure.Damaged, PrivateCacheFailure.classify(javax.crypto.AEADBadTagException("tag"), keyPresent = true))
        assertEquals(PrivateCacheFailure.Damaged, PrivateCacheFailure.classify(IllegalStateException("wrap", kotlinx.serialization.SerializationException("json")), keyPresent = true))
        assertEquals(PrivateCacheFailure.Locked, PrivateCacheFailure.classify(java.io.IOException("not yet unlocked"), keyPresent = true))
        assertFalse(PrivateCacheFailure.Locked.repair); assertTrue(PrivateCacheFailure.Damaged.repair); assertTrue(PrivateCacheFailure.KeyLost.repair)
    }

    @Test fun aReadIsCurrentOnlyOnTheSameDesktopConnectionAndTranscriptEpoch() {
        val desktop = PairedDesktop(desktopId = "desktop", desktopName = "Desktop", deviceId = "device", deviceName = "Phone", certificate = "cert", spki = "spki",
            endpoints = listOf("wss://127.0.0.1:8443/mobile/v1"), connectionAlias = "connection", actionAlias = "action", pairedAt = 0)
        val state = MobileState(desktop = desktop, cacheEpoch = "e1", sessions = listOf(Session(id = "s", provider = "codex", title = "t", status = "idle")))
        val fence = ReadFence("desktop", 3, "e1")
        assertTrue(fence.holds(state, 3))
        assertFalse("reconnected (scope change, revocation, replacement)", fence.holds(state, 4))
        assertFalse("disconnected", ReadFence("desktop", HeldUpserts.NONE, "e1").holds(state, HeldUpserts.NONE))
        assertFalse("memory erased since", fence.holds(state.copy(cacheEpoch = "e2"), 3))
        assertTrue("an epoch change is ignored where the snapshot itself sets it", fence.holds(state.copy(cacheEpoch = "e2"), 3, epoch = false))
        assertFalse("forgotten or re-paired", fence.holds(state.copy(desktop = null), 3))
    }
}
