package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Welcome
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * MOB-008: the desktop build this phone last signed in to, from its authenticated welcome. Kept
 * with the cache so an offline phone can say which build it last saw; parts the desktop did not
 * send stay null (unknown), never guessed.
 */
@Serializable
data class DesktopBuildSeen(
    val version: String = "unknown",
    val commit: String? = null,
    val dirty: Boolean? = null,
    val label: String? = null,
    val protocolMajor: Int? = null,
    val protocolMinor: Int? = null,
    val seenAt: Long = 0,
)

/** This app's own build, for the connection details. */
data class AppIdentity(val versionName: String, val versionCode: Long, val packageId: String, val androidRelease: String, val sdk: Int) {
    val channel: String get() = if (packageId.endsWith(".debug")) "development" else "stable"
}

object ConnectionDiagnostics {
    fun seen(welcome: Welcome, now: Long) = DesktopBuildSeen(welcome.build?.version ?: "unknown", welcome.build?.commit, welcome.build?.dirty, welcome.brokerBuild, welcome.protocol.major, welcome.protocol.minor, now)

    fun buildText(build: DesktopBuildSeen?): String = when {
        build == null -> "unknown"
        else -> buildString {
            append(build.version)
            build.commit?.takeIf(String::isNotBlank)?.let { append(" · ").append(it.take(12)) }
            when (build.dirty) { true -> append(" (with local changes)"); false -> Unit; null -> if (build.commit == null) append(" · commit unknown") }
        }
    }

    fun protocolText(build: DesktopBuildSeen?): String = if (build?.protocolMajor == null) "unknown" else "${build.protocolMajor}.${build.protocolMinor ?: 0}"

    /** The connection state in words; never the failure text, which can name addresses. */
    fun connectionText(connection: ConnectionState): String = when (connection) {
        is ConnectionState.Online -> "online"
        is ConnectionState.Offline -> when (connection.kind) { OfflineKind.Unreachable -> "offline · desktop unreachable"; OfflineKind.MonitoringOff -> "not connected · monitoring off"; OfflineKind.PairingChange -> "pairing change in progress"; OfflineKind.NotConnected -> "not connected" }
        is ConnectionState.Blocked -> if (connection.repair) "blocked · pairing needs repair" else "blocked"
        ConnectionState.Connecting -> "connecting"
        ConnectionState.Authenticating -> "signing in"
        ConnectionState.Unpaired -> "unpaired"
    }

    /**
     * A copyable summary for support: versions, connection state, protocol, which providers can run
     * from this phone, and when it last synchronized. It names no keys, tokens, pairing offers,
     * addresses, device or session IDs, and no conversation content.
     */
    fun summary(app: AppIdentity, state: MobileState, lastSynchronized: Long?): String = buildString {
        appendLine("Cere Mobile ${app.versionName} (${app.versionCode}) · ${app.channel} channel")
        appendLine("Android ${app.androidRelease} (API ${app.sdk})")
        appendLine("Connection: ${connectionText(state.connection)}")
        val online = state.connection as? ConnectionState.Online
        appendLine("Desktop build: ${buildText(state.desktopBuild)}${if (online == null && state.desktopBuild != null) " · last seen ${Instant.ofEpochMilli(state.desktopBuild.seenAt)}" else ""}")
        appendLine("Protocol: ${protocolText(state.desktopBuild)}${online?.let { " · ${it.features.size} features · ${it.operations.size} operations" } ?: ""}")
        val providers = state.providers.entries.sortedBy { it.key }.joinToString(", ") { (id, value) ->
            val entry = value as? JsonObject
            val available = entry?.get("available")?.jsonPrimitive?.booleanOrNull == true
            val remote = entry?.get("remoteExecution")?.jsonPrimitive?.booleanOrNull == true
            "$id ${if (!available) "unavailable" else if (remote) "usable here" else "desktop only"}"
        }
        appendLine("Providers: ${providers.ifBlank { "none reported" }}")
        appendLine("Last synchronized: ${lastSynchronized?.let { Instant.ofEpochMilli(it).toString() } ?: "never"}")
        append("Pending desktop actions: ${state.pendingCommands.size} · Background monitoring: ${if (state.monitoring) "on" else "off"}")
    }
}
