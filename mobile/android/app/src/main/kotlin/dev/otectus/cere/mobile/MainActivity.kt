package dev.otectus.cere.mobile

import android.Manifest
import android.content.*
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import dev.otectus.cere.mobile.data.*
import dev.otectus.cere.mobile.protocol.*
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

open class MainActivity : FragmentActivity() {
    private val repository get() = (application as CereApp).repository
    private val launch = mutableStateOf<LaunchRequest?>(null)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A share or notification tap is handled once. After rotation or process death it
        // is replayed only if it had not been handled yet.
        if (savedInstanceState?.getBoolean(LAUNCH_HANDLED) != true) launch.value = launchRequest(intent)
        setContent {
            CereTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                        CereRoot(repository, this@MainActivity, launch.value) { launch.value = null }
                    }
                }
            }
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); launch.value = launchRequest(intent) }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); outState.putBoolean(LAUNCH_HANDLED, launch.value == null) }
    override fun onStart() { super.onStart(); repository.setVisible(true) }
    override fun onStop() { repository.setVisible(false); super.onStop() }

    private fun launchRequest(intent: Intent?): LaunchRequest? = when (intent?.action) {
        Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> sharedImages(intent).takeIf { it.isNotEmpty() }?.let { LaunchRequest.Share(it) }
        ACTION_REVIEW -> intent.getStringExtra(EXTRA_APPROVAL_ID)?.let { LaunchRequest.Review(it) }
        ACTION_OPEN_SESSION -> intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf(String::isNotBlank)?.let { LaunchRequest.OpenSession(it) }
        ACTION_OPEN_DESKTOP -> LaunchRequest.OpenDesktop
        else -> null
    }
    @Suppress("DEPRECATION")
    private fun sharedImages(intent: Intent): List<Uri> {
        if (intent.type?.startsWith("image/") != true) return emptyList()
        val uris: List<Uri> = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        } else listOfNotNull(if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        // Only content another app shares is imported, never a file path.
        return uris.filter { it.scheme == ContentResolver.SCHEME_CONTENT }.take(4)
    }

    companion object {
        const val ACTION_REVIEW = "dev.otectus.cere.mobile.REVIEW"
        const val ACTION_OPEN_SESSION = "dev.otectus.cere.mobile.OPEN_SESSION"
        const val ACTION_OPEN_DESKTOP = "dev.otectus.cere.mobile.OPEN_DESKTOP"
        const val EXTRA_APPROVAL_ID = "approvalId"
        const val EXTRA_SESSION_ID = "sessionId"
        private const val LAUNCH_HANDLED = "launchHandled"
    }
}

/** What the activity was opened for: shared images or a notification tap. */
internal sealed interface LaunchRequest {
    data class Share(val uris: List<Uri>) : LaunchRequest
    data class Review(val approvalId: String) : LaunchRequest
    data class OpenSession(val sessionId: String) : LaunchRequest
    data object OpenDesktop : LaunchRequest
}

private fun startMonitoring(context: Context) { ContextCompat.startForegroundService(context, Intent(context, MonitoringService::class.java)) }
private fun openNotificationSettings(context: Context) { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }

@Composable
private fun CereRoot(repository: CereRepository, activity: FragmentActivity, launch: LaunchRequest?, consumeLaunch: () -> Unit) {
    val state by repository.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.restoreReady, state.desktop?.deviceId, state.stagedPairing?.desktop?.deviceId) {
        if (state.restoreReady && state.desktop != null && state.stagedPairing == null && activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) repository.connectWhileOpen()
    }
    when {
        !state.restoreReady && state.connection !is ConnectionState.Blocked -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        state.stagedPairing != null -> PairingScreen(repository, state, activity, state.desktop)
        state.desktop == null && state.connection is ConnectionState.Blocked -> UnreadableCacheScreen(repository, activity, state.connection as ConnectionState.Blocked)
        state.desktop == null -> PairingScreen(repository, state, activity)
        state.connection is ConnectionState.Blocked -> BlockedScreen(repository, state, activity, state.connection as ConnectionState.Blocked)
        else -> AppShell(repository, state, activity, launch, consumeLaunch)
    }
}

