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
)

class PrivateCacheUnavailableException(cause: Throwable) : IllegalStateException("Private cache is unavailable. Unlock the phone and retry.", cause)

/** Private, credential-protected, AES-GCM sealed state. No plaintext cache or draft touches disk. */
class SecureStore(context: Context) {
    private val app = context.applicationContext
    private val file = AtomicFile(app.filesDir.resolve("cere-private-state.bin"))
    private val mutex = Mutex()
    private val alias = "cere.private.cache.v1"

    suspend fun read(): CachedState = mutex.withLock { withContext(Dispatchers.IO) {
        if (!file.baseFile.exists()) return@withContext CachedState()
        try {
            val bytes = file.readFully()
            require(bytes.size > 13 && bytes[0].toInt() == 1)
            val iv = bytes.copyOfRange(1, 13)
            val clear = Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)); doFinal(bytes.copyOfRange(13, bytes.size))
            }
            WireCodec.json.decodeFromString(CachedState.serializer(), clear.decodeToString())
        } catch (error: Throwable) {
            throw PrivateCacheUnavailableException(error)
        }
    } }

    suspend fun write(value: CachedState) = mutex.withLock { withContext(Dispatchers.IO) {
        val clear = WireCodec.json.encodeToString(CachedState.serializer(), value).toByteArray()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(clear)
        val output = file.startWrite()
        try { output.write(encrypted); file.finishWrite(output) } catch (error: Throwable) { file.failWrite(output); throw error }
    } }

    suspend fun writeBlob(id: String, clear: ByteArray) = mutex.withLock { withContext(Dispatchers.IO) {
        require(id.matches(Regex("[0-9a-f-]{36}")))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        blob(id).writeBytes(byteArrayOf(1) + cipher.iv + cipher.doFinal(clear))
    } }
    suspend fun readBlob(id: String): ByteArray = mutex.withLock { withContext(Dispatchers.IO) {
        val bytes = blob(id).readBytes(); require(bytes.size > 13 && bytes[0].toInt() == 1)
        Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13))); doFinal(bytes.copyOfRange(13, bytes.size)) }
    } }
    suspend fun deleteBlob(id: String) = mutex.withLock { withContext(Dispatchers.IO) { blob(id).delete() } }

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
