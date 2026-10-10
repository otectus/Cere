package dev.otectus.cere.mobile

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import dev.otectus.cere.mobile.data.CereRepository
import dev.otectus.cere.mobile.data.PreparedAction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Signs and sends a prepared action, then reports exactly once. The request runs in the
 * repository's lifetime, so rotating or leaving the screen cannot cancel it halfway;
 * an authentication prompt interrupted by the activity closing reports a failure
 * instead of leaving its caller waiting.
 */
internal fun authenticate(activity: FragmentActivity, title: String, action: PreparedAction, repository: CereRepository, success: (JsonElement) -> Unit, failure: (String) -> Unit) {
    var settled = false
    val finish: (Result<JsonElement>) -> Unit = { result ->
        if (!settled) { settled = true; result.onSuccess(success).onFailure { failure(it.message ?: "The action failed") } }
    }
    if (!action.requiresUserAuthentication) {
        repository.launchAction(action, { repository.signWithoutAuthentication(action) }, finish)
        return
    }
    val observer = object : DefaultLifecycleObserver {
        override fun onDestroy(owner: LifecycleOwner) { finish(Result.failure(IllegalStateException("Authentication was interrupted. Review the request and try again."))) }
    }
    activity.lifecycle.addObserver(observer)
    val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            activity.lifecycle.removeObserver(observer)
            repository.launchAction(action, { repository.signAuthenticated(action) }, finish)
        }
        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            activity.lifecycle.removeObserver(observer)
            finish(Result.failure(IllegalStateException(errString.toString())))
        }
    })
    prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle("Confirm the exact action shown")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL).build(), BiometricPrompt.CryptoObject(action.signature))
}

/** Prepares a signed action for review, then authenticates and sends it. */
internal fun signedReview(activity: FragmentActivity, repository: CereRepository, method: String, params: JsonObject, title: String, success: (JsonElement) -> Unit, failure: (String) -> Unit, boundProjectId: String? = null, label: String? = null) {
    activity.lifecycleScope.launch {
        val action = try { repository.prepareAction(method, params, boundProjectId, label) } catch (cancelled: CancellationException) { throw cancelled } catch (error: Exception) {
            failure(error.message ?: "Unable to prepare this action"); return@launch
        }
        authenticate(activity, title, action, repository, success, failure)
    }
}
