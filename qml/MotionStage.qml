import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: stage
    objectName: "motionStage"
    implicitHeight: 320
    color: Theme.stageSurface
    radius: 14
    border.color: Theme.stageBorder
    property bool playing: false
    property int step: 0
    property var program: ((App.animations.idleProfiles || {})[preferences.idleEnergy || App.animations.defaultIdleProfile] || {}).preview || []
    readonly property var current: program.length ? program[Math.min(step,program.length-1)] : ({motion:"idle",caption:"",ms:1000})
    onProgramChanged: { playing = false; step = 0 }
    readonly property var preferences: App.state.settings || ({})
    readonly property bool allowed: !preferences.quiet && !preferences.reducedMotion && preferences.motionIntensity !== 0
    onAllowedChanged: if (!allowed) playing = false
    onVisibleChanged: if (!visible) playing = false
    function start() { if (!allowed || !program.length) return; step = 0; playing = true; actor.play(); next.restart() }

    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        y: 28; width: 202; height: 202; radius: 101
        color: Theme.stageSpotlight
        border.color: Theme.stageSpotlightBorder
    }
    GesturePlayer {
        id: actor
        objectName: "motionStagePlayer"
        width: 208; height: 225
        anchors.horizontalCenter: parent.horizontalCenter
        y: 13
        followAppMotion: false
        motion: stage.current.motion
        active: stage.playing && stage.allowed && visible
        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            acceptedButtons: Qt.NoButton
            onPositionChanged: mouse => actor.gazeAt(mouse.x / width, mouse.y / height)
            onExited: actor.clearGaze()
        }
    }
    ColumnLayout {
        anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
        anchors.margins: 12
        spacing: 7
        CText {
            Layout.alignment: Qt.AlignHCenter
            horizontalAlignment: Text.AlignHCenter
            text: stage.playing ? stage.current.caption : "A little more " + App.assistantName
            color: Theme.muted; font.pixelSize: 12
        }
        CButton {
            objectName: "playMotionShowcase"
            Layout.alignment: Qt.AlignHCenter
            enabled: stage.allowed && stage.program.length > 0
            text: stage.playing ? "Pause preview" : "Spend a moment with " + App.assistantName
            onClicked: { if (stage.playing) stage.playing = false; else stage.start() }
        }
    }
    Timer {
        id: next
        interval: stage.current.ms
        running: stage.playing
        onTriggered: {
            if (stage.step + 1 < stage.program.length) { stage.step++; restart() }
            else stage.playing = false
        }
    }
}
