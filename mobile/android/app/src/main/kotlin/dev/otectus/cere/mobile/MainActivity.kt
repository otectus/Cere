package dev.otectus.cere.mobile

import android.Manifest
import android.content.*
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.otectus.cere.mobile.data.*
import dev.otectus.cere.mobile.protocol.*
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

open class MainActivity : FragmentActivity() {
    private val sharedImage = mutableStateOf<android.net.Uri?>(null)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sharedImage.value = sharedUri(intent)
        setContent { CereTheme { CereRoot((application as CereApp).repository, this, false, sharedImage.value, { sharedImage.value = null }) } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); sharedImage.value = sharedUri(intent) }
    private fun sharedUri(intent: Intent?): android.net.Uri? = if (intent?.action == Intent.ACTION_SEND && intent.type?.startsWith("image/") == true) {
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, android.net.Uri::class.java)
        else @Suppress("DEPRECATION") (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? android.net.Uri)
    } else null
}

class ReviewActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CereTheme { CereRoot((application as CereApp).repository, this, true, null) {} } }
    }
}

private enum class Destination(val label: String) { Chat("Chat"), Sessions("Sessions"), Inbox("Inbox"), Desktop("Desktop"), Settings("Settings") }
private val primaryDestinations = listOf(Destination.Chat, Destination.Sessions, Destination.Desktop, Destination.Settings)

@Composable
private fun CereRoot(repository: CereRepository, activity: FragmentActivity, openInbox: Boolean, sharedImage: android.net.Uri?, consumeShare: () -> Unit) {
    val state by repository.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.restoreReady, state.desktop?.deviceId) {
        if (state.restoreReady && state.desktop != null) repository.connectWhileOpen()
    }
    when {
        !state.restoreReady && state.connection !is ConnectionState.Blocked -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        state.desktop == null && state.connection is ConnectionState.Blocked -> Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) { Icon(Icons.Default.Lock, null, modifier = Modifier.size(48.dp)); Spacer(Modifier.height(14.dp)); Text("Unlock private cache", style = MaterialTheme.typography.titleLarge); Text((state.connection as ConnectionState.Blocked).reason, color = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.height(16.dp)); Button(repository::retry) { Text("Retry") } }
        state.desktop == null -> PairingScreen(repository, state, activity)
        state.connection is ConnectionState.Blocked -> Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Icon(Icons.Default.Lock, null, modifier = Modifier.size(48.dp)); Spacer(Modifier.height(14.dp))
            Text("Pairing needs attention", style = MaterialTheme.typography.titleLarge)
            Text((state.connection as ConnectionState.Blocked).reason, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(16.dp)); Button(repository::retry) { Text("Retry") }
            TextButton(onClick = { activity.lifecycleScope.launch { repository.forget() } }) { Text("Remove phone pairing and pair again") }
        }
        else -> AppShell(repository, state, activity, openInbox, sharedImage, consumeShare)
    }
}

