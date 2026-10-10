@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.cere.mobile

import android.content.Intent
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.otectus.cere.mobile.data.CereRepository
import dev.otectus.cere.mobile.data.MobileState
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
import java.net.URI
import java.util.concurrent.TimeUnit
import java.io.InputStream
import java.io.ByteArrayOutputStream

/** source=null opens authorized native history; source!=null creates an editable handoff draft. */
@Composable
fun SessionTransferSheet(repository: CereRepository, state: MobileState, activity: FragmentActivity, source: Session?, onDismiss: () -> Unit, onCreated: (String) -> Unit) {
    var projectId by rememberSaveable(source?.id) { mutableStateOf(source?.projectId ?: state.projects.firstOrNull()?.id.orEmpty()) }
    val providers = state.providers.filter { (_, value) -> (value as? JsonObject)?.get("remoteExecution")?.jsonPrimitive?.booleanOrNull == true }.keys.toList()
    var provider by rememberSaveable(source?.id) { mutableStateOf(providers.firstOrNull().orEmpty()) }
    var model by rememberSaveable(source?.id) { mutableStateOf("") }; var models by remember { mutableStateOf(emptyList<ModelOption>()) }
    var preview by remember { mutableStateOf<JsonObject?>(null) }; var draft by rememberSaveable(source?.id) { mutableStateOf("") }
    var history by remember { mutableStateOf(emptyList<JsonObject>()) }; var historyId by rememberSaveable(source?.id) { mutableStateOf("") }
    var stopped by rememberSaveable(source?.id) { mutableStateOf(false) }; var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }
    val projectIds = state.projects.map(Project::id); val sessionIds = state.sessions.map(Session::id)
    LaunchedEffect(state.cacheEpoch) { preview = null; draft = ""; history = emptyList(); historyId = ""; stopped = false; error = null }
    LaunchedEffect(sessionIds) { if (source != null && source.id !in sessionIds) { preview = null; draft = ""; onDismiss() } }
    LaunchedEffect(projectIds) { if (projectId !in projectIds) projectId = projectIds.firstOrNull().orEmpty() }
    LaunchedEffect(source?.id, if (source == null) projectId else null, state.cacheEpoch) {
        busy = true; error = null
        runCatching {
            if (source != null) repository.request("sessions.handoffPreview", buildJsonObject { put("sessionId", source.id) }).jsonObject.let { preview = it; if (draft.isBlank()) draft = it.getValue("draft").jsonPrimitive.content }
            else repository.request("sessions.history", buildJsonObject { put("projectId", projectId) }).jsonObject.let { value -> history = value["items"]?.jsonArray.orEmpty().map { row -> row.jsonObject }; if (history.none { it["id"]?.jsonPrimitive?.contentOrNull == historyId }) historyId = "" }
        }.onFailure { error = it.message }; busy = false
    }
    LaunchedEffect(provider) {
        if (source != null && provider.isNotEmpty()) runCatching { repository.request("providers.models", buildJsonObject { put("provider", provider) }) }
            .onSuccess { models = WireCodec.json.decodeFromJsonElement<List<ModelOption>>(it); if (models.none { option -> option.id == model }) model = if (provider == "ollama") models.firstOrNull { option -> option.isDefault }?.id ?: models.firstOrNull()?.id.orEmpty() else "" }
            .onFailure { error = it.message }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text(if (source == null) "Desktop history" else "Hand off conversation") },
        text = { Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(if (source == null) "Import a stopped Codex thread from an approved project. Its historical transcript remains with the provider." else "Review the last eight conversation messages. This creates a draft; Send is a separate action.")
            source?.let { original -> val project = state.projects.firstOrNull { it.id == original.projectId }; Text("Source · ${project?.name ?: original.title}", fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold); Text(project?.path ?: original.project ?: "Path unavailable", style = MaterialTheme.typography.bodySmall); if (original.provider == "ollama") Text("Ollama · ${original.ollamaHost.ifBlank { state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable" }}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Text("Destination project"); FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { state.projects.forEach { project -> FilterChip(projectId == project.id, { projectId = project.id }, { Column { Text(project.name); Text(project.path ?: "Path unavailable", style = MaterialTheme.typography.labelSmall) } }) } }
            state.projects.firstOrNull { it.id == projectId }?.let { project -> SelectionContainer { Text(project.path ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) } }
            if (source != null) {
                Text("Provider"); FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { providers.forEach { value -> FilterChip(provider == value, { provider = value }, { Text(value) }) } }
                if (provider == "ollama") Text("Ollama destination · ${state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (provider != "ollama") FilterChip(model.isBlank(), { model = "" }, { Text("Provider default model") })
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { models.forEach { option -> FilterChip(model == option.id, { model = option.id }, { Text(option.displayName + if (option.cloud) " · Cloud" else "") }) } }
                if (preview?.get("shortened")?.jsonPrimitive?.booleanOrNull == true) Text("Some source text is shortened. Check and edit the draft before continuing.", color = MaterialTheme.colorScheme.tertiary)
                OutlinedTextField(draft, { draft = it.take(100000) }, label = { Text("Handoff draft") }, minLines = 5, maxLines = 12, modifier = Modifier.fillMaxWidth())
            } else {
                history.forEach { item -> FilterChip(historyId == item["id"]?.jsonPrimitive?.content, { historyId = item.getValue("id").jsonPrimitive.content }, { Text(item["title"]?.jsonPrimitive?.content ?: "Desktop thread") }) }
                if (!busy && history.isEmpty()) Text("No importable Codex threads in this project.")
                Row { Checkbox(stopped, { stopped = it }); Text("I stopped the external CLI writer. Cere may now manage this thread.") }
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth()); error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } },
        confirmButton = { Button(onClick = {
            busy = true; error = null
            val method = if (source == null) "sessions.import" else "sessions.handoffCreate"
            val params = buildJsonObject { if (source == null) { put("historyId", historyId); put("externalWriterStopped", true) } else { put("sourceSessionId", source.id); put("sourceDigest", preview!!.getValue("sourceDigest")); put("draft", draft); put("projectId", projectId); put("provider", provider); put("model", model); put("tools", false) } }
            signedReview(activity, repository, method, params, if (source == null) "Import this desktop thread" else "Create this handoff draft", { value -> busy = false; onCreated(value.jsonObject.getValue("id").jsonPrimitive.content) }, { error = it; busy = false }, projectId)
        }, enabled = !busy && projectId.isNotBlank() && if (source == null) stopped && historyId.isNotBlank() else preview != null && draft.isNotBlank() && provider.isNotBlank() && (provider != "ollama" || model.isNotBlank())) { Text(if (source == null) "Review & import" else "Create draft") } },
        dismissButton = { TextButton({ onDismiss() }, enabled = !busy) { Text("Cancel") } })
}

