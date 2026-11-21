@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.cere.mobile

import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import dev.otectus.cere.mobile.data.CereRepository
import dev.otectus.cere.mobile.data.ConfigurationDraft
import dev.otectus.cere.mobile.data.MobileState
import dev.otectus.cere.mobile.data.ModelIds
import dev.otectus.cere.mobile.data.ToolAvailability
import dev.otectus.cere.mobile.data.ToolPolicy
import dev.otectus.cere.mobile.data.traits
import dev.otectus.cere.mobile.protocol.Agent
import dev.otectus.cere.mobile.protocol.ConversationBehavior
import dev.otectus.cere.mobile.protocol.ModelOption
import dev.otectus.cere.mobile.protocol.Session
import dev.otectus.cere.mobile.protocol.WireCodec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
internal fun ConversationSettingsSheet(repository: CereRepository, state: MobileState, session: Session,
    activity: FragmentActivity, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var title by rememberSaveable(session.id) { mutableStateOf(session.title) }
    var models by remember(session.id) { mutableStateOf(emptyList<ModelOption>()) }
    var unlisted by remember(session.id) { mutableStateOf(false) }
    var model by rememberSaveable(session.id) { mutableStateOf(session.model.orEmpty()) }
    var effort by rememberSaveable(session.id) { mutableStateOf(session.effort.orEmpty()) }
    var tools by rememberSaveable(session.id) { mutableStateOf(session.tools) }
    var toolsNotice by remember(session.id) { mutableStateOf<String?>(null) }
    var baseline by rememberSaveable(session.id) { mutableStateOf(session.configRevision) }
    var refresh by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    val traits = state.traits(session.provider)
    // A desktop that reports the stored tools choice also keeps options a change leaves out (sessions.toolsState).
    val toolsState = state.has("sessions.toolsState")
    val blocked = ConfigurationDraft.blockedReason(traits, toolsState)
    val canConfigure = session.canConfigure && state.supports("sessions.configure")
    val idle = session.status !in setOf("starting", "working", "waiting", "stopping") && session.agents.none(Agent::isActive)
    val conflict = baseline != session.configRevision
    LaunchedEffect(session.id, refresh, canConfigure) {
        if (canConfigure && blocked == null) {
            loading = true; error = null
            try { val catalog = repository.modelCatalog(session.provider, sessionId = session.id); models = catalog.models; unlisted = catalog.unlisted }
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
    val selected = models.firstOrNull { it.id == model.trim() }
    // A typed ID is accepted where the provider takes one (MOB-004); the desktop checks it again.
    val typed = traits.customModel
    val modelError = if (typed && selected == null) ModelIds.error(model) else null
    fun availability(option: ModelOption?) = ToolPolicy.availability(traits, option, session, toolsState)
    val tooling = availability(selected)
    val draft = ConfigurationDraft(model, effort, tools)
    // A model change keeps the tools choice unless the new model or route cannot use it; then the change is said first.
    fun keepTools(next: ToolAvailability) { if (tools && !next.available) { tools = false; toolsNotice = "Desktop tools turn off with this change: ${next.reason}" } else toolsNotice = null }
    fun chooseModel(option: ModelOption) { model = option.id; effort = option.defaultEffort; keepTools(availability(option)) }
    AncillarySheetScaffold(
        title = "Conversation settings",
        subtitle = listOfNotNull(traits.label, session.project).filter(String::isNotBlank).joinToString(" · "),
        busy = submitting,
        onDismiss = close,
        action = if (canConfigure && blocked == null) ({
            Button({
                submitting = true; error = null
                signedReview(activity, repository, "sessions.configure", draft.params(session, baseline, partial = toolsState, routeRevision = state.has("sessions.routeRevision")), "Change conversation model", {
                    scope.launch { try { repository.selectSession(session.id); close() } finally { submitting = false } }
                }, { error = it; submitting = false }, label = session.title)
            }, modifier = Modifier.fillMaxWidth().heightIn(min = CereLayout.target),
                enabled = !submitting && !loading && !conflict && draft.changes(session) &&
                    (selected != null || typed && modelError == null) && (!tools || tooling.available)) { Text("Review & apply") }
        }) else null,
    ) {
        AncillarySection("Conversation", "Name and organize this conversation") {
            session.connectionName?.let { Text("Connection: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (state.supports("sessions.rename")) {
                OutlinedTextField(title, { title = it.take(100) }, label = { Text("Title") }, enabled = !submitting, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton({ run("sessions.rename", buildJsonObject { put("sessionId", session.id); put("title", title.trim()); put("expectedRevision", session.revision) }) },
                    enabled = !submitting && title.isNotBlank() && title.trim() != session.title, modifier = Modifier.heightIn(min = CereLayout.target)) { Text("Rename") }
            }
            if (state.supports("sessions.organize")) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({ organize(pinned = !session.pinned) }, enabled = !submitting, modifier = Modifier.heightIn(min = CereLayout.target)) { Text(if (session.pinned) "Unpin" else "Pin conversation") }
                OutlinedButton({ organize(archived = !session.archived) }, enabled = !submitting, modifier = Modifier.heightIn(min = CereLayout.target)) { Text(if (session.archived) "Unarchive" else "Archive") }
            }
        }
            if (state.supports("sessions.disconnect") && session.mode == "managed") {
                AncillarySection("Provider connection", "Control the desktop provider process for this conversation") {
                Text(if (idle) "Disconnect closes ${session.provider.replaceFirstChar(Char::uppercase)} for this conversation on the desktop. History stays, and it reconnects with the next message."
                    else "Stop the active turn before disconnecting the provider.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton({ run("sessions.disconnect", buildJsonObject { put("sessionId", session.id) }, "Provider disconnected. It reconnects with your next message.", closeAfter = false) },
                    enabled = !submitting && idle, modifier = Modifier.heightIn(min = CereLayout.target)) { Text("Disconnect provider") }
                }
            }
            if (canConfigure && blocked != null) AncillarySection("Model") { Text(blocked, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            else if (canConfigure) {
                AncillarySection("Model and tools", "Choose how the next turn runs") {
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton({ refresh++ }, enabled = !loading && !submitting, modifier = Modifier.heightIn(min = CereLayout.target)) { Text("Refresh models") }
                }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                // An endpoint that lists no models is not a failure: its model ID is typed instead.
                if (!loading && unlisted) Text("This endpoint doesn't list its models. Enter the model ID below.", style = MaterialTheme.typography.bodySmall)
                else if (!loading && error != null && typed) Text("The model list could not be loaded. You can still enter a model ID below.", style = MaterialTheme.typography.bodySmall)
                else if (!loading && models.isEmpty() && error == null) Text(if (typed) "No models listed. Enter the model ID below." else "No models loaded. Check this provider on your PC, then refresh.")
                // The current model stays chosen even when a refreshed list leaves it out.
                session.model?.takeIf { it.isNotBlank() && !loading && models.isNotEmpty() && models.none { option -> option.id == it } }?.let {
                    Text("The current model, $it, is not in this list.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                models.forEach { option -> Row(Modifier.fillMaxWidth().heightIn(min = CereLayout.target)
                    .selectable(selected = model.trim() == option.id, enabled = !submitting && !loading, role = Role.RadioButton) { chooseModel(option) }
                    .padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(model.trim() == option.id, null, enabled = !submitting && !loading)
                    Column(Modifier.weight(1f)) { Text(option.displayName); if (option.description.isNotBlank()) Text(option.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                } }
                if (typed) OutlinedTextField(model, { value -> model = value.take(ModelIds.MAX_LENGTH + 64); effort = ""; keepTools(availability(models.firstOrNull { it.id == value.trim() })) },
                    label = { Text("Model ID") }, singleLine = true, enabled = !submitting, isError = modelError != null && model.isNotEmpty(),
                    supportingText = { Text(modelError?.takeIf { model.isNotEmpty() } ?: "As the provider names it; the desktop checks it.") }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Model ID" })
                selected?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                    Text("Reasoning effort")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { efforts.forEach { option ->
                        FilterChip(effort == option.id, { effort = option.id }, { Text(option.displayName) }, enabled = !submitting)
                    } }
                }
                if (tooling.applies) ListItem(headlineContent = { Text("Desktop tools") },
                    supportingContent = { Text(tooling.reason ?: "Uses the desktop's existing permission checks") },
                    // Tools that are on can always be turned off; turning them on needs a route and model that allow it.
                    trailingContent = { Switch(tools, { tools = it; toolsNotice = null }, enabled = !submitting && (tooling.available || tools)) })
                toolsNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
                if (conflict) {
                    Text("Conversation settings changed on the desktop. Reload before saving.", color = MaterialTheme.colorScheme.error)
                    TextButton({ model = session.model.orEmpty(); effort = session.effort.orEmpty(); tools = session.tools; toolsNotice = null; baseline = session.configRevision; refresh++ }) { Text("Reload desktop settings") }
                }
                }
            } else Text(session.toolsUnavailableReason?.takeIf { !session.canSend } ?: "Model changes are unavailable while busy or outside this phone's provider access.")
            if ((session.draftAttachmentCount ?: 0) > 0) Text("This draft includes ${session.draftAttachmentCount} desktop attachment(s). " +
                if (state.draftEditable(session)) "Review them under the message field before sending." else "Review them on the PC before sending.")
            if (state.supports("sessions.behavior")) ConversationStyle(repository, session.id)
            if (state.supports("workflows.status")) ConversationWork(repository, state, session.id)
            if (submitting) LinearProgressIndicator(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
            feedback?.let { AncillaryFeedback(it) }
            error?.let { AncillaryFeedback(it, error = true) }
    }
}

/**
 * W11: which style the conversation's next turn uses and where it is set. Styles are chosen on the
 * desktop. MOB-002: the answer is decoded into a model whose profile and posture are nullable, so the
 * desktop's JSON nulls (no style set) render as "No style" instead of failing.
 */
@Composable
private fun ConversationStyle(repository: CereRepository, sessionId: String) {
    var value by remember(sessionId) { mutableStateOf<ConversationBehavior?>(null) }
    LaunchedEffect(sessionId) {
        try { value = WireCodec.json.decodeFromJsonElement(ConversationBehavior.serializer(), repository.read("sessions.behavior", buildJsonObject { put("sessionId", sessionId) })) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { value = null }
    }
    value?.let { ConversationStyleContent(it) }
}

@Composable
internal fun ConversationStyleContent(behavior: ConversationBehavior) {
    AncillarySection("Style", "Styles and postures are chosen on the desktop") {
        val where = when (behavior.source) { "session" -> "set for this conversation"; "project" -> "set for this project"; else -> "the personality, for every conversation" }
        val profile = behavior.profile?.label?.takeIf(String::isNotBlank)
        Text(if (profile != null) "$profile · $where" else "No style · $where")
        behavior.posture?.takeIf { it.label.isNotBlank() }?.let { posture ->
            Text("Posture: ${posture.label}" + if (posture.pinned) " · pinned to this conversation" else "", style = MaterialTheme.typography.bodySmall)
        }
        if (behavior.standingInstructions) Text("This conversation also has standing instructions.", style = MaterialTheme.typography.bodySmall)
        behavior.warnings.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
    }
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
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var scheduleToPause by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(sessionId, open, refresh) {
        if (open) {
            loading = true
            runCatching { repository.read("workflows.status", buildJsonObject { put("sessionId", sessionId) }).jsonObject }
                .onSuccess { value = it; error = null }.onFailure { if (it is CancellationException) throw it; error = it.message }
            loading = false
        }
    }
    AncillarySection("Results and schedules", "Provider outcomes, Cere checks, and recurring work") {
        TextButton({ if (open) refresh++ else open = true }, enabled = !loading, modifier = Modifier.heightIn(min = CereLayout.target)) { Text(if (open) "Refresh" else "Show") }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (open) {
            error?.let { AncillaryFeedback(it, error = true) }
            val results = value?.get("results")?.jsonArray.orEmpty(); val schedules = value?.get("schedules")?.jsonArray.orEmpty()
            if (!loading && value != null && results.isEmpty() && schedules.isEmpty()) Text("No results or schedules for this conversation yet.", style = MaterialTheme.typography.bodySmall)
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
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(schedule["label"]?.jsonPrimitive?.contentOrNull.orEmpty())
                    Text(if (!enabled) "Paused · turn it on again from the desktop" else if (next != null) "Next run ${time.format(java.util.Date(next))}" else "On", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (enabled && state.supports("workflows.pauseSchedule")) TextButton({ scheduleToPause = schedule }, modifier = Modifier.heightIn(min = CereLayout.target)) { Text("Pause schedule") }
                }
            }
        }
    }
    scheduleToPause?.let { schedule ->
        val label = schedule["label"]?.jsonPrimitive?.contentOrNull ?: "this schedule"
        AlertDialog(
            onDismissRequest = { scheduleToPause = null },
            title = { Text("Pause schedule?") },
            text = { Text("$label will stop running until you turn it on again from the desktop.") },
            confirmButton = { Button({
                scheduleToPause = null; loading = true
                scope.launch {
                    runCatching { repository.mutate("workflows.pauseSchedule", buildJsonObject { put("sessionId", sessionId); put("scheduleId", schedule.getValue("id").jsonPrimitive.content); put("expectedRevision", schedule.getValue("revision").jsonPrimitive.content) }) }
                        .onSuccess { refresh++ }.onFailure { if (it is CancellationException) throw it; error = it.message; loading = false }
                }
            }) { Text("Pause") } },
            dismissButton = { TextButton({ scheduleToPause = null }) { Text("Keep running") } },
        )
    }
}
