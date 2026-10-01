import QtQuick
import QtQuick.Controls
// Context and overflow menus use the panels' palette, type and focus style.
Menu {
    id: menu
    padding: 4
    delegate: CMenuItem {}
    background: Rectangle {
        implicitWidth: 220
        color: Theme.raised; radius: Theme.radiusControl
        border.color: Theme.borderStrong
    }
}
