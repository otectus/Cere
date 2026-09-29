import QtQuick
import QtQuick.Controls
Slider {
    id: control
    implicitHeight: 32
    implicitWidth: 160
    padding: 9
    background: Rectangle {
        x: control.leftPadding; y: (control.height-height)/2
        width: control.availableWidth; height: 4; radius: 2; color: Theme.line
        Rectangle { width: control.visualPosition*parent.width; height: parent.height; radius: 2; color: control.enabled ? Theme.cyan : Theme.muted }
    }
    handle: Rectangle {
        x: control.leftPadding + control.visualPosition*(control.availableWidth-width)
        y: (control.height-height)/2
        width: 18; height: 18; radius: 9
        color: control.enabled ? Theme.text : Theme.muted
        border.color: control.activeFocus || control.pressed ? Theme.cyan : Theme.line
        border.width: control.activeFocus || control.pressed ? 3 : 2
    }
}