/** A connection that stopped retrying. Only a broken pairing offers re-pairing, and replacement keeps drafts. */
/** The private cache could not be read: locked (retry after unlock), or damaged or keyless (remove and pair again). */
@Composable
private fun UnreadableCacheScreen(repository: CereRepository, activity: FragmentActivity, blocked: ConnectionState.Blocked) {
    var confirm by rememberSaveable { mutableStateOf(false) }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 600.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Surface(shape = RoundedCornerShape(20.dp), color = if (blocked.repair) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.tertiaryContainer) {
                Icon(Icons.Default.Lock, null, tint = if (blocked.repair) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(18.dp).size(36.dp))
            }
            Text(if (blocked.repair) "Private data can't be read" else "Unlock private cache", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            Text(
                if (blocked.repair) "Cere stopped before opening anything private on this phone." else "Unlock this phone, then ask Cere to open its encrypted cache again.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            SecureStatusPanel(if (blocked.repair) "Encrypted cache unavailable" else "Phone is still locked", blocked.reason, tone = if (blocked.repair) SecureTone.Danger else SecureTone.Attention)
            if (blocked.repair) {
                Text("Removing the unreadable cache is the only recovery on this phone. The desktop pairing must also be revoked before you reconnect.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button({ confirm = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Remove and pair again") }
            } else {
                Button(repository::retry, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Retry") }
            }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text("Remove unreadable data?") },
        text = { Text("Cere Mobile cannot read its private data on this phone. Removing it lets you pair again; anything in it, including unsent drafts, is already unreadable. On the desktop, revoke the old pairing for this phone.") },
        confirmButton = { Button({ confirm = false; activity.lifecycleScope.launch { runCatching { repository.discardUnreadableCache() } } }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Remove") } },
        dismissButton = { TextButton({ confirm = false }) { Text("Cancel") } })
}

@Composable
private fun BlockedScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity, blocked: ConnectionState.Blocked) {
    val scope = rememberCoroutineScope()
    var replacing by rememberSaveable { mutableStateOf(false) }
    var confirmForget by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val desktop = state.desktop
    if (replacing && desktop != null) { PairingScreen(repository, state, activity, desktop) { replacing = false }; return }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.tertiaryContainer) {
                Icon(Icons.Default.Lock, null, tint = MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(18.dp).size(36.dp))
            }
            Text(if (blocked.repair) "Pairing needs attention" else "Can't connect to the desktop", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            SecureStatusPanel(if (blocked.repair) "Secure connection needs repair" else "Desktop unavailable", blocked.reason, tone = SecureTone.Attention)
            Button(repository::retry, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Retry") }
            if (blocked.repair) {
                if (state.pendingCommands.isNotEmpty()) {
                    OutlinedPanel("Check before repairing") {
                        Text("These desktop actions were never confirmed. Check them on the PC before replacing the pairing:", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        state.pendingCommands.forEach { Text("• ${CommandOutcomes.describe(it)}", style = MaterialTheme.typography.bodySmall) }
                        OutlinedButton({ scope.launch { runCatching { repository.releaseForRepair() }.onFailure { error = it.message } } }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("I've checked them on the PC") }
                    }
                }
                Text("Replacing keeps this phone's encrypted conversations, drafts, and local images.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton({ replacing = true }, enabled = desktop != null && repository.replacementBlocker() == null, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Replace pairing · keeps drafts") }
                TextButton({ confirmForget = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Remove phone pairing and pair again") }
            } else Text("Check the desktop and try again. Your conversations and drafts stay on this phone.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            error?.let { SecureStatusPanel("Repair couldn't continue", it, tone = SecureTone.Danger) }
        }
    }
    if (confirmForget) AlertDialog(onDismissRequest = { confirmForget = false }, title = { Text("Remove this pairing?") },
        text = { Text("This erases this phone's encrypted conversations, drafts, images and keys for this desktop. Replace pairing keeps them.") },
        confirmButton = { Button({ confirmForget = false; activity.lifecycleScope.launch { repository.forget() } }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Remove") } },
        dismissButton = { TextButton({ confirmForget = false }) { Text("Cancel") } })
}

@Composable
private fun PairingScreen(
    repository: CereRepository,
    state: MobileState,
    activity: FragmentActivity,
    replacing: PairedDesktop? = null,
    onCancel: (() -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    var raw by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var scan by rememberSaveable { mutableStateOf(false) }
    var enteringOffer by rememberSaveable { mutableStateOf(false) }
    var showResponseText by rememberSaveable { mutableStateOf(false) }
    var showManual by rememberSaveable { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    var savePrompt by remember { mutableStateOf<CompletedPairing?>(null) }
    val result = state.stagedPairing
    var unstaged by remember { mutableStateOf<CompletedPairing?>(null) }
    var deviceName by rememberSaveable { mutableStateOf(Build.MODEL.take(48).ifBlank { "Android phone" }) }
    val returning by repository.pairingReturn.collectAsStateWithLifecycle()
    BackHandler(enabled = scan) { scan = false }
    BackHandler(enabled = !scan && onCancel != null) { onCancel?.invoke() }
    LaunchedEffect(state.restoreReady, state.desktop?.deviceId, result?.desktop?.deviceId, unstaged?.desktop?.deviceId) {
        // What to keep is read from the repository when pruning runs, not from this frame: a pairing
        // that was just staged is there before this screen's collected state shows it, and clearing
        // `unstaged` in between must not delete its brand-new keys.
        val keep = unstaged?.desktop
        withContext(Dispatchers.IO) { val now = repository.state.value; repository.pairingManager().pruneUncommitted(now.restoreReady, now.desktop, now.stagedPairing?.desktop, keep) }
    }
    fun finishPairing(completed: CompletedPairing) { scope.launch { runCatching { repository.completePairing(completed); startMonitoring(activity); onCancel?.invoke() }.onFailure { error = it.message } } }
    // Alerts and (Android 17) local-network access are asked for before the phone first contacts the
    // PC, so approvals can reach a locked phone and the answer can travel. Declining alerts doesn't stop pairing.
    var afterPermissions by remember { mutableStateOf<(() -> Unit)?>(null) }
    val localNetworkPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val next = afterPermissions; afterPermissions = null
        if (granted) next?.invoke() else error = "Local network permission is required to connect to Cere Desktop."
    }
    fun withLocalNetwork(then: () -> Unit) {
        if (Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(activity, "android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) { afterPermissions = then; localNetworkPermission.launch("android.permission.ACCESS_LOCAL_NETWORK") }
        else then()
    }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> val next = afterPermissions; afterPermissions = null; next?.let(::withLocalNetwork) }
    fun withPermissions(then: () -> Unit) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) { afterPermissions = then; notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
        else withLocalNetwork(then)
    }
    val networkReturn = result?.responseReturn == "network"
    fun sendAnswer(completed: CompletedPairing) = withPermissions { repository.startPairingReturn(completed) }
    fun stagePairing(completed: CompletedPairing) { scope.launch {
        unstaged = completed
        runCatching { repository.stagePairing(completed) }
            .onSuccess { unstaged = null; if (completed.responseReturn == "network") sendAnswer(completed) }
            .onFailure { error = "Could not seal the pairing response. Unlock the phone and retry: ${it.message}" }
    } }
    // After a restart with an answer staged, delivery resumes where the permissions already allow it.
    LaunchedEffect(result?.desktop?.deviceId) {
        val staged = result ?: return@LaunchedEffect
        val allowed = Build.VERSION.SDK_INT < 37 || ContextCompat.checkSelfPermission(activity, "android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED
        if (staged.responseReturn == "network" && allowed) repository.startPairingReturn(staged)
    }
    // The desktop confirmed this answer: save the pairing and connect.
    LaunchedEffect(returning, result?.desktop?.deviceId) { if (returning == PairingReturnState.Confirmed) result?.let(::finishPairing) }
    // The manual route: the desktop is asked first, so a pairing it never confirmed is not kept.
    fun desktopConfirmed(completed: CompletedPairing) { checking = true; error = null; scope.launch {
        try {
            when (val reply = repository.checkPairingConfirmed(completed)) {
                PairingReply.Confirmed -> withPermissions { finishPairing(completed) }
                PairingReply.Received -> error = "Your PC has this answer. Check that it shows these six words, then confirm there."
                is PairingReply.Closed -> error = if (reply.reason == "refused") "Your PC hasn't confirmed this pairing yet. Paste the response there, compare the six words and confirm, then try again." else reply.message
                null -> savePrompt = completed
            }
        } finally { checking = false }
    } }
    val clipboard = LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)

    fun prepare(value: String) {
        var created: PendingPairing? = null
        runCatching {
            replacing?.let { repository.replacementBlocker()?.let(::error) }
            val offer = repository.pairingManager().parseAndVerify(value.trim())
            val pending = repository.pairingManager().prepare(offer, deviceName.trim(), replacing)
            created = pending
            if (pending.actionAuthentication == ActionAuthentication.TRUSTED_DEVICE) {
                val completed = repository.pairingManager().completeWithoutAuthentication(pending)
                created = null
                stagePairing(completed)
                return@runCatching
            }
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(auth: BiometricPrompt.AuthenticationResult) {
                    runCatching {
                        val signature = auth.cryptoObject?.signature ?: error("Authentication signature unavailable")
                        signature.update(pending.transcript)
                        repository.pairingManager().complete(pending, signature.sign())
                    }.onSuccess { completed -> created = null; stagePairing(completed) }.onFailure { repository.pairingManager().cancel(pending); created = null; error = it.message }
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
        ScannerScreen(onResult = { scan = false; raw = it; prepare(it) }, onBack = { scan = false }, onEnterOffer = { scan = false; enteringOffer = true })
        return
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 540.dp).fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (onCancel != null) TextButton(onCancel) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
                Text(stringResource(R.string.go_back))
            }
            Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.extraLarge)
                .background(androidx.compose.ui.graphics.Brush.linearGradient(listOf(
                    MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.surfaceContainerHigh)))
                .padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Image(painterResource(R.drawable.cere_face_icon), "Cere", Modifier.size(72.dp))
                Text(stringResource(when {
                    result != null -> R.string.compare_words
                    replacing != null -> R.string.update_connection
                    else -> R.string.connect_to_cere
                }), style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.semantics { heading() })
                Text(stringResource(when {
                    result != null -> R.string.verify_pc_steps
                    replacing != null -> R.string.replace_pc_steps
                    else -> R.string.pair_pc_steps
                }), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (result == null) {
                replacing?.let { Text("Paired desktop · ${it.desktopName}", style = MaterialTheme.typography.titleSmall) }
                repository.replacementBlocker()?.let { SecureStatusPanel("Finish before replacing", it, tone = SecureTone.Attention) }
                val canPair = unstaged == null && (replacing == null || repository.replacementBlocker() == null)
                OutlinedTextField(deviceName, { deviceName = it.take(48) }, label = { Text(stringResource(R.string.phone_name)) },
                    supportingText = { Text(stringResource(R.string.phone_name_hint)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button({ scan = true }, enabled = canPair, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Icon(painterResource(R.drawable.ic_scan), null)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.scan_pairing))
                }
                if (!enteringOffer) OutlinedButton({ enteringOffer = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.paste_instead))
                } else {
                    OutlinedTextField(raw, { raw = it }, label = { Text(stringResource(R.string.pair_offer)) },
                        minLines = 2, maxLines = 3, modifier = Modifier.fillMaxWidth())
                    OutlinedButton({ prepare(raw) }, enabled = raw.isNotBlank() && canPair, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.verify_offer))
                    }
                }
            }
            error?.let { SecureStatusPanel("Pairing couldn't continue", it, tone = SecureTone.Danger) }
            unstaged?.let { completed ->
                Button(onClick = { stagePairing(completed) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Retry secure staging") }
                TextButton(onClick = { repository.pairingManager().delete(completed.desktop); unstaged = null; error = null }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Cancel unstaged pairing") }
            }
            result?.let { completed ->
                Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.primaryContainer, border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = .45f)), modifier = Modifier.fillMaxWidth()) {
                    SelectionContainer { Text(completed.sas, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onPrimaryContainer, textAlign = TextAlign.Center, modifier = Modifier.padding(20.dp).fillMaxWidth()) }
                }
                Text(if (completed.desktop.actionAuthentication == ActionAuthentication.TRUSTED_DEVICE) "This trusted-phone pairing signs reviewed actions without a fingerprint or PIN." else "This pairing requires phone authentication for sensitive actions.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                // Network return: the answer goes to the PC by itself and the phone finishes when the PC confirms.
                val ended = returning as? PairingReturnState.Ended
                if (networkReturn) {
                    val (line, problem) = when (val now = returning) {
                        PairingReturnState.Idle -> "Ready to send the signed answer to your PC." to false
                        PairingReturnState.Sending -> "Sending your answer to the PC…" to false
                        PairingReturnState.Waiting -> "Your PC has the answer. Check that it shows these same six words, then confirm there. This phone finishes by itself." to false
                        is PairingReturnState.Retrying -> "Can't reach the PC yet (${now.reason}). Retrying while the QR is valid…" to true
                        PairingReturnState.Confirmed -> "Confirmed. Connecting…" to false
                        is PairingReturnState.Ended -> now.message to true
                        is PairingReturnState.Unreachable -> "${now.reason} Send the answer another way below." to true
                    }
                    if (returning == PairingReturnState.Sending) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (problem) SecureStatusPanel("Check the connection", line, tone = SecureTone.Attention)
                    else Text(line, color = MaterialTheme.colorScheme.onSurface)
                    if (returning == PairingReturnState.Idle) OutlinedButton({ sendAnswer(completed) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Send the answer to the PC") }
                }
                val manual = !networkReturn || showManual || returning is PairingReturnState.Unreachable
                if (networkReturn && !manual && ended == null) TextButton({ showManual = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Send the answer another way") }
                if (manual && ended == null) {
                    HorizontalDivider()
                    Text("Get this public signed answer to the PC: copy or share it, then paste it, or save it to a file and choose Load response file…, in Cere Settings → Cere Mobile. Confirm there only if the six words match.")
                    PairingQrCode(completed.responseUri, Modifier.align(Alignment.CenterHorizontally))
                    TextButton({ showResponseText = !showResponseText }) {
                        Text(stringResource(if (showResponseText) R.string.hide_signed_text else R.string.show_signed_text))
                    }
                    if (showResponseText) SelectionContainer { Text(completed.responseUri, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Cere pairing response", completed.responseUri)) }) { Icon(painterResource(R.drawable.ic_copy), null); Spacer(Modifier.width(8.dp)); Text("Copy response") }
                        OutlinedButton(onClick = {
                            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, completed.responseUri).putExtra(Intent.EXTRA_SUBJECT, "Cere pairing response")
                            runCatching { activity.startActivity(Intent.createChooser(send, "Send the pairing response to your PC")) }.onFailure { error = "No app can share text on this phone. Copy the response instead." }
                        }) { Icon(Icons.Default.Share, null); Spacer(Modifier.width(8.dp)); Text("Share response") }
                    }
                    // Checked with the PC before the pairing is saved.
                    Button(onClick = { desktopConfirmed(completed) }, enabled = !checking, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(if (checking) "Checking with the PC…" else "I confirmed on the PC") }
                }
                TextButton(onClick = { scope.launch { runCatching { repository.cancelStagedPairing() }.onFailure { error = it.message } }; showManual = false }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (ended != null) "Start over" else "Cancel pairing") }
            }
        }
        }
    }
    savePrompt?.let { completed -> AlertDialog(onDismissRequest = { savePrompt = null }, title = { Text("Save this pairing?") },
        text = { Text("Cere couldn't ask your PC whether it confirmed this pairing. Save it only if the PC showed these same six words and you confirmed there; otherwise this phone keeps a pairing the PC doesn't have.") },
        confirmButton = { Button({ savePrompt = null; withPermissions { finishPairing(completed) } }) { Text("Save pairing") } },
        dismissButton = { TextButton({ savePrompt = null }) { Text("Not yet") } }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppShell(repository: CereRepository, state: MobileState, activity: FragmentActivity, launch: LaunchRequest?, consumeLaunch: () -> Unit) {
    val scope = rememberCoroutineScope()
    var destinationName by rememberSaveable { mutableStateOf(Destination.Sessions.name) }
    val destination = Destination.entries.find { it.name == destinationName } ?: Destination.Sessions
    var selectedSession by rememberSaveable { mutableStateOf(state.selectedSessionId) }
    var settingsGroup by rememberSaveable { mutableStateOf<SettingsGroup?>(null) }
    var returnFromInbox by rememberSaveable { mutableStateOf<String?>(null) }
    var highlightedApproval by rememberSaveable { mutableStateOf<String?>(null) }
    // Shared image URIs, one per line, until the person picks a conversation for them.
    var pendingShare by rememberSaveable { mutableStateOf("") }
    fun open(id: String?) { selectedSession = id; scope.launch { repository.selectSession(id) } }
    LaunchedEffect(state.selectedSessionId, state.sessions) { if (selectedSession != null && state.sessions.none { it.id == selectedSession }) selectedSession = null }
    LaunchedEffect(launch) {
        when (launch) {
            null -> return@LaunchedEffect
            is LaunchRequest.Share -> pendingShare = launch.uris.joinToString("\n")
            is LaunchRequest.Review -> { open(null); destinationName = Destination.Inbox.name; highlightedApproval = launch.approvalId }
            is LaunchRequest.OpenSession -> if (state.sessions.any { it.id == launch.sessionId }) open(launch.sessionId) else { open(null); destinationName = Destination.Sessions.name }
            LaunchRequest.OpenDesktop -> { open(null); destinationName = Destination.Desktop.name }
        }
        consumeLaunch()
    }
    fun selectTab(item: Destination) {
        returnFromInbox = null
        highlightedApproval = null
        settingsGroup = null
        destinationName = item.name
        open(null)
    }
    fun back() {
        if (selectedSession != null) open(null)
        else if (destination == Destination.Settings && settingsGroup != null) settingsGroup = null
        else {
            val previous = returnFromInbox
            selectTab(Destination.Sessions)
            if (previous != null && state.sessions.any { it.id == previous }) open(previous)
        }
    }
    BackHandler(enabled = selectedSession != null || destination != Destination.Sessions, onBack = ::back)
    val connection = state.connection
    val connectionText = connectionTitle(state)
    val selected = state.sessions.find { it.id == selectedSession }
    val pages = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val landscape = maxWidth >= 440.dp && maxWidth > maxHeight
        val rail = selectedSession == null && (maxWidth >= 600.dp || landscape)
        val useBars = maxHeight >= 280.dp
        val compactRail = maxHeight < 410.dp
        val keyboardOpen = WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current) > 0
        Row(Modifier.fillMaxSize()) {
            if (rail) CereNavigation(destination, state.approvals.size, true, ::selectTab, compactRail = compactRail)
            Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                if (useBars && selectedSession == null) {
                    CompanionHeader(state.desktop?.desktopName.orEmpty(), connection, connectionText,
                        onConnection = { selectTab(Destination.Settings); settingsGroup = SettingsGroup.Connection }, onRetry = repository::retry)
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
                Box(Modifier.weight(1f).widthIn(max = CereLayout.readingWidth).fillMaxWidth()) {
                    if (selectedSession != null) key(selectedSession) {
                        ChatScreen(repository, state, selected, activity, ::back, {
                            returnFromInbox = selectedSession
                            open(null)
                            destinationName = Destination.Inbox.name
                        }) { id -> open(id) }
                    } else pages.SaveableStateProvider(destination.name) {
                        when (destination) {
                            Destination.Sessions -> SessionsScreen(repository, state, { open(it) }, activity)
                            Destination.Inbox -> InboxScreen(repository, state, activity, highlightedApproval)
                            Destination.Desktop -> DesktopScreen(repository, state, activity)
                            Destination.Settings -> SettingsScreen(repository, state, activity, settingsGroup) { settingsGroup = it }
                        }
                    }
                }
                if (selectedSession == null && !rail && (useBars || !keyboardOpen)) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Surface(color = MaterialTheme.colorScheme.surface) {
                        CereNavigation(destination, state.approvals.size, false, ::selectTab)
                    }
                }
            }
        }
    }
    if (pendingShare.isNotBlank()) ShareTargetDialog(repository, state, pendingShare.split('\n').map(Uri::parse), { pendingShare = "" }) { id -> pendingShare = ""; destinationName = Destination.Sessions.name; open(id) }
}

/** Shared images go into a conversation the person picks; failures are shown, never dropped. */
@Composable
private fun ShareTargetDialog(repository: CereRepository, state: MobileState, uris: List<Uri>, dismiss: () -> Unit, opened: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var importing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var partial by remember { mutableStateOf<String?>(null) }
    val targets = state.sessions.filter { !it.archived && it.mode == "managed" && (query.isBlank() || it.title.contains(query, true) || it.project.orEmpty().contains(query, true)) }
        .sortedByDescending(Session::updated).take(50)
    fun importInto(session: Session) {
        importing = true; error = null
        scope.launch {
            val failures = mutableListOf<String>(); var added = 0
            for (uri in uris) {
                try { repository.importImage(session.id, uri); added++ }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { failures += failure.message ?: "An image could not be added." }
            }
            importing = false
            if (failures.isEmpty()) opened(session.id)
            else { error = (if (added > 0) "Added $added of ${uris.size} images. " else "") + failures.distinct().joinToString(" "); if (added > 0) partial = session.id }
        }
    }
    AlertDialog(onDismissRequest = { if (!importing) dismiss() }, title = { Text(if (uris.size == 1) "Add the image to a conversation" else "Add ${uris.size} images to a conversation") }, text = {
        Column(Modifier.heightIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Cere keeps a private copy on this phone. You review it before anything is uploaded.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.sessions.size > 6) OutlinedTextField(query, { query = it.take(200) }, placeholder = { Text("Search conversations") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (targets.isEmpty()) Text("No conversation can take images right now. Create one, then share again.")
            LazyColumn(Modifier.weight(1f, fill = false)) { items(targets, key = { it.id }) { session ->
                ListItem(headlineContent = { Text(session.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(listOfNotNull(session.provider.replaceFirstChar(Char::uppercase), session.project?.substringAfterLast('/')).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.clickable(enabled = !importing && partial == null) { importInto(session) })
            } }
            if (importing) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { partial?.let { id -> Button({ opened(id) }) { Text("Open conversation") } } }, dismissButton = { TextButton(dismiss, enabled = !importing) { Text(if (partial != null) "Close" else "Cancel") } })
}

@Composable
private fun SessionsScreen(repository: CereRepository, state: MobileState, select: (String) -> Unit, activity: FragmentActivity) {
    var query by rememberSaveable { mutableStateOf("") }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var creating by rememberSaveable { mutableStateOf(false) }
    var showHistory by rememberSaveable { mutableStateOf(false) }; var transferSourceId by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    var searching by remember { mutableStateOf(false) }
    var searchError by remember { mutableStateOf<String?>(null) }
    var retrySearch by remember { mutableIntStateOf(0) }
    var loadingMore by remember { mutableStateOf(false) }
    // The phone keeps recent conversations; the desktop searches every conversation in scope.
    LaunchedEffect(query, state.connection is ConnectionState.Online, retrySearch) {
        searchError = null
        val text = query.trim()
        if (text.length < 2 || !state.supports("sessions.list")) return@LaunchedEffect
        delay(350); searching = true
        try { repository.searchSessions(text) } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { searchError = failure.localizedMessage ?: "Desktop search failed." } finally { searching = false }
    }
    val transferSource = state.sessions.firstOrNull { it.id == transferSourceId }
    val sessions = remember(state.sessions, query, showArchived) { state.sessions.filter { it.archived == showArchived && (query.isBlank() || listOf(it.title, it.project.orEmpty(), it.provider, it.folderName.orEmpty()).any { value -> value.contains(query.trim(), true) }) }.sortedWith(compareBy<Session> { it.status != "waiting" }.thenByDescending { it.pinned }.thenByDescending { it.updated }) }
    val loadedIds = remember(state.sessions) { state.sessions.mapTo(HashSet(), Session::id) }
    val search = state.search?.takeIf { query.trim().length >= 2 && it.query == query.trim() }
    val unloadedMatches = search?.remaining(loadedIds) ?: 0
    val requestCounts = remember(state.approvals) { state.approvals.groupingBy(Approval::sessionId).eachCount() }
    val canImport = state.supports("sessions.history") && state.supports("sessions.import")
    val canHandoff = state.supports("sessions.handoffPreview") && state.supports("sessions.handoffCreate")
    Box(Modifier.fillMaxSize()) {
        LazyColumn(contentPadding = PaddingValues(start = CereLayout.gutter, end = CereLayout.gutter, top = 18.dp, bottom = 92.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PageTitle(stringResource(R.string.conversations_heading), Modifier.weight(1f))
                    if (canImport) {
                        var menu by remember { mutableStateOf(false) }
                        Box {
                            IconButton({ menu = true }) { Icon(Icons.Default.MoreVert, stringResource(R.string.conversation_actions)) }
                            DropdownMenu(menu, { menu = false }) {
                                DropdownMenuItem({ Text(stringResource(R.string.import_history)) }, { menu = false; showHistory = true })
                            }
                        }
                    }
                }
            }
            item {
                OutlinedTextField(query, { query = it.take(200) }, leadingIcon = { Icon(Icons.Default.Search, null) },
                    trailingIcon = {
                        if (searching) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        else if (query.isNotEmpty()) IconButton({ query = "" }) { Icon(Icons.Default.Close, stringResource(R.string.clear_search)) }
                    }, placeholder = { Text(stringResource(R.string.search_conversations), maxLines = 1, overflow = TextOverflow.Ellipsis) }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
            }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(!showArchived, { showArchived = false }, { Text(stringResource(R.string.active_chats)) })
                    FilterChip(showArchived, { showArchived = true }, { Text(stringResource(R.string.archived_chats)) })
                }
            }
            searchError?.let { item {
                Text(it, color = MaterialTheme.colorScheme.error)
                if (query.trim().length >= 2) TextButton({ retrySearch++ }) { Text("Retry search") }
            } }
            if (unloadedMatches > 0 || query.isBlank() && state.sessionsNotLoaded > 0) item {
                val moreSearchResults = search != null && unloadedMatches > 0
                val detail = if (search != null && moreSearchResults)
                    "${search.total} matches on the desktop · $unloadedMatches more${if (search.truncated) " (first 5000 matches)" else ""}"
                else "${state.sessionsNotLoaded} more conversations on the desktop"
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(detail, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton({
                        loadingMore = true
                        scope.launch {
                            try { if (moreSearchResults) repository.loadMoreSearchResults() else repository.loadMoreSessions() }
                            catch (cancelled: CancellationException) { throw cancelled }
                            catch (failure: Exception) { searchError = failure.message }
                            finally { loadingMore = false }
                        }
                    }, enabled = !loadingMore && state.connection is ConnectionState.Online) {
                        Text(stringResource(if (loadingMore) R.string.loading_more else R.string.load_more))
                    }
                }
            }
            if (sessions.isEmpty() && !searching) item {
                EmptyState(Icons.Default.Search, stringResource(when {
                    query.isNotBlank() -> R.string.empty_search
                    showArchived -> R.string.empty_archive
                    state.connection is ConnectionState.Online -> R.string.empty_library
                    else -> R.string.empty_cache
                }), stringResource(when {
                    state.connection !is ConnectionState.Online && query.isNotBlank() -> R.string.search_offline
                    query.isNotBlank() -> R.string.search_again
                    showArchived -> R.string.empty_archive_hint
                    state.connection is ConnectionState.Online -> R.string.empty_library_hint
                    else -> R.string.empty_cache_hint
                }))
            }
            items(sessions, key = { it.id }, contentType = { "conversation" }) { session ->
                LibraryConversation(session, sessionDisplayStatus(session, requestCounts[session.id] ?: 0),
                    { select(session.id) }, if (canHandoff) { { transferSourceId = session.id } } else null)
            }
        }
        if (state.supports("sessions.create")) {
            val createLabel = stringResource(R.string.new_chat)
            val placement = Modifier.align(Alignment.BottomEnd).padding(CereLayout.gutter)
            if (androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.6f) {
                FloatingActionButton({ creating = true }, modifier = placement, containerColor = MaterialTheme.colorScheme.primary) {
                    Icon(Icons.Default.Add, createLabel)
                }
            } else ExtendedFloatingActionButton(
                onClick = { creating = true }, icon = { Icon(Icons.Default.Add, null) }, text = { Text(createLabel) },
                modifier = placement.semantics { contentDescription = createLabel },
                containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary)
        }
    }
    if (creating) CreateSessionSheet(repository, state, activity, { creating = false }) { id -> creating = false; select(id) }
    if (showHistory) SessionTransferSheet(repository, state, activity, null, { showHistory = false }, { id -> showHistory = false; select(id) })
    transferSource?.let { source -> SessionTransferSheet(repository, state, activity, source, { transferSourceId = null }, { id -> transferSourceId = null; select(id) }) }
}

@Composable
private fun CreateSessionSheet(repository: CereRepository, state: MobileState, activity: FragmentActivity, close: () -> Unit, created: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var title by rememberSaveable { mutableStateOf("") }
    // Keep an authorized provider selectable when discovery failed, so Refresh
    // can recover it without restarting either app.
    val supportedProviders = state.providers.filterValues { it.jsonObject["remoteExecution"]?.jsonPrimitive?.booleanOrNull == true }
    var provider by rememberSaveable { mutableStateOf(supportedProviders.keys.firstOrNull().orEmpty()) }
    var project by rememberSaveable { mutableStateOf(state.projects.firstOrNull()?.id.orEmpty()) }
    var models by remember { mutableStateOf<List<ModelOption>>(emptyList()) }
    var unlisted by remember { mutableStateOf(false) }
    var model by rememberSaveable(provider) { mutableStateOf("") }
    var effort by rememberSaveable(provider) { mutableStateOf("") }
    var tools by rememberSaveable(provider) { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(supportedProviders.keys) { if (provider !in supportedProviders) provider = supportedProviders.keys.firstOrNull().orEmpty() }
    LaunchedEffect(state.projects) { if (state.projects.none { it.id == project }) project = state.projects.firstOrNull()?.id.orEmpty() }
    LaunchedEffect(provider, refresh) {
        models = emptyList(); unlisted = false; error = null
        if (provider.isNotBlank()) {
            loading = true
            try {
                val catalog = repository.modelCatalog(provider); models = catalog.models; unlisted = catalog.unlisted
                val defaultModel = if (provider == "ollama") state.settings["defaultModel"]?.jsonPrimitive?.contentOrNull else null
                val selected = models.firstOrNull { it.id == model.trim() }
                if (model.isBlank() || selected == null && !state.traits(provider).customModel) {
                    val preferred = models.firstOrNull { it.id == defaultModel } ?: models.firstOrNull { it.isDefault } ?: models.firstOrNull()
                    model = preferred?.id.orEmpty()
                    effort = preferred?.defaultEffort.orEmpty()
                    if (!ToolPolicy.availability(state.traits(provider), preferred).available) tools = false
                } else if (selected != null && selected.efforts.none { it.id == effort }) {
                    effort = selected.defaultEffort.orEmpty()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { loading = false }
        }
    }
    val providerTraits = state.traits(provider)
    val selectedModel = models.firstOrNull { it.id == model.trim() }
    val selectedProject = state.projects.firstOrNull { it.id == project }
    // MOB-004: a typed model ID where the provider takes one; Ollama still needs a model it lists.
    val typed = providerTraits.customModel
    val modelError = if (typed && selectedModel == null) ModelIds.error(model) else null
    // MOB-003: the same tools rule as Conversation settings.
    val tooling = ToolPolicy.availability(providerTraits, selectedModel)
    fun chooseModel(option: ModelOption) { model = option.id; effort = option.defaultEffort; if (!ToolPolicy.availability(providerTraits, option).available) tools = false }
    fun submit() {
        submitting = true; error = null
        scope.launch {
            try {
                val params = buildJsonObject { put("provider", provider); put("projectId", project); if (title.isNotBlank()) put("title", title); put("model", model.trim()); if (effort.isNotBlank()) put("effort", effort); put("tools", tools && tooling.available) }
                val action = repository.prepareAction("sessions.create", params, label = title.ifBlank { null })
                authenticate(activity, "Create ${state.traits(provider).label} conversation", action, repository, { result ->
                    scope.launch { try { created(repository.openCreatedSession(result)) } catch (failure: Exception) { error = failure.message; submitting = false } }
                }, { error = it; submitting = false })
            } catch (failure: Exception) { error = failure.message; submitting = false }
        }
    }
    AncillarySheetScaffold(title = "New conversation", busy = submitting, onDismiss = close, action = {
        Button(::submit, enabled = (selectedModel != null || typed && modelError == null) && selectedProject != null &&
            !loading && !submitting && state.supports("sessions.create"), modifier = Modifier.fillMaxWidth()) {
            Text(if (submitting) "Creating…" else "Create conversation")
        }
    }) {
        OutlinedTextField(title, { title = it.take(100) }, label = { Text("Title (optional)") }, enabled = !submitting, singleLine = true, modifier = Modifier.fillMaxWidth())
        AncillarySection("Provider") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { supportedProviders.keys.forEach { id ->
                FilterChip(provider == id, { provider = id }, { Text(state.traits(id).label) }, enabled = !submitting)
            } }
            // What the desktop says about running this provider from a phone (billing, restrictions).
            if (provider.isNotBlank()) state.traits(provider).remoteNote.takeIf(String::isNotBlank)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = if (state.traits(provider).billed) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val unavailable = state.providers.filterKeys { it !in supportedProviders }
            var showUnavailable by rememberSaveable { mutableStateOf(false) }
            if (unavailable.isNotEmpty()) TextButton({ showUnavailable = !showUnavailable }) {
                Text(if (showUnavailable) "Hide unavailable providers" else "Unavailable providers (${unavailable.size})")
            }
            if (showUnavailable) unavailable.forEach { (id, value) ->
                Text("${state.traits(id).label} · ${value.jsonObject["remoteUnavailableReason"]?.jsonPrimitive?.contentOrNull ?: "Enable access on the desktop"}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        AncillarySection("Desktop project") {
            if (state.projects.isEmpty()) Text("Grant this phone a project in desktop Remote settings.", color = MaterialTheme.colorScheme.error)
            state.projects.forEach { option -> FilterChip(project == option.id, { project = option.id }, { Column {
                Text(option.name); Text(option.path ?: "Path unavailable", style = MaterialTheme.typography.labelSmall)
            } }, enabled = !submitting) }
        }
        AncillarySection("Model") {
            if (provider == "ollama") Text("Ollama · ${state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable"}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton({ refresh++ }, enabled = provider.isNotBlank() && !loading && !submitting && state.supports("providers.models")) { Text("Refresh models") }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            // An endpoint without a model list is not a failure; neither is a failed refresh where an ID can be typed.
            else if (unlisted) Text("This endpoint doesn't list its models. Enter the model ID below.", style = MaterialTheme.typography.bodySmall)
            else if (error != null && typed) Text("The model list could not be loaded. You can still enter a model ID below.", style = MaterialTheme.typography.bodySmall)
            else if (models.isEmpty() && provider.isNotBlank()) Text(if (typed) "No models listed. Enter the model ID below." else "No models loaded. Check the provider on your PC, then refresh.", style = MaterialTheme.typography.bodySmall)
            models.forEach { option -> Row(Modifier.fillMaxWidth().selectable(selected = model.trim() == option.id, enabled = !submitting, role = Role.RadioButton, onClick = { chooseModel(option) }).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(model.trim() == option.id, null, enabled = !submitting)
                Spacer(Modifier.width(12.dp))
                Column { Text(option.displayName); if (option.description.isNotBlank()) Text(option.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } }
            if (typed && provider.isNotBlank()) OutlinedTextField(model, { value -> model = value.take(ModelIds.MAX_LENGTH + 64); effort = ""; if (!ToolPolicy.availability(providerTraits, models.firstOrNull { it.id == value.trim() }).available) tools = false },
                label = { Text("Model ID") }, singleLine = true, enabled = !submitting, isError = modelError != null && model.isNotEmpty(),
                supportingText = { Text(modelError?.takeIf { model.isNotEmpty() } ?: "Choose one above, or type the ID as the provider names it.") }, modifier = Modifier.fillMaxWidth())
            selectedModel?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                Text("Effort", fontWeight = FontWeight.Medium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { efforts.forEach { option -> FilterChip(effort == option.id, { effort = option.id }, { Text(option.displayName) }, enabled = !submitting) } }
            }
            // Cere's desktop tools, for providers whose conversation Cere runs: per model for Ollama, per route for APIs.
            if (tooling.applies) ListItem(headlineContent = { Text("Desktop tools") }, supportingContent = {
                Text(if (tooling.available) "Use ordinary desktop permission checks" else "Conversation only · ${tooling.reason}")
            }, trailingContent = { Switch(tools, { tools = it }, enabled = !submitting && tooling.available) })
        }
        error?.let { SecureStatusPanel("Conversation setup", it, tone = SecureTone.Danger) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(repository: CereRepository, state: MobileState, session: Session?, activity: FragmentActivity, goBack: () -> Unit, openInbox: () -> Unit, selectSession: (String) -> Unit) {
    if (session == null) return EmptyState(Icons.Default.Warning, "Session unavailable", "It may no longer be in this device's scope.")
    val context = LocalContext.current
    val scope = rememberCoroutineScope(); val storedDraft = state.draft(session); var draft by rememberSaveable(session.id) { mutableStateOf(storedDraft.text) }; var activityOpen by rememberSaveable(session.id) { mutableStateOf(false) }; var error by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var activityLoading by remember(session.id) { mutableStateOf(false) }; var activityError by remember(session.id) { mutableStateOf<String?>(null) }; var activityOlderLoading by remember(session.id) { mutableStateOf(false) }; var activityRefresh by remember(session.id) { mutableIntStateOf(0) }
    var reviewOpen by rememberSaveable(session.id) { mutableStateOf(false) }; var sending by remember(session.id) { mutableStateOf(false) }; var loadingOlder by remember(session.id) { mutableStateOf(false) }
    var attachmentReviewId by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var desktopReviewId by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var pinnedOpen by rememberSaveable(session.id) { mutableStateOf(false) }
    var portraitSheet by remember { mutableStateOf<PortraitSheet?>(null) }
    LaunchedEffect(state.connection is ConnectionState.Online) {
        if (state.connection is ConnectionState.Online && state.supports("desktop.portrait")) portraitSheet = runCatching { repository.portrait() }.getOrNull() ?: portraitSheet
    }
    var desktopRemoveId by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var showConversationSettings by rememberSaveable(session.id) { mutableStateOf(false) }
    var webSearch by rememberSaveable(session.id) { mutableStateOf(false) }
    var attachMenu by remember { mutableStateOf(false) }
    // A full-size capture's private file, kept across the camera app and process death until imported.
    var cameraFile by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    val canSearchWeb = state.canSearchWeb(session)
    LaunchedEffect(canSearchWeb) { if (!canSearchWeb) webSearch = false }
    val now = repository.desktopTime()
    val attachments = state.attachments.filter { it.sessionId == session.id }
    val activeAgents = session.agents.filter(Agent::isActive)
    val waitingApprovals = state.approvals.filter { it.sessionId == session.id || session.id in it.parentSessionIds || activeAgents.any { agent -> agent.id == it.sessionId } }
    val busy = session.status in setOf("starting", "working", "waiting", "stopping") || waitingApprovals.any { it.sessionId == session.id }
    val attachmentsReady = attachments.all { it.reviewedAt != null && it.readyAt(now) }
    // A desktop draft's attachments are part of the draft: shown, reviewable and sent with it, never queued.
    val desktopAttachments = session.draftAttachments
    val draftEditable = state.draftEditable(session)
    val canCompose = draftEditable && session.canSend && session.mode == "managed" && session.draftIncluded && (!busy || session.canQueue && session.status != "stopping" && desktopAttachments.isEmpty()) && !sending && attachmentsReady &&
        (desktopAttachments.isEmpty() || state.supports("attachments.commit")) && state.supports("sessions.send") && state.pendingCommands.none { it.sessionId == session.id && it.method == "sessions.send" }
    val canAttach = state.supports("attachments.begin") && attachments.size + desktopAttachments.count { it.kind == "image" } < 4 && session.mode == "managed"
    fun imported(uri: android.net.Uri?) { if (uri != null) scope.launch { runCatching { repository.importImage(session.id, uri) }.onSuccess { attachmentReviewId = it.id }.onFailure { error = it.message } } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia(), ::imported)
    val files = rememberLauncherForActivityResult(ActivityResultContracts.GetContent(), ::imported)
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val path = cameraFile ?: return@rememberLauncherForActivityResult
        cameraFile = null
        scope.launch {
            val file = File(path)
            try { if (saved) attachmentReviewId = repository.importImage(session.id, FileProvider.getUriForFile(context, "${context.packageName}.camera", file)).id }
            catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message }
            finally { withContext(NonCancellable + Dispatchers.IO) { file.delete() } }
        }
    }
    fun launchCamera() { scope.launch {
        val file = try { withContext(Dispatchers.IO) {
            // A capture left behind by an interrupted import is removed before the next one.
            val directory = File(context.cacheDir, "camera").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
            File.createTempFile("capture-", ".jpg", directory)
        } } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = "The camera couldn't be prepared: ${failure.message}"; return@launch }
        cameraFile = file.path
        try { camera.launch(FileProvider.getUriForFile(context, "${context.packageName}.camera", file)) }
        catch (_: ActivityNotFoundException) { cameraFile = null; file.delete(); error = "No camera app is available on this phone." }
        catch (_: SecurityException) { cameraFile = null; file.delete(); error = "Camera access is off for Cere. Allow it in Android settings, or pick a photo instead." }
    } }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera() else error = "Camera access wasn't allowed. Photos and files still work."
    }
    fun takePhoto() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera()
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }
    val uploading = remember(session.id) { mutableStateMapOf<String, Int>() }
    fun uploadFailed(id: String, reason: String?) {
        uploading.remove(id)
        error = reason ?: "The image could not be uploaded. Try again when your desktop is connected."
    }
    fun finishUpload(local: LocalAttachment, initial: JsonObject?) {
        uploading[local.id] = R.string.image_transferring
        scope.launch {
            runCatching {
                val uploaded = repository.uploadAttachment(local.id, initial)
                val attachmentId = uploaded.getValue("attachmentId").jsonPrimitive.content
                uploading[local.id] = R.string.image_finishing
                val commit = repository.prepareAction("attachments.commit", buildJsonObject { put("attachmentId", attachmentId) }, label = local.displayName)
                authenticate(activity, "Finish image upload", commit, repository, { ready ->
                    repository.attachmentCommitted(local.id, ready.jsonObject)
                    uploading.remove(local.id)
                }, { uploadFailed(local.id, it) })
            }.onFailure { uploadFailed(local.id, it.message) }
        }
    }
    fun upload(local: LocalAttachment) {
        if (local.id in uploading) return
        val resumable = local.remoteAttachmentId != null && local.remoteStatus != "ready" && (local.remoteExpiresAt ?: Long.MAX_VALUE) > now
        if (resumable) { finishUpload(local, null); return }
        uploading[local.id] = R.string.image_preparing
        scope.launch {
            runCatching {
                val begin = repository.prepareAction("attachments.begin", buildJsonObject {
                    put("sessionId", session.id); put("size", local.size); put("mime", local.mime); put("sha256", local.sha256)
                }, label = local.displayName)
                authenticate(activity, "Upload ${local.displayName}", begin, repository, { value -> finishUpload(local, value.jsonObject) },
                    { uploadFailed(local.id, it) })
            }.onFailure { uploadFailed(local.id, it.message) }
        }
    }
    // Removing always works on the phone; the desktop is asked to discard its copy when it still has one.
    fun remove(local: LocalAttachment) { scope.launch { runCatching { repository.discardAttachment(local.id) }.onFailure { error = it.message } } }
    // MOB-005: Files, Images and Analysis pause under phone control. The person confirms exactly
    // which before this phone takes the conversation over; the desktop refuses anything else.
    var takeoverOpen by rememberSaveable(session.id) { mutableStateOf(false) }
    var acknowledged by remember(session.id, session.workbenchFamilies) { mutableStateOf<List<String>?>(null) }
    val takeoverNeeded = session.workbenchTakeover == "acknowledge" && state.has("workbench.takeover")
    fun send() {
        if (takeoverNeeded && acknowledged == null) { takeoverOpen = true; return }
        val sentText = draft; val sentAttachments = attachments.map { it.id }.toSet(); val searchThisTurn = webSearch; val families = acknowledged
        sending = true; error = null
        scope.launch {
            val action = try { repository.prepareSend(session.id, sentText, webSearch = searchThisTurn, workbenchAcknowledged = families) } catch (cancelled: CancellationException) { sending = false; throw cancelled } catch (failure: Exception) {
                sending = false; error = failure.message
                if ((failure as? RemoteRequestException)?.code == "REVISION_CONFLICT") repository.selectSession(session.id)
                return@launch
            }
            repository.launchSend(action, session.id, sentText, sentAttachments) { result ->
                sending = false
                // Like the desktop, web search applies to one accepted message only.
                result.onSuccess { webSearch = false }.onFailure { failure ->
                    error = failure.message
                    if ((failure as? RemoteRequestException)?.code == "REVISION_CONFLICT") scope.launch { repository.selectSession(session.id) }
                }
            }
        }
    }
    var loadAttempt by remember(session.id) { mutableIntStateOf(0) }
    var loadingHistory by remember(session.id) { mutableStateOf(false) }
    var historyError by remember(session.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(session.id, state.connection is ConnectionState.Online, loadAttempt) {
        if (state.connection !is ConnectionState.Online) return@LaunchedEffect
        loadingHistory = true
        historyError = null
        try { repository.loadMessages(session.id) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { historyError = failure.message ?: "Conversation history could not be loaded." }
        finally { loadingHistory = false }
    }
    // A reply that finishes while this conversation is on screen has been read, as on the desktop.
    LaunchedEffect(session.id, session.unread) { if (session.unread) repository.markRead(session.id) }
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
    val canAutosave = !sending && draftEditable && session.draftIncluded && session.mode == "managed" &&
        state.supports("drafts.put") && storedDraft.dirty && !storedDraft.conflict
    LaunchedEffect(session.id, canAutosave, storedDraft.text, storedDraft.remoteRevision) {
        if (canAutosave) {
            delay(700)
            repository.autosaveDraft(session.id)
        }
    }
    val messages = remember(state.messages, session.id) { state.messages.filter { it.sessionId == session.id }.sortedBy { it.time } }
    val activityItems = remember(messages) { messages.filterNot(Message::isConversationMessage) }
    val unknownSend = state.pendingCommands.firstOrNull { it.sessionId == session.id && it.method == "sessions.send" && it.status == "unknown" }
    var reviewingOutcome by remember(session.id) { mutableStateOf(false) }
    val sendHint = when {
        session.mode == "linked" -> "Linked terminal session · continue on the PC"
        state.connection !is ConnectionState.Online -> null
        !session.canSend -> "Sending is unavailable for this session. Check provider access on your PC."
        !session.draftIncluded -> "Loading desktop draft…"
        session.draftAttachmentCount == null -> "Restart the updated Cere broker on your PC to sync desktop attachments. Your draft stays on this phone."
        !draftEditable -> "${session.draftAttachmentCount} attachment(s) are in this desktop draft. Update Cere on your PC to review them here, or send it from the PC."
        desktopAttachments.isNotEmpty() && !state.supports("attachments.commit") -> "Sending this draft's desktop attachments needs the attachment permission. Remove them here, or send from the PC."
        storedDraft.conflict -> "Resolve the draft conflict before sending."
        sending -> "Sending your message…"
        !attachmentsReady -> "Upload or remove the images before sending."
        state.pendingCommands.any { it.sessionId == session.id && it.method == "sessions.send" } -> "Checking the previous send with your desktop…"
        busy && session.canQueue && desktopAttachments.isNotEmpty() -> "Queued messages carry text only. Send this draft with its desktop attachments after this turn, or remove them."
        session.queuedCount > 0 -> "${session.queuedCount} message(s) queued · will send after this turn"
        busy && session.canQueue -> "You can send another message; it will run after this turn."
        // Busy and not queueable from here: say why, and what can be done instead.
        busy && session.canSend && session.status != "stopping" -> if (session.provider == "ollama") "This turn was started on the desktop, where its follow-ups queue. Wait for it to finish, or Stop it, then send from here."
            else "${session.provider.replaceFirstChar(Char::uppercase)} takes one message at a time. Wait for this turn to finish, or Stop it, then send."
        else -> null
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val room = maxHeight
        Column(Modifier.fillMaxSize()) {
            val portraitShown by UiPreferences.portrait(context).collectAsState()
            val portraitState = PortraitState.resolve(state.connection is ConnectionState.Online, session.status, session.activity, waitingApprovals.size,
                state.permissions["paused"]?.jsonPrimitive?.booleanOrNull == true)
            if (room >= 240.dp) Surface(color = MaterialTheme.colorScheme.surface) {
                Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    IconButton(goBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.go_back)) }
                    if (portraitShown && room >= 300.dp) portraitSheet?.let {
                        StatusPortrait(it, portraitState, size = 36.dp)
                        Spacer(Modifier.width(10.dp))
                    }
                    Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                        Text(session.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.semantics { heading() })
                        val online = state.connection is ConnectionState.Online
                        Text(listOfNotNull(if (online) sessionDisplayStatus(session, waitingApprovals.size) else connectionTitle(state),
                            session.model?.takeIf(String::isNotBlank) ?: state.traits(session.provider).label).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (online) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.tertiary,
                            style = MaterialTheme.typography.labelMedium)
                    }
                    var options by remember { mutableStateOf(false) }
                    Box {
                        IconButton({ options = true }) { Icon(Icons.Default.MoreVert, stringResource(R.string.chat_options)) }
                        DropdownMenu(options, { options = false }) {
                            DropdownMenuItem({ Text(stringResource(R.string.chat_settings)) },
                                { options = false; showConversationSettings = true }, leadingIcon = { Icon(Icons.Default.Settings, null) })
                            if (state.supports("activity.list") || activityItems.isNotEmpty() || session.agents.isNotEmpty())
                                DropdownMenuItem({ Text(stringResource(R.string.activity_label)) }, { options = false; activityOpen = true },
                                    leadingIcon = { Icon(Icons.Default.List, null) })
                            if (state.supports("messages.bookmarks")) DropdownMenuItem({ Text(stringResource(R.string.pinned_replies)) },
                                { options = false; pinnedOpen = true }, leadingIcon = { Icon(Icons.Default.Star, null) })
                            DropdownMenuItem({ Text(stringResource(R.string.nav_inbox)) }, { options = false; openInbox() },
                                leadingIcon = { Icon(Icons.Default.Notifications, null) })
                            if (canSearchWeb) DropdownMenuItem({ Text("Web search") }, { options = false; webSearch = !webSearch },
                                enabled = !sending && (!busy || session.canQueue), trailingIcon = { Checkbox(webSearch, null) })
                        }
                    }
                }
            }
            key(session.id) {
                if (messages.isEmpty() && loadingHistory) Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                } else if (messages.isEmpty() && historyError != null) Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) {
                    SecureStatusPanel("History unavailable", historyError.orEmpty(), tone = SecureTone.Attention)
                    TextButton({ loadAttempt++ }, enabled = state.connection is ConnectionState.Online) { Text("Retry loading messages") }
                } else ConversationTimeline(messages, busy, session.status, Modifier.weight(1f), state.messagesBefore[session.id] != null, loadingOlder, {
                    loadingOlder = true
                    scope.launch { try { repository.loadOlderMessages(session.id) } catch (failure: Exception) { error = failure.message } finally { loadingOlder = false } }
                }, statusText = when {
                    waitingApprovals.isNotEmpty() -> if (waitingApprovals.size == 1) "Input needed: ${waitingApprovals.first().title}" else "${waitingApprovals.size} requests need input · Review below"
                    // Waiting on something this phone cannot answer or see: say where it is.
                    session.status == "waiting" && !state.supports("approvals.answer") -> "Waiting for a decision on the desktop · this phone cannot answer requests"
                    activeAgents.size == 1 -> "1 subagent is working…"
                    activeAgents.size > 1 -> "${activeAgents.size} subagents are working…"
                    // What the turn is doing, in the desktop's words; unknown activities keep the general line.
                    session.status == "starting" || session.status == "working" -> activityLabel(session.activity)
                    else -> null
                }, sessionId = session.id, restoredPosition = state.scrollPositions[session.id],
                    onPositionChanged = repository::recordScrollPosition) { message -> MessageBubble(repository, state, message) }
            }
            // Controls under the conversation scroll on their own and never take more than about
            // half the space, so large text and the keyboard leave the message field usable.
            Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, tonalElevation = 1.dp) {
            Column(Modifier.heightIn(max = room * 0.42f).verticalScroll(rememberScrollState()).padding(top = 4.dp)) {
                if (messages.isNotEmpty() && historyError != null) TextButton({ loadAttempt++ }, enabled = state.connection is ConnectionState.Online) {
                    Text("Couldn’t refresh messages · Retry")
                }
                session.error?.let { Text(it, color = MaterialTheme.colorScheme.error, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 16.dp)) }
                if (storedDraft.conflict) Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text("Draft changed on desktop", fontWeight = FontWeight.SemiBold)
                        Text("Your phone edit is preserved. Choose which version to keep.")
                        FlowRow {
                            TextButton({ scope.launch { repository.reloadRemoteDraft(session.id, storedDraft.remoteRevision) } }) { Text("Reload desktop") }
                            TextButton({ scope.launch { repository.keepLocalDraft(session.id, storedDraft.remoteRevision) } }) { Text("Keep phone edit") }
                        }
                    }
                }
                if (waitingApprovals.isNotEmpty()) {
                    TextButton({ activityOpen = false; reviewOpen = true }, modifier = Modifier.fillMaxWidth()) { Text("${waitingApprovals.first().title}${if (waitingApprovals.size > 1) " (+${waitingApprovals.size - 1})" else ""} · Review", maxLines = 2, overflow = TextOverflow.Ellipsis) }
                }
                session.workbenchNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
                (error ?: state.lastError)?.let { Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    IconButton({ error = null; scope.launch { repository.dismissError() } }) { Icon(Icons.Default.Close, "Dismiss error") }
                } }
                if (busy) FlowRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton({ activityOpen = true }, enabled = state.supports("activity.list") || activityItems.isNotEmpty() || session.agents.isNotEmpty()) {
                        Icon(Icons.Default.List, null)
                        Text(stringResource(R.string.activity_label))
                    }
                    if (state.supports("sessions.stop")) OutlinedButton(onClick = {
                        scope.launch { runCatching { repository.mutate("sessions.stop", buildJsonObject { put("sessionId", session.id) }, session.title) }.onFailure { error = it.message } }
                    }, enabled = session.status != "stopping") { Text(if (session.status == "stopping") "Stopping…" else "Stop") }
                }
                if (state.connection is ConnectionState.Offline) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.draft_offline), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(repository::retry) { Text("Reconnect") }
                }
                if (webSearch) Text("This message becomes a public web search query, up to 500 characters.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary, modifier = Modifier.padding(horizontal = 16.dp))
                if (attachments.isNotEmpty()) LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(attachments, key = { it.id }) { attachment ->
                    val discarded = attachment.remoteAttachmentId != null && (attachment.remoteExpiresAt ?: Long.MAX_VALUE) <= now
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), shape = RoundedCornerShape(12.dp)) { Column(Modifier.widthIn(min = 176.dp, max = 280.dp).padding(12.dp)) {
                        Text(attachment.displayName, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${attachment.width}×${attachment.height} · ${attachment.size / 1024} KiB${if (attachment.transformed) " · private copy optimized" else ""}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (!discarded && attachment.committedOffset > 0 && !attachment.readyAt(now) && attachment.size > 0) {
                            val fraction = (attachment.committedOffset.toFloat() / attachment.size).coerceIn(0f, 1f)
                            LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp))
                            Text("${(fraction * 100).toInt()}% received by desktop", style = MaterialTheme.typography.labelSmall)
                        }
                        if (discarded) Text("The desktop discarded the upload. Upload it again.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val stage = uploading[attachment.id]
                            when {
                                stage != null -> Text(stringResource(stage), Modifier.padding(8.dp), style = MaterialTheme.typography.labelMedium)
                                attachment.reviewedAt == null -> TextButton({ attachmentReviewId = attachment.id }) { Text("Review") }
                                attachment.readyAt(now) -> Text("Ready", color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(12.dp))
                                else -> TextButton({ upload(attachment) }, enabled = state.supports("attachments.begin") && state.supports("attachments.commit")) { Text(if (attachment.committedOffset > 0 && !discarded && attachment.remoteStatus != "ready") "Resume" else "Upload") }
                            }
                            IconButton({ remove(attachment) }, enabled = stage == null) { Icon(Icons.Default.Delete, "Remove image") }
                        }
                    } }
                } }
                if (desktopAttachments.isNotEmpty() && draftEditable) {
                    Text("From the desktop draft · sent with this message", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(desktopAttachments, key = { it.id }) { attachment ->
                        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), shape = RoundedCornerShape(12.dp)) { Column(Modifier.widthIn(min = 176.dp, max = 280.dp).padding(12.dp)) {
                            Text(attachment.name, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${if (attachment.kind == "image") "Image" else "Text file"} · ${attachment.size / 1024} KiB", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                TextButton({ desktopReviewId = attachment.id }) { Text("Review") }
                                IconButton({ desktopRemoveId = attachment.id }, enabled = !sending && !storedDraft.conflict && state.supports("drafts.put")) { Icon(Icons.Default.Delete, "Remove ${attachment.name} from the draft") }
                            }
                        } }
                    } }
                }
                sendHint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp)) }
                // F11: a linked conversation continues in its terminal on the desktop; this brings that window forward there.
                if (session.mode == "linked" && state.supports("sessions.focusTerminal")) OutlinedButton({
                    signedReview(activity, repository, "sessions.focusTerminal", buildJsonObject { put("sessionId", session.id) }, "Open the terminal on the desktop", { error = null }, { error = it }, label = session.title)
                }, modifier = Modifier.padding(horizontal = 12.dp)) { Text("Open on desktop") }
                if (unknownSend != null) TextButton({ reviewingOutcome = true }, modifier = Modifier.padding(horizontal = 8.dp)) { Text("Review uncertain send") }
            }
            }
            ConversationComposer(
                sendFromKeyboard = remember(context) { UiPreferences.sendFromKeyboard(context) },
                value = draft,
                onValueChange = { if (it.length <= 100_000) { draft = it; repository.editDraft(session.id, it) } },
                enabled = session.mode == "managed" && session.draftIncluded && draftEditable && !sending,
                placeholder = stringResource(if (busy && session.canQueue) R.string.queue_message else R.string.compose_message, state.assistantName),
                canSend = draft.isNotBlank() && canCompose && !storedDraft.conflict,
                onSend = ::send,
                modifier = Modifier.heightIn(max = (room * 0.34f).coerceAtLeast(80.dp)),
                leadingContent = if (canAttach) { {
                    Box {
                        IconButton({ attachMenu = true }, modifier = Modifier.size(48.dp)) { Icon(Icons.Default.Add, stringResource(R.string.attach_image)) }
                        DropdownMenu(attachMenu, { attachMenu = false }) {
                            DropdownMenuItem({ Text(stringResource(R.string.photo_library)) }, { attachMenu = false; picker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) })
                            DropdownMenuItem({ Text(stringResource(R.string.screenshot_file)) }, { attachMenu = false; files.launch("image/*") })
                            DropdownMenuItem({ Text(stringResource(R.string.camera)) }, { attachMenu = false; takePhoto() })
                        }
                    }
                } } else null,
            )
        }
    }
    if (showConversationSettings) ConversationSettingsSheet(repository, state, session, activity) { showConversationSettings = false }
    if (pinnedOpen) PinnedReplies(repository, state, session.id) { pinnedOpen = false }
    if (takeoverOpen) AlertDialog(onDismissRequest = { takeoverOpen = false }, title = { Text("Continue on this phone?") },
        text = { Text((session.workbenchNote ?: "This conversation uses desktop Workbench tools that pause under phone control.") + "\n\nSending from the phone continues it without them. To keep them, continue on the desktop instead.") },
        confirmButton = { Button({ takeoverOpen = false; acknowledged = session.workbenchFamilies; send() }) { Text("Continue without them") } },
        dismissButton = { TextButton({ takeoverOpen = false }) { Text("Keep it on the desktop") } })
    if (activityOpen) ActivityPanel(activityItems, activityLoading, activityError, { activityRefresh++ }, { activityOpen = false },
        agents = session.agents, canOpenAgent = { agent -> state.sessions.any { it.id == agent.id } },
        onOpenAgent = { agent -> activityOpen = false; selectSession(agent.id) },
        hasOlder = state.activityBefore[session.id] != null, loadingOlder = activityOlderLoading,
        onLoadOlder = { activityOlderLoading = true; scope.launch { try { repository.loadOlderActivity(session.id) } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { activityError = failure.message } finally { activityOlderLoading = false } } }) { item -> ActivityRow(repository, state, item) }
    if (reviewingOutcome && unknownSend != null) AlertDialog(onDismissRequest = { reviewingOutcome = false }, title = { Text("Check the previous send") },
        text = { Text("The provider may have received your previous message. Review this conversation and the provider on your PC before trying again. Your draft is kept; nothing will be sent automatically.") },
        confirmButton = { TextButton({ scope.launch { repository.acknowledgeUnknownCommand(unknownSend.commandId); reviewingOutcome = false; error = null } }) { Text("I've reviewed it on the PC") } },
        dismissButton = { TextButton({ reviewingOutcome = false }) { Text("Keep waiting") } })
    if (reviewOpen) ModalBottomSheet({ reviewOpen = false }) {
        Text("Requests for this conversation", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(20.dp))
        LazyColumn(Modifier.heightIn(max = 560.dp), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(waitingApprovals, key = { it.id }) { ApprovalCard(repository, state, activity, it) }
            if (waitingApprovals.isEmpty()) item { Text("All requests have been answered.") }
        }
    }
    desktopAttachments.firstOrNull { it.id == desktopReviewId }?.let { attachment ->
        DesktopAttachmentDialog(repository, state, session.id, attachment, onRemove = { desktopReviewId = null; desktopRemoveId = attachment.id }, onDismiss = { desktopReviewId = null })
    }
    desktopAttachments.firstOrNull { it.id == desktopRemoveId }?.let { attachment ->
        AlertDialog(onDismissRequest = { desktopRemoveId = null }, title = { Text("Remove ${attachment.name}?") },
            text = { Text("It leaves this conversation's draft on the desktop too, and is not sent. The original file on the PC is not changed.") },
            confirmButton = { TextButton({ desktopRemoveId = null; scope.launch { runCatching { repository.removeDesktopAttachment(session.id, attachment.id) }.onFailure { failure ->
                error = failure.message; if ((failure as? RemoteRequestException)?.code == "REVISION_CONFLICT") repository.selectSession(session.id) } } },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Remove") } },
            dismissButton = { TextButton({ desktopRemoveId = null }) { Text("Keep") } })
    }
    val reviewingAttachment = attachments.firstOrNull { it.id == attachmentReviewId }
    if (reviewingAttachment != null) AttachmentReviewDialog(repository, reviewingAttachment,
        onKeep = { scope.launch { repository.markAttachmentReviewed(reviewingAttachment.id); attachmentReviewId = null } },
        onRemove = { scope.launch { repository.removeAttachment(reviewingAttachment.id); attachmentReviewId = null } },
        onDismiss = { attachmentReviewId = null })
}

/** Decodes an image for display with its longer side at most [maxSide] pixels. */
internal fun decodeForDisplay(bytes: ByteArray, maxSide: Int): android.graphics.Bitmap? {
    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
}

@Composable
private fun AttachmentReviewDialog(repository: CereRepository, attachment: LocalAttachment, onKeep: () -> Unit, onRemove: () -> Unit, onDismiss: () -> Unit) {
    var bitmap by remember(attachment.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var error by remember(attachment.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(attachment.id) {
        try {
            val bytes = repository.attachmentPreview(attachment.id)
            bitmap = withContext(Dispatchers.Default) { decodeForDisplay(bytes, 2048) } ?: error("The private image copy could not be decoded")
        } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Review image") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Only this optimized private copy can be uploaded. Nothing leaves your phone until you choose Upload.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            bitmap?.let { Image(it.asImageBitmap(), contentDescription = "Image selected for this message", modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp).clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Fit) }
            if (bitmap == null && error == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Text("${attachment.width}×${attachment.height} · ${attachment.size / 1024} KiB", style = MaterialTheme.typography.bodySmall)
        }
    }, confirmButton = { Button(onKeep, enabled = bitmap != null, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep for message") } }, dismissButton = {
        FlowRow { TextButton(onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Review later") }; TextButton(onRemove,
            modifier = Modifier.heightIn(min = 48.dp), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Remove") } }
    })
}

/** W10: what a desktop draft attachment contains, as the desktop will send it. */
@Composable
private fun DesktopAttachmentDialog(repository: CereRepository, state: MobileState, sessionId: String, attachment: DraftAttachment, onRemove: () -> Unit, onDismiss: () -> Unit) {
    val previewable = attachment.kind != "image" || state.supports("attachments.read")
    var bitmap by remember(attachment.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var text by remember(attachment.id) { mutableStateOf<DesktopAttachmentPreview.Text?>(null) }
    var error by remember(attachment.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(attachment.id, previewable) {
        if (!previewable) return@LaunchedEffect
        try {
            when (val preview = repository.desktopAttachmentPreview(sessionId, attachment.id)) {
                is DesktopAttachmentPreview.Image -> bitmap = withContext(Dispatchers.Default) { decodeForDisplay(preview.preview.bytes, 2048) } ?: error("The preview could not be decoded")
                is DesktopAttachmentPreview.Text -> text = preview
            }
        } catch (cancelled: CancellationException) { throw cancelled } catch (_: StaleResultException) {} catch (failure: Exception) { error = failure.message }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(attachment.name, maxLines = 2, overflow = TextOverflow.Ellipsis) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Attached on the desktop. Sending this draft from the phone sends this file exactly as shown.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            bitmap?.let { Image(it.asImageBitmap(), contentDescription = "Preview of ${attachment.name}", modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp).clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Fit) }
            text?.let { preview ->
                SelectionContainer { Text(preview.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                if (preview.truncated) Text("Only the beginning is shown here. The whole file is sent.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
            }
            if (!previewable) Text("Viewing images from the desktop needs the preview permission for this phone.", style = MaterialTheme.typography.bodySmall)
            else if (bitmap == null && text == null && error == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Text("${if (attachment.kind == "image") "Image" else "Text file"} · ${attachment.size / 1024} KiB", style = MaterialTheme.typography.bodySmall)
        }
    }, confirmButton = { Button(onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Done") } }, dismissButton = {
        TextButton(onRemove, enabled = state.supports("drafts.put"), modifier = Modifier.heightIn(min = 48.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Remove from draft") }
    })
}

@Composable private fun ActivityRow(repository: CereRepository, state: MobileState, item: Message) {
    val clipboard = LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)
    val scope = rememberCoroutineScope()
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    var content by remember(item.id, item.revision) { mutableStateOf(item.text) }
    var loading by remember(item.id) { mutableStateOf(false) }
    var error by remember(item.id) { mutableStateOf<String?>(null) }
    Surface(Modifier.fillMaxWidth().padding(vertical = 6.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) { Column(Modifier.padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(item.text.lineSequence().firstOrNull()?.take(90).orEmpty().ifBlank { "Provider activity" }, fontWeight = FontWeight.SemiBold,
                maxLines = 2, modifier = Modifier.weight(1f))
            IconButton({ clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Cere activity", content)) }, Modifier.size(48.dp)) { Icon(painterResource(R.drawable.ic_copy), if (item.contentTruncated && content == item.text) "Copy activity preview" else "Copy activity text") }
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

/**
 * MOB-005: a Workbench result (proposed changes, files or images, an image or analysis run) is
 * reviewed on the desktop. The phone shows what it is and where to see it, never a partial preview.
 */
@Composable internal fun DesktopResultCard(message: Message) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Info, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.padding(start = 10.dp)) {
                Text(message.desktopOnly?.label ?: "A desktop result", fontWeight = FontWeight.SemiBold)
                Text("View this result on the desktop. Its files, images and review stay there.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable private fun MessageBubble(repository: CereRepository, state: MobileState, message: Message) {
    if (message.isDesktopOnlyResult()) { DesktopResultCard(message); return }
    val scope = rememberCoroutineScope(); var content by remember(message.id, message.revision) { mutableStateOf(message.text) }; var loading by remember(message.id, message.revision) { mutableStateOf(false) }; var error by remember(message.id, message.revision) { mutableStateOf<String?>(null) }
    val clipboard = LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)
    val uriHandler = LocalUriHandler.current
    // A Delegation update is Cere's text in a user-role row: shown on Cere's side, never as the user's message.
    val update = message.isDelegationUpdate(); val mine = message.role == "user" && !update
    // The stored Markdown keeps its memory citations; they are left out of what is shown and copied
    // unless the desktop shows them, including a marker that is still streaming in.
    val shown = remember(content, state.showMemoryCitations) { Citations.shown(content, state.showMemoryCitations) }
    val preview = message.contentTruncated && content == message.text
    val colors = MaterialTheme.colorScheme
    val clipboardLabel = stringResource(if (preview) R.string.copy_preview else R.string.copy_message)
    val bubbleShape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = if (mine) 20.dp else 6.dp, bottomEnd = if (mine) 6.dp else 20.dp)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Surface(color = when { mine -> colors.primaryContainer; update -> colors.secondaryContainer; else -> colors.surface },
            shape = bubbleShape, border = if (mine) null else BorderStroke(1.dp, colors.outlineVariant),
            modifier = Modifier.fillMaxWidth(if (mine) 0.87f else 1f)) {
            Column(Modifier.padding(start = 16.dp, end = 12.dp, bottom = 16.dp, top = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (update) stringResource(R.string.delegation_update) else if (mine) stringResource(R.string.your_message) else state.assistantName,
                style = MaterialTheme.typography.titleSmall, color = if (mine) colors.onPrimaryContainer else colors.primary,
                modifier = Modifier.weight(1f))
            if (message.bookmarked) Icon(Icons.Default.Star, stringResource(R.string.session_pinned), Modifier.size(16.dp), tint = colors.primary)
            var options by remember { mutableStateOf(false) }
            Box {
                IconButton({ options = true }) { Icon(Icons.Default.MoreVert, stringResource(R.string.message_actions), Modifier.size(20.dp)) }
                DropdownMenu(options, { options = false }) {
                    DropdownMenuItem({ Text(clipboardLabel) }, {
                        options = false
                        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Cere message", shown))
                    }, leadingIcon = { Icon(painterResource(R.drawable.ic_copy), null) })
                    if (state.supports("messages.bookmark") && message.isConversationMessage()) DropdownMenuItem(
                        { Text(stringResource(if (message.bookmarked) R.string.unpin_reply else R.string.pin_reply)) }, {
                            options = false
                            scope.launch { runCatching { repository.setBookmark(message, !message.bookmarked) }.onFailure { error = it.message } }
                        }, leadingIcon = { Icon(Icons.Default.Star, null) })
                }
            }
        }
        Markdown(shown)
        MessageSources(message.sources) { url -> runCatching { uriHandler.openUri(url) }.onFailure { error = "No app could open this link." } }
        if (preview) { Spacer(Modifier.height(8.dp)); Text("Message preview · ${message.contentChars ?: "many"} characters", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary); OutlinedButton({ scope.launch { loading = true; error = null; runCatching { repository.fullMessage(message) }.onSuccess { content = it }.onFailure { error = it.message }; loading = false } }, enabled = !loading && state.supports("sessions.messagePart")) { Text(if (loading) "Loading…" else "Load full message") } }
        error?.let { Text("$it. Open the full message on the desktop.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    } } }
}

/**
 * MOB-008: which desktop build this phone is (or was last) signed in to, the protocol they agreed,
 * this app's own build, and when it last synchronized. The summary can be copied for support; it
 * names no keys, tokens, offers, addresses, IDs or conversation content.
 */
@Composable
private fun ConnectionDetails(repository: CereRepository, state: MobileState) {
    val context = LocalContext.current
    val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
    var copied by remember { mutableStateOf(false) }
    val app = remember(context) {
        @Suppress("DEPRECATION") val info = context.packageManager.getPackageInfo(context.packageName, 0)
        AppIdentity(info.versionName ?: "unknown", info.longVersionCode, context.packageName, Build.VERSION.RELEASE ?: "unknown", Build.VERSION.SDK_INT)
    }
    val online = state.connection as? ConnectionState.Online
    val time = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
    OutlinedPanel("Connection details") {
        val build = state.desktopBuild
        val desktopBuild = when {
            build == null -> "Desktop build: unknown"
            online != null -> "Desktop build: ${ConnectionDiagnostics.buildText(build)}"
            else -> "Desktop build last seen: ${ConnectionDiagnostics.buildText(build)} · ${time.format(java.util.Date(build.seenAt))}"
        }
        val usable = state.providers.count { (_, value) -> (value as? JsonObject)?.get("remoteExecution")?.jsonPrimitive?.booleanOrNull == true }
        Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (online != null) "CONNECTED" else "LAST KNOWN CONNECTION", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = if (online != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary)
                SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Cere Mobile ${app.versionName} (${app.versionCode}) · ${app.channel} channel", style = MaterialTheme.typography.bodySmall)
                    Text(desktopBuild, style = MaterialTheme.typography.bodySmall)
                    Text("Protocol ${ConnectionDiagnostics.protocolText(build)}" + (online?.let { " · ${it.features.size} features · ${it.operations.size} operations" } ?: ""), style = MaterialTheme.typography.bodySmall)
                    Text("Providers usable from this phone: $usable of ${state.providers.size}", style = MaterialTheme.typography.bodySmall)
                    Text("Last synchronized: ${repository.lastSynchronizedAt()?.let { time.format(java.util.Date(it)) } ?: "never"}", style = MaterialTheme.typography.bodySmall)
                } }
            }
        }
        Text("This summary excludes keys, tokens, network addresses, device IDs, and conversation content.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton({ clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Cere connection details", ConnectionDiagnostics.summary(app, state, repository.lastSynchronizedAt()))); copied = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Icon(painterResource(R.drawable.ic_copy), null); Spacer(Modifier.width(8.dp)); Text(if (copied) "Copied" else "Copy diagnostic summary")
        }
    }
}

/** F77: the desktop's memory health in plain words; details stay in desktop Health. */
@Composable
private fun MemoryHealthLine(health: JsonObject) {
    val enabled = health["enabled"]?.jsonPrimitive?.booleanOrNull == true
    val failing = listOfNotNull("extraction".takeIf { health["extraction"]?.jsonPrimitive?.contentOrNull == "failing" }, "embeddings".takeIf { health["embedding"]?.jsonPrimitive?.contentOrNull == "failing" })
    val projections = health["projections"]?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }.filter { it["status"]?.jsonPrimitive?.contentOrNull == "degraded" }
    val text = when {
        !enabled -> "Memory is off or paused on the desktop. Chat still works."
        failing.isNotEmpty() || projections.isNotEmpty() || health["degraded"]?.jsonPrimitive?.booleanOrNull == true ->
            "Memory is degraded" + (if (failing.isNotEmpty()) ": ${failing.joinToString(" and ")} failing" else "") + ". Recall may be incomplete; chat still works. Details are in desktop Health."
        else -> "Memory is working."
    }
    Text(text, style = MaterialTheme.typography.bodySmall, color = if (enabled && text != "Memory is working.") MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
}

/** W11: the conversation's pinned replies, the same ones the desktop lists as bookmarks. */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun PinnedReplies(repository: CereRepository, state: MobileState, sessionId: String, onDismiss: () -> Unit) {
    var items by remember(sessionId) { mutableStateOf<List<Message>?>(null) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(sessionId, refresh) {
        try { items = repository.pinnedReplies(sessionId) }
        catch (cancelled: CancellationException) { throw cancelled } catch (_: StaleResultException) {} catch (failure: Exception) { error = failure.message }
    }
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Pinned replies", style = MaterialTheme.typography.headlineSmall)
                Text("Shared with desktop bookmarks", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onDismiss, Modifier.size(48.dp)) { Icon(Icons.Default.Close, "Close pinned replies") }
        }
        LazyColumn(Modifier.heightIn(max = 560.dp), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                error != null -> item { Text(error!!, color = MaterialTheme.colorScheme.error) }
                items == null -> item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                items!!.isEmpty() -> item { Text("No pinned replies yet. Pin a reply with its star.") }
                else -> items(items!!, key = { it.id }) { message -> MessageBubble(repository, state, message.copy(bookmarked = true)) }
            }
            item { TextButton({ refresh++ }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(6.dp)); Text("Refresh") } }
        }
    }
}

@Composable
private fun InboxScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity, highlighted: String? = null) {
    val gone = highlighted != null && state.approvals.none { it.id == highlighted }
    if (state.approvals.isEmpty()) return EmptyState(Icons.Default.Check, if (state.connection is ConnectionState.Online) "Inbox clear" else "No saved requests", if (state.connection !is ConnectionState.Online) "Reconnect to check for new requests from the desktop." else if (gone) "The request you opened was already answered or has ended." else "Requests that need your review appear here.")
    val list = rememberLazyListState()
    // A notification tap scrolls to its request.
    LaunchedEffect(highlighted, state.approvals.map(Approval::id)) {
        val index = state.approvals.indexOfFirst { it.id == highlighted }
        if (index >= 0) list.animateScrollToItem(index)
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PageTitle(stringResource(R.string.nav_inbox))
                Text("${state.approvals.size} waiting · Review the origin and exact request before answering.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            LazyColumn(state = list, modifier = Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(state.approvals, key = { it.id }) { approval -> ApprovalCard(repository, state, activity, approval, highlighted = approval.id == highlighted) }
                if (gone) item { Text("The request you opened was already answered or has ended.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

@Composable
private fun ApprovalCard(repository: CereRepository, state: MobileState, activity: FragmentActivity, approval: Approval, highlighted: Boolean = false) {
    val scope = rememberCoroutineScope(); var error by remember(approval.id, approval.revision, approval.digest) { mutableStateOf<String?>(null) }; var expanded by remember(approval.id) { mutableStateOf(true) }; var preview by remember(approval.id, approval.revision, approval.digest) { mutableStateOf<ApprovalPreview?>(null) }; var previewLoading by remember(approval.id, approval.revision, approval.digest) { mutableStateOf(false) }
    var validationAttempted by remember(approval.id, approval.revision, approval.digest) { mutableStateOf(false) }
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
    // Only an answer in flight for this exact request blocks it; an uncertain answer to an
    // earlier request, or to another request in the same conversation, does not.
    val pending = approval.id in mutations || CommandOutcomes.answering(state.pendingCommands, approval.id, approval.digest)
    var bitmap by remember(approval.id, approval.revision, approval.digest) { mutableStateOf<android.graphics.Bitmap?>(null) }
    val isQuestion = approval.kind == "question" || approval.questions.isNotEmpty()
    ElevatedCard(Modifier.fillMaxWidth().then(if (highlighted) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, CardDefaults.elevatedShape) else Modifier)) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Surface(shape = RoundedCornerShape(12.dp), color = if (isQuestion) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.tertiaryContainer) {
                Icon(if (isQuestion) Icons.Default.Info else Icons.Default.Warning, null, tint = if (isQuestion) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(10.dp).size(22.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(if (isQuestion) "QUESTION" else "PERMISSION · ${approval.kind.uppercase()}", style = MaterialTheme.typography.labelMedium, color = if (isQuestion) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.SemiBold)
                Text(approval.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            // Where the request comes from: the conversation, the agent inside it, and the conversation that delegated it.
                Text(approvalOrigin(state, approval), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        approval.detail?.let {
            OutlinedButton({ expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (expanded) "Hide exact request" else "Review exact request") }
            if (expanded) Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
                SelectionContainer { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(12.dp)) }
            }
        }
        approval.url?.let { url ->
            OutlinedButton({ runCatching { uriHandler.openUri(url) }.onFailure { error = it.message ?: "Could not open the link." } }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text("Open link ↗")
            }
            Text("Complete the requested step in your browser, then confirm below.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (approval.kind == "image") {
            val image = bitmap
            if (image != null) {
                Image(image.asImageBitmap(), "Exact capture proposed for sharing", Modifier.fillMaxWidth()
                    .heightIn(max = 420.dp).clip(MaterialTheme.shapes.medium), contentScale = ContentScale.Fit)
                Text("Verified capture", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
            } else if (state.supports("approvals.preview") && state.supports("attachments.read")) OutlinedButton({
                scope.launch {
                    previewLoading = true; error = null
                    try {
                        val fetched = repository.approvalPreview(approval)
                        val decoded = withContext(Dispatchers.Default) { decodeForDisplay(fetched.bytes, 2048) }
                        if (decoded == null) error = "The capture could not be displayed. Try again or review it on your desktop."
                        else { bitmap = decoded; preview = fetched }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (failure: Exception) { error = failure.message }
                    finally { previewLoading = false }
                }
            }, enabled = !previewLoading, modifier = Modifier.fillMaxWidth()) {
                Text(if (previewLoading) "Loading preview…" else "Review exact capture")
            } else SecureStatusPanel("Review on your desktop", "This phone does not have access to the capture preview.", tone = SecureTone.Attention)
        }
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
        if (unsupported) SecureStatusPanel("Continue on the desktop", "This form contains an unsupported field. You can still deny it here.", tone = SecureTone.Attention)
        if (!approval.canAnswer && approval.choices.any { it !in setOf("deny","cancel") }) SecureStatusPanel("Desktop review required", "Positive answers are blocked by the current provider policy.", tone = SecureTone.Attention)
        if (!state.supports("approvals.answer")) SecureStatusPanel("Read-only access", "This device can review this request but cannot answer it.", tone = SecureTone.Attention)
        if (pending) SecureStatusPanel("Submitting response", "Keep Cere open while the desktop confirms it.", tone = SecureTone.Info)
        // Actions wrap instead of squeezing their labels at large text sizes.
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) { approval.choices.forEach { choice ->
            val deny = choice == "deny" || choice == "cancel"
            if (deny) OutlinedButton({
                if (!repository.beginApprovalMutation(approval)) return@OutlinedButton
                scope.launch { try { repository.mutate("approvals.answer", approvalParams(approval, choice, emptyMap()), approval.title) } catch (failure: Exception) { error = failure.message } finally { repository.endApprovalMutation(approval) } }
            }, enabled = state.supports("approvals.answer") && !pending, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(choice.replaceFirstChar(Char::uppercase)) }
            else Button({
                validationAttempted = true
                if (!answersComplete || !repository.beginApprovalMutation(approval)) return@Button
                scope.launch {
                    runCatching { repository.prepareAction("approvals.answer", approvalParams(approval, choice, answers, preview?.imageDigest), label = approval.title) }
                        .onSuccess { action ->
                            runCatching { authenticate(activity, "${choice.replaceFirstChar(Char::uppercase)} ${approval.title}", action, repository,
                                { repository.endApprovalMutation(approval) },
                                { error = it; repository.endApprovalMutation(approval) }) }
                                .onFailure { error = it.message; repository.endApprovalMutation(approval) }
                        }
                        .onFailure { error = it.message; repository.endApprovalMutation(approval) }
                }
            }, enabled = approval.canAnswer && !unsupported && state.supports("approvals.answer") && !pending && (approval.kind != "image" || preview != null), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(when { choice == "answer" -> "Send answers"; choice == "allow" && approval.url != null -> "I've completed it"; else -> choice.replaceFirstChar(Char::uppercase) }) }
        } }
        if (validationAttempted && !answersComplete) Text("Answer each required question before sending.", color = MaterialTheme.colorScheme.error)
        error?.let { SecureStatusPanel("Request needs attention", it, tone = SecureTone.Danger) }
    } }
}

@Composable
private fun QuestionField(question: ApprovalQuestion, index: Int, count: Int, answers: List<String>, error: String?, update: (List<String>) -> Unit) {
    val other = questionOtherValue(question, answers)
    OutlinedPanel("Question ${index + 1} of $count · ${if (question.required) "Required" else "Optional"}") {
        question.header?.let { Text(it, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
        Text(question.question, style = MaterialTheme.typography.bodyLarge, fontWeight = if (question.header == null) FontWeight.Medium else FontWeight.Normal)
        question.options.forEach { option ->
            val selected = option.label in answers
            FilterChip(selected, { update(selectQuestionOption(question, answers, option.label, !selected)) }, {
                Column { Text(option.label); option.description?.takeIf(String::isNotBlank)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp))
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

@Composable private fun OutlinedPanel(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun MemoryScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity) {
    val readable = state.supports("memory.list") || state.supports("memory.retrieve")
    if (!readable) return EmptyState(Icons.Default.Lock, "Memory is not granted", "Enable scoped memory access from Desktop Settings.")
    // Memory belongs to a conversation's project on its memory server, whichever provider it uses; the
    // desktop refuses a conversation whose memory server is not granted to this phone.
    val scope = rememberCoroutineScope(); val sessions = state.sessions.filter { it.mode != "linked" }
    var sessionId by rememberSaveable { mutableStateOf(sessions.firstOrNull()?.id.orEmpty()) }; var kind by rememberSaveable { mutableStateOf("saved") }
    var filter by rememberSaveable { mutableStateOf("") }; var query by rememberSaveable { mutableStateOf("") }; var offset by rememberSaveable { mutableIntStateOf(0) }
    var result by remember { mutableStateOf<JsonObject?>(null) }; var loading by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var adding by rememberSaveable { mutableStateOf(false) }
    var managedRecord by remember { mutableStateOf<JsonObject?>(null) }; var managing by remember { mutableStateOf(false) }; var clearProject by rememberSaveable { mutableStateOf(false) }
    val sessionIds = sessions.map(Session::id)
    fun clearVisibleMemory() { result = null; managedRecord = null; managing = false; clearProject = false; adding = false; error = null; offset = 0 }
    LaunchedEffect(state.cacheEpoch) { clearVisibleMemory(); filter = ""; query = "" }
    LaunchedEffect(sessionIds) { if (sessionId !in sessionIds) { clearVisibleMemory(); filter = ""; query = ""; sessionId = sessionIds.firstOrNull().orEmpty() } }
    LaunchedEffect(sessionId) { result = null; managedRecord = null; managing = false; clearProject = false; adding = false; error = null }
    // A result is shown only for the conversation and view it was asked for, and never after the
    // desktop's memory changed meanwhile (read() refuses it): erased text cannot come back.
    fun list() { if (sessionId.isBlank() || !state.supports("memory.list")) return; val asked = Triple(sessionId, kind, offset); scope.launch { loading = true; error = null; runCatching { repository.read("memory.list", buildJsonObject { put("sessionId", asked.first); put("kind", asked.second); put("offset", asked.third); put("filter", filter.trim()) }).jsonObject }.onSuccess { if (Triple(sessionId, kind, offset) == asked) result = it }.onFailure { error = it.message }; loading = false } }
    fun retrieve() { if (sessionId.isBlank() || query.isBlank() || !state.supports("memory.retrieve")) return; val asked = sessionId; scope.launch { loading = true; error = null; runCatching { repository.read("memory.retrieve", buildJsonObject { put("sessionId", asked); put("query", query.trim()) }).jsonObject }.onSuccess { if (sessionId == asked) result = it }.onFailure { error = it.message }; loading = false } }
    LaunchedEffect(sessionId, kind, offset, state.cacheEpoch) { if (sessionId.isNotBlank() && state.supports("memory.list")) list() }
    // F77: memory health without endpoints or error text; degraded memory never blocks chat.
    var health by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(sessionId, state.cacheEpoch) { health = if (sessionId.isNotBlank() && state.supports("memory.health")) runCatching { repository.read("memory.health", buildJsonObject { put("sessionId", sessionId) }).jsonObject }.getOrNull() else null }
    val rows = result?.get("rows")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }; val total = result?.get("total")?.jsonPrimitive?.intOrNull ?: rows.size
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { PageTitle("Project memory"); Text("Review memory within the selected conversation's approved project and memory server.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        health?.let { value -> item { MemoryHealthLine(value) } }
        if (sessions.isEmpty()) item { OutlinedPanel("No conversations") { Text("Create or open a conversation in an approved project before opening memory.", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        else item { Text("Session", fontWeight = FontWeight.Medium); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { sessions.forEach { session -> val project = state.projects.firstOrNull { it.id == session.projectId }; FilterChip(sessionId == session.id, { sessionId = session.id; offset = 0 }, { Column { Text(session.title); Text(project?.name ?: session.project.orEmpty(), style = MaterialTheme.typography.labelSmall) } }) } }; sessions.firstOrNull { it.id == sessionId }?.let { session -> val project = state.projects.firstOrNull { it.id == session.projectId }; OutlinedPanel(project?.name ?: "Approved project") { SelectionContainer { Text(project?.path ?: session.project ?: "Path unavailable", style = MaterialTheme.typography.bodySmall) }; Text("Ollama · ${session.ollamaHost.ifBlank { state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: "host unavailable" }}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
        if (state.supports("memory.list")) item { Text("Browse", style = MaterialTheme.typography.titleMedium); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("saved" to "Saved", "conversation" to "Conversation", "assertions" to "Assertions", "episodes" to "Episodes", "entities" to "Entities").forEach { (id,label) -> FilterChip(kind == id, { kind = id; offset = 0 }, { Text(label) }) } }; Row(verticalAlignment = Alignment.CenterVertically) { OutlinedTextField(filter, { filter = it }, placeholder = { Text("Find text in memory") }, singleLine = true, modifier = Modifier.weight(1f)); Spacer(Modifier.width(8.dp)); OutlinedButton({ offset = 0; list() }, enabled = !loading) { Text("Find") } } }
        if (state.supports("memory.retrieve")) item { Text("Recall", style = MaterialTheme.typography.titleMedium); Row(verticalAlignment = Alignment.CenterVertically) { OutlinedTextField(query, { query = it.take(1000) }, placeholder = { Text("Ask what Cere remembers") }, singleLine = true, modifier = Modifier.weight(1f)); Spacer(Modifier.width(8.dp)); OutlinedButton(::retrieve, enabled = query.isNotBlank() && !loading) { Text("Recall") } } }
        if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        items(rows, key = { it["id"]?.jsonPrimitive?.contentOrNull ?: it.toString() }) { row ->
            MemoryRow(row, if (state.supports("memory.forgetPreview") || state.supports("memory.timeline")) ({ managedRecord = row; managing = true }) else null)
        }
        if (!loading && result != null && rows.isEmpty()) item { Text("No matching memory records.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        result?.takeIf { "rows" !in it }?.let { value -> item { StructuredObject(value) } }
        if (result?.containsKey("rows") == true) item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { OutlinedButton({ offset = (offset - 25).coerceAtLeast(0) }, enabled = offset > 0 && !loading) { Text("Previous") }; Text("$total total", color = MaterialTheme.colorScheme.onSurfaceVariant); OutlinedButton({ offset += 25 }, enabled = offset + 25 < total && !loading) { Text("Next") } } }
        if (state.supports("memory.save") && sessions.isNotEmpty()) item { Button({ adding = true }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Add, null); Spacer(Modifier.width(8.dp)); Text("Remember a fact") } }
        // Forgetting is two steps: gone from recall at once, physically removed later. Receipts keep both visible.
        if (state.erasures.isNotEmpty()) item { OutlinedPanel("Forget receipts") {
            state.erasures.forEach { receipt -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(receipt.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(when { receipt.purgeComplete -> "Hidden from recall · physically removed"; receipt.checkedAt != null -> "Hidden from recall · physical removal ${receipt.state?.lowercase() ?: "in progress"}"; else -> "Hidden from recall · physical removal not checked yet" },
                        style = MaterialTheme.typography.bodySmall, color = if (receipt.purgeComplete) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!receipt.purgeComplete && state.supports("memory.erasureStatus")) TextButton({ scope.launch { runCatching { repository.checkErasure(receipt.jobId) }.onFailure { error = it.message } } }) { Text("Check") }
                else TextButton({ scope.launch { repository.dismissErasure(receipt.jobId) } }) { Text("Dismiss") }
            } }
        } }
        if (state.supports("memory.forgetPreview") && state.supports("memory.clear") && sessions.isNotEmpty()) item { OutlinedButton({ clearProject = true }, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error), modifier = Modifier.fillMaxWidth()) { Text("Clear this project's memory") } }
    }
    if (adding) { var text by rememberSaveable { mutableStateOf("") }; var saveError by remember { mutableStateOf<String?>(null) }; AlertDialog(onDismissRequest = { adding = false }, title = { Text("Remember a fact") }, text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(text, { text = it.take(MEMORY_FACT_LIMIT) }, minLines = 5, label = { Text("Fact") }, modifier = Modifier.fillMaxWidth()); Text("${text.length} / $MEMORY_FACT_LIMIT characters", color = MaterialTheme.colorScheme.onSurfaceVariant); saveError?.let { Text(it, color = MaterialTheme.colorScheme.error) } } }, confirmButton = { Button({ scope.launch { runCatching { val action = repository.prepareAction("memory.save", buildJsonObject { put("sessionId", sessionId); put("text", text.trim()) }); authenticate(activity, "Save this memory", action, repository, { adding = false; offset = 0; list() }, { saveError = it }) }.onFailure { saveError = it.message } } }, enabled = text.isNotBlank()) { Text("Review & save") } }, dismissButton = { TextButton({ adding = false }) { Text("Cancel") } }) }
    if (managing) managedRecord?.let { record -> MemoryRecordSheet(repository, state, activity, sessionId, record, { managing = false; managedRecord = null }, { list() }, kind, rows) }
    if (clearProject) MemoryRecordSheet(repository, state, activity, sessionId, null, { clearProject = false }, { list() })
}

@Composable
private fun SettingsScreen(repository: CereRepository, state: MobileState, activity: FragmentActivity, group: SettingsGroup?, selectGroup: (SettingsGroup?) -> Unit) {
    val context = LocalContext.current; val scope = rememberCoroutineScope(); var confirmForget by rememberSaveable { mutableStateOf(false) }; var showMemory by rememberSaveable { mutableStateOf(false) }; var replacePairing by rememberSaveable { mutableStateOf(false) }
    var remoteSettings by remember { mutableStateOf(state.settings) }; var personality by rememberSaveable { mutableStateOf("") }; var defaultModel by rememberSaveable { mutableStateOf("") }; var searchProvider by rememberSaveable { mutableStateOf("auto") }; var settingsDirty by rememberSaveable { mutableStateOf(false) }; var settingsConflict by rememberSaveable { mutableStateOf(false) }; var baselineRevision by rememberSaveable { mutableStateOf("0") }; var loading by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var feedback by remember { mutableStateOf<String?>(null) }
    var alertsOn by remember { mutableStateOf(CereNotifications.requestAlertsEnabled(context)) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) alertsOn = CereNotifications.requestAlertsEnabled(context) }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) }
    }
    val permissions = state.permissions; val paused = permissions["paused"]?.jsonPrimitive?.booleanOrNull == true; val categories = permissions["categories"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }; val caps = permissions["caps"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
    fun applySettings(value: JsonObject) { remoteSettings = value; personality = value["personality"]?.jsonPrimitive?.contentOrNull.orEmpty(); defaultModel = value["defaultModel"]?.jsonPrimitive?.contentOrNull.orEmpty(); searchProvider = value["webSearch"]?.jsonObject?.get("provider")?.jsonPrimitive?.contentOrNull ?: "auto"; baselineRevision = value["revision"]?.jsonPrimitive?.contentOrNull ?: "0"; settingsDirty = false; settingsConflict = false }
    fun receiveSettings(value: JsonObject) { val revision = value["revision"]?.jsonPrimitive?.contentOrNull ?: "0"; if (settingsDirty && revision != baselineRevision) { remoteSettings = value; settingsConflict = true } else if (!settingsDirty) applySettings(value) }
    LaunchedEffect(state.settings, state.connection is ConnectionState.Online, group == SettingsGroup.Assistant) { if (group == SettingsGroup.Assistant && state.supports("settings.get")) { loading = true; runCatching { repository.read("settings.get", buildJsonObject {}).jsonObject }.onSuccess(::receiveSettings).onFailure { error = it.message }; loading = false } else receiveSettings(state.settings) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        alertsOn = CereNotifications.requestAlertsEnabled(context)
        if (!granted && Build.VERSION.SDK_INT >= 33 && !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) feedback = "Android didn't ask again. Turn on notifications for Cere in Notification settings."
    }
    val localNetworkPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) startMonitoring(context) else error = "Local network permission is required to monitor the desktop." }
    fun requestAlerts() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else openNotificationSettings(context)
    }
    BackHandler(enabled = showMemory) { showMemory = false }
    if (replacePairing) {
        val desktop = state.desktop
        if (desktop != null) PairingScreen(repository, state, activity, desktop) { replacePairing = false }
        return
    }
    if (showMemory) { Column(Modifier.fillMaxSize()) { Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) { IconButton({ showMemory = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to settings") }; Text("Settings", style = MaterialTheme.typography.titleMedium) }; MemoryScreen(repository, state, activity) }; return }
    if (group == null) {
        SettingsIndex(state) { selectGroup(it) }
        return
    }
    val groupState = key(group) { rememberLazyListState() }
    LazyColumn(state = groupState, contentPadding = PaddingValues(CereLayout.gutter), verticalArrangement = Arrangement.spacedBy(CereLayout.groupGap)) {
        item {
            TextButton({ selectGroup(null) }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
                Text(stringResource(R.string.nav_settings))
            }
            PageTitle(stringResource(group.title))
        }
        if (loading && group == SettingsGroup.Assistant) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        feedback?.let { item { SecureStatusPanel("Updated", it, tone = SecureTone.Success) } }
        error?.let { item { SecureStatusPanel("Couldn't finish", it, tone = SecureTone.Danger) } }
        when (group) {
            SettingsGroup.Access -> {
                item { OutlinedPanel(if (paused) "Actions paused" else "${permissions["profile"]?.jsonPrimitive?.contentOrNull ?: "Scoped"} access") { Text(if (paused) "The desktop is currently blocking remote actions." else "This phone can use only the capabilities negotiated at sign-in.", color = if (paused) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant); if (categories.isNotEmpty()) Text("Categories · ${categories.joinToString()}", style = MaterialTheme.typography.bodySmall); if (caps.isNotEmpty()) Text("Capabilities · ${caps.joinToString()}", style = MaterialTheme.typography.bodySmall); if (!paused && state.supports("permissions.pause")) OutlinedButton({ scope.launch { runCatching { repository.mutate("permissions.pause", buildJsonObject {}) }.onSuccess { feedback = "Desktop actions paused" }.onFailure { error = it.message } } }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Pause desktop actions") } } }
                if (state.supports("permissions.reduce") && state.supports("devices.self")) item {
                    PermissionReductionPanel(repository, state, { feedback = it }, { error = it })
                }
            }
            SettingsGroup.Assistant -> {
                if (state.supports("settings.get")) item { OutlinedPanel("Defaults") { if (settingsConflict) { Text("Desktop settings changed while you were editing. Your values are preserved.", color = MaterialTheme.colorScheme.tertiary); FlowRow { TextButton({ applySettings(remoteSettings) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Reload desktop") }; TextButton({ baselineRevision = remoteSettings["revision"]?.jsonPrimitive?.contentOrNull ?: baselineRevision; settingsConflict = false }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep mine") } } }; OutlinedTextField(personality, { personality = it.take(8000); settingsDirty = true }, label = { Text("Personality") }, minLines = 3, modifier = Modifier.fillMaxWidth(), supportingText = { Text("Applies to every conversation unless a project or conversation style on the desktop replaces it.") }); if (!remoteSettings["ollamaHost"]?.jsonPrimitive?.contentOrNull.isNullOrBlank()) OutlinedTextField(defaultModel, { defaultModel = it.take(512); settingsDirty = true }, label = { Text("Default Ollama model") }, singleLine = true, modifier = Modifier.fillMaxWidth()); Text("Web search provider", style = MaterialTheme.typography.labelLarge); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { listOf("auto","duckduckgo","brave","mojeek","searxng").forEach { provider -> FilterChip(searchProvider == provider, { searchProvider = provider; settingsDirty = true }, { Text(provider) }, modifier = Modifier.heightIn(min = 48.dp)) } }; if (state.supports("settings.patch")) Button({ scope.launch { runCatching { val action = repository.prepareAction("settings.patch", assistantSettingsPatch(remoteSettings, baselineRevision, personality, defaultModel, searchProvider)); authenticate(activity, "Update assistant settings", action, repository, { value -> applySettings(value.jsonObject); feedback = "Settings updated" }, { error = it }) }.onFailure { error = it.message } } }, enabled = !loading && !settingsConflict && settingsDirty, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Review & save") } else Text("This device has read-only settings access.", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
                if (state.supports("memory.list") || state.supports("memory.retrieve")) item { OutlinedPanel("Project memory") { Text("Browse saved facts, conversation passages, assertions, episodes, and entities for an approved conversation.", color = MaterialTheme.colorScheme.onSurfaceVariant); OutlinedButton({ showMemory = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Icon(Icons.Default.Star, null); Spacer(Modifier.width(8.dp)); Text("Open memory") } } }
            }
            SettingsGroup.Phone -> {
                item { OutlinedPanel(stringResource(R.string.conversation_preferences)) {
                    val portraitShown by UiPreferences.portrait(context).collectAsState()
                    Row(Modifier.toggleable(portraitShown, role = Role.Switch) { UiPreferences.setPortrait(context, it) },
                        verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text("Show the assistant's portrait"); Text("Show the desktop portrait alongside the conversation status.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        Switch(portraitShown, null)
                    }
                    HorizontalDivider()
                    var keyboardSend by remember { mutableStateOf(UiPreferences.sendFromKeyboard(context)) }
                    Row(Modifier.fillMaxWidth().heightIn(min = CereLayout.target).toggleable(keyboardSend, role = Role.Switch) {
                        keyboardSend = it
                        UiPreferences.setSendFromKeyboard(context, it)
                    }, verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.keyboard_send))
                            Text(stringResource(R.string.keyboard_send_detail), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Switch(keyboardSend, null)
                    }
                } }
                item { OutlinedPanel("Background connection") { ListItem(headlineContent = { Text("Monitor in the background") }, supportingContent = { Text("Keeps a private notification and the desktop connection while Cere is closed, so requests, replies and timers can alert you.") }, trailingContent = { Switch(state.monitoring, { enabled -> if (enabled) { if (Build.VERSION.SDK_INT >= 33 && !NotificationManagerCompat.from(context).areNotificationsEnabled()) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS); if (Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(context, "android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) localNetworkPermission.launch("android.permission.ACCESS_LOCAL_NETWORK") else startMonitoring(context) } else context.stopService(Intent(context, MonitoringService::class.java)) }) }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f))) } }
                item { OutlinedPanel("Request notifications") { ListItem(headlineContent = { Text("Request alerts") }, supportingContent = { Text(when {
                    !alertsOn -> "Off. Approval and question requests arrive silently. Allow notifications so they can reach you."
                    !state.monitoring -> "On while background monitoring is on."
                    else -> "On. Lock-screen alerts hide request details."
                }, color = if (alertsOn) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error) }, trailingContent = { if (!alertsOn) TextButton(::requestAlerts, modifier = Modifier.heightIn(min = 48.dp)) { Text("Allow") } }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f)))
                    HorizontalDivider()
                    ListItem(headlineContent = { Text("Notification settings") }, supportingContent = { Text("Choose how requests, replies, problems and timers alert you") }, modifier = Modifier.clickable { openNotificationSettings(context) }.heightIn(min = 56.dp), colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f)))
                } }
            }
            SettingsGroup.Connection -> {
                item { OutlinedPanel("Desktop connection") {
                    when (val connection = state.connection) {
                        is ConnectionState.Online -> Text("Connected to ${connection.desktopName}", color = MaterialTheme.colorScheme.primary)
                        is ConnectionState.Offline -> {
                            Text(connection.reason, style = MaterialTheme.typography.bodySmall)
                            if (connection.kind == OfflineKind.Unreachable) Text("Check that the PC is awake and reachable over Wi-Fi or your VPN. After a Wi-Fi address change, the PC firewall may still allow the phone's previous address.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (connection.kind == OfflineKind.MonitoringOff) Text("Cere connects whenever it is open. Turn on background monitoring to stay connected while it is closed.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            OutlinedButton(repository::retry, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (connection.kind == OfflineKind.Unreachable) "Retry connection" else "Connect now") }
                        }
                        else -> Text("Connecting to your paired desktop…")
                    }
                } }
                item { ConnectionDetails(repository, state) }
                // Actions whose outcome the desktop never confirmed. Nothing here is sent again.
                if (state.pendingCommands.isNotEmpty()) item { OutlinedPanel("Unconfirmed desktop actions") {
                    Text("Cere couldn't confirm these with the desktop. Check each one on the PC; nothing is sent again automatically.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    state.pendingCommands.forEach { command -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(CommandOutcomes.describe(command), maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(if (command.status == "unknown") "Outcome unknown · check it on the PC" else "Checking with the desktop…", style = MaterialTheme.typography.bodySmall, color = if (command.status == "unknown") MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (command.status == "unknown") TextButton({ scope.launch { runCatching { repository.acknowledgeUnknownCommand(command.commandId) }.onFailure { error = it.message } } }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Checked") }
                    } }
                } }

            }
            SettingsGroup.Pairing -> {
                item { MobileMaintenanceSection() }
                item { OutlinedPanel("Paired desktop") { ListItem(headlineContent = { Text(state.desktop?.desktopName.orEmpty()) }, supportingContent = { Text("Device ${state.desktop?.deviceId?.take(8)} · pinned TLS identity") }, leadingContent = { Icon(Icons.Default.Home, null) }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f))) } }
                item { OutlinedButton({ replacePairing = true }, enabled = repository.replacementBlocker() == null, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Replace pairing from this desktop") } }
                repository.replacementBlocker()?.let { blocker -> item { Text(blocker, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) } }
                item { OutlinedButton({ confirmForget = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Forget this desktop") } }
            }
        }
    }
    if (confirmForget) AlertDialog(onDismissRequest = { confirmForget = false }, title = { Text("Forget desktop?") }, text = { Text("This removes the encrypted cache, drafts and both phone keys. Pairing is required again.") }, confirmButton = { Button({ confirmForget = false; activity.lifecycleScope.launch { repository.forget() } }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Forget") } }, dismissButton = { TextButton({ confirmForget = false }) { Text("Cancel") } })
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
        runCatching { repository.read("devices.self", buildJsonObject {}).jsonObject }
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
    val removedCount = removedCaps.size + removedCategories.size + removedScripts.size + removedProjects.size + removedHosts.size
    OutlinedPanel("Reduce this phone's access") {
        Text("Turn off grants this phone should no longer have. Selected grants are kept; adding access still requires the desktop.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        fun toggle(value: String, values: Set<String>, update: (Set<String>) -> Unit) = update(if (value in values) values - value else values + value)
        if (projects.isNotEmpty()) { Text("Projects", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { projects.forEach { project -> val id = project["id"]?.jsonPrimitive?.contentOrNull ?: return@forEach; val name = project["name"]?.jsonPrimitive?.contentOrNull ?: project["path"]?.jsonPrimitive?.contentOrNull ?: id; FilterChip(id in selectedProjects, { toggle(id, selectedProjects) { selectedProjects = it } }, { Text(name) }, enabled = !pending, modifier = Modifier.heightIn(min = 48.dp)) } } }
        if (categories.isNotEmpty()) { Text("Action categories", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { categories.forEach { value -> FilterChip(value in selectedCategories, { toggle(value, selectedCategories) { selectedCategories = it } }, { Text(value) }, enabled = !pending, modifier = Modifier.heightIn(min = 48.dp)) } } }
        if (caps.isNotEmpty()) { Text("Capabilities", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { caps.forEach { value -> FilterChip(value in selectedCaps, { toggle(value, selectedCaps) { selectedCaps = it } }, { Text(value) }, enabled = !pending, modifier = Modifier.heightIn(min = 48.dp)) } } }
        if (scripts.isNotEmpty()) { Text("Scripts", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { scripts.forEach { value -> FilterChip(value in selectedScripts, { toggle(value, selectedScripts) { selectedScripts = it } }, { Text(value) }, enabled = !pending, modifier = Modifier.heightIn(min = 48.dp)) } } }
        if (hosts.isNotEmpty()) { Text("Ollama hosts", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { hosts.forEach { value -> FilterChip(value in selectedHosts, { toggle(value, selectedHosts) { selectedHosts = it } }, { Text(value) }, enabled = !pending, modifier = Modifier.heightIn(min = 48.dp)) } } }
        if (changed) SecureStatusPanel("$removedCount ${if (removedCount == 1) "grant" else "grants"} will be removed", "Review the exact list before reconnecting with reduced access.", tone = SecureTone.Attention)
        if (pending) SecureStatusPanel("Reduction pending", "Waiting for the desktop to confirm the access reduction after reconnect…", tone = SecureTone.Attention)
        Button({ review = true }, enabled = changed && scopeVersion != null && !pending && !loading, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Review reduced access") }
    }
    if (review && scopeVersion != null) AlertDialog(onDismissRequest = { review = false }, title = { Text("Remove these grants?") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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

@Composable internal fun StructuredObject(value: JsonObject) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        value.forEach { (key, item) ->
            Column {
                Text(key.replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer { Text(if (item is JsonPrimitive) item.content else item.toString(), style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}

@Composable private fun EmptyState(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, detail: String) = EmptyState(androidx.compose.ui.graphics.vector.rememberVectorPainter(icon), title, detail)
@Composable private fun EmptyState(icon: androidx.compose.ui.graphics.painter.Painter, title: String, detail: String) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // A library empty state is itself a lazy-list item and has no upper height constraint.
        val scroll = if (constraints.hasBoundedHeight) Modifier.verticalScroll(rememberScrollState()) else Modifier
        Column(scroll.widthIn(max = 420.dp).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.secondaryContainer) {
                Icon(icon, null, Modifier.padding(14.dp).size(28.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
            }
            Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

@Composable private fun Markdown(value: String) = CereMarkdown(value)

/** "Conversation · agent Scout · delegated from Parent", from the scoped session list and the request's opaque agent reference. */
internal fun approvalOrigin(state: MobileState, approval: Approval): String {
    val session = state.sessions.firstOrNull { it.id == approval.sessionId }
    val agent = approval.agentId?.let { id -> session?.agents?.firstOrNull { it.id == id } }
    val parent = approval.parentSessionIds.firstNotNullOfOrNull { id -> state.sessions.firstOrNull { it.id == id } }
    return listOfNotNull(session?.title ?: "A conversation not loaded on this phone", agent?.let { "agent ${it.name}" }, parent?.let { "delegated from ${it.title}" }).joinToString(" · ")
}
