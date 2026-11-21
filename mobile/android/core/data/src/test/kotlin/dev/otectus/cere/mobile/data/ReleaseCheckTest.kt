package dev.otectus.cere.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** MOB-006: the update check against realistic GitHub answers, both channels, caching and failures. */
class ReleaseCheckTest {
    private val sha = "a".repeat(64)
    private fun release(tag: String, prerelease: Boolean, assets: List<String>, draft: Boolean = false) =
        """{"tag_name":"$tag","draft":$draft,"prerelease":$prerelease,"html_url":"https://github.com/otectus/Cere/releases/tag/$tag","name":"$tag","body":"notes","assets":[${assets.joinToString(",") { """{"name":"$it","size":1,"browser_download_url":"https://github.com/otectus/Cere/releases/download/$tag/$it"}""" }}]}"""
    private fun metadata(packageId: String, version: String, code: Long, development: Boolean, apk: String, minSdk: Int = 30) =
        """{"packageId":"$packageId","versionName":"$version","versionCode":$code,"development":$development,"minSdk":$minSdk,"protocol":{"major":1,"minMinor":0,"maxMinor":0,"desktopMinor":1},"apk":{"name":"$apk","sha256":"$sha"},"source":"0123456"}"""
    private val page = "[" + listOf(
        release("mobile-dev-v0.1.4", true, listOf("cere-mobile-v0.1.4-dev.apk", "mobile-development.json")),
        release("mobile-dev-v0.1.3", true, listOf("cere-mobile-v0.1.3-debug.apk", "mobile-development.json")),
        release("mobile-v0.2.0", false, listOf("cere-mobile-v0.2.0.apk", "mobile-release.json", "SHA256SUMS")),
        release("mobile-v0.3.0", false, listOf("cere-mobile-v0.3.0.apk", "mobile-release.json"), draft = true),
        release("v0.1.1", false, listOf("cere-desktop.tar.zst")),
    ).joinToString(",") + "]"
    private class Memory : ReleaseCache {
        val bodies = mutableMapOf<Int, String>(); val etags = mutableMapOf<Int, String?>()
        override fun body(page: Int) = bodies[page]; override fun etag(page: Int) = etags[page]
        override fun store(page: Int, body: String, etag: String?) { bodies[page] = body; etags[page] = etag }
    }
    private fun fetcher(pages: (String, String?) -> HttpReply, files: Map<String, String>): (String, String?) -> HttpReply = { url, etag ->
        if (url.startsWith("https://api.github.com/")) pages(url, etag) else files[url.substringAfterLast("/download/")]?.let { HttpReply(200, it) } ?: HttpReply(404)
    }
    private val files = mapOf(
        "mobile-dev-v0.1.4/mobile-development.json" to metadata("dev.otectus.cere.mobile.debug", "0.1.4", 1004, true, "cere-mobile-v0.1.4-dev.apk"),
        "mobile-dev-v0.1.3/mobile-development.json" to metadata("dev.otectus.cere.mobile.debug", "0.1.3", 1003, true, "cere-mobile-v0.1.3-debug.apk"),
        "mobile-v0.2.0/mobile-release.json" to metadata("dev.otectus.cere.mobile", "0.2.0", 2000, false, "cere-mobile-v0.2.0.apk"),
    )

    @Test fun aDevelopmentInstallFindsTheNextSnapshotAndNeverAStableRelease() {
        val check = ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(200, page, "\"e1\"") }, files), Memory())
        assertEquals("https://github.com/otectus/Cere/releases/tag/mobile-dev-v0.1.4", check.newest())
        // The installed 0.1.3 is not newer than itself.
        assertNull(ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1004, 35, fetcher({ _, _ -> HttpReply(200, page) }, files), Memory()).newest())
    }

    @Test fun aStableInstallIgnoresSnapshotsAndDrafts() {
        val check = ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile"), 1004, 35, fetcher({ _, _ -> HttpReply(200, page) }, files), Memory())
        assertEquals("https://github.com/otectus/Cere/releases/tag/mobile-v0.2.0", check.newest())
    }

    @Test fun metadataMustNameThisPackageVersionAndAnAndroidLevelThePhoneHas() {
        val wrongPackage = files + ("mobile-dev-v0.1.4/mobile-development.json" to metadata("dev.otectus.cere.mobile", "0.1.4", 1004, true, "cere-mobile-v0.1.4-dev.apk"))
        assertNull(ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(200, page) }, wrongPackage), Memory()).newest())
        val notDevelopment = files + ("mobile-dev-v0.1.4/mobile-development.json" to metadata("dev.otectus.cere.mobile.debug", "0.1.4", 1004, false, "cere-mobile-v0.1.4-dev.apk"))
        assertNull(ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(200, page) }, notDevelopment), Memory()).newest())
        val newerAndroid = files + ("mobile-dev-v0.1.4/mobile-development.json" to metadata("dev.otectus.cere.mobile.debug", "0.1.4", 1004, true, "cere-mobile-v0.1.4-dev.apk", minSdk = 40))
        assertNull(ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(200, page) }, newerAndroid), Memory()).newest())
    }

    @Test fun anUnchangedPageIsReadFromTheEtagCacheAndFailuresAreReportedNotGuessed() {
        val cache = Memory()
        ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(200, page, "\"e1\"") }, files), cache).newest()
        assertEquals("\"e1\"", cache.etag(1))
        var sent: String? = null
        val cached = ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, etag -> sent = etag; HttpReply(304) }, files), cache).newest()
        assertEquals("\"e1\"", sent); assertTrue(cached!!.endsWith("mobile-dev-v0.1.4"))
        // Rate-limited, offline-style failures and malformed answers throw; the caller says the check is unavailable.
        assertThrows(IllegalStateException::class.java) { ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(403) }, files), Memory()).newest() }
        assertThrows(IllegalStateException::class.java) { ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(304) }, files), Memory()).newest() }
        assertThrows(Exception::class.java) { ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(200, "{not json") }, files), Memory()).newest() }
        assertThrows(IllegalStateException::class.java) { ReleaseCheck(ReleaseChannel.forPackage("dev.otectus.cere.mobile.debug"), 1003, 35, fetcher({ _, _ -> HttpReply(200, page) }, emptyMap()), Memory()).newest() }
    }
}
