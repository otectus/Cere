@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.cere.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import dev.otectus.cere.mobile.data.CereRepository
import dev.otectus.cere.mobile.data.ConnectionState
import dev.otectus.cere.mobile.data.MobileState
import dev.otectus.cere.mobile.protocol.Project
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.flag(key: String) = (this[key] as? JsonPrimitive)?.booleanOrNull == true

/**
 * Desktop controls for one approved project. Each list loads on its own, so a category
 * that is off on the desktop hides only its own section. Every action names the desktop
 * and project it runs on and is signed like any other desktop action.
 */
@Composable
internal fun DesktopScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity) {
    val scope = rememberCoroutineScope()
    var projectId by rememberSaveable { mutableStateOf(state.projects.firstOrNull()?.id.orEmpty()) }
    var status by remember { mutableStateOf<JsonObject?>(null) }
    var apps by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var windows by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var sectionErrors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var loading by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var volume by remember { mutableStateOf<Float?>(null) }
    var moving by remember { mutableStateOf<JsonObject?>(null) }
    var reviewingScript by remember { mutableStateOf<JsonObject?>(null) }
    var workspace by rememberSaveable { mutableStateOf("") }
    var timerMinutes by rememberSaveable { mutableStateOf("10") }
    var timerLabel by rememberSaveable { mutableStateOf("") }
    var filePath by rememberSaveable { mutableStateOf("") }
    var workspaceCard by remember { mutableStateOf<JsonObject?>(null) }
    val project = state.projects.firstOrNull { it.id == projectId }
    val actions = status?.get("actions")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }
    val actionNames = actions.mapNotNull { it.text("name") }.toSet()
    val categories = actions.mapNotNull { it.text("category") }.toSet()

    fun refresh() {
        if (projectId.isBlank()) return
        scope.launch {
            loading = true; error = null
            val errors = mutableMapOf<String, String>()
            suspend fun load(section: String, method: String, apply: (JsonElement) -> Unit) {
                try { apply(repository.read(method, buildJsonObject { put("projectId", projectId) })) }
                catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { errors[section] = failure.message ?: "Could not load" }
            }
            if (state.supports("desktop.status")) load("status", "desktop.status") { status = it.jsonObject; volume = null }
            if (state.supports("desktop.workspace")) load("workspace", "desktop.workspace") { workspaceCard = it.jsonObject }
            val loaded = status?.get("actions")?.jsonArray.orEmpty().mapNotNull { (it as? JsonObject)?.text("category") }.toSet()
            if ("apps" in loaded && state.supports("desktop.apps")) load("apps", "desktop.apps") { apps = it.jsonArray.mapNotNull { row -> row as? JsonObject } } else apps = emptyList()
            if ("windows" in loaded && state.supports("desktop.windows")) load("windows", "desktop.windows") { windows = it.jsonArray.mapNotNull { row -> row as? JsonObject } } else windows = emptyList()
            sectionErrors = errors; loading = false
        }
    }
    fun execute(name: String, args: JsonObject, label: String, definitionDigest: String? = null) {
        feedback = null; error = null
        val params = buildJsonObject { put("projectId", projectId); put("action", name); put("args", args); definitionDigest?.let { put("definitionDigest", it) } }
        val cue = project?.path ?: project?.name ?: "approved project"
        signedReview(activity, repository, "desktop.execute", params, "$label · $cue", { feedback = "$label · done"; refresh() }, { error = it }, projectId, label)
    }

    val projectIds = state.projects.map(Project::id)
    LaunchedEffect(state.cacheEpoch, projectIds) {
        if (projectId !in projectIds) projectId = projectIds.firstOrNull().orEmpty()
    }
    LaunchedEffect(projectId, state.cacheEpoch, state.connection is ConnectionState.Online) {
        status = null; apps = emptyList(); windows = emptyList(); sectionErrors = emptyMap(); feedback = null; error = null
        if (filePath.isBlank() || state.projects.none { filePath.startsWith(it.path.orEmpty()) }) filePath = project?.path.orEmpty()
        if (state.connection is ConnectionState.Online) refresh()
    }
    // A timer that fires leaves the list; refresh when the desktop announces it.
    LaunchedEffect(projectId) { repository.notices.collect { if (it.kind == "timer" && it.projectId == projectId) refresh() } }
    if (!state.supports("desktop.status")) return DesktopEmptyState("Desktop controls are not granted", "On the desktop, grant this phone Desktop control and the categories you want in Settings → Cere Mobile.")

    val filter = query.trim()
    fun matches(vararg values: String?) = filter.isBlank() || values.any { it.orEmpty().contains(filter, true) }
    val audio = status?.get("audio") as? JsonObject; val media = status?.get("media") as? JsonObject
    val timers = status?.get("timers")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }
    val scripts = status?.get("scripts")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }.filter { matches(it.text("name"), it.text("executable")) }
    val shownWindows = windows.filter { matches(it.text("title"), it.text("app")) }
    val shownApps = apps.filter { matches(it.text("name")) }
    val formatter = remember { DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()) }

    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text("Desktop", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() }); Text("Everyday controls, close at hand.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            OutlinedButton(::refresh, enabled = !loading && state.connection is ConnectionState.Online) { Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(6.dp)); Text(if (loading) "Loading" else "Refresh") }
        } }
        item { FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { state.projects.forEach { option -> FilterChip(projectId == option.id, { projectId = option.id }, { Column { Text(option.name); Text(option.path ?: "Path unavailable", style = MaterialTheme.typography.labelSmall) } }) } } }
        project?.let { selected -> item { Panel("Action scope") { Text(state.desktop?.desktopName ?: "Paired desktop", color = MaterialTheme.colorScheme.primary); SelectionContainer { Text(selected.path ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) } } } }
        // F80: whether the desktop is working in this project now, from fresh observations only.
        workspaceCard?.let { card -> item { Panel("Desktop workspace") {
            val unknown = card["unknown"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull?.replace('_', ' ') }
            Text(when (card.text("state")) {
                "in-project" -> "Working in this project now · ${card.text("relativePath") ?: "."}" + if (card.flag("verifiedCheckout")) " · verified checkout" else ""
                "elsewhere" -> "Working outside this project right now."
                "unknown" -> "Not known right now" + if (unknown.isNotEmpty()) ": no fresh ${unknown.joinToString(", ")}." else "."
                else -> card.text("reason") ?: "Workspace awareness is unavailable on the desktop."
            })
        } } }
        // W10: features that need a program the desktop does not have; chat is not affected.
        status?.get("missing")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }.takeIf { it.isNotEmpty() }?.let { missing -> item { Panel("Unavailable on the desktop") {
            missing.forEach { Text("${it.text("feature") ?: ""} needs ${it.text("name") ?: "a program"} installed on the desktop.", style = MaterialTheme.typography.bodySmall) }
        } } }
        item { OutlinedTextField(query, { query = it }, leadingIcon = { Icon(Icons.Default.Search, null) }, placeholder = { Text("Search apps, windows or scripts") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
        feedback?.let { item { Surface(color = MaterialTheme.colorScheme.primaryContainer, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline), shape = RoundedCornerShape(8.dp)) { Text(it, Modifier.padding(12.dp)) } } }
        error?.let { item { Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(8.dp)) { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) } } }
        sectionErrors["status"]?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        if (status != null && categories.isEmpty()) item { Text("No desktop control categories are enabled for this project. Enable them on the desktop in Settings.", color = MaterialTheme.colorScheme.onSurfaceVariant) }

        if (audio?.flag("available") == true) item { Panel("Sound") {
            val level = volume ?: (audio.text("percent")?.toFloatOrNull() ?: 0f)
            Text("Volume ${level.toInt()}%${if (audio.flag("muted")) " · Muted" else ""}", color = MaterialTheme.colorScheme.primary)
            // The volume is sent once, when the finger lifts, as one signed action.
            Slider(level, { volume = it }, valueRange = 0f..100f, steps = 19, enabled = "audio.volume" in actionNames,
                onValueChangeFinished = { val percent = (volume ?: level).toInt(); execute("audio.volume", buildJsonObject { put("percent", percent) }, "Set desktop volume to $percent%") })
            OutlinedButton({ execute("audio.mute", buildJsonObject {}, if (audio.flag("muted")) "Unmute desktop sound" else "Mute desktop sound") }, enabled = "audio.mute" in actionNames) { Text(if (audio.flag("muted")) "Unmute" else "Mute") }
        } }
        if (media?.flag("available") == true) item { Panel("Playback") {
            Text(listOfNotNull(media.text("name"), media.text("status")).joinToString(" · "), color = MaterialTheme.colorScheme.primary)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(Triple("Previous", "Previous", "canPrevious"), Triple("PlayPause", if (media.text("status") == "Playing") "Pause" else "Play", "canPlayPause"), Triple("Next", "Next", "canNext"), Triple("Stop", "Stop", "canStop")).forEach { (command, label, capability) ->
                    OutlinedButton({ execute("media.control", buildJsonObject { put("command", command); media.text("player")?.let { put("player", it) } }, "$label on ${media.text("name") ?: "the desktop player"}") },
                        enabled = "media.control" in actionNames && media.flag(capability)) { Text(label) }
                }
            }
        } }

        if (status?.flag("capture") == true && state.supports("captures.start") && project != null) item { CapturePanel(repository, state, activity, project) }
        if ("timers" in categories) item { Panel("Timers") {
            if (timers.isEmpty()) Text("No timers set from this phone in this project.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            timers.forEach { timer -> Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text(timer.text("label") ?: "Timer"); Text("Due ${timer.text("due")?.toLongOrNull()?.let { formatter.format(Instant.ofEpochMilli(it)) } ?: "soon"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                TextButton({ signedReview(activity, repository, "timers.cancel", buildJsonObject { put("projectId", projectId); put("timerId", timer.text("id").orEmpty()) }, "Cancel timer ${timer.text("label") ?: ""}", { feedback = "Timer cancelled"; refresh() }, { error = it }, projectId, timer.text("label")) }, enabled = state.supports("timers.cancel")) { Text("Cancel") }
            } }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(timerMinutes, { timerMinutes = it.filter(Char::isDigit).take(5) }, label = { Text("Minutes") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(110.dp))
                OutlinedTextField(timerLabel, { timerLabel = it.take(200) }, label = { Text("Label") }, singleLine = true, modifier = Modifier.weight(1f))
            }
            val minutes = timerMinutes.toIntOrNull()
            Button({ execute("timer.start", buildJsonObject { put("minutes", minutes ?: 0); put("label", timerLabel.ifBlank { "Timer" }) }, "Start a $minutes-minute desktop timer") }, enabled = "timer.start" in actionNames && minutes != null && minutes in 1..10080) { Text("Start timer") }
        } }

        if ("scripts" in categories) item { Panel("Saved scripts") {
            if (scripts.isEmpty()) Text("No saved scripts are granted to this phone.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            scripts.forEach { script -> Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text(script.text("name") ?: script.text("id") ?: "Script", fontWeight = FontWeight.Medium); Text(script.text("executable").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                OutlinedButton({ reviewingScript = script }, enabled = "script.run" in actionNames) { Text("Review & run") }
            } }
        } }

        if ("windows" in categories) {
            item { Text("Windows", style = MaterialTheme.typography.titleMedium) }
            sectionErrors["windows"]?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            item { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(workspace, { workspace = it.filter(Char::isDigit).take(2) }, label = { Text("Workspace") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(130.dp))
                val number = workspace.toIntOrNull()
                OutlinedButton({ execute("workspace.switch", buildJsonObject { put("workspace", number ?: 0) }, "Switch to workspace $number") }, enabled = "workspace.switch" in actionNames && number != null && number in 1..99) { Text("Switch workspace") }
            } }
            if (shownWindows.isEmpty() && sectionErrors["windows"] == null) item { Text("No windows to show.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(shownWindows.take(40)) { window -> Panel(window.text("title") ?: "Untitled") {
                Text("${window.text("app").orEmpty()} · Workspace ${window.text("workspace").orEmpty()}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton({ execute("windows.focus", buildJsonObject { put("address", window.text("address").orEmpty()) }, "Focus ${window.text("title") ?: "window"}") }, enabled = "windows.focus" in actionNames) { Text("Focus") }
                    OutlinedButton({ moving = window }, enabled = "windows.move" in actionNames) { Text("Move…") }
                }
            } }
        }

        if ("apps" in categories) {
            item { Text("Applications", style = MaterialTheme.typography.titleMedium) }
            sectionErrors["apps"]?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (shownApps.isEmpty() && sectionErrors["apps"] == null) item { Text("No applications to show.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(shownApps.take(40)) { app -> Panel(app.text("name") ?: "Application") {
                OutlinedButton({ execute("apps.launch", buildJsonObject { put("desktopId", app.text("id").orEmpty()) }, "Open ${app.text("name").orEmpty()}") }, enabled = "apps.launch" in actionNames) { Text("Open on desktop") }
            } }
        }

        if ("files" in categories) item { Panel("Open a file or folder") {
            Text("Opens on the desktop in its default app. Paths must be inside this project.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(filePath, { filePath = it.take(4096) }, label = { Text("Path on the desktop") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            val inside = project?.path?.let { root -> filePath == root || filePath.startsWith("$root/") } == true
            Button({ execute("files.open", buildJsonObject { put("path", filePath.trim()) }, "Open ${filePath.substringAfterLast('/')}") }, enabled = "files.open" in actionNames && inside) { Text("Open on desktop") }
        } }
    }

    moving?.let { window ->
        var target by rememberSaveable(window.text("address")) { mutableStateOf("") }
        val number = target.toIntOrNull()
        AlertDialog(onDismissRequest = { moving = null }, title = { Text("Move window") }, text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(window.text("title") ?: "Untitled", fontWeight = FontWeight.Medium)
            Text("Currently on workspace ${window.text("workspace").orEmpty()}. The desktop stays on its current workspace.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(target, { target = it.filter(Char::isDigit).take(2) }, label = { Text("Destination workspace (1–99)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        } }, confirmButton = { Button({ moving = null; execute("windows.move", buildJsonObject { put("address", window.text("address").orEmpty()); put("workspace", number ?: 0) }, "Move ${window.text("title") ?: "window"} to workspace $number") }, enabled = number != null && number in 1..99) { Text("Review & move") } },
            dismissButton = { TextButton({ moving = null }) { Text("Cancel") } })
    }
    reviewingScript?.let { script ->
        AlertDialog(onDismissRequest = { reviewingScript = null }, title = { Text("Run saved script?") }, text = { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(script.text("name") ?: "Script", fontWeight = FontWeight.SemiBold)
            SelectionContainer { Text(listOf(script.text("executable").orEmpty(), *script["args"]?.jsonArray.orEmpty().map { (it as? JsonPrimitive)?.contentOrNull.orEmpty() }.toTypedArray()).joinToString(" "), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
            Text("Folder · ${script.text("cwd").orEmpty()}", style = MaterialTheme.typography.bodySmall)
            Text("Time limit · ${(script.text("timeout")?.toLongOrNull() ?: 0) / 1000} s", style = MaterialTheme.typography.bodySmall)
            Text("Runs exactly this saved definition on ${state.desktop?.desktopName ?: "the desktop"}. If it changed on the desktop, the run is refused.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } }, confirmButton = { Button({ reviewingScript = null; execute("script.run", buildJsonObject { put("id", script.text("id").orEmpty()) }, "Run ${script.text("name") ?: "script"}", script.text("definitionDigest")) }) { Text("Run") } },
            dismissButton = { TextButton({ reviewingScript = null }) { Text("Cancel") } })
    }
}

@Composable private fun Panel(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline), shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(title, fontWeight = FontWeight.SemiBold); content() }
    }
}

