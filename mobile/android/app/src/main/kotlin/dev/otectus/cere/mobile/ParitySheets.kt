@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.cere.mobile

import android.content.Intent
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.otectus.cere.mobile.data.CereRepository
import dev.otectus.cere.mobile.data.MobileState
import dev.otectus.cere.mobile.data.traits
import dev.otectus.cere.mobile.protocol.ModelOption
import dev.otectus.cere.mobile.protocol.Project
import dev.otectus.cere.mobile.protocol.Session
import dev.otectus.cere.mobile.protocol.WireCodec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import java.io.InputStream
import java.io.ByteArrayOutputStream

/**
 * Consistent full-height treatment for secondary tasks. The bounded inner column avoids an
 * over-wide form on tablets while the scrolling body and fixed action area remain usable in
 * landscape, with the keyboard open, and at large font scales. When available height is short,
 * the chrome joins the scroll so content and actions cannot crowd each other out.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AncillarySheetScaffold(
    title: String,
    subtitle: String? = null,
    busy: Boolean,
    onDismiss: () -> Unit,
    action: (@Composable RowScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val padding = CereLayout.gutter
    val spacing = CereLayout.groupGap
    val touchTarget = CereLayout.target
    @Composable fun Header() {
        Row(
            Modifier.fillMaxWidth().padding(start = padding, end = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).semantics { heading() }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.headlineSmall)
                subtitle?.takeIf(String::isNotBlank)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            TextButton(onDismiss, enabled = !busy, modifier = Modifier.heightIn(min = touchTarget)) { Text("Close") }
        }
    }
    @Composable fun Footer() {
        if (action != null) {
            HorizontalDivider()
            Row(
                Modifier.fillMaxWidth().padding(horizontal = padding, vertical = 10.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
                content = action,
            )
        }
    }
    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth().imePadding().fillMaxHeight(0.94f).semantics { paneTitle = title }) {
            val compact = maxHeight < 420.dp
            val wholePageScroll = rememberScrollState()
            val bodyScroll = rememberScrollState()
            // Keep the fields in the same composition when IME insets change. Replacing the body
            // at the height breakpoint disposes its focused editor and closes the keyboard.
            Column(Modifier.fillMaxHeight().widthIn(max = CereLayout.readingWidth).fillMaxWidth()
                .align(Alignment.TopCenter).then(if (compact) Modifier.verticalScroll(wholePageScroll) else Modifier)) {
                Header()
                HorizontalDivider()
                Column(Modifier.fillMaxWidth().then(if (compact) Modifier else Modifier.weight(1f).verticalScroll(bodyScroll))
                    .padding(padding), verticalArrangement = Arrangement.spacedBy(spacing), content = content)
                Footer()
            }
        }
    }
}

@Composable
internal fun AncillarySection(
    title: String,
    detail: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surface,
        shape = MaterialTheme.shapes.medium,
        tonalElevation = 1.dp,
    ) {
        Column(Modifier.padding(CereLayout.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.semantics { heading() }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            content()
        }
    }
}

@Composable
internal fun AncillaryFeedback(message: String, error: Boolean = false) {
    Surface(
        Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
        contentColor = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer,
        shape = MaterialTheme.shapes.medium,
    ) { Text(message, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium) }
}

/** source=null opens authorized native history; source!=null creates an editable handoff draft. */
@Composable
fun SessionTransferSheet(repository: CereRepository, state: MobileState, activity: FragmentActivity, source: Session?, onDismiss: () -> Unit, onCreated: (String) -> Unit) {
    var projectId by rememberSaveable(source?.id) { mutableStateOf(source?.projectId ?: state.projects.firstOrNull()?.id.orEmpty()) }
    val providers = state.providers.filter { (_, value) -> (value as? JsonObject)?.get("remoteExecution")?.jsonPrimitive?.booleanOrNull == true }.keys.toList()
    var provider by rememberSaveable(source?.id) { mutableStateOf(providers.firstOrNull().orEmpty()) }
    var model by rememberSaveable(source?.id) { mutableStateOf("") }; var models by remember { mutableStateOf(emptyList<ModelOption>()) }
    var preview by remember { mutableStateOf<JsonObject?>(null) }; var draft by rememberSaveable(source?.id) { mutableStateOf("") }
    var history by remember { mutableStateOf(emptyList<JsonObject>()) }; var historyId by rememberSaveable(source?.id) { mutableStateOf("") }
    var stopped by rememberSaveable(source?.id) { mutableStateOf(false) }; var busy by remember { mutableStateOf(false) }; var modelLoading by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }
    // Desktop history can come from Codex or, with a desktop that offers it, Claude Code.
    val historyProviders = if (state.has("history.claude")) listOf("codex" to "Codex", "claude" to "Claude Code") else listOf("codex" to "Codex")
    var historyProvider by rememberSaveable(source?.id) { mutableStateOf("codex") }
    val projectIds = state.projects.map(Project::id); val sessionIds = state.sessions.map(Session::id)
    LaunchedEffect(state.cacheEpoch) { preview = null; draft = ""; history = emptyList(); historyId = ""; stopped = false; error = null }
    LaunchedEffect(sessionIds) { if (source != null && source.id !in sessionIds) { preview = null; draft = ""; onDismiss() } }
    LaunchedEffect(projectIds) { if (projectId !in projectIds) projectId = projectIds.firstOrNull().orEmpty() }
    LaunchedEffect(source?.id, if (source == null) projectId else null, if (source == null) historyProvider else null, state.cacheEpoch) {
        busy = true; error = null
        runCatching {
            if (source != null) repository.read("sessions.handoffPreview", buildJsonObject { put("sessionId", source.id) }).jsonObject.let { preview = it; if (draft.isBlank()) draft = it.getValue("draft").jsonPrimitive.content }
            else repository.read("sessions.history", buildJsonObject { put("projectId", projectId); if (historyProvider != "codex") put("provider", historyProvider) }).jsonObject.let { value -> history = value["items"]?.jsonArray.orEmpty().map { row -> row.jsonObject }; if (history.none { it["id"]?.jsonPrimitive?.contentOrNull == historyId }) historyId = "" }
        }.onFailure { error = it.message }; busy = false
    }
    var unlisted by remember { mutableStateOf(false) }
    LaunchedEffect(provider) {
        if (source != null && provider.isNotEmpty()) {
            modelLoading = true
            try {
                val catalog = repository.modelCatalog(provider); models = catalog.models; unlisted = catalog.unlisted
                // A provider that needs a model gets one chosen for it; a typed ID is kept.
                if (models.none { option -> option.id == model.trim() } && !(state.traits(provider).customModel && model.isNotBlank()))
                    model = if (state.traits(provider).modelRequired) models.firstOrNull { option -> option.isDefault }?.id ?: models.firstOrNull()?.id.orEmpty() else ""
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { modelLoading = false }
        }
    }
    // MOB-004: the destination's model follows the provider's rules: required, listed, or typed.
    val destination = state.traits(provider)
    val modelReady = !destination.modelRequired || models.any { it.id == model.trim() } || destination.customModel && dev.otectus.cere.mobile.data.ModelIds.error(model) == null
    val working = busy || modelLoading
    AncillarySheetScaffold(
        title = if (source == null) "Desktop history" else "Hand off conversation",
        subtitle = if (source == null) "Continue a stopped external thread" else "Create an editable draft for another provider",
        busy = working,
        onDismiss = onDismiss,
        action = { Button(onClick = {
            busy = true; error = null
            val method = if (source == null) "sessions.import" else "sessions.handoffCreate"
            val params = buildJsonObject { if (source == null) { put("historyId", historyId); put("externalWriterStopped", true) } else { put("sourceSessionId", source.id); put("sourceDigest", preview!!.getValue("sourceDigest")); put("draft", draft); put("projectId", projectId); put("provider", provider); put("model", model.trim()); put("tools", false) } }
            signedReview(activity, repository, method, params, if (source == null) "Import this desktop thread" else "Create this handoff draft", { value -> busy = false; onCreated(value.jsonObject.getValue("id").jsonPrimitive.content) }, { error = it; busy = false }, projectId)
        }, modifier = Modifier.fillMaxWidth().heightIn(min = CereLayout.target),
            enabled = !working && projectId.isNotBlank() && if (source == null) stopped && historyId.isNotBlank() else preview != null && draft.isNotBlank() && provider.isNotBlank() && modelReady
        ) { Text(if (source == null) "Review & import" else "Create draft") } },
    ) {
        Text(if (source == null) "Import a stopped conversation from an approved project. Its historical transcript remains with the provider; a Claude Code conversation continues in Claude's restricted mode." else "Review the last eight conversation messages. This creates a draft; Send is a separate action.")
        source?.let { original ->
            val project = state.projects.firstOrNull { it.id == original.projectId }
            AncillarySection("Source", "The conversation being handed off") {
                Text(project?.name ?: original.title, fontWeight = FontWeight.SemiBold)
                SelectionContainer { Text(project?.path ?: original.project ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) }
                if (original.provider == "ollama") Text("Ollama · ${original.ollamaHost.ifBlank { state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable" }}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        AncillarySection("Destination project", "The approved project that will own the conversation") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.projects.forEach { project -> FilterChip(projectId == project.id, { projectId = project.id }, { Column { Text(project.name); Text(project.path ?: "Path unavailable", style = MaterialTheme.typography.labelSmall) } }, enabled = !working) }
            }
            state.projects.firstOrNull { it.id == projectId }?.let { project -> SelectionContainer { Text(project.path ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) } }
        }
        if (source != null) {
            AncillarySection("Provider and model", "Where the handoff draft will continue") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { providers.forEach { value -> FilterChip(provider == value, { provider = value }, { Text(state.traits(value).label) }, enabled = !working) } }
                if (provider == "ollama") Text("Ollama destination · ${state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!destination.modelRequired) FilterChip(model.isBlank(), { model = "" }, { Text("Provider default model") }, enabled = !working)
                    models.forEach { option -> FilterChip(model.trim() == option.id, { model = option.id }, { Text(option.displayName + if (option.cloud) " · Cloud" else "") }, enabled = !working) }
                }
                if (unlisted) Text("This endpoint doesn't list its models. Enter the model ID.", style = MaterialTheme.typography.bodySmall)
                if (destination.customModel) OutlinedTextField(model, { model = it.take(dev.otectus.cere.mobile.data.ModelIds.MAX_LENGTH + 64) }, label = { Text("Model ID") }, singleLine = true,
                    enabled = !working, isError = model.isNotEmpty() && models.none { it.id == model.trim() } && dev.otectus.cere.mobile.data.ModelIds.error(model) != null, modifier = Modifier.fillMaxWidth())
            }
            AncillarySection("Draft", "Review and edit before creating it") {
                if (preview?.get("shortened")?.jsonPrimitive?.booleanOrNull == true) AncillaryFeedback("Some source text is shortened. Check and edit the draft before continuing.")
                OutlinedTextField(draft, { draft = it.take(100000) }, label = { Text("Handoff draft") }, minLines = 5, maxLines = 12, enabled = !working, modifier = Modifier.fillMaxWidth())
            }
        } else {
            AncillarySection("External thread", "Choose one stopped thread to continue") {
                if (historyProviders.size > 1) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { historyProviders.forEach { (id, label) -> FilterChip(historyProvider == id, { historyProvider = id; historyId = "" }, { Text(label) }, enabled = !working) } }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { history.forEach { item -> FilterChip(historyId == item["id"]?.jsonPrimitive?.content, { historyId = item.getValue("id").jsonPrimitive.content }, { Text(item["title"]?.jsonPrimitive?.content ?: "Desktop thread") }, enabled = !working) } }
                if (!working && history.isEmpty()) Text("No importable ${historyProviders.firstOrNull { it.first == historyProvider }?.second ?: "desktop"} threads in this project.")
                Row(Modifier.fillMaxWidth().heightIn(min = CereLayout.target)
                    .toggleable(stopped, enabled = !working, role = Role.Checkbox) { stopped = it }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(stopped, null, enabled = !working)
                    Text("I stopped the external CLI writer. Cere may now manage this thread.", Modifier.weight(1f))
                }
            }
        }
        if (working) LinearProgressIndicator(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
        error?.let { AncillaryFeedback(it, error = true) }
    }
}

