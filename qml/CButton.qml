import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Button {
    id: control
    property bool primary: false
    property bool danger: false
    property string help: ""
    Layout.minimumWidth: 0
    implicitHeight: 38
    implicitWidth: Math.max(36, contentItem.implicitWidth + 24)
    leftPadding: 12; rightPadding: 12
    topPadding: 6; bottomPadding: 6
    hoverEnabled: true
    font.family: Theme.font
    font.pixelSize: 13
    Accessible.name: text
    ToolTip.visible: hovered && (help.length>0 || contentItem.truncated === true)
    ToolTip.text: help || text
    ToolTip.delay: 600
    background: Rectangle {
        radius: 7
        color: !control.enabled ? Theme.surface : control.down ? "#355367" : control.primary ? Theme.selected : control.hovered ? Theme.raised : Theme.input
        border.color: control.activeFocus ? Theme.cyan : control.primary ? "#4288a4" : control.danger ? "#825361" : Theme.line
        border.width: control.activeFocus ? 2 : 1
    }
    contentItem: Text {
        text: control.text
        font: control.font
        color: !control.enabled ? "#64788a" : control.danger ? Theme.danger : control.primary ? Theme.cyan : Theme.text
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
        textFormat: Text.PlainText
    }
}
