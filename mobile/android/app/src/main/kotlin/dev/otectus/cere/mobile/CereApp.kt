package dev.otectus.cere.mobile

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.os.StrictMode
import dev.otectus.cere.mobile.data.CereRepository

class CereApp : Application() {
    val repository by lazy { CereRepository(this) }

    override fun onCreate() {
        super.onCreate()
        if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().build())
            StrictMode.setVmPolicy(StrictMode.VmPolicy.Builder().detectLeakedClosableObjects().detectLeakedRegistrationObjects().penaltyLog().build())
        }
        // Channels exist from the start, so Android's notification settings list them before the first alert.
        CereNotifications.ensureChannels(this)
        // Network changes reach the connection while the app is open, with or without background monitoring.
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { repository.networkAvailable() }
            override fun onLost(network: Network) { repository.networkLost() }
        })
    }
}
