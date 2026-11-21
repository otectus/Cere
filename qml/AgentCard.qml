import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: card
    property var agent: ({})
    property bool expanded: false
    signal expansionRequested(bool open)
    readonly property var relatedSession: (App.state.sessions || []).find(session => session.id === agent.id) || null
    readonly property bool active: ["starting", "running", "waiting"].indexOf(agent.status) >= 0
    readonly property string statusLabel: {
        switch (agent.status) {
        case "starting": return "Starting"
        case "running": return "Working"
        case "waiting": return "Waiting"
        case "completed": return "Completed"
        case "failed": return "Failed"
        case "interrupted": return "Interrupted"
        case "closed": return "Closed"
        default: return agent.status || "Unknown"
        }
    }
    readonly property color statusColor: agent.status === "failed" ? Theme.danger
        : agent.status === "waiting" ? Theme.amber
        : active ? Theme.accentText
        : Theme.muted
    Accessible.role: Accessible.Grouping
    Accessible.name: (agent.name || agent.id || "Subagent") + ", " + statusLabel
    Accessible.description: expanded ? "Details shown" : "Details hidden"

    implicitHeight: body.implicitHeight + 16
    radius: Theme.radiusControl
    color: expanded ? Theme.raised : Theme.surface
    border.color: active ? Theme.activeBorder : Theme.line

    ColumnLayout {
        id: body
        anchors.fill: parent
        anchors.margins: Theme.space2
        spacing: Theme.space2
        CButton {
            objectName: "agent_" + (card.agent.id || "")
            Layout.fillWidth: true
            implicitHeight: 32
            leftPadding: 8
            rightPadding: 8
            help: card.expanded ? "Hide subagent details" : "Show subagent details"
            Accessible.name: (card.agent.name || card.agent.id || "Subagent") + ", " + card.statusLabel
            Accessible.description: help
            Accessible.expanded: card.expanded
            onClicked: card.expansionRequested(!card.expanded)
            contentItem: RowLayout {
                spacing: 7
                Rectangle {
                    Layout.preferredWidth: 8
                    Layout.preferredHeight: 8
                    radius: 4
                    color: card.statusColor
                    Accessible.ignored: true
                }
                Text {
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    text: card.agent.name || card.agent.id || "Subagent"
                    textFormat: Text.PlainText
                    color: Theme.text
                    font.family: Theme.font
                    font.pixelSize: Theme.secondary
                    font.weight: Font.DemiBold
                    elide: Text.ElideRight
                }
                Text {
                    text: card.statusLabel
                    textFormat: Text.PlainText
                    color: card.statusColor
                    font.family: Theme.font
                    font.pixelSize: Theme.caption
                }
                Text {
                    text: card.expanded ? "▾" : "▸"
                    color: Theme.muted
                    font.pixelSize: Theme.secondary
                }
            }
        }
        ColumnLayout {
            visible: card.expanded
            Layout.fillWidth: true
            Layout.leftMargin: 8
            Layout.rightMargin: 8
            Layout.bottomMargin: Theme.space1
            spacing: Theme.space2
            CText {
                visible: !!card.agent.task
                Layout.fillWidth: true
                text: card.agent.task || ""
                textFormat: Text.PlainText
                color: Theme.text
                font.pixelSize: Theme.caption
                wrapMode: Text.Wrap
            }
            CText {
                visible: !!card.agent.detail
                Layout.fillWidth: true
                // A delegated conversation's result reads like its reply, without hidden memory citations.
                text: App.displayText(card.agent.detail || "", App.showMemoryCitations)
                textFormat: Text.PlainText
                color: card.agent.status === "failed" ? Theme.danger : Theme.muted
                font.pixelSize: Theme.caption
                wrapMode: Text.Wrap
            }
            CText {
                visible: !!card.agent.parentId
                Layout.fillWidth: true
                text: "Parent · " + String(card.agent.parentId).slice(0, 8)
                color: Theme.muted
                font.pixelSize: Theme.caption
            }
            CButton {
                visible: !!card.relatedSession && App.selectedId !== card.agent.id
                Layout.fillWidth: true
                text: "Open conversation"
                help: "Open this subagent's Cere conversation"
                onClicked: App.selectedId = card.agent.id
            }
        }
    }
}