@Composable private fun DesktopEmptyState(title: String, detail: String) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(Icons.Default.Lock, null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(48.dp)); Spacer(Modifier.height(14.dp))
        Text(title, style = MaterialTheme.typography.titleLarge); Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * W10: capture the desktop's focused display from the phone. The capture is an accepted job on the
 * desktop; with editing, Satty opens there and waits for whoever is at the desktop. The phone shows
 * the exact image it will share (a reduced copy bound to the original's digest), and nothing goes to
 * a conversation until it is attached here and sent from that conversation.
 */
@Composable
private fun CapturePanel(repository: CereRepository, state: MobileState, activity: FragmentActivity, project: Project) {
    val scope = rememberCoroutineScope()
    val captures by repository.captures.collectAsState()
    val latest = captures.values.firstOrNull { it.text("projectId") == project.id }
    val captureId = latest?.text("captureId"); val captureState = latest?.text("state")
    var preview by remember(captureId) { mutableStateOf<dev.otectus.cere.mobile.data.ApprovalPreview?>(null) }
    var bitmap by remember(captureId) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }
    var target by rememberSaveable(captureId) { mutableStateOf<String?>(null) }
    val targets = state.sessions.filter { it.projectId == project.id && it.canSend && it.mode == "managed" }
    // Satty may stay open for minutes: the phone checks in while it waits, as well as hearing events.
    LaunchedEffect(captureId, captureState) {
        if (captureId != null && captureState in setOf("capturing", "editing")) { kotlinx.coroutines.delay(3_000); runCatching { repository.captureStatus(captureId) } }
        if (captureId != null && captureState == "ready" && preview == null && state.supports("captures.preview")) runCatching { repository.capturePreview(captureId) }
            .onSuccess { value -> preview = value; bitmap = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { decodeForDisplay(value.bytes, 2048) } }.onFailure { error = it.message }
    }
    fun start(edit: Boolean) { busy = true; error = null
        signedReview(activity, repository, "captures.start", buildJsonObject { put("projectId", project.id); put("edit", edit) }, if (edit) "Capture and edit on the desktop" else "Capture the desktop display",
            { result -> repository.captureStarted(result); busy = false }, { error = it; busy = false }, boundProjectId = project.id) }
    Panel("Screen capture") {
        Text("Captures the desktop's focused display. Nothing is shared with a conversation until you attach it and send.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button({ start(false) }, enabled = !busy && captureState !in setOf("capturing", "editing")) { Text("Capture now") }
            OutlinedButton({ start(true) }, enabled = !busy && captureState !in setOf("capturing", "editing")) { Text("Capture and edit on the desktop") }
        }
        latest?.let { capture ->
            Text(when (captureState) {
                "capturing" -> "Capturing…"; "editing" -> "Waiting for the capture to be saved in Satty on the desktop…"
                "ready" -> "Ready to review"; "attached" -> "Attached to a conversation draft. Send it from that conversation."
                else -> capture.text("message") ?: (captureState ?: "")
            }, color = if (captureState in setOf("failed", "expired")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            bitmap?.let { androidx.compose.foundation.Image(it.asImageBitmap(), "The exact capture that will be attached", Modifier.fillMaxWidth().heightIn(max = 360.dp)) }
            if (captureState == "ready" && preview != null && state.supports("captures.attach")) {
                Text("Attach to", fontWeight = FontWeight.Medium)
                if (targets.isEmpty()) Text("No conversation in this project can send from this phone.", style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { targets.forEach { session -> FilterChip(target == session.id, { target = session.id }, { Text(session.title, maxLines = 1) }) } }
                Button({ val chosen = target ?: return@Button; val reviewed = preview ?: return@Button; busy = true; error = null
                    signedReview(activity, repository, "captures.attach", buildJsonObject { put("captureId", captureId!!); put("sessionId", chosen); put("imageDigest", reviewed.imageDigest) }, "Attach this capture",
                        { result -> scope.launch { runCatching { repository.adoptCapture(chosen, result.jsonObject, reviewed) }.onFailure { error = it.message }; captureId?.let { runCatching { repository.captureStatus(it) } }; busy = false } }, { error = it; busy = false }, boundProjectId = project.id)
                }, enabled = !busy && target != null) { Text("Review & attach") }
            }
            if (captureId != null && captureState in setOf("capturing", "editing", "ready")) TextButton({ scope.launch { busy = true; runCatching { repository.discardCapture(captureId) }.onFailure { error = it.message }; busy = false } }, enabled = !busy) { Text(if (captureState == "ready") "Discard" else "Cancel") }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}
