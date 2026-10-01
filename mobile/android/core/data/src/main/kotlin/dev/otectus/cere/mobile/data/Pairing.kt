package dev.otectus.cere.mobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.otectus.cere.mobile.protocol.CanonicalJson
import dev.otectus.cere.mobile.protocol.ActionAuthentication
import dev.otectus.cere.mobile.protocol.WireCodec
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.spec.X509EncodedKeySpec
import java.io.ByteArrayInputStream
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
data class PairingOffer(
    val type: String,
    val v: Int,
    val desktopId: String,
    val name: String,
    val certificate: String,
    val spki: String,
    val identityKey: String,
    val endpoints: List<String>,
    val pairingId: String,
    val nonce: String,
    val expiresAt: Long,
    val signature: String,
    val actionAuthentication: ActionAuthentication = ActionAuthentication.BIOMETRIC,
    val replacesDeviceId: String? = null,
)

data class VerifiedPairingOffer(
    val offer: PairingOffer,
    /** The exact parsed offer, including omitted/default fields, used by the desktop signature. */
    val signedElement: JsonObject,
)

@Serializable
data class PairingResponseBody(
    val type: String = "response",
    val v: Int = 1,
    val desktopId: String,
    val pairingId: String,
    val offerDigest: String,
    val nonce: String,
    val deviceId: String,
    val name: String,
    val keyVersion: Int = 1,
    val connectionKey: String,
    val actionKey: String,
    val deviceNonce: String,
)

@Serializable
data class PairingResponse(
    val type: String = "response",
    val v: Int = 1,
    val desktopId: String,
    val pairingId: String,
    val offerDigest: String,
    val nonce: String,
    val deviceId: String,
    val name: String,
    val keyVersion: Int = 1,
    val connectionKey: String,
    val actionKey: String,
    val deviceNonce: String,
    val connectionProof: String,
    val actionProof: String,
)

@Serializable
data class PairedDesktop(
    val desktopId: String,
    val desktopName: String,
    val deviceId: String,
    val deviceName: String,
    val certificate: String,
    val spki: String,
    val endpoints: List<String>,
    val connectionAlias: String,
    val actionAlias: String,
    val pairedAt: Long,
    val actionAuthentication: ActionAuthentication = ActionAuthentication.BIOMETRIC,
    val identityKey: String = "",
)

data class PendingPairing(
    val offer: PairingOffer,
    val body: PairingResponseBody,
    val connectionProof: String,
    val actionSignature: Signature,
    val transcript: ByteArray,
    val connectionAlias: String,
    val actionAlias: String,
    val actionAuthentication: ActionAuthentication,
)

@Serializable data class CompletedPairing(
    val desktop: PairedDesktop,
    val responseUri: String,
    val sas: String,
    val replacesDeviceId: String? = null,
)

