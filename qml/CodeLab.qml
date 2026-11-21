import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Code Lab in the Workbench: write or pick a recipe, choose this conversation's files as read-only
// inputs, and run it in the isolated runtime. The limits shown are the ones the runtime reports as
// enforced on this computer, nothing more.
ColumnLayout {
    id: lab
    objectName: "codeLab"
    property string sessionId: ""
    property var status: null
    property var files: []
    property var chosen: []
    property bool open: false
    property string error: ""
    signal started()
    spacing: 6
    RpcClient { id: rpc; scope: lab.sessionId }
    function refresh() {
        rpc.call("codelab.status", {}, value => { if (!value.error) lab.status = value })
        if (sessionId) rpc.call("artifacts.list", { sessionId: sessionId, limit: 100 }, value => { if (!value.error) lab.files = value.artifacts || [] })
    }
    Component.onCompleted: refresh()
    onSessionIdChanged: { files = []; chosen = []; error = ""; refresh() }
    RowLayout {
        Layout.fillWidth: true
        CButton { objectName: "codeLabToggle"; text: lab.open ? "Hide Code Lab" : "Code Lab"; iconName: "terminal"; quiet: !lab.open; onClicked: { lab.open = !lab.open; if (lab.open) lab.refresh() } }
    }
    CText { objectName: "codeLabStatus"; Layout.fillWidth: true; visible: !!lab.status; text: !lab.status ? "" : !lab.status.available ? lab.status.problem : !lab.status.enabled ? "Off: turn it on in Settings › Connections › Images & analysis" : "Python " + lab.status.runtime.python + " · no network · read-only inputs"; color: lab.status && lab.status.available && lab.status.enabled ? Theme.muted : Theme.amber; font.pixelSize: Theme.caption }
    ColumnLayout {
        visible: lab.open; Layout.fillWidth: true; spacing: 6
        CText { visible: !!lab.status && lab.status.available; color: Theme.muted; font.pixelSize: Theme.caption
            text: lab.status ? "Memory: " + lab.status.enforced.memory + ". Processes: " + lab.status.enforced.processes + ". Time: 60 s by default. Outputs: up to 20 files, 100 MiB." : "" }
        RowLayout {
            Layout.fillWidth: true
            CComboBox { id: recipe; objectName: "codeLabRecipe"; Layout.fillWidth: true; model: ["Start from a recipe…"].concat((lab.status?.recipes || []).map(r => r.label)); Accessible.name: "Recipe"
                onActivated: index => { if (index > 0) { code.text = lab.status.recipes[index - 1].code; purpose.text = lab.status.recipes[index - 1].label } } }
        }
        CField { id: purpose; objectName: "codeLabPurpose"; Layout.fillWidth: true; placeholderText: "What this run is for"; Accessible.name: "Purpose" }
        ScrollView {
            Layout.fillWidth: true; Layout.preferredHeight: 180; clip: true
            CTextArea { id: code; objectName: "codeLabCode"; font.family: "monospace"; font.pixelSize: Theme.caption; wrapMode: TextEdit.NoWrap; placeholderText: "# Python 3. Inputs are in /work/input; write results to /work/output."; Accessible.name: "Python code" }
        }
        CText { text: "Inputs (read-only copies):"; font.pixelSize: Theme.secondary }
        Flow {
            Layout.fillWidth: true; spacing: 6
            Repeater {
                model: lab.files
                CCheckBox {
                    required property var modelData
                    width: implicitContentWidth + leftPadding + rightPadding; text: modelData.name; checked: lab.chosen.some(c => c.artifactId === modelData.id)
                    onToggled: lab.chosen = checked ? lab.chosen.concat([{ artifactId: modelData.id, versionId: modelData.latestVersionId }]) : lab.chosen.filter(c => c.artifactId !== modelData.id)
                }
            }
            CText { visible: !lab.files.length; width: implicitWidth; text: "No files in this conversation yet: import one in Images, or attach one from Files."; color: Theme.muted; font.pixelSize: Theme.caption }
        }
        CText { visible: !!lab.error; text: lab.error; color: Theme.danger; font.pixelSize: Theme.caption }
        RowLayout {
            Layout.fillWidth: true
            CButton { objectName: "codeLabRun"; text: "Run"; primary: true; enabled: !!lab.status && lab.status.available && lab.status.enabled && code.text.trim().length > 0
                onClicked: rpc.call("codelab.run", { sessionId: lab.sessionId, code: code.text, inputs: lab.chosen, purpose: purpose.text || "Run from the Workbench" }, value => { lab.error = value.error || ""; if (!value.error) lab.started() }) }
            CButton { objectName: "codeLabGrant"; text: "Let " + App.assistantName + " run code for 30 minutes"; quiet: true; visible: !!lab.status && lab.status.available && lab.status.enabled
                help: "Up to 10 Code Lab runs without asking each time. Commands in your folders always ask."
                onClicked: rpc.call("codelab.grant", { sessionId: lab.sessionId, minutes: 30, maxRuns: 10 }, value => lab.error = value.error || "") }
        }
    }
}
