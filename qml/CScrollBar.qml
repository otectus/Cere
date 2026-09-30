import QtQuick
import QtQuick.Controls
ScrollBar {
    id: bar
    policy: ScrollBar.AsNeeded
    minimumSize: 0.08
    padding: 2
    implicitWidth: 10
    contentItem: Rectangle {
        implicitWidth: 6; implicitHeight: 40; radius: 3
        color: bar.pressed ? Theme.cyan : bar.hovered ? "#658196" : "#344c60"
        opacity: bar.size < 1 ? 1 : 0
    }
    background: Rectangle { color: "transparent" }
}
