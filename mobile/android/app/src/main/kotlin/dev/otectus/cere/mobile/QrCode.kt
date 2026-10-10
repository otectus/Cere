package dev.otectus.cere.mobile

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun PairingQrCode(text: String, modifier: Modifier = Modifier) {
    // Encoded off the main thread; the space is held while the code is drawn.
    val image by produceState<ImageBitmap?>(null, text) {
        value = withContext(Dispatchers.Default) {
            val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 640, 640, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 2))
            val pixels = IntArray(matrix.width * matrix.height) { index -> if (matrix[index % matrix.width, index / matrix.width]) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
            Bitmap.createBitmap(pixels, matrix.width, matrix.height, Bitmap.Config.RGB_565).asImageBitmap()
        }
    }
    val frame = modifier.background(Color.White).padding(8.dp).size(260.dp)
    image?.let { Image(it, "Signed pairing response QR code", frame) } ?: Box(frame)
}
