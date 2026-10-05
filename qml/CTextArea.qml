import QtQuick
import QtQuick.Controls
// Multi-line fields share the single-line field's boundary, focus ring and type.
TextArea {
    id: control
    color: Theme.text
    placeholderTextColor: Theme.muted
    selectionColor: Theme.selected
    selectedTextColor: Theme.text
    font.family: Theme.font
    font.pixelSize: Theme.body
    wrapMode: TextEdit.Wrap
    selectByMouse: true
    leftPadding: 10; rightPadding: 10; topPadding: 8; bottomPadding: 8
    // Tab and Shift+Tab move between controls, so an editor never traps the keyboard.
    Keys.onTabPressed: event => { const next = control.nextItemInFocusChain(true); if (next && next !== control) next.forceActiveFocus(Qt.TabFocusReason); event.accepted = true }
    Keys.onBacktabPressed: event => { const previous = control.nextItemInFocusChain(false); if (previous && previous !== control) previous.forceActiveFocus(Qt.BacktabFocusReason); event.accepted = true }
    background: Rectangle {
        color: Theme.input; radius: Theme.radiusControl
        border.color: control.activeFocus ? Theme.focus : control.hovered ? Theme.borderHover : Theme.border
        border.width: control.activeFocus ? Theme.focusWidth : 1
    }
}
