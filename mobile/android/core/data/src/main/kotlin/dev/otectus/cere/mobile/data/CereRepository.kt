package dev.otectus.cere.mobile.data

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import dev.otectus.cere.mobile.protocol.*
import dev.otectus.cere.mobile.protocol.Request as WireRequest
import dev.otectus.cere.mobile.protocol.Response as WireResponse
import java.security.Signature
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.random.Random
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

sealed interface ConnectionState {
    data object Unpaired : ConnectionState
    data class Offline(val reason: String, val lastVerifiedAt: Long?, val kind: OfflineKind = OfflineKind.Unreachable) : ConnectionState
    /** [repair] is true only when a new or replacement pairing is the fix. */
    data class Blocked(val reason: String, val repair: Boolean = false) : ConnectionState
    data object Connecting : ConnectionState
    data object Authenticating : ConnectionState
    /** [features]: behaviour beyond [operations] the desktop negotiated in welcome (protocol 1.1). */
    data class Online(val desktopName: String, val operations: Set<String>, val expiresAt: Long, val features: Set<String> = emptySet()) : ConnectionState
}

data class MobileState(
    val restoreReady: Boolean = false,
    val desktop: PairedDesktop? = null,
    val stagedPairing: CompletedPairing? = null,
    val connection: ConnectionState = ConnectionState.Unpaired,
    val sessions: List<Session> = emptyList(), val messages: List<Message> = emptyList(),
    val approvals: List<Approval> = emptyList(), val projects: List<Project> = emptyList(),
    val providers: JsonObject = JsonObject(emptyMap()), val permissions: JsonObject = JsonObject(emptyMap()),
    val settings: JsonObject = JsonObject(emptyMap()), val cursor: String? = null, val lastError: String? = null,
    val drafts: Map<String, LocalDraft> = emptyMap(), val pendingCommands: List<PendingCommand> = emptyList(),
    val selectedSessionId: String? = null,
    val attachments: List<LocalAttachment> = emptyList(),
    val monitoring: Boolean = false,
    val cacheEpoch: String? = null,
    val messagesBefore: Map<String, String> = emptyMap(),
    val scrollPositions: Map<String, SessionScrollPosition> = emptyMap(),
    /** Where each conversation's Activity continues (activity.page); absent when it is all loaded. */
    val activityBefore: Map<String, String> = emptyMap(),
    /** In-scope conversations the snapshot named that this phone has not loaded yet. */
    val sessionsNotLoaded: Int = 0,
    /** The desktop search being shown, with every match it named. */
    val search: SessionSearch? = null,
    val erasures: List<ErasureReceipt> = emptyList(),
) {
    fun supports(operation: String) = (connection as? ConnectionState.Online)?.operations?.contains(operation) == true
    fun has(feature: String) = (connection as? ConnectionState.Online)?.features?.contains(feature) == true
    /** The assistant's name as the desktop shows it. */
    val assistantName: String get() = settings["assistantName"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }?.take(40) ?: "Cere"
    /** The desktop's citation setting: memory citations are hidden unless it shows them. */
    val showMemoryCitations: Boolean get() = settings["showMemoryCitations"]?.jsonPrimitive?.booleanOrNull == true
    fun draft(session: Session) = drafts[session.id] ?: LocalDraft(session.id, session.draft, session.draftRevision, session.draftRevision, false)
    /**
     * W10: whether this phone can show [session]'s desktop draft attachments, and so edit or send that
     * draft with them: the desktop lists every attachment it counts.
     */
    fun showsDesktopAttachments(session: Session) = has("drafts.desktopAttachments") && session.draftIncluded && session.draftAttachmentCount == session.draftAttachments.size
    /** A draft without desktop attachments, or one whose desktop attachments this phone shows. */
    fun draftEditable(session: Session) = session.draftAttachmentCount == 0 || (session.draftAttachmentCount ?: 0) > 0 && showsDesktopAttachments(session)
}

/** The desktop's portrait sheet: [columns] cells of [cell] pixels, indexed by expression in [frames]. */
class PortraitSheet(val avatarId: String, val label: String, val bytes: ByteArray, val columns: Int, val cell: Int,
    val frames: Map<String, Int>, val palette: Map<String, String>, val sha256: String)

/** W10: what a desktop draft attachment contains, for review on the phone. */
sealed interface DesktopAttachmentPreview {
    data class Image(val preview: ApprovalPreview) : DesktopAttachmentPreview
    data class Text(val text: String, val truncated: Boolean) : DesktopAttachmentPreview
}

class PreparedAction internal constructor(
    val method: String,
    val params: JsonObject,
    val commandId: String,
    val challengeId: String,
    val signature: Signature,
    val requiresUserAuthentication: Boolean,
    internal val transcript: ByteArray,
    internal val command: PendingCommand,
)
/**
 * A desktop search. [ids] lists every match in the desktop's order when it can say (search.ids);
 * otherwise [nextOffset] pages through the matches. Nothing is left out silently: [total] counts them.
 */
data class SessionSearch(val query: String, val total: Int, val ids: List<String> = emptyList(), val nextOffset: Int? = null, val truncated: Boolean = false) {
    fun remaining(loaded: Set<String>): Int = if (ids.isNotEmpty()) ids.count { it !in loaded } else if (nextOffset != null) (total - nextOffset).coerceAtLeast(0) else 0
}
/** A read's result arrived after the desktop, the connection or the transcript it was asked for changed. */
class StaleResultException : IllegalStateException("This changed on the desktop while it was loading, so it was not shown. Try again.")
/**
 * The state a read was asked in. Its result is published only while all of it still holds: the same
 * paired desktop, the same connection (a scope change, revocation or replacement ends that) and the
 * same transcript epoch (memory erasure changes it). A late result can then never restore erased
 * text or a conversation a newer snapshot removed.
 */
internal data class ReadFence(val desktopId: String?, val connection: Long, val cacheEpoch: String?) {
    fun holds(state: MobileState, connectionNow: Long, epoch: Boolean = true) =
        connection != HeldUpserts.NONE && connection == connectionNow && desktopId == state.desktop?.desktopId && (!epoch || cacheEpoch == state.cacheEpoch)
}
class CommandPendingException(val commandId: String) : IllegalStateException("The desktop hasn't confirmed this yet. Cere will check command ${commandId.take(8)} again after reconnecting.")
data class ApprovalPreview(val bytes: ByteArray, val mime: String, val imageDigest: String)
/** Ends reconnection. [repair] is true when only a new or replacement pairing can fix it. */
private class TerminalProtocolException(message: String, val repair: Boolean = false) : IllegalStateException(message)
/** A desktop refusal: [message] is written for people, [code] is for program checks. */
class RemoteRequestException(val code: String, message: String) : IllegalStateException(message)
/** The desktop did not answer before the request deadline. This is a failure, not a cancellation. */
class RequestTimeoutException : IllegalStateException("The desktop did not answer in time. Check the connection and try again.")

/** A desktop event the phone can turn into an alert. */
@Serializable
data class DesktopNotice(
    val kind: String,
    val sessionId: String? = null,
    val title: String? = null,
    val projectId: String? = null,
    val timerId: String? = null,
    val label: String? = null,
)

