@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.cere.mobile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import dev.otectus.cere.mobile.data.CereRepository
import dev.otectus.cere.mobile.data.MobileState
import dev.otectus.cere.mobile.data.traits
import dev.otectus.cere.mobile.protocol.Agent
import dev.otectus.cere.mobile.protocol.ModelOption
import dev.otectus.cere.mobile.protocol.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
internal fun ConversationSettingsSheet(repository: CereRepository, state: MobileState, session: Session,
    activity: FragmentActivity, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var title by rememberSaveable(session.id) { mutableStateOf(session.title) }
    var models by remember(session.id) { mutableStateOf(emptyList<ModelOption>()) }
    var model by rememberSaveable(session.id) { mutableStateOf(session.model.orEmpty()) }
    var effort by rememberSaveable(session.id) { mutableStateOf(session.effort.orEmpty()) }
    var tools by rememberSaveable(session.id) { mutableStateOf(session.tools) }
    var baseline by rememberSaveable(session.id) { mutableStateOf(session.configRevision) }
    var refresh by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    val canConfigure = session.canConfigure && state.supports("sessions.configure")
    val idle = session.status !in setOf("starting", "working", "waiting", "stopping") && session.agents.none(Agent::isActive)
    val conflict = baseline != session.configRevision
    LaunchedEffect(session.id, refresh, canConfigure) {
        if (canConfigure) {
            loading = true; error = null
            try { models = repository.models(session.provider, refresh = true, sessionId = session.id) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { loading = false }
        }
    }
    fun run(method: String, params: JsonObject, done: String? = null, closeAfter: Boolean = true) {
        submitting = true; error = null; feedback = null
        scope.launch {
            try {
                repository.mutate(method, params, session.title)
                repository.selectSession(session.id)
                if (closeAfter) close() else feedback = done
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { submitting = false }
        }
    }
    fun organize(pinned: Boolean? = null, archived: Boolean? = null) = run("sessions.organize", buildJsonObject {
        put("sessionId", session.id); put("expectedRevision", session.revision)
        pinned?.let { put("pinned", it) }; archived?.let { put("archived", it) }
    })
    val selected = models.firstOrNull { it.id == model }
    val changed = model != session.model.orEmpty() || effort != session.effort.orEmpty() || tools != session.tools
    fun chooseModel(option: ModelOption) { model = option.id; effort = option.defaultEffort; if ("tools" !in option.capabilities) tools = false }
    AlertDialog(onDismissRequest = { if (!submitting) close() }, title = { Text("Conversation settings") }, text = {
        Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("${session.provider} · ${session.project.orEmpty()}", style = MaterialTheme.typography.bodySmall)
            if (state.supports("sessions.rename")) {
                OutlinedTextField(title, { title = it.take(100) }, label = { Text("Title") }, enabled = !submitting, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton({ run("sessions.rename", buildJsonObject { put("sessionId", session.id); put("title", title.trim()); put("expectedRevision", session.revision) }) },
                    enabled = !submitting && title.isNotBlank() && title.trim() != session.title) { Text("Rename") }
            }
            if (state.supports("sessions.organize")) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({ organize(pinned = !session.pinned) }, enabled = !submitting) { Text(if (session.pinned) "Unpin" else "Pin conversation") }
                OutlinedButton({ organize(archived = !session.archived) }, enabled = !submitting) { Text(if (session.archived) "Unarchive" else "Archive") }
            }
            if (state.supports("sessions.disconnect") && session.mode == "managed") {
                HorizontalDivider()
                Text("Provider connection", style = MaterialTheme.typography.titleMedium)
                Text(if (idle) "Disconnect closes ${session.provider.replaceFirstChar(Char::uppercase)} for this conversation on the desktop. History stays, and it reconnects with the next message."
                    else "Stop the active turn before disconnecting the provider.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton({ run("sessions.disconnect", buildJsonObject { put("sessionId", session.id) }, "Provider disconnected. It reconnects with your next message.", closeAfter = false) },
                    enabled = !submitting && idle) { Text("Disconnect provider") }
            }
            if (canConfigure) {
                HorizontalDivider()
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Model", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    TextButton({ refresh++ }, enabled = !loading && !submitting) { Text("Refresh models") }
                }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (!loading && models.isEmpty()) Text("No models loaded. Check this provider on your PC, then refresh.")
                models.forEach { option -> Row(Modifier.fillMaxWidth().clickable(enabled = !submitting && !loading) { chooseModel(option) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(model == option.id, { chooseModel(option) }, enabled = !submitting && !loading)
                    Column { Text(option.displayName); if (option.description.isNotBlank()) Text(option.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                } }
                selected?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                    Text("Reasoning effort")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { efforts.forEach { option ->
                        FilterChip(effort == option.id, { effort = option.id }, { Text(option.displayName) }, enabled = !submitting)
                    } }
                }
                if (state.traits(session.provider).cereTools) ListItem(headlineContent = { Text("Desktop tools") },
                    supportingContent = { Text("Uses the desktop's existing permission checks") },
                    trailingContent = { Switch(tools, { tools = it }, enabled = !submitting && selected?.capabilities?.contains("tools") == true) })
                if (conflict) {
                    Text("Conversation settings changed on the desktop. Reload before saving.", color = MaterialTheme.colorScheme.error)
                    TextButton({ model = session.model.orEmpty(); effort = session.effort.orEmpty(); tools = session.tools; baseline = session.configRevision; refresh++ }) { Text("Reload desktop settings") }
                }
            } else Text("Model changes are unavailable while busy or outside this phone's provider access.")
            if ((session.draftAttachmentCount ?: 0) > 0) Text("This draft includes ${session.draftAttachmentCount} desktop attachment(s). " +
                if (state.draftEditable(session)) "Review them under the message field before sending." else "Review them on the PC before sending.")
            if (state.supports("sessions.behavior")) ConversationStyle(repository, session.id)
            if (state.supports("workflows.status")) ConversationWork(repository, state, session.id)
            feedback?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = {
        if (canConfigure) Button({
            submitting = true; error = null
            signedReview(activity, repository, "sessions.configure", buildJsonObject {
                put("sessionId", session.id); put("model", model); put("tools", tools)
                put("effort", effort); put("expectedConfigRevision", baseline)
            }, "Change conversation model", {
                scope.launch { try { repository.selectSession(session.id); close() } finally { submitting = false } }
            }, { error = it; submitting = false }, label = session.title)
        }, enabled = !submitting && !loading && !conflict && changed && selected != null) { Text("Review & apply") }
    }, dismissButton = { TextButton(close, enabled = !submitting) { Text("Close") } })
}

/** W11: which style the conversation's next turn uses and where it is set. Styles are chosen on the desktop. */
@Composable
private fun ConversationStyle(repository: CereRepository, sessionId: String) {
    var value by remember(sessionId) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(sessionId) { value = runCatching { repository.read("sessions.behavior", buildJsonObject { put("sessionId", sessionId) }).jsonObject }.getOrNull() }
    val behavior = value ?: return
    HorizontalDivider()
    Text("Style", style = MaterialTheme.typography.titleMedium)
    val where = when (behavior["source"]?.jsonPrimitive?.contentOrNull) { "session" -> "set for this conversation"; "project" -> "set for this project"; else -> "the personality, for every conversation" }
    val profile = behavior["profile"]?.jsonObject?.get("label")?.jsonPrimitive?.contentOrNull
    Text(if (profile != null) "$profile · $where" else "No style · $where")
    behavior["posture"]?.jsonObject?.let { posture ->
        Text("Posture: ${posture["label"]?.jsonPrimitive?.contentOrNull.orEmpty()}" + if (posture["pinned"]?.jsonPrimitive?.booleanOrNull == true) " · pinned to this conversation" else "", style = MaterialTheme.typography.bodySmall)
    }
    if (behavior["standingInstructions"]?.jsonPrimitive?.booleanOrNull == true) Text("This conversation also has standing instructions.", style = MaterialTheme.typography.bodySmall)
    behavior["warnings"]?.jsonArray?.forEach { Text(it.jsonPrimitive.content, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
    Text("Styles and postures are chosen on the desktop.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * W11: the conversation's results, with the provider's report kept apart from what Cere itself
 * verified, and the schedules made from it. A schedule can be paused here; turning it on again is a
 * desktop review.
 */
@Composable
private fun ConversationWork(repository: CereRepository, state: MobileState, sessionId: String) {
    val scope = rememberCoroutineScope()
    var value by remember(sessionId) { mutableStateOf<JsonObject?>(null) }
    var open by rememberSaveable(sessionId) { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(sessionId, open, refresh) {
        if (open) runCatching { repository.read("workflows.status", buildJsonObject { put("sessionId", sessionId) }).jsonObject }
            .onSuccess { value = it; error = null }.onFailure { if (it is CancellationException) throw it; error = it.message }
    }
    HorizontalDivider()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("Results and schedules", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        TextButton({ if (open) refresh++ else open = true }) { Text(if (open) "Refresh" else "Show") }
    }
    if (!open) return
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    val results = value?.get("results")?.jsonArray.orEmpty(); val schedules = value?.get("schedules")?.jsonArray.orEmpty()
    if (value != null && results.isEmpty() && schedules.isEmpty()) Text("No results or schedules for this conversation yet.", style = MaterialTheme.typography.bodySmall)
    results.map(JsonElement::jsonObject).forEach { result ->
        val provider = result["providerOutcome"]?.jsonPrimitive?.contentOrNull.orEmpty(); val verification = result["verification"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val gate = when (result["gate"]?.jsonPrimitive?.contentOrNull) { "passed" -> "required checks passed"; "failed" -> "a required check failed"; "incomplete" -> "required checks incomplete"; else -> "no required checks" }
        Text("Provider reported: $provider · Cere verified: ${verification.replace('-', ' ')} · $gate", style = MaterialTheme.typography.bodySmall)
        if (result["editedSinceCheck"]?.jsonPrimitive?.booleanOrNull == true) Text("Files changed after the last passing check.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
        result["uncertainty"]?.jsonPrimitive?.contentOrNull?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
    val time = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
    schedules.map(JsonElement::jsonObject).forEach { schedule ->
        val enabled = schedule["enabled"]?.jsonPrimitive?.booleanOrNull == true
        val next = schedule["next"]?.jsonPrimitive?.longOrNull
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(schedule["label"]?.jsonPrimitive?.contentOrNull.orEmpty())
                Text(if (!enabled) "Paused · turn it on again from the desktop" else if (next != null) "Next run ${time.format(java.util.Date(next))}" else "On", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (enabled && state.supports("workflows.pauseSchedule")) TextButton({ scope.launch {
                runCatching { repository.mutate("workflows.pauseSchedule", buildJsonObject { put("sessionId", sessionId); put("scheduleId", schedule.getValue("id").jsonPrimitive.content); put("expectedRevision", schedule.getValue("revision").jsonPrimitive.content) }) }
                    .onSuccess { refresh++ }.onFailure { if (it is CancellationException) throw it; error = it.message; refresh++ }
            } }) { Text("Pause") }
        }
    }
}
