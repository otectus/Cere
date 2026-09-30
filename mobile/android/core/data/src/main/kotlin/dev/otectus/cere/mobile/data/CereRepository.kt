package dev.otectus.cere.mobile.data

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import dev.otectus.cere.mobile.protocol.*
import dev.otectus.cere.mobile.protocol.Request as WireRequest
import dev.otectus.cere.mobile.protocol.Response as WireResponse
import java.security.Signature
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlin.math.min
import kotlin.random.Random
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

sealed interface ConnectionState {
    data object Unpaired : ConnectionState
    data class Offline(val reason: String, val lastVerifiedAt: Long?) : ConnectionState
    data class Blocked(val reason: String) : ConnectionState
    data object Connecting : ConnectionState
    data object Authenticating : ConnectionState
    data class Online(val desktopName: String, val operations: Set<String>, val expiresAt: Long) : ConnectionState
}

data class MobileState(
    val restoreReady: Boolean = false,
    val desktop: PairedDesktop? = null,
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
) {
    fun supports(operation: String) = (connection as? ConnectionState.Online)?.operations?.contains(operation) == true
    fun draft(session: Session) = drafts[session.id] ?: LocalDraft(session.id, session.draft, session.draftRevision, session.draftRevision, false)
}

class PreparedAction internal constructor(
    val method: String,
    val params: JsonObject,
    val commandId: String,
    val challengeId: String,
    val signature: Signature,
    internal val transcript: ByteArray,
    internal val command: PendingCommand,
)
class CommandPendingException(val commandId: String) : IllegalStateException("Outcome unknown. Cere will reconcile command $commandId after reconnect.")
data class ApprovalPreview(val bytes: ByteArray, val mime: String, val imageDigest: String)
private class TerminalProtocolException(message: String) : IllegalStateException(message)

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
    private val snapshotRequests = Channel<Unit>(Channel.CONFLATED)
    private val frames = Channel<Pair<WebSocket, String>>(Channel.UNLIMITED)
    private val _state = MutableStateFlow(MobileState()); val state: StateFlow<MobileState> = _state.asStateFlow()
    private val _questionDrafts = MutableStateFlow<Map<String, Map<String, List<String>>>>(emptyMap())
    val questionDrafts: StateFlow<Map<String, Map<String, List<String>>>> = _questionDrafts.asStateFlow()
    private val _approvalMutations = MutableStateFlow<Set<String>>(emptySet())
    val approvalMutations: StateFlow<Set<String>> = _approvalMutations.asStateFlow()
    @Volatile private var socket: WebSocket? = null
    private var welcome: Welcome? = null; private var activeHello: Hello? = null
    private var reconnectJob: Job? = null; private var refreshJob: Job? = null
    private var endpointIndex = 0; private var backoffAttempt = 0; private var terminalBlocked = false
    @Volatile private var shouldMonitor = false; private var lastVerified: Long? = null
    // Treat startup as restore-blocked until the credential-encrypted cache has
    // been read. This prevents service/UI callbacks from persisting the default
    // unpaired state over an existing pairing while restore is still in flight.
    @Volatile private var restoreBlocked = true; private var cacheDirty = false
    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { scope.launch {
            if (restoreBlocked) { if (restore() && shouldMonitor) connect() } else if (cacheDirty) flushPrivateCache()
        } }
    }

    init {
        val unlockFilter = IntentFilter().apply { addAction(Intent.ACTION_USER_UNLOCKED); addAction(Intent.ACTION_USER_PRESENT) }
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(unlockReceiver, unlockFilter, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") app.registerReceiver(unlockReceiver, unlockFilter)
        scope.launch { if (restore() && shouldMonitor) connect(); for ((webSocket, text) in frames) {
            if (socket !== webSocket) continue
            try { handle(webSocket, WireCodec.decodeFrame(text)) }
            catch (error: Throwable) { fail(webSocket, error.message ?: "Protocol error", error is TerminalProtocolException) }
        } }
        scope.launch { for (ignored in snapshotRequests) {
            try { reconcile(); reconcilePendingCommands() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { updateState { it.copy(lastError = error.message ?: "Could not refresh desktop state") } }
        } }
    }

    fun pairingManager() = pairing
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
    suspend fun completePairing(completed: CompletedPairing) {
        if (!updateState { MobileState(restoreReady = true, desktop = completed.desktop, connection = ConnectionState.Offline("Ready to connect", null)) }) {
            cacheDirty = false; stateMutex.withLock { _state.value = MobileState(connection = ConnectionState.Blocked(PRIVATE_CACHE_ERROR), lastError = PRIVATE_CACHE_ERROR) }; error(PRIVATE_CACHE_ERROR)
        }
    }

    @Synchronized fun startMonitoring() { shouldMonitor = true; terminalBlocked = false; if (restoreBlocked) scope.launch { stateMutex.withLock { _state.value = _state.value.copy(monitoring = true) } } else scope.launch { updateState { it.copy(monitoring = true) } }; if (socket == null && !restoreBlocked) connect() }
    /** Opening the app reconnects a restored pairing even when its service was stopped by an update. */
    @Synchronized fun connectWhileOpen() {
        if (restoreBlocked || _state.value.desktop == null || socket != null || terminalBlocked) return
        shouldMonitor = true; reconnectJob?.cancel(); reconnectJob = null; connect()
    }
    @Synchronized fun networkAvailable() {
        if (!shouldMonitor || restoreBlocked || socket != null || terminalBlocked) return
        reconnectJob?.cancel(); reconnectJob = null; connect()
    }
    @Synchronized fun stopMonitoring(reason: String = "Monitoring off") {
        shouldMonitor = false; reconnectJob?.cancel(); reconnectJob = null; refreshJob?.cancel(); refreshJob = null
        val currentSocket = socket; socket = null; welcome = null; currentSocket?.close(1000, reason)
        scope.launch { updateState { current -> current.copy(connection = current.desktop?.let { ConnectionState.Offline(reason, lastVerified) } ?: ConnectionState.Unpaired, monitoring = false) } }
    }
    @Synchronized fun retry() { terminalBlocked = false; backoffAttempt = 0; shouldMonitor = true; if (restoreBlocked) { scope.launch { if (restore()) connect() }; return }; val old = socket; socket = null; old?.cancel(); reconnectJob?.cancel(); reconnectJob = null; connect() }

    fun setQuestionAnswer(approvalId: String, questionId: String, answers: List<String>) {
        _questionDrafts.update { drafts ->
            val approval = drafts[approvalId].orEmpty().toMutableMap()
            if (answers.any(String::isNotBlank)) approval[questionId] = answers else approval.remove(questionId)
            if (approval.isEmpty()) drafts - approvalId else drafts + (approvalId to approval.toMap())
        }
    }

    @Synchronized fun beginApprovalMutation(approvalId: String): Boolean {
        if (approvalId in _approvalMutations.value) return false
        _approvalMutations.value = _approvalMutations.value + approvalId
        return true
    }

    @Synchronized fun endApprovalMutation(approvalId: String) {
        _approvalMutations.value = _approvalMutations.value - approvalId
    }

    private fun retainApprovalInteractionState(approvals: List<Approval>) {
        val ids = approvals.mapTo(mutableSetOf(), Approval::id)
        _questionDrafts.update { drafts -> drafts.filterKeys { it in ids } }
        _approvalMutations.update { mutations -> mutations.filterTo(mutableSetOf()) { it in ids } }
    }

    suspend fun forget() {
        val desktop = _state.value.desktop ?: return
        if (_state.value.supports("devices.selfRevoke")) runCatching { mutate("devices.selfRevoke", buildJsonObject {}) }
        stopMonitoring("Forgotten"); pairing.delete(desktop); store.clear(); stateMutex.withLock { _state.value = MobileState(restoreReady = true) }
        _questionDrafts.value = emptyMap(); _approvalMutations.value = emptySet()
    }

    suspend fun selectSession(sessionId: String?) {
        updateState { it.copy(selectedSessionId = sessionId) }
        if (sessionId != null && _state.value.supports("sessions.get")) runCatching {
            val full = WireCodec.json.decodeFromJsonElement(Session.serializer(), request("sessions.get", buildJsonObject { put("sessionId", sessionId) }))
            updateState { current ->
                val merged = CacheReconciler.mergeSession(current.sessions.firstOrNull { it.id == sessionId }, full)
                val draft = CacheReconciler.mergeDraft(current.drafts[sessionId], merged)
                current.copy(sessions = current.sessions.map { if (it.id == sessionId) merged else it }, drafts = current.drafts + (sessionId to draft))
            }
        }
        if (_state.value.supports("sync.open")) snapshotRequests.trySend(Unit)
    }

    suspend fun openCreatedSession(result: JsonElement): String {
        val session = WireCodec.json.decodeFromJsonElement(Session.serializer(), result)
        updateState { current -> current.copy(selectedSessionId = session.id,
            sessions = current.sessions.filterNot { it.id == session.id } + session) }
        selectSession(session.id)
        return session.id
    }

    suspend fun request(method: String, params: JsonObject): JsonElement {
        require(_state.value.supports(method)) { "Desktop did not negotiate $method" }
        val id = UUID.randomUUID().toString(); val deferred = CompletableDeferred<WireResponse>(); pendingResponses[id] = deferred
        if (socket?.send(WireCodec.encode(WireRequest(id = id, method = method, params = params))) != true) { pendingResponses.remove(id); error("Desktop is unreachable") }
        val response = try { withTimeout(30_000) { deferred.await() } } finally { pendingResponses.remove(id) }
        response.error?.let { error("${it.code}: ${it.message}") }; return response.result ?: JsonNull
    }

    suspend fun mutate(method: String, params: JsonObject): JsonElement {
        val digest = CanonicalJson.sha256(params)
        val existing = _state.value.pendingCommands.firstOrNull { it.method == method && it.paramsDigest == digest }
        return requestWithCommand(existing?.copy(params = params) ?: pendingCommand(UUID.randomUUID().toString(), method, params), null)
    }

    suspend fun prepareAction(method: String, params: JsonObject, boundProjectId: String? = null): PreparedAction {
        require(_state.value.supports(method)); val desktop = _state.value.desktop ?: error("Not paired"); val session = welcome ?: error("Not authenticated")
        val connectionSigned = method == "sessions.send"
        check(!connectionSigned || session.sendAuthentication == "connection-key") {
            "Restart the updated Cere broker on your PC to send without a password or fingerprint. Your draft is saved."
        }
        val digest = CanonicalJson.sha256(params); val existing = _state.value.pendingCommands.firstOrNull { it.method == method && it.paramsDigest == digest }
        val commandId = existing?.commandId ?: UUID.randomUUID().toString()
        val challenge = request("commands.challenge", buildJsonObject { put("method", method); put("paramsDigest", digest); put("commandId", commandId) }).jsonObject
        val challengeId = challenge.getValue("challengeId").jsonPrimitive.content; val nonce = challenge.getValue("nonce").jsonPrimitive.content
        val transcript = CanonicalJson.encode(SigningTranscripts.action(desktop.desktopId, desktop.deviceId, 1, session.scopeVersion, session.epoch,
            session.authSessionId, challengeId, nonce, method, digest, commandId)).toByteArray()
        val signature = if (connectionSigned) pairing.connectionSignature(desktop.connectionAlias) else pairing.actionSignature(desktop.actionAlias)
        return PreparedAction(method, params, commandId, challengeId, signature, transcript,
            pendingCommand(commandId, method, params, boundProjectId))
    }
    suspend fun completeAction(action: PreparedAction, signature: ByteArray): JsonElement = requestWithCommand(action.command, Proof(action.challengeId, CanonicalJson.base64Url(signature)))
    fun signAuthenticated(action: PreparedAction): ByteArray = action.signature.run { update(action.transcript); sign() }

    suspend fun saveLocalDraft(sessionId: String, text: String) = updateState { current ->
        val session = current.sessions.firstOrNull { it.id == sessionId } ?: return@updateState current; val old = current.drafts[sessionId] ?: current.draft(session)
        val otherDraftBytes = current.drafts.filterKeys { it != sessionId }.values.sumOf { it.text.toByteArray().size }
        require(otherDraftBytes + text.toByteArray().size + current.attachments.sumOf { it.size } <= 19 * 1024 * 1024) { "Private offline drafts have reached the 20 MiB device limit" }
        current.copy(drafts = current.drafts + (sessionId to old.copy(text = text, dirty = text != session.draft)))
    }
    suspend fun syncDraft(sessionId: String) = draftMutexes.getOrPut(sessionId) { Mutex() }.withLock { syncDraftLocked(sessionId) }
    private suspend fun syncDraftLocked(sessionId: String) {
        if (!_state.value.supports("drafts.put")) return; val draft = _state.value.drafts[sessionId] ?: return
        if (!draft.dirty || draft.conflict) return
        val result = mutate("drafts.put", buildJsonObject { put("sessionId", sessionId); put("text", draft.text); put("expectedRevision", draft.remoteRevision) }).jsonObject
        val revision = result.getValue("revision").jsonPrimitive.content
        updateState { current ->
            val latest = current.drafts[sessionId] ?: return@updateState current
            current.copy(drafts = current.drafts + (sessionId to CacheReconciler.acknowledgeDraft(latest, draft.text, revision)),
                sessions = current.sessions.map { session -> if (session.id == sessionId &&
                    (session.draftRevision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) <= revision.toBigInteger())
                    session.copy(draft = draft.text, draftRevision = revision) else session })
        }
    }

    /** Serialize pending autosaves before binding the send signature to draft/config revisions. */
    suspend fun prepareSend(sessionId: String, text: String): PreparedAction = draftMutexes.getOrPut(sessionId) { Mutex() }.withLock {
        require(_state.value.pendingCommands.none { it.sessionId == sessionId && it.method == "sessions.send" }) { "Review the previous send outcome before sending another message" }
        val initial = _state.value.sessions.first { it.id == sessionId }
        require(initial.canSend && initial.draftIncluded) { "This session is not ready to send" }
        require(!_state.value.draft(initial).conflict) { "Resolve the desktop draft conflict before sending" }
        check(saveLocalDraft(sessionId, text)) { PRIVATE_CACHE_ERROR }
        syncDraftLocked(sessionId)
        val current = _state.value
        val session = current.sessions.first { it.id == sessionId }
        val draft = current.draft(session)
        require(!draft.conflict && draft.text == text) { "Draft changed. Review the current text before sending" }
        val attachments = current.attachments.filter { it.sessionId == sessionId }
        require(attachments.all { it.remoteAttachmentId != null && it.remoteStatus == "ready" }) { "Finish uploading the images before sending" }
        prepareAction("sessions.send", buildJsonObject {
            put("sessionId", sessionId); put("text", text)
            put("attachments", JsonArray(attachments.map { JsonPrimitive(it.remoteAttachmentId!!) }))
            put("webSearch", false); put("expectedDraftRevision", draft.remoteRevision); put("expectedConfigRevision", session.configRevision)
        })
    }
    suspend fun keepLocalDraft(sessionId: String) { updateState { current -> current.drafts[sessionId]?.let { current.copy(drafts = current.drafts + (sessionId to it.copy(baseRevision = it.remoteRevision, conflict = false, remoteText = null, dirty = true))) } ?: current }; syncDraft(sessionId) }
    suspend fun reloadRemoteDraft(sessionId: String) = updateState { current -> current.drafts[sessionId]?.let { draft -> current.copy(drafts = current.drafts + (sessionId to draft.copy(text = draft.remoteText.orEmpty(), baseRevision = draft.remoteRevision, dirty = false, conflict = false, remoteText = null))) } ?: current }
    suspend fun clearAcceptedDraft(sessionId: String, sentText: String, attachmentIds: Set<String>) {
        _state.value.attachments.filter { it.id in attachmentIds }.forEach { store.deleteBlob(it.id) }
        updateState { current -> val session = current.sessions.firstOrNull { it.id == sessionId } ?: return@updateState current; val draft = current.drafts[sessionId] ?: current.draft(session)
            current.copy(drafts = if (draft.text == sentText) current.drafts + (sessionId to draft.copy(text = "", dirty = false, conflict = false, remoteText = null)) else current.drafts,
                attachments = current.attachments.filterNot { it.id in attachmentIds }) }
        snapshotRequests.trySend(Unit)
    }

    suspend fun loadMessages(sessionId: String) {
        if (_state.value.selectedSessionId != sessionId) selectSession(sessionId); if (!_state.value.supports("sessions.messages")) return
        val result = request("sessions.messages", buildJsonObject { put("sessionId", sessionId); put("limit", 100) }).jsonObject
        val incoming = result["items"]?.jsonArray?.map { WireCodec.json.decodeFromJsonElement(Message.serializer(), it) }.orEmpty()
        val before = result["before"]?.jsonPrimitive?.contentOrNull
        updateState(System.currentTimeMillis()) { current -> current.copy(messages = mergeMessages(current.messages, incoming), messagesBefore = if (before == null) current.messagesBefore - sessionId else current.messagesBefore + (sessionId to before)) }
    }
    suspend fun loadOlderMessages(sessionId: String) {
        val before = _state.value.messagesBefore[sessionId] ?: return
        val result = request("sessions.messages", buildJsonObject { put("sessionId", sessionId); put("before", before); put("limit", 100) }).jsonObject
        val incoming = result["items"]?.jsonArray?.map { WireCodec.json.decodeFromJsonElement(Message.serializer(), it) }.orEmpty(); val next = result["before"]?.jsonPrimitive?.contentOrNull
        updateState(System.currentTimeMillis()) { current -> current.copy(messages = mergeMessages(current.messages, incoming), messagesBefore = if (next == null) current.messagesBefore - sessionId else current.messagesBefore + (sessionId to next)) }
    }
    suspend fun loadActivity(sessionId: String) {
        val incoming = request("activity.list", buildJsonObject { put("sessionId", sessionId); put("limit", 100) }).jsonArray
            .map { WireCodec.json.decodeFromJsonElement(Message.serializer(), it) }
        updateState { current -> current.copy(messages = mergeMessages(current.messages, incoming)) }
    }
    suspend fun models(provider: String, refresh: Boolean = false): List<ModelOption> {
        val cached = _state.value.providers[provider]?.jsonObject?.get("models")?.jsonArray.orEmpty().mapNotNull { runCatching { WireCodec.json.decodeFromJsonElement(ModelOption.serializer(), it) }.getOrNull() }
        if (!refresh && cached.isNotEmpty()) return cached; if (!_state.value.supports("providers.models")) return emptyList()
        return request("providers.models", buildJsonObject { put("provider", provider) }).jsonArray.map { WireCodec.json.decodeFromJsonElement(ModelOption.serializer(), it) }
    }

    suspend fun importImage(sessionId: String, uri: android.net.Uri): LocalAttachment {
        val (attachment, bytes) = decodePrivateImage(app, sessionId, uri)
        require(_state.value.attachments.filter { it.sessionId == sessionId }.size < 4) { "A message can contain at most four images" }
        require(_state.value.attachments.sumOf { it.size } + _state.value.drafts.values.sumOf { it.text.toByteArray().size } + attachment.size <= 19 * 1024 * 1024) { "Private offline media has reached the 20 MiB device limit" }
        store.writeBlob(attachment.id, bytes); updateState { it.copy(attachments = it.attachments + attachment) }; return attachment
    }
    suspend fun importCameraImage(sessionId: String, bitmap: android.graphics.Bitmap): LocalAttachment {
        val (attachment, bytes) = encodePrivateBitmap(sessionId, bitmap)
        require(_state.value.attachments.filter { it.sessionId == sessionId }.size < 4) { "A message can contain at most four images" }
        require(_state.value.attachments.sumOf { it.size } + _state.value.drafts.values.sumOf { it.text.toByteArray().size } + attachment.size <= 19 * 1024 * 1024) { "Private offline media has reached the 20 MiB device limit" }
        store.writeBlob(attachment.id, bytes); updateState { it.copy(attachments = it.attachments + attachment) }; return attachment
    }
    suspend fun removeAttachment(id: String) { store.deleteBlob(id); updateState { it.copy(attachments = it.attachments.filterNot { item -> item.id == id }) } }
    suspend fun uploadAttachment(localId: String, initial: JsonObject? = null): JsonObject {
        var local = _state.value.attachments.firstOrNull { it.id == localId } ?: error("Attachment is no longer available")
        var upload = initial ?: local.remoteAttachmentId?.let { request("attachments.status", buildJsonObject { put("attachmentId", it) }).jsonObject } ?: error("Upload has not started")
        val attachmentId = upload.getValue("attachmentId").jsonPrimitive.content; val uploadId = upload.getValue("uploadId").jsonPrimitive.content; var offset = upload["offset"]?.jsonPrimitive?.intOrNull ?: 0
        updateState { current -> current.copy(attachments = current.attachments.map { if (it.id == localId) it.copy(remoteAttachmentId = attachmentId, uploadId = uploadId, committedOffset = offset, remoteStatus = upload["status"]?.jsonPrimitive?.contentOrNull ?: "uploading") else it }) }
        local = _state.value.attachments.first { it.id == localId }
        val bytes = store.readBlob(local.id)
        require(bytes.size == local.size && offset in 0..bytes.size)
        while (offset < bytes.size) {
            val count = minOf(256 * 1024, bytes.size - offset); val progress = CompletableDeferred<JsonObject>(); uploadProgress[uploadId] = progress
            val uuid = UUID.fromString(uploadId); val frame = ByteBuffer.allocate(24 + count).order(ByteOrder.BIG_ENDIAN).putLong(uuid.mostSignificantBits).putLong(uuid.leastSignificantBits).putLong(offset.toLong()).put(bytes, offset, count).array()
            if (socket?.send(ByteString.of(*frame)) != true) { uploadProgress.remove(uploadId); error("Desktop is unreachable") }
            val result = try { withTimeout(30_000) { progress.await() } } finally { uploadProgress.remove(uploadId) }
            val next = result["offset"]?.jsonPrimitive?.intOrNull ?: error("Upload progress is missing")
            require(next == offset + count) { "Desktop reported an invalid upload offset" }; offset = next
            updateState { current -> current.copy(attachments = current.attachments.map { if (it.id == localId) it.copy(committedOffset = offset) else it }) }
        }
        return upload
    }
    suspend fun markAttachmentReady(localId: String, result: JsonObject) = updateState { current -> current.copy(attachments = current.attachments.map { if (it.id == localId) it.copy(remoteAttachmentId = result["attachmentId"]?.jsonPrimitive?.contentOrNull, uploadId = result["uploadId"]?.jsonPrimitive?.contentOrNull ?: it.uploadId, committedOffset = result["offset"]?.jsonPrimitive?.intOrNull ?: it.committedOffset, remoteStatus = result["status"]?.jsonPrimitive?.contentOrNull ?: "ready") else it }) }
    suspend fun approvalPreview(approval: Approval): ApprovalPreview {
        val metadata = request("approvals.preview", buildJsonObject { put("approvalId", approval.id); put("revision", approval.revision); put("digest", approval.digest) }).jsonObject
        val readId = metadata.getValue("readId").jsonPrimitive.content; val size = metadata.getValue("size").jsonPrimitive.int
        require(size in 1..1_048_576) { "Preview is too large" }
        val output = ByteArray(size); var offset = 0
        while (offset < size) {
            val expected = minOf(256 * 1024, size - offset); val binary = CompletableDeferred<Pair<Long, ByteArray>>(); binaryReads[readId] = binary
            val response = try { request("attachments.read", buildJsonObject { put("readId", readId); put("offset", offset); put("length", expected) }).jsonObject } catch (error: Throwable) { binaryReads.remove(readId); throw error }
            val (frameOffset, payload) = try { withTimeout(30_000) { binary.await() } } finally { binaryReads.remove(readId) }
            require(frameOffset == offset.toLong() && response["bytes"]?.jsonPrimitive?.intOrNull == payload.size && payload.size in 1..expected) { "Desktop returned an invalid preview part" }
            payload.copyInto(output, offset); offset += payload.size
        }
        val hash = android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(output), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        require(hash == metadata["sha256"]?.jsonPrimitive?.contentOrNull) { "Preview integrity check failed" }
        return ApprovalPreview(output, metadata.getValue("mime").jsonPrimitive.content, metadata.getValue("imageDigest").jsonPrimitive.content)
    }

    suspend fun fullMessage(message: Message): String {
        if (!message.contentTruncated) return message.text
        require(_state.value.supports("sessions.messagePart")) { "This desktop cannot load the full message" }
        val parts = message.textParts ?: error("The desktop did not describe the message parts")
        require(parts.encoding == "unicode-scalar" && parts.count in 1..64 && parts.partChars in 1..32_768) { "Message is too large to open safely on this phone" }
        val content = StringBuilder(minOf(message.contentChars ?: 0, 2_100_000).toInt())
        repeat(parts.count) { part ->
            val result = request("sessions.messagePart", buildJsonObject { put("sessionId", message.sessionId); put("messageId", message.id); put("revision", message.revision); put("part", part) }).jsonObject
            require(result["messageId"]?.jsonPrimitive?.contentOrNull == message.id && result["revision"]?.jsonPrimitive?.contentOrNull == message.revision) { "Message changed while it was loading" }
            require(result["part"]?.jsonPrimitive?.intOrNull == part && result["count"]?.jsonPrimitive?.intOrNull == parts.count && result["encoding"]?.jsonPrimitive?.contentOrNull == "unicode-scalar") { "Desktop returned an invalid message part" }
            val next = result["content"]?.jsonPrimitive?.content ?: error("Message part is missing")
            require(content.length + next.length <= 2_100_000) { "Message is too large to open safely on this phone" }
            content.append(next)
        }
        return content.toString()
    }

    private suspend fun requestWithCommand(command: PendingCommand, proof: Proof?): JsonElement {
        require(_state.value.supports(command.method)); check(updateState { current -> if (current.pendingCommands.any { it.commandId == command.commandId }) current else current.copy(pendingCommands = current.pendingCommands + command) }) { PRIVATE_CACHE_ERROR }
        val id = UUID.randomUUID().toString(); val deferred = CompletableDeferred<WireResponse>(); pendingResponses[id] = deferred
        if (socket?.send(WireCodec.encode(WireRequest(id = id, method = command.method, params = command.params, commandId = command.commandId, proof = proof))) != true) { pendingResponses.remove(id); throw CommandPendingException(command.commandId) }
        val response = try { withTimeout(30_000) { deferred.await() } } catch (_: TimeoutCancellationException) {
            return resolveCommand(command)
        } catch (_: CancellationException) {
            throw CommandPendingException(command.commandId)
        } catch (_: Throwable) {
            return runCatching { resolveCommand(command) }.getOrElse { throw CommandPendingException(command.commandId) }
        } finally { pendingResponses.remove(id) }
        response.error?.let {
            if (it.code == "OUTCOME_UNKNOWN") { markPending(command.commandId, "unknown"); throw CommandPendingException(command.commandId) }
            removePending(command.commandId)
            error("${it.code}: ${it.message}")
        }; val result = response.result ?: JsonNull
        if (command.method == "sessions.send") { val status = result.jsonObject["status"]?.jsonPrimitive?.contentOrNull; if (status !in setOf("accepted", "completed")) { markPending(command.commandId, "unknown"); throw CommandPendingException(command.commandId) }; markPending(command.commandId, status!!) }
        else removePending(command.commandId)
        return result
    }
    private suspend fun resolveCommand(command: PendingCommand): JsonElement {
        if (!_state.value.supports("commands.status")) throw CommandPendingException(command.commandId)
        val status = runCatching { request("commands.status", buildJsonObject { put("commandId", command.commandId) }).jsonObject }.getOrElse { throw CommandPendingException(command.commandId) }
        return when (status["status"]?.jsonPrimitive?.contentOrNull) {
            // Ledger acceptance means the broker is still processing the request;
            // only its completed result confirms provider acceptance to the UI.
            "accepted" -> { markPending(command.commandId, "accepted"); throw CommandPendingException(command.commandId) }
            "completed" -> { removePending(command.commandId); status["result"] ?: JsonNull }
            "failed" -> { removePending(command.commandId); val failure = status["error"] as? JsonObject
                error("${failure?.get("code")?.jsonPrimitive?.contentOrNull ?: "COMMAND_FAILED"}: ${failure?.get("message")?.jsonPrimitive?.contentOrNull ?: "Command failed"}") }
            else -> { markPending(command.commandId, "unknown"); throw CommandPendingException(command.commandId) }
        }
    }

    /** Explicit human review releases an uncertain ID; it never replays the operation. */
    suspend fun acknowledgeUnknownSend(commandId: String) {
        val command = _state.value.pendingCommands.firstOrNull { it.commandId == commandId } ?: return
        require(command.method == "sessions.send" && command.status == "unknown")
        removePending(commandId)
    }

    @Synchronized private fun connect() {
        if (restoreBlocked || !shouldMonitor) return
        val desktop = _state.value.desktop ?: return; if (socket != null || terminalBlocked) return
        if (!pairing.hasSigningKeys(desktop)) {
            val reason = "Phone pairing keys are missing. Remove this phone pairing and pair again."
            terminalBlocked = true; reconnectJob?.cancel(); reconnectJob = null
            scope.launch { updateState { it.copy(connection = ConnectionState.Blocked(reason), lastError = reason) } }
            return
        }
        scope.launch { updateState { it.copy(connection = ConnectionState.Connecting, lastError = null) } }
        try {
            require(desktop.endpoints.isNotEmpty()) { "Paired desktop has no endpoint" }
            val endpoint = desktop.endpoints[endpointIndex++ % desktop.endpoints.size]
            val request = okhttp3.Request.Builder().url(endpoint).header("Sec-WebSocket-Protocol", "cere.mobile.v1").build()
            socket = PinnedTls.client(desktop).newWebSocket(request, listener)
        } catch (error: Exception) {
            val reason = error.message?.takeIf(String::isNotBlank) ?: "Pinned desktop identity is invalid"
            terminalBlocked = true; reconnectJob?.cancel(); reconnectJob = null
            scope.launch { updateState { it.copy(connection = ConnectionState.Blocked(reason), lastError = reason) } }
        }
    }
    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) { synchronized(this@CereRepository) {
            if (socket !== webSocket) { webSocket.cancel(); return }; val desktop = _state.value.desktop ?: return
            scope.launch { updateState { it.copy(connection = ConnectionState.Authenticating) } }
            val hello = Hello(desktopId = desktop.desktopId, deviceId = desktop.deviceId, clientNonce = CanonicalJson.base64Url(ByteArray(32).also(java.security.SecureRandom()::nextBytes)), appVersion = "0.1.0")
            activeHello = hello; webSocket.send(WireCodec.encode(hello))
        } }
        override fun onMessage(webSocket: WebSocket, text: String) { if (socket === webSocket) frames.trySend(webSocket to text) }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (socket !== webSocket || bytes.size <= 24) return
            val frame = ByteBuffer.wrap(bytes.toByteArray()).order(ByteOrder.BIG_ENDIAN); val id = UUID(frame.long, frame.long).toString(); val offset = frame.long
            binaryReads.remove(id)?.complete(offset to bytes.substring(24).toByteArray())
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) = fail(webSocket, t.message ?: "Connection failed", t is SSLHandshakeException || t is SSLPeerUnverifiedException)
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (socket === webSocket) {
            if (reason.contains("AUTH_REVOKED") || reason.contains("DEVICE_REVOKED")) scope.launch { revokeLocal(webSocket, reason.ifBlank { "Device access was revoked" }) }
            else fail(webSocket, reason.ifBlank { "Disconnected" }, reason.contains("UNAUTHENTICATED") || reason.contains("INCOMPATIBLE"))
        } }
    }

    private suspend fun handle(webSocket: WebSocket, frame: Frame) { when (frame) {
        is Frame.Challenge -> { val desktop = _state.value.desktop ?: return; val hello = activeHello ?: return; if (frame.value.audience != desktop.desktopId || frame.value.expiresAt <= System.currentTimeMillis()) throw TerminalProtocolException("Authentication challenge is invalid")
            val transcript = SigningTranscripts.authentication(CanonicalJson.sha256(WireCodec.json.encodeToJsonElement(Hello.serializer(), hello)), frame.value, desktop.desktopId, desktop.deviceId, 1)
            webSocket.send(WireCodec.encode(Auth(challengeId = frame.value.challengeId, signature = pairing.signConnection(desktop.connectionAlias, CanonicalJson.encode(transcript).toByteArray())))) }
        is Frame.Accepted -> { val desktop = _state.value.desktop ?: return; if (frame.value.desktopId != desktop.desktopId || frame.value.protocol.major != 1) throw TerminalProtocolException("Desktop protocol is incompatible")
            welcome = frame.value; backoffAttempt = 0; updateState { current -> current.copy(
                connection = ConnectionState.Online(desktop.desktopName, frame.value.operations, frame.value.expiresAt),
                pendingCommands = current.pendingCommands.map { command -> if (command.scopeVersion != null && command.scopeVersion != frame.value.scopeVersion) command.copy(params = JsonObject(emptyMap())) else command },
            ) }
            refreshJob?.cancel(); refreshJob = scope.launch { delay((frame.value.expiresAt - System.currentTimeMillis() - 60_000).coerceAtLeast(1_000)); if (socket === webSocket) webSocket.close(4000, "AUTH_REFRESH") }
            snapshotRequests.trySend(Unit) }
        is Frame.Reply -> pendingResponses.remove(frame.value.id)?.complete(frame.value)
        is Frame.Push -> handleEvent(webSocket, frame.value)
    } }

    private suspend fun reconcile() = syncMutex.withLock {
        if (!_state.value.supports("sync.open")) return; val selected = _state.value.selectedSessionId?.takeIf { id -> _state.value.sessions.any { it.id == id } }
        val syncParams = buildJsonObject { _state.value.cursor?.let { put("resumeCursor", it) }; selected?.let { put("selectedSessionId", it) } }
        val result = try { request("sync.open", syncParams) } catch (error: Throwable) {
            if (selected != null && error.message?.contains("SCOPE_DENIED") == true) request("sync.open", buildJsonObject { _state.value.cursor?.let { put("resumeCursor", it) } }) else throw error
        }
        val snapshot = WireCodec.json.decodeFromJsonElement(SyncSnapshot.serializer(), result)
        val authorized = snapshot.sessionIds?.toSet() ?: snapshot.sessions.mapTo(mutableSetOf(), Session::id)
        val authorizedProjects = snapshot.projects.mapTo(mutableSetOf(), Project::id)
        _state.value.attachments.filter { it.sessionId !in authorized }.forEach { store.deleteBlob(it.id) }
        val persisted = updateState(System.currentTimeMillis()) { current -> val base = if (snapshot.cacheEpoch != null && snapshot.cacheEpoch != current.cacheEpoch) current.copy(messages = emptyList()) else current; val merged = CacheReconciler.merge(base, snapshot, selected); current.copy(sessions = merged.sessions, messages = merged.messages, approvals = merged.approvals, drafts = merged.drafts,
            projects = snapshot.projects, providers = snapshot.providers, permissions = snapshot.permissions, settings = snapshot.settings, cursor = snapshot.cursor,
            selectedSessionId = current.selectedSessionId?.takeIf { id -> merged.sessions.any { it.id == id } }, attachments = current.attachments.filter { it.sessionId in authorized },
            pendingCommands = CacheReconciler.retainAuthorizedCommands(current.pendingCommands, authorized, authorizedProjects, welcome?.scopeVersion),
            cacheEpoch = snapshot.cacheEpoch ?: current.cacheEpoch, messagesBefore = if (selected == null) current.messagesBefore else snapshot.messagesBefore?.let { current.messagesBefore + (selected to it) } ?: (current.messagesBefore - selected), lastError = null) }
        retainApprovalInteractionState(snapshot.approvals)
        snapshot.nextSessionOffset?.let { hydrateSessionPages(it) }
        if (persisted && _state.value.supports("sync.ack")) runCatching { request("sync.ack", buildJsonObject { put("cursor", snapshot.cursor) }) }
    }
    private suspend fun hydrateSessionPages(firstOffset: Int) {
        if (!_state.value.supports("sessions.list")) return
        var offset: Int? = firstOffset; var pages = 0
        while (offset != null && pages++ < 20) {
            val result = request("sessions.list", buildJsonObject { put("offset", offset) }).jsonObject
            val items = result["items"]?.jsonArray.orEmpty().map { WireCodec.json.decodeFromJsonElement(Session.serializer(), it) }
            updateState { current ->
                val existing = current.sessions.associateBy(Session::id)
                val incoming = items.map { CacheReconciler.mergeSession(existing[it.id], it) }.associateBy(Session::id)
                current.copy(sessions = current.sessions.filterNot { it.id in incoming } + incoming.values)
            }
            offset = result["nextOffset"]?.jsonPrimitive?.intOrNull
        }
    }
    private suspend fun handleEvent(webSocket: WebSocket, event: Event) { when (event.name) {
        "snapshot.changed" -> snapshotRequests.trySend(Unit).let { }
        "attachment.progress" -> event.data["uploadId"]?.jsonPrimitive?.contentOrNull?.let { uploadProgress.remove(it)?.complete(event.data) }
        "device.revoked" -> revokeLocal(webSocket, "Device access was revoked")
        "remote.disabled" -> fail(webSocket, "Remote access is disabled", false)
        "message.upsert" -> { val message = WireCodec.json.decodeFromJsonElement(Message.serializer(), event.data)
            val persisted = updateState(System.currentTimeMillis()) { current -> val messages = current.messages.toMutableList(); val index = messages.indexOfFirst { it.id == message.id }; if (index < 0) messages += message else if (revisionAfter(message.revision, messages[index].revision)) messages[index] = message; current.copy(messages = messages, cursor = event.cursor) }
            if (persisted && _state.value.supports("sync.ack")) scope.launch { runCatching { request("sync.ack", buildJsonObject { put("cursor", event.cursor) }) } } }
    } }
    private suspend fun reconcilePendingCommands() { _state.value.pendingCommands.toList().forEach { command -> runCatching { resolveCommand(command) }.onFailure { error -> if (error !is CommandPendingException) updateState { it.copy(lastError = error.message) } } } }

    @Synchronized private fun fail(webSocket: WebSocket, reason: String, terminal: Boolean) {
        if (socket !== webSocket) return; socket = null; welcome = null; refreshJob?.cancel(); refreshJob = null; webSocket.cancel()
        pendingResponses.values.forEach { it.completeExceptionally(IllegalStateException(reason)) }; pendingResponses.clear()
        if (terminal) { terminalBlocked = true; reconnectJob?.cancel(); reconnectJob = null; scope.launch { updateState { it.copy(connection = ConnectionState.Blocked(reason), lastError = reason) } } }
        else scheduleReconnect(reason)
    }
    private suspend fun revokeLocal(webSocket: WebSocket, reason: String) {
        if (socket !== webSocket) return
        val desktop = _state.value.desktop; socket = null; welcome = null; shouldMonitor = false; terminalBlocked = true; refreshJob?.cancel(); reconnectJob?.cancel(); webSocket.cancel()
        pendingResponses.values.forEach { it.completeExceptionally(IllegalStateException(reason)) }; pendingResponses.clear(); uploadProgress.values.forEach { it.completeExceptionally(IllegalStateException(reason)) }; uploadProgress.clear()
        if (desktop != null) pairing.delete(desktop); store.clear(); stateMutex.withLock { _state.value = MobileState(restoreReady = true, connection = ConnectionState.Unpaired, lastError = reason) }
        _questionDrafts.value = emptyMap(); _approvalMutations.value = emptySet()
    }
    @Synchronized private fun scheduleReconnect(reason: String) {
        scope.launch { updateState { current -> current.copy(connection = current.desktop?.let { ConnectionState.Offline(reason, lastVerified) } ?: ConnectionState.Unpaired, lastError = reason) } }
        if (!shouldMonitor || terminalBlocked || reconnectJob?.isActive == true) return
        val ceiling = min(60_000L, 1_000L * (1L shl min(backoffAttempt, 6))); backoffAttempt++; val wait = Random.nextLong(ceiling + 1)
        reconnectJob = scope.launch { delay(wait); reconnectJob = null; if (shouldMonitor && socket == null && !terminalBlocked) connect() }
    }

    private suspend fun restore(): Boolean = restoreMutex.withLock restore@ {
        if (!restoreBlocked) return@restore true
        val cache = try { store.read() } catch (error: PrivateCacheUnavailableException) {
            restoreBlocked = true
            stateMutex.withLock { _state.value = _state.value.copy(connection = ConnectionState.Blocked(error.message ?: PRIVATE_CACHE_ERROR), lastError = error.message ?: PRIVATE_CACHE_ERROR) }
            return@restore false
        }
        stateMutex.withLock {
            lastVerified = cache.lastVerifiedAt
            _state.value = MobileState(restoreReady = true, desktop = cache.desktop,
            connection = cache.desktop?.let { ConnectionState.Offline("Not connected", cache.lastVerifiedAt) } ?: ConnectionState.Unpaired,
            sessions = cache.sessions, messages = cache.messages, approvals = cache.approvals, projects = cache.projects, providers = cache.providers,
            permissions = cache.permissions, settings = cache.settings, cursor = cache.cursor, drafts = cache.drafts.associateBy(LocalDraft::sessionId), pendingCommands = cache.pendingCommands, selectedSessionId = cache.selectedSessionId, attachments = cache.attachments, cacheEpoch = cache.cacheEpoch, monitoring = shouldMonitor)
            restoreBlocked = false
        }
        true
    }
    private suspend fun updateState(verifiedAt: Long? = lastVerified, transform: (MobileState) -> MobileState): Boolean = stateMutex.withLock { if (restoreBlocked) return@withLock false; lastVerified = verifiedAt; val transformed = transform(_state.value); val cutoff = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
        val expired = transformed.attachments.filter { it.createdAt < cutoff }; expired.forEach { store.deleteBlob(it.id) }
        val attachments = transformed.attachments.filter { it.createdAt >= cutoff }
        val protected = transformed.drafts.filterValues { it.dirty || it.conflict }.keys + attachments.map { it.sessionId } + transformed.pendingCommands.mapNotNull(PendingCommand::sessionId)
        val keepIds = (protected + transformed.sessions.sortedByDescending { it.updated }.take(200).map { it.id }).toSet()
        val sessions = transformed.sessions.filter { it.id in keepIds }.map { if (it.id != transformed.selectedSessionId && transformed.drafts[it.id]?.dirty != true) it.copy(draft = "", draftIncluded = false) else it }
        val fixedBytes = attachments.sumOf { it.size } + transformed.drafts.filterKeys { it in keepIds }.values.sumOf { it.text.toByteArray().size }; var remaining = (20 * 1024 * 1024 - fixedBytes - 512 * 1024).coerceAtLeast(0)
        val retainedMessages = ArrayList<Message>(); transformed.messages.asReversed().forEach { message -> val bytes = message.text.toByteArray().size + 256; if (message.sessionId in keepIds && (message.time == 0L || message.time >= cutoff) && bytes <= remaining) { retainedMessages += message; remaining -= bytes } }
        val next = transformed.copy(sessions = sessions, messages = retainedMessages.asReversed(), drafts = transformed.drafts.filterKeys { it in keepIds }, attachments = attachments, lastError = if (expired.isNotEmpty()) "Expired local image drafts were removed" else transformed.lastError); _state.value = next
        val ready = if (next.lastError == PRIVATE_CACHE_ERROR) next.copy(lastError = null) else next; _state.value = ready
        try { store.write(cached(ready, verifiedAt)); cacheDirty = false; true } catch (cancelled: CancellationException) { throw cancelled } catch (_: Throwable) { cacheDirty = true; _state.value = ready.copy(lastError = PRIVATE_CACHE_ERROR); false } }
    private suspend fun flushPrivateCache() {
        val persisted = stateMutex.withLock { if (restoreBlocked) return@withLock false; val ready = if (_state.value.lastError == PRIVATE_CACHE_ERROR) _state.value.copy(lastError = null) else _state.value; try { store.write(cached(ready, lastVerified)); _state.value = ready; cacheDirty = false; true } catch (cancelled: CancellationException) { throw cancelled } catch (_: Throwable) { cacheDirty = true; false } }
        if (persisted) _state.value.cursor?.let { cursor -> if (_state.value.supports("sync.ack")) runCatching { request("sync.ack", buildJsonObject { put("cursor", cursor) }) } }
    }
    private fun cached(state: MobileState, verifiedAt: Long?) = CachedState(state.desktop, state.cursor, state.sessions, state.messages, state.approvals, state.projects, state.providers, state.permissions, state.settings, verifiedAt, state.drafts.values.toList(), state.pendingCommands, state.selectedSessionId, state.attachments, state.cacheEpoch)
    private suspend fun removePending(commandId: String) = updateState { it.copy(pendingCommands = it.pendingCommands.filterNot { command -> command.commandId == commandId }) }
    private suspend fun markPending(commandId: String, status: String) = updateState { current -> current.copy(pendingCommands = current.pendingCommands.map { if (it.commandId == commandId) it.copy(status = status) else it }) }
    private fun pendingCommand(commandId: String, method: String, params: JsonObject, boundProjectId: String? = null): PendingCommand {
        val directSession = listOf("sessionId", "sourceSessionId").firstNotNullOfOrNull { (params[it] as? JsonPrimitive)?.contentOrNull }
        val approvalSession = (params["approvalId"] as? JsonPrimitive)?.contentOrNull?.let { id -> _state.value.approvals.firstOrNull { it.id == id }?.sessionId }
        val attachmentSession = (params["attachmentId"] as? JsonPrimitive)?.contentOrNull?.let { id -> _state.value.attachments.firstOrNull { it.remoteAttachmentId == id }?.sessionId }
        val sessionId = directSession ?: approvalSession ?: attachmentSession
        val directProject = listOf("projectId", "confirmProjectId").firstNotNullOfOrNull { (params[it] as? JsonPrimitive)?.contentOrNull }
        val projectId = boundProjectId ?: directProject ?: sessionId?.let { id -> _state.value.sessions.firstOrNull { it.id == id }?.projectId }
        return PendingCommand(commandId, method, params, System.currentTimeMillis(), paramsDigest = CanonicalJson.sha256(params), scopeVersion = welcome?.scopeVersion, sessionId = sessionId, projectId = projectId)
    }
    private fun revisionAfter(incoming: String, existing: String): Boolean = incoming.toBigIntegerOrNull()?.let { next -> existing.toBigIntegerOrNull()?.let { next > it } } ?: incoming != existing
    private companion object { const val PRIVATE_CACHE_ERROR = "Private cache is unavailable. Unlock the phone and retry." }
}
