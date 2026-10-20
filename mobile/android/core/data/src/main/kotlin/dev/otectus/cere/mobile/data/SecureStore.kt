package dev.otectus.cere.mobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import dev.otectus.cere.mobile.protocol.*
import java.security.KeyStore
import java.io.File
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

@Serializable
data class CachedState(
    val desktop: PairedDesktop? = null,
    val stagedPairing: CompletedPairing? = null,
    val cursor: String? = null,
    val sessions: List<Session> = emptyList(),
    val messages: List<Message> = emptyList(),
    val approvals: List<Approval> = emptyList(),
    val projects: List<Project> = emptyList(),
    val providers: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.JsonObject(emptyMap()),
    val permissions: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.JsonObject(emptyMap()),
    val settings: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.JsonObject(emptyMap()),
    val lastVerifiedAt: Long? = null,
    val drafts: List<LocalDraft> = emptyList(),
    val pendingCommands: List<PendingCommand> = emptyList(),
    val selectedSessionId: String? = null,
    val attachments: List<LocalAttachment> = emptyList(),
    val cacheEpoch: String? = null,
    val scrollPositions: Map<String, SessionScrollPosition> = emptyMap(),
    val erasures: List<ErasureReceipt> = emptyList(),
)

/**
 * W09: a forget or clear the phone asked for. Suppression (gone from recall) is immediate; physical
 * removal finishes later. The receipt stays on the phone so its state can be checked after reconnecting.
 */
@Serializable
data class ErasureReceipt(val jobId: String, val sessionId: String, val label: String, val requestedAt: Long, val purgeComplete: Boolean = false, val state: String? = null, val checkedAt: Long? = null)

/**
 * Why the private cache cannot be read. [Locked] is retried after unlock; [Damaged] and [KeyLost]
 * cannot recover by waiting: the encrypted state is unreadable and this phone must pair again.
 */
enum class PrivateCacheFailure(val message: String, val repair: Boolean) {
    Locked("Private cache is unavailable. Unlock the phone and retry.", false),
    Damaged("This phone's private Cere data is damaged and cannot be read. Remove this pairing in Settings and pair again; unsent drafts on this phone cannot be recovered.", true),
    KeyLost("Android removed the key that protects Cere's private data on this phone, so it cannot be read. Remove this pairing in Settings and pair again.", true);

    companion object {
        /** [keyPresent]: the cache's key alias still existed when the read started. */
        fun classify(error: Throwable, keyPresent: Boolean): PrivateCacheFailure {
            val chain = generateSequence(error) { it.cause }.take(8).toList()
            return when {
                !keyPresent -> KeyLost
                chain.any { it is android.security.keystore.KeyPermanentlyInvalidatedException || it is java.security.UnrecoverableKeyException } -> KeyLost
                chain.any { it is javax.crypto.AEADBadTagException || it is kotlinx.serialization.SerializationException || it is IllegalArgumentException } -> Damaged
                else -> Locked
            }
        }
    }
}
class PrivateCacheUnavailableException(cause: Throwable, val failure: PrivateCacheFailure = PrivateCacheFailure.Locked) : IllegalStateException(failure.message, cause)

/** Private, credential-protected, AES-GCM sealed state. No plaintext cache or draft touches disk. */
class SecureStore(context: Context) {
    private val app = context.applicationContext
    // Resolved on first use, which is always on the IO dispatcher, not while the app object is created.
    private val file by lazy { AtomicFile(app.filesDir.resolve("cere-private-state.bin")) }
    private val mutex = Mutex()
    private val alias = "cere.private.cache.v1"

    suspend fun read(): CachedState = mutex.withLock { withContext(Dispatchers.IO) {
        if (!file.baseFile.exists()) return@withContext CachedState()
        // A cache whose key alias is gone was sealed by a key Android has since removed.
        val keyPresent = runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias(alias) }.getOrDefault(true)
        try {
            if (!keyPresent) throw IllegalStateException("The private cache key is missing")
            val bytes = file.readFully()
            require(bytes.size > 13 && bytes[0].toInt() == 1)
            val iv = bytes.copyOfRange(1, 13)
            val clear = Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)); doFinal(bytes.copyOfRange(13, bytes.size))
            }
            WireCodec.json.decodeFromString(CachedState.serializer(), clear.decodeToString())
        } catch (error: Throwable) {
            throw PrivateCacheUnavailableException(error, PrivateCacheFailure.classify(error, keyPresent))
        }
    } }

    suspend fun write(value: CachedState) = mutex.withLock { withContext(Dispatchers.IO) {
        val clear = WireCodec.json.encodeToString(CachedState.serializer(), value).toByteArray()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(clear)
        val output = file.startWrite()
        try { output.write(encrypted); file.finishWrite(output) } catch (error: Throwable) { file.failWrite(output); throw error }
    } }

    /** Written whole or not at all: a crash mid-write leaves no partial image behind. */
    suspend fun writeBlob(id: String, clear: ByteArray) = mutex.withLock { withContext(Dispatchers.IO) {
        require(id.matches(Regex("[0-9a-f-]{36}")))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val target = AtomicFile(blob(id)); val output = target.startWrite()
        try { output.write(byteArrayOf(1) + cipher.iv + cipher.doFinal(clear)); target.finishWrite(output) } catch (error: Throwable) { target.failWrite(output); throw error }
    } }
    /** Every stored image's ID, to find images no saved draft refers to any more. */
    suspend fun blobIds(): Set<String> = mutex.withLock { withContext(Dispatchers.IO) {
        app.filesDir.resolve("cere-private-media").listFiles().orEmpty().mapNotNull { file -> file.name.removeSuffix(".bin").takeIf { file.name.endsWith(".bin") && it.matches(Regex("[0-9a-f-]{36}")) } }.toSet()
    } }
    suspend fun readBlob(id: String): ByteArray = mutex.withLock { withContext(Dispatchers.IO) {
        val bytes = blob(id).readBytes(); require(bytes.size > 13 && bytes[0].toInt() == 1)
        Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13))); doFinal(bytes.copyOfRange(13, bytes.size)) }
    } }
    suspend fun deleteBlob(id: String) = mutex.withLock { withContext(Dispatchers.IO) { AtomicFile(blob(id)).delete() } }

    suspend fun clear() = mutex.withLock { withContext(Dispatchers.IO) {
        file.delete(); app.filesDir.resolve("cere-private-media").deleteRecursively()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    } }

    private fun blob(id: String): File = app.filesDir.resolve("cere-private-media").apply { mkdirs() }.resolve("$id.bin")

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
            generateKey()
        }
    }
}
