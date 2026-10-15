import QtQuick
import QtQuick.Window
import Cere.Native 1.0
import "Motion.js" as Motion

Item {
    id: player
    objectName: "gesturePlayer"
    property bool followAppMotion: true
    property string motion: "idle"
    property var settings: App.state.settings || ({})
    property var avatar: App.avatar
    readonly property var puppet: avatar.puppet || ({})
    readonly property var animationCatalog: {
        const catalog = Object.assign({}, App.animations)
        catalog.puppet = player.puppet
        return catalog
    }
    property var mirrorSource: null
    readonly property var visual: mirrorSource || player
    readonly property bool referenceArt: puppet.presentation === "reference"
    readonly property bool referenceStill: referenceArt && !visual.active
    property real intensity: settings.motionIntensity === undefined ? 0.7 : settings.motionIntensity
    readonly property bool exposed: visible && Window.window !== null && Window.window.visible && Window.window.visibility !== Window.Minimized
    property bool active: !mirrorSource && exposed && motion !== "quiet" && !settings.quiet && !settings.reducedMotion && intensity > 0
    property var sequence: ({keys:[{pose:0,ms:1000}],loop:true})
    property var clock: Motion.create(Math.floor(Math.random() * 4294967296))
    property int keyIndex: 0
    property int pose: 0
    property real shiftX: 0
    property real shiftY: 0
    property real angle: 0
    property var rig: ({})
    property string symbol: sequence.symbol || ""
    property alias emoticon: badge
    property real gazeX: 0
    property real gazeY: 0
    property bool hovered: false
    property bool blinking: false
    property string phase: "rest"
    property string idleBeat: "At ease"
    property bool ready: false
    property int renderedFrames: 0
    readonly property bool animating: frames.running
    property string idleEnergy: settings.idleEnergy || animationCatalog.defaultIdleProfile
    property string bodyMood: followAppMotion ? App.bodyMood : "neutral"
    // Touch the singleton even when every conversation panel is closed.
    readonly property var sharedMood: followAppMotion ? ConversationMood.forSession(App.moodSession) : null
    function configureLife() {
        if (ready) Motion.configure(clock, idleEnergy, bodyMood)
    }
    onIdleEnergyChanged: configureLife()
    onBodyMoodChanged: configureLife()
    // Kept as a readable signal for UI diagnostics; rendering uses the rig itself.
    readonly property real breath: rig.breath || 0

    function gazeAt(x, y) {
        hovered = true
        gazeX = Motion.clamp((x - .5) * 2, -1, 1)
        gazeY = Motion.clamp(((y === undefined ? .4 : y) - .4) * 2, -1, 1)
    }
    function clearGaze() { hovered = false; gazeX = 0; gazeY = 0 }
    function play() {
        if (!ready) return
        blinking = false
        sequence = (animationCatalog.clips || {})[motion] || {keys:[{pose:0,ms:1000}],loop:true}
        Motion.select(clock, sequence, animationCatalog, motion)
        configureLife()
        advance(0)
    }
    function advance(seconds) {
        const velocity = App.petVelocity
        const sample = Motion.sample(clock, seconds, intensity, gazeX, gazeY,
                                     velocity.x, velocity.y, !active, {hovered:hovered})
        keyIndex = sample.keyIndex; pose = sample.pose
        shiftX = sample.x; shiftY = sample.y; angle = sample.rotation
        rig = sample
        phase = sample.phase; idleBeat = sample.beat; blinking = sample.blink > .1

    }
    onIntensityChanged: if (ready && !active) advance(0)
    onActiveChanged: {
        if (!ready) return
        if (!active) { blinking = false; clearGaze() }
        play()
    }
    function syncMotion() {
        if (motion !== App.motion) motion = App.motion
        else play()
    }
    onFollowAppMotionChanged: if (ready && followAppMotion) syncMotion()
    onMotionChanged: play()
    onAnimationCatalogChanged: if (ready && !mirrorSource) play()
    Component.onCompleted: { if (followAppMotion) motion = App.motion; ready = true; play() }
    Connections {
        target: App
        // A replay of the same clip has a new director revision but the same name.
        function onMotionChanged() { if (player.followAppMotion) player.syncMotion() }
        function onConversationMessage(message) { badge.observe(message) }
    }
    FrameAnimation {
        id: frames
        property real pendingSeconds: 0
        running: player.active && player.exposed && player.ready
        onRunningChanged: pendingSeconds = 0
        onTriggered: {
            pendingSeconds += frameTime
            // The reference surface is rasterized at full selected detail.
            // Keep its gentle motion at up to 60 Hz on high-refresh displays.
            if (player.referenceArt && pendingSeconds < 1 / 60) return
            player.advance(pendingSeconds)
            pendingSeconds = 0
            player.renderedFrames++
        }
    }
    // A grounded shadow responds to lift, so jumps and landings have weight.
    Rectangle {
        width: parent.width * .48 * (1 + Math.min(0, player.visual.shiftY) * .016)
        height: Math.max(3, parent.height * .025)
        x: (parent.width - width) / 2; y: parent.height - height - 4
        radius: height / 2; color: Theme.petShadow
        opacity: .65 + Math.min(0, player.visual.shiftY) * .035
    }
    Item {
        id: artwork
        width: parent.width * .96; height: parent.height * .96
        x: (parent.width - width) / 2 + (player.referenceStill ? 0 : player.visual.shiftX * (player.referenceArt ? .35 : 1)) * parent.width / 192
        y: parent.height - height - 5 + (player.referenceStill ? 0 : player.visual.shiftY * (player.referenceArt ? .35 : 1)) * parent.height / 208
        rotation: player.referenceStill ? 0 : player.referenceArt ? Math.max(-3, Math.min(3, player.visual.angle * .35)) : player.visual.angle
        transformOrigin: Item.Bottom
        AvatarPuppet {
            objectName: "avatarPuppet"
            anchors.fill: parent
            source: App.assetPath + player.puppet.texture
            definition: player.puppet
            pose: player.referenceStill ? ({}) : player.visual.rig
        }
    }

    EmoticonBadge {
        id: badge
        anchors.top: parent.top; anchors.right: parent.right
        anchors.topMargin: 3; anchors.rightMargin: Math.max(4,parent.width * .07)
        unit: Math.max(.8,Math.min(1.5,player.width/192))
        snapshot: App.state
        sharedMoods: player.followAppMotion ? App.conversationMoods : null
        connected: App.connected
        live: player.followAppMotion
        motion: player.motion
        hovered: player.hovered
        selectedId: App.selectedId
        panelOpen: !!((App.state.panels || {}).ui || (App.state.panels || {}).overlay)
        listening: !!((App.state.attention || {}).ui?.listening || (App.state.attention || {}).overlay?.listening)
        mirror: player.mirrorSource ? player.mirrorSource.emoticon : null
    }
}
