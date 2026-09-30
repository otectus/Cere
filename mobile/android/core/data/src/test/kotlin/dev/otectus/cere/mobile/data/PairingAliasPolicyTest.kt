package dev.otectus.cere.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingAliasPolicyTest {
    private val committedConnection = "cere.connection.desktop.device"
    private val committedAction = "cere.action.desktop.device"
    private val staleConnection = "cere.connection.old.device"

    @Test fun coldStartCannotPruneKeysBeforePrivateCacheRestoreCompletes() {
        val aliases = setOf(committedConnection, committedAction, staleConnection)

        assertTrue(PairingAliasPolicy.aliasesToPrune(aliases, restoreReady = false, kept = emptySet()).isEmpty())
    }

    @Test fun completedRestoreKeepsCommittedPairAndPrunesOnlyOrphans() {
        val aliases = setOf(committedConnection, committedAction, staleConnection, "unrelated.app.key")

        assertEquals(
            setOf(staleConnection),
            PairingAliasPolicy.aliasesToPrune(aliases, restoreReady = true, kept = setOf(committedConnection, committedAction)),
        )
    }
}
