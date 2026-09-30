import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
TextField {
    id: control
    implicitHeight: 42
    implicitWidth: 180
    Layout.minimumWidth: 0
    color: Theme.text
    placeholderTextColor: Theme.muted
    selectionColor: Theme.selected
    selectedTextColor: Theme.text
    font.family: Theme.font
    font.pixelSize: 13
    leftPadding: 12
    rightPadding: 12
    selectByMouse: true
    background: Rectangle { color: Theme.input; radius: 9; border.color: control.activeFocus ? Theme.cyan : control.hovered ? "#426078" : Theme.line; border.width: control.activeFocus ? 2 : 1 }
}
