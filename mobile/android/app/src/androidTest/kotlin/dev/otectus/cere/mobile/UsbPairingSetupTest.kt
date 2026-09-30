package dev.otectus.cere.mobile

import android.app.AlertDialog
import android.content.Intent
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.test.platform.app.InstrumentationRegistry
import dev.otectus.cere.mobile.data.CompletedPairing
import dev.otectus.cere.mobile.data.ConnectionState
import dev.otectus.cere.mobile.data.PendingPairing
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Explicit USB setup only. Uses the real Keystore authentication and offline SAS review. */
class UsbPairingSetupTest {
    @Test fun verifyExistingPairing() {
        val expected = InstrumentationRegistry.getArguments().getString("cereExpectedDesktopId")
        assumeTrue("Run explicitly against the owner's paired desktop", expected != null)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
        val repository = (activity.application as CereApp).repository
        runBlocking { withTimeout(10_000) { repository.state.first { it.desktop != null } } }
        check(repository.state.value.desktop?.desktopId == expected)
        val desktop = checkNotNull(repository.state.value.desktop)
        val keys = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        check(keys.containsAlias(desktop.connectionAlias) && keys.containsAlias(desktop.actionAlias)) {
            "Cold launch lost the pairing keys"
        }
        val keyFactory = java.security.KeyFactory.getInstance("EC", "AndroidKeyStore")
        fun requiresAuthentication(alias: String): Boolean = keyFactory.getKeySpec(
            keys.getKey(alias, null), android.security.keystore.KeyInfo::class.java,
        ).isUserAuthenticationRequired
        check(!requiresAuthentication(desktop.connectionAlias)) { "Ordinary sends must not prompt for authentication" }
        check(requiresAuthentication(desktop.actionAlias)) { "Sensitive actions must retain authentication" }
        val testTranscript = "Cere USB connection-key signing check".toByteArray()
        val signature = repository.pairingManager().connectionSignature(desktop.connectionAlias).run {
            update(testTranscript); sign()
        }
        check(java.security.Signature.getInstance("SHA256withECDSA").run {
            initVerify(keys.getCertificate(desktop.connectionAlias).publicKey); update(testTranscript); verify(signature)
        }) { "Connection key signing failed" }
        instrumentation.runOnMainSync {
            ContextCompat.startForegroundService(activity, Intent(activity, MonitoringService::class.java))
        }
        val online = runBlocking { withTimeoutOrNull(30_000) {
            repository.state.first { it.connection is ConnectionState.Online && it.projects.isNotEmpty() }
        } }
        check(online != null) { "Connection failed: ${repository.state.value.connection}; ${repository.state.value.lastError}" }
        println("USB_VERIFY: connection key signed without a prompt; sensitive key requires authentication; LAN online; sessions=${online.sessions.size}; projects=${online.projects.size}")
    }

    @Test fun pairFromExplicitUsbOffer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val offer = InstrumentationRegistry.getArguments().getString("cerePairingOffer")
        assumeTrue("Run explicitly with a fresh public Cere pairing offer", offer != null)
        require(offer!!.startsWith("cere-pair://v1/") && offer.length <= 2000)
        val context = instrumentation.targetContext
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
        instrumentation.waitForIdleSync()
        // Allow the initial pairing screen's orphan-key cleanup to finish before creating keys.
        Thread.sleep(1_000)
        instrumentation.waitForIdleSync()
        val repository = (activity.application as CereApp).repository
        val damaged = repository.state.value.desktop
        if (damaged != null) {
            check(InstrumentationRegistry.getArguments().getString("cereReplaceMissingKeys") == damaged.deviceId) {
                "Replacing an existing pairing requires its explicit device ID"
            }
            val keys = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            check(!keys.containsAlias(damaged.connectionAlias) && !keys.containsAlias(damaged.actionAlias)) {
                "Setup must preserve a pairing with intact private keys"
            }
            check(repository.state.value.sessions.isEmpty() && repository.state.value.pendingCommands.isEmpty()) {
                "Repair must preserve any existing session cache or pending commands"
            }
            runBlocking { repository.forget() }
            Thread.sleep(1_000)
            instrumentation.waitForIdleSync()
        }
        check(repository.state.value.desktop == null) { "A desktop is already paired; setup must preserve it" }
        val manager = repository.pairingManager()
        val responseFile = File(context.filesDir, "usb-pairing-response.json")
        val confirmedFile = File(context.filesDir, "usb-pairing-desktop-confirmed")
        responseFile.delete(); confirmedFile.delete()
        val result = AtomicReference<CompletedPairing>()
        val failure = AtomicReference<Throwable>()
        val authenticated = CountDownLatch(1)
        var pending: PendingPairing? = null
        var dialog: AlertDialog? = null
        try {
            instrumentation.runOnMainSync {
                try {
                    val prepared = manager.prepare(manager.parseAndVerify(offer), Build.MODEL.take(48))
                    pending = prepared
                    val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(auth: BiometricPrompt.AuthenticationResult) {
                            try {
                                val signature = checkNotNull(auth.cryptoObject?.signature)
                                signature.update(prepared.transcript)
                                val completed = manager.complete(prepared, signature.sign())
                                result.set(completed)
                                responseFile.writeText(buildJsonObject {
                                    put("response", completed.responseUri); put("sas", completed.sas)
                                }.toString())
                                dialog = AlertDialog.Builder(activity).setTitle("Compare with Cere Desktop")
                                    .setMessage(completed.sas + "\n\nWaiting for confirmation on the connected PC…")
                                    .setCancelable(false).show()
                            } catch (error: Throwable) { failure.set(error) }
                            finally { authenticated.countDown() }
                        }
                        override fun onAuthenticationError(code: Int, message: CharSequence) {
                            failure.set(IllegalStateException("Phone authentication: $message ($code)"))
                            authenticated.countDown()
                        }
                    })
                    prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Create Cere action key")
                        .setSubtitle("This key will protect approvals and sensitive changes")
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                        .build(), BiometricPrompt.CryptoObject(prepared.actionSignature))
                } catch (error: Throwable) { failure.set(error); authenticated.countDown() }
            }
            check(authenticated.await(180, TimeUnit.SECONDS)) { "Waiting for owner authentication timed out" }
            failure.get()?.let { throw it }
            val completed = checkNotNull(result.get())
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
            while (!confirmedFile.exists() && System.nanoTime() < deadline) Thread.sleep(250)
            check(confirmedFile.exists()) { "Desktop SAS confirmation timed out" }
            runBlocking { repository.completePairing(completed) }
            instrumentation.runOnMainSync {
                dialog?.dismiss()
                ContextCompat.startForegroundService(activity, Intent(activity, MonitoringService::class.java))
            }
            runBlocking { withTimeout(45_000) { repository.state.first { it.connection is ConnectionState.Online && it.projects.isNotEmpty() } } }
            println("USB_SETUP: authenticated, desktop confirmed, paired cache saved, LAN online")
        } finally {
            if (repository.state.value.desktop == null) pending?.let(manager::cancel)
            instrumentation.runOnMainSync { dialog?.dismiss() }
            responseFile.delete(); confirmedFile.delete()
        }
    }
}
