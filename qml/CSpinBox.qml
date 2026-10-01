import QtQuick
import QtQuick.Controls
SpinBox {
    id: control
    implicitWidth: 128; implicitHeight: 40
    leftPadding: 36; rightPadding: 36; editable: true
    font.family: Theme.font; font.pixelSize: Theme.body
    background: Rectangle { color: Theme.input; radius: Theme.radiusControl; border.color: control.activeFocus ? Theme.focus : control.hovered ? Theme.borderHover : Theme.border; border.width: control.activeFocus ? Theme.focusWidth : 1 }
    contentItem: TextInput {
        text: control.textFromValue(control.value,control.locale)
        font: control.font; color: Theme.text
        horizontalAlignment: Qt.AlignHCenter; verticalAlignment: Qt.AlignVCenter
        readOnly: !control.editable; validator: control.validator; selectByMouse: true
        inputMethodHints: Qt.ImhDigitsOnly
    }
    down.indicator: Rectangle {
        x: 2; y: 2; width: 32; height: control.height-4; radius: Theme.radiusChip
        color: control.down.pressed ? Theme.selected : control.down.hovered ? Theme.raised : "transparent"
        Text { anchors.centerIn: parent; text: "−"; color: control.down.enabled ? Theme.cyan : Theme.muted; font.family: Theme.font; font.pixelSize: Theme.glyph }
    }
    up.indicator: Rectangle {
        x: control.width-width-2; y: 2; width: 32; height: control.height-4; radius: Theme.radiusChip
        color: control.up.pressed ? Theme.selected : control.up.hovered ? Theme.raised : "transparent"
        Text { anchors.centerIn: parent; text: "+"; color: control.up.enabled ? Theme.cyan : Theme.muted; font.family: Theme.font; font.pixelSize: Theme.glyph }
    }
}
