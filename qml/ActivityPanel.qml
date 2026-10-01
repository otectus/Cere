import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: panel
    property bool expanded: false
    property real maximumHeight: 260
    property bool follow: true
    property var expandedAgents: ({})
    property string sessionId: App.selectedId
    readonly property var agents: App.session.agents || []
    readonly property var activeAgents: agents.filter(agent => ["starting", "running", "waiting"].indexOf(agent.status) >= 0)
    readonly property var pendingInput: (App.state.approvals || []).filter(approval => approval.sessionId === sessionId)
    readonly property string activityLabel: {
        switch (App.session.activity) {
        case "thinking": return "Thinking"
        case "speaking": return "Responding"
        case "working": return "Using tools"
        case "delegating": return "Delegating"
        case "waitingForAgents": return "Waiting for subagents"
        case "compacting": return "Compacting context"
        case "planning": return "Planning"
        default: return ""
        }
    }
    readonly property string summary: {
        const parts = []
        if (activeAgents.length) parts.push(activeAgents.length + (activeAgents.length === 1 ? " subagent active" : " subagents active"))
        if (pendingInput.length) parts.push(pendingInput.length + (pendingInput.length === 1 ? " input needed" : " inputs needed"))
        if (activityLabel && !activeAgents.length && !pendingInput.length) parts.push(activityLabel)
        if (!parts.length && App.activityCount) parts.push(App.activityCount + (App.activityCount === 1 ? " tool event" : " tool events"))
        return parts.join(" · ")
    }

    spacing: 0
    implicitHeight: 36 + (expanded ? maximumHeight : 0)

    CButton {
        objectName: "activityToggle"
        Layout.fillWidth: true
        implicitHeight: 36
        quiet: true
        alignLeft: true
        text: (panel.expanded ? "▾  " : "▸  ") + "Activity" + (panel.summary ? " · " + panel.summary : "")
        help: panel.expanded ? "Hide subagent and tool activity" : "Show subagent and tool activity"
        Accessible.name: "Activity"
        Accessible.description: panel.summary || help
        onClicked: panel.expanded = !panel.expanded
    }
    Rectangle {
        visible: panel.expanded
        Layout.fillWidth: true
        Layout.preferredHeight: panel.maximumHeight
        color: Theme.input
        border.color: Theme.line
        radius: Theme.radiusControl
        clip: true

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 8
            spacing: 6

            RowLayout {
                visible: panel.agents.length > 0
                Layout.fillWidth: true
                CText {
                    Layout.fillWidth: true
                    text: "Subagents · " + panel.agents.length
                    color: Theme.muted
                    font.pixelSize: Theme.caption
                    font.bold: true
                }
                CText {
                    visible: panel.activeAgents.length > 0
                    text: panel.activeAgents.length + " active"
                    color: Theme.cyan
                    font.pixelSize: Theme.caption
                }
            }
            ScrollView {
                id: agentViewport
                visible: panel.agents.length > 0
                Layout.fillWidth: true
                Layout.fillHeight: App.activityCount === 0
                Layout.preferredHeight: App.activityCount > 0
                    ? Math.min(agentColumn.implicitHeight, panel.maximumHeight * 0.48)
                    : -1
                clip: true
                contentWidth: availableWidth
                contentHeight: agentColumn.implicitHeight
                ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                ScrollBar.vertical: CScrollBar {}
                Column {
                    id: agentColumn
                    width: agentViewport.availableWidth
                    spacing: 6
                    Repeater {
                        model: panel.agents
                        AgentCard {
                            required property var modelData
                            width: agentColumn.width
                            agent: modelData
                            expanded: panel.expandedAgents[modelData.id] === true
                            onExpansionRequested: open => {
                                const next = Object.assign({}, panel.expandedAgents)
                                next[modelData.id] = open
                                panel.expandedAgents = next
                            }
                        }
                    }
                }
            }
            CText {
                visible: App.activityCount > 0
                Layout.fillWidth: true
                text: "Tool activity · " + App.activityCount
                color: Theme.muted
                font.pixelSize: Theme.caption
                font.bold: true
            }
            ListView {
                id: activity
                objectName: "toolActivity"
                visible: App.activityCount > 0
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                model: App.activity
                spacing: 8
                cacheBuffer: 120
                reuseItems: true
                ScrollBar.vertical: CScrollBar {}
                delegate: MessageCard {
                    required property var entry
                    width: activity.width - 12
                    message: entry
                    collapsed: false
                }
                onMovementStarted: panel.follow = false
                onMovementEnded: if (atYEnd) panel.follow = true
                onContentHeightChanged: if (panel.follow) Qt.callLater(() => activity.positionViewAtEnd())
            }
            CText {
                Layout.fillWidth: true
                Layout.fillHeight: true
                visible: panel.agents.length === 0 && App.activityCount === 0
                text: panel.pendingInput.length ? "Waiting for your response." : "Subagent and tool activity will appear here."
                color: Theme.muted
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                wrapMode: Text.Wrap
            }
        }
        CButton {
            visible: !panel.follow && App.activityCount > 0
            anchors.bottom: parent.bottom
            anchors.horizontalCenter: parent.horizontalCenter
            text: "↓ Latest activity"
            onClicked: {
                panel.follow = true
                activity.positionViewAtEnd()
            }
        }
    }

    onExpandedChanged: if (expanded && follow) Qt.callLater(() => activity.positionViewAtEnd())
    onSessionIdChanged: { follow = true; expandedAgents = ({}) }
}
