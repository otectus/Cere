import QtQuick
import QtQuick.Controls
Item {
    id: pet
    width: 192; height: 208
    Accessible.role: Accessible.Button
    Accessible.name: "Cere, " + (((App.animations.clips || {})[App.motion] || {}).label || "Open Cere")
    Accessible.onPressAction: App.togglePanel()
    property var settings: App.state.settings || ({})
    property bool dragging: false
    property point pressPoint
    // Only the primary surface advances placement; the seam mirror is visual.
    property bool motionDriver: true
    property alias animationPlayer: art
    property alias motionSource: art.mirrorSource
    FrameAnimation {
        running: pet.visible && pet.motionDriver && App.petMoving
        onTriggered: App.advancePetMotion()
    }
    property int busy: (App.state.sessions || []).filter(s => ["working","starting","stopping"].indexOf(s.status) >= 0).length
    property int waiting: (App.state.approvals || []).length
    GesturePlayer {
        id: art
        anchors.fill: parent
        clip: true
        transform: Translate { x: App.petSubpixel.x; y: App.petSubpixel.y }
    }
    MouseArea {
        id:petMouse
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        hoverEnabled: true
        cursorShape: pet.dragging ? Qt.ClosedHandCursor : Qt.OpenHandCursor
        onPressed: mouse => { App.setPetInteracting(true);pet.pressPoint = Qt.point(mouse.x,mouse.y);pet.dragging = false }
        onPositionChanged: mouse => {
            if (!pressed) art.gazeAt(mouse.x/width, mouse.y/height)
            if (!pressed || pressedButtons !== Qt.LeftButton) return
            if (!pet.dragging && Math.hypot(mouse.x-pet.pressPoint.x, mouse.y-pet.pressPoint.y)>6) { pet.dragging=true; App.beginDrag(pet.pressPoint.x,pet.pressPoint.y) }
            if (pet.dragging) App.drag(mouse.x,mouse.y)
        }
        onReleased: mouse => {
            if(pet.dragging) { App.endDrag(); pet.dragging=false }
            else if(mouse.button === Qt.RightButton) context.popup()
            else App.togglePanel()
            App.setPetInteracting(containsMouse||context.visible)
        }
        onCanceled: { if(pet.dragging)App.endDrag();pet.dragging=false;App.setPetInteracting(containsMouse||context.visible) }
        onEntered: { App.setPetInteracting(true);if(!pet.busy&&!pet.waiting)App.preview("attentive") }
        onExited: { art.clearGaze(); if(!pressed&&!context.visible)App.setPetInteracting(false) }
    }
    CMenu {
        id: context
        onVisibleChanged: App.setPetInteracting(visible||petMouse.containsMouse||petMouse.pressed)
        CMenuItem { text: "Open Cere"; onTriggered: App.togglePanel() }
        CMenuItem { text: "Expand workspace"; onTriggered: App.expand() }
        CMenuSeparator {}
        CMenuItem { text: "Always on top"; checkable: true; checked: settings.topmost === true; onTriggered: App.rpc("settings.update",{topmost:!checked ? false : true}) }
        CMenu { title: "Size"; Repeater { model: [0.75,1,1.5,2,3]; CMenuItem { required property real modelData; text: Math.round(modelData*100)+"%"; onTriggered: App.resizePet(modelData) } } }
        CMenuItem { text: "Roaming · follow mouse"; checkable: true; checked: settings.roaming === true; onTriggered: App.rpc("settings.update",{roaming:checked}) }
        CMenuItem { text: "Quiet mode"; checkable: true; checked: settings.quiet === true; onTriggered: App.rpc("settings.update",{quiet:checked}) }
        CMenuItem { text: "Hide Cere"; onTriggered: App.rpc("settings.update",{hidden:true}) }
    }
}
