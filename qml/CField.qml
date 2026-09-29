import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
TextField {
    id: control
    implicitHeight: 40
    implicitWidth: 180
    Layout.minimumWidth: 0
    color: Theme.text
    placeholderTextColor: Theme.muted
    selectionColor: "#396982"
    font.family: Theme.font
    font.pixelSize: 13
    leftPadding: 12
    rightPadding: 12
    selectByMouse: true
    background: Rectangle { color: Theme.input; radius: 7; border.color: control.activeFocus ? Theme.cyan : Theme.line; border.width: control.activeFocus ? 2 : 1 }
}
