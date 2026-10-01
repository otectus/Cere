import QtQuick
import QtQuick.Controls
// A 12 px track with a thumb that stays visible (3:1 or more) whenever there is more to see.
ScrollBar {
    id: bar
    policy: ScrollBar.AsNeeded
    minimumSize: 0.08
    padding: 2
    Accessible.name: bar.horizontal ? "Horizontal scroll bar" : "Vertical scroll bar"
    contentItem: Rectangle {
        implicitWidth: 8; implicitHeight: 8; radius: 4
        color: bar.pressed ? Theme.cyan : bar.hovered ? Theme.scrollThumbHover : Theme.scrollThumb
        opacity: bar.size < 1 ? 1 : 0
    }
    background: Rectangle { color: "transparent" }
}
