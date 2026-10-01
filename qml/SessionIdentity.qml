import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Labels.js" as Labels
// Who a request or result belongs to, on separate lines so a long title never pushes
// the project out of view: provider and session ID, the full title, then the project.
ColumnLayout {
    id: identity
    property string provider: ""
    property string sessionId: ""
    property string title: ""
    property string cwd: ""
    // Shown alone when there is no session to name.
    property string fallback: ""
    readonly property string heading: provider ? Labels.provider(provider) + " · " + sessionId.slice(0, 8) : fallback
    readonly property string text: [heading, title, cwd].filter(line => line.length > 0).join("\n")
    spacing: 1
    Accessible.role: Accessible.StaticText
    Accessible.name: text
    Text {
        Layout.fillWidth: true; Layout.minimumWidth: 0
        text: identity.heading; textFormat: Text.PlainText
        color: Theme.muted; font.family: Theme.font; font.pixelSize: Theme.caption; font.weight: Font.DemiBold
        elide: Text.ElideRight
    }
    Text {
        visible: identity.title.length > 0
        Layout.fillWidth: true; Layout.minimumWidth: 0
        text: identity.title; textFormat: Text.PlainText
        color: Theme.text; font.family: Theme.font; font.pixelSize: Theme.secondary
        wrapMode: Text.WrapAtWordBoundaryOrAnywhere
    }
    Text {
        id: project
        visible: identity.cwd.length > 0
        Layout.fillWidth: true; Layout.minimumWidth: 0
        text: identity.cwd; textFormat: Text.PlainText
        color: Theme.muted; font.family: Theme.font; font.pixelSize: Theme.caption
        maximumLineCount: 1; elide: Text.ElideMiddle
        HoverHandler { id: projectHover }
        ToolTip.visible: projectHover.hovered && project.truncated; ToolTip.text: project.text; ToolTip.delay: 600
    }
}
