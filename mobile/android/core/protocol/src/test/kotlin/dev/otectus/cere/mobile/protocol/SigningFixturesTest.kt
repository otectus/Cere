package dev.otectus.cere.mobile.protocol

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The public vectors in protocol/mobile/v1/signing-fixtures.json, also checked by the broker's tests. */
class SigningFixturesTest {
    @Test fun canonicalJsonDigestsAndSignaturesMatchTheBroker() {
        val fixtures = WireCodec.json.parseToJsonElement(SharedFixtures.text("protocol/mobile/v1/signing-fixtures.json")).jsonObject
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(CanonicalJson.decodeBase64Url(fixtures.getValue("publicKey").jsonPrimitive.content)))
        val cases = fixtures.getValue("cases").jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val value = case.jsonObject
            val name = value.getValue("name").jsonPrimitive.content
            val signed = value.getValue("value")
            assertEquals(name, value.getValue("canonical").jsonPrimitive.content, CanonicalJson.encode(signed))
            assertEquals(name, value.getValue("sha256").jsonPrimitive.content, CanonicalJson.sha256(signed))
            fun verifies(payload: kotlinx.serialization.json.JsonElement) = Signature.getInstance("SHA256withECDSA").run {
                initVerify(key); update(CanonicalJson.encode(payload).toByteArray()); verify(CanonicalJson.decodeBase64Url(value.getValue("signature").jsonPrimitive.content))
            }
            assertTrue(name, verifies(signed))
            // Any change to the signed value invalidates the signature, as the broker checks too.
            assertFalse(name, verifies(buildJsonObject { (signed as JsonObject).forEach { (k, v) -> put(k, v) }; put("changed", true) }))
        }
    }
}
