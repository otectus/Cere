package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Session
import kotlinx.serialization.json.*

fun MobileState.canSearchWeb(session: Session): Boolean =
    session.provider == "ollama" && supports("sessions.send") &&
        settings["webSearch"]?.jsonObject?.get("enabled")?.jsonPrimitive?.booleanOrNull == true &&
        permissions["caps"]?.jsonArray.orEmpty().any { it.jsonPrimitive.contentOrNull == "web" }

/** Omit settings outside the paired scope so an unrelated edit remains usable. */
fun assistantSettingsPatch(settings: JsonObject, revision: String, personality: String, defaultModel: String, searchProvider: String) = buildJsonObject {
    put("expectedRevision", revision)
    put("personality", personality)
    if (!settings["ollamaHost"]?.jsonPrimitive?.contentOrNull.isNullOrBlank()) put("defaultModel", defaultModel)
    put("searchProvider", searchProvider)
}
