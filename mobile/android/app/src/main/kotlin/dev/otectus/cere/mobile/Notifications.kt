package dev.otectus.cere.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.otectus.cere.mobile.data.DesktopNotice
import dev.otectus.cere.mobile.protocol.Approval

/** Channels, request alerts and desktop notices. Lock-screen copies never show request or conversation detail. */
internal object CereNotifications {
    const val MONITORING = "cere-monitoring"
    const val REQUESTS = "cere-requests"
    const val COMPLETIONS = "cere-completions"
    const val PROBLEMS = "cere-problems"
    const val TIMERS = "cere-timers"
    const val MONITORING_ID = 41

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        fun channel(id: String, name: String, importance: Int, description: String, badge: Boolean = true) =
            NotificationChannel(id, name, importance).apply { this.description = description; lockscreenVisibility = Notification.VISIBILITY_PRIVATE; setShowBadge(badge) }
        manager.createNotificationChannels(listOf(
            channel(MONITORING, "Cere connection", NotificationManager.IMPORTANCE_LOW, "Shows when Cere is monitoring your paired desktop", badge = false),
            channel(REQUESTS, "Cere requests", NotificationManager.IMPORTANCE_HIGH, "Approval and question requests from the paired Cere desktop"),
            channel(COMPLETIONS, "Replies ready", NotificationManager.IMPORTANCE_DEFAULT, "A desktop conversation finished its reply"),
            channel(PROBLEMS, "Conversation problems", NotificationManager.IMPORTANCE_DEFAULT, "A desktop conversation stopped or reported an error"),
            channel(TIMERS, "Desktop timers", NotificationManager.IMPORTANCE_HIGH, "Timers set from this phone on the desktop"),
        ))
    }

    /** Request alerts reach the person only with notifications allowed and the requests channel on. */
    fun requestAlertsEnabled(context: Context): Boolean {
        val compat = NotificationManagerCompat.from(context)
        if (!compat.areNotificationsEnabled()) return false
        val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel(REQUESTS)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun approvalId(id: String) = ("approval:$id").hashCode()
    private fun noticeId(notice: DesktopNotice) = (if (notice.kind == "timer") "timer:${notice.timerId}" else "notice:${notice.sessionId}").hashCode()

    private fun open(context: Context, requestCode: Int, action: String, extra: Pair<String, String>? = null): PendingIntent =
        PendingIntent.getActivity(context, requestCode, Intent(context, MainActivity::class.java).setAction(action)
            .apply { extra?.let { putExtra(it.first, it.second) } }
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    fun monitoring(context: Context, text: String): Notification {
        val stop = PendingIntent.getService(context, 1, Intent(context, MonitoringService::class.java).setAction(MonitoringService.ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, MONITORING)
            .setSmallIcon(R.drawable.ic_cere_notification)
            .setContentTitle("Cere Mobile")
            .setContentText(text)
            .setContentIntent(open(context, 0, Intent.ACTION_MAIN))
            .addAction(0, "Stop monitoring", stop)
            .setOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setSilent(true)
            .build()
    }

    fun approval(context: Context, approval: Approval, problem: String? = null): Notification {
        val review = open(context, approvalId(approval.id), MainActivity.ACTION_REVIEW, MainActivity.EXTRA_APPROVAL_ID to approval.id)
        val builder = NotificationCompat.Builder(context, REQUESTS)
            .setSmallIcon(R.drawable.ic_cere_notification)
            .setContentTitle(problem ?: "Cere needs your review")
            .setContentText(if (problem != null) "Open Cere to check: ${approval.title}" else "${approval.kind.replaceFirstChar(Char::uppercase)} · ${approval.title}")
            .setContentIntent(review)
            .setAutoCancel(true)
            // Re-posting the same request must not sound or vibrate again.
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(context, REQUESTS).setSmallIcon(R.drawable.ic_cere_notification).setContentTitle("Cere request").setContentText("Unlock to review").build())
        if (problem == null && "deny" in approval.choices) {
            val deny = PendingIntent.getBroadcast(context, approvalId(approval.id), Intent(context, DenyReceiver::class.java).setData(Uri.parse("cere://deny/${approval.id}")).putExtra("approvalId", approval.id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            builder.addAction(android.R.drawable.ic_delete, "Deny", deny)
        }
        return builder.build()
    }

    /** Builds the alert for a desktop notice, or null for kinds the phone does not announce. */
    fun notice(context: Context, notice: DesktopNotice): Pair<Int, Notification>? {
        val (channel, title, text) = when (notice.kind) {
            "complete" -> Triple(COMPLETIONS, "Reply ready", notice.title ?: "A conversation finished")
            "error" -> Triple(PROBLEMS, "A conversation reported a problem", "${notice.title ?: "Conversation"} · open Cere to review Activity")
            "interrupted" -> Triple(PROBLEMS, "A conversation stopped", notice.title ?: "Conversation")
            "timer" -> Triple(TIMERS, "Timer", notice.label ?: "Your desktop timer finished")
            else -> return null
        }
        val id = noticeId(notice)
        val tap = if (notice.kind == "timer") open(context, id, MainActivity.ACTION_OPEN_DESKTOP)
            else open(context, id, MainActivity.ACTION_OPEN_SESSION, MainActivity.EXTRA_SESSION_ID to (notice.sessionId ?: ""))
        val publicTitle = if (notice.kind == "timer") "Cere timer" else "Cere conversation update"
        return id to NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_cere_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_cere_notification).setContentTitle(publicTitle).setContentText("Unlock to view").build())
            .build()
    }
}
