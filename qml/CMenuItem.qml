import QtQuick
import QtQuick.Controls
MenuItem {
    id: item
    // A hidden entry takes no room, so menus can list optional actions.
    implicitHeight: visible ? 34 : 0
    implicitWidth: 220
    leftPadding: 12; rightPadding: 12
    font.family: Theme.font; font.pixelSize: Theme.body
    contentItem: Text {
        leftPadding: item.checkable ? item.indicator.width + 8 : 0
        rightPadding: item.subMenu ? 18 : 0
        text: item.text; font: item.font; textFormat: Text.PlainText
        color: item.enabled ? Theme.text : Theme.muted
        elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter
    }
    indicator: Rectangle {
        visible: item.checkable
        x: item.leftPadding; y: (item.height - height) / 2
        width: 16; height: 16; radius: 4
        color: item.checked ? Theme.cyan : Theme.input
        border.color: item.checked ? Theme.cyan : Theme.border
        Text { anchors.centerIn: parent; visible: item.checked; text: "✓"; color: Theme.background; font.family: Theme.font; font.pixelSize: Theme.caption; font.bold: true }
    }
    arrow: Text {
        visible: !!item.subMenu
        x: item.width - width - item.rightPadding; y: (item.height - height) / 2
        text: "›"; color: Theme.muted; font.family: Theme.font; font.pixelSize: Theme.section
    }
    background: Rectangle {
        radius: Theme.radiusChip
        color: item.highlighted ? Theme.selected : "transparent"
        border.color: item.visualFocus ? Theme.focus : "transparent"
        border.width: Theme.focusWidth
    }
}
