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
import dev.otectus.cere.mobile.protocol.ActionAuthentication
import dev.otectus.cere.mobile.protocol.WireCodec
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
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
        requireCellularAndVpnIfRequested(context)
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
        check(requiresAuthentication(desktop.actionAlias) == (desktop.actionAuthentication == ActionAuthentication.BIOMETRIC)) {
            "Action key authentication does not match the paired policy"
        }
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
        if (desktop.actionAuthentication == ActionAuthentication.TRUSTED_DEVICE) {
            val method = InstrumentationRegistry.getArguments().getString("cereSyntheticSensitiveMethod")
            val rawParams = InstrumentationRegistry.getArguments().getString("cereSyntheticSensitiveParams")
            if (method != null && rawParams != null) runBlocking {
                val action = repository.prepareAction(method, WireCodec.json.parseToJsonElement(rawParams).jsonObject)
                check(!action.requiresUserAuthentication) { "Trusted action unexpectedly requested phone authentication" }
                repository.completeAction(action, repository.signWithoutAuthentication(action))
            }
        }
        println("USB_VERIFY: connection and ${desktop.actionAuthentication} action keys signed under policy; VPN/LAN online; sessions=${online.sessions.size}; projects=${online.projects.size}")
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
        val existing = repository.state.value.desktop
        val cachedSessionIds = repository.state.value.sessions.map { it.id }.toSet()
        val cachedDrafts = repository.state.value.drafts
        val cachedAttachmentIds = repository.state.value.attachments.map { it.id }.toSet()
        val expectedDesktopId = InstrumentationRegistry.getArguments().getString("cereExpectedDesktopId")
        if (existing != null) {
            check(expectedDesktopId == existing.desktopId) { "Replacement requires the explicit current desktop ID" }
            check(repository.replacementBlocker() == null) { repository.replacementBlocker()!! }
        }
        val manager = repository.pairingManager()
        val responseFile = File(context.filesDir, "usb-pairing-response.json")
        val confirmedFile = File(context.filesDir, "usb-pairing-desktop-confirmed")
        responseFile.delete(); confirmedFile.delete()
        val result = AtomicReference<CompletedPairing>()
        val failure = AtomicReference<Throwable>()
        val authenticated = CountDownLatch(1)
        var pending: PendingPairing? = null
        var committed = false
        var dialog: AlertDialog? = null
        fun publish(completed: CompletedPairing) {
            runBlocking { repository.stagePairing(completed) }
            result.set(completed)
            responseFile.writeText(buildJsonObject {
                put("response", completed.responseUri); put("sas", completed.sas)
                put("deviceId", completed.desktop.deviceId)
                completed.replacesDeviceId?.let { put("replacesDeviceId", it) }
                put("actionAuthentication", completed.desktop.actionAuthentication.name.lowercase().replace('_', '-'))
            }.toString())
            dialog = AlertDialog.Builder(activity).setTitle("Compare with Cere Desktop")
                .setMessage(completed.sas + "\n\nWaiting for confirmation on the connected PC…")
                .setCancelable(false).show()
        }
        try {
            instrumentation.runOnMainSync {
                try {
                    val prepared = manager.prepare(manager.parseAndVerify(offer), Build.MODEL.take(48), existing)
                    pending = prepared
                    if (prepared.actionAuthentication == ActionAuthentication.TRUSTED_DEVICE) {
                        val completed = manager.completeWithoutAuthentication(prepared)
                        publish(completed)
                        authenticated.countDown()
                        return@runOnMainSync
                    }
                    val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(auth: BiometricPrompt.AuthenticationResult) {
                            try {
                                val signature = checkNotNull(auth.cryptoObject?.signature)
                                signature.update(prepared.transcript)
                                val completed = manager.complete(prepared, signature.sign())
                                publish(completed)
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
            committed = true
            if (existing != null) {
                check(repository.state.value.sessions.map { it.id }.toSet() == cachedSessionIds) { "Replacement discarded cached sessions" }
                check(repository.state.value.drafts == cachedDrafts) { "Replacement discarded or changed drafts" }
                check(repository.state.value.attachments.map { it.id }.toSet() == cachedAttachmentIds) { "Replacement discarded local images" }
            }
            instrumentation.runOnMainSync {
                dialog?.dismiss()
                ContextCompat.startForegroundService(activity, Intent(activity, MonitoringService::class.java))
            }
            runBlocking { withTimeout(45_000) { repository.state.first { it.connection is ConnectionState.Online && it.projects.isNotEmpty() } } }
            println("USB_SETUP: ${completed.desktop.actionAuthentication} proof created, desktop confirmed, encrypted cache preserved, VPN/LAN online")
        } finally {
            // Once the public response is durably staged its desktop outcome may
            // be ambiguous. Preserve it and both new aliases for explicit resume.
            if (!committed && repository.state.value.stagedPairing == null) pending?.let(manager::cancel)
            instrumentation.runOnMainSync { dialog?.dismiss() }
            if (committed) { responseFile.delete(); confirmedFile.delete() }
        }
    }

    /** Resume after force-stop/process death once a replacement response was durably staged. */
    @Test fun resumeStagedPairing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val expectedDesktopId = InstrumentationRegistry.getArguments().getString("cereExpectedDesktopId")
        assumeTrue("Run explicitly with the current desktop ID", expectedDesktopId != null)
        val context = instrumentation.targetContext
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
        val repository = (activity.application as CereApp).repository
        val expectedDeviceId = InstrumentationRegistry.getArguments().getString("cereExpectedDeviceId")
        val restored = runBlocking { withTimeout(10_000) {
            repository.state.first { it.restoreReady }
        } }
        val oldDesktop = checkNotNull(restored.desktop)
        check(oldDesktop.desktopId == expectedDesktopId)
        val completed = restored.stagedPairing
        if (completed == null) {
            check(expectedDeviceId != null && oldDesktop.deviceId == expectedDeviceId) {
                "No staged response exists and the committed device does not match cereExpectedDeviceId"
            }
            val keys = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            check(keys.containsAlias(oldDesktop.connectionAlias) && keys.containsAlias(oldDesktop.actionAlias)) {
                "Committed replacement keys are missing"
            }
            instrumentation.runOnMainSync { ContextCompat.startForegroundService(activity, Intent(activity, MonitoringService::class.java)) }
            runBlocking { withTimeout(45_000) { repository.state.first { it.connection is ConnectionState.Online && it.projects.isNotEmpty() } } }
            println("USB_RESUME: ambiguous confirmation had already committed expected device; keys survived and connection reached Online")
            return
        }
        if (expectedDeviceId != null) check(completed.desktop.deviceId == expectedDeviceId) { "Staged replacement device does not match cereExpectedDeviceId" }
        check(completed.replacesDeviceId == oldDesktop.deviceId)
        val keys = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        check(keys.containsAlias(oldDesktop.connectionAlias) && keys.containsAlias(oldDesktop.actionAlias))
        check(keys.containsAlias(completed.desktop.connectionAlias) && keys.containsAlias(completed.desktop.actionAlias)) {
            "Process restart lost staged replacement aliases"
        }
        val responseFile = File(context.filesDir, "usb-pairing-response.json")
        val confirmedFile = File(context.filesDir, "usb-pairing-desktop-confirmed")
        responseFile.writeText(buildJsonObject {
            put("response", completed.responseUri); put("sas", completed.sas)
            put("deviceId", completed.desktop.deviceId)
            put("replacesDeviceId", completed.replacesDeviceId)
            put("actionAuthentication", completed.desktop.actionAuthentication.name.lowercase().replace('_', '-'))
        }.toString())
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
        while (!confirmedFile.exists() && System.nanoTime() < deadline) Thread.sleep(250)
        check(confirmedFile.exists()) {
            "Desktop confirmation timed out; staged response and aliases were preserved for another resume"
        }
        runBlocking { repository.completePairing(completed) }
        instrumentation.runOnMainSync { ContextCompat.startForegroundService(activity, Intent(activity, MonitoringService::class.java)) }
        runBlocking { withTimeout(45_000) { repository.state.first { it.connection is ConnectionState.Online && it.projects.isNotEmpty() } } }
        responseFile.delete(); confirmedFile.delete()
        println("USB_RESUME: staged response and both key pairs survived process death; replacement committed and reached Online")
    }
}
