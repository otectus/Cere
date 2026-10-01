import QtQuick
import "PortraitMood.js" as Mood

// One owner of classification, streaming holds and freshness, shared by consumers.
Item {
    id: source
    property var settings: ({})
    property var session: ({})
    property var messages: []
    property var config: ({})
    property bool active: false
    signal settled()
    readonly property string sessionId: session.id || ""
    readonly property bool cuesEnabled: settings.expressiveCues !== false
    property string mood: "neutral"
    property real moodConfidence: 0
    property string pendingMood: ""
    property double pendingSince: 0
    property string observedSignature: ""
    property string liveMessageId: ""
    property double liveMessageTime: 0
    property bool ready: false
    property real moodIntensity: 0
    function scheduleMood() { if (ready && active && !moodDebounce.running) moodDebounce.start() }
    function resetMood() {
        mood = "neutral"; moodConfidence = 0; pendingMood = ""; pendingSince = 0
        observedSignature = ""; liveMessageId = ""; liveMessageTime = 0
        scheduleMood()
    }
    function refreshMood() {
        if (!cuesEnabled || !sessionId) { mood = "neutral"; moodConfidence = 0; settled(); return }
        var now = Date.now(), sample = messages.slice(-config.messageLimit), newest = null
        for (var i = sample.length - 1; i >= 0; --i) {
            if (sample[i].sessionId !== sessionId) continue
            if (sample[i].role === "user") break
            if (sample[i].role === "assistant" && (!sample[i].kind || sample[i].kind === "text")) { newest = sample[i]; break }
        }
        if (newest) {
            var signature = newest.id + ":" + newest.text.length + ":" + newest.text.slice(-256)
            // Message.time is the START of a streamed reply. Keep new words fresh,
            // but never revive a historical reply just because its panel opened.
            if (signature !== observedSignature) {
                if (session.status === "working" && session.activity === "speaking") {
                    liveMessageId = newest.id; liveMessageTime = now
                }
                observedSignature = signature
            }
            if (newest.id === liveMessageId)
                sample = sample.map(function(m) { return m.id === liveMessageId ? Object.assign({}, m, {time:liveMessageTime}) : m })
        }
        var result = Mood.analyze(sample, now, sessionId)
        moodConfidence = result.confidence; moodIntensity = result.intensity
        // New turns clear immediately; competing stream cues need a short hold.
        if (!result.messageId || result.mood === "neutral" || result.mood === mood) {
            mood = result.mood; pendingMood = ""; settled(); return
        }
        if (mood === "neutral") { mood = result.mood; pendingMood = ""; settled(); return }
        if (pendingMood !== result.mood) { pendingMood = result.mood; pendingSince = now }
        else if (now - pendingSince >= config.holdMs) { mood = result.mood; pendingMood = "" }
        settled()
    }

    onMessagesChanged: scheduleMood()
    onSessionIdChanged: if (ready) resetMood()
    onCuesEnabledChanged: resetMood()
    onActiveChanged: { if (active) scheduleMood(); else { moodDebounce.stop(); resetMood() } }
    Component.onCompleted: { ready = true; if (active) refreshMood() }
    Timer { id: moodDebounce; interval: source.config.debounceMs || 1; onTriggered: source.refreshMood() }
    Timer {
        interval: source.config.refreshMs || 1; repeat: true
        running: source.active && source.cuesEnabled && source.sessionId.length > 0
            && (source.mood !== "neutral" || source.pendingMood !== "")
        onTriggered: source.refreshMood()
    }
}
