import QtQuick

Item {
    id: player
    objectName: "gesturePlayer"
    property string motion: App.motion
    property var settings: App.state.settings || ({})
    property real intensity: settings.motionIntensity === undefined ? 0.7 : settings.motionIntensity
    property bool active: visible && motion !== "quiet" && !settings.quiet && !settings.reducedMotion && intensity > 0
    property var sequence: ({keys:[{pose:0,ms:1000}],loop:true})
    property int keyIndex: 0
    property int pose: 0
    property int previousPose: 0
    property int shownPose: 0
    property int tweenMs: 0
    property real blend: 1
    property real shiftX: 0
    property real shiftY: 0
    property real angle: 0
    property real stretchX: 1
    property real stretchY: 1
    property real breath: 0
    property real breathPhase: 0
    property var targetKey: ({})
    property string symbol: sequence.symbol || ""
    // Gaze follows only deliberate interaction with the pet, never polls the desktop.
    property int gazePose: 0
    property int pendingGaze: 0
    property bool blinking: false
    property int restingPose: active && motion === "idle" && gazePose ? gazePose : pose
    property var restingFrame: (App.animations.frames || [])[restingPose] || ({})
    property int displayPose: blinking && restingFrame.blinkPose !== undefined ? restingFrame.blinkPose : restingPose
    property bool canBlink: active && sequence.loop === true && restingFrame.blinkPose !== undefined
    property bool breathing: active && sequence.breath === true
    property bool animating: movement.running || dissolve.running || breathTimer.running || stepTimer.running || blinkTimer.running || blinkRelease.running || gazeDelay.running

    function gazeAt(fraction) {
        pendingGaze = fraction < 0.35 ? 2 : fraction > 0.65 ? 3 : 0
        if (active && motion === "idle" && pendingGaze !== gazePose && !gazeDelay.running) gazeDelay.start()
    }
    function clearGaze() { gazeDelay.stop(); pendingGaze = 0; gazePose = 0 }
    function scheduleBlink() {
        blinkTimer.stop()
        if (!canBlink) return
        const config = App.animations.blink || ({minMs:3800,maxMs:7200})
        blinkTimer.interval = config.minMs + Math.round(Math.random() * (config.maxMs-config.minMs))
        blinkTimer.start()
    }
    function showPose() {
        // Keep the more visible cel if a more important reaction interrupts a dissolve.
        const from = blend < 0.5 ? previousPose : shownPose
        dissolve.stop()
        previousPose = from
        shownPose = displayPose
        blend = active && from !== shownPose ? 0 : 1
        if (blend === 0) {
            dissolve.duration = blinking || blinkRelease.running ? 45 : 120
            dissolve.start()
        }
    }
    function play() {
        stepTimer.stop(); blinkRelease.stop(); blinking = false
        sequence = (App.animations.clips || {})[motion] || {keys:[{pose:0,ms:1000}],loop:true}
        keyIndex = 0
        applyKey()
        scheduleBlink()
    }
    function applyKey() {
        const key = sequence.keys[keyIndex]
        movement.stop()
        tweenMs = active ? Math.min(key.easeMs || key.ms, 650) : 0
        targetKey = active ? ({x:(key.x || 0)*intensity, y:(key.y || 0)*intensity,
            rotation:(key.rotation || 0)*intensity, sx:1+((key.sx || 1)-1)*intensity,
            sy:1+((key.sy || 1)-1)*intensity}) : ({x:0,y:0,rotation:0,sx:1,sy:1})
        pose = key.pose
        if (active) movement.start()
        else {
            shiftX=0; shiftY=0; angle=0; stretchX=1; stretchY=1
            showPose()
        }
        if (active && sequence.keys.length > 1) {
            stepTimer.interval = key.ms
            stepTimer.start()
        }
    }
    onDisplayPoseChanged: showPose()
    onCanBlinkChanged: { blinkRelease.stop(); blinking=false; scheduleBlink() }
    onBreathingChanged: if (!breathing) { breath=0; breathPhase=0 }
    onIntensityChanged: if (sequence.keys.length) applyKey()
    onActiveChanged: {
        clearGaze()
        if (active) play()
        else {
            stepTimer.stop(); blinkTimer.stop(); blinkRelease.stop(); blinking=false
            dissolve.stop(); movement.stop(); blend=1; tweenMs=0; breath=0
            shiftX=0; shiftY=0; angle=0; stretchX=1; stretchY=1
            // Reduced motion retains the current state as a static, readable pose.
            play()
        }
    }
    Component.onCompleted: play()
    Connections {
        target: App
        function onMotionChanged() { Qt.callLater(player.play) }
    }
    Timer { id:gazeDelay; interval:260; onTriggered:player.gazePose=player.pendingGaze }
    Timer { id:blinkTimer; onTriggered:{ player.blinking=true; blinkRelease.start() } }
    Timer { id:blinkRelease; interval:(App.animations.blink || {}).closedMs || 110; onTriggered:{ player.blinking=false; player.scheduleBlink() } }
    Timer {
        id: stepTimer
        repeat: false
        onTriggered: {
            if (player.keyIndex + 1 < player.sequence.keys.length) player.keyIndex++
            else if (player.sequence.loop) player.keyIndex = 0
            else return
            player.applyKey()
        }
    }
    Timer {
        // Subpixel breathing needs no monitor-rate animation (often 144+ Hz).
        // Larger, occasional gestures still use the scene graph's smooth tweens.
        id:breathTimer; running:player.breathing; interval:50; repeat:true
        onTriggered: {
            const config=App.animations.breathing || ({})
            const inhale=config.inhaleMs || 2600, exhale=config.exhaleMs || 3400
            player.breathPhase=(player.breathPhase+interval)%(inhale+exhale)
            player.breath=player.breathPhase<inhale
                ? (1-Math.cos(Math.PI*player.breathPhase/inhale))/2
                : (1+Math.cos(Math.PI*(player.breathPhase-inhale)/exhale))/2
        }
    }
    NumberAnimation { id:dissolve; target:player; property:"blend"; from:0; to:1; easing.type:Easing.InOutSine }
    ParallelAnimation {
        id: movement
        NumberAnimation { target:player; property:"shiftX"; to:player.targetKey.x || 0; duration:player.tweenMs; easing.type:Easing.InOutSine }
        NumberAnimation { target:player; property:"shiftY"; to:player.targetKey.y || 0; duration:player.tweenMs; easing.type:Easing.InOutSine }
        NumberAnimation { target:player; property:"angle"; to:player.targetKey.rotation || 0; duration:player.tweenMs; easing.type:Easing.InOutSine }
        NumberAnimation { target:player; property:"stretchX"; to:player.targetKey.sx || 1; duration:player.tweenMs; easing.type:Easing.InOutSine }
        NumberAnimation { target:player; property:"stretchY"; to:player.targetKey.sy || 1; duration:player.tweenMs; easing.type:Easing.InOutSine }
    }
    // Decode once, then let Qt reuse its texture cache for both pose layers.
    Repeater {
        model: (App.animations.frames || []).length
        CereSprite { required property int index; pose:index; visible:false; width:1; height:1 }
    }
    Item {
        id: artwork
        width:parent.width*0.9; height:parent.height*0.9
        x:(parent.width-width)/2 + player.shiftX*parent.width/192
        y:parent.height-height-2 + player.shiftY*parent.height/208
        rotation:player.angle
        transformOrigin:Item.Bottom
        transform:Scale {
            origin.x:artwork.width/2; origin.y:artwork.height
            xScale:player.stretchX
            yScale:player.stretchY + player.breath * player.intensity * ((App.animations.breathing || {}).amount || 0.006)
        }
        CereSprite { pose:player.previousPose; anchors.fill:parent; opacity:1-player.blend; visible:opacity>0 }
        CereSprite { pose:player.shownPose; anchors.fill:parent; opacity:player.blend }
    }
    Rectangle {
        anchors.top:parent.top; anchors.right:parent.right
        anchors.topMargin:2; anchors.rightMargin:Math.max(4,parent.width*0.07)
        width:25; height:23; radius:9
        visible:player.symbol.length>0
        color:"#ed10212c"; border.color:["error","problem","waiting","approval"].indexOf(player.motion)>=0 ? Theme.amber : Theme.cyan
        Text { anchors.centerIn:parent; text:player.symbol; color:parent.border.color; font.pixelSize:14; font.family:Theme.font }
    }
}