class PairingManager(private val context: Context) {
    private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun parseAndVerify(uri: String): VerifiedPairingOffer {
        require(uri.toByteArray().size <= 2_000) { "Pairing offer is too large" }
        val prefix = "cere-pair://v1/"
        require(uri.startsWith(prefix)) { "Not a Cere pairing offer" }
        val json = CanonicalJson.decodeBase64Url(uri.removePrefix(prefix)).decodeToString()
        val offer = WireCodec.json.decodeFromString(PairingOffer.serializer(), json)
        require(offer.type == "offer" && offer.v == 1)
        require(offer.name.toByteArray().size <= 48 && offer.endpoints.size in 1..3)
        require(offer.expiresAt > Instant.now().toEpochMilli()) { "Pairing offer expired" }
        offer.endpoints.forEach {
            val parsed = java.net.URI(it)
            require(parsed.scheme == "wss" && parsed.path == "/mobile/v1" && it.toByteArray().size <= 96)
        }
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(CanonicalJson.decodeBase64Url(offer.certificate)))
        require(CanonicalJson.base64Url(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)) == offer.spki) { "Certificate identity mismatch" }
        val objectValue = WireCodec.json.parseToJsonElement(json).jsonObject
        val unsigned = JsonObject(objectValue - "signature")
        val transcript = buildJsonObject { put("domain", "cere.mobile.pair.offer.v1"); put("offer", unsigned) }
        val identity = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(CanonicalJson.decodeBase64Url(offer.identityKey)))
        require(Signature.getInstance("SHA256withECDSA").run {
            initVerify(identity); update(CanonicalJson.encode(transcript).toByteArray()); verify(CanonicalJson.decodeBase64Url(offer.signature))
        }) { "Pairing offer signature is invalid" }
        return VerifiedPairingOffer(offer, objectValue)
    }

    fun prepare(verified: VerifiedPairingOffer, deviceName: String, replacing: PairedDesktop? = null): PendingPairing {
        val offer = verified.offer
        require(deviceName.isNotBlank() && deviceName.toByteArray().size <= 48)
        if (replacing == null) {
            require(offer.replacesDeviceId == null) { "This offer replaces an existing phone pairing" }
        } else {
            require(offer.desktopId == replacing.desktopId && offer.replacesDeviceId == replacing.deviceId) {
                "Replacement offer does not identify this paired phone"
            }
            require(offer.spki == replacing.spki) { "Replacement certificate must retain the pinned desktop key" }
            require(replacing.identityKey.isBlank() || offer.identityKey == replacing.identityKey) {
                "Replacement offer changed the desktop identity key"
            }
        }
        val deviceId = UUID.randomUUID().toString()
        val suffix = offer.desktopId.take(12) + "." + deviceId.take(12)
        val connectionAlias = "cere.connection.$suffix"
        val actionAlias = "cere.action.$suffix"
        try {
            generateKey(connectionAlias, requiresAuthentication = false)
            generateKey(actionAlias, requiresAuthentication = offer.actionAuthentication == ActionAuthentication.BIOMETRIC)
        } catch (error: Throwable) {
            keys.deleteEntry(connectionAlias)
            keys.deleteEntry(actionAlias)
            throw error
        }
        val signedOffer = verified.signedElement
        val body = PairingResponseBody(
            desktopId = offer.desktopId,
            pairingId = offer.pairingId,
            offerDigest = CanonicalJson.sha256(signedOffer),
            nonce = offer.nonce,
            deviceId = deviceId,
            name = deviceName,
            connectionKey = CanonicalJson.base64Url(keys.getCertificate(connectionAlias).publicKey.encoded),
            actionKey = CanonicalJson.base64Url(keys.getCertificate(actionAlias).publicKey.encoded),
            deviceNonce = CanonicalJson.base64Url(ByteArray(32).also(java.security.SecureRandom()::nextBytes)),
        )
        val responseElement = WireCodec.json.encodeToJsonElement(PairingResponseBody.serializer(), body)
        val transcript = CanonicalJson.encode(buildJsonObject { put("domain", "cere.mobile.pair.response.v1"); put("response", responseElement) }).toByteArray()
        return PendingPairing(
            offer, body, sign(connectionAlias, transcript),
            Signature.getInstance("SHA256withECDSA").apply { initSign(keys.getKey(actionAlias, null) as java.security.PrivateKey) },
            transcript, connectionAlias, actionAlias, offer.actionAuthentication,
        )
    }

    fun completeWithoutAuthentication(pending: PendingPairing): CompletedPairing {
        require(pending.actionAuthentication == ActionAuthentication.TRUSTED_DEVICE) {
            "Phone authentication is required for this pairing"
        }
        return complete(pending, pending.actionSignature.run { update(pending.transcript); sign() })
    }

    fun complete(pending: PendingPairing, authenticatedSignature: ByteArray): CompletedPairing {
        val response = PairingResponse(
            desktopId = pending.body.desktopId, pairingId = pending.body.pairingId,
            offerDigest = pending.body.offerDigest, nonce = pending.body.nonce,
            deviceId = pending.body.deviceId, name = pending.body.name,
            connectionKey = pending.body.connectionKey, actionKey = pending.body.actionKey,
            deviceNonce = pending.body.deviceNonce, connectionProof = pending.connectionProof,
            actionProof = CanonicalJson.base64Url(authenticatedSignature),
        )
        val element = WireCodec.json.encodeToJsonElement(PairingResponse.serializer(), response)
        val responseUri = "cere-pair://v1/${CanonicalJson.base64Url(CanonicalJson.encode(element).toByteArray())}"
        require(responseUri.toByteArray().size <= 2_000) { "Pairing response is too large" }
        val responseDigest = CanonicalJson.sha256(element)
        val sasBytes = MessageDigest.getInstance("SHA-256").digest("${pending.body.offerDigest}.$responseDigest".toByteArray())
        val sas = sasBytes.take(6).joinToString(" ") { SAS_WORDS[it.toInt() and 0xff] }
        return CompletedPairing(
            PairedDesktop(pending.offer.desktopId, pending.offer.name, pending.body.deviceId, pending.body.name, pending.offer.certificate, pending.offer.spki, pending.offer.endpoints, pending.connectionAlias, pending.actionAlias, System.currentTimeMillis(), pending.actionAuthentication, pending.offer.identityKey),
            responseUri, sas, pending.offer.replacesDeviceId,
        )
    }

    fun signConnection(alias: String, bytes: ByteArray) = sign(alias, bytes)
    fun connectionSignature(alias: String): Signature = signingSignature(alias)
    fun actionSignature(alias: String): Signature = signingSignature(alias)
    private fun signingSignature(alias: String): Signature = Signature.getInstance("SHA256withECDSA").apply { initSign(keys.getKey(alias, null) as java.security.PrivateKey) }

    fun hasSigningKeys(desktop: PairedDesktop): Boolean = runCatching {
        keys.containsAlias(desktop.connectionAlias) && keys.containsAlias(desktop.actionAlias)
    }.getOrDefault(false)

    fun cancel(pending: PendingPairing) {
        keys.deleteEntry(pending.connectionAlias); keys.deleteEntry(pending.actionAlias)
    }

    fun pruneUncommitted(restoreReady: Boolean, vararg keep: PairedDesktop?) {
        val kept = keep.filterNotNull().flatMap { listOf(it.connectionAlias, it.actionAlias) }.toSet()
        PairingAliasPolicy.aliasesToPrune(keys.aliases().toList(), restoreReady, kept).forEach(keys::deleteEntry)
    }

    fun delete(desktop: PairedDesktop) {
        keys.deleteEntry(desktop.connectionAlias); keys.deleteEntry(desktop.actionAlias)
    }

    private fun generateKey(alias: String, requiresAuthentication: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(requiresAuthentication)
            .apply { if (requiresAuthentication) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL) }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec); generateKeyPair() }
    }

    private fun sign(alias: String, bytes: ByteArray): String = CanonicalJson.base64Url(Signature.getInstance("SHA256withECDSA").run {
        initSign(keys.getKey(alias, null) as java.security.PrivateKey); update(bytes); sign()
    })
}

