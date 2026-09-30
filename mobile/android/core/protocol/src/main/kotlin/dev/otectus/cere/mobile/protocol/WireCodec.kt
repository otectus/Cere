package dev.otectus.cere.mobile.protocol

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object WireCodec {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        isLenient = false
    }

    inline fun <reified T> encode(value: T): String = json.encodeToString(value)

    fun decodeFrame(text: String): Frame {
        require(text.toByteArray(Charsets.UTF_8).size <= 1_048_576) { "Frame exceeds authenticated limit" }
        val objectValue = json.parseToJsonElement(text).jsonObject
        require(objectValue["v"]?.jsonPrimitive?.content == "1") { "Unsupported protocol version" }
        return when (objectValue["type"]?.jsonPrimitive?.content) {
            "auth.challenge" -> Frame.Challenge(json.decodeFromJsonElement(AuthChallenge.serializer(), objectValue))
            "welcome" -> Frame.Accepted(json.decodeFromJsonElement(Welcome.serializer(), objectValue))
            "response" -> Frame.Reply(json.decodeFromJsonElement(Response.serializer(), objectValue))
            "event" -> Frame.Push(json.decodeFromJsonElement(Event.serializer(), objectValue))
            else -> error("Unknown frame type")
        }
    }
}
