package dev.otectus.cere.mobile.data

import kotlinx.serialization.Serializable

/** Encrypted, device-local reading position. Message IDs keep the anchor stable as older pages arrive. */
@Serializable
data class SessionScrollPosition(
    val sessionId: String,
    val anchorMessageId: String? = null,
    val itemIndex: Int = 0,
    val offset: Int = 0,
    val following: Boolean = true,
)
