pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Window
import "PortraitMood.js" as Mood
import "PortraitState.js" as State

Rectangle {
    id: portrait
    objectName: "cerePortrait"
    implicitWidth: 64
    implicitHeight: 64
    radius: width * .27
    color: "#102736"
    border.color: accent
    border.width: 1

    // Inputs are explicit so the miniature and workspace share identical behavior.
    property var settings: ({})
    property var session: ({})
    property var messages: []
    property var approvals: []
    property var speech: ({})
    property bool connected: true
    property bool listening: false
    property url assetRoot: Qt.resolvedUrl("../assets/")
    readonly property string sessionId: session.id || ""
    readonly property real intensity: settings.motionIntensity === undefined ? .7 : Math.max(0, Math.min(1, settings.motionIntensity))
    readonly property bool exposed: visible && Window.window !== null && Window.window.visible && Window.window.visibility !== Window.Minimized
    readonly property bool animated: exposed && !settings.reducedMotion && !settings.quiet && intensity > 0
    readonly property bool cuesEnabled: settings.expressiveCues !== false
    readonly property bool hovered: pointer.containsMouse
    readonly property bool speaking: connected && speech.state === "speaking"
    readonly property var resolved: State.resolve({session:session, approvals:approvals, connected:connected,
        paused:settings.paused, mood:cuesEnabled ? mood : "neutral", greeting:greeting,
        hovered:hovered, listening:listening})
    readonly property string expression: resolved.expression
    readonly property string description: "Cere · " + resolved.label + (speaking ? " · Speaking" : "")
    readonly property color accent: resolved.tone === "attention" ? "#bb9155" : resolved.tone === "warm" ? "#70b8cb" : "#367790"
    readonly property var frames: ({neutral:0, curious:1, thinking:2, happy:3, cheeky:4, skeptical:5,
        tender:6, concerned:7, surprised:8, focused:9, sleepy:10})
    readonly property int face: blinking ? 11 : (frames[expression] || 0)
    property string mood: "neutral"
    property real moodConfidence: 0
    property string pendingMood: ""
    property double pendingSince: 0
    property string observedSignature: ""
    property string liveMessageId: ""
    property double liveMessageTime: 0
    property bool ready: false
    property bool greeting: false
    property bool blinking: false
    property real phase: 0
    property real driftX: 0
    property real driftY: 0
    property real tilt: 0
    property real gazeX: 0
    property real gazeY: 0
    property int renderedFrames: 0
    property int loadedFaces: 0
    readonly property bool artworkReady: loadedFaces === 12

    function scheduleMood() { if (ready && exposed && !moodDebounce.running) moodDebounce.start() }
    function resetMood() {
        mood = "neutral"; moodConfidence = 0; pendingMood = ""; pendingSince = 0
        observedSignature = ""; liveMessageId = ""; liveMessageTime = 0
        greeting = false; greetingTimer.stop()
        scheduleMood()
    }
    function refreshMood() {
        if (!cuesEnabled || !sessionId) { mood = "neutral"; moodConfidence = 0; return }
        var now = Date.now(), sample = messages.slice(-32), newest = null
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
        moodConfidence = result.confidence
        // New turns clear immediately; competing stream cues need a short hold.
        if (!result.messageId || result.mood === "neutral" || result.mood === mood) {
            mood = result.mood; pendingMood = ""; return
        }
        if (mood === "neutral") { mood = result.mood; pendingMood = ""; return }
        if (pendingMood !== result.mood) { pendingMood = result.mood; pendingSince = now }
        else if (now - pendingSince >= 650) { mood = result.mood; pendingMood = "" }
    }
    function acknowledge() {
        if (!animated) return
        greeting = true; greetingTimer.restart()
    }
    function settle() {
        phase = 0; driftX = 0; driftY = 0; tilt = 0; gazeX = 0; gazeY = 0
        blinking = false; greeting = false; greetingTimer.stop(); blinkEnd.stop()
    }
    onMessagesChanged: scheduleMood()
    onSessionIdChanged: if (ready) resetMood()
    onCuesEnabledChanged: { resetMood(); scheduleMood() }
    onAnimatedChanged: if (ready && !animated) settle()
    onExposedChanged: if (exposed) scheduleMood()
    Component.onCompleted: { ready = true; refreshMood() }

    Accessible.role: Accessible.Button
    Accessible.name: description
    Accessible.description: "Animated portrait. Activate to say hello."
    Accessible.onPressAction: acknowledge()
    activeFocusOnTab: true
    Keys.onSpacePressed: acknowledge()
    Keys.onReturnPressed: acknowledge()

    Timer { id: moodDebounce; interval: 160; onTriggered: portrait.refreshMood() }
    Timer { interval: 750; repeat: true; running: portrait.exposed && portrait.cuesEnabled && portrait.sessionId.length > 0; onTriggered: portrait.refreshMood() }
    Timer { id: greetingTimer; interval: 1550; onTriggered: portrait.greeting = false }
    Timer {
        id: blinkClock
        interval: 2800 + Math.random() * 3600
        repeat: true
        running: portrait.animated
        onTriggered: {
            interval = 2800 + Math.random() * 3600
            if (portrait.expression === "cheeky" || portrait.expression === "happy") return
            portrait.blinking = true; blinkEnd.start()
        }
    }
    Timer { id: blinkEnd; interval: 130; onTriggered: portrait.blinking = false }
    FrameAnimation {
        running: portrait.animated
        onTriggered: {
            var dt = Math.min(frameTime, .05), ease = 1 - Math.exp(-dt * 7)
            portrait.phase += dt
            var p = portrait.phase, weight = portrait.intensity
            portrait.gazeX += ((portrait.hovered ? (pointer.mouseX / portrait.width - .5) * 2 : Math.sin(p * .43) * .28) - portrait.gazeX) * ease
            portrait.gazeY += ((portrait.hovered ? (pointer.mouseY / portrait.height - .5) * 2 : 0) - portrait.gazeY) * ease
            portrait.driftX = portrait.gazeX * portrait.width * .018 * weight
            portrait.driftY = (Math.sin(p * 1.7) * .65 + portrait.gazeY * .6 + (portrait.speaking ? Math.sin(p * 9) * .45 : 0)) * portrait.height / 64 * weight
            var target = (portrait.expression === "curious" ? -4 : portrait.expression === "cheeky" ? 4 : portrait.expression === "tender" ? -3 : 0)
            portrait.tilt += ((target + portrait.gazeX * 2 + Math.sin(p * .9) * .8) * weight - portrait.tilt) * ease
            portrait.renderedFrames++
        }
    }

    Rectangle {
        anchors.fill: parent; anchors.margins: 3; radius: parent.radius - 2
        gradient: Gradient {
            GradientStop { position: 0; color: "#23495d" }
            GradientStop { position: 1; color: "#101c2b" }
        }
    }
    Item {
        width: parent.width * .98; height: parent.height * .98
        x: (parent.width - width) / 2 + portrait.driftX
        y: (parent.height - height) / 2 + portrait.driftY
        rotation: portrait.tilt
        Repeater {
            id: faces
            model: 12
            Image {
                id: faceImage
                required property int index
                anchors.fill: parent
                source: portrait.assetRoot + "cere-portrait-expressions.png"
                sourceSize: Qt.size(1024, 768)
                sourceClipRect: Qt.rect((index % 4) * 256, Math.floor(index / 4) * 256, 256, 256)
                fillMode: Image.PreserveAspectFit
                smooth: true; mipmap: true; cache: true
                property bool loaded: status === Image.Ready
                onLoadedChanged: portrait.loadedFaces += loaded ? 1 : -1
                opacity: portrait.face === index ? 1 : 0
                visible: opacity > 0
                Behavior on opacity { NumberAnimation { duration: portrait.animated ? (portrait.blinking || faceImage.index === 11 ? 65 : 220) : 0; easing.type: Easing.InOutQuad } }
            }
        }
    }
    Rectangle {
        anchors.fill: parent; radius: parent.radius; color: "transparent"
        border.width: portrait.activeFocus ? 2 : 1
        border.color: portrait.activeFocus ? "#49dfff" : "#39667b"
    }
    // Breath-like mask light communicates real speech without pretending to lip-sync.
    Item {
        anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: 3
        width: 13; height: 7; visible: portrait.speaking
        Repeater {
            model: 3
            Rectangle {
                required property int index
                x: index * 5; y: parent.height - height
                width: 3; height: portrait.animated ? 3 + (1 + Math.sin(portrait.phase * 12 + index * 1.7)) * 2 : 4
                radius: 1.5; color: "#a8ecff"
            }
        }
    }
    MouseArea {
        id: pointer; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
        onClicked: portrait.acknowledge()
    }
    ToolTip.visible: pointer.containsMouse || activeFocus
    ToolTip.delay: 650
    ToolTip.text: description
}
