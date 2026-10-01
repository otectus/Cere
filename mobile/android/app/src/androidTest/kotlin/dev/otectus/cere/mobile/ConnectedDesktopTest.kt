package dev.otectus.cere.mobile

import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import dev.otectus.cere.mobile.data.ConnectionState
import dev.otectus.cere.mobile.protocol.Session
import dev.otectus.cere.mobile.protocol.WireCodec
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Explicit owner-device diagnostics. Mutations are restricted to a named synthetic session. */
class ConnectedDesktopTest {
    @Test fun pairedDesktopReadsReconnectAndSyntheticSend() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val desktopId = args.getString("cereExpectedDesktopId")
        assumeTrue("Needs an explicitly selected paired desktop", desktopId != null)
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
        val repository = (activity.application as CereApp).repository
        val online = withTimeout(45_000) { repository.state.first { it.connection is ConnectionState.Online && it.projects.isNotEmpty() } }
        check(online.desktop?.desktopId == desktopId)
        val previousSession = online.selectedSessionId
        val self = repository.request("devices.self", buildJsonObject {}).jsonObject
        check(self["id"]?.jsonPrimitive?.content == online.desktop?.deviceId)
        val projects = repository.request("projects.list", buildJsonObject {}).jsonArray
        check(projects.isNotEmpty())
        repository.request("settings.get", buildJsonObject {}).jsonObject
        repository.request("permissions.get", buildJsonObject {}).jsonObject
        repository.request("approvals.list", buildJsonObject {}).jsonArray
        if (online.supports("desktop.status")) repository.request("desktop.status", buildJsonObject { put("projectId", online.projects.first().id) }).jsonObject
        println("CONNECTED_CHECK: pinned TLS; device, project, settings, permission, inbox and desktop reads passed")
        val sessionId = args.getString("cereSmokeSessionId")
        try {
            if (sessionId != null) {
                repository.selectSession(sessionId)
                val session = WireCodec.json.decodeFromJsonElement(Session.serializer(), repository.request("sessions.get", buildJsonObject { put("sessionId", sessionId) }))
                check(session.title.startsWith("Cere mobile validation ") && session.provider == "ollama" && !session.tools && session.canSend)
                check(session.draft.isEmpty() && session.draftAttachmentCount == 0 && repository.state.value.draft(session).text.isEmpty())
                val models = repository.models(session.provider, refresh = true, sessionId = session.id)
                check(models.any { it.id == session.model })
                repository.loadMessages(session.id)
                check(repository.state.value.messages.none { it.sessionId == session.id }) { "Live send needs an unused synthetic session" }
                if (online.supports("memory.list")) {
                    repository.request("memory.list", buildJsonObject { put("sessionId", session.id); put("kind", "saved"); put("offset", 0); put("filter", "Cere mobile validation") })
                    println("CONNECTED_CHECK: scoped memory read passed")
                }
                val prompt = "Connectivity test. Reply with exactly CERE_MOBILE_OK. Do not use tools or save anything to memory."
                val action = repository.prepareSend(session.id, prompt)
                repository.completeAction(action, repository.signAuthenticated(action))
                repository.clearAcceptedDraft(session.id, prompt, emptySet())
                withTimeout(120_000) {
                    while (true) {
                        repository.loadMessages(session.id)
                        val rows = repository.state.value.messages.filter { it.sessionId == session.id }
                        if (rows.any { it.role == "assistant" && "CERE_MOBILE_OK" in it.text }) break
                        delay(1500)
                    }
                }
                check(repository.state.value.messages.any { it.sessionId == session.id && it.role == "user" && it.text == prompt })
                check(repository.state.value.pendingCommands.none { it.sessionId == session.id && it.method == "sessions.send" })
                println("CONNECTED_CHECK: live Ollama reply received after phone-key signed send; command reconciled; draft cleared")
                if (online.supports("sessions.organize")) {
                    var current = WireCodec.json.decodeFromJsonElement(Session.serializer(), repository.request("sessions.get", buildJsonObject { put("sessionId", session.id) }))
                    check(!current.pinned && !current.archived)
                    repository.mutate("sessions.organize", buildJsonObject { put("sessionId", session.id); put("expectedRevision", current.revision); put("pinned", true); put("archived", true) })
                    current = WireCodec.json.decodeFromJsonElement(Session.serializer(), repository.request("sessions.get", buildJsonObject { put("sessionId", session.id) }))
                    check(current.pinned && current.archived)
                    repository.mutate("sessions.organize", buildJsonObject { put("sessionId", session.id); put("expectedRevision", current.revision); put("pinned", false); put("archived", false) })
                    println("CONNECTED_CHECK: revision-bound pin/archive and restore passed")
                }
            }
            repository.stopMonitoring("Explicit USB reconnect test")
            withTimeout(5_000) { repository.state.first { it.connection is ConnectionState.Offline } }
            repository.startMonitoring()
            withTimeout(45_000) { repository.state.first { it.connection is ConnectionState.Online && it.projects.isNotEmpty() } }
            println("CONNECTED_CHECK: disconnect/reconnect and authoritative resync passed")
        } finally {
            repository.selectSession(previousSession)
            if (!online.monitoring) {
                repository.stopMonitoring("Restore monitoring preference after USB diagnostics")
                withTimeout(5_000) { repository.state.first { it.connection is ConnectionState.Offline } }
                repository.connectWhileOpen()
            }
        }
    }
}