/** record=null previews clearing the selected project. Editing always uses a reviewed revision. */
@Composable
fun MemoryRecordSheet(repository: CereRepository, state: MobileState, activity: FragmentActivity, sessionId: String, record: JsonObject?, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val session = state.sessions.find { it.id == sessionId }; val project = state.projects.find { it.id == session?.projectId }
    val scope = rememberCoroutineScope(); val id = record?.get("id")?.jsonPrimitive?.contentOrNull
    var text by rememberSaveable(id) { mutableStateOf(record?.get("text")?.jsonPrimitive?.contentOrNull.orEmpty()) }
    var preview by remember { mutableStateOf<JsonObject?>(null) }; var confirmation by rememberSaveable(id) { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }; var busy by remember { mutableStateOf(false) }
    val revision = record?.get("revision")?.jsonPrimitive?.contentOrNull
    val editable = record?.get("kind")?.jsonPrimitive?.contentOrNull == "saved" || record?.get("type")?.jsonPrimitive?.contentOrNull == "saved"
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text(if (record == null) "Clear project memory" else "Memory record") }, text = {
        Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(project?.name ?: "Selected project", style = MaterialTheme.typography.titleMedium)
            SelectionContainer { Text(project?.path ?: session?.project ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) }
            Text("Ollama · ${session?.ollamaHost?.ifBlank { state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable" } ?: "host unavailable"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (record != null && text.isNotBlank()) OutlinedTextField(text, { if (editable) text = it.take(MEMORY_FACT_LIMIT) }, readOnly = !editable, minLines = 4, maxLines = 10, label = { Text(if (editable) "Saved fact" else "Memory content") },
                supportingText = { if (editable) Text("${text.length} / $MEMORY_FACT_LIMIT characters") }, modifier = Modifier.fillMaxWidth())
            if (record != null && text.isBlank()) Text("This graph record can be inspected on the desktop. Forget below removes it and dependent evidence in this project.")
            if (preview == null) OutlinedButton(onClick = { scope.launch { busy = true; runCatching { repository.request("memory.forgetPreview", buildJsonObject { put("sessionId", sessionId); id?.let { put("id", it) } }).jsonObject }.onSuccess { preview = it }.onFailure { error = it.message }; busy = false } }, enabled = !busy && state.supports("memory.forgetPreview")) { Text("Preview what will be forgotten") }
            preview?.let { value ->
                Text("${value["count"]?.jsonPrimitive?.content ?: "0"} records will be suppressed, including dependent evidence. Source occurrences may also be removed from saved conversations.", color = MaterialTheme.colorScheme.tertiary)
                OutlinedTextField(confirmation, { confirmation = it }, label = { Text("Type ${project?.name ?: "FORGET"} to confirm") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(onClick = {
                    busy = true
                    val method = if (record == null) "memory.clear" else "memory.forget"
                    val params = buildJsonObject { put("sessionId", sessionId); if (record == null) put("confirmProjectId", project!!.id) else put("id", id!!); put("selection", value.getValue("selection")); put("expectedRevision", value.getValue("revision")) }
                    signedReview(activity, repository, method, params, "Forget reviewed memory", { busy = false; onChanged(); onDismiss() }, { error = it; busy = false })
                }, enabled = !busy && project != null && confirmation == project.name && state.supports(if (record == null) "memory.clear" else "memory.forget"), colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(if (record == null) "Clear this project" else "Forget this record") }
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth()); error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { if (editable && id != null && text.isNotBlank() && revision != null && state.supports("memory.save")) Button({
        busy = true; signedReview(activity, repository, "memory.save", buildJsonObject { put("sessionId", sessionId); put("id", id); put("text", text); put("expectedRevision", revision) }, "Save this edited fact", { busy = false; onChanged(); onDismiss() }, { error = it; busy = false })
    }, enabled = !busy && preview == null) { Text("Review & save") } }, dismissButton = { TextButton(onDismiss, enabled = !busy) { Text("Close") } })
}

/** Saved facts are limited to 2,000 characters on the desktop; adding and editing use the same limit. */
internal const val MEMORY_FACT_LIMIT = 2000

@Composable
fun MobileMaintenanceSection() {
    val context = LocalContext.current; val scope = rememberCoroutineScope(); val power = context.getSystemService(PowerManager::class.java)
    val development = remember { ReleaseChannel.of(context).development }
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
        Text("Battery & updates", style = MaterialTheme.typography.titleLarge)
        Text(if (unrestricted) "Battery optimization exemption is enabled. Delivery still needs an awake, reachable desktop." else "Battery optimization can delay approval notifications while the phone sleeps.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton({ context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); unrestricted = power.isIgnoringBatteryOptimizations(context.packageName) }) { Text("Open battery settings") }
        if (development) Text("This is a development build (${context.packageName}). It updates from development snapshots. A stable release installs as a separate app with its own pairing; keep this build until the stable app is paired.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton({ scope.launch { check() } }, enabled = !busy) { Text(if (busy) "Checking…" else "Check for updates") }
        status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        release?.let { url -> Button({ context.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }) { Text("Open GitHub release") } }
    }
}

/**
 * Stable builds follow published `mobile-vX.Y.Z` releases. Development builds (the
 * `.debug` package) follow `mobile-dev-vX.Y.Z` snapshots, whose metadata must name this
 * exact package; a stable release never offers itself to a development install.
 */
private class ReleaseChannel private constructor(val development: Boolean, val packageId: String) {
    val tag = Regex(if (development) "^mobile-dev-v(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$" else "^mobile-v(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
    val metadata = if (development) "mobile-development.json" else "mobile-release.json"
    fun apkNames(version: String) = if (development) setOf("cere-mobile-v$version-dev.apk", "cere-mobile-v$version-debug.apk") else setOf("cere-mobile-v$version.apk")
    companion object { fun of(context: android.content.Context) = ReleaseChannel(context.packageName.endsWith(".debug"), context.packageName) }
}

private suspend fun checkMobileRelease(context: android.content.Context): String? = withContext(Dispatchers.IO) {
    val preferences = context.getSharedPreferences("public-release-cache", android.content.Context.MODE_PRIVATE)
    preferences.edit().putLong("lastCheck", System.currentTimeMillis()).apply()
    val channel = ReleaseChannel.of(context)
    val client = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS).build()
    val ownCode = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
    val candidates = mutableListOf<Triple<Long, String, String>>()
    for (page in 1..10) {
        val builder = Request.Builder().url("https://api.github.com/repos/otectus/Cere/releases?per_page=50&page=$page").header("Accept", "application/vnd.github+json")
        preferences.getString("etag-$page", null)?.let { builder.header("If-None-Match", it) }
        val body = client.newCall(builder.build()).execute().use { response ->
            if (response.code == 304) preferences.getString("body-$page", null) ?: error("Missing update cache")
            else { check(response.isSuccessful); val bytes = response.body?.byteStream()?.use { it.readBounded(2 * 1024 * 1024) } ?: error("Missing update response"); bytes.toString(Charsets.UTF_8).also { value -> preferences.edit().putString("body-$page", value).putString("etag-$page", response.header("ETag")).apply() } }
        }
        val releases = WireCodec.json.parseToJsonElement(body).jsonArray
        for (entry in releases) {
            val value = entry.jsonObject
            if (value["draft"]?.jsonPrimitive?.booleanOrNull != false) continue
            // Stable builds ignore prereleases; development snapshots are published as prereleases.
            if (!channel.development && value["prerelease"]?.jsonPrimitive?.booleanOrNull != false) continue
            val tag = value["tag_name"]?.jsonPrimitive?.contentOrNull ?: continue
            val match = channel.tag.matchEntire(tag) ?: continue
            val (major, minor, patch) = match.destructured; val code = major.toLong() * 1000000 + minor.toLong() * 1000 + patch.toLong()
            val assets = value["assets"]?.jsonArray.orEmpty().mapNotNull { it.jsonObject["name"]?.jsonPrimitive?.contentOrNull }.toSet()
            if (assets.none { it in channel.apkNames("$major.$minor.$patch") } || channel.metadata !in assets) continue
            val url = value["html_url"]?.jsonPrimitive?.contentOrNull ?: continue; val parsed = URI(url)
            if (parsed.scheme != "https" || parsed.host != "github.com" || parsed.path != "/otectus/Cere/releases/tag/$tag") continue
            if (code > ownCode) candidates.add(Triple(code, tag, url))
        }
        if (releases.size < 50) break
    }
    // Release metadata is read from this repository only. This check never downloads or installs an APK.
    for ((code, tag, url) in candidates.sortedByDescending { it.first }.take(10)) {
        val metadata = client.newCall(Request.Builder().url("https://github.com/otectus/Cere/releases/download/$tag/${channel.metadata}").build()).execute().use { response ->
            check(response.isSuccessful)
            WireCodec.json.parseToJsonElement(response.body!!.byteStream().use { it.readBounded(8192) }.toString(Charsets.UTF_8)).jsonObject
        }
        val version = channel.tag.matchEntire(tag)!!.destructured.let { (major, minor, patch) -> "$major.$minor.$patch" }
        val protocol = metadata["protocol"] as? JsonObject ?: continue
        if (metadata["packageId"]?.jsonPrimitive?.contentOrNull != channel.packageId || metadata["versionCode"]?.jsonPrimitive?.longOrNull != code || metadata["versionName"]?.jsonPrimitive?.contentOrNull != version) continue
        if (channel.development && metadata["development"]?.jsonPrimitive?.booleanOrNull != true) continue
        if ((metadata["minSdk"]?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE) > android.os.Build.VERSION.SDK_INT || protocol["major"]?.jsonPrimitive?.intOrNull != 1 || (protocol["minMinor"]?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE) > 0 || (protocol["maxMinor"]?.jsonPrimitive?.intOrNull ?: -1) < 0) continue
        val apk = metadata["apk"] as? JsonObject ?: continue
        if (apk["name"]?.jsonPrimitive?.contentOrNull !in channel.apkNames(version) || apk["sha256"]?.jsonPrimitive?.contentOrNull?.matches(Regex("[a-fA-F0-9]{64}")) != true) continue
        return@withContext url
    }
    null
}

private fun InputStream.readBounded(limit: Int): ByteArray {
    val result = ByteArrayOutputStream(); val buffer = ByteArray(8192)
    while (true) { val count = read(buffer); if (count < 0) break; check(result.size() + count <= limit) { "Update response exceeds limit" }; result.write(buffer, 0, count) }
    return result.toByteArray()
}