@Composable
private fun PairingScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity) {
    val scope = rememberCoroutineScope()
    var raw by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var scan by rememberSaveable { mutableStateOf(false) }
    var resultJson by rememberSaveable { mutableStateOf<String?>(null) }
    val result = resultJson?.let { runCatching { WireCodec.json.decodeFromString(CompletedPairing.serializer(), it) }.getOrNull() }
    var deviceName by rememberSaveable { mutableStateOf(Build.MODEL.take(48).ifBlank { "Android phone" }) }
    var pendingCompletion by remember { mutableStateOf<CompletedPairing?>(null) }
    LaunchedEffect(state.restoreReady, state.desktop?.deviceId, result?.desktop?.deviceId) {
        repository.pairingManager().pruneUncommitted(state.restoreReady, state.desktop, result?.desktop)
    }
    fun finishPairing(completed: CompletedPairing) { scope.launch { runCatching { repository.completePairing(completed); ContextCompat.startForegroundService(activity, Intent(activity, MonitoringService::class.java)) }.onFailure { repository.pairingManager().delete(completed.desktop); resultJson = null; error = it.message } } }
    val localNetworkPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) pendingCompletion?.let(::finishPairing).also { pendingCompletion = null } else error = "Local network permission is required to connect to Cere Desktop." }
    val clipboard = LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)

    fun prepare(value: String) {
        var created: PendingPairing? = null
        runCatching {
            val offer = repository.pairingManager().parseAndVerify(value.trim())
            val pending = repository.pairingManager().prepare(offer, deviceName.trim())
            created = pending
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(auth: BiometricPrompt.AuthenticationResult) {
                    runCatching {
                        val signature = auth.cryptoObject?.signature ?: error("Authentication signature unavailable")
                        signature.update(pending.transcript)
                        repository.pairingManager().complete(pending, signature.sign())
                    }.onSuccess { completed -> created = null; resultJson = WireCodec.json.encodeToString(CompletedPairing.serializer(), completed) }.onFailure { repository.pairingManager().cancel(pending); created = null; error = it.message }
                }
                override fun onAuthenticationError(code: Int, message: CharSequence) { repository.pairingManager().cancel(pending); created = null; error = message.toString() }
            })
            prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Create Cere action key")
                .setSubtitle("This key will protect approvals and sensitive changes")
                .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG or androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build(), BiometricPrompt.CryptoObject(pending.actionSignature))
        }.onFailure { created?.let(repository.pairingManager()::cancel); created = null; error = it.message }
    }

    if (scan) {
        ScannerScreen(onResult = { scan = false; raw = it; prepare(it) }, onBack = { scan = false })
        return
    }
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 42.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Image(painterResource(R.drawable.cere_face_icon), "Cere", modifier = Modifier.size(76.dp))
            Text("Connect to Cere", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            Text("Pair offline with the offer shown in Desktop Settings. Cere will not contact the desktop until you copy the signed response back and confirm the six words.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(deviceName, { deviceName = it.take(48) }, label = { Text("This phone") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(raw, { raw = it }, label = { Text("Pairing offer") }, placeholder = { Text("Paste cere-pair://v1/…") }, minLines = 4, maxLines = 6, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { prepare(raw) }, enabled = raw.isNotBlank() && result == null) { Icon(Icons.Default.Share, null); Spacer(Modifier.width(8.dp)); Text("Verify offer") }
                OutlinedButton(onClick = { scan = true }) { Icon(Icons.Default.Create, null); Spacer(Modifier.width(8.dp)); Text("Scan") }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            result?.let { completed ->
                HorizontalDivider()
                Text("Compare on both screens", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                Text(completed.sas, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.secondary)
                Text("Copy this public signed response into Desktop Settings. Confirm only if the six words match.")
                PairingQrCode(completed.responseUri, Modifier.align(Alignment.CenterHorizontally))
                SelectionContainer { Text(completed.responseUri, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                Button(onClick = {
                    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Cere pairing response", completed.responseUri))
                }) { Icon(Icons.Default.Share, null); Spacer(Modifier.width(8.dp)); Text("Copy response") }
                Button(onClick = { if (Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(activity, "android.permission.ACCESS_LOCAL_NETWORK") != android.content.pm.PackageManager.PERMISSION_GRANTED) { pendingCompletion = completed; localNetworkPermission.launch("android.permission.ACCESS_LOCAL_NETWORK") } else finishPairing(completed) }, modifier = Modifier.fillMaxWidth()) { Text("Desktop confirmed") }
                TextButton(onClick = { repository.pairingManager().delete(completed.desktop); resultJson = null; pendingCompletion = null }) { Text("Cancel pairing") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppShell(repository: CereRepository, state: MobileState, activity: FragmentActivity, openInbox: Boolean, sharedImage: android.net.Uri?, consumeShare: () -> Unit) {
    val scope = rememberCoroutineScope()
    var destinationName by rememberSaveable { mutableStateOf(if (openInbox) Destination.Inbox.name else Destination.Sessions.name) }
    val destination = Destination.valueOf(destinationName)
    var selectedSession by rememberSaveable { mutableStateOf(state.selectedSessionId) }
    LaunchedEffect(state.selectedSessionId, state.sessions) { if (selectedSession != null && state.sessions.none { it.id == selectedSession }) selectedSession = null }
    LaunchedEffect(sharedImage) { sharedImage?.let { uri -> val target = selectedSession ?: state.selectedSessionId ?: state.sessions.firstOrNull()?.id; if (target != null) { runCatching { repository.importImage(target, uri) }; selectedSession = target; repository.selectSession(target); consumeShare() } } }
    BackHandler(enabled = selectedSession != null) { selectedSession = null; scope.launch { repository.selectSession(null) } }
    val connectionText = when (val connection = state.connection) {
        is ConnectionState.Online -> "Online"
        is ConnectionState.Offline -> "Offline · desktop unreachable"
        is ConnectionState.Blocked -> "Action required · ${connection.reason}"
        ConnectionState.Authenticating -> "Signing in"
        ConnectionState.Connecting -> "Connecting"
        ConnectionState.Unpaired -> "Unpaired"
    }
    Scaffold(
        topBar = { TopAppBar(
            title = { if (selectedSession != null) {
                val selected = state.sessions.find { it.id == selectedSession }
                val pending = state.approvals.count { it.sessionId == selectedSession }
                Column { Text(selected?.title ?: "Chat", maxLines = 1, overflow = TextOverflow.Ellipsis); Text(selected?.let { sessionDisplayStatus(it, pending) } ?: connectionText, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, color = if (state.connection is ConnectionState.Online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary) }
            } else Row(verticalAlignment = Alignment.CenterVertically) { Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.primaryContainer, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.size(44.dp)) { Image(painterResource(R.drawable.cere_face_icon), "Cere", Modifier.padding(2.dp)) }; Spacer(Modifier.width(12.dp)); Column { Row(verticalAlignment = Alignment.CenterVertically) { Text("C E R E", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge); Spacer(Modifier.width(8.dp)); Surface(color = if (state.connection is ConnectionState.Online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary, shape = RoundedCornerShape(50), modifier = Modifier.size(7.dp)) {} }; Text(if (state.approvals.isNotEmpty()) "${state.approvals.size} waiting for your input" else connectionText, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } },
            navigationIcon = { if (selectedSession != null) IconButton(onClick = { selectedSession = null; scope.launch { repository.selectSession(null) } }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            actions = {
                BadgedBox(badge = { if (state.approvals.isNotEmpty()) Badge { Text(state.approvals.size.toString()) } }) {
                    IconButton(onClick = { selectedSession = null; destinationName = Destination.Inbox.name; scope.launch { repository.selectSession(null) } }) { Icon(Icons.Default.Email, "Inbox") }
                }
                if (state.connection is ConnectionState.Offline) IconButton(repository::retry) { Icon(Icons.Default.Refresh, "Retry") }
            },
        ) },
        bottomBar = { if (selectedSession == null) NavigationBar { primaryDestinations.forEach { item -> NavigationBarItem(selected = destination == item, onClick = {
            destinationName = item.name
            if (item == Destination.Chat) (state.selectedSessionId ?: state.sessions.firstOrNull()?.id)?.let { id -> selectedSession = id; scope.launch { repository.selectSession(id) } }
        }, icon = { Icon(when(item) { Destination.Chat -> Icons.Default.Email; Destination.Sessions -> Icons.Default.List; Destination.Desktop -> Icons.Default.Home; Destination.Settings -> Icons.Default.Settings; Destination.Inbox -> Icons.Default.Email }, null) }, label = { Text(item.label) }) } } },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            if (selectedSession != null) ChatScreen(repository, state, state.sessions.find { it.id == selectedSession }, activity) { id -> selectedSession = id; scope.launch { repository.selectSession(id) } }
            else when (destination) {
                Destination.Chat -> EmptyState(Icons.Default.Email, "No chat selected", "Choose or create a session to start chatting.")
                Destination.Sessions -> SessionsScreen(repository, state, { selectedSession = it; scope.launch { repository.selectSession(it) } }, activity)
                Destination.Inbox -> InboxScreen(repository, state, activity)
                Destination.Desktop -> DesktopScreen(repository, state, activity)
                Destination.Settings -> SettingsScreen(repository, state, activity)
            }
        }
    }
}

@Composable
private fun SessionsScreen(repository: CereRepository, state: MobileState, select: (String) -> Unit, activity: FragmentActivity) {
    var query by remember { mutableStateOf("") }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }; var transferSource by remember { mutableStateOf<Session?>(null) }
    val sessions = state.sessions.filter { it.archived == showArchived && (query.isBlank() || listOf(it.title, it.project.orEmpty(), it.provider, it.folderName.orEmpty()).any { value -> value.contains(query, true) }) }.sortedWith(compareBy<Session> { it.status != "waiting" }.thenByDescending { it.pinned }.thenByDescending { it.updated })
    Box(Modifier.fillMaxSize()) {
      Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, leadingIcon = { Icon(Icons.Default.Search, null) }, placeholder = { Text("Search sessions") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(16.dp))
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(!showArchived, { showArchived = false }, { Text("Conversations") }); FilterChip(showArchived, { showArchived = true }, { Text("Archived") }) }
        if (state.supports("sessions.history") && state.supports("sessions.import")) OutlinedButton({ showHistory = true }, modifier = Modifier.padding(horizontal = 16.dp)) { Text("Import desktop history") }
        if (sessions.isEmpty()) EmptyState(Icons.Default.List, if (state.connection is ConnectionState.Online) "No sessions in your approved scope" else "No cached sessions", "Create or connect to the desktop to begin.")
        else LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(sessions, key = { it.id }) { session -> ElevatedCard(onClick = { select(session.id) }, modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    ProviderMark(session.provider)
                    Column(Modifier.padding(start = 14.dp).weight(1f)) { Text(session.title, fontWeight = FontWeight.SemiBold); if (session.pinned || session.unread || !session.folderName.isNullOrBlank()) Text(listOfNotNull(if (session.pinned) "Pinned" else null, if (session.unread) "Unread" else null, session.folderName).joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary); Text(listOfNotNull(session.project?.substringAfterLast('/'), session.model).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Column(horizontalAlignment = Alignment.End) { StatusPill(sessionDisplayStatus(session, state.approvals.count { it.sessionId == session.id })); if (state.supports("sessions.handoffPreview") && state.supports("sessions.handoffCreate")) IconButton({ transferSource = session }) { Icon(Icons.Default.Share, "Hand off session") } }
                }
            } }
        }
      }
      if (state.supports("sessions.create")) FloatingActionButton({ creating = true }, Modifier.padding(20.dp).align(Alignment.BottomEnd)) { Icon(Icons.Default.Add, "New session") }
    }
    if (creating) CreateSessionDialog(repository, state, activity, { creating = false }) { id -> creating = false; select(id) }
    if (showHistory) SessionTransferSheet(repository, state, activity, null, { showHistory = false }, { id -> showHistory = false; select(id) })
    transferSource?.let { source -> SessionTransferSheet(repository, state, activity, source, { transferSource = null }, { id -> transferSource = null; select(id) }) }
}

@Composable
private fun CreateSessionDialog(repository: CereRepository, state: MobileState, activity: FragmentActivity, close: () -> Unit, created: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var title by rememberSaveable { mutableStateOf("") }
    // Keep an authorized provider selectable when discovery failed, so Refresh
    // can recover it without restarting either app.
    val supportedProviders = state.providers.filterValues { it.jsonObject["remoteExecution"]?.jsonPrimitive?.booleanOrNull == true }
    var provider by rememberSaveable { mutableStateOf(supportedProviders.keys.firstOrNull().orEmpty()) }
    var project by rememberSaveable { mutableStateOf(state.projects.firstOrNull()?.id.orEmpty()) }
    var models by remember { mutableStateOf<List<ModelOption>>(emptyList()) }
    var model by rememberSaveable { mutableStateOf("") }
    var effort by rememberSaveable { mutableStateOf("") }
    var tools by rememberSaveable { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(supportedProviders.keys) { if (provider !in supportedProviders) provider = supportedProviders.keys.firstOrNull().orEmpty() }
    LaunchedEffect(state.projects) { if (state.projects.none { it.id == project }) project = state.projects.firstOrNull()?.id.orEmpty() }
    LaunchedEffect(provider, refresh) {
        model = ""; effort = ""; tools = false; models = emptyList(); error = null
        if (provider.isNotBlank()) {
            loading = true
            try {
                models = repository.models(provider, refresh = true)
                val defaultModel = if (provider == "ollama") state.settings["defaultModel"]?.jsonPrimitive?.contentOrNull else null
                val preferred = models.firstOrNull { it.id == defaultModel } ?: models.firstOrNull { it.isDefault } ?: models.firstOrNull()
                model = preferred?.id.orEmpty(); effort = preferred?.defaultEffort.orEmpty()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { loading = false }
        }
    }
    val selectedModel = models.firstOrNull { it.id == model }
    val selectedProject = state.projects.firstOrNull { it.id == project }
    fun chooseModel(option: ModelOption) { model = option.id; effort = option.defaultEffort; if ("tools" !in option.capabilities) tools = false }
    AlertDialog(onDismissRequest = { if (!submitting) close() }, title = { Text("New conversation") }, text = {
        Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(title, { title = it.take(100) }, label = { Text("Title (optional)") }, enabled = !submitting)
            Text("Provider", fontWeight = FontWeight.Medium)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { supportedProviders.keys.forEach { id ->
                FilterChip(provider == id, { provider = id }, { Text(id.replaceFirstChar(Char::uppercase)) }, enabled = !submitting)
            } }
            state.providers.filterKeys { it !in supportedProviders }.forEach { (id, value) ->
                Text("${id.replaceFirstChar(Char::uppercase)} · ${value.jsonObject["remoteUnavailableReason"]?.jsonPrimitive?.contentOrNull ?: "Enable access on the desktop"}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("Desktop project", fontWeight = FontWeight.Medium)
            if (state.projects.isEmpty()) Text("Grant this phone a project in desktop Remote settings.", color = MaterialTheme.colorScheme.error)
            state.projects.forEach { option -> FilterChip(project == option.id, { project = option.id }, { Column {
                Text(option.name); Text(option.path ?: "Path unavailable", style = MaterialTheme.typography.labelSmall)
            } }, enabled = !submitting) }
            if (provider == "ollama") Text("Ollama · ${state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable"}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Model", fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                TextButton({ refresh++ }, enabled = provider.isNotBlank() && !loading && !submitting && state.supports("providers.models")) { Text("Refresh models") }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            else if (models.isEmpty() && provider.isNotBlank()) Text("No models loaded. Check the provider on your PC, then refresh.", style = MaterialTheme.typography.bodySmall)
            models.forEach { option -> Row(Modifier.fillMaxWidth().clickable(enabled = !submitting) { chooseModel(option) }.padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(model == option.id, { chooseModel(option) }, enabled = !submitting)
                Column { Text(option.displayName); if (option.description.isNotBlank()) Text(option.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } }
            selectedModel?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                Text("Effort", fontWeight = FontWeight.Medium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { efforts.forEach { option -> FilterChip(effort == option.id, { effort = option.id }, { Text(option.displayName) }, enabled = !submitting) } }
            }
            if (provider == "ollama") ListItem(headlineContent = { Text("Desktop tools") }, supportingContent = {
                Text(if (selectedModel?.capabilities?.contains("tools") == true) "Use ordinary desktop permission checks" else "Conversation only · this model does not advertise tools")
            }, trailingContent = { Switch(tools, { tools = it }, enabled = !submitting && selectedModel?.capabilities?.contains("tools") == true) })
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { Button(onClick = {
        submitting = true; error = null
        scope.launch {
            try {
                val params = buildJsonObject { put("provider", provider); put("projectId", project); if (title.isNotBlank()) put("title", title); put("model", model); if (effort.isNotBlank()) put("effort", effort); put("tools", tools) }
                val action = repository.prepareAction("sessions.create", params)
                authenticate(activity, "Create $provider conversation", action, repository, { result ->
                    scope.launch { try { created(repository.openCreatedSession(result)) } catch (failure: Exception) { error = failure.message; submitting = false } }
                }, { error = it; submitting = false })
            } catch (failure: Exception) { error = failure.message; submitting = false }
        }
    }, enabled = selectedModel != null && selectedProject != null && !loading && !submitting && state.supports("sessions.create")) {
        Text(if (submitting) "Creating…" else "Create conversation")
    } }, dismissButton = { TextButton(close, enabled = !submitting) { Text("Cancel") } })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(repository: CereRepository, state: MobileState, session: Session?, activity: FragmentActivity, selectSession: (String) -> Unit) {
    if (session == null) return EmptyState(Icons.Default.Warning, "Session unavailable", "It may no longer be in this device's scope.")
    val scope = rememberCoroutineScope(); val storedDraft = state.draft(session); var draft by rememberSaveable(session.id) { mutableStateOf(storedDraft.text) }; var activityOpen by rememberSaveable(session.id) { mutableStateOf(false) }; var error by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var activityLoading by remember(session.id) { mutableStateOf(false) }; var activityError by remember(session.id) { mutableStateOf<String?>(null) }; var activityRefresh by remember(session.id) { mutableIntStateOf(0) }
    var reviewOpen by rememberSaveable(session.id) { mutableStateOf(false) }; var sending by remember(session.id) { mutableStateOf(false) }; var loadingOlder by remember(session.id) { mutableStateOf(false) }
    var attachmentReviewId by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var showConversationSettings by rememberSaveable(session.id) { mutableStateOf(false) }
    var webSearch by rememberSaveable(session.id) { mutableStateOf(false) }
    val canSearchWeb = state.canSearchWeb(session)
    LaunchedEffect(canSearchWeb) { if (!canSearchWeb) webSearch = false }
    val attachments = state.attachments.filter { it.sessionId == session.id }
    val activeAgents = session.agents.filter(Agent::isActive)
    val waitingApprovals = state.approvals.filter { it.sessionId == session.id }
    val busy = session.status in setOf("starting", "working", "waiting", "stopping") || activeAgents.isNotEmpty() || waitingApprovals.isNotEmpty()
    val attachmentsReady = attachments.all { it.reviewedAt != null && it.remoteAttachmentId != null && it.remoteStatus == "ready" }
    val canCompose = session.draftAttachmentCount == 0 && session.canSend && session.mode == "managed" && session.draftIncluded && !busy && !sending && attachmentsReady && state.supports("sessions.send") && state.pendingCommands.none { it.sessionId == session.id && it.method == "sessions.send" }
    fun imported(uri: android.net.Uri?) { if (uri != null) scope.launch { runCatching { repository.importImage(session.id, uri) }.onSuccess { attachmentReviewId = it.id }.onFailure { error = it.message } } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia(), ::imported)
    val files = rememberLauncherForActivityResult(ActivityResultContracts.GetContent(), ::imported)
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap -> if (bitmap != null) scope.launch { runCatching { repository.importCameraImage(session.id, bitmap) }.onSuccess { attachmentReviewId = it.id }.onFailure { error = it.message } } }
    fun finishUpload(local: LocalAttachment, initial: JsonObject?) { scope.launch { runCatching {
        val uploaded = repository.uploadAttachment(local.id, initial); val attachmentId = uploaded.getValue("attachmentId").jsonPrimitive.content
        val commit = repository.prepareAction("attachments.commit", buildJsonObject { put("attachmentId", attachmentId) })
        authenticate(activity, "Finish image upload", commit, repository, { ready -> scope.launch { repository.markAttachmentReady(local.id, ready.jsonObject) } }, { error = it })
    }.onFailure { error = it.message } } }
    fun upload(local: LocalAttachment) { if (local.remoteAttachmentId != null) { finishUpload(local, null); return }; scope.launch { runCatching {
        val begin = repository.prepareAction("attachments.begin", buildJsonObject { put("sessionId", session.id); put("size", local.size); put("mime", local.mime); put("sha256", local.sha256) })
        authenticate(activity, "Upload ${local.displayName}", begin, repository, { value -> finishUpload(local, value.jsonObject) }, { error = it })
    }.onFailure { error = it.message } } }
    fun remove(local: LocalAttachment) { if (local.remoteAttachmentId == null || !state.supports("attachments.abort")) { scope.launch { repository.removeAttachment(local.id) }; return }; scope.launch { runCatching { val action = repository.prepareAction("attachments.abort", buildJsonObject { put("attachmentId", local.remoteAttachmentId) }); authenticate(activity, "Cancel image upload", action, repository, { scope.launch { repository.removeAttachment(local.id) } }, { error = it }) }.onFailure { error = it.message } } }
    LaunchedEffect(session.id, state.connection is ConnectionState.Online) { if (state.connection is ConnectionState.Online) runCatching { repository.loadMessages(session.id) }.onFailure { error = it.message } }
    LaunchedEffect(storedDraft.text, storedDraft.dirty, storedDraft.conflict) { if (!storedDraft.dirty && draft != storedDraft.text) draft = storedDraft.text }
    LaunchedEffect(activityOpen, activityRefresh, session.id, state.connection is ConnectionState.Online) {
        if (activityOpen && state.supports("activity.list")) {
            activityLoading = true; activityError = null
            try { repository.loadActivity(session.id) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { activityError = failure.message }
            finally { activityLoading = false }
        }
    }
    LaunchedEffect(draft, sending) {
        if (sending || session.draftAttachmentCount != 0 || !session.draftIncluded || session.mode != "managed") return@LaunchedEffect
        try {
            repository.saveLocalDraft(session.id, draft)
            delay(700)
            repository.syncDraft(session.id)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            error = failure.message
            if (failure.message?.contains("REVISION_CONFLICT") == true) repository.selectSession(session.id)
        }
    }
    val messages = state.messages.filter { it.sessionId == session.id }.sortedBy { it.time }
    val activityItems = messages.filterNot(Message::isConversationMessage)
    val unknownSend = state.pendingCommands.firstOrNull { it.sessionId == session.id && it.method == "sessions.send" && it.status == "unknown" }
    var reviewingOutcome by remember(session.id) { mutableStateOf(false) }
    val sendHint = when {
        session.mode == "linked" -> "Linked terminal session · continue on the PC"
        !session.canSend -> "Sending is unavailable for this session. Check provider access on your PC."
        !session.draftIncluded -> "Loading desktop draft…"
        session.draftAttachmentCount == null -> "Restart the updated Cere broker on your PC to sync desktop attachments. Your draft stays on this phone."
        (session.draftAttachmentCount ?: 0) > 0 -> "${session.draftAttachmentCount} attachment(s) are in this desktop draft. Review and send or remove them on the PC first."
        storedDraft.conflict -> "Resolve the draft conflict before sending."
        sending -> "Sending your message…"
        !attachmentsReady -> "Upload or remove the images before sending."
        state.pendingCommands.any { it.sessionId == session.id && it.method == "sessions.send" } -> "Checking the previous send with your desktop…"
        else -> null
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        if (state.connection !is ConnectionState.Online) AssistChip({}, { Text("Cached · actions unavailable") }, leadingIcon = { Icon(Icons.Default.Warning, null) }, modifier = Modifier.padding(horizontal = 16.dp))
        if (storedDraft.conflict) Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp), shape = RoundedCornerShape(12.dp)) { Column(Modifier.padding(12.dp)) { Text("Draft changed on desktop", fontWeight = FontWeight.SemiBold); Text("Your phone edit is preserved. Choose which version to keep."); Row { TextButton({ scope.launch { repository.reloadRemoteDraft(session.id); draft = storedDraft.remoteText.orEmpty() } }) { Text("Reload desktop") }; TextButton({ scope.launch { repository.keepLocalDraft(session.id) } }) { Text("Keep phone edit") } } } }
        Text(listOfNotNull(session.provider.replaceFirstChar(Char::uppercase), session.model, session.project).joinToString(" · "),
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        session.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) }
        key(session.id) {
            ConversationTimeline(messages, busy, session.status, Modifier.weight(1f), state.messagesBefore[session.id] != null, loadingOlder, {
                loadingOlder = true
                scope.launch { try { repository.loadOlderMessages(session.id) } catch (failure: Exception) { error = failure.message } finally { loadingOlder = false } }
            }, statusText = when {
                waitingApprovals.isNotEmpty() -> if (waitingApprovals.size == 1) "Waiting for your input…" else "Waiting for ${waitingApprovals.size} inputs…"
                activeAgents.size == 1 -> "1 subagent is working…"
                activeAgents.size > 1 -> "${activeAgents.size} subagents are working…"
                else -> null
            }, sessionId = session.id, restoredPosition = state.scrollPositions[session.id],
                onPositionChanged = repository::recordScrollPosition) { message -> MessageBubble(repository, state, message) }
        }
        if (waitingApprovals.isNotEmpty()) {
            TextButton({ activityOpen = false; reviewOpen = true }, modifier = Modifier.fillMaxWidth()) { Text("${waitingApprovals.size} request(s) need your input · Review") }
        }
        (error ?: state.lastError)?.let { Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            IconButton({ error = null; scope.launch { repository.dismissError() } }) { Icon(Icons.Default.Close, "Dismiss error") }
        } }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton({ activityOpen = true }, enabled = state.supports("activity.list") || activityItems.isNotEmpty() || session.agents.isNotEmpty()) { Icon(Icons.Default.List, null); Text(buildList { add("Activity"); if (activeAgents.isNotEmpty()) add("${activeAgents.size} agent${if (activeAgents.size == 1) "" else "s"} active"); else if (activityItems.isNotEmpty()) add(activityItems.size.toString()) }.joinToString(" · ")) }
            if (!busy) TextButton({ showConversationSettings = true }) { Text("Conversation settings") }
            if (busy) OutlinedButton(onClick = { scope.launch { runCatching { repository.mutate("sessions.stop", buildJsonObject { put("sessionId", session.id) }) }.onFailure { error = it.message } } }, enabled = state.supports("sessions.stop") && session.status != "stopping") { Icon(Icons.Default.Clear, null); Text(if (session.status == "stopping") "Stopping…" else "Stop") }
        }
        if (attachments.isNotEmpty()) LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(attachments, key = { it.id }) { attachment -> Surface(border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline), shape = RoundedCornerShape(8.dp)) { Column(Modifier.widthIn(min = 150.dp).padding(10.dp)) { Text(attachment.displayName, style = MaterialTheme.typography.labelLarge); Text("${attachment.width}×${attachment.height} · ${attachment.size / 1024} KiB${if (attachment.transformed) " · private copy optimized" else ""}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant); Row { if (attachment.reviewedAt == null) TextButton({ attachmentReviewId = attachment.id }) { Text("Review") } else if (attachment.remoteStatus != "ready") TextButton({ upload(attachment) }, enabled = state.supports("attachments.begin") && state.supports("attachments.commit")) { Text(if (attachment.committedOffset > 0) "Resume" else "Upload") } else Text("Ready", color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(12.dp)); IconButton({ remove(attachment) }) { Icon(Icons.Default.Delete, "Remove image") } } } } } }
        if (state.supports("attachments.begin") && attachments.size < 4) FlowRow(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) { TextButton({ picker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) { Text("Photo") }; TextButton({ files.launch("image/*") }) { Text("Screenshot or file") }; TextButton({ camera.launch(null) }) { Text("Camera") } }
        if (canSearchWeb) FilterChip(webSearch, { webSearch = !webSearch }, { Text("Search the web") }, enabled = !sending && !busy, modifier = Modifier.padding(horizontal = 12.dp))
        sendHint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp)) }
        if (unknownSend != null) TextButton({ reviewingOutcome = true }, modifier = Modifier.padding(horizontal = 8.dp)) { Text("Review uncertain send") }
        OutlinedTextField(draft, { if (it.length <= 100_000) { draft = it; repository.editDraft(session.id, it) } }, enabled = session.mode == "managed" && session.draftIncluded && (session.draftAttachmentCount ?: 0) == 0 && !sending,
            placeholder = { Text("Message Cere") }, minLines = 1, maxLines = 6, modifier = Modifier.fillMaxWidth().padding(12.dp), trailingIcon = {
                IconButton(onClick = {
                    val sentText = draft; val sentAttachments = attachments.map { it.id }.toSet()
                    sending = true; error = null
                    scope.launch {
                        try {
                            val action = repository.prepareSend(session.id, sentText, webSearch = webSearch)
                            repository.completeAction(action, repository.signAuthenticated(action))
                            repository.clearAcceptedDraft(session.id, sentText, sentAttachments)
                            if (draft == sentText) draft = ""
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (failure: Exception) {
                            error = failure.message
                            if (failure.message?.contains("REVISION_CONFLICT") == true) repository.selectSession(session.id)
                        } finally {
                            sending = false
                        }
                    }
                }, enabled = draft.isNotBlank() && canCompose && !storedDraft.conflict) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
            })
    }
    if (showConversationSettings) ConversationSettingsSheet(repository, state, session, activity) { showConversationSettings = false }
    if (activityOpen) ActivityPanel(activityItems, activityLoading, activityError, { activityRefresh++ }, { activityOpen = false },
        agents = session.agents, canOpenAgent = { agent -> state.sessions.any { it.id == agent.id } },
        onOpenAgent = { agent -> activityOpen = false; selectSession(agent.id) }) { item -> ActivityRow(repository, state, item) }
    if (reviewingOutcome && unknownSend != null) AlertDialog(onDismissRequest = { reviewingOutcome = false }, title = { Text("Check the previous send") },
        text = { Text("The provider may have received your previous message. Review this conversation and the provider on your PC before trying again. Your draft is kept; nothing will be sent automatically.") },
        confirmButton = { TextButton({ scope.launch { repository.acknowledgeUnknownSend(unknownSend.commandId); reviewingOutcome = false; error = null } }) { Text("I've reviewed it on the PC") } },
        dismissButton = { TextButton({ reviewingOutcome = false }) { Text("Keep waiting") } })
    if (reviewOpen) ModalBottomSheet({ reviewOpen = false }) {
        Text("Requests for this conversation", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(20.dp))
        LazyColumn(Modifier.heightIn(max = 560.dp), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(waitingApprovals, key = { it.id }) { ApprovalCard(repository, state, activity, it) }
            if (waitingApprovals.isEmpty()) item { Text("All requests have been answered.") }
        }
    }
    val reviewingAttachment = attachments.firstOrNull { it.id == attachmentReviewId }
    if (reviewingAttachment != null) AttachmentReviewDialog(repository, reviewingAttachment,
        onKeep = { scope.launch { repository.markAttachmentReviewed(reviewingAttachment.id); attachmentReviewId = null } },
        onRemove = { scope.launch { repository.removeAttachment(reviewingAttachment.id); attachmentReviewId = null } },
        onDismiss = { attachmentReviewId = null })
}

@Composable
private fun AttachmentReviewDialog(repository: CereRepository, attachment: LocalAttachment, onKeep: () -> Unit, onRemove: () -> Unit, onDismiss: () -> Unit) {
    var bitmap by remember(attachment.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var error by remember(attachment.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(attachment.id) {
        runCatching { val bytes = repository.attachmentPreview(attachment.id); android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("The private image copy could not be decoded") }
            .onSuccess { bitmap = it }
            .onFailure { error = it.message }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Review image before upload") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Only the optimized private copy shown here will be uploaded after you choose Keep and then Upload.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            bitmap?.let { Image(it.asImageBitmap(), contentDescription = "Image selected for this message", modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp).clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Fit) }
            if (bitmap == null && error == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Text("${attachment.width}×${attachment.height} · ${attachment.size / 1024} KiB", style = MaterialTheme.typography.bodySmall)
        }
    }, confirmButton = { Button(onKeep, enabled = bitmap != null) { Text("Keep for message") } }, dismissButton = {
        Row { TextButton(onDismiss) { Text("Review later") }; TextButton(onRemove, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Remove") } }
    })
}

@Composable private fun ActivityRow(repository: CereRepository, state: MobileState, item: Message) {
    val clipboard = LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)
    val scope = rememberCoroutineScope()
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    var content by remember(item.id, item.revision) { mutableStateOf(item.text) }
    var loading by remember(item.id) { mutableStateOf(false) }
    var error by remember(item.id) { mutableStateOf<String?>(null) }
    ElevatedCard(Modifier.fillMaxWidth().padding(vertical = 6.dp)) { Column(Modifier.padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(item.text.lineSequence().firstOrNull()?.take(90).orEmpty().ifBlank { "Provider activity" }, fontWeight = FontWeight.SemiBold,
                maxLines = 2, modifier = Modifier.weight(1f))
            IconButton({ clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Cere activity", content)) }) { Icon(painterResource(R.drawable.ic_copy), if (item.contentTruncated && content == item.text) "Copy activity preview" else "Copy activity text") }
        }
        if (expanded) SelectionContainer { Text(content, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.horizontalScroll(rememberScrollState())) }
        TextButton({ expanded = !expanded }) { Text(if (expanded) "Collapse" else "Show details") }
        if (expanded && item.contentTruncated && content == item.text) OutlinedButton({ scope.launch {
            loading = true
            try { content = repository.fullMessage(item) } catch (failure: Exception) { error = failure.message } finally { loading = false }
        } }, enabled = !loading && state.supports("sessions.messagePart")) { Text(if (loading) "Loading…" else "Load full output") }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    } }
}

@Composable private fun MessageBubble(repository: CereRepository, state: MobileState, message: Message) {
    val scope = rememberCoroutineScope(); var content by remember(message.id, message.revision) { mutableStateOf(message.text) }; var loading by remember(message.id, message.revision) { mutableStateOf(false) }; var error by remember(message.id, message.revision) { mutableStateOf<String?>(null) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (message.role == "user") Arrangement.End else Arrangement.Start) { Surface(color = if (message.role == "user") MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(18.dp), modifier = Modifier.widthIn(max = 620.dp).fillMaxWidth(0.88f)) { Column(Modifier.padding(14.dp)) { Text(message.role.replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.height(5.dp)); Markdown(content)
        if (message.contentTruncated && content == message.text) { Spacer(Modifier.height(8.dp)); Text("Message preview · ${message.contentChars ?: "many"} characters", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary); OutlinedButton({ scope.launch { loading = true; error = null; runCatching { repository.fullMessage(message) }.onSuccess { content = it }.onFailure { error = it.message }; loading = false } }, enabled = !loading && state.supports("sessions.messagePart")) { Text(if (loading) "Loading…" else "Load full message") } }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    } } }
}

@Composable
private fun InboxScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity) {
    if (state.approvals.isEmpty()) return EmptyState(Icons.Default.Check, "Inbox clear", "Requests that need your review appear here.")
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { items(state.approvals, key = { it.id }) { approval -> ApprovalCard(repository, state, activity, approval) } }
}

@Composable
private fun ApprovalCard(repository: CereRepository, state: MobileState, activity: FragmentActivity, approval: Approval) {
    val scope = rememberCoroutineScope(); var error by remember { mutableStateOf<String?>(null) }; var expanded by remember { mutableStateOf(false) }; var preview by remember(approval.id, approval.revision) { mutableStateOf<ApprovalPreview?>(null) }; var previewLoading by remember { mutableStateOf(false) }
    var validationAttempted by remember(approval.id, approval.revision) { mutableStateOf(false) }
    val drafts by repository.questionDrafts.collectAsStateWithLifecycle()
    val mutations by repository.approvalMutations.collectAsStateWithLifecycle()
    val uriHandler = LocalUriHandler.current
    val answers = drafts[approval.id].orEmpty()
    val questionIds = approval.questions.mapTo(mutableSetOf(), ApprovalQuestion::id); val fieldIds = approval.fields.keys
    fun schema(id: String) = approval.fields[id] as? JsonObject
    fun supported(value: JsonObject?): Boolean {
        if (value == null) return true
        val type = value["type"]?.jsonPrimitive?.contentOrNull
        if (type == "array") {
            val items = value["items"] as? JsonObject ?: return false
            return items["type"]?.jsonPrimitive?.contentOrNull == "string" &&
                items["enum"] is JsonArray && items["enum"]!!.jsonArray.all { it is JsonPrimitive }
        }
        if (type !in setOf("string","boolean","number","integer")) return false
        return value["enum"]?.let { it is JsonArray && it.all { option -> option is JsonPrimitive } } != false &&
            value["oneOf"]?.let { it is JsonArray && it.all { option -> option is JsonObject && option["const"] is JsonPrimitive } } != false
    }
    fun validField(id: String): Boolean {
        val values = answers[id].orEmpty()
        val field = schema(id)
        if (!supported(field)) return false
        val type = field?.get("type")?.jsonPrimitive?.contentOrNull
        if (type == "array") {
            val allowed = (field?.get("items") as? JsonObject)?.get("enum")?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
            val minimum = field?.get("minItems")?.jsonPrimitive?.intOrNull ?: 1
            val maximum = field?.get("maxItems")?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE
            return values.size in minimum..maximum && values.distinct().size == values.size && values.all { it in allowed }
        }
        val answer = values.firstOrNull()?.trim().orEmpty()
        if (answer.isBlank()) return false
        if (type == "boolean" && answer !in setOf("true","false")) return false
        if (type in setOf("number","integer")) { val number = answer.toDoubleOrNull() ?: return false; if (type == "integer" && number % 1.0 != 0.0) return false; field?.get("minimum")?.jsonPrimitive?.doubleOrNull?.let { if (number < it) return false }; field?.get("maximum")?.jsonPrimitive?.doubleOrNull?.let { if (number > it) return false } }
        field?.get("enum")?.jsonArray?.let { if (answer !in it.map { option -> option.jsonPrimitive.content }) return false }
        field?.get("oneOf")?.jsonArray?.let { if (answer !in it.mapNotNull { option -> option.jsonObject["const"]?.jsonPrimitive?.contentOrNull }) return false }
        return true
    }
    val unsupported = approval.fields.values.any { !supported(it as? JsonObject) }
    val answersComplete = approval.questions.all { questionError(it, answers[it.id].orEmpty()) == null } && fieldIds.all(::validField)
    val pending = approval.id in mutations || state.pendingCommands.any { it.method == "approvals.answer" && it.sessionId == approval.sessionId }
    ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) { Icon(if (approval.kind == "question" || approval.questions.isNotEmpty()) Icons.Default.Info else Icons.Default.Warning, null, tint = MaterialTheme.colorScheme.tertiary); Spacer(Modifier.width(10.dp)); Column { Text(approval.title, fontWeight = FontWeight.SemiBold); Text(if (approval.kind == "question" || approval.questions.isNotEmpty()) "QUESTION" else "PERMISSION · ${approval.kind.uppercase()}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary) } }
        approval.detail?.let { TextButton({ expanded = !expanded }) { Text(if (expanded) "Hide exact request" else "Review exact request") }; if (expanded) SelectionContainer { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) } }
        approval.url?.let { url ->
            OutlinedButton({ runCatching { uriHandler.openUri(url) }.onFailure { error = it.message ?: "Could not open the link." } }, modifier = Modifier.fillMaxWidth()) {
                Text("Open link ↗")
            }
            Text("Complete the requested step in your browser, then confirm below.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (approval.kind == "image") { val bitmap = remember(preview) { preview?.bytes?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size) } }; if (bitmap != null) { Image(bitmap.asImageBitmap(), "Exact capture proposed for sharing", Modifier.fillMaxWidth().heightIn(max = 420.dp).clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.Fit); Text("Verified exact preview", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium) } else OutlinedButton({ scope.launch { previewLoading = true; error = null; runCatching { repository.approvalPreview(approval) }.onSuccess { preview = it }.onFailure { error = it.message }; previewLoading = false } }, enabled = !previewLoading && state.supports("approvals.preview") && state.supports("attachments.read")) { Text(if (previewLoading) "Loading preview…" else "Review exact capture") } }
        approval.questions.forEachIndexed { index, question ->
            QuestionField(question, index, approval.questions.size, answers[question.id].orEmpty(),
                if (validationAttempted) questionError(question, answers[question.id].orEmpty()) else null) {
                repository.setQuestionAnswer(approval.id, question.id, it)
            }
        }
        approval.fields.filterKeys { it !in questionIds }.forEach { (id, value) ->
            ApprovalField(id, (value as? JsonObject)?.get("title")?.jsonPrimitive?.contentOrNull ?: id, value as? JsonObject, answers[id].orEmpty(),
                if (validationAttempted && !validField(id)) "Enter a valid answer." else null) {
                repository.setQuestionAnswer(approval.id, id, it)
            }
        }
        if (unsupported) Text("This form contains an unsupported field. You can deny it here or continue on the desktop.", color = MaterialTheme.colorScheme.tertiary)
        if (!approval.canAnswer && approval.choices.any { it !in setOf("deny","cancel") }) Text("Positive answers require desktop review under the current provider policy.", color = MaterialTheme.colorScheme.tertiary)
        if (!state.supports("approvals.answer")) Text("This device has read-only approval access.", color = MaterialTheme.colorScheme.tertiary)
        if (pending) Text("Submitting this response…", color = MaterialTheme.colorScheme.primary)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { approval.choices.forEach { choice ->
            val deny = choice == "deny" || choice == "cancel"
            if (deny) OutlinedButton({
                if (!repository.beginApprovalMutation(approval.id)) return@OutlinedButton
                scope.launch { try { repository.mutate("approvals.answer", approvalParams(approval, choice, emptyMap())) } catch (failure: Exception) { error = failure.message } finally { repository.endApprovalMutation(approval.id) } }
            }, enabled = state.supports("approvals.answer") && !pending) { Text(choice.replaceFirstChar(Char::uppercase)) }
            else Button({
                validationAttempted = true
                if (!answersComplete || !repository.beginApprovalMutation(approval.id)) return@Button
                scope.launch {
                    runCatching { repository.prepareAction("approvals.answer", approvalParams(approval, choice, answers, preview?.imageDigest)) }
                        .onSuccess { action ->
                            runCatching { authenticate(activity, "${choice.replaceFirstChar(Char::uppercase)} ${approval.title}", action, repository,
                                { repository.endApprovalMutation(approval.id) },
                                { error = it; repository.endApprovalMutation(approval.id) }) }
                                .onFailure { error = it.message; repository.endApprovalMutation(approval.id) }
                        }
                        .onFailure { error = it.message; repository.endApprovalMutation(approval.id) }
                }
            }, enabled = approval.canAnswer && !unsupported && state.supports("approvals.answer") && !pending && (approval.kind != "image" || preview != null)) { Text(when { choice == "answer" -> "Send answers"; choice == "allow" && approval.url != null -> "I've completed it"; else -> choice.replaceFirstChar(Char::uppercase) }) }
        } }
        if (validationAttempted && !answersComplete) Text("Answer each required question before sending.", color = MaterialTheme.colorScheme.error)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    } }
}

@Composable
private fun QuestionField(question: ApprovalQuestion, index: Int, count: Int, answers: List<String>, error: String?, update: (List<String>) -> Unit) {
    val other = questionOtherValue(question, answers)
    OutlinedPanel("Question ${index + 1} of $count · ${if (question.required) "Required" else "Optional"}") {
        question.header?.let { Text(it, fontWeight = FontWeight.SemiBold) }
        Text(question.question, fontWeight = if (question.header == null) FontWeight.Medium else FontWeight.Normal)
        question.options.forEach { option ->
            val selected = option.label in answers
            FilterChip(selected, { update(selectQuestionOption(question, answers, option.label, !selected)) }, {
                Column { Text(option.label); option.description?.takeIf(String::isNotBlank)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            }, modifier = Modifier.fillMaxWidth())
        }
        if (question.options.isEmpty() || question.allowOther) OutlinedTextField(
            other,
            { update(updateQuestionOther(question, answers, it)) },
            label = { Text(if (question.options.isEmpty()) "Answer" else "Other answer") },
            minLines = if (question.isSecret) 1 else 2,
            maxLines = if (question.isSecret) 1 else 6,
            singleLine = question.isSecret,
            visualTransformation = if (question.isSecret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(keyboardType = if (question.isSecret) KeyboardType.Password else KeyboardType.Text),
            isError = error != null,
            supportingText = { error?.let { Text(it) } },
            modifier = Modifier.fillMaxWidth(),
        )
        else error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable private fun ApprovalField(id: String, label: String, schema: JsonObject?, answers: List<String>, error: String?, update: (List<String>) -> Unit) {
    val type = schema?.get("type")?.jsonPrimitive?.contentOrNull ?: "string"
    val options = when {
        type == "array" -> (schema?.get("items") as? JsonObject)?.get("enum")?.jsonArray?.map { ApprovalOption(it.jsonPrimitive.content) }.orEmpty()
        schema?.get("enum") is JsonArray -> schema["enum"]!!.jsonArray.map { ApprovalOption(it.jsonPrimitive.content) }
        schema?.get("oneOf") is JsonArray -> schema["oneOf"]!!.jsonArray.mapNotNull { option -> (option as? JsonObject)?.get("const")?.jsonPrimitive?.contentOrNull?.let { ApprovalOption(it, option["title"]?.jsonPrimitive?.contentOrNull) } }
        type == "boolean" -> listOf(ApprovalOption("true", "Yes"), ApprovalOption("false", "No"))
        else -> emptyList()
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, fontWeight = FontWeight.Medium)
        if (options.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { options.forEach { option ->
                val selected = option.label in answers
                FilterChip(selected, { update(if (type == "array") { if (selected) answers - option.label else (answers + option.label).distinct() } else listOf(option.label)) }, { Text(option.description ?: option.label) })
            } }
            if (type == "array") Text(listOfNotNull(
                schema?.get("minItems")?.jsonPrimitive?.contentOrNull?.let { "Choose at least $it" },
                schema?.get("maxItems")?.jsonPrimitive?.contentOrNull?.let { "Choose at most $it" },
                error,
            ).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = if (error == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
            else error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        } else if (type in setOf("string","number","integer")) {
            OutlinedTextField(answers.firstOrNull().orEmpty(), { update(listOf(it)) }, minLines = if (type == "string") 2 else 1, isError = error != null, keyboardOptions = KeyboardOptions(keyboardType = if (type == "number" || type == "integer") KeyboardType.Decimal else KeyboardType.Text), supportingText = { val bounds = listOfNotNull(schema?.get("minimum")?.jsonPrimitive?.contentOrNull?.let { "min $it" }, schema?.get("maximum")?.jsonPrimitive?.contentOrNull?.let { "max $it" }).joinToString(" · "); Text(listOfNotNull(bounds.takeIf(String::isNotBlank), error).joinToString(" · ")) }, modifier = Modifier.fillMaxWidth())
        } else Text("Unsupported field type: $type", color = MaterialTheme.colorScheme.error)
    }
}

private fun approvalParams(value: Approval, choice: String, answers: Map<String, List<String>>, imageDigest: String? = null) = buildJsonObject { put("approvalId", value.id); put("revision", value.revision); put("digest", value.digest); put("choice", choice); put("answers", buildJsonObject { answers.mapValues { (_, values) -> values.filter(String::isNotBlank) }.filterValues(List<String>::isNotEmpty).forEach { (id, values) -> put(id, buildJsonObject { put("answers", buildJsonArray { values.forEach(::add) }) }) } }); imageDigest?.let { put("imageDigest", it) } }

@Composable
private fun DesktopScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity) {
    val scope = rememberCoroutineScope(); var projectId by rememberSaveable { mutableStateOf(state.projects.firstOrNull()?.id.orEmpty()) }; var status by remember { mutableStateOf(JsonObject(emptyMap())) }; var apps by remember { mutableStateOf(JsonArray(emptyList())) }; var windows by remember { mutableStateOf(JsonArray(emptyList())) }; var query by rememberSaveable { mutableStateOf("") }; var loading by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var feedback by remember { mutableStateOf<String?>(null) }
    fun refresh() { if (projectId.isBlank()) return; scope.launch { loading = true; error = null; runCatching {
        if (state.supports("desktop.status")) status = repository.request("desktop.status", buildJsonObject { put("projectId", projectId) }).jsonObject
        if (state.supports("desktop.apps")) apps = repository.request("desktop.apps", buildJsonObject { put("projectId", projectId) }).jsonArray
        if (state.supports("desktop.windows")) windows = repository.request("desktop.windows", buildJsonObject { put("projectId", projectId) }).jsonArray
    }.onFailure { error = it.message }; loading = false } }
    fun execute(name: String, args: JsonObject, label: String) { scope.launch { runCatching { val action = repository.prepareAction("desktop.execute", buildJsonObject { put("projectId", projectId); put("action", name); put("args", args) }); val selected = state.projects.firstOrNull { it.id == projectId }; val cue = selected?.path ?: selected?.name ?: "approved project"; authenticate(activity, "$label · $cue", action, repository, { feedback = "$label completed"; refresh() }, { error = it }) }.onFailure { error = it.message } } }
    val projectIds = state.projects.map(Project::id)
    LaunchedEffect(state.cacheEpoch, projectIds, state.supports("desktop.status"), state.supports("desktop.apps"), state.supports("desktop.windows")) {
        status = JsonObject(emptyMap()); apps = JsonArray(emptyList()); windows = JsonArray(emptyList()); feedback = null; error = null
        if (projectId !in projectIds) projectId = projectIds.firstOrNull().orEmpty()
    }
    LaunchedEffect(projectId, state.cacheEpoch, state.connection is ConnectionState.Online) { if (state.connection is ConnectionState.Online) refresh() }
    if (!state.supports("desktop.status")) return EmptyState(Icons.Default.Lock, "Desktop controls are not granted", "Open Cere Desktop Settings to grant exact projects and categories.")
    val actionNames = status["actions"]?.jsonArray.orEmpty().mapNotNull { it.jsonObject["name"]?.jsonPrimitive?.contentOrNull }.toSet()
    val audio = status["audio"]?.jsonObject ?: JsonObject(emptyMap()); val media = status["media"]?.jsonObject ?: JsonObject(emptyMap())
    val filteredApps = apps.filter { query.isBlank() || it.jsonObject["name"]?.jsonPrimitive?.contentOrNull.orEmpty().contains(query, true) }
    val filteredWindows = windows.filter { query.isBlank() || listOf("title","app").any { key -> it.jsonObject[key]?.jsonPrimitive?.contentOrNull.orEmpty().contains(query, true) } }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) { Column(Modifier.weight(1f)) { Text("Desktop", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() }); Text("Everyday controls, close at hand.", color = MaterialTheme.colorScheme.onSurfaceVariant) }; OutlinedButton(::refresh, enabled = !loading) { Icon(Icons.Default.Refresh, null); Text(if (loading) "Loading" else "Refresh") } } }
        item { FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { state.projects.forEach { project -> FilterChip(projectId == project.id, { projectId = project.id }, { Column { Text(project.name); Text(project.path ?: "Path unavailable", style = MaterialTheme.typography.labelSmall) } }) } } }
        state.projects.firstOrNull { it.id == projectId }?.let { project -> item { OutlinedPanel("Action scope") { Text(state.desktop?.desktopName ?: "Paired desktop", color = MaterialTheme.colorScheme.primary); SelectionContainer { Text(project.path ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) } } } }
        item { OutlinedTextField(query, { query = it }, leadingIcon = { Icon(Icons.Default.Search, null) }, placeholder = { Text("Search controls, apps or windows") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
        feedback?.let { item { Surface(color = MaterialTheme.colorScheme.primaryContainer, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline), shape = RoundedCornerShape(8.dp)) { Text(it, Modifier.padding(12.dp)) } } }
        error?.let { item { Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(8.dp)) { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) } } }
        if (audio["available"]?.jsonPrimitive?.booleanOrNull == true) item { OutlinedPanel("Sound") { Row(verticalAlignment = Alignment.CenterVertically) { Text("${audio["percent"]?.jsonPrimitive?.intOrNull ?: 0}%${if (audio["muted"]?.jsonPrimitive?.booleanOrNull == true) " · Muted" else ""}", color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f)); OutlinedButton({ execute("audio.mute", buildJsonObject {}, if (audio["muted"]?.jsonPrimitive?.booleanOrNull == true) "Unmute output" else "Mute output") }, enabled = "audio.mute" in actionNames) { Text(if (audio["muted"]?.jsonPrimitive?.booleanOrNull == true) "Unmute" else "Mute") } } } }
        if (media["available"]?.jsonPrimitive?.booleanOrNull == true) item { OutlinedPanel("Playback") { Text(listOfNotNull(media["name"]?.jsonPrimitive?.contentOrNull, media["status"]?.jsonPrimitive?.contentOrNull).joinToString(" · "), color = MaterialTheme.colorScheme.primary); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("Previous","PlayPause","Next","Stop").forEach { command -> OutlinedButton({ execute("media.control", buildJsonObject { put("command", command); media["player"]?.jsonPrimitive?.contentOrNull?.let { put("player", it) } }, command) }, enabled = "media.control" in actionNames) { Text(command) } } } } }
        if (filteredWindows.isNotEmpty()) item { Text("Windows", style = MaterialTheme.typography.titleMedium) }
        items(filteredWindows.take(30)) { item -> val value=item.jsonObject; OutlinedPanel(value["title"]?.jsonPrimitive?.contentOrNull ?: "Untitled") { Text("${value["app"]?.jsonPrimitive?.contentOrNull.orEmpty()} · Workspace ${value["workspace"]?.jsonPrimitive?.contentOrNull.orEmpty()}", color=MaterialTheme.colorScheme.onSurfaceVariant); OutlinedButton({ execute("windows.focus", buildJsonObject { put("address", value["address"]!!.jsonPrimitive.content) }, "Focus window") }, enabled="windows.focus" in actionNames) { Text("Focus") } } }
        if (filteredApps.isNotEmpty()) item { Text("Applications", style = MaterialTheme.typography.titleMedium) }
        items(filteredApps.take(30)) { item -> val value=item.jsonObject; OutlinedPanel(value["name"]?.jsonPrimitive?.contentOrNull ?: "Application") { OutlinedButton({ execute("apps.launch", buildJsonObject { put("desktopId", value["id"]!!.jsonPrimitive.content) }, "Open ${value["name"]?.jsonPrimitive?.contentOrNull.orEmpty()}") }, enabled="apps.launch" in actionNames) { Text("Open") } } }
        if (apps.isEmpty() && windows.isEmpty()) item { Text("No granted app or window categories are available for this project.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable private fun OutlinedPanel(title: String, content: @Composable ColumnScope.() -> Unit) { Surface(color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline), shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(title, fontWeight = FontWeight.SemiBold); content() } } }

@Composable
private fun MemoryScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity) {
    val readable = state.supports("memory.list") || state.supports("memory.retrieve")
    if (!readable) return EmptyState(Icons.Default.Lock, "Memory is not granted", "Enable scoped memory access from Desktop Settings.")
    val scope = rememberCoroutineScope(); val sessions = state.sessions.filter { it.provider == "ollama" }
    var sessionId by rememberSaveable { mutableStateOf(sessions.firstOrNull()?.id.orEmpty()) }; var kind by rememberSaveable { mutableStateOf("saved") }
    var filter by rememberSaveable { mutableStateOf("") }; var query by rememberSaveable { mutableStateOf("") }; var offset by rememberSaveable { mutableIntStateOf(0) }
    var result by remember { mutableStateOf<JsonObject?>(null) }; var loading by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var adding by remember { mutableStateOf(false) }
    var managedRecord by remember { mutableStateOf<JsonObject?>(null) }; var managing by remember { mutableStateOf(false) }; var clearProject by remember { mutableStateOf(false) }
    val sessionIds = sessions.map(Session::id)
    fun clearVisibleMemory() { result = null; managedRecord = null; managing = false; clearProject = false; adding = false; error = null; offset = 0 }
    LaunchedEffect(state.cacheEpoch) { clearVisibleMemory(); filter = ""; query = "" }
    LaunchedEffect(sessionIds) { if (sessionId !in sessionIds) { clearVisibleMemory(); filter = ""; query = ""; sessionId = sessionIds.firstOrNull().orEmpty() } }
    LaunchedEffect(sessionId) { result = null; managedRecord = null; managing = false; clearProject = false; adding = false; error = null }
    fun list() { if (sessionId.isBlank() || !state.supports("memory.list")) return; scope.launch { loading = true; error = null; runCatching { repository.request("memory.list", buildJsonObject { put("sessionId", sessionId); put("kind", kind); put("offset", offset); put("filter", filter.trim()) }).jsonObject }.onSuccess { result = it }.onFailure { error = it.message }; loading = false } }
    fun retrieve() { if (sessionId.isBlank() || query.isBlank() || !state.supports("memory.retrieve")) return; scope.launch { loading = true; error = null; runCatching { repository.request("memory.retrieve", buildJsonObject { put("sessionId", sessionId); put("query", query.trim()) }).jsonObject }.onSuccess { result = it }.onFailure { error = it.message }; loading = false } }
    LaunchedEffect(sessionId, kind, offset, state.cacheEpoch) { if (sessionId.isNotBlank() && state.supports("memory.list")) list() }
    val rows = result?.get("rows")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }; val total = result?.get("total")?.jsonPrimitive?.intOrNull ?: rows.size
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("Project memory", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() }); Text("Review memory within the selected Ollama session's approved project.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (sessions.isEmpty()) item { OutlinedPanel("No Ollama sessions") { Text("Create an Ollama session in an approved project before opening memory.", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        else item { Text("Session", fontWeight = FontWeight.Medium); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { sessions.forEach { session -> val project = state.projects.firstOrNull { it.id == session.projectId }; FilterChip(sessionId == session.id, { sessionId = session.id; offset = 0 }, { Column { Text(session.title); Text(project?.name ?: session.project.orEmpty(), style = MaterialTheme.typography.labelSmall) } }) } }; sessions.firstOrNull { it.id == sessionId }?.let { session -> val project = state.projects.firstOrNull { it.id == session.projectId }; OutlinedPanel(project?.name ?: "Approved project") { SelectionContainer { Text(project?.path ?: session.project ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) }; Text("Ollama · ${session.ollamaHost.ifBlank { state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable" }}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
        if (state.supports("memory.list")) item { Text("Browse", style = MaterialTheme.typography.titleMedium); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("saved" to "Saved", "conversation" to "Conversation", "assertions" to "Assertions", "episodes" to "Episodes", "entities" to "Entities").forEach { (id,label) -> FilterChip(kind == id, { kind = id; offset = 0 }, { Text(label) }) } }; Row(verticalAlignment = Alignment.CenterVertically) { OutlinedTextField(filter, { filter = it }, placeholder = { Text("Find text in memory") }, singleLine = true, modifier = Modifier.weight(1f)); Spacer(Modifier.width(8.dp)); OutlinedButton({ offset = 0; list() }, enabled = !loading) { Text("Find") } } }
        if (state.supports("memory.retrieve")) item { Text("Recall", style = MaterialTheme.typography.titleMedium); Row(verticalAlignment = Alignment.CenterVertically) { OutlinedTextField(query, { query = it.take(1000) }, placeholder = { Text("Ask what Cere remembers") }, singleLine = true, modifier = Modifier.weight(1f)); Spacer(Modifier.width(8.dp)); OutlinedButton(::retrieve, enabled = query.isNotBlank() && !loading) { Text("Recall") } } }
        if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        items(rows, key = { it["id"]?.jsonPrimitive?.contentOrNull ?: it.toString() }) { row ->
            MemoryRow(row, if (state.supports("memory.forgetPreview")) ({ managedRecord = row; managing = true }) else null)
        }
        if (!loading && result != null && rows.isEmpty()) item { Text("No matching memory records.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        result?.takeIf { "rows" !in it }?.let { value -> item { StructuredObject(value) } }
        if (result?.containsKey("rows") == true) item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { OutlinedButton({ offset = (offset - 25).coerceAtLeast(0) }, enabled = offset > 0 && !loading) { Text("Previous") }; Text("$total total", color = MaterialTheme.colorScheme.onSurfaceVariant); OutlinedButton({ offset += 25 }, enabled = offset + 25 < total && !loading) { Text("Next") } } }
        if (state.supports("memory.save") && sessions.isNotEmpty()) item { Button({ adding = true }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Add, null); Spacer(Modifier.width(8.dp)); Text("Remember a fact") } }
        if (state.supports("memory.forgetPreview") && state.supports("memory.clear") && sessions.isNotEmpty()) item { OutlinedButton({ clearProject = true }, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error), modifier = Modifier.fillMaxWidth()) { Text("Clear this project's memory") } }
    }
    if (adding) { var text by remember { mutableStateOf("") }; var saveError by remember { mutableStateOf<String?>(null) }; AlertDialog(onDismissRequest = { adding = false }, title = { Text("Remember a fact") }, text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(text, { text = it.take(2000) }, minLines = 5, label = { Text("Fact") }, modifier = Modifier.fillMaxWidth()); Text("${text.length} / 2000", color = MaterialTheme.colorScheme.onSurfaceVariant); saveError?.let { Text(it, color = MaterialTheme.colorScheme.error) } } }, confirmButton = { Button({ scope.launch { runCatching { val action = repository.prepareAction("memory.save", buildJsonObject { put("sessionId", sessionId); put("text", text.trim()) }); authenticate(activity, "Save this memory", action, repository, { adding = false; offset = 0; list() }, { saveError = it }) }.onFailure { saveError = it.message } } }, enabled = text.isNotBlank()) { Text("Review & save") } }, dismissButton = { TextButton({ adding = false }) { Text("Cancel") } }) }
    if (managing) managedRecord?.let { record -> MemoryRecordSheet(repository, state, activity, sessionId, record, { managing = false; managedRecord = null }, { list() }) }
    if (clearProject) MemoryRecordSheet(repository, state, activity, sessionId, null, { clearProject = false }, { list() })
}

@Composable
private fun SettingsScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity) {
    val context = LocalContext.current; val scope = rememberCoroutineScope(); var confirmForget by remember { mutableStateOf(false) }; var showMemory by rememberSaveable { mutableStateOf(false) }
    var remoteSettings by remember { mutableStateOf(state.settings) }; var personality by rememberSaveable { mutableStateOf("") }; var defaultModel by rememberSaveable { mutableStateOf("") }; var searchProvider by rememberSaveable { mutableStateOf("auto") }; var settingsDirty by rememberSaveable { mutableStateOf(false) }; var settingsConflict by rememberSaveable { mutableStateOf(false) }; var baselineRevision by rememberSaveable { mutableStateOf("0") }; var loading by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var feedback by remember { mutableStateOf<String?>(null) }
    val permissions = state.permissions; val paused = permissions["paused"]?.jsonPrimitive?.booleanOrNull == true; val categories = permissions["categories"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }; val caps = permissions["caps"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
    fun applySettings(value: JsonObject) { remoteSettings = value; personality = value["personality"]?.jsonPrimitive?.contentOrNull.orEmpty(); defaultModel = value["defaultModel"]?.jsonPrimitive?.contentOrNull.orEmpty(); searchProvider = value["webSearch"]?.jsonObject?.get("provider")?.jsonPrimitive?.contentOrNull ?: "auto"; baselineRevision = value["revision"]?.jsonPrimitive?.contentOrNull ?: "0"; settingsDirty = false; settingsConflict = false }
    fun receiveSettings(value: JsonObject) { val revision = value["revision"]?.jsonPrimitive?.contentOrNull ?: "0"; if (settingsDirty && revision != baselineRevision) { remoteSettings = value; settingsConflict = true } else if (!settingsDirty) applySettings(value) }
    LaunchedEffect(state.settings, state.connection is ConnectionState.Online) { if (state.supports("settings.get")) { loading = true; runCatching { repository.request("settings.get", buildJsonObject {}).jsonObject }.onSuccess(::receiveSettings).onFailure { error = it.message }; loading = false } else receiveSettings(state.settings) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val localNetworkPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) ContextCompat.startForegroundService(context, Intent(context, MonitoringService::class.java)) }
    if (showMemory) { Column(Modifier.fillMaxSize()) { Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) { IconButton({ showMemory = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to settings") }; Text("Settings", style = MaterialTheme.typography.titleMedium) }; MemoryScreen(repository, state, activity) }; return }
    LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("Desktop policy", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() }) }
        item { OutlinedPanel(if (paused) "Actions paused" else "${permissions["profile"]?.jsonPrimitive?.contentOrNull ?: "Scoped"} access") { Text(if (paused) "The desktop is currently blocking remote actions." else "This phone can use only the capabilities negotiated at sign-in.", color = if (paused) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant); if (categories.isNotEmpty()) Text("Categories · ${categories.joinToString()}", style = MaterialTheme.typography.bodySmall); if (caps.isNotEmpty()) Text("Capabilities · ${caps.joinToString()}", style = MaterialTheme.typography.bodySmall); if (!paused && state.supports("permissions.pause")) OutlinedButton({ scope.launch { runCatching { repository.mutate("permissions.pause", buildJsonObject {}) }.onSuccess { feedback = "Desktop actions paused" }.onFailure { error = it.message } } }, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Pause desktop actions") } } }
        if (state.supports("permissions.reduce") && state.supports("devices.self")) item {
            PermissionReductionPanel(repository, state, { feedback = it }, { error = it })
        }
        if (state.supports("settings.get")) item { Spacer(Modifier.height(4.dp)); Text("Assistant", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() }) }
        if (state.supports("settings.get")) item { OutlinedPanel("Defaults") { if (settingsConflict) { Text("Desktop settings changed while you were editing. Your values are preserved.", color = MaterialTheme.colorScheme.tertiary); Row { TextButton({ applySettings(remoteSettings) }) { Text("Reload desktop") }; TextButton({ baselineRevision = remoteSettings["revision"]?.jsonPrimitive?.contentOrNull ?: baselineRevision; settingsConflict = false }) { Text("Keep mine") } } }; OutlinedTextField(personality, { personality = it.take(8000); settingsDirty = true }, label = { Text("Personality") }, minLines = 3, modifier = Modifier.fillMaxWidth()); if (!remoteSettings["ollamaHost"]?.jsonPrimitive?.contentOrNull.isNullOrBlank()) OutlinedTextField(defaultModel, { defaultModel = it.take(512); settingsDirty = true }, label = { Text("Default Ollama model") }, singleLine = true, modifier = Modifier.fillMaxWidth()); Text("Web search provider", style = MaterialTheme.typography.labelLarge); FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf("auto","duckduckgo","brave","mojeek","searxng").forEach { provider -> FilterChip(searchProvider == provider, { searchProvider = provider; settingsDirty = true }, { Text(provider) }) } }; if (state.supports("settings.patch")) Button({ scope.launch { runCatching { val action = repository.prepareAction("settings.patch", assistantSettingsPatch(remoteSettings, baselineRevision, personality, defaultModel, searchProvider)); authenticate(activity, "Update assistant settings", action, repository, { value -> applySettings(value.jsonObject); feedback = "Settings updated" }, { error = it }) }.onFailure { error = it.message } } }, enabled = !loading && !settingsConflict && settingsDirty, modifier = Modifier.fillMaxWidth()) { Text("Review & save") } else Text("This device has read-only settings access.", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        if (state.supports("memory.list") || state.supports("memory.retrieve")) item { OutlinedPanel("Project memory") { Text("Browse saved facts, conversation passages, assertions, episodes, and entities for an approved Ollama session.", color = MaterialTheme.colorScheme.onSurfaceVariant); OutlinedButton({ showMemory = true }) { Icon(Icons.Default.Star, null); Spacer(Modifier.width(8.dp)); Text("Open memory") } } }
        if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        feedback?.let { item { Text(it, color = MaterialTheme.colorScheme.primary) } }; error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        item { HorizontalDivider(); Spacer(Modifier.height(8.dp)); Text("Phone", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() }) }
        item { OutlinedPanel("Desktop connection") {
            when (val connection = state.connection) {
                is ConnectionState.Online -> Text("Connected to ${connection.desktopName}", color = MaterialTheme.colorScheme.primary)
                is ConnectionState.Offline -> {
                    Text(connection.reason, style = MaterialTheme.typography.bodySmall)
                    Text("Check that the PC is awake and reachable over Wi-Fi or your VPN. After a Wi-Fi address change, the PC firewall may still allow the phone's previous address.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(repository::retry) { Text("Retry connection") }
                }
                else -> Text("Connecting to your paired desktop…")
            }
        } }

        item { ListItem(headlineContent = { Text("Monitor desktop") }, supportingContent = { Text("Keeps a private foreground notification and reconnects with backoff") }, trailingContent = { Switch(state.monitoring, { enabled -> if (enabled) { if (Build.VERSION.SDK_INT >= 33 && !NotificationManagerCompat.from(context).areNotificationsEnabled()) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS); if (Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(context, "android.permission.ACCESS_LOCAL_NETWORK") != android.content.pm.PackageManager.PERMISSION_GRANTED) localNetworkPermission.launch("android.permission.ACCESS_LOCAL_NETWORK") else ContextCompat.startForegroundService(context, Intent(context, MonitoringService::class.java)) } else context.stopService(Intent(context, MonitoringService::class.java)) }) }) }
        item { ListItem(headlineContent = { Text("Notification controls") }, supportingContent = { Text("Lock-screen content is redacted") }, modifier = Modifier.clickable { context.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, MonitoringService.CHANNEL)) }) }
        item { HorizontalDivider(); Spacer(Modifier.height(8.dp)); MobileMaintenanceSection() }
        item { ListItem(headlineContent = { Text(state.desktop?.desktopName.orEmpty()) }, supportingContent = { Text("Device ${state.desktop?.deviceId?.take(8)} · pinned TLS identity") }, leadingContent = { Icon(Icons.Default.Home, null) }) }
        item { OutlinedButton({ confirmForget = true }, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Forget this desktop") } }
    }
    if (confirmForget) AlertDialog(onDismissRequest = { confirmForget = false }, title = { Text("Forget desktop?") }, text = { Text("This removes the encrypted cache and both phone keys. Pairing is required again.") }, confirmButton = { Button({ scope.launch { repository.forget() } }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Forget") } }, dismissButton = { TextButton({ confirmForget = false }) { Text("Cancel") } })
}

@Composable
private fun PermissionReductionPanel(repository: CereRepository, state: MobileState, onFeedback: (String) -> Unit, onError: (String?) -> Unit) {
    val scope = rememberCoroutineScope()
    var device by remember { mutableStateOf<JsonObject?>(null) }
    var selectedCaps by remember { mutableStateOf(setOf<String>()) }
    var selectedCategories by remember { mutableStateOf(setOf<String>()) }
    var selectedScripts by remember { mutableStateOf(setOf<String>()) }
    var selectedProjects by remember { mutableStateOf(setOf<String>()) }
    var selectedHosts by remember { mutableStateOf(setOf<String>()) }
    var review by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    val pending = state.pendingCommands.any { it.method == "permissions.reduce" }
    val scopeVersion = device?.get("scopeVersion")?.jsonPrimitive?.contentOrNull
    fun strings(key: String) = device?.get(key)?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
    val caps = strings("caps"); val categories = strings("categories"); val scripts = strings("scriptIds"); val hosts = strings("ollamaHosts")
    val projects = device?.get("projects")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }
    LaunchedEffect(state.connection is ConnectionState.Online, pending) {
        if (!state.supports("devices.self")) return@LaunchedEffect
        loading = true
        runCatching { repository.request("devices.self", buildJsonObject {}).jsonObject }
            .onSuccess { value ->
                device = value
                selectedCaps = value["caps"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
                selectedCategories = value["categories"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
                selectedScripts = value["scriptIds"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
                selectedProjects = value["projects"]?.jsonArray.orEmpty().mapNotNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull }.toSet()
                selectedHosts = value["ollamaHosts"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
            }.onFailure { onError(it.message) }
        loading = false
    }
    val removedCaps = caps.filterNot { it in selectedCaps }; val removedCategories = categories.filterNot { it in selectedCategories }
    val removedScripts = scripts.filterNot { it in selectedScripts }; val removedHosts = hosts.filterNot { it in selectedHosts }
    val removedProjects = projects.filter { it["id"]?.jsonPrimitive?.contentOrNull !in selectedProjects }
    val changed = removedCaps.isNotEmpty() || removedCategories.isNotEmpty() || removedScripts.isNotEmpty() || removedProjects.isNotEmpty() || removedHosts.isNotEmpty()
    OutlinedPanel("Reduce this phone's access") {
        Text("You can remove existing device and project grants here. Adding access still requires the desktop.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        fun toggle(value: String, values: Set<String>, update: (Set<String>) -> Unit) = update(if (value in values) values - value else values + value)
        if (projects.isNotEmpty()) { Text("Projects", style = MaterialTheme.typography.labelLarge); FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { projects.forEach { project -> val id = project["id"]?.jsonPrimitive?.contentOrNull ?: return@forEach; val name = project["name"]?.jsonPrimitive?.contentOrNull ?: project["path"]?.jsonPrimitive?.contentOrNull ?: id; FilterChip(id in selectedProjects, { toggle(id, selectedProjects) { selectedProjects = it } }, { Text(name) }, enabled = !pending) } } }
        if (categories.isNotEmpty()) { Text("Action categories", style = MaterialTheme.typography.labelLarge); FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { categories.forEach { value -> FilterChip(value in selectedCategories, { toggle(value, selectedCategories) { selectedCategories = it } }, { Text(value) }, enabled = !pending) } } }
        if (caps.isNotEmpty()) { Text("Capabilities", style = MaterialTheme.typography.labelLarge); FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { caps.forEach { value -> FilterChip(value in selectedCaps, { toggle(value, selectedCaps) { selectedCaps = it } }, { Text(value) }, enabled = !pending) } } }
        if (scripts.isNotEmpty()) { Text("Scripts", style = MaterialTheme.typography.labelLarge); FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { scripts.forEach { value -> FilterChip(value in selectedScripts, { toggle(value, selectedScripts) { selectedScripts = it } }, { Text(value) }, enabled = !pending) } } }
        if (hosts.isNotEmpty()) { Text("Ollama hosts", style = MaterialTheme.typography.labelLarge); FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { hosts.forEach { value -> FilterChip(value in selectedHosts, { toggle(value, selectedHosts) { selectedHosts = it } }, { Text(value) }, enabled = !pending) } } }
        if (pending) Text("Waiting for the desktop to confirm the access reduction after reconnect…", color = MaterialTheme.colorScheme.tertiary)
        Button({ review = true }, enabled = changed && scopeVersion != null && !pending && !loading) { Text("Review reduced access") }
    }
    if (review && scopeVersion != null) AlertDialog(onDismissRequest = { review = false }, title = { Text("Remove these grants?") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("This only removes access. Active remote work is stopped and this phone reconnects with the new scope.")
            removedProjects.forEach { Text("Project · ${it["name"]?.jsonPrimitive?.contentOrNull ?: it["path"]?.jsonPrimitive?.contentOrNull ?: it["id"]?.jsonPrimitive?.contentOrNull}") }
            removedCategories.forEach { Text("Category · $it") }; removedCaps.forEach { Text("Capability · $it") }
            removedScripts.forEach { Text("Script · $it") }; removedHosts.forEach { Text("Ollama host · $it") }
        }
    }, confirmButton = { Button({
        review = false
        val params = buildJsonObject {
            put("expectedScopeVersion", scopeVersion)
            put("caps", JsonArray(selectedCaps.sorted().map(::JsonPrimitive)))
            put("categories", JsonArray(selectedCategories.sorted().map(::JsonPrimitive)))
            put("scriptIds", JsonArray(selectedScripts.sorted().map(::JsonPrimitive)))
            put("projectIds", JsonArray(selectedProjects.sorted().map(::JsonPrimitive)))
            put("ollamaHosts", JsonArray(selectedHosts.sorted().map(::JsonPrimitive)))
        }
        scope.launch { runCatching { repository.mutate("permissions.reduce", params) }
            .onSuccess { onFeedback("Access reduced. Reconnecting with the new grants…") }
            .onFailure { failure -> if (failure is CommandPendingException) onFeedback("Access reduction is pending desktop reconciliation…") else onError(failure.message) } }
    }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Reduce access & reconnect") } }, dismissButton = { TextButton({ review = false }) { Text("Cancel") } })
}

@Composable private fun MemoryRow(row: JsonObject, manage: (() -> Unit)? = null) { OutlinedPanel(row["text"]?.jsonPrimitive?.contentOrNull ?: row["name"]?.jsonPrimitive?.contentOrNull ?: "Memory record") { val detail = listOfNotNull(row["kind"]?.jsonPrimitive?.contentOrNull, row["status"]?.jsonPrimitive?.contentOrNull, row["state"]?.jsonPrimitive?.contentOrNull, row["updated"]?.jsonPrimitive?.contentOrNull).joinToString(" · "); if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant); val remaining = JsonObject(row.filterKeys { it !in setOf("id","text","name","kind","status","state","updated","revision") }); if (remaining.isNotEmpty()) StructuredObject(remaining); manage?.let { OutlinedButton(it) { Text("Inspect or forget") } } } }

@Composable private fun StructuredObject(value: JsonObject) { Column(verticalArrangement = Arrangement.spacedBy(5.dp)) { value.forEach { (key, item) -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { Text(key.replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.widthIn(min = 88.dp)); SelectionContainer { Text(if (item is JsonPrimitive) item.content else item.toString(), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f)) } } } } }

private fun authenticate(activity: FragmentActivity, title: String, action: PreparedAction, repository: CereRepository, success: (JsonElement) -> Unit, failure: (String) -> Unit) {
    val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            activity.lifecycleScope.launch {
                runCatching { repository.completeAction(action, repository.signAuthenticated(action)) }.onSuccess(success).onFailure { failure(it.message ?: "Action failed") }
            }
        }
        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { failure(errString.toString()) }
    })
    prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle("Confirm the exact action shown")
        .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG or androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL).build(), BiometricPrompt.CryptoObject(action.signature))
}

@Composable private fun EmptyState(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, detail: String) { Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) { Icon(icon, null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(48.dp)); Spacer(Modifier.height(14.dp)); Text(title, style = MaterialTheme.typography.titleLarge, textAlign = androidx.compose.ui.text.style.TextAlign.Center); Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center) } }
@Composable private fun ProviderMark(provider: String) { Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.size(42.dp)) { Box(contentAlignment = Alignment.Center) { Text(provider.take(1).uppercase(), fontWeight = FontWeight.Bold) } } }
@Composable private fun StatusPill(status: String) {
    val normalized = status.lowercase()
    Surface(shape = RoundedCornerShape(20.dp), color = when {
        "waiting" in normalized || "input" in normalized -> MaterialTheme.colorScheme.tertiaryContainer
        "active" in normalized || "working" in normalized || "tools" in normalized -> MaterialTheme.colorScheme.secondaryContainer
        "error" in normalized || "failed" in normalized -> MaterialTheme.colorScheme.errorContainer
        else -> MaterialTheme.colorScheme.surface
    }, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Text(status.replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp))
    }
}

@Composable private fun Markdown(value: String) = CereMarkdown(value)
