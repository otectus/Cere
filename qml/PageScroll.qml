import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window
Flickable {
    id: scroll
    default property alias body: column.data
    property real maximumContentWidth: 1120
    readonly property real bodyWidth: column.width
    clip: true
    contentWidth: width
    contentHeight: column.implicitHeight + 8
    boundsBehavior: Flickable.StopAtBounds
    flickableDirection: Flickable.VerticalFlick
    ScrollBar.vertical: CScrollBar {}
    ColumnLayout {
        id: column
        width: Math.max(0, Math.min(scroll.width - 16, scroll.maximumContentWidth))
        x: Math.max(0, (scroll.width - 16 - width) / 2)
        spacing: 14
    }
    function reveal(item) {
        let ancestor = item
        while (ancestor && ancestor !== column) ancestor = ancestor.parent
        if (!ancestor || !item) return
        const point = item.mapToItem(column, 0, 0)
        if (point.y < contentY) contentY = Math.max(0, point.y - 8)
        else if (point.y + item.height > contentY + height)
            contentY = Math.min(Math.max(0, contentHeight-height), point.y + item.height-height+8)
    }
    Connections {
        target: scroll.Window.window
        function onActiveFocusItemChanged() { scroll.reveal(scroll.Window.window.activeFocusItem) }
    }
    onHeightChanged: contentY = Math.max(0, Math.min(contentY, contentHeight-height))
    onContentHeightChanged: contentY = Math.max(0, Math.min(contentY, contentHeight-height))
}
