package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.WireCodec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * W08: what the desktop says a provider supports (its snapshot's providers[id].traits), so controls
 * and explanations come from the broker instead of provider names. An older desktop sends none;
 * [legacy] then reproduces what this app assumed before.
 */
@Serializable
data class ProviderTraits(
    val label: String,
    val kind: String = "cli",
    val modelRequired: Boolean = false,
    val effort: Boolean = false,
    val images: String = "no",
    val tools: String = "native",
    val webSearch: Boolean = false,
    val queue: Boolean = false,
    val configure: Boolean = false,
    val billed: Boolean = false,
    val remoteNote: String = "",
) {
    /** Cere runs this conversation and its desktop tools are an opt-in. */
    val cereTools: Boolean get() = tools == "cere"

    companion object {
        fun legacy(provider: String) = when (provider) {
            "ollama" -> ProviderTraits("Ollama", kind = "local", modelRequired = true, images = "per-model", tools = "cere", webSearch = true, queue = true, configure = true)
            "codex" -> ProviderTraits("Codex", effort = true, images = "yes", configure = true)
            "claude" -> ProviderTraits("Claude Code", effort = true, images = "yes", configure = true)
            else -> ProviderTraits(provider.replaceFirstChar(Char::uppercase))
        }
    }
}

fun MobileState.traits(provider: String): ProviderTraits =
    (providers[provider] as? JsonObject)?.get("traits")?.let { runCatching { WireCodec.json.decodeFromJsonElement(ProviderTraits.serializer(), it.jsonObject) }.getOrNull() }
        ?: ProviderTraits.legacy(provider)
