import QtQuick
import QtQuick.Controls
import QtQuick.Window
import "EmoticonState.js" as Faces
import "PortraitMood.js" as Mood

Rectangle {
    id: badge
    objectName: "emoticonBadge"
    property var snapshot: ({})
    property bool connected: true
    property bool live: true
    property string motion: "idle"
    property string selectedId: ""
    property bool hovered: false
    property bool panelOpen: false
    property bool listening: false
    property real unit: 1
    property var cues: ({})
    // When supplied by the host, consume its settled mood instead of classifying
    // a second time. Standalone badge previews retain their explicit observe API.
    property var sharedMoods: null
    property double now: Date.now()
    property int variant: 0
    property var mirror: null
    readonly property var settings: snapshot.settings || ({})
    readonly property bool exposed: visible && Window.window !== null && Window.window.visible && Window.window.visibility !== Window.Minimized
    readonly property bool animated: exposed && !mirror && !settings.quiet && !settings.reducedMotion && settings.motionIntensity !== 0
    readonly property var emotion: mirror ? mirror.emotion : Faces.resolve({state:snapshot, connected:connected, live:live,
        motion:motion, cues:sharedMoods || cues, now:now, selectedId:selectedId, hovered:hovered, panelOpen:panelOpen, listening:listening})
    readonly property string glyph: mirror ? mirror.glyph : Faces.glyph(emotion, variant)
    readonly property string description: emotion.label + (emotion.sessionTitle ? " · " + emotion.sessionTitle : "")
    readonly property color accent: emotion.tone === "danger" ? "#ff9eae" : emotion.tone === "attention" ? "#ffd385"
        : emotion.tone === "success" ? "#82dccc" : emotion.tone === "warm" ? "#f1bbdf" : "#49dfff"

    function observe(message) {
        if (sharedMoods || !live || mirror || settings.expressiveCues === false || !message.sessionId) return
        if (message.role !== "user" && (message.role !== "assistant" || (message.kind && message.kind !== "text"))) return
        var time = Date.now(), next = Object.assign({}, cues)
        // Only live prose contributes tone; code and quotations use the portrait's
        // existing conservative classifier. A user's new turn clears the old mood.
        var sample = message.role === "user" ? {mood:"neutral"} : Mood.analyze([Object.assign({}, message, {time:time})], time, message.sessionId)
        next[message.sessionId] = {mood:sample.mood, time:time}
        Object.keys(next).forEach(function(id) { if (time - next[id].time >= 90000) delete next[id] })
        var keys = Object.keys(next).sort(function(a,b) { return next[b].time - next[a].time })
        keys.slice(64).forEach(function(id) { delete next[id] })
        cues = next; now = time
    }
    onSnapshotChanged: now = Date.now()
    onAnimatedChanged: if (!animated) variant = 0
    onExposedChanged: if (exposed) now = Date.now()
    onSelectedIdChanged: variant = 0
    onEmotionChanged: if (emotion.key !== lastKey) { lastKey = emotion.key; variant = 0 }
    property string lastKey: ""

    width: Math.min(116 * unit, Math.max(48 * unit, face.implicitWidth + 20 * unit))
    height: 28 * unit; radius: 11 * unit
    color: "#ed10212c"; border.color: accent
    Accessible.role: Accessible.StaticText
    Accessible.name: description
    Text {
        id: face; objectName:"emoticonFace"
        anchors.fill: parent; anchors.margins: 5 * badge.unit
        text: badge.glyph; textFormat: Text.PlainText
        color: badge.accent; font.family:"Adwaita Sans"; font.pixelSize:14 * badge.unit
        fontSizeMode: Text.HorizontalFit; minimumPixelSize: 9 * badge.unit
        horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
    }
    // Infrequent changes keep the face readable. Static accessibility modes retain
    // real state changes but stop cosmetic rotation entirely.
    Timer { objectName:"emoticonVariation"; interval: 6200; repeat: true; running: badge.animated; onTriggered: badge.variant = (badge.variant + 1) % 3 }
    Timer { interval: 2000; repeat: true; running: badge.exposed && !badge.mirror && badge.live; onTriggered: badge.now = Date.now() }
    ToolTip.visible: badge.hovered
    ToolTip.delay: 650
    ToolTip.text: description
}
