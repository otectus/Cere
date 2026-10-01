import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Popup {
    id: dialog
    default property alias body: bodyColumn.data
    property Component footerContent:null
    readonly property real footerHeight:footerLoader.item?footerLoader.item.implicitHeight+14:0
    parent: Overlay.overlay
    anchors.centerIn: parent
    width: Math.min(520, parent ? parent.width-32 : 520)
    implicitHeight: Math.min(bodyColumn.implicitHeight+48+footerHeight, parent ? parent.height-32 : 720)
    modal: true; dim: true; focus: true; padding: 24; margins: 16
    bottomPadding:24+footerHeight
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
    background: Rectangle {
        color: Theme.surface; radius: Theme.radiusDialog; border.color: Theme.borderStrong
        Loader { id:footerLoader;anchors.left:parent.left;anchors.right:parent.right;anchors.bottom:parent.bottom;anchors.margins:24;sourceComponent:dialog.footerContent }
    }
    Overlay.modal: Rectangle { color: Theme.overlayScrim }
    contentItem: ScrollView {
        id: viewport
        clip: true; contentWidth: availableWidth; contentHeight: bodyColumn.implicitHeight
        rightPadding: contentHeight>availableHeight ? 12 : 0
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical: CScrollBar { parent:viewport;x:viewport.width-width;y:viewport.topPadding;height:viewport.availableHeight }
        ColumnLayout { id: bodyColumn; width: viewport.availableWidth; spacing: 14 }
    }
}
