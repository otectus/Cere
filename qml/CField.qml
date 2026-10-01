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
    font.pixelSize: Theme.body
    leftPadding: 12
    rightPadding: 12
    selectByMouse: true
    background: Rectangle { color: Theme.input; radius: Theme.radiusControl; border.color: control.activeFocus ? Theme.focus : control.hovered ? Theme.borderHover : Theme.border; border.width: control.activeFocus ? Theme.focusWidth : 1 }
}