internal object ActionAuthenticationPolicy {
    fun pairingRequiresPrompt(mode: ActionAuthentication) = mode == ActionAuthentication.BIOMETRIC

    fun modesMatch(desktop: PairedDesktop, welcome: dev.otectus.cere.mobile.protocol.Welcome): Boolean =
        desktop.actionAuthentication == welcome.actionAuthentication

    fun actionRequiresPrompt(desktop: PairedDesktop, welcome: dev.otectus.cere.mobile.protocol.Welcome, connectionSigned: Boolean): Boolean {
        require(modesMatch(desktop, welcome)) { "Desktop action authentication does not match this pairing" }
        return !connectionSigned && desktop.actionAuthentication == ActionAuthentication.BIOMETRIC
    }
}

internal object PairingAliasPolicy {
    fun aliasesToPrune(aliases: Collection<String>, restoreReady: Boolean, kept: Set<String>): Set<String> {
        if (!restoreReady) return emptySet()
        return aliases.filterTo(linkedSetOf()) {
            (it.startsWith("cere.connection.") || it.startsWith("cere.action.")) && it !in kept
        }
    }
}

private val SAS_WORDS = listOf("acorn","amber","anchor","angel","apple","apron","arrow","atlas","autumn","badge","bamboo","barrel","basil","beach","beacon","bear","beetle","berry","birch","bird","bison","blade","bloom","blue","boat","bolt","book","boots","branch","brass","breeze","brick","bridge","brook","broom","brush","bubble","bucket","butter","button","cabin","cactus","cake","camel","candle","canoe","canyon","carrot","castle","cedar","cello","chalk","cherry","chest","circle","clay","cliff","clock","cloud","clover","coast","cocoa","comet","coral","cotton","cove","crane","creek","crown","crystal","cube","daisy","dawn","deer","delta","desert","diamond","dice","dolphin","dove","dragon","dream","drum","dune","eagle","earth","echo","elm","ember","emerald","feather","fern","field","finch","fire","fish","flag","flame","flint","flower","flute","foam","forest","fossil","fox","frost","fruit","garden","gate","gem","ghost","ginger","glass","globe","gold","goose","grape","grass","green","grove","guitar","gull","harbor","hare","harp","hawk","hazel","heart","hedge","heron","hill","hive","holly","honey","horse","ice","igloo","ink","iris","island","ivory","ivy","jade","jar","jasmine","jay","jelly","jewel","kettle","key","kite","kiwi","lake","lamb","lamp","lark","laurel","leaf","lemon","leopard","lilac","lime","lion","lizard","lotus","lynx","maple","marble","marsh","meadow","melon","mint","mirror","mist","moon","moss","moth","mountain","mouse","mushroom","nest","nettle","night","north","nut","oak","oasis","ocean","olive","onyx","opal","orange","orbit","orchid","otter","owl","palm","panda","paper","peach","pearl","pebble","pepper","pine","pink","pipe","plum","pond","poppy","pot","prism","pumpkin","purple","quail","quartz","queen","quilt","rabbit","rain","raven","reed","reef","ribbon","ridge","river","robin","rock","rose","ruby","sail","sage","sand","scarlet","sea","seal","seed","shell","shore","silver","sky","slate","snow","soap","sparrow","spice","spider","spring","spruce","square","squirrel","star","steel","stone","stork","storm","straw")
