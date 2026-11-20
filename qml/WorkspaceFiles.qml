import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Files: the conversation's workspace folders, one folder level at a time, with name
// filtering and content search as separate actions. Names are untrusted text and render as plain text.
Item {
    id: pane
    objectName: "workspaceFiles"
    property string sessionId: ""
    property var roots: []
    property var grants: []
    property string problem: ""
    property string error: ""
    property var listing: ({ entries: [] })
    property var results: null
    property bool loading: false
    readonly property var root: roots.find(r => r.id === WorkbenchState.rootFor(sessionId)) || roots[0] || null
    readonly property string path: root ? WorkbenchState.folder(sessionId, root.id) : ""
    readonly property var crumbs: path ? path.split("/") : []
    signal settingsRequested(var root)
    RpcClient { id: rpc }
    function refreshRoots() {
        if (!sessionId) { roots = []; return }
        rpc.call("workspace.roots", { sessionId: sessionId }, value => {
            if (value.error) { error = value.error; roots = []; return }
            roots = value.roots || []; grants = value.grants || []; problem = value.problem || ""; error = ""
            if (root) load(false)
        })
    }
    function load(more) {
        if (!root) return
        if (root.status && root.status !== "available") { listing = ({ entries: [] }); return }
        loading = true
        const params = { sessionId: sessionId, rootId: root.id, path: path }
        if (more && listing.nextCursor) params.cursor = listing.nextCursor
        rpc.call("files.list", params, value => {
            loading = false
            if (value.error) { error = value.error; return }
            error = ""
            listing = more ? Object.assign({}, value, { entries: (listing.entries || []).concat(value.entries) }) : value
        })
    }
    function open(entry) {
        if (entry.type === "directory") { results = null; WorkbenchState.setFolder(sessionId, root.id, entry.path); load(false) }
        else if (entry.type === "file") WorkbenchState.openFile(sessionId, root.id, entry.path, 1)
    }
    function goTo(index) { results = null; WorkbenchState.setFolder(sessionId, root.id, index < 0 ? "" : crumbs.slice(0, index + 1).join("/")); load(false) }
    function runSearch() {
        if (!root || !searchField.text.trim()) { results = null; return }
        loading = true
        rpc.call("files.search", { sessionId: sessionId, rootId: root.id, path: path, query: searchField.text, mode: regexMode.checked ? "regex" : "literal" }, value => {
            loading = false
            if (value.error) { error = value.error; return }
            error = ""; results = value
        })
    }
    function chooseFolder() { const chosen = App.chooseFolder(); if (chosen) settingsRequested({ path: chosen, policy: { write: false, organize: false, hidden: false, execute: false, destinations: { remote: false, cloud: false } } }) }
    function useConversation() { rpc.call("workspace.conversationRoot", { sessionId: sessionId }, value => { if (value.error) error = value.error; else { WorkbenchState.setRoot(sessionId, value.id); refreshRoots() } }) }
    function size(bytes) { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? Math.round(bytes / 1024) + " KiB" : (bytes / 1048576).toFixed(1) + " MiB" }
    onSessionIdChanged: { results = null; refreshRoots() }
    Component.onCompleted: refreshRoots()
    Connections { target: App; function onStateChanged() { if (!pane.roots.length && pane.sessionId && App.connected && !rpc.busy) pane.refreshRoots() } }

    ColumnLayout {
        anchors.fill: parent; spacing: 8
        CText { visible: !!pane.problem; text: pane.problem; color: Theme.amber; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            Layout.fillWidth: true; spacing: 6
            CComboBox {
                id: rootPicker; objectName: "workspaceRootPicker"
                Layout.fillWidth: true; visible: pane.roots.length > 0
                model: pane.roots.map(r => r.name + (r.primary ? " · primary" : "") + (r.status && r.status !== "available" ? " · " + (r.status === "missing" ? "unavailable" : "replaced") : ""))
                currentIndex: Math.max(0, pane.roots.findIndex(r => pane.root && r.id === pane.root.id))
                Accessible.name: "Workspace folder"
                onActivated: index => { WorkbenchState.setRoot(pane.sessionId, pane.roots[index].id); pane.results = null; pane.load(false) }
            }
            CButton { objectName: "workspaceAddFolder"; visible: pane.roots.length > 0; implicitWidth: 40; text: ""; iconName: "plus"; help: "Add a folder to this conversation’s workspace"; Accessible.name: "Add a workspace folder"; onClicked: pane.chooseFolder() }
            CButton { objectName: "workspaceUseConversation"; visible: pane.roots.length > 0 && !pane.roots.some(r => r.kind === "conversation"); implicitWidth: 40; text: ""; iconName: "projects"
                help: "A private folder Cere keeps for this conversation; export what it produces later"; Accessible.name: "Use a private conversation workspace"; onClicked: pane.useConversation() }
            CButton { objectName: "workspaceFolderSettings"; visible: !!pane.root; implicitWidth: 40; text: ""; iconName: "settings"; help: "Folder permissions"; Accessible.name: "Folder permissions"; onClicked: pane.settingsRequested(pane.root) }
        }
        CText {
            visible: !pane.roots.length && !pane.error
            text: "Choose a folder this conversation may read, or use a private conversation workspace. Cere asks before any change, and nothing outside the folders you choose is visible."
            color: Theme.muted; font.pixelSize: Theme.secondary
        }
        Flow {
            Layout.fillWidth: true; spacing: 6; visible: !pane.roots.length && !!pane.sessionId
            CButton { objectName: "workspaceChooseFolder"; text: "Choose folder…"; iconName: "plus"; primary: true; onClicked: pane.chooseFolder() }
            CButton { objectName: "workspaceConversationFolder"; text: "Use conversation workspace"; iconName: "projects"; help: "A private folder Cere keeps for this conversation; export what it produces later"; onClicked: pane.useConversation() }
        }
        CText { visible: !!pane.root && pane.root.status === "missing"; text: "This folder is not available right now. If it is on a removable drive, connect it again."; color: Theme.amber; font.pixelSize: Theme.secondary }
        CText { visible: !!pane.root && pane.root.status === "replaced"; text: "A different folder now sits at this location. Remove it and choose it again to continue."; color: Theme.amber; font.pixelSize: Theme.secondary }
        Flow {
            Layout.fillWidth: true; spacing: 2; visible: !!pane.root
            CButton { objectName: "crumbRoot"; quiet: true; implicitHeight: 28; text: pane.root ? pane.root.name : ""; onClicked: pane.goTo(-1) }
            Repeater {
                model: pane.crumbs
                RowLayout {
                    required property string modelData; required property int index
                    spacing: 2
                    CText { Layout.fillWidth: false; text: "/"; color: Theme.muted }
                    CButton { quiet: true; implicitHeight: 28; text: modelData; Accessible.name: "Open " + modelData; onClicked: pane.goTo(index) }
                }
            }
        }
        RowLayout {
            Layout.fillWidth: true; spacing: 6; visible: !!pane.root
            CField { id: filterField; objectName: "workspaceFilter"; Layout.fillWidth: true; placeholderText: "Filter names"; Accessible.name: "Filter names in this folder" }
            CField { id: searchField; objectName: "workspaceSearch"; Layout.fillWidth: true; placeholderText: "Search contents"; Accessible.name: "Search file contents"; onAccepted: pane.runSearch() }
            CCheckBox { id: regexMode; Layout.fillWidth: false; implicitWidth: 80; text: "Regex"; Accessible.name: "Regular expression search" }
            CButton { objectName: "workspaceSearchRun"; text: ""; iconName: "search"; Accessible.name: "Search"; enabled: !pane.loading; onClicked: pane.runSearch() }
        }
        CText { visible: !!pane.error; text: pane.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText {
            objectName: "workspaceSearchSummary"; visible: !!pane.results
            text: pane.results ? (pane.results.files.length + " file" + (pane.results.files.length === 1 ? "" : "s") + " with matches" + (pane.results.complete ? "" : " · stopped at " + pane.results.stoppedBecause + ", so this is not every match")) : ""
            color: pane.results && !pane.results.complete ? Theme.amber : Theme.muted; font.pixelSize: Theme.secondary
        }
        ListView {
            id: entries; objectName: "workspaceEntries"
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 2
            visible: !!pane.root && !pane.results
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: CScrollBar {}
            model: (pane.listing.entries || []).filter(e => !filterField.text || e.name.toLowerCase().indexOf(filterField.text.toLowerCase()) >= 0)
            keyNavigationEnabled: true; activeFocusOnTab: true
            Keys.onReturnPressed: if (currentIndex >= 0) pane.open(model[currentIndex])
            delegate: ItemDelegate {
                required property var modelData; required property int index
                objectName: "workspaceEntry_" + modelData.name
                width: entries.width - 12; height: 40
                highlighted: entries.currentIndex === index
                Accessible.name: (modelData.type === "directory" ? "Folder " : modelData.type === "file" ? "File " : modelData.type + " ") + modelData.name
                background: Rectangle { radius: Theme.radiusControl; color: parent.highlighted || parent.hovered ? Theme.raised : "transparent" }
                onClicked: { entries.currentIndex = index; pane.open(modelData) }
                contentItem: RowLayout {
                    spacing: 8
                    CIcon { name: modelData.type === "directory" ? "projects" : modelData.type === "symlink" ? "arrow" : "file"; Layout.preferredWidth: 20; Layout.preferredHeight: 20 }
                    CText { Layout.fillWidth: true; text: modelData.name; elide: Text.ElideMiddle; wrapMode: Text.NoWrap; color: modelData.excluded || modelData.credential ? Theme.muted : Theme.text }
                    CText { Layout.fillWidth: false; text: [modelData.credential ? "credential" : "", modelData.excluded ? "skipped by search" : "", modelData.type === "symlink" ? "link, not followed" : "", modelData.links ? modelData.links + " links" : "",
                        modelData.type === "file" ? pane.size(modelData.size) : "", ["fifo","socket","device","other"].indexOf(modelData.type) >= 0 ? "special file" : ""].filter(s => s).join(" · ")
                        color: Theme.muted; font.pixelSize: Theme.caption }
                }
            }
            footer: ColumnLayout {
                width: entries.width - 12; spacing: 4
                CButton { visible: !!pane.listing.nextCursor; Layout.fillWidth: true; quiet: true; text: "Show more"; onClicked: pane.load(true) }
                CText { visible: (pane.listing.hiddenSkipped || 0) > 0; text: pane.listing.hiddenSkipped + " hidden item" + (pane.listing.hiddenSkipped === 1 ? " is" : "s are") + " not shown. Turn on hidden files in the folder permissions to list them."; color: Theme.muted; font.pixelSize: Theme.caption }
                CText { visible: (pane.listing.unreadableNames || 0) > 0; text: pane.listing.unreadableNames + " item(s) with names Cere cannot display are not shown."; color: Theme.muted; font.pixelSize: Theme.caption }
                CText { visible: !pane.loading && pane.listing.entries && !pane.listing.entries.length; text: "This folder is empty."; color: Theme.muted; font.pixelSize: Theme.secondary }
            }
        }
        ListView {
            id: matches; objectName: "workspaceMatches"
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 6
            visible: !!pane.results
            ScrollBar.vertical: CScrollBar {}
            model: pane.results ? pane.results.files : []
            delegate: ColumnLayout {
                id: fileRow
                required property var modelData
                width: matches.width - 12; spacing: 2
                CButton { Layout.fillWidth: true; quiet: true; alignLeft: true; implicitHeight: 30; text: modelData.path; Accessible.name: "Open " + modelData.path; onClicked: WorkbenchState.openFile(pane.sessionId, pane.root.id, modelData.path, modelData.matches[0]?.line || 1) }
                Repeater {
                    model: modelData.matches
                    CButton {
                        required property var modelData
                        Layout.fillWidth: true; quiet: true; alignLeft: true; implicitHeight: 26; font.family: "monospace"; font.pixelSize: Theme.caption
                        text: modelData.line + "  " + modelData.text
                        Accessible.name: "Line " + modelData.line + ": " + modelData.text
                        onClicked: WorkbenchState.openFile(pane.sessionId, pane.root.id, fileRow.modelData.path, modelData.line)
                    }
                }
            }
        }
    }
}
