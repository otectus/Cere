import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Shelf: what this project has collected, each kept where it lives with its own rules. Files
// shared with the project or pinned, collections bound to it, the capsule's accepted decisions and tasks,
// other conversations and saved recipes. "Use in next message" adds a reference to the composer; nothing
// here enters a prompt by itself.
Item {
    id: shelf
    objectName: "projectShelf"
    property string sessionId: ""
    property var shelfData: null
    property string error: ""
    property string notice: ""
    RpcClient { id: rpc; scope: shelf.sessionId }
    function refresh() { if (!sessionId) return; rpc.call("shelf.get", { sessionId: sessionId }, value => { if (value.error) { error = value.error; shelfData = null } else { error = ""; shelfData = value } }) }
    function use(ref) {
        const current = WorkbenchState.referencesFor(sessionId)
        if (current.length >= 8) { notice = "A message can reference up to 8 items."; return }
        const key = JSON.stringify(Object.assign({}, ref, { label: "" }))
        if (!current.some(r => JSON.stringify(Object.assign({}, r, { label: "", version: undefined })) === key)) WorkbenchState.setReferences(sessionId, current.concat([ref]))
        notice = "Added “" + ref.label + "” to your next message."
    }
    onSessionIdChanged: { shelfData = null; error = ""; notice = ""; refresh() }
    onVisibleChanged: if (visible) refresh()
    Component.onCompleted: refresh()
    component Group: ColumnLayout {
        property string title: ""
        property string empty: ""
        property int count: 0
        default property alias rows: body.data
        Layout.fillWidth: true; spacing: 4
        CText { text: parent.title + (parent.count ? " · " + parent.count : ""); font.weight: Font.DemiBold; font.pixelSize: Theme.secondary }
        CText { visible: !parent.count; text: parent.empty; color: Theme.muted; font.pixelSize: Theme.caption }
        ColumnLayout { id: body; Layout.fillWidth: true; spacing: 2 }
    }
    component Row: RowLayout {
        id: row
        property string label: ""
        property string detail: ""
        property string icon: "file"
        property var ref: null
        Layout.fillWidth: true; spacing: 8
        CIcon { name: row.icon; Layout.preferredWidth: 18; Layout.preferredHeight: 18 }
        ColumnLayout {
            Layout.fillWidth: true; spacing: 0
            CText { text: row.label; elide: Text.ElideMiddle; wrapMode: Text.NoWrap; font.pixelSize: Theme.secondary }
            CText { visible: !!row.detail; text: row.detail; elide: Text.ElideRight; wrapMode: Text.NoWrap; color: Theme.muted; font.pixelSize: Theme.caption }
        }
        CButton { visible: !!row.ref; text: "Use in next message"; quiet: true; implicitHeight: 30; font.pixelSize: Theme.caption; Accessible.name: "Use " + row.label + " in the next message"; onClicked: shelf.use(row.ref) }
    }
    ScrollView {
        anchors.fill: parent; clip: true; contentWidth: availableWidth
        ColumnLayout {
            width: parent.width; spacing: 14
            CText { text: "Things this project has collected. Each keeps its own rules: sharing a file with the project makes it findable here, not part of every prompt."; color: Theme.muted; font.pixelSize: Theme.caption }
            CText { visible: !!shelf.error; text: shelf.error; color: Theme.danger; font.pixelSize: Theme.secondary }
            CText { objectName: "shelfNotice"; visible: !!shelf.notice; text: shelf.notice; color: Theme.accentText; font.pixelSize: Theme.caption; Accessible.role: Accessible.AlertMessage }
            Group {
                title: "Files"; empty: "Pin a file in Images, or share one with the project, to keep it here."; count: (shelf.shelfData?.artifacts || []).length
                Repeater { model: shelf.shelfData?.artifacts || []
                    Row { required property var modelData; objectName: "shelfArtifact_" + modelData.id; label: modelData.name; icon: modelData.kind === "image" ? "image" : "file"
                        detail: [modelData.pinned ? "pinned" : "", modelData.shared ? "shared with the project" : "", modelData.here ? "" : "from another conversation"].filter(s => s).join(" · ")
                        ref: ({ kind: "artifact", artifactId: modelData.id, versionId: modelData.latestVersionId, label: modelData.name }) } }
            }
            Group {
                title: "Document collections"; empty: "No collection is bound to this project. Bind one in Settings › Knowledge."; count: (shelf.shelfData?.collections || []).length
                Repeater { model: shelf.shelfData?.collections || []
                    Row { required property var modelData; label: modelData.name; icon: "memory"; detail: modelData.allowCloud ? "may be read by cloud models" : "local models only"; ref: ({ kind: "collection", id: modelData.id, label: modelData.name }) } }
            }
            Group {
                title: "Decisions and tasks"; empty: "The project capsule has no accepted decisions or tasks yet."; count: (shelf.shelfData?.capsule?.decisions || []).length + (shelf.shelfData?.capsule?.tasks || []).length
                Repeater { model: shelf.shelfData?.capsule?.decisions || []; Row { required property var modelData; label: modelData; icon: "star"; detail: "Decision" } }
                Repeater { model: shelf.shelfData?.capsule?.tasks || []; Row { required property var modelData; label: modelData.text; icon: "context"; detail: modelData.state === "active" ? "Task in progress" : "Accepted task" } }
            }
            Group {
                title: "Other conversations in this project"; empty: "No other saved conversations use this project."; count: (shelf.shelfData?.conversations || []).length
                Repeater { model: shelf.shelfData?.conversations || []
                    Row { required property var modelData; label: modelData.title; icon: "chat"; detail: modelData.provider + " · recent messages are referenced, with attribution"; ref: ({ kind: "conversation", sessionId: modelData.id, label: modelData.title }) } }
            }
            Group {
                objectName: "shelfRecipes"; title: "Recipes"; empty: "No recipes."; count: (shelf.shelfData?.recipes || []).length
                CText { visible: (shelf.shelfData?.recipes || []).length > 0; text: "Run a recipe from Project workflows; Workbench recipes take files, folders and collections as inputs."; color: Theme.muted; font.pixelSize: Theme.caption }
                Repeater { model: shelf.shelfData?.recipes || []; Row { required property var modelData; label: modelData.name; icon: "sessions"; detail: "version " + modelData.version + (modelData.workbench ? " · Workbench" : "") + (modelData.builtin ? " · built in" : "") } }
            }
        }
    }
}
