package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.ModelOption
import dev.otectus.cere.mobile.protocol.Session
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Whether Cere's desktop tools can be on for a route and model; [applies] is false for providers with their own tools. */
data class ToolAvailability(val available: Boolean, val reason: String? = null, val applies: Boolean = true)

/**
 * MOB-003: one rule for creating and editing. Ollama needs a model that advertises tools; a hosted
 * API or compatible endpoint follows what the desktop says about its route. An older desktop that
 * says nothing leaves the decision to it: the switch is offered and the desktop refuses with its reason.
 */
object ToolPolicy {
    fun availability(traits: ProviderTraits, model: ModelOption?, session: Session? = null, sessionReports: Boolean = false): ToolAvailability {
        if (!traits.cereTools) return ToolAvailability(false, applies = false)
        if (traits.kind == "local" || traits.toolCalling == "per-model")
            return if (model?.capabilities?.contains("tools") == true) ToolAvailability(true) else ToolAvailability(false, "This model does not advertise tools.")
        if (session != null && sessionReports && session.toolsAvailable != null)
            return if (session.toolsAvailable == true) ToolAvailability(true) else ToolAvailability(false, session.toolsUnavailableReason ?: NOT_DECLARED)
        return if (traits.toolCalling == "no") ToolAvailability(false, NOT_DECLARED) else ToolAvailability(true)
    }
    const val NOT_DECLARED = "This endpoint is not declared to support tools. Turn on tool calling for it on the desktop if it does."
}

/** MOB-004: the desktop's rule for a typed API model ID. The desktop stays authoritative. */
object ModelIds {
    const val MAX_LENGTH = 512
    fun error(raw: String): String? {
        val value = raw.trim()
        return when {
            value.isEmpty() -> "Enter the model ID."
            value.length > MAX_LENGTH -> "A model ID has at most $MAX_LENGTH characters."
            value.any { it.code < 0x20 || it.code == 0x7f } -> "A model ID cannot contain control characters."
            else -> null
        }
    }
}

/**
 * A conversation-settings edit. With a desktop that keeps omitted options (sessions.toolsState),
 * only what changed is sent, so a model change alone never turns tools off. An older desktop needs
 * every option, so the values sent are the session's own.
 */
data class ConfigurationDraft(val model: String, val effort: String, val tools: Boolean) {
    fun changes(session: Session) = model.trim() != session.model.orEmpty() || effort != session.effort.orEmpty() || tools != session.tools

    fun params(session: Session, baselineRevision: String, partial: Boolean, routeRevision: Boolean): JsonObject = buildJsonObject {
        put("sessionId", session.id); put("model", model.trim())
        if (!partial || effort != session.effort.orEmpty()) put("effort", effort)
        if (!partial || tools != session.tools) put("tools", tools)
        put("expectedConfigRevision", baselineRevision)
        if (routeRevision) session.routeRevision?.let { put("expectedRouteRevision", it) }
    }

    companion object {
        fun of(session: Session) = ConfigurationDraft(session.model.orEmpty(), session.effort.orEmpty(), session.tools)

        /**
         * An older desktop reports a hosted API conversation's tools as off whatever they are, so the
         * phone cannot send the real value; it changes nothing rather than turning them off.
         */
        fun blockedReason(traits: ProviderTraits, toolsState: Boolean): String? =
            if (traits.kind == "api" && !toolsState) "Update Cere on the desktop to change this conversation's model from the phone without turning off its tools." else null
    }
}

/** A provider's catalog as the phone shows it: its models, and whether it lists any at all. */
data class ModelCatalog(val models: List<ModelOption>, val unlisted: Boolean = false)
