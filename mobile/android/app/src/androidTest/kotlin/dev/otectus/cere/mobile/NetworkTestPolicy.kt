package dev.otectus.cere.mobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.platform.app.InstrumentationRegistry

internal fun requireCellularAndVpnIfRequested(context: Context) {
    if (InstrumentationRegistry.getArguments().getString("cereRequireCellular") != "true") return
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val capabilities = connectivity.allNetworks.mapNotNull(connectivity::getNetworkCapabilities)
    fun validated(transport: Int) = capabilities.any {
        it.hasTransport(transport) &&
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
    check(validated(NetworkCapabilities.TRANSPORT_CELLULAR)) { "No validated cellular network is active" }
    check(validated(NetworkCapabilities.TRANSPORT_VPN)) { "No validated VPN/Tailscale network is active" }
}
