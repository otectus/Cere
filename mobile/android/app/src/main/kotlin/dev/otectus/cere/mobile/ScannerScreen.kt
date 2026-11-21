package dev.otectus.cere.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.ui.res.painterResource
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun ScannerScreen(onResult: (String) -> Unit, onBack: () -> Unit, onEnterOffer: () -> Unit) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var cameraError by rememberSaveable { mutableStateOf<String?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) request.launch(Manifest.permission.CAMERA) }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (granted && cameraError == null) CameraPreview(onResult) { cameraError = it }
        if (granted && cameraError == null) {
            Box(
                Modifier.align(Alignment.Center).size(260.dp).border(3.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(20.dp))
                    .semantics { contentDescription = "QR scanning frame" },
            )
            Surface(
                color = Color.Black.copy(alpha = .78f),
                contentColor = Color.White,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
            ) {
                Column(Modifier.widthIn(max = 480.dp).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Point at the Cere pairing QR", fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                    Text("Only signed Cere pairing offers are accepted.", style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = .75f), textAlign = TextAlign.Center)
                }
            }
        } else {
            Surface(
                color = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.onSurface,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.align(Alignment.Center).padding(16.dp).widthIn(max = 520.dp),
            ) {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                        Icon(painterResource(R.drawable.ic_scan), null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(16.dp).size(32.dp))
                    }
                    Text(if (cameraError == null) "Camera access needed" else "Camera unavailable", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                    Text(cameraError ?: "Camera access is used only to scan the offline pairing offer. Cere does not save the preview.", color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                    if (cameraError == null) Button({ request.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Allow camera") }
                    else Button({ cameraError = null }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Try camera again") }
                    OutlinedButton({ context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Open app settings") }
                    TextButton(onEnterOffer, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Enter offer instead") }
                }
            }
        }
        IconButton(onBack, Modifier.padding(12.dp).align(Alignment.TopStart).size(48.dp)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White) }
    }
}

@Composable
private fun CameraPreview(onResult: (String) -> Unit, onError: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val view = remember(context) { PreviewView(context) }
    val resultCallback by rememberUpdatedState(onResult)
    val errorCallback by rememberUpdatedState(onError)
    AndroidView(factory = { view }, modifier = Modifier.fillMaxSize())
    DisposableEffect(view, owner) {
        val executor = Executors.newSingleThreadExecutor()
        val reader = MultiFormatReader().apply {
            setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
        }
        val preview = Preview.Builder().build().apply { surfaceProvider = view.surfaceProvider }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        val delivered = AtomicBoolean(false)
        var disposed = false
        var boundProvider: ProcessCameraProvider? = null
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (!disposed) runCatching {
                val provider = future.get()
                analysis.setAnalyzer(executor) { image ->
                    try {
                        val plane = image.planes[0]
                        val bytes = ByteArray(plane.buffer.remaining()).also(plane.buffer::get)
                        val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                        val text = reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
                        if (text.startsWith("cere-pair://v1/") && delivered.compareAndSet(false, true))
                            view.post { if (!disposed) resultCallback(text) }
                    } catch (_: ReaderException) {
                        // A frame without a readable offer is expected.
                    } finally {
                        reader.reset()
                        image.close()
                    }
                }
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                boundProvider = provider
            }.onFailure { errorCallback(it.message ?: "Cere could not start this camera.") }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            disposed = true
            analysis.clearAnalyzer()
            boundProvider?.unbind(preview, analysis)
            executor.shutdown()
        }
    }
}
