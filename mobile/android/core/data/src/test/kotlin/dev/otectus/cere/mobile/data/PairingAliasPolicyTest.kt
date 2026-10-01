package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.ActionAuthentication
import dev.otectus.cere.mobile.protocol.CanonicalJson
import dev.otectus.cere.mobile.protocol.ProtocolVersion
import dev.otectus.cere.mobile.protocol.Welcome
import dev.otectus.cere.mobile.protocol.WireCodec
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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

    private fun desktop(mode: ActionAuthentication) = PairedDesktop(
        desktopId = "desktop", desktopName = "Desktop", deviceId = "device", deviceName = "Phone",
        certificate = "certificate", spki = "spki", endpoints = listOf("wss://desktop/mobile/v1"),
        connectionAlias = committedConnection, actionAlias = committedAction, pairedAt = 1,
        actionAuthentication = mode,
    )

    private fun welcome(mode: ActionAuthentication = ActionAuthentication.BIOMETRIC) = Welcome(
        v = 1, type = "welcome", authSessionId = "auth", expiresAt = 2, epoch = "1",
        desktopId = "desktop", scopeVersion = "1", protocol = ProtocolVersion(1, 0),
        operations = emptySet(), actionAuthentication = mode,
    )

    @Test fun trustedPairingSignsReviewedActionsWithoutPromptOnlyWhenWelcomeMatches() {
        val trusted = desktop(ActionAuthentication.TRUSTED_DEVICE)
        assertFalse(ActionAuthenticationPolicy.pairingRequiresPrompt(trusted.actionAuthentication))
        assertFalse(ActionAuthenticationPolicy.actionRequiresPrompt(trusted, welcome(ActionAuthentication.TRUSTED_DEVICE), connectionSigned = false))
        assertFalse(ActionAuthenticationPolicy.modesMatch(trusted, welcome()))
        assertTrue(runCatching { ActionAuthenticationPolicy.actionRequiresPrompt(trusted, welcome(), connectionSigned = false) }.isFailure)
    }

    @Test fun legacyPairingAndWelcomeRemainBiometric() {
        val legacyJson = """{"type":"offer","v":1,"desktopId":"desktop","name":"Desktop","certificate":"c","spki":"s","identityKey":"i","endpoints":["wss://desktop/mobile/v1"],"pairingId":"pair","nonce":"nonce","expiresAt":2,"signature":"sig"}"""
        val raw = WireCodec.json.parseToJsonElement(legacyJson) as JsonObject
        val offer = WireCodec.json.decodeFromString(PairingOffer.serializer(), legacyJson)
        assertEquals(ActionAuthentication.BIOMETRIC, offer.actionAuthentication)
        assertTrue(ActionAuthenticationPolicy.pairingRequiresPrompt(offer.actionAuthentication))
        assertTrue(ActionAuthenticationPolicy.actionRequiresPrompt(desktop(ActionAuthentication.BIOMETRIC), welcome(), connectionSigned = false))
        assertNotEquals(CanonicalJson.sha256(raw), CanonicalJson.sha256(WireCodec.json.encodeToJsonElement(PairingOffer.serializer(), offer)))
    }
}
