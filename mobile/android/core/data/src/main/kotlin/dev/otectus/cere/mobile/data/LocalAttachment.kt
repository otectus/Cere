package dev.otectus.cere.mobile.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

@Serializable
data class LocalAttachment(
    val id: String,
    val sessionId: String,
    val displayName: String,
    val mime: String,
    val size: Int,
    val sha256: String,
    val width: Int,
    val height: Int,
    val transformed: Boolean,
    val remoteAttachmentId: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val uploadId: String? = null,
    val committedOffset: Int = 0,
    val remoteStatus: String = "local",
    val reviewedAt: Long? = null,
    /** When the desktop discards this upload: 15 minutes while uploading, one hour once ready. */
    val remoteExpiresAt: Long? = null,
) {
    /** Uploaded and still held by the desktop, so it can be attached to a send. */
    fun readyAt(now: Long) = remoteAttachmentId != null && remoteStatus == "ready" && (remoteExpiresAt == null || remoteExpiresAt > now)

    /** The desktop no longer has this upload; keep the private copy so it can be uploaded again. */
    fun withoutRemote() = copy(remoteAttachmentId = null, uploadId = null, committedOffset = 0, remoteStatus = "local", remoteExpiresAt = null)
}

internal suspend fun decodePrivateImage(context: Context, sessionId: String, uri: Uri): Pair<LocalAttachment, ByteArray> = withContext(Dispatchers.IO) {
    val source = ImageDecoder.createSource(context.contentResolver, uri)
    val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val max = maxOf(info.size.width, info.size.height)
        if (max > 4096) decoder.setTargetSampleSize((max + 4095) / 4096)
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        decoder.isMutableRequired = false
    }
    encodePrivateBitmap(sessionId, bitmap, true)
}

internal suspend fun encodePrivateBitmap(sessionId: String, bitmap: Bitmap, initiallyTransformed: Boolean = true): Pair<LocalAttachment, ByteArray> = withContext(Dispatchers.IO) {
    require(bitmap.width.toLong() * bitmap.height <= 16_000_000L) { "Image dimensions are too large" }
    fun encode(quality: Int): ByteArray = ByteArrayOutputStream().use { output ->
        @Suppress("DEPRECATION")
        bitmap.compress(if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.JPEG, quality, output)
        output.toByteArray()
    }
    var sampled = initiallyTransformed; var quality = 90; var bytes = encode(quality)
    while (bytes.size > 10 * 1024 * 1024 && quality > 45) { quality -= 10; bytes = encode(quality); sampled = true }
    require(bytes.isNotEmpty() && bytes.size <= 10 * 1024 * 1024) { "Image cannot be reduced below 10 MiB" }
    val mime = if (Build.VERSION.SDK_INT >= 30) "image/webp" else "image/jpeg"
    val hash = android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
    val id = UUID.randomUUID().toString()
    LocalAttachment(id, sessionId, "Image ${id.take(6)}", mime, bytes.size, hash, bitmap.width, bitmap.height, sampled || quality < 90) to bytes
}
