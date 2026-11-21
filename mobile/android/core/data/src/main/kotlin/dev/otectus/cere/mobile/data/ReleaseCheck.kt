package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.WireCodec
import java.net.URI
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Stable builds follow published `mobile-vX.Y.Z` releases. Development builds (the `.debug`
 * package) follow `mobile-dev-vX.Y.Z` snapshots, whose metadata must name this exact package; a
 * stable release never offers itself to a development install, nor a snapshot to a stable one.
 */
class ReleaseChannel(val development: Boolean, val packageId: String) {
    val tag = Regex(if (development) "^mobile-dev-v(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$" else "^mobile-v(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
    val metadata = if (development) "mobile-development.json" else "mobile-release.json"
    fun apkNames(version: String) = if (development) setOf("cere-mobile-v$version-dev.apk", "cere-mobile-v$version-debug.apk") else setOf("cere-mobile-v$version.apk")
    companion object { fun forPackage(packageId: String) = ReleaseChannel(packageId.endsWith(".debug"), packageId) }
}

/** What the checker needs from one HTTP answer. */
data class HttpReply(val code: Int, val body: String? = null, val etag: String? = null)

/** The pages the checker read last, for conditional (ETag) requests. */
interface ReleaseCache {
    fun body(page: Int): String?
    fun etag(page: Int): String?
    fun store(page: Int, body: String, etag: String?)
}

/**
 * The manual and at-most-daily update check. It reads up to ten pages of this repository's GitHub
 * releases with ETags, then the release metadata of the newest candidates, and answers the release
 * page to open, or null. It never downloads or installs an APK. A failure (offline, a rate limit, a
 * malformed answer) is thrown, so the caller can say the check is unavailable without touching chat.
 */
class ReleaseCheck(
    private val channel: ReleaseChannel,
    private val ownCode: Long,
    private val sdk: Int,
    private val fetch: (url: String, etag: String?) -> HttpReply,
    private val cache: ReleaseCache,
) {
    data class Candidate(val code: Long, val tag: String, val url: String, val version: String)

    fun newest(): String? {
        val candidates = mutableListOf<Candidate>()
        for (page in 1..10) {
            val reply = fetch("https://api.github.com/repos/otectus/Cere/releases?per_page=50&page=$page", cache.etag(page))
            val body = when {
                reply.code == 304 -> cache.body(page) ?: error("Missing update cache")
                reply.code in 200..299 -> (reply.body ?: error("Missing update response")).also { cache.store(page, it, reply.etag) }
                else -> error("GitHub answered HTTP ${reply.code}")
            }
            val releases = WireCodec.json.parseToJsonElement(body).jsonArray
            releases.forEach { entry -> candidate(entry.jsonObject)?.let(candidates::add) }
            if (releases.size < 50) break
        }
        for (candidate in candidates.sortedByDescending { it.code }.take(10)) {
            val reply = fetch("https://github.com/otectus/Cere/releases/download/${candidate.tag}/${channel.metadata}", null)
            check(reply.code in 200..299) { "Release metadata answered HTTP ${reply.code}" }
            val metadata = WireCodec.json.parseToJsonElement(reply.body ?: error("Missing release metadata")).jsonObject
            if (accepts(metadata, candidate)) return candidate.url
        }
        return null
    }

    /** A published release of this channel, with this version's APK and metadata, newer than this install. */
    fun candidate(value: JsonObject): Candidate? {
        if (value["draft"]?.jsonPrimitive?.booleanOrNull != false) return null
        // Stable builds ignore prereleases; development snapshots are published as prereleases.
        if (!channel.development && value["prerelease"]?.jsonPrimitive?.booleanOrNull != false) return null
        val tag = value["tag_name"]?.jsonPrimitive?.contentOrNull ?: return null
        val match = channel.tag.matchEntire(tag) ?: return null
        val (major, minor, patch) = match.destructured
        val code = major.toLong() * 1_000_000 + minor.toLong() * 1_000 + patch.toLong()
        val version = "$major.$minor.$patch"
        val assets = value["assets"]?.jsonArray.orEmpty().mapNotNull { it.jsonObject["name"]?.jsonPrimitive?.contentOrNull }.toSet()
        if (assets.none { it in channel.apkNames(version) } || channel.metadata !in assets) return null
        val url = value["html_url"]?.jsonPrimitive?.contentOrNull ?: return null
        val parsed = runCatching { URI(url) }.getOrNull() ?: return null
        if (parsed.scheme != "https" || parsed.host != "github.com" || parsed.path != "/otectus/Cere/releases/tag/$tag") return null
        return if (code > ownCode) Candidate(code, tag, url, version) else null
    }

    /** The metadata names this package and version, supports this Android level and speaks protocol 1 at hello revision 0. */
    fun accepts(metadata: JsonObject, candidate: Candidate): Boolean {
        val protocol = metadata["protocol"] as? JsonObject ?: return false
        if (metadata["packageId"]?.jsonPrimitive?.contentOrNull != channel.packageId || metadata["versionCode"]?.jsonPrimitive?.longOrNull != candidate.code || metadata["versionName"]?.jsonPrimitive?.contentOrNull != candidate.version) return false
        if (channel.development && metadata["development"]?.jsonPrimitive?.booleanOrNull != true) return false
        if ((metadata["minSdk"]?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE) > sdk || protocol["major"]?.jsonPrimitive?.intOrNull != 1 ||
            (protocol["minMinor"]?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE) > 0 || (protocol["maxMinor"]?.jsonPrimitive?.intOrNull ?: -1) < 0) return false
        val apk = metadata["apk"] as? JsonObject ?: return false
        return apk["name"]?.jsonPrimitive?.contentOrNull in channel.apkNames(candidate.version) && apk["sha256"]?.jsonPrimitive?.contentOrNull?.matches(Regex("[a-fA-F0-9]{64}")) == true
    }
}
