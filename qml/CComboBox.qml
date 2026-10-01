import QtQuick
import QtQuick.Controls
ComboBox {
    id: control
    implicitHeight: 42
    implicitWidth: 200
    leftPadding: 12; rightPadding: 32
    font.family: Theme.font; font.pixelSize: Theme.body
    background: Rectangle { radius: Theme.radiusControl; color: Theme.input; border.color: control.activeFocus ? Theme.focus : control.hovered ? Theme.borderHover : Theme.border; border.width: control.activeFocus ? Theme.focusWidth : 1 }
    contentItem: Text {
        text: control.displayText; font: control.font
        color: control.enabled ? Theme.text : Theme.muted
        verticalAlignment: Text.AlignVCenter; elide: Text.ElideRight; textFormat: Text.PlainText
    }
    indicator: Text { x: control.width-width-12; y: (control.height-height)/2; text: "⌄"; font.family: Theme.font; font.pixelSize: Theme.glyph; color: Theme.muted }
    delegate: ItemDelegate {
        required property int index
        width: control.width-8
        text: control.textAt(index)
        font: control.font
        highlighted: control.highlightedIndex===index
        contentItem: Text { text: parent.text; font: control.font; color: parent.highlighted ? Theme.cyan : Theme.text; elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter }
        background: Rectangle { radius: Theme.radiusChip; color: parent.highlighted ? Theme.selected : "transparent" }
    }
    popup: Popup {
        y: control.height+5; width: control.width; padding: 4
        implicitHeight: Math.min(260, menu.contentHeight+8)
        background: Rectangle { color: Theme.raised; border.color: Theme.borderStrong; radius: Theme.radiusControl }
        contentItem: ListView {
            id: menu; clip: true; implicitHeight: contentHeight
            model: control.popup.visible ? control.delegateModel : null
            currentIndex: control.highlightedIndex
            ScrollBar.vertical: CScrollBar {}
        }
    }
}