/** record=null previews clearing the selected project. Editing always uses a reviewed revision. */
@Composable
fun MemoryRecordSheet(repository: CereRepository, state: MobileState, activity: FragmentActivity, sessionId: String, record: JsonObject?, onDismiss: () -> Unit, onChanged: () -> Unit, kind: String = "saved", rows: List<JsonObject> = emptyList()) {
    val session = state.sessions.find { it.id == sessionId }; val project = state.projects.find { it.id == session?.projectId }
    val scope = rememberCoroutineScope(); val id = record?.get("id")?.jsonPrimitive?.contentOrNull
    var text by rememberSaveable(id) { mutableStateOf(record?.get("text")?.jsonPrimitive?.contentOrNull.orEmpty()) }
    var preview by remember { mutableStateOf<JsonObject?>(null) }; var confirmation by rememberSaveable(id) { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }; var busy by remember { mutableStateOf(false) }; var graphBusy by remember { mutableStateOf(false) }
    val revision = record?.get("revision")?.jsonPrimitive?.contentOrNull
    val editable = record?.get("kind")?.jsonPrimitive?.contentOrNull == "saved" || record?.get("type")?.jsonPrimitive?.contentOrNull == "saved"
    val working = busy || graphBusy
    AncillarySheetScaffold(
        title = if (record == null) "Clear project memory" else "Memory record",
        subtitle = project?.name ?: "Selected project",
        busy = working,
        onDismiss = onDismiss,
        action = if (editable && id != null && text.isNotBlank() && revision != null && state.supports("memory.save")) ({
            Button({
                busy = true; error = null
                signedReview(activity, repository, "memory.save", buildJsonObject { put("sessionId", sessionId); put("id", id); put("text", text); put("expectedRevision", revision) }, "Save this edited fact", { busy = false; onChanged(); onDismiss() }, { error = it; busy = false })
            }, enabled = !working && preview == null, modifier = Modifier.fillMaxWidth().heightIn(min = CereLayout.target)) { Text("Review & save") }
        }) else null,
    ) {
        AncillarySection("Project", "Memory changes stay within this approved project") {
            SelectionContainer { Text(project?.path ?: session?.project ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) }
            Text("Ollama · ${session?.ollamaHost?.ifBlank { state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable" } ?: "host unavailable"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (record != null) AncillarySection("Record") {
            if (text.isNotBlank()) OutlinedTextField(text, { if (editable) text = it.take(MEMORY_FACT_LIMIT) }, readOnly = !editable, enabled = !working, minLines = 4, maxLines = 10, label = { Text(if (editable) "Saved fact" else "Memory content") },
                supportingText = { if (editable) Text("${text.length} / $MEMORY_FACT_LIMIT characters") }, modifier = Modifier.fillMaxWidth())
            else Text("This graph record can be inspected on the desktop. Forget below removes it and dependent evidence in this project.")
            MemoryGraphActions(repository, state, activity, sessionId, kind, record, rows, onChanged) { graphBusy = it }
        }
        AncillarySection(
            if (record == null) "Clear memory" else "Forget record",
            "Preview the impact before confirming this destructive change",
        ) {
            if (preview == null) OutlinedButton(
                onClick = { scope.launch { busy = true; error = null; runCatching { repository.read("memory.forgetPreview", buildJsonObject { put("sessionId", sessionId); id?.let { put("id", it) } }).jsonObject }.onSuccess { preview = it }.onFailure { error = it.message }; busy = false } },
                enabled = !working && state.supports("memory.forgetPreview"),
                modifier = Modifier.fillMaxWidth().heightIn(min = CereLayout.target),
            ) { Text("Preview what will be forgotten") }
            preview?.let { value ->
                AncillaryFeedback("${value["count"]?.jsonPrimitive?.content ?: "0"} records will be suppressed, including dependent evidence. Source occurrences may also be removed from saved conversations.")
                OutlinedTextField(confirmation, { confirmation = it }, label = { Text("Type ${project?.name ?: "FORGET"} to confirm") }, singleLine = true, enabled = !working, modifier = Modifier.fillMaxWidth())
                Button(onClick = {
                    busy = true; error = null
                    val method = if (record == null) "memory.clear" else "memory.forget"
                    val params = buildJsonObject { put("sessionId", sessionId); if (record == null) put("confirmProjectId", project!!.id) else put("id", id!!); put("selection", value.getValue("selection")); put("expectedRevision", value.getValue("revision")) }
                    signedReview(activity, repository, method, params, "Forget reviewed memory", { result -> busy = false; scope.launch { runCatching { repository.recordErasure(result, sessionId, if (record == null) "Cleared ${project?.name ?: "project"} memory" else (text.ifBlank { "A memory record" }).take(80)) } }; onChanged(); onDismiss() }, { error = it; busy = false })
                }, enabled = !working && project != null && confirmation == project.name && state.supports(if (record == null) "memory.clear" else "memory.forget"),
                    modifier = Modifier.fillMaxWidth().heightIn(min = CereLayout.target),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(if (record == null) "Clear this project" else "Forget this record") }
            }
        }
        if (working) LinearProgressIndicator(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
        error?.let { AncillaryFeedback(it, error = true) }
    }
}

/**
 * W09: the graph workflows a person can do from the phone, each typed, bound to the revision on screen
 * and witnessed by their own statement: an assertion's history and correction, choosing the right
 * assertion in a conflict, an identity decision between two entities, and freezing an episode.
 */
@Composable
internal fun MemoryGraphActions(repository: CereRepository, state: MobileState, activity: FragmentActivity, sessionId: String, kind: String, record: JsonObject, rows: List<JsonObject>, onChanged: () -> Unit, onBusyChange: (Boolean) -> Unit = {}) {
    val scope = rememberCoroutineScope(); val id = record["id"]?.jsonPrimitive?.contentOrNull ?: return
    val revision = record["revision"]?.jsonPrimitive?.contentOrNull
    var history by remember(id) { mutableStateOf<JsonObject?>(null) }; var busy by remember(id) { mutableStateOf(false) }
    var error by remember(id) { mutableStateOf<String?>(null) }; var done by remember(id) { mutableStateOf<String?>(null) }
    var statement by rememberSaveable(id) { mutableStateOf("") }; var replacement by rememberSaveable(id) { mutableStateOf("") }
    var other by rememberSaveable(id) { mutableStateOf<String?>(null) }; var decision by rememberSaveable(id) { mutableStateOf("not_same") }
    fun setBusy(value: Boolean) { busy = value; onBusyChange(value) }
    fun review(method: String, params: JsonObject, title: String) { setBusy(true); error = null; done = null
        signedReview(activity, repository, method, params, title, { setBusy(false); done = "Saved on the desktop."; onChanged() }, { error = it; setBusy(false) }) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (kind == "assertions" && state.supports("memory.timeline")) {
            OutlinedButton({ scope.launch { setBusy(true); error = null; runCatching { repository.read("memory.timeline", buildJsonObject { put("sessionId", sessionId); put("id", id) }).jsonObject }.onSuccess { history = it }.onFailure { error = it.message }; setBusy(false) } }, enabled = !busy) { Text("Show history and evidence") }
            history?.let { StructuredObject(it) }
        }
        val statementField: @Composable (String) -> Unit = { label -> OutlinedTextField(statement, { statement = it.take(2000) }, label = { Text(label) }, minLines = 2, modifier = Modifier.fillMaxWidth(), supportingText = { Text("Your own words are kept as the evidence for this change.") }) }
        if (kind == "assertions" && revision != null && state.supports("memory.correct")) {
            Text("Correct this", fontWeight = FontWeight.Medium)
            OutlinedTextField(replacement, { replacement = it.take(200) }, label = { Text("What it should be") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            statementField("Your correction, as you would say it")
            Button({ review("memory.correct", buildJsonObject { put("sessionId", sessionId); put("id", id); put("expectedRevision", revision); put("statement", statement.trim()); put("change", buildJsonObject { put("objectName", replacement.trim()) }) }, "Correct this memory") },
                enabled = !busy && replacement.isNotBlank() && statement.isNotBlank()) { Text("Review & correct") }
            if (record["status"]?.jsonPrimitive?.contentOrNull in setOf("conflict", "contested", "disputed") && state.supports("memory.resolveConflict"))
                OutlinedButton({ review("memory.resolveConflict", buildJsonObject { put("sessionId", sessionId); put("id", id); put("expectedRevision", revision); put("statement", statement.trim()) }, "Keep this one in the conflict") }, enabled = !busy && statement.isNotBlank()) { Text("This one is right") }
        }
        if (kind == "entities" && state.supports("memory.identity")) {
            val type = record["type"]?.jsonPrimitive?.contentOrNull
            val candidates = rows.filter { it["id"]?.jsonPrimitive?.contentOrNull != id && it["type"]?.jsonPrimitive?.contentOrNull == type }
            if (candidates.isNotEmpty()) {
                Text("Compare with another ${type ?: "entity"} on this page", fontWeight = FontWeight.Medium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { candidates.forEach { row -> val rowId = row["id"]?.jsonPrimitive?.contentOrNull; FilterChip(other == rowId, { other = rowId }, { Text(row["text"]?.jsonPrimitive?.contentOrNull ?: "Entity") }) } }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("same" to "The same", "not_same" to "Not the same", "possible" to "Possibly the same").forEach { (value, label) -> FilterChip(decision == value, { decision = value }, { Text(label) }) } }
                statementField("Why, in your words")
                Button({ review("memory.identity", buildJsonObject { put("sessionId", sessionId); put("leftId", id); put("rightId", other!!); put("decision", decision); put("statement", statement.trim()) }, "Record this identity decision") },
                    enabled = !busy && other != null && statement.isNotBlank()) { Text("Review & record") }
            }
        }
        if (kind == "episodes" && state.supports("memory.freezeEpisode"))
            OutlinedButton({ review("memory.freezeEpisode", buildJsonObject { put("sessionId", sessionId); put("id", id) }, "Freeze this episode") }, enabled = !busy) { Text("Freeze this episode") }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        done?.let { Text(it, color = MaterialTheme.colorScheme.primary) }; error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/** Saved facts are limited to 2,000 characters on the desktop; adding and editing use the same limit. */
internal const val MEMORY_FACT_LIMIT = 2000

@Composable
fun MobileMaintenanceSection() {
    val context = LocalContext.current; val scope = rememberCoroutineScope(); val power = context.getSystemService(PowerManager::class.java)
    val development = remember { dev.otectus.cere.mobile.data.ReleaseChannel.forPackage(context.packageName).development }
    var unrestricted by remember { mutableStateOf(power.isIgnoringBatteryOptimizations(context.packageName)) }
    var busy by remember { mutableStateOf(false) }; var status by remember { mutableStateOf<String?>(null) }; var release by remember { mutableStateOf<String?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) unrestricted = power.isIgnoringBatteryOptimizations(context.packageName) }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) }
    }
    suspend fun check() {
        busy = true; release = null
        runCatching { checkMobileRelease(context) }.onSuccess { release = it; status = if (it == null) "No newer compatible ${if (development) "development snapshot" else "mobile release"} found." else "A newer Cere Mobile ${if (development) "development snapshot" else "release"} is available." }.onFailure { status = "Update check unavailable. Chat is unaffected." }
        busy = false
    }
    LaunchedEffect(Unit) {
        val last = withContext(Dispatchers.IO) { context.getSharedPreferences("public-release-cache", android.content.Context.MODE_PRIVATE).getLong("lastCheck", 0) }
        if (System.currentTimeMillis() - last > TimeUnit.DAYS.toMillis(1)) check()
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Battery & updates", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        Text(if (unrestricted) "Battery optimization exemption is enabled. Delivery still needs an awake, reachable desktop." else "Battery optimization can delay approval notifications while the phone sleeps.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton({ context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); unrestricted = power.isIgnoringBatteryOptimizations(context.packageName) },
            modifier = Modifier.heightIn(min = CereLayout.target)) { Text("Open battery settings") }
        if (development) Text("This is a development build (${context.packageName}). It updates from development snapshots. A stable release installs as a separate app with its own pairing; keep this build until the stable app is paired.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton({ scope.launch { check() } }, enabled = !busy, modifier = Modifier.heightIn(min = CereLayout.target)) { Text(if (busy) "Checking…" else "Check for updates") }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
        status?.let { AncillaryFeedback(it) }
        release?.let { url -> Button({ context.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) },
            modifier = Modifier.heightIn(min = CereLayout.target)) { Text("Open GitHub release") } }
    }
}

/**
 * The update check itself is [dev.otectus.cere.mobile.data.ReleaseCheck]: this supplies its HTTP
 * requests (bounded bodies and timeouts, no token) and keeps its ETag cache in preferences.
 */
private suspend fun checkMobileRelease(context: android.content.Context): String? = withContext(Dispatchers.IO) {
    val preferences = context.getSharedPreferences("public-release-cache", android.content.Context.MODE_PRIVATE)
    preferences.edit().putLong("lastCheck", System.currentTimeMillis()).apply()
    val client = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS).build()
    val ownCode = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
    val cache = object : dev.otectus.cere.mobile.data.ReleaseCache {
        override fun body(page: Int) = preferences.getString("body-$page", null)
        override fun etag(page: Int) = preferences.getString("etag-$page", null)
        override fun store(page: Int, body: String, etag: String?) { preferences.edit().putString("body-$page", body).putString("etag-$page", etag).apply() }
    }
    dev.otectus.cere.mobile.data.ReleaseCheck(dev.otectus.cere.mobile.data.ReleaseChannel.forPackage(context.packageName), ownCode, android.os.Build.VERSION.SDK_INT, { url, etag ->
        val builder = Request.Builder().url(url).header("Accept", if (url.startsWith("https://api.github.com/")) "application/vnd.github+json" else "application/json")
        etag?.let { builder.header("If-None-Match", it) }
        client.newCall(builder.build()).execute().use { response ->
            // Release pages are bounded at 2 MiB, metadata at 8 KiB.
            val limit = if (url.startsWith("https://api.github.com/")) 2 * 1024 * 1024 else 8192
            dev.otectus.cere.mobile.data.HttpReply(response.code, if (response.isSuccessful) response.body?.byteStream()?.use { it.readBounded(limit) }?.toString(Charsets.UTF_8) else null, response.header("ETag"))
        }
    }, cache).newest()
}

private fun InputStream.readBounded(limit: Int): ByteArray {
    val result = ByteArrayOutputStream(); val buffer = ByteArray(8192)
    while (true) { val count = read(buffer); if (count < 0) break; check(result.size() + count <= limit) { "Update response exceeds limit" }; result.write(buffer, 0, count) }
    return result.toByteArray()
}
