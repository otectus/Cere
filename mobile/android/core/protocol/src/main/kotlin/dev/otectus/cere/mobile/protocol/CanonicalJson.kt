package dev.otectus.cere.mobile.protocol

import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.*

/** RFC 8785-compatible for Cere transcripts, whose numeric fields are integers in the safe range. */
object CanonicalJson {
    fun encode(element: JsonElement): String = when (element) {
        is JsonObject -> element.entries.sortedBy { it.key }.joinToString(",", "{", "}") {
            "${WireCodec.json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(it.key))}:${encode(it.value)}"
        }
        is JsonArray -> element.joinToString(",", "[", "]") { encode(it) }
        JsonNull -> "null"
        is JsonPrimitive -> when {
            element.isString -> WireCodec.json.encodeToString(JsonPrimitive.serializer(), element)
            element.booleanOrNull != null -> element.content
            element.longOrNull != null -> element.long.toString()
            else -> error("Floating-point values are forbidden in signed transcripts")
        }
    }

    fun sha256(element: JsonElement): String = base64Url(MessageDigest.getInstance("SHA-256").digest(encode(element).toByteArray()))
    fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    fun decodeBase64Url(value: String): ByteArray = Base64.getUrlDecoder().decode(value)
}

object SigningTranscripts {
    fun authentication(helloDigest: String, challenge: AuthChallenge, desktopId: String, deviceId: String, keyVersion: Int): JsonObject = buildJsonObject {
        put("domain", "cere.mobile.auth.v1")
        put("helloDigest", helloDigest)
        put("challenge", buildJsonObject {
            put("challengeId", challenge.challengeId)
            put("serverNonce", challenge.serverNonce)
            put("epoch", challenge.epoch)
            put("audience", challenge.audience)
            put("expiresAt", challenge.expiresAt)
        })
        put("desktopId", desktopId)
        put("deviceId", deviceId)
        put("keyVersion", keyVersion)
        put("epoch", challenge.epoch)
    }

    fun action(desktopId: String, deviceId: String, keyVersion: Int, scopeVersion: String, epoch: String, authSessionId: String, challengeId: String, nonce: String, method: String, paramsDigest: String, commandId: String): JsonObject = buildJsonObject {
        put("domain", "cere.mobile.action.v1")
        put("desktopId", desktopId); put("deviceId", deviceId); put("keyVersion", keyVersion)
        put("scopeVersion", scopeVersion); put("epoch", epoch); put("authSessionId", authSessionId)
        put("challengeId", challengeId); put("nonce", nonce); put("method", method); put("paramsDigest", paramsDigest); put("commandId", commandId)
    }
}
