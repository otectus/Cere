package dev.otectus.cere.mobile

import android.app.Application
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
    }
}
