import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Popup {
    id: dialog
    default property alias body: bodyColumn.data
    parent: Overlay.overlay
    anchors.centerIn: parent
    width: Math.min(520, parent ? parent.width-32 : 520)
    implicitHeight: Math.min(bodyColumn.implicitHeight+48, parent ? parent.height-32 : 720)
    modal: true; dim: true; focus: true; padding: 24; margins: 16
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
    background: Rectangle { color: Theme.surface; radius: 16; border.color: "#36536a" }
    Overlay.modal: Rectangle { color: "#b304090f" }
    contentItem: ScrollView {
        id: viewport
        clip: true; contentWidth: availableWidth; contentHeight: bodyColumn.implicitHeight
        rightPadding: contentHeight>availableHeight ? 12 : 0
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical: CScrollBar { parent:viewport;x:viewport.width-width;y:viewport.topPadding;height:viewport.availableHeight }
        ColumnLayout { id: bodyColumn; width: viewport.availableWidth; spacing: 14 }
    }
}
