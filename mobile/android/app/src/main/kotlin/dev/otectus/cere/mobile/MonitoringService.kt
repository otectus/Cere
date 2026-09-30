package dev.otectus.cere.mobile

import android.app.*
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.otectus.cere.mobile.data.ConnectionState
import dev.otectus.cere.mobile.protocol.Approval
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class MonitoringService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val repository get() = (application as CereApp).repository
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { repository.networkAvailable() }
    }

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Cere connection", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shows when Cere is monitoring your paired desktop"
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            setShowBadge(false)
        })
        manager.createNotificationChannel(NotificationChannel(INBOX_CHANNEL, "Cere requests", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Approval and question requests from the paired Cere desktop"
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        startForeground(ID, notification("Connecting…"))
        getSystemService(ConnectivityManager::class.java).requestNetwork(NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build(), networkCallback)
        repository.startMonitoring()
        scope.launch { repository.state.collectLatest { state ->
            val text = when (val connection = state.connection) {
                is ConnectionState.Online -> "Connected to ${connection.desktopName}"
                is ConnectionState.Offline -> "Waiting for desktop"
                is ConnectionState.Blocked -> "Connection blocked · open Cere"
                ConnectionState.Authenticating -> "Authenticating…"
                ConnectionState.Connecting -> "Connecting…"
                ConnectionState.Unpaired -> "Pairing required"
            }
            manager.notify(ID, notification(text))
            val active = state.approvals.map { it.id.hashCode() }.toSet()
            shownApprovals.filterNot(active::contains).forEach { manager.cancel(it) }
            shownApprovals = active
            state.approvals.forEach { approval -> manager.notify(approval.id.hashCode(), approvalNotification(approval)) }
        } }
    }

    override fun onDestroy() { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }; scope.cancel(); repository.stopMonitoring(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null

    private fun notification(text: String): Notification {
        val intent = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_cere_notification)
            .setContentTitle("Cere Mobile")
            .setContentText(text)
            .setContentIntent(intent)
            .setOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setSilent(true)
            .build()
    }

    private fun approvalNotification(approval: Approval): Notification {
        val review = PendingIntent.getActivity(this, approval.id.hashCode(), Intent(this, ReviewActivity::class.java).putExtra("approvalId", approval.id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val deny = PendingIntent.getBroadcast(this, approval.id.hashCode(), Intent(this, DenyReceiver::class.java).setData(Uri.parse("cere://deny/${approval.id}")).putExtra("approvalId", approval.id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, INBOX_CHANNEL)
            .setSmallIcon(R.drawable.ic_cere_notification)
            .setContentTitle("Cere needs your review")
            .setContentText("${approval.kind.replaceFirstChar(Char::uppercase)} · ${approval.title}")
            .setContentIntent(review)
            .addAction(android.R.drawable.ic_delete, "Deny", deny)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(this, INBOX_CHANNEL).setSmallIcon(R.drawable.ic_cere_notification).setContentTitle("Cere request").setContentText("Unlock to review").build())
            .build()
    }

    private var shownApprovals: Set<Int> = emptySet()
    companion object { const val CHANNEL = "cere-monitoring"; const val INBOX_CHANNEL = "cere-requests"; const val ID = 41 }
}

class DenyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val approvalId = intent.getStringExtra("approvalId") ?: return
        val pending = goAsync(); val repository = (context.applicationContext as CereApp).repository
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val approval = withTimeoutOrNull(5_000) { repository.state.first { state -> state.approvals.any { it.id == approvalId } }.approvals.first { it.id == approvalId } } ?: return@launch
                if (repository.state.value.supports("approvals.answer") && "deny" in approval.choices) repository.mutate("approvals.answer", buildJsonObject {
                    put("approvalId", approval.id); put("revision", approval.revision); put("digest", approval.digest); put("choice", "deny"); put("answers", buildJsonObject {})
                })
            } finally { pending.finish() }
        }
    }
}
