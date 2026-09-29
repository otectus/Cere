import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CheckBox {
    id: control
    Layout.fillWidth: true
    Layout.minimumWidth: 0
    implicitWidth: 200
    implicitHeight: Math.max(32, label.implicitHeight+8)
    spacing: 10; padding: 4
    font.family: Theme.font; font.pixelSize: 13
    Accessible.name: text
    indicator: Rectangle {
        x: control.leftPadding; y: (control.height-height)/2
        width: 20; height: 20; radius: 5
        color: control.checked ? Theme.cyan : Theme.input
        border.color: control.activeFocus || control.hovered ? Theme.cyan : Theme.line
        border.width: control.activeFocus ? 2 : 1
        opacity: control.enabled ? 1 : 0.45
        Text { anchors.centerIn: parent; text: "✓"; visible: control.checked; color: Theme.background; font.pixelSize: 15; font.bold: true }
    }
    contentItem: Text {
        id: label
        text: control.text; font: control.font; color: control.enabled ? Theme.text : Theme.muted
        leftPadding: control.indicator.width+control.spacing
        verticalAlignment: Text.AlignVCenter; wrapMode: Text.Wrap; textFormat: Text.PlainText
    }
}
