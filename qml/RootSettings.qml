import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench folder permissions: what a conversation may do in one folder and where its contents may be
// processed. Reading is always reviewed per folder; every change is a reviewed change set unless a
// bounded edit permission, shown here with its scope and expiry, covers it.
CDialog {
    id: dialog
    objectName: "rootSettings"
    property string sessionId: ""
    property var root: ({})
    property var grants: []
    property string error: ""
    readonly property bool adding: !root.id
    signal saved()
    RpcClient { id: rpc }
    function openFor(sessionId, root, grants) {
        dialog.sessionId = sessionId; dialog.root = root || ({}); dialog.grants = (grants || []).filter(g => g.rootId === dialog.root.id); error = ""
        const p = dialog.root.policy || {}
        write.checked = !!p.write; organize.checked = !!p.organize; hidden.checked = !!p.hidden; execute.checked = !!p.execute
        remote.checked = !!p.destinations?.remote; cloud.checked = !!p.destinations?.cloud; primary.checked = !!dialog.root.primary
        open()
    }
    function policy() { return { write: write.checked, organize: organize.checked, hidden: hidden.checked, execute: execute.checked, destinations: { remote: remote.checked || cloud.checked, cloud: cloud.checked } } }
    function save() {
        error = ""
        const done = value => { if (value.error) error = value.error; else { saved(); close() } }
        if (adding) rpc.call("workspace.addRoot", { sessionId: sessionId, path: root.path, policy: policy(), primary: primary.checked }, value => { if (!value.error) WorkbenchState.setRoot(sessionId, value.id); done(value) })
        else rpc.call("workspace.updateRoot", { sessionId: sessionId, rootId: root.id, policy: policy(), expectedRevision: root.revision, primary: primary.checked }, done)
    }
    CText { text: dialog.adding ? "Add a workspace folder" : "Folder permissions"; font.pixelSize: Theme.title; font.bold: true }
    CText { objectName: "rootSettingsPath"; text: dialog.root.path || ""; font.family: "monospace"; font.pixelSize: Theme.secondary; color: Theme.accentText; wrapMode: Text.WrapAnywhere }
    CText { text: "This conversation can list, search and read files here. Credential files, version-control internals and Cere’s own data are never read for a model."; color: Theme.muted; font.pixelSize: Theme.secondary }
    SectionLabel { text: "What Cere may do" }
    CCheckBox { id: write; objectName: "rootWrite"; text: "Create and edit text files (you review each change)" }
    CCheckBox { id: organize; objectName: "rootOrganize"; text: "Organize: new folders, copy, move and trash (you review each set)" }
    CCheckBox { id: hidden; objectName: "rootHidden"; text: "Include hidden files in listings and search" }
    CCheckBox { id: execute; objectName: "rootExecute"; text: "Run approved commands here (Analysis)" }
    SectionLabel { text: "Who may process its contents" }
    CCheckBox { checked: true; enabled: false; text: "Models on this computer" }
    CCheckBox { id: remote; objectName: "rootRemote"; text: "Also models on your own servers (another computer running Ollama, a LAN endpoint)" }
    CCheckBox { id: cloud; objectName: "rootCloud"; text: "Also cloud services (hosted APIs, Ollama Cloud, unverified endpoints)" }
    CText { text: "A model whose processing location is not allowed here cannot read this folder, and earlier excerpts are withheld from it."; color: Theme.muted; font.pixelSize: Theme.caption }
    CCheckBox { id: primary; objectName: "rootPrimary"; text: "Primary folder (used when the model names no folder)" }
    ColumnLayout {
        visible: !dialog.adding && write.checked; Layout.fillWidth: true; spacing: 6
        SectionLabel { text: "Edit permission" }
        CText { text: "Let Cere apply small text edits in this folder without asking each time. Moves, trash and commands are never covered."; color: Theme.muted; font.pixelSize: Theme.secondary }
        RowLayout {
            Layout.fillWidth: true
            CSpinBox { id: minutes; from: 5; to: 240; stepSize: 5; value: 30; Accessible.name: "Minutes" }
            CText { Layout.fillWidth: false; text: "minutes, up to" }
            CSpinBox { id: operations; from: 1; to: 100; value: 20; Accessible.name: "Operations" }
            CText { Layout.fillWidth: false; text: "operations" }
        }
        CButton { objectName: "rootGrantEdits"; text: "Allow edits for " + minutes.value + " minutes"; onClicked: rpc.call("workspace.grantEdits", { sessionId: dialog.sessionId, rootId: dialog.root.id, minutes: minutes.value, maxOperations: operations.value }, value => { if (value.error) dialog.error = value.error; else dialog.grants = dialog.grants.concat([value]) }) }
        Repeater {
            model: dialog.grants
            RowLayout {
                required property var modelData
                Layout.fillWidth: true
                CText { Layout.fillWidth: true; text: "Edits allowed until " + new Date(modelData.expires).toLocaleTimeString() + " · " + modelData.usedOperations + " of " + modelData.maxOperations + " used"; font.pixelSize: Theme.secondary }
                CButton { text: "Revoke"; danger: true; onClicked: rpc.call("workspace.revokeGrant", { id: modelData.id }, () => dialog.grants = dialog.grants.filter(g => g.id !== modelData.id)) }
            }
        }
    }
    CText { visible: !!dialog.error; text: dialog.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    RowLayout {
        Layout.fillWidth: true; spacing: 8
        CButton { objectName: "rootRemove"; visible: !dialog.adding; text: "Remove folder"; danger: true; onClicked: rpc.call("workspace.removeRoot", { sessionId: dialog.sessionId, rootId: dialog.root.id }, value => { if (value.error) dialog.error = value.error; else { dialog.saved(); dialog.close() } }) }
        Item { Layout.fillWidth: true }
        CButton { text: "Cancel"; onClicked: dialog.close() }
        CButton { objectName: "rootSave"; text: dialog.adding ? "Add folder" : "Save"; primary: true; onClicked: dialog.save() }
    }
}
