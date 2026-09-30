import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Button {
    id: control
    property bool primary: false
    property bool danger: false
    property bool quiet: false
    property bool alignLeft: false
    property string iconName: ""
    property string help: ""
    Layout.minimumWidth: 0
    implicitHeight: 40
    implicitWidth: Math.max(40, contentItem.implicitWidth + 28)
    leftPadding: 12; rightPadding: 12
    topPadding: 6; bottomPadding: 6
    hoverEnabled: true
    font.family: Theme.font
    font.pixelSize: 13
    Accessible.name: text
    ToolTip.visible: hovered && (help.length>0 || label.truncated)
    ToolTip.text: help || text
    ToolTip.delay: 600
    background: Rectangle {
        radius: 9
        color: !control.enabled ? Theme.surface : control.down ? Theme.selected : control.primary ? Theme.selected : control.hovered ? Theme.raised : control.quiet ? "transparent" : Theme.surface
        border.color: control.activeFocus ? Theme.cyan : control.primary ? "#235677" : control.danger ? "#704452" : control.quiet ? "transparent" : Theme.line
        border.width: control.activeFocus ? 2 : 1
        Behavior on color { ColorAnimation { duration: Theme.reducedMotion ? 0 : 100 } }
    }
    contentItem: RowLayout {
        spacing: 8
        CIcon { visible: control.iconName.length>0; name: control.iconName; color: label.color; Layout.preferredWidth:20; Layout.preferredHeight:20 }
        Text {
            id: label
            Layout.fillWidth:true; Layout.minimumWidth:0
            text: control.text; font: control.font
            color: !control.enabled ? Theme.muted : control.danger ? Theme.danger : control.primary ? Theme.cyan : Theme.text
            horizontalAlignment: control.alignLeft ? Text.AlignLeft : Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight; textFormat: Text.PlainText
        }
    }
}
