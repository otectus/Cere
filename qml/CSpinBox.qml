import QtQuick
import QtQuick.Controls
SpinBox {
    id: control
    implicitWidth: 128; implicitHeight: 40
    leftPadding: 36; rightPadding: 36; editable: true
    font.family: Theme.font; font.pixelSize: 13
    background: Rectangle { color: Theme.input; radius: 7; border.color: control.activeFocus ? Theme.cyan : Theme.line }
    contentItem: TextInput {
        text: control.textFromValue(control.value,control.locale)
        font: control.font; color: Theme.text
        horizontalAlignment: Qt.AlignHCenter; verticalAlignment: Qt.AlignVCenter
        readOnly: !control.editable; validator: control.validator; selectByMouse: true
        inputMethodHints: Qt.ImhDigitsOnly
    }
    down.indicator: Rectangle {
        x: 1; y: 1; width: 32; height: control.height-2; radius: 6
        color: control.down.pressed ? Theme.selected : control.down.hovered ? Theme.raised : "transparent"
        Text { anchors.centerIn: parent; text: "−"; color: control.down.enabled ? Theme.cyan : Theme.muted; font.pixelSize: 19 }
    }
    up.indicator: Rectangle {
        x: control.width-width-1; y: 1; width: 32; height: control.height-2; radius: 6
        color: control.up.pressed ? Theme.selected : control.up.hovered ? Theme.raised : "transparent"
        Text { anchors.centerIn: parent; text: "+"; color: control.up.enabled ? Theme.cyan : Theme.muted; font.pixelSize: 19 }
    }
}
