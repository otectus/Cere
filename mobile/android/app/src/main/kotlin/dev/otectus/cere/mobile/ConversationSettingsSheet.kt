@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.cere.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import dev.otectus.cere.mobile.data.CereRepository
import dev.otectus.cere.mobile.data.MobileState
import dev.otectus.cere.mobile.protocol.ModelOption
import dev.otectus.cere.mobile.protocol.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
internal fun ConversationSettingsSheet(repository: CereRepository, state: MobileState, session: Session,
    activity: FragmentActivity, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var title by remember(session.id) { mutableStateOf(session.title) }
    var models by remember(session.id) { mutableStateOf(emptyList<ModelOption>()) }
    var model by remember(session.id) { mutableStateOf(session.model.orEmpty()) }
    var effort by remember(session.id) { mutableStateOf(session.effort.orEmpty()) }
    var tools by remember(session.id) { mutableStateOf(session.tools) }
    var baseline by remember(session.id) { mutableStateOf(session.configRevision) }
    var refresh by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val canConfigure = session.canConfigure && state.supports("sessions.configure")
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
    fun organize(pinned: Boolean? = null, archived: Boolean? = null) {
        submitting = true; error = null
        scope.launch {
            try {
                repository.mutate("sessions.organize", buildJsonObject {
                    put("sessionId", session.id); put("expectedRevision", session.revision)
                    pinned?.let { put("pinned", it) }; archived?.let { put("archived", it) }
                })
                repository.selectSession(session.id); close()
            } catch (failure: Exception) { error = failure.message }
            finally { submitting = false }
        }
    }
    val selected = models.firstOrNull { it.id == model }
    val changed = model != session.model.orEmpty() || effort != session.effort.orEmpty() || tools != session.tools
    AlertDialog(onDismissRequest = { if (!submitting) close() }, title = { Text("Conversation settings") }, text = {
        Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("${session.provider} · ${session.project.orEmpty()}", style = MaterialTheme.typography.bodySmall)
            if (state.supports("sessions.rename")) {
                OutlinedTextField(title, { title = it.take(100) }, label = { Text("Title") }, enabled = !submitting)
                TextButton({ submitting = true; scope.launch {
                    try {
                        repository.mutate("sessions.rename", buildJsonObject { put("sessionId", session.id); put("title", title.trim()); put("expectedRevision", session.revision) })
                        repository.selectSession(session.id); close()
                    } catch (failure: Exception) { error = failure.message }
                    finally { submitting = false }
                } }, enabled = !submitting && title.isNotBlank() && title.trim() != session.title) { Text("Rename") }
            }
            if (state.supports("sessions.organize")) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({ organize(pinned = !session.pinned) }, enabled = !submitting) { Text(if (session.pinned) "Unpin" else "Pin conversation") }
                OutlinedButton({ organize(archived = !session.archived) }, enabled = !submitting) { Text(if (session.archived) "Unarchive" else "Archive") }
            }
            if (canConfigure) {
                HorizontalDivider()
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Model", style = MaterialTheme.typography.titleMedium)
                    TextButton({ refresh++ }, enabled = !loading && !submitting) { Text("Refresh models") }
                }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (!loading && models.isEmpty()) Text("No models loaded. Check this provider on your PC, then refresh.")
                models.forEach { option ->
                    FilterChip(model == option.id, {
                        model = option.id; effort = option.defaultEffort
                        if ("tools" !in option.capabilities) tools = false
                    }, { Text(option.displayName) }, enabled = !submitting && !loading)
                }
                selected?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                    Text("Reasoning effort")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { efforts.forEach { option ->
                        FilterChip(effort == option.id, { effort = option.id }, { Text(option.displayName) }, enabled = !submitting)
                    } }
                }
                if (session.provider == "ollama") ListItem(headlineContent = { Text("Desktop tools") },
                    supportingContent = { Text("Uses the desktop's existing permission checks") },
                    trailingContent = { Switch(tools, { tools = it }, enabled = !submitting && selected?.capabilities?.contains("tools") == true) })
                if (conflict) {
                    Text("Conversation settings changed on the desktop. Reload before saving.", color = MaterialTheme.colorScheme.error)
                    TextButton({ model = session.model.orEmpty(); effort = session.effort.orEmpty(); tools = session.tools; baseline = session.configRevision; refresh++ }) { Text("Reload desktop settings") }
                }
            } else Text("Model changes are unavailable while busy or outside this phone's provider access.")
            if ((session.draftAttachmentCount ?: 0) > 0) Text("This draft includes ${session.draftAttachmentCount} desktop attachment(s). Review them on the PC before sending.")
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
            }, { error = it; submitting = false })
        }, enabled = !submitting && !loading && !conflict && changed && selected != null) { Text("Review & apply") }
    }, dismissButton = { TextButton(close, enabled = !submitting) { Text("Close") } })
}
