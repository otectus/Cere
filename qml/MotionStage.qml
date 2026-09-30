import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: stage
    objectName: "motionStage"
    implicitHeight: 320
    color: "#101d29"
    radius: 14
    border.color: "#2a4356"
    property bool playing: false
    property int step: 0
    property var program: [
        {motion:"idle", ms:6500, caption:"A moment to herself"},
        {motion:"wave", ms:3400, caption:"Oh, there you are"},
        {motion:"glassesAdjust", ms:3400, caption:"One tiny adjustment"},
        {motion:"thinking", ms:4200, caption:"Give her a moment…"},
        {motion:"speaking", ms:4200, caption:"She has a few thoughts"},
        {motion:"hairTuck", ms:3300, caption:"That lock of hair again"},
        {motion:"idle", ms:4000, caption:"Right here with you"}
    ]
    readonly property var preferences: App.state.settings || ({})
    readonly property bool allowed: !preferences.quiet && !preferences.reducedMotion && preferences.motionIntensity !== 0
    onAllowedChanged: if (!allowed) playing = false
    onVisibleChanged: if (!visible) playing = false
    function start() { step = 0; playing = true; actor.play(); next.restart() }

    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        y: 28; width: 202; height: 202; radius: 101
        color: "#182d3c"
        border.color: "#244254"
    }
    GesturePlayer {
        id: actor
        objectName: "motionStagePlayer"
        width: 208; height: 225
        anchors.horizontalCenter: parent.horizontalCenter
        y: 13
        followAppMotion: false
        motion: stage.program[stage.step].motion
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
            text: stage.playing ? stage.program[stage.step].caption : "A little more Cere"
            color: Theme.muted; font.pixelSize: 12
        }
        CButton {
            objectName: "playMotionShowcase"
            Layout.alignment: Qt.AlignHCenter
            enabled: stage.allowed
            text: stage.playing ? "Pause preview" : "Spend a moment with Cere"
            onClicked: { if (stage.playing) stage.playing = false; else stage.start() }
        }
    }
    Timer {
        id: next
        interval: stage.program[stage.step].ms
        running: stage.playing
        onTriggered: {
            if (stage.step + 1 < stage.program.length) { stage.step++; restart() }
            else stage.playing = false
        }
    }
}