class CereRepository(context: Context) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val store = SecureStore(app)
    private val pairing = PairingManager(app)
    private val pendingResponses = ConcurrentHashMap<String, CompletableDeferred<WireResponse>>()
    private val uploadProgress = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()
    private val binaryReads = ConcurrentHashMap<String, CompletableDeferred<Pair<Long, ByteArray>>>()
    private val stateMutex = Mutex(); private val syncMutex = Mutex(); private val restoreMutex = Mutex()
    private val draftMutexes = ConcurrentHashMap<String, Mutex>()
    private val approvalRetirements = ApprovalRetirements()
    private val snapshotRequests = Channel<Unit>(Channel.CONFLATED)
    // Inbound frames are bounded: replies and acknowledgements reach their waiters on the socket's
    // reader thread, message updates are coalesced per connection (HeldUpserts) and the few ordered
    // control frames (challenge, welcome, revocation) wait in a small queue.
    private class Inbound(val generation: Long, val socket: WebSocket, val frame: Frame)
    private val control = Channel<Inbound>(CONTROL_CAPACITY)
    private val upserts = HeldUpserts()
    private val upsertSignal = Channel<Unit>(Channel.CONFLATED)
    /** Increases with every socket; the current socket's value, or NONE while disconnected. */
    private var connections = 0L
    @Volatile private var socketGeneration = HeldUpserts.NONE
    private val _state = MutableStateFlow(MobileState()); val state: StateFlow<MobileState> = _state.asStateFlow()
    private val _questionDrafts = MutableStateFlow<Map<String, Map<String, List<String>>>>(emptyMap())
    val questionDrafts: StateFlow<Map<String, Map<String, List<String>>>> = _questionDrafts.asStateFlow()
    private val questionDraftIdentities = ConcurrentHashMap<String, ApprovalIdentity>()
    private val _approvalMutations = MutableStateFlow<Set<String>>(emptySet())
    val approvalMutations: StateFlow<Set<String>> = _approvalMutations.asStateFlow()
    private val approvalMutationIdentities = ConcurrentHashMap<String, ApprovalIdentity>()
    // W10: captures this phone started, as the desktop last reported them (captures.* results and capture.updated events).
    private val _captures = MutableStateFlow<Map<String, JsonObject>>(emptyMap())
    val captures: StateFlow<Map<String, JsonObject>> = _captures.asStateFlow()
    private val _notices = MutableSharedFlow<DesktopNotice>(extraBufferCapacity = 32)
    /** Completion, failure, stop and timer notices for alerts. */
    val notices: SharedFlow<DesktopNotice> = _notices.asSharedFlow()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var connecting = false
    private var welcome: Welcome? = null; private var activeHello: Hello? = null
    private var reconnectJob: Job? = null; private var refreshJob: Job? = null; private var backgroundJob: Job? = null
    private var endpointIndex = 0; private var backoffAttempt = 0; private var terminalBlocked = false
    private var unreachableSince: Long? = null
    @Volatile private var serverOffset = 0L
    private val authRejections = AuthRejections()
    // shouldMonitor: the background service keeps the connection. visible: the app is on screen.
    @Volatile private var shouldMonitor = false; @Volatile private var visible = false; private var lastVerified: Long? = null
    @Volatile private var pairingTransition = false
    // Treat startup as restore-blocked until the credential-encrypted cache has
    // been read. This prevents service/UI callbacks from persisting the default
    // unpaired state over an existing pairing while restore is still in flight.
    @Volatile private var restoreBlocked = true; @Volatile private var cacheDirty = false
    private val flushLock = Any(); private var flushJob: Job? = null
    @Volatile private var ackedCursor: String? = null
    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { scope.launch {
            if (restoreBlocked) { if (restore() && keepConnected()) connect() } else if (cacheDirty) flushNow()
        } }
    }

    init {
        val unlockFilter = IntentFilter().apply { addAction(Intent.ACTION_USER_UNLOCKED); addAction(Intent.ACTION_USER_PRESENT) }
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(unlockReceiver, unlockFilter, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") app.registerReceiver(unlockReceiver, unlockFilter)
        scope.launch { if (restore() && keepConnected() && _state.value.stagedPairing == null) connect(); for (item in control) {
            if (socket !== item.socket || socketGeneration != item.generation) continue
            try { handle(item.socket, item.frame) }
            catch (error: Throwable) {
                if (error is CancellationException) currentCoroutineContext().ensureActive()
                fail(item.socket, error.message ?: "Protocol error", error is TerminalProtocolException, repair = (error as? TerminalProtocolException)?.repair == true)
            }
        } }
        scope.launch { for (ignored in upsertSignal) {
            val batch = upserts.drain() ?: continue
            if (batch.generation != socketGeneration) continue
            try { applyUpserts(batch) }
            catch (cancelled: CancellationException) { currentCoroutineContext().ensureActive() }
            catch (error: Exception) { Log.w(TAG, "Message updates could not be applied", error); snapshotRequests.trySend(Unit) }
        } }
        scope.launch { for (ignored in snapshotRequests) {
            try { reconcile(); reconcilePendingCommands() }
            catch (cancelled: CancellationException) {
                // Only the repository's own cancellation ends this loop; one slow or
                // cancelled request must never stop later reconciliation.
                currentCoroutineContext().ensureActive()
                Log.w(TAG, "Snapshot refresh was cancelled", cancelled)
            }
            catch (error: Exception) {
                Log.w(TAG, "Snapshot refresh failed", error)
                if (_state.value.connection is ConnectionState.Online) updateState { it.copy(lastError = error.message ?: "Could not refresh desktop state") }
            }
        } }
    }

    fun pairingManager() = pairing
    fun replacementBlocker(): String? = ReplacementPolicy.blocker(_state.value)
    suspend fun dismissError() { updateState { it.copy(lastError = null) } }

    // Start on the caller in edit order, then finish encrypted persistence in the
    // repository's lifetime even if the user immediately leaves the chat screen.
    fun editDraft(sessionId: String, text: String) {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try { saveLocalDraft(sessionId, text) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { updateState { it.copy(lastError = error.message) } }
        }
    }
    /** Seal the response and new aliases before showing them. The old pairing remains committed. */
    suspend fun stagePairing(completed: CompletedPairing) {
        pairingTransition = true
        try {
            stateMutex.withLock {
                val current = _state.value
                require(current.stagedPairing == null || current.stagedPairing == completed) { "Another pairing response is already awaiting confirmation" }
                validateReplacement(completed, current.desktop)
                ReplacementPolicy.blocker(current)?.let(::error)
                val staged = current.copy(
                    stagedPairing = completed,
                    connection = current.desktop?.let { ConnectionState.Offline("Replacement response awaiting desktop confirmation", lastVerified, OfflineKind.PairingChange) }
                        ?: ConnectionState.Unpaired,
                    monitoring = false,
                    lastError = null,
                )
                store.write(cached(staged, lastVerified))
                _state.value = staged
                cacheDirty = false
            }
        } catch (error: Throwable) {
            pairingTransition = _state.value.stagedPairing != null
            throw error
        }
        disconnectForPairingTransition()
    }

    suspend fun completePairing(completed: CompletedPairing) {
        val replacing = stateMutex.withLock {
            val current = _state.value
            require(current.stagedPairing == completed) { "Pairing response was not durably staged" }
            validateReplacement(completed, current.desktop)
            ReplacementPolicy.blocker(current)?.let(::error)
            val previousDesktop = current.desktop
            val next = if (previousDesktop == null) MobileState(
                restoreReady = true,
                desktop = completed.desktop,
                connection = ConnectionState.Offline("Ready to connect", null, OfflineKind.NotConnected),
            ) else current.copy(
                desktop = completed.desktop,
                stagedPairing = null,
                connection = ConnectionState.Offline("Pairing updated; ready to connect", lastVerified, OfflineKind.NotConnected),
                cursor = null,
                approvals = emptyList(),
                monitoring = false,
                lastError = null,
            )
            store.write(cached(next, lastVerified))
            _state.value = next
            cacheDirty = false
            previousDesktop
        }
        pairingTransition = false
        synchronized(this) { terminalBlocked = false; authRejections.reset(); backoffAttempt = 0; unreachableSince = null }
        if (replacing != null) {
            approvalRetirements.clear(); questionDraftIdentities.clear(); approvalMutationIdentities.clear()
            _questionDrafts.value = emptyMap(); _approvalMutations.value = emptySet()
        }
        if (replacing != null) runCatching { pairing.delete(replacing) }
    }

    suspend fun cancelStagedPairing() {
        val staged = stateMutex.withLock {
            val current = _state.value
            val pending = current.stagedPairing ?: return@withLock null
            val next = if (current.desktop == null) MobileState(restoreReady = true)
            else current.copy(
                stagedPairing = null,
                connection = ConnectionState.Offline("Replacement cancelled", lastVerified, OfflineKind.NotConnected),
                monitoring = false,
                lastError = null,
            )
            store.write(cached(next, lastVerified))
            _state.value = next
            cacheDirty = false
            pending
        } ?: return
        pairingTransition = false
        runCatching { pairing.delete(staged.desktop) }
    }

    private fun validateReplacement(completed: CompletedPairing, replacing: PairedDesktop?) {
        if (replacing == null) require(completed.replacesDeviceId == null) { "A replacement response requires its existing phone pairing" }
        else {
            require(completed.desktop.desktopId == replacing.desktopId) { "A paired phone can only replace its current desktop connection" }
            require(completed.replacesDeviceId == replacing.deviceId) { "Replacement response does not identify this paired phone" }
        }
    }

    @Synchronized private fun disconnectForPairingTransition() {
        val currentSocket = socket; socket = null; welcome = null; activeHello = null; endConnection()
        refreshJob?.cancel(); refreshJob = null; reconnectJob?.cancel(); reconnectJob = null
        failWaiters("Pairing confirmation in progress")
        currentSocket?.close(1000, "Pairing confirmation in progress")
    }

    private fun keepConnected() = shouldMonitor || visible
    /** True while the app is on screen with this conversation open; its notices need no alert. */
    fun isShowing(sessionId: String?): Boolean = visible && sessionId != null && _state.value.selectedSessionId == sessionId

    @Synchronized fun startMonitoring() {
        shouldMonitor = true; terminalBlocked = false; authRejections.reset(); backgroundJob?.cancel(); backgroundJob = null
        if (restoreBlocked) scope.launch { stateMutex.withLock { _state.value = _state.value.copy(monitoring = true) } } else scope.launch { updateState { it.copy(monitoring = true) } }
        if (socket == null && !connecting && !restoreBlocked) connect()
    }
    /** Opening the app reconnects a restored pairing even when background monitoring is off. */
    @Synchronized fun connectWhileOpen() {
        visible = true; backgroundJob?.cancel(); backgroundJob = null
        if (restoreBlocked || _state.value.desktop == null || _state.value.stagedPairing != null || socket != null || connecting || terminalBlocked) return
        reconnectJob?.cancel(); reconnectJob = null; connect()
    }
    /**
     * Called as the app's screens start and stop. Without background monitoring the
     * connection ends a short while after the app leaves the screen, so opening the
     * photo picker or camera does not drop it.
     */
    @Synchronized fun setVisible(isVisible: Boolean) {
        if (isVisible) { connectWhileOpen(); return }
        visible = false
        scope.launch { flushNow() }
        if (shouldMonitor) return
        backgroundJob?.cancel()
        backgroundJob = scope.launch {
            delay(BACKGROUND_GRACE_MS)
            synchronized(this@CereRepository) { if (!visible && !shouldMonitor) disconnect("Background monitoring is off", OfflineKind.MonitoringOff) }
        }
    }
    @Synchronized fun networkAvailable() {
        if (!keepConnected() || restoreBlocked || socket != null || connecting || terminalBlocked) return
        reconnectJob?.cancel(); reconnectJob = null; backoffAttempt = 0; connect()
    }
    /** The network that was active when the socket connected; null when none was. */
    @Volatile private var socketNetwork: android.net.Network? = null
    /**
     * A network went away. Only losing the one carrying the socket ends it; losing another (cellular
     * while on Wi-Fi, a VPN's underlying network the socket does not use) leaves the connection alone.
     */
    @Synchronized fun networkLost(network: android.net.Network? = null) {
        val current = socket ?: return
        if (ConnectionPolicy.dropsConnection(network, socketNetwork)) fail(current, "The network changed", false)
    }
    /** Stops monitoring and disconnects now. */
    @Synchronized fun stopMonitoring(reason: String = "Monitoring off") {
        shouldMonitor = false; backgroundJob?.cancel(); backgroundJob = null
        disconnect(reason, OfflineKind.MonitoringOff) { it.copy(monitoring = false) }
    }
    /** The background service stopped. Keep the connection while the app is on screen. */
    @Synchronized fun backgroundMonitoringStopped() {
        shouldMonitor = false
        if (visible) scope.launch { updateState { it.copy(monitoring = false) } }
        else disconnect("Background monitoring is off", OfflineKind.MonitoringOff) { it.copy(monitoring = false) }
    }
    @Synchronized fun retry() {
        terminalBlocked = false; backoffAttempt = 0; unreachableSince = null; authRejections.reset(); visible = true
        if (restoreBlocked) { scope.launch { if (restore()) connect() }; return }
        val old = socket; socket = null; endConnection(); old?.cancel(); reconnectJob?.cancel(); reconnectJob = null; connect()
    }
    @Synchronized private fun disconnect(reason: String, kind: OfflineKind, extra: (MobileState) -> MobileState = { it }) {
        reconnectJob?.cancel(); reconnectJob = null; refreshJob?.cancel(); refreshJob = null
        val currentSocket = socket; socket = null; welcome = null; endConnection(); currentSocket?.close(1000, reason)
        failWaiters(reason)
        scope.launch { updateState { current -> extra(current.copy(connection = current.desktop?.let { ConnectionState.Offline(reason, lastVerified, kind) } ?: ConnectionState.Unpaired)) } }
    }

    fun setQuestionAnswer(approvalId: String, questionId: String, answers: List<String>) {
        val identity = _state.value.approvals.firstOrNull { it.id == approvalId }?.identity() ?: return
        val previousIdentity = questionDraftIdentities.put(approvalId, identity)
        _questionDrafts.update { drafts ->
            val approval = if (previousIdentity == null || previousIdentity == identity) drafts[approvalId].orEmpty().toMutableMap() else mutableMapOf()
            if (answers.any(String::isNotBlank)) approval[questionId] = answers else approval.remove(questionId)
            if (approval.isEmpty()) {
                questionDraftIdentities.remove(approvalId, identity)
                drafts - approvalId
            } else drafts + (approvalId to approval.toMap())
        }
    }

    @Synchronized fun beginApprovalMutation(approval: Approval): Boolean {
        if (approval.id in _approvalMutations.value) return false
        approvalMutationIdentities[approval.id] = approval.identity()
        _approvalMutations.value = _approvalMutations.value + approval.id
        return true
    }

    @Synchronized fun endApprovalMutation(approval: Approval) {
        if (!approvalMutationIdentities.remove(approval.id, approval.identity())) return
        _approvalMutations.value = _approvalMutations.value - approval.id
    }

    private fun retainApprovalInteractionState(approvals: List<Approval>) {
        val identities = approvals.associate { it.id to it.identity() }
        _questionDrafts.update { drafts -> drafts.filterKeys { id -> questionDraftIdentities[id] == identities[id] } }
        questionDraftIdentities.forEach { (id, identity) -> if (identities[id] != identity) questionDraftIdentities.remove(id, identity) }
        _approvalMutations.update { mutations -> mutations.filterTo(mutableSetOf()) { id -> approvalMutationIdentities[id] == identities[id] } }
        approvalMutationIdentities.forEach { (id, identity) -> if (identities[id] != identity) approvalMutationIdentities.remove(id, identity) }
    }

    private fun clearApprovalInteractionState(identity: ApprovalIdentity) {
        if (questionDraftIdentities.remove(identity.id, identity)) _questionDrafts.update { it - identity.id }
        if (approvalMutationIdentities.remove(identity.id, identity)) _approvalMutations.update { it - identity.id }
    }

    /**
     * After a damaged cache or a key Android removed: deletes the unreadable private data so this phone
     * can pair again. Nothing in it could be read, so nothing readable is lost.
     */
    suspend fun discardUnreadableCache() {
        check(restoreFailure?.repair == true) { "Only private data that cannot be read is discarded here." }
        store.clear()
        restoreMutex.withLock { stateMutex.withLock { _state.value = MobileState(restoreReady = true); cacheDirty = false; restoreBlocked = false; restoreFailure = null } }
        synchronized(this) { terminalBlocked = false; authRejections.reset() }
    }
    suspend fun forget() {
        val desktop = _state.value.desktop
        if (desktop != null && _state.value.supports("devices.selfRevoke")) runCatching { mutate("devices.selfRevoke", buildJsonObject {}) }
        val staged = _state.value.stagedPairing?.desktop
        if (desktop == null && staged == null) return
        stopMonitoring("Forgotten"); synchronized(flushLock) { flushJob?.cancel(); flushJob = null }
        desktop?.let { runCatching { pairing.delete(it) } }; staged?.let { runCatching { pairing.delete(it) } }; store.clear(); stateMutex.withLock { _state.value = MobileState(restoreReady = true); cacheDirty = false }
        pairingTransition = false; approvalRetirements.clear(); questionDraftIdentities.clear(); approvalMutationIdentities.clear()
        _questionDrafts.value = emptyMap(); _approvalMutations.value = emptySet()
        synchronized(this) { terminalBlocked = false; authRejections.reset() }
    }

    suspend fun selectSession(sessionId: String?) {
        updateState { it.copy(selectedSessionId = sessionId) }
        if (sessionId != null && _state.value.supports("sessions.get")) runCatching {
            val fence = fence()
            val full = WireCodec.json.decodeFromJsonElement(Session.serializer(), request("sessions.get", buildJsonObject { put("sessionId", sessionId) }))
            updateState { current ->
                if (!fence.holds(current, socketGeneration) || current.sessions.none { it.id == sessionId }) return@updateState current
                val merged = CacheReconciler.mergeSession(current.sessions.firstOrNull { it.id == sessionId }, full)
                val draft = CacheReconciler.mergeDraft(current.drafts[sessionId], merged)
                current.copy(sessions = current.sessions.map { if (it.id == sessionId) merged else it }, drafts = current.drafts + (sessionId to draft))
            }
        }
        if (sessionId != null) markRead(sessionId)
        if (_state.value.supports("sync.open")) snapshotRequests.trySend(Unit)
    }

    /** Opening a conversation clears Unread on every client, as opening it on the desktop does. */
    suspend fun markRead(sessionId: String) {
        val session = _state.value.sessions.firstOrNull { it.id == sessionId } ?: return
        if (!session.unread || !_state.value.supports("sessions.read")) return
        updateState { current -> current.copy(sessions = current.sessions.map { if (it.id == sessionId) it.copy(unread = false) else it }) }
        runCatching { mutate("sessions.read", buildJsonObject { put("sessionId", sessionId) }) }
    }

    suspend fun openCreatedSession(result: JsonElement): String {
        val session = WireCodec.json.decodeFromJsonElement(Session.serializer(), result)
        updateState { current -> current.copy(selectedSessionId = session.id,
            sessions = current.sessions.filterNot { it.id == session.id } + session) }
        selectSession(session.id)
        return session.id
    }

    /**
     * Searches every in-scope conversation on the desktop, including ones this phone has not cached.
     * The first matches load at once; [loadMoreSearchResults] continues, so no match is hidden.
     */
    suspend fun searchSessions(query: String): List<Session> {
        if (query.isBlank() || !_state.value.supports("sessions.list")) return emptyList()
        val text = query.trim().take(200)
        val withIds = _state.value.has("search.ids")
        val fence = fence()
        val result = request("sessions.list", buildJsonObject { put("filter", text); put("offset", 0); if (withIds) put("withIds", true) }).jsonObject
        val items = result["items"]?.jsonArray.orEmpty().map { WireCodec.json.decodeFromJsonElement(Session.serializer(), it) }
        val ids = result["ids"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty()
        val search = SessionSearch(text, result["total"]?.jsonPrimitive?.intOrNull ?: (ids.size.takeIf { withIds } ?: items.size),
            ids, if (withIds) null else result["nextOffset"]?.jsonPrimitive?.intOrNull, result["idsTruncated"]?.jsonPrimitive?.booleanOrNull == true)
        mergeSummaries(items, fence) { it.copy(search = search) }
        return items
    }
    /** The next matches of the current search: by ID when the desktop listed them, else by offset. */
    suspend fun loadMoreSearchResults() {
        val search = _state.value.search ?: return
        if (search.ids.isNotEmpty() && _state.value.supports("sessions.batch")) {
            val loaded = _state.value.sessions.mapTo(HashSet(), Session::id)
            val next = search.ids.filter { it !in loaded }.take(50).ifEmpty { return }
            val fence = fence()
            val result = request("sessions.batch", buildJsonObject { put("sessionIds", JsonArray(next.map(::JsonPrimitive))) }).jsonObject
            val items = result["items"]?.jsonArray.orEmpty().map { WireCodec.json.decodeFromJsonElement(Session.serializer(), it) }
            val gone = result["missing"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty().toSet()
            mergeSummaries(items, fence) { current -> current.copy(search = current.search?.takeIf { it.query == search.query }?.let { it.copy(ids = it.ids - gone, total = it.total - gone.size) }) }
            return
        }
        val offset = search.nextOffset ?: return
        val fence = fence()
        val result = request("sessions.list", buildJsonObject { put("filter", search.query); put("offset", offset) }).jsonObject
        val items = result["items"]?.jsonArray.orEmpty().map { WireCodec.json.decodeFromJsonElement(Session.serializer(), it) }
        mergeSummaries(items, fence) { current -> current.copy(search = current.search?.takeIf { it.query == search.query }?.copy(nextOffset = result["nextOffset"]?.jsonPrimitive?.intOrNull)) }
    }
    private suspend fun mergeSummaries(items: List<Session>, fence: ReadFence? = null, extra: (MobileState) -> MobileState = { it }) = updateState { current ->
        // A summary from an older connection or pairing could restore a conversation that left scope.
        if (fence != null && !fence.holds(current, socketGeneration, epoch = false)) return@updateState current
        val existing = current.sessions.associateBy(Session::id)
        val incoming = items.map { CacheReconciler.mergeSession(existing[it.id], it) }.associateBy(Session::id)
        extra(current.copy(sessions = current.sessions.filterNot { it.id in incoming } + incoming.values))
    }

    private fun fence() = ReadFence(_state.value.desktop?.desktopId, socketGeneration, _state.value.cacheEpoch)
    /** [request] for a result shown on a screen: refused with [StaleResultException] when its fence no longer holds. */
    suspend fun read(method: String, params: JsonObject): JsonElement {
        val fence = fence(); val result = request(method, params)
        if (!fence.holds(_state.value, socketGeneration)) throw StaleResultException()
        return result
    }
    suspend fun request(method: String, params: JsonObject): JsonElement {
        check(!pairingTransition && _state.value.stagedPairing == null) { "Finish or cancel pairing confirmation first" }
        require(_state.value.supports(method)) { "The desktop isn't connected or doesn't offer this right now." }
        val id = UUID.randomUUID().toString(); val deferred = CompletableDeferred<WireResponse>(); pendingResponses[id] = deferred
        if (socket?.send(WireCodec.encode(WireRequest(id = id, method = method, params = params))) != true) { pendingResponses.remove(id); error("The desktop is unreachable") }
        // withTimeoutOrNull: a deadline is reported as a failure, never as a cancellation of the caller.
        val response = try { withTimeoutOrNull(REQUEST_TIMEOUT_MS) { deferred.await() } } finally { pendingResponses.remove(id) } ?: throw RequestTimeoutException()
        response.error?.let { throw RemoteRequestException(it.code, it.message) }; return response.result ?: JsonNull
    }

    suspend fun mutate(method: String, params: JsonObject, label: String? = null): JsonElement {
        val digest = CanonicalJson.sha256(params)
        val existing = _state.value.pendingCommands.firstOrNull { it.method == method && it.paramsDigest == digest }
        return requestWithCommand(existing?.copy(params = params) ?: pendingCommand(UUID.randomUUID().toString(), method, params, null, label), null)
    }

    suspend fun prepareAction(method: String, params: JsonObject, boundProjectId: String? = null, label: String? = null): PreparedAction {
        require(_state.value.supports(method)) { "The desktop isn't connected or doesn't offer this right now." }
        val desktop = _state.value.desktop ?: error("Not paired"); val session = welcome ?: error("Not signed in to the desktop yet. Wait for Online and try again.")
        val connectionSigned = method == "sessions.send"
        check(!connectionSigned || session.sendAuthentication == "connection-key") {
            "Restart the updated Cere broker on your PC to send without a password or fingerprint. Your draft is saved."
        }
        val digest = CanonicalJson.sha256(params); val existing = _state.value.pendingCommands.firstOrNull { it.method == method && it.paramsDigest == digest }
        val commandId = existing?.commandId ?: UUID.randomUUID().toString()
        // Opening the key first reports a key reset before the desktop issues a challenge. Keystore reads stay off the main thread.
        val signature = withContext(Dispatchers.IO) { if (connectionSigned) pairing.connectionSignature(desktop.connectionAlias) else pairing.actionSignature(desktop.actionAlias) }
        val challenge = request("commands.challenge", buildJsonObject { put("method", method); put("paramsDigest", digest); put("commandId", commandId) }).jsonObject
        val challengeId = challenge.getValue("challengeId").jsonPrimitive.content; val nonce = challenge.getValue("nonce").jsonPrimitive.content
        val transcript = CanonicalJson.encode(SigningTranscripts.action(desktop.desktopId, desktop.deviceId, 1, session.scopeVersion, session.epoch,
            session.authSessionId, challengeId, nonce, method, digest, commandId)).toByteArray()
        val requiresUserAuthentication = ActionAuthenticationPolicy.actionRequiresPrompt(desktop, session, connectionSigned)
        return PreparedAction(method, params, commandId, challengeId, signature, requiresUserAuthentication, transcript,
            pendingCommand(commandId, method, params, boundProjectId, label))
    }
    suspend fun completeAction(action: PreparedAction, signature: ByteArray): JsonElement = requestWithCommand(action.command, Proof(action.challengeId, CanonicalJson.base64Url(signature)))
    fun signAuthenticated(action: PreparedAction): ByteArray {
        require(action.requiresUserAuthentication) { "This action does not use phone authentication" }
        return action.signature.run { update(action.transcript); sign() }
    }
    fun signWithoutAuthentication(action: PreparedAction): ByteArray {
        require(!action.requiresUserAuthentication) { "Phone authentication is required for this action" }
        return action.signature.run { update(action.transcript); sign() }
    }
    /**
     * Sends a prepared message in the repository's lifetime. Leaving the chat cannot cancel
     * the send or the cleanup of its accepted draft and images.
     */
    fun launchSend(action: PreparedAction, sessionId: String, sentText: String, attachmentIds: Set<String>, done: (Result<Unit>) -> Unit) {
        scope.launch {
            val result = try {
                completeAction(action, signWithoutAuthentication(action)); clearAcceptedDraft(sessionId, sentText, attachmentIds); Result.success(Unit)
            } catch (cancelled: CancellationException) { throw cancelled } catch (error: Throwable) { Result.failure(error) }
            withContext(Dispatchers.Main) { done(result) }
        }
    }
    /** The desktop's current time as this phone estimates it from the last sign-in. */
    fun desktopTime(): Long = System.currentTimeMillis() + serverOffset
    /** Records a committed upload in the repository's lifetime. */
    fun attachmentCommitted(localId: String, result: JsonObject) { scope.launch { runCatching { markAttachmentReady(localId, result) }.onFailure { failure -> updateState { it.copy(lastError = failure.message) } } } }
    /** Completes a prepared action in the repository's lifetime, so leaving the screen cannot cancel it midway. */
    fun launchAction(action: PreparedAction, signature: () -> ByteArray, done: (Result<JsonElement>) -> Unit) {
        scope.launch {
            val result = try { Result.success(completeAction(action, signature())) } catch (cancelled: CancellationException) { throw cancelled } catch (error: Throwable) { Result.failure(error) }
            withContext(Dispatchers.Main) { done(result) }
        }
    }

    suspend fun saveLocalDraft(sessionId: String, text: String, immediate: Boolean = false) = updateState(immediate = immediate) { current ->
        val session = current.sessions.firstOrNull { it.id == sessionId } ?: return@updateState current; val old = current.drafts[sessionId] ?: current.draft(session)
        val otherDraftBytes = current.drafts.filterKeys { it != sessionId }.values.sumOf { it.text.toByteArray().size }
        require(otherDraftBytes + text.toByteArray().size + current.attachments.sumOf { it.size } <= 19 * 1024 * 1024) { "Private offline drafts have reached the 20 MiB device limit" }
        current.copy(drafts = current.drafts + (sessionId to old.copy(text = text, dirty = text != session.draft)))
    }
    suspend fun syncDraft(sessionId: String) = draftMutexes.getOrPut(sessionId) { Mutex() }.withLock { syncDraftLocked(sessionId) }
    private suspend fun syncDraftLocked(sessionId: String) {
        if (!_state.value.supports("drafts.put")) return; val draft = _state.value.drafts[sessionId] ?: return
        val session = _state.value.sessions.firstOrNull { it.id == sessionId } ?: return
        if (!_state.value.draftEditable(session)) return
        if (!draft.dirty || draft.conflict) return
        putDraft(sessionId, draft.text, draft.remoteRevision, session.draftAttachments.map(DraftAttachment::id))
    }
    /** Saves [text] as the desktop draft; [desktopAttachmentIds] are the shown desktop attachments it keeps. */
    private suspend fun putDraft(sessionId: String, text: String, expectedRevision: String, desktopAttachmentIds: List<String>) {
        val result = mutate("drafts.put", buildJsonObject { put("sessionId", sessionId); put("text", text); put("expectedRevision", expectedRevision)
            if (_state.value.sessions.firstOrNull { it.id == sessionId }?.draftAttachmentCount != 0) put("desktopAttachmentIds", JsonArray(desktopAttachmentIds.map(::JsonPrimitive))) }).jsonObject
        val revision = result.getValue("revision").jsonPrimitive.content
        val attachments = result["draftAttachments"]?.let { WireCodec.json.decodeFromJsonElement(ListSerializer(DraftAttachment.serializer()), it) }
        updateState { current ->
            val latest = current.drafts[sessionId] ?: return@updateState current
            current.copy(drafts = current.drafts + (sessionId to CacheReconciler.acknowledgeDraft(latest, text, revision)),
                sessions = current.sessions.map { session -> if (session.id == sessionId &&
                    (session.draftRevision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) <= revision.toBigInteger())
                    session.copy(draft = text, draftRevision = revision, draftAttachments = attachments ?: session.draftAttachments,
                        draftAttachmentCount = attachments?.size ?: session.draftAttachmentCount) else session })
        }
    }
    /** W10: takes one desktop attachment out of [sessionId]'s draft, at the user's explicit request; the text stays. */
    suspend fun removeDesktopAttachment(sessionId: String, attachmentId: String) = draftMutexes.getOrPut(sessionId) { Mutex() }.withLock {
        val current = _state.value; val session = current.sessions.first { it.id == sessionId }
        require(current.showsDesktopAttachments(session)) { "Reopen this conversation to review its desktop attachments" }
        val draft = current.draft(session)
        require(!draft.conflict) { "Resolve the draft conflict first" }
        putDraft(sessionId, draft.text, draft.remoteRevision, session.draftAttachments.map(DraftAttachment::id).filter { it != attachmentId })
    }
    /** W11 (F93): the desktop's portrait sheet for the static status avatar, checked against its digest. */
    suspend fun portrait(): PortraitSheet {
        val held = portraitSheet
        val result = read("desktop.portrait", buildJsonObject { held?.let { put("known", it.sha256) } }).jsonObject
        val sha256 = result.getValue("sha256").jsonPrimitive.content
        held?.takeIf { it.sha256 == sha256 }?.let { return it }
        val bytes = android.util.Base64.decode(result.getValue("data").jsonPrimitive.content, android.util.Base64.DEFAULT)
        require(bytes.size in 1..512 * 1024) { "The desktop portrait is too large" }
        val hash = android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        require(hash == sha256) { "Portrait integrity check failed" }
        return PortraitSheet(result.getValue("avatarId").jsonPrimitive.content, result["label"]?.jsonPrimitive?.contentOrNull.orEmpty(), bytes,
            result["columns"]?.jsonPrimitive?.intOrNull ?: 4, result["cell"]?.jsonPrimitive?.intOrNull ?: 96,
            result["frames"]?.jsonObject.orEmpty().mapValues { it.value.jsonPrimitive.int },
            result["palette"]?.jsonObject.orEmpty().mapValues { it.value.jsonPrimitive.content }, sha256).also { portraitSheet = it }
    }
    @Volatile private var portraitSheet: PortraitSheet? = null
    /** W11: pins or unpins a reply; the desktop shows it as a bookmark. */
    suspend fun setBookmark(message: Message, bookmarked: Boolean) {
        val fence = fence()
        val result = mutate("messages.bookmark", buildJsonObject { put("sessionId", message.sessionId); put("messageId", message.id); put("bookmarked", bookmarked) })
        val updated = WireCodec.json.decodeFromJsonElement(Message.serializer(), result)
        updateState { current -> if (!fence.holds(current, socketGeneration)) current else current.copy(messages = mergeMessages(current.messages, listOf(updated))) }
    }
    /** The pinned replies of [sessionId], newest pin first. */
    suspend fun pinnedReplies(sessionId: String): List<Message> =
        read("messages.bookmarks", buildJsonObject { put("sessionId", sessionId) }).jsonObject["items"]?.jsonArray.orEmpty()
            .map { WireCodec.json.decodeFromJsonElement(Message.serializer(), it) }
    /** What a desktop draft attachment contains: an image's reduced copy bound to the original's digest, or a text file's opening. */
    suspend fun desktopAttachmentPreview(sessionId: String, attachmentId: String): DesktopAttachmentPreview {
        val fence = fence()
        val metadata = request("drafts.attachmentPreview", buildJsonObject { put("sessionId", sessionId); put("attachmentId", attachmentId) }).jsonObject
        val preview = if (metadata["kind"]?.jsonPrimitive?.contentOrNull == "text")
            DesktopAttachmentPreview.Text(metadata.getValue("text").jsonPrimitive.content, metadata["truncated"]?.jsonPrimitive?.booleanOrNull == true)
        else DesktopAttachmentPreview.Image(readPreview(metadata))
        if (!fence.holds(_state.value, socketGeneration)) throw StaleResultException()
        return preview
    }

    /** Serialize pending autosaves before binding the send signature to draft/config revisions. */
    suspend fun prepareSend(sessionId: String, text: String, webSearch: Boolean = false): PreparedAction = draftMutexes.getOrPut(sessionId) { Mutex() }.withLock {
        require(_state.value.pendingCommands.none { it.sessionId == sessionId && it.method == "sessions.send" }) { "Review the previous send outcome before sending another message" }
        val initial = _state.value.sessions.first { it.id == sessionId }
        require(initial.canSend && initial.draftIncluded) { "This session is not ready to send" }
        require(initial.draftAttachmentCount != null) { "Restart the updated Cere broker on your PC to synchronize desktop attachments before sending. Your draft is saved." }
        require(_state.value.draftEditable(initial)) { "This draft has desktop attachments. Update Cere on your PC to review them here, or send it from the PC." }
        require(initial.draftAttachments.isEmpty() || _state.value.supports("attachments.commit")) { "Sending this draft's desktop attachments needs the attachment permission. Remove them, or send from the PC." }
        require(!webSearch || _state.value.canSearchWeb(initial)) { "Web search is unavailable for this conversation" }
        require(!_state.value.draft(initial).conflict) { "Resolve the desktop draft conflict before sending" }
        check(saveLocalDraft(sessionId, text, immediate = true)) { PRIVATE_CACHE_ERROR }
        syncDraftLocked(sessionId)
        val current = _state.value
        val session = current.sessions.first { it.id == sessionId }
        val draft = current.draft(session)
        require(!draft.conflict && draft.text == text) { "Draft changed. Review the current text before sending" }
        val now = desktopTime()
        val attachments = current.attachments.filter { it.sessionId == sessionId }
        require(attachments.all { it.reviewedAt != null }) { "Review every image before sending" }
        val expired = attachments.filter { it.remoteStatus == "ready" && it.remoteAttachmentId != null && !it.readyAt(now) }
        if (expired.isNotEmpty()) { expireAttachments(expired.mapTo(HashSet(), LocalAttachment::id)); error("The desktop discarded an uploaded image after an hour. Upload it again before sending.") }
        require(attachments.all { it.readyAt(now) }) { "Finish uploading the images before sending" }
        // The desktop draft's attachments go as shown here, bound by their content digests.
        val desktop = session.draftAttachments
        require(current.draftEditable(session)) { "The desktop draft attachments changed. Review them again before sending" }
        require(desktop.count { it.kind == "image" } + attachments.size <= 4) { "Attach at most four images, counting the desktop draft's" }
        prepareAction("sessions.send", buildJsonObject {
            put("sessionId", sessionId); put("text", text)
            put("attachments", JsonArray(attachments.map { JsonPrimitive(it.remoteAttachmentId!!) }))
            if (desktop.isNotEmpty()) put("desktopAttachments", JsonArray(desktop.map { buildJsonObject { put("id", it.id); put("sha256", it.sha256) } }))
            put("webSearch", webSearch); put("expectedDraftRevision", draft.remoteRevision); put("expectedConfigRevision", session.configRevision)
        })
    }
    suspend fun keepLocalDraft(sessionId: String) { updateState { current -> current.drafts[sessionId]?.let { current.copy(drafts = current.drafts + (sessionId to it.copy(baseRevision = it.remoteRevision, conflict = false, remoteText = null, dirty = true))) } ?: current }; syncDraft(sessionId) }
    suspend fun reloadRemoteDraft(sessionId: String) = updateState { current -> current.drafts[sessionId]?.let { draft -> current.copy(drafts = current.drafts + (sessionId to draft.copy(text = draft.remoteText.orEmpty(), baseRevision = draft.remoteRevision, dirty = false, conflict = false, remoteText = null))) } ?: current }
    /**
     * After the desktop accepted a send: its text leaves the draft unless newer typing replaced it, and
     * its images leave the phone. Metadata is saved first and the image files go after, so a crash in
     * between leaves only files no draft refers to, which the next start removes.
     */
    suspend fun clearAcceptedDraft(sessionId: String, sentText: String, attachmentIds: Set<String>) {
        val saved = updateState(immediate = true) { current -> val session = current.sessions.firstOrNull { it.id == sessionId } ?: return@updateState current; val draft = current.drafts[sessionId] ?: current.draft(session)
            current.copy(drafts = if (draft.text == sentText) current.drafts + (sessionId to draft.copy(text = "", dirty = false, conflict = false, remoteText = null)) else current.drafts,
                attachments = current.attachments.filterNot { it.id in attachmentIds }) }
        if (saved) attachmentIds.forEach { store.deleteBlob(it) }
        snapshotRequests.trySend(Unit)
    }
    fun recordScrollPosition(position: SessionScrollPosition) {
        if (_state.value.scrollPositions[position.sessionId] == position) return
        scope.launch(start = CoroutineStart.UNDISPATCHED) { updateState { current ->
            if (current.sessions.none { it.id == position.sessionId }) current
            else current.copy(scrollPositions = current.scrollPositions + (position.sessionId to position))
        } }
    }

    suspend fun loadMessages(sessionId: String) {
        if (_state.value.selectedSessionId != sessionId) selectSession(sessionId); if (!_state.value.supports("sessions.messages")) return
        val fence = fence()
        val result = request("sessions.messages", buildJsonObject { put("sessionId", sessionId); put("limit", 100) }).jsonObject
        val incoming = result["items"]?.jsonArray?.map { WireCodec.json.decodeFromJsonElement(Message.serializer(), it) }.orEmpty()
        val before = result["before"]?.jsonPrimitive?.contentOrNull
        updateState(System.currentTimeMillis()) { current -> if (!fence.holds(current, socketGeneration) || current.sessions.none { it.id == sessionId }) current
            else current.copy(messages = mergeMessages(current.messages, incoming), messagesBefore = if (before == null) current.messagesBefore - sessionId else current.messagesBefore + (sessionId to before)) }
    }
    suspend fun loadOlderMessages(sessionId: String) {
        val before = _state.value.messagesBefore[sessionId] ?: return
        val fence = fence()
        val result = request("sessions.messages", buildJsonObject { put("sessionId", sessionId); put("before", before); put("limit", 100) }).jsonObject
        val incoming = result["items"]?.jsonArray?.map { WireCodec.json.decodeFromJsonElement(Message.serializer(), it) }.orEmpty(); val next = result["before"]?.jsonPrimitive?.contentOrNull
        updateState(System.currentTimeMillis()) { current -> if (!fence.holds(current, socketGeneration) || current.sessions.none { it.id == sessionId }) current
            else current.copy(messages = mergeMessages(current.messages, incoming), messagesBefore = if (next == null) current.messagesBefore - sessionId else current.messagesBefore + (sessionId to next)) }
    }
    /** The newest Activity page; [loadOlderActivity] continues past it when the desktop pages Activity. */
    suspend fun loadActivity(sessionId: String) {
        val fence = fence()
        if (!_state.value.supports("activity.page")) {
            val incoming = request("activity.list", buildJsonObject { put("sessionId", sessionId); put("limit", 100) }).jsonArray
                .map { WireCodec.json.decodeFromJsonElement(Message.serializer(), it) }
            updateState { current -> if (!fence.holds(current, socketGeneration)) current else current.copy(messages = mergeMessages(current.messages, incoming)) }
            return
        }
        val result = request("activity.page", buildJsonObject { put("sessionId", sessionId); put("limit", 100) }).jsonObject
        applyActivity(sessionId, result, fence)
    }
    suspend fun loadOlderActivity(sessionId: String) {
        val before = _state.value.activityBefore[sessionId] ?: return
        val fence = fence()
        val result = request("activity.page", buildJsonObject { put("sessionId", sessionId); put("before", before); put("limit", 100) }).jsonObject
        applyActivity(sessionId, result, fence)
    }
    private suspend fun applyActivity(sessionId: String, result: JsonObject, fence: ReadFence) {
        val incoming = result["items"]?.jsonArray.orEmpty().map { WireCodec.json.decodeFromJsonElement(Message.serializer(), it) }
        val before = result["before"]?.jsonPrimitive?.contentOrNull
        updateState { current -> if (!fence.holds(current, socketGeneration) || current.sessions.none { it.id == sessionId }) current else current.copy(messages = mergeMessages(current.messages, incoming),
            activityBefore = if (before == null) current.activityBefore - sessionId else current.activityBefore + (sessionId to before)) }
    }
    suspend fun models(provider: String, refresh: Boolean = false, sessionId: String? = null): List<ModelOption> {
        val cached = _state.value.providers[provider]?.jsonObject?.get("models")?.jsonArray.orEmpty().mapNotNull { runCatching { WireCodec.json.decodeFromJsonElement(ModelOption.serializer(), it) }.getOrNull() }
        if (!refresh && sessionId == null && cached.isNotEmpty()) return cached; if (!_state.value.supports("providers.models")) return emptyList()
        return read("providers.models", buildJsonObject { put("provider", provider); sessionId?.let { put("sessionId", it) } }).jsonArray.map { WireCodec.json.decodeFromJsonElement(ModelOption.serializer(), it) }
    }

    suspend fun importImage(sessionId: String, uri: android.net.Uri): LocalAttachment {
        val (attachment, bytes) = try { decodePrivateImage(app, sessionId, uri) } catch (denied: SecurityException) {
            throw IllegalStateException("Cere wasn't allowed to read this image. Share or pick it again from the app that has it.", denied)
        }
        require(_state.value.attachments.filter { it.sessionId == sessionId }.size < 4) { "A message can contain at most four images" }
        require(_state.value.attachments.sumOf { it.size } + _state.value.drafts.values.sumOf { it.text.toByteArray().size } + attachment.size <= 19 * 1024 * 1024) { "Private offline media has reached the 20 MiB device limit" }
        store.writeBlob(attachment.id, bytes)
        // Not imported until its record is saved; the image file goes with a failed save.
        if (!updateState(immediate = true, revertOnFailure = true) { it.copy(attachments = it.attachments + attachment) }) { runCatching { store.deleteBlob(attachment.id) }; error(PRIVATE_CACHE_ERROR) }
        return attachment
    }
    suspend fun attachmentPreview(localId: String): ByteArray {
        require(_state.value.attachments.any { it.id == localId }) { "Attachment is no longer available" }
        return store.readBlob(localId)
    }
    suspend fun markAttachmentReviewed(localId: String) = check(updateState(immediate = true, revertOnFailure = true) { current ->
        require(current.attachments.any { it.id == localId }) { "Attachment is no longer available" }
        current.copy(attachments = current.attachments.map { if (it.id == localId) it.copy(reviewedAt = System.currentTimeMillis()) else it })
    }) { PRIVATE_CACHE_ERROR }
    /** The record goes first, then the file: a crash in between leaves an unreferenced file the next start removes. */
    suspend fun removeAttachment(id: String) {
        check(updateState(immediate = true, revertOnFailure = true) { it.copy(attachments = it.attachments.filterNot { item -> item.id == id }) }) { PRIVATE_CACHE_ERROR }
        store.deleteBlob(id)
    }
    /** Removes the private copy now and, when the desktop still holds the upload, asks it to discard it. */
    suspend fun discardAttachment(id: String) {
        val local = _state.value.attachments.firstOrNull { it.id == id }
        removeAttachment(id)
        val remote = local?.remoteAttachmentId ?: return
        if (_state.value.supports("attachments.abort")) scope.launch { runCatching { mutate("attachments.abort", buildJsonObject { put("attachmentId", remote) }) } }
    }
    private suspend fun expireAttachments(ids: Set<String>) {
        if (ids.isEmpty()) return
        updateState(immediate = true) { current -> current.copy(attachments = current.attachments.map { if (it.id in ids) it.withoutRemote() else it }) }
    }
    suspend fun uploadAttachment(localId: String, initial: JsonObject? = null): JsonObject {
        var local = _state.value.attachments.firstOrNull { it.id == localId } ?: error("Attachment is no longer available")
        require(local.reviewedAt != null) { "Review this image before uploading it" }
        var upload = initial ?: local.remoteAttachmentId?.let { remoteId ->
            try { request("attachments.status", buildJsonObject { put("attachmentId", remoteId) }).jsonObject }
            catch (error: RemoteRequestException) {
                if (error.code != "ATTACHMENT_INVALID") throw error
                expireAttachments(setOf(localId))
                throw RemoteRequestException(error.code, "The desktop discarded this unfinished upload. Upload it again.")
            }
        } ?: error("Upload has not started")
        val attachmentId = upload.getValue("attachmentId").jsonPrimitive.content; val uploadId = upload.getValue("uploadId").jsonPrimitive.content; var offset = upload["offset"]?.jsonPrimitive?.intOrNull ?: 0
        // The upload's identity is saved before its first byte leaves, so it can resume after a crash.
        check(updateState(immediate = true) { current ->
            check(!pairingTransition && current.stagedPairing == null) { "Finish or cancel pairing confirmation first" }
            current.copy(attachments = current.attachments.map { if (it.id == localId) it.copy(remoteAttachmentId = attachmentId, uploadId = uploadId, committedOffset = offset, remoteStatus = upload["status"]?.jsonPrimitive?.contentOrNull ?: "uploading", remoteExpiresAt = upload["expiresAt"]?.jsonPrimitive?.longOrNull) else it })
        }) { PRIVATE_CACHE_ERROR }
        local = _state.value.attachments.first { it.id == localId }
        val bytes = store.readBlob(local.id)
        require(bytes.size == local.size && offset in 0..bytes.size)
        while (offset < bytes.size) {
            val count = minOf(256 * 1024, bytes.size - offset); val progress = CompletableDeferred<JsonObject>(); uploadProgress[uploadId] = progress
            val uuid = UUID.fromString(uploadId); val frame = ByteBuffer.allocate(24 + count).order(ByteOrder.BIG_ENDIAN).putLong(uuid.mostSignificantBits).putLong(uuid.leastSignificantBits).putLong(offset.toLong()).put(bytes, offset, count).array()
            if (socket?.send(ByteString.of(*frame)) != true) { uploadProgress.remove(uploadId); error("The desktop is unreachable") }
            val result = try { withTimeoutOrNull(REQUEST_TIMEOUT_MS) { progress.await() } } finally { uploadProgress.remove(uploadId) } ?: throw RequestTimeoutException()
            val next = result["offset"]?.jsonPrimitive?.intOrNull ?: error("Upload progress is missing")
            require(next == offset + count) { "Desktop reported an invalid upload offset" }; offset = next
            updateState { current -> current.copy(attachments = current.attachments.map { if (it.id == localId) it.copy(committedOffset = offset) else it }) }
        }
        return upload
    }
    /** Ready only once saved: on a failed save the image stays not ready, so it is never sent unconfirmed. */
    suspend fun markAttachmentReady(localId: String, result: JsonObject) = check(updateState(immediate = true, revertOnFailure = true) { current -> current.copy(attachments = current.attachments.map { if (it.id == localId) it.copy(remoteAttachmentId = result["attachmentId"]?.jsonPrimitive?.contentOrNull, uploadId = result["uploadId"]?.jsonPrimitive?.contentOrNull ?: it.uploadId, committedOffset = result["offset"]?.jsonPrimitive?.intOrNull ?: it.committedOffset, remoteStatus = result["status"]?.jsonPrimitive?.contentOrNull ?: "ready", remoteExpiresAt = result["expiresAt"]?.jsonPrimitive?.longOrNull ?: it.remoteExpiresAt) else it }) }) { PRIVATE_CACHE_ERROR }
    /** Reads a preview's bytes in parts and checks them against the digest the desktop named. */
    private suspend fun readPreview(metadata: JsonObject): ApprovalPreview {
        val readId = metadata.getValue("readId").jsonPrimitive.content; val size = metadata.getValue("size").jsonPrimitive.int
        require(size in 1..1_048_576) { "Preview is too large" }
        val output = ByteArray(size); var offset = 0
        while (offset < size) {
            val expected = minOf(256 * 1024, size - offset); val binary = CompletableDeferred<Pair<Long, ByteArray>>(); binaryReads[readId] = binary
            val response = try { request("attachments.read", buildJsonObject { put("readId", readId); put("offset", offset); put("length", expected) }).jsonObject } catch (error: Throwable) { binaryReads.remove(readId); throw error }
            val (frameOffset, payload) = try { withTimeoutOrNull(REQUEST_TIMEOUT_MS) { binary.await() } } finally { binaryReads.remove(readId) } ?: throw RequestTimeoutException()
            require(frameOffset == offset.toLong() && response["bytes"]?.jsonPrimitive?.intOrNull == payload.size && payload.size in 1..expected) { "Desktop returned an invalid preview part" }
            payload.copyInto(output, offset); offset += payload.size
        }
        val hash = android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(output), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        require(hash == metadata["sha256"]?.jsonPrimitive?.contentOrNull) { "Preview integrity check failed" }
        return ApprovalPreview(output, metadata.getValue("mime").jsonPrimitive.content, metadata.getValue("imageDigest").jsonPrimitive.content)
    }
    suspend fun approvalPreview(approval: Approval): ApprovalPreview {
        val fence = fence()
        try {
            val metadata = request("approvals.preview", buildJsonObject { put("approvalId", approval.id); put("revision", approval.revision); put("digest", approval.digest) }).jsonObject
            val preview = readPreview(metadata)
            if (!fence.holds(_state.value, socketGeneration)) throw StaleResultException()
            return preview
        } catch (error: RemoteRequestException) {
            when (error.code) {
                "APPROVAL_GONE" -> retireApproval(approval.identity())
                "REVISION_CONFLICT" -> snapshotRequests.trySend(Unit)
            }
            throw error
        }
    }

    suspend fun fullMessage(message: Message): String {
        if (!message.contentTruncated) return message.text
        require(_state.value.supports("sessions.messagePart")) { "This desktop cannot load the full message" }
        val parts = message.textParts ?: error("The desktop did not describe the message parts")
        require(parts.encoding == "unicode-scalar" && parts.count in 1..64 && parts.partChars in 1..32_768) { "Message is too large to open safely on this phone" }
        val fence = fence()
        val content = StringBuilder(minOf(message.contentChars ?: 0, 2_100_000).toInt())
        repeat(parts.count) { part ->
            val result = request("sessions.messagePart", buildJsonObject { put("sessionId", message.sessionId); put("messageId", message.id); put("revision", message.revision); put("part", part) }).jsonObject
            require(result["messageId"]?.jsonPrimitive?.contentOrNull == message.id && result["revision"]?.jsonPrimitive?.contentOrNull == message.revision) { "Message changed while it was loading" }
            require(result["part"]?.jsonPrimitive?.intOrNull == part && result["count"]?.jsonPrimitive?.intOrNull == parts.count && result["encoding"]?.jsonPrimitive?.contentOrNull == "unicode-scalar") { "Desktop returned an invalid message part" }
            val next = result["content"]?.jsonPrimitive?.content ?: error("Message part is missing")
            require(content.length + next.length <= 2_100_000) { "Message is too large to open safely on this phone" }
            content.append(next)
        }
        // A message erased (or a phone re-paired) while its parts loaded is not shown.
        if (!fence.holds(_state.value, socketGeneration)) throw StaleResultException()
        return content.toString()
    }

    private suspend fun requestWithCommand(command: PendingCommand, proof: Proof?): JsonElement {
        require(_state.value.supports(command.method)) { "The desktop isn't connected or doesn't offer this right now." }
        // The command ID is durable before the request leaves, so a crash can be reconciled.
        check(updateState(immediate = true) { current ->
            check(!pairingTransition && current.stagedPairing == null) { "Finish or cancel pairing confirmation first" }
            if (current.pendingCommands.any { it.commandId == command.commandId }) current else current.copy(pendingCommands = current.pendingCommands + command)
        }) { PRIVATE_CACHE_ERROR }
        val id = UUID.randomUUID().toString(); val deferred = CompletableDeferred<WireResponse>(); pendingResponses[id] = deferred
        if (socket?.send(WireCodec.encode(WireRequest(id = id, method = command.method, params = command.params, commandId = command.commandId, proof = proof))) != true) { pendingResponses.remove(id); throw CommandPendingException(command.commandId) }
        val response = try { withTimeoutOrNull(REQUEST_TIMEOUT_MS) { deferred.await() } } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return resolveAfterTransportFailure(command)
        } finally { pendingResponses.remove(id) } ?: return resolveAfterTransportFailure(command)
        response.error?.let {
            if (it.code == "OUTCOME_UNKNOWN") { markUnknown(command); throw CommandPendingException(command.commandId) }
            if (it.code == "REVISION_CONFLICT") snapshotRequests.trySend(Unit)
            if (it.code == "ATTACHMENT_INVALID" && command.method == "sessions.send") expireSessionAttachments(command.sessionId)
            settleCommand(command, retireApproval = it.code == "APPROVAL_GONE")
            throw RemoteRequestException(it.code, it.message)
        }; val result = response.result ?: JsonNull
        if (command.method == "sessions.send") {
            val status = acceptedSendStatus(result)
            if (status == null) { markPending(command.commandId, "unknown"); throw CommandPendingException(command.commandId) }
            // A queued result acknowledges durable broker ownership, so the user
            // can send the next follow-up without an uncertain-command barrier.
            if (status == "queued") removePending(command.commandId) else markPending(command.commandId, status)
        } else settleCommand(command, retireApproval = command.method == "approvals.answer")
        return result
    }
    private suspend fun resolveAfterTransportFailure(command: PendingCommand): JsonElement = try { resolveCommand(command) } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (refused: RemoteRequestException) { throw refused } catch (_: Throwable) { throw CommandPendingException(command.commandId) }
    private suspend fun resolveCommand(command: PendingCommand): JsonElement {
        if (!_state.value.supports("commands.status")) throw CommandPendingException(command.commandId)
        val status = try { request("commands.status", buildJsonObject { put("commandId", command.commandId) }).jsonObject } catch (cancelled: CancellationException) { throw cancelled } catch (_: Throwable) { throw CommandPendingException(command.commandId) }
        return when (status["status"]?.jsonPrimitive?.contentOrNull) {
            // Ledger acceptance means the broker is still processing the request;
            // only its completed result confirms provider acceptance to the UI.
            "accepted" -> { markPending(command.commandId, "accepted"); throw CommandPendingException(command.commandId) }
            "completed" -> {
                settleCommand(command, retireApproval = command.method == "approvals.answer")
                // A send confirmed only now (its reply was lost) clears its text and images as an answered send does.
                if (command.method == "sessions.send") acceptedLater(command)
                status["result"] ?: JsonNull
            }
            "failed" -> { val failure = status["error"] as? JsonObject
                val code = failure?.get("code")?.jsonPrimitive?.contentOrNull ?: "COMMAND_FAILED"
                if (code == "REVISION_CONFLICT") snapshotRequests.trySend(Unit)
                if (code == "ATTACHMENT_INVALID" && command.method == "sessions.send") expireSessionAttachments(command.sessionId)
                settleCommand(command, retireApproval = code == "APPROVAL_GONE")
                throw RemoteRequestException(code, failure?.get("message")?.jsonPrimitive?.contentOrNull ?: "The desktop could not complete this action.") }
            else -> { markUnknown(command); throw CommandPendingException(command.commandId) }
        }
    }
    private suspend fun acceptedLater(command: PendingCommand) {
        val sessionId = command.sessionId ?: return
        val text = command.params["text"]?.jsonPrimitive?.contentOrNull ?: return // params are withheld after a grant change
        val remote = command.params["attachments"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty().toSet()
        clearAcceptedDraft(sessionId, text, _state.value.attachments.filter { it.sessionId == sessionId && it.remoteAttachmentId in remote }.mapTo(HashSet(), LocalAttachment::id))
    }
    private fun rememberCapture(value: JsonObject) {
        val id = value["captureId"]?.jsonPrimitive?.contentOrNull ?: return
        _captures.update { current -> (current + (id to value)).entries.sortedByDescending { it.value["startedAt"]?.jsonPrimitive?.longOrNull ?: 0 }.take(8).associate { it.key to it.value } }
    }
    /** Accepted at once; the capture continues on the desktop (capturing, editing in Satty, ready). */
    fun captureStarted(result: JsonElement) { (result as? JsonObject)?.let(::rememberCapture) }
    suspend fun captureStatus(captureId: String): JsonObject = read("captures.status", buildJsonObject { put("captureId", captureId) }).jsonObject.also(::rememberCapture)
    suspend fun discardCapture(captureId: String) { mutate("captures.discard", buildJsonObject { put("captureId", captureId) }); _captures.update { it - captureId } }
    /** A reduced copy of a ready capture and the digest of the exact original it stands for. */
    suspend fun capturePreview(captureId: String): ApprovalPreview {
        val fence = fence()
        val metadata = request("captures.preview", buildJsonObject { put("captureId", captureId) }).jsonObject
        val preview = readPreview(metadata)
        if (!fence.holds(_state.value, socketGeneration)) throw StaleResultException()
        return preview
    }
    /**
     * The desktop attached the reviewed capture to [sessionId] as a ready image; the phone keeps the
     * preview it showed as the private copy, already reviewed, so the next send can include it.
     */
    suspend fun adoptCapture(sessionId: String, result: JsonObject, preview: ApprovalPreview) {
        val remoteId = result["attachmentId"]?.jsonPrimitive?.contentOrNull ?: error("The desktop did not return the attachment")
        val hash = android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(preview.bytes), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        val local = LocalAttachment(UUID.randomUUID().toString(), sessionId, "Desktop capture", preview.mime, preview.bytes.size, hash,
            result["width"]?.jsonPrimitive?.intOrNull ?: 0, result["height"]?.jsonPrimitive?.intOrNull ?: 0, transformed = true,
            remoteAttachmentId = remoteId, uploadId = result["uploadId"]?.jsonPrimitive?.contentOrNull, committedOffset = result["offset"]?.jsonPrimitive?.intOrNull ?: 0,
            remoteStatus = "ready", reviewedAt = System.currentTimeMillis(), remoteExpiresAt = result["expiresAt"]?.jsonPrimitive?.longOrNull)
        require(_state.value.attachments.count { it.sessionId == sessionId } < 4) { "A message can contain at most four images" }
        store.writeBlob(local.id, preview.bytes)
        if (!updateState(immediate = true, revertOnFailure = true) { it.copy(attachments = it.attachments + local) }) { runCatching { store.deleteBlob(local.id) }; error(PRIVATE_CACHE_ERROR) }
    }
    /** Keeps the receipt of an accepted forget or clear, so its removal can be checked later. */
    suspend fun recordErasure(result: JsonElement, sessionId: String, label: String) {
        val jobId = (result as? JsonObject)?.let { it["job_id"] ?: it["jobId"] ?: it["id"] }?.jsonPrimitive?.contentOrNull ?: return
        updateState(immediate = true) { current -> current.copy(erasures = (listOf(ErasureReceipt(jobId, sessionId, label.take(100), System.currentTimeMillis())) + current.erasures.filterNot { it.jobId == jobId }).take(MAX_ERASURE_RECEIPTS)) }
    }
    /** Asks the desktop how far an erasure got: suppressed at once, physically removed once purged. */
    suspend fun checkErasure(jobId: String): ErasureReceipt? {
        val receipt = _state.value.erasures.firstOrNull { it.jobId == jobId } ?: return null
        val status = read("memory.erasureStatus", buildJsonObject { put("sessionId", receipt.sessionId); put("jobId", jobId) }).jsonObject
        val checked = receipt.copy(purgeComplete = status["purgeComplete"]?.jsonPrimitive?.booleanOrNull == true, state = status["state"]?.jsonPrimitive?.contentOrNull, checkedAt = System.currentTimeMillis())
        updateState { current -> current.copy(erasures = current.erasures.map { if (it.jobId == jobId) checked else it }) }
        return checked
    }
    suspend fun dismissErasure(jobId: String) { updateState { current -> current.copy(erasures = current.erasures.filterNot { it.jobId == jobId }) } }
    /** Unknown outcomes the next snapshot shows anyway are forgotten; others wait for review. */
    private suspend fun markUnknown(command: PendingCommand) {
        if (CommandOutcomes.dropsWhenUnknown(command.method)) {
            removePending(command.commandId)
            if (command.method.startsWith("attachments.")) expireAttachments(_state.value.attachments.filter { it.remoteAttachmentId != null && it.remoteStatus != "ready" }.mapTo(HashSet(), LocalAttachment::id))
        } else markPending(command.commandId, "unknown")
    }
    private suspend fun expireSessionAttachments(sessionId: String?) {
        expireAttachments(_state.value.attachments.filter { it.sessionId == sessionId }.mapTo(HashSet(), LocalAttachment::id))
    }

    /** Explicit human review releases an uncertain ID; it never replays the operation. */
    suspend fun acknowledgeUnknownCommand(commandId: String) {
        val command = _state.value.pendingCommands.firstOrNull { it.commandId == commandId } ?: return
        require(command.status == "unknown") { "Cere is still checking this action with the desktop." }
        removePending(commandId)
    }
    suspend fun acknowledgeUnknownSend(commandId: String) = acknowledgeUnknownCommand(commandId)
    /**
     * When this pairing can no longer reach the desktop, the person confirms they checked
     * the listed actions on the PC. Their IDs are released and unfinished uploads return to
     * this phone, so the pairing can be replaced without losing drafts. Nothing is replayed.
     */
    suspend fun releaseForRepair() {
        check((_state.value.connection as? ConnectionState.Blocked)?.repair == true) { "Only a pairing that needs repair can release unconfirmed actions." }
        updateState(immediate = true) { current -> current.copy(pendingCommands = emptyList(),
            attachments = current.attachments.map { if (it.remoteStatus !in setOf("local", "ready")) it.withoutRemote() else it }) }
    }

    @Synchronized private fun connect() {
        if (restoreBlocked || !keepConnected()) return
        val desktop = _state.value.desktop ?: return; if (_state.value.stagedPairing != null || socket != null || connecting || terminalBlocked) return
        connecting = true
        scope.launch { updateState { it.copy(connection = ConnectionState.Connecting, lastError = null) } }
        scope.launch {
            // The keystore and the platform trust store are read here, off the main thread.
            val built = runCatching {
                if (desktop.endpoints.isEmpty()) throw PairingRepairException("This pairing has no desktop address. On the desktop, choose Update gateway addresses / certificate, then Replace pairing for this phone.")
                if (!pairing.hasSigningKeys(desktop)) throw PairingRepairException("Phone pairing keys are missing. Remove this phone pairing and pair again.")
                // The socket is not bound to a network (a split-tunnel VPN must keep routing it); the
                // network active now is the one it uses, so only that network's loss ends it.
                val network = app.getSystemService(android.net.ConnectivityManager::class.java)?.activeNetwork
                PinnedTls.client(desktop) to network
            }
            synchronized(this@CereRepository) {
                connecting = false
                val (client, network) = built.getOrElse { error ->
                    val reason = error.message?.takeIf(String::isNotBlank) ?: "Pinned desktop identity is invalid"
                    // Only a broken pairing stops reconnection; a phone clock that is off can recover.
                    if (error is PairingRepairException) block(reason, repair = true) else scheduleReconnect(reason)
                    return@launch
                }
                if (socket != null || !keepConnected() || terminalBlocked || _state.value.desktop != desktop || _state.value.stagedPairing != null) return@launch
                val endpoint = desktop.endpoints[endpointIndex++ % desktop.endpoints.size]
                val request = okhttp3.Request.Builder().url(endpoint).header("Sec-WebSocket-Protocol", "cere.mobile.v1").build()
                val generation = ++connections
                upserts.begin(generation); socketGeneration = generation; socketNetwork = network
                socket = client.newWebSocket(request, listener)
            }
        }
    }
    @Synchronized private fun block(reason: String, repair: Boolean) {
        terminalBlocked = true; reconnectJob?.cancel(); reconnectJob = null
        scope.launch { updateState { it.copy(connection = ConnectionState.Blocked(reason, repair), lastError = reason) } }
    }
    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) { synchronized(this@CereRepository) {
            if (socket !== webSocket) { webSocket.cancel(); return }; val desktop = _state.value.desktop ?: return
            scope.launch { updateState { it.copy(connection = ConnectionState.Authenticating) } }
            @Suppress("DEPRECATION")
            val appVersion = app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "unknown"
            val hello = Hello(desktopId = desktop.desktopId, deviceId = desktop.deviceId, clientNonce = CanonicalJson.base64Url(ByteArray(32).also(java.security.SecureRandom()::nextBytes)), appVersion = appVersion)
            activeHello = hello; webSocket.send(WireCodec.encode(hello))
        } }
        override fun onMessage(webSocket: WebSocket, text: String) {
            val generation = synchronized(this@CereRepository) { if (socket !== webSocket) return; socketGeneration }
            // Checked before anything is decoded or kept: a frame past the protocol limit ends the connection.
            if (!FrameLimits.fits(text)) { fail(webSocket, "The desktop sent more than this phone accepts at once; reconnecting", false); return }
            val frame = try { WireCodec.decodeFrame(text) } catch (error: Throwable) { fail(webSocket, error.message ?: "Protocol error", false); return }
            receive(webSocket, generation, frame)
        }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (socket !== webSocket || bytes.size <= 24) return
            if (bytes.size > FrameLimits.MAX_BINARY_BYTES) { fail(webSocket, "The desktop sent a larger image part than requested; reconnecting", false); return }
            val frame = ByteBuffer.wrap(bytes.toByteArray()).order(ByteOrder.BIG_ENDIAN); val id = UUID(frame.long, frame.long).toString(); val offset = frame.long
            binaryReads.remove(id)?.complete(offset to bytes.substring(24).toByteArray())
        }
        // Answer the desktop's close so the socket ends promptly instead of waiting out OkHttp's timer.
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
            val terminal = ConnectionPolicy.isTerminalFailure(t)
            fail(webSocket, if (terminal) "The desktop's certificate no longer matches this pairing. Pair this phone again." else t.message?.takeIf(String::isNotBlank) ?: "Connection failed", terminal, repair = terminal)
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (socket === webSocket) {
            when (ConnectionPolicy.closeAction(reason)) {
                CloseAction.Revoked -> scope.launch { revokeLocal(webSocket, "The desktop revoked this phone's access") }
                CloseAction.Terminal -> fail(webSocket, ConnectionPolicy.incompatibleText(reason), true)
                CloseAction.AuthRejected -> {
                    val gone = authRejections.record(System.currentTimeMillis())
                    fail(webSocket, if (gone) "The desktop no longer accepts this phone. If it was revoked or replaced, pair again." else "The desktop declined this sign-in; retrying", gone, repair = gone)
                }
                CloseAction.Retry -> fail(webSocket, closeReasonText(reason), false)
            }
        } }
    }
    private fun closeReasonText(reason: String) = when {
        reason.isBlank() -> "Disconnected"
        reason.contains("AUTH_EXPIRED") || reason.contains("AUTH_REFRESH") -> "Refreshing the desktop sign-in"
        reason.contains("SCOPE_CHANGED") -> "This phone's access changed; reconnecting"
        reason.contains("PAIRING_REPLACED") -> "This pairing was replaced on the desktop"
        reason.contains("SLOW_CONSUMER") || reason.contains("LIMIT_EXCEEDED") -> "The desktop closed a busy connection; reconnecting"
        reason.contains("ATTACHMENT_INVALID") -> "The desktop rejected an image upload; reconnecting"
        else -> reason
    }

    /**
     * Routes one decoded frame on the socket's reader thread without blocking it: replies and upload
     * acknowledgements complete their waiters, message updates are coalesced, and only ordered control
     * frames are queued. A full control queue means the desktop is misbehaving; the connection restarts.
     */
    private fun receive(webSocket: WebSocket, generation: Long, frame: Frame) {
        when (frame) {
            is Frame.Reply -> { pendingResponses.remove(frame.value.id)?.complete(frame.value); return }
            is Frame.Push -> when (frame.value.name) {
                "message.upsert" -> {
                    val message = runCatching { WireCodec.json.decodeFromJsonElement(Message.serializer(), frame.value.data) }.getOrNull()
                    if (message == null) { snapshotRequests.trySend(Unit); return }
                    if (upserts.offer(generation, message, frame.value.cursor)) upsertSignal.trySend(Unit)
                    return
                }
                "attachment.progress" -> { frame.value.data["uploadId"]?.jsonPrimitive?.contentOrNull?.let { uploadProgress.remove(it)?.complete(frame.value.data) }; return }
                "snapshot.changed" -> { snapshotRequests.trySend(Unit); return }
                "notice" -> { runCatching { WireCodec.json.decodeFromJsonElement(DesktopNotice.serializer(), frame.value.data) }.getOrNull()?.let { _notices.tryEmit(it) }; return }
                "capture.updated" -> { rememberCapture(frame.value.data); return }
                else -> Unit
            }
            else -> Unit
        }
        if (control.trySend(Inbound(generation, webSocket, frame)).isFailure) fail(webSocket, "The desktop sent too many control messages; reconnecting", false)
    }
    /** The current socket is gone: nothing held for it is applied, and its late frames are refused. */
    private fun endConnection() { socketGeneration = HeldUpserts.NONE; upserts.discard() }
    private suspend fun applyUpserts(batch: HeldUpserts.Batch) {
        // Past the held-update budget the backlog was dropped; an authoritative snapshot replaces it.
        if (batch.overflowed) { snapshotRequests.trySend(Unit); return }
        updateState(System.currentTimeMillis()) { current ->
            if (batch.generation != socketGeneration) return@updateState current
            val messages = current.messages.toMutableList(); val index = HashMap<String, Int>(messages.size * 2)
            messages.forEachIndexed { position, message -> index[message.id] = position }
            for (message in batch.messages) {
                val position = index[message.id]
                if (position == null) { index[message.id] = messages.size; messages += message }
                else if (revisionAfter(message.revision, messages[position].revision)) messages[position] = message
            }
            current.copy(messages = messages, cursor = batch.cursor ?: current.cursor)
        }
    }

    private suspend fun handle(webSocket: WebSocket, frame: Frame) { when (frame) {
        is Frame.Challenge -> { val desktop = _state.value.desktop ?: return; val hello = activeHello ?: return
            if (frame.value.audience != desktop.desktopId) throw TerminalProtocolException("This desktop's identity no longer matches the pairing. Pair this phone again.", repair = true)
            // The desktop enforces challenge expiry; the phone only learns the clock offset from it.
            serverOffset = ConnectionPolicy.serverClockOffset(frame.value.expiresAt, System.currentTimeMillis())
            val transcript = SigningTranscripts.authentication(CanonicalJson.sha256(WireCodec.json.encodeToJsonElement(Hello.serializer(), hello)), frame.value, desktop.desktopId, desktop.deviceId, 1)
            webSocket.send(WireCodec.encode(Auth(challengeId = frame.value.challengeId, signature = pairing.signConnection(desktop.connectionAlias, CanonicalJson.encode(transcript).toByteArray())))) }
        is Frame.Accepted -> { val desktop = _state.value.desktop ?: return
            if (frame.value.desktopId != desktop.desktopId) throw TerminalProtocolException("This desktop's identity no longer matches the pairing. Pair this phone again.", repair = true)
            if (frame.value.protocol.major != PROTOCOL_VERSION) throw TerminalProtocolException(ConnectionPolicy.incompatibleText(if (frame.value.protocol.major > PROTOCOL_VERSION) "INCOMPATIBLE_CLIENT_OLDER" else "INCOMPATIBLE_CLIENT_NEWER"))
            if (!ActionAuthenticationPolicy.modesMatch(desktop, frame.value)) throw TerminalProtocolException(
                if (desktop.actionAuthentication == ActionAuthentication.TRUSTED_DEVICE) "Restart the updated Cere broker on your PC to use trusted-phone actions."
                else "Desktop action authentication does not match this phone pairing."
            )
            synchronized(this) { welcome = frame.value; backoffAttempt = 0; unreachableSince = null; authRejections.reset() }
            updateState { current -> current.copy(
                connection = ConnectionState.Online(desktop.desktopName, frame.value.operations, frame.value.expiresAt, frame.value.features),
                pendingCommands = current.pendingCommands.map { command -> if (command.scopeVersion != null && command.scopeVersion != frame.value.scopeVersion) command.copy(params = JsonObject(emptyMap())) else command },
            ) }
            refreshJob?.cancel(); refreshJob = scope.launch { delay(ConnectionPolicy.refreshDelay(frame.value.expiresAt, serverOffset, System.currentTimeMillis())); if (socket === webSocket) webSocket.close(4000, "AUTH_REFRESH") }
            snapshotRequests.trySend(Unit) }
        is Frame.Reply -> pendingResponses.remove(frame.value.id)?.complete(frame.value)
        is Frame.Push -> handleEvent(webSocket, frame.value)
    } }

    private suspend fun reconcile() = syncMutex.withLock {
        if (!_state.value.supports("sync.open")) return; val selected = _state.value.selectedSessionId?.takeIf { id -> _state.value.sessions.any { it.id == id } }
        val syncParams = buildJsonObject { _state.value.cursor?.let { put("resumeCursor", it) }; selected?.let { put("selectedSessionId", it) } }
        val fence = fence()
        val result = try { request("sync.open", syncParams) } catch (error: RemoteRequestException) {
            if (selected != null && error.code == "SCOPE_DENIED") request("sync.open", buildJsonObject { _state.value.cursor?.let { put("resumeCursor", it) } }) else throw error
        }
        val snapshot = WireCodec.json.decodeFromJsonElement(SyncSnapshot.serializer(), result)
        val authorized = snapshot.sessionIds?.toSet() ?: snapshot.sessions.mapTo(mutableSetOf(), Session::id)
        val authorizedProjects = snapshot.projects.mapTo(mutableSetOf(), Project::id)
        // A snapshot from a connection that has since ended describes a scope that may no longer hold.
        if (!fence.holds(_state.value, socketGeneration, epoch = false)) return
        val outOfScope = _state.value.attachments.filter { it.sessionId !in authorized }.mapTo(HashSet(), LocalAttachment::id)
        var visibleApprovals = emptyList<Approval>()
        updateState(System.currentTimeMillis()) { current ->
            visibleApprovals = approvalRetirements.visible(snapshot.approvals)
            val visibleSnapshot = snapshot.copy(approvals = visibleApprovals)
            val base = if (snapshot.cacheEpoch != null && snapshot.cacheEpoch != current.cacheEpoch) current.copy(messages = emptyList()) else current; val merged = CacheReconciler.merge(base, visibleSnapshot, selected); current.copy(sessions = merged.sessions, messages = merged.messages, approvals = merged.approvals, drafts = merged.drafts,
            projects = snapshot.projects, providers = snapshot.providers, permissions = snapshot.permissions, settings = snapshot.settings, cursor = snapshot.cursor,
            selectedSessionId = current.selectedSessionId?.takeIf { id -> merged.sessions.any { it.id == id } }, attachments = current.attachments.filter { it.sessionId in authorized },
            scrollPositions = current.scrollPositions.filterKeys { it in authorized },
            erasures = current.erasures.filter { it.sessionId in authorized },
            // An authoritative snapshot settles unknown approval answers and self-correcting commands.
            pendingCommands = CommandOutcomes.afterSnapshot(CacheReconciler.retainAuthorizedCommands(current.pendingCommands, authorized, authorizedProjects, welcome?.scopeVersion)),
            cacheEpoch = snapshot.cacheEpoch ?: current.cacheEpoch, messagesBefore = if (selected == null) current.messagesBefore else snapshot.messagesBefore?.let { current.messagesBefore + (selected to it) } ?: (current.messagesBefore - selected), lastError = null)
        }
        retainApprovalInteractionState(visibleApprovals)
        // Their records left the cache with the snapshot; the files follow once that is saved.
        if (outOfScope.isNotEmpty()) { flushNow(); if (!cacheDirty) outOfScope.forEach { store.deleteBlob(it) } }
        hydrateSessions(snapshot)
        Unit
    }
    /**
     * Loads the summaries a snapshot named but did not include. By ID (sessions.batch) the snapshot's
     * own sessionIds decide what exists, so a change in order meanwhile cannot skip one, and an ID that
     * left scope is never brought back. An older desktop pages by offset. Either way the work per
     * snapshot is bounded; what remains is counted in sessionsNotLoaded and loads on request.
     */
    private suspend fun hydrateSessions(snapshot: SyncSnapshot, batches: Int = HYDRATION_BATCHES) {
        val ids = snapshot.sessionIds
        if (ids != null && _state.value.supports("sessions.batch")) { hydrateById(ids, batches); return }
        val first = snapshot.nextSessionOffset
        if (first == null) { updateState { it.copy(sessionsNotLoaded = 0) }; return }
        if (!_state.value.supports("sessions.list")) return
        var offset: Int? = first; var pages = 0
        while (offset != null && pages++ < batches) {
            val result = request("sessions.list", buildJsonObject { put("offset", offset) }).jsonObject
            mergeSummaries(result["items"]?.jsonArray.orEmpty().map { WireCodec.json.decodeFromJsonElement(Session.serializer(), it) })
            offset = result["nextOffset"]?.jsonPrimitive?.intOrNull
        }
        val total = ids?.size
        updateState { current -> current.copy(sessionsNotLoaded = if (offset == null) 0 else total?.let { all -> (all - current.sessions.count { it.id in ids }).coerceAtLeast(1) } ?: 1) }
    }
    private suspend fun hydrateById(ids: List<String>, batches: Int) {
        var rounds = 0
        while (rounds++ < batches) {
            val loaded = _state.value.sessions.mapTo(HashSet(), Session::id)
            val next = ids.filter { it !in loaded }.take(50)
            if (next.isEmpty()) break
            val result = request("sessions.batch", buildJsonObject { put("sessionIds", JsonArray(next.map(::JsonPrimitive))) }).jsonObject
            val items = result["items"]?.jsonArray.orEmpty().map { WireCodec.json.decodeFromJsonElement(Session.serializer(), it) }
            val gone = result["missing"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty().toSet()
            // A summary arriving after a newer snapshot removed its conversation is not reinserted.
            updateState { current ->
                val authorized = ids.toSet() - gone
                val existing = current.sessions.associateBy(Session::id)
                val incoming = items.filter { it.id in authorized }.map { CacheReconciler.mergeSession(existing[it.id], it) }.associateBy(Session::id)
                current.copy(sessions = current.sessions.filterNot { it.id in incoming || it.id in gone } + incoming.values)
            }
            if (items.isEmpty() && gone.isEmpty()) break
        }
        updateState { current -> val loaded = current.sessions.mapTo(HashSet(), Session::id); current.copy(sessionsNotLoaded = ids.count { it !in loaded }) }
    }
    /** Continues loading conversations a snapshot named that are not on this phone yet. */
    suspend fun loadMoreSessions() { if (_state.value.supports("sync.open")) snapshotRequests.trySend(Unit) }
    private suspend fun handleEvent(webSocket: WebSocket, event: Event) { when (event.name) {
        "snapshot.changed" -> snapshotRequests.trySend(Unit).let { }
        "attachment.progress" -> event.data["uploadId"]?.jsonPrimitive?.contentOrNull?.let { uploadProgress.remove(it)?.complete(event.data) }
        "device.revoked" -> revokeLocal(webSocket, "The desktop revoked this phone's access")
        "remote.disabled" -> fail(webSocket, "Remote access is turned off on the desktop", false)
        // Cursor acknowledgement follows the encrypted write of this message (see flushNow).
        "message.upsert" -> { val message = WireCodec.json.decodeFromJsonElement(Message.serializer(), event.data)
            updateState(System.currentTimeMillis()) { current -> val messages = current.messages.toMutableList(); val index = messages.indexOfFirst { it.id == message.id }; if (index < 0) messages += message else if (revisionAfter(message.revision, messages[index].revision)) messages[index] = message; current.copy(messages = messages, cursor = event.cursor) } }
        "notice" -> runCatching { WireCodec.json.decodeFromJsonElement(DesktopNotice.serializer(), event.data) }.getOrNull()?.let { _notices.tryEmit(it) }
    } }
    private suspend fun reconcilePendingCommands() { _state.value.pendingCommands.toList().forEach { command -> try { resolveCommand(command) } catch (cancelled: CancellationException) { throw cancelled } catch (_: CommandPendingException) { } catch (error: Throwable) { updateState { it.copy(lastError = error.message) } } } }

    @Synchronized private fun fail(webSocket: WebSocket, reason: String, terminal: Boolean, repair: Boolean = false) {
        if (socket !== webSocket) return; socket = null; welcome = null; endConnection(); refreshJob?.cancel(); refreshJob = null; webSocket.cancel()
        failWaiters(reason)
        if (terminal) block(reason, repair) else scheduleReconnect(reason)
    }
    private fun failWaiters(reason: String) {
        val error = IllegalStateException(reason)
        pendingResponses.values.forEach { it.completeExceptionally(error) }; pendingResponses.clear()
        uploadProgress.values.forEach { it.completeExceptionally(error) }; uploadProgress.clear()
        binaryReads.values.forEach { it.completeExceptionally(error) }; binaryReads.clear()
    }
    private suspend fun revokeLocal(webSocket: WebSocket, reason: String) {
        if (socket !== webSocket) return
        val desktop = _state.value.desktop; val staged = _state.value.stagedPairing?.desktop
        synchronized(this) { socket = null; welcome = null; endConnection(); shouldMonitor = false; terminalBlocked = true; refreshJob?.cancel(); reconnectJob?.cancel(); webSocket.cancel(); failWaiters(reason) }
        synchronized(flushLock) { flushJob?.cancel(); flushJob = null }
        if (desktop != null) runCatching { pairing.delete(desktop) }; if (staged != null) runCatching { pairing.delete(staged) }; store.clear(); stateMutex.withLock { _state.value = MobileState(restoreReady = true, connection = ConnectionState.Unpaired, lastError = reason); cacheDirty = false }
        pairingTransition = false; approvalRetirements.clear(); questionDraftIdentities.clear(); approvalMutationIdentities.clear()
        _questionDrafts.value = emptyMap(); _approvalMutations.value = emptySet()
    }
    @Synchronized private fun scheduleReconnect(reason: String) {
        val now = System.currentTimeMillis(); if (unreachableSince == null) unreachableSince = now
        scope.launch { updateState { current -> current.copy(connection = current.desktop?.let { ConnectionState.Offline(reason, lastVerified, OfflineKind.Unreachable) } ?: ConnectionState.Unpaired) } }
        if (!keepConnected() || terminalBlocked || reconnectJob?.isActive == true) return
        val ceiling = ConnectionPolicy.backoffCeiling(backoffAttempt, unreachableSince, now); backoffAttempt++; val wait = Random.nextLong(ceiling + 1)
        reconnectJob = scope.launch { delay(wait); synchronized(this@CereRepository) { reconnectJob = null }; if (keepConnected() && socket == null && !terminalBlocked) connect() }
    }

    @Volatile private var restoreFailure: PrivateCacheFailure? = null
    private suspend fun restore(): Boolean = restoreMutex.withLock restore@ {
        if (!restoreBlocked) return@restore true
        val cache = try { store.read() } catch (error: PrivateCacheUnavailableException) {
            restoreBlocked = true; restoreFailure = error.failure
            // Locked: retried after unlock. Damaged or keyless: only removing it and pairing again helps.
            stateMutex.withLock { _state.value = _state.value.copy(connection = ConnectionState.Blocked(error.failure.message, repair = error.failure.repair), lastError = error.failure.message) }
            return@restore false
        }
        restoreFailure = null
        // Image files and their records are written separately; after a crash between the two, a file
        // nothing refers to is removed and a record whose file is gone is dropped and reported.
        val listed = runCatching { store.blobIds() }
        val (orphans, dangling) = CacheIntegrity.blobs(cache.attachments.mapTo(HashSet(), LocalAttachment::id), listed.getOrDefault(emptySet()), filesListed = listed.isSuccess)
        orphans.forEach { runCatching { store.deleteBlob(it) } }
        val attachments = cache.attachments.filterNot { it.id in dangling }
        stateMutex.withLock {
            lastVerified = cache.lastVerifiedAt
            _state.value = MobileState(restoreReady = true, desktop = cache.desktop, stagedPairing = cache.stagedPairing,
            connection = cache.desktop?.let { ConnectionState.Offline("Not connected", cache.lastVerifiedAt, OfflineKind.NotConnected) } ?: ConnectionState.Unpaired,
            sessions = cache.sessions, messages = cache.messages, approvals = cache.approvals, projects = cache.projects, providers = cache.providers,
            permissions = cache.permissions, settings = cache.settings, cursor = cache.cursor, drafts = cache.drafts.associateBy(LocalDraft::sessionId), pendingCommands = cache.pendingCommands, selectedSessionId = cache.selectedSessionId, attachments = attachments, cacheEpoch = cache.cacheEpoch, scrollPositions = cache.scrollPositions, monitoring = shouldMonitor, erasures = cache.erasures,
                lastError = if (dangling.isNotEmpty()) "${dangling.size} image draft${if (dangling.size == 1) " was" else "s were"} lost when Cere stopped unexpectedly. Add ${if (dangling.size == 1) "it" else "them"} again." else null)
            if (dangling.isNotEmpty()) cacheDirty = true
            pairingTransition = cache.stagedPairing != null
            ackedCursor = cache.cursor
            restoreBlocked = false
        }
        true
    }
    /**
     * Applies [transform] to the state the app shows. Ordinary updates are written to the
     * encrypted cache at most once per [PERSIST_DEBOUNCE_MS]; [immediate] writes now and
     * returns whether the write succeeded, for changes that must survive a crash (command
     * IDs, attachments, a draft about to be sent).
     */
    private suspend fun updateState(verifiedAt: Long? = lastVerified, immediate: Boolean = false, revertOnFailure: Boolean = false, transform: (MobileState) -> MobileState): Boolean = stateMutex.withLock {
        if (restoreBlocked) return@withLock false; lastVerified = verifiedAt; val previous = _state.value; val transformed = transform(previous)
        val cutoff = System.currentTimeMillis() - CacheRetention.PERSISTED_AGE_MS
        val expired = transformed.attachments.filter { it.createdAt < cutoff }; expired.forEach { store.deleteBlob(it.id) }
        val attachments = transformed.attachments.filter { it.createdAt >= cutoff }
        // Only the open conversation keeps a hydrated desktop draft; others reload it when opened.
        val sessions = transformed.sessions.map { if (it.id != transformed.selectedSessionId && transformed.drafts[it.id]?.dirty != true) it.copy(draft = "", draftIncluded = false) else it }
        val (messages, cursors) = CacheRetention.liveBound(transformed.messages, transformed.messagesBefore, transformed.selectedSessionId)
        val next = transformed.copy(sessions = sessions, messages = messages, messagesBefore = cursors, attachments = attachments, lastError = if (expired.isNotEmpty()) "Image drafts older than seven days were removed from this phone" else transformed.lastError)
        val ready = if (next.lastError == PRIVATE_CACHE_ERROR) next.copy(lastError = null) else next
        _state.value = ready
        if (!immediate) { cacheDirty = true; scheduleFlush(); return@withLock true }
        // A step that is only complete once saved (an imported or reviewed image) is undone when saving fails.
        val saved = writeLocked(ready, verifiedAt)
        if (!saved && revertOnFailure) _state.value = previous.copy(lastError = PRIVATE_CACHE_ERROR)
        saved
    }
    /** Writes [ready] while holding the state lock; on success acknowledges its cursor to the desktop. */
    private suspend fun writeLocked(ready: MobileState, verifiedAt: Long?): Boolean = try {
        store.write(cached(ready, verifiedAt)); cacheDirty = false; acknowledge(ready.cursor); true
    } catch (cancelled: CancellationException) { throw cancelled } catch (_: Throwable) {
        cacheDirty = true; _state.value = ready.copy(lastError = PRIVATE_CACHE_ERROR); false
    }
    private fun scheduleFlush() {
        synchronized(flushLock) {
            if (flushJob?.isActive == true) return
            flushJob = scope.launch { delay(PERSIST_DEBOUNCE_MS); flushNow() }
        }
    }
    /** Writes any pending state now. The app calls this when it leaves the screen. */
    suspend fun flushNow() {
        stateMutex.withLock {
            if (restoreBlocked || !cacheDirty) return@withLock
            val ready = if (_state.value.lastError == PRIVATE_CACHE_ERROR) _state.value.copy(lastError = null) else _state.value
            if (writeLocked(ready, lastVerified)) _state.value = ready
        }
    }
    /** The desktop learns a cursor only after the state containing it is sealed on this phone. */
    private fun acknowledge(cursor: String?) {
        if (cursor == null || cursor == ackedCursor || !_state.value.supports("sync.ack")) return
        ackedCursor = cursor
        scope.launch { runCatching { request("sync.ack", buildJsonObject { put("cursor", cursor) }) } }
    }
    private fun cached(state: MobileState, verifiedAt: Long?) = CacheRetention.persistable(state, System.currentTimeMillis()).let { persisted -> CachedState(
        desktop = persisted.desktop,
        stagedPairing = persisted.stagedPairing,
        cursor = persisted.cursor,
        sessions = persisted.sessions,
        messages = persisted.messages,
        approvals = persisted.approvals,
        projects = persisted.projects,
        providers = persisted.providers,
        permissions = persisted.permissions,
        settings = persisted.settings,
        lastVerifiedAt = verifiedAt,
        drafts = persisted.drafts.values.toList(),
        pendingCommands = persisted.pendingCommands,
        selectedSessionId = persisted.selectedSessionId,
        attachments = persisted.attachments,
        cacheEpoch = persisted.cacheEpoch,
        scrollPositions = persisted.scrollPositions,
        erasures = persisted.erasures,
    ) }
    private suspend fun removePending(commandId: String) = updateState(immediate = true) { it.copy(pendingCommands = it.pendingCommands.filterNot { command -> command.commandId == commandId }) }
    private suspend fun markPending(commandId: String, status: String) = updateState(immediate = true) { current -> current.copy(pendingCommands = current.pendingCommands.map { if (it.commandId == commandId) it.copy(status = status) else it }) }
    private suspend fun retireApproval(identity: ApprovalIdentity) {
        approvalRetirements.retire(identity)
        updateState { current -> current.copy(approvals = current.approvals.filterNot { it.identity() == identity }) }
        clearApprovalInteractionState(identity)
    }
    private suspend fun settleCommand(command: PendingCommand, retireApproval: Boolean) {
        val identity = command.takeIf { retireApproval && it.method == "approvals.answer" }?.params?.let(::approvalIdentity)
        identity?.let(approvalRetirements::retire)
        updateState(immediate = true) { current -> current.copy(
            pendingCommands = current.pendingCommands.filterNot { it.commandId == command.commandId },
            approvals = identity?.let { retired -> current.approvals.filterNot { it.identity() == retired } } ?: current.approvals,
        ) }
        identity?.let(::clearApprovalInteractionState)
    }
    private fun approvalIdentity(params: JsonObject): ApprovalIdentity? {
        val id = params["approvalId"]?.jsonPrimitive?.contentOrNull ?: return null
        val revision = params["revision"]?.jsonPrimitive?.contentOrNull ?: return null
        val digest = params["digest"]?.jsonPrimitive?.contentOrNull ?: return null
        return ApprovalIdentity(id, revision, digest)
    }
    private fun pendingCommand(commandId: String, method: String, params: JsonObject, boundProjectId: String? = null, label: String? = null): PendingCommand {
        val directSession = listOf("sessionId", "sourceSessionId").firstNotNullOfOrNull { (params[it] as? JsonPrimitive)?.contentOrNull }
        val approvalId = (params["approvalId"] as? JsonPrimitive)?.contentOrNull
        val approvalSession = approvalId?.let { id -> _state.value.approvals.firstOrNull { it.id == id }?.sessionId }
        val attachmentSession = (params["attachmentId"] as? JsonPrimitive)?.contentOrNull?.let { id -> _state.value.attachments.firstOrNull { it.remoteAttachmentId == id }?.sessionId }
        val sessionId = directSession ?: approvalSession ?: attachmentSession
        val directProject = listOf("projectId", "confirmProjectId").firstNotNullOfOrNull { (params[it] as? JsonPrimitive)?.contentOrNull }
        val projectId = boundProjectId ?: directProject ?: sessionId?.let { id -> _state.value.sessions.firstOrNull { it.id == id }?.projectId }
        val answer = method == "approvals.answer"
        val title = label ?: sessionId?.let { id -> _state.value.sessions.firstOrNull { it.id == id }?.title?.take(60) }
        return PendingCommand(commandId, method, params, System.currentTimeMillis(), paramsDigest = CanonicalJson.sha256(params), scopeVersion = welcome?.scopeVersion, sessionId = sessionId, projectId = projectId,
            approvalId = approvalId.takeIf { answer }, approvalDigest = (params["digest"] as? JsonPrimitive)?.contentOrNull?.takeIf { answer }, label = title)
    }
    private fun revisionAfter(incoming: String, existing: String): Boolean = incoming.toBigIntegerOrNull()?.let { next -> existing.toBigIntegerOrNull()?.let { next > it } } ?: incoming != existing
    private companion object {
        const val PRIVATE_CACHE_ERROR = "Private cache is unavailable. Unlock the phone and retry."
        const val CONTROL_CAPACITY = 16
        const val MAX_ERASURE_RECEIPTS = 20
        /** Requests of 50 summaries per snapshot; more load when asked. */
        const val HYDRATION_BATCHES = 40
        const val REQUEST_TIMEOUT_MS = 30_000L
        const val PERSIST_DEBOUNCE_MS = 1_000L
        const val BACKGROUND_GRACE_MS = 30_000L
        const val TAG = "CereRepository"
    }
}

internal object ReplacementPolicy {
    fun blocker(state: MobileState): String? = when {
        state.pendingCommands.isNotEmpty() -> "Resolve pending command outcomes before replacing this phone pairing. Unresolved desktop actions are listed in Settings."
        state.attachments.any { it.remoteStatus !in setOf("local", "ready") } ->
            "Finish or cancel in-progress image uploads before replacing this phone pairing"
        else -> null
    }
}
