import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// The Workbench: Files, Preview, Changes, Images and Runs for the selected conversation. In the expanded
// workspace it sits beside the chat; in the compact panel it is one focused sheet with a way back.
Rectangle {
    id: bench
    objectName: "workbench"
    property bool compact: false
    readonly property string sessionId: App.selectedId
    readonly property var session: App.session || ({})
    readonly property bool managed: ["ollama", "openai", "anthropic", "google", "compatible"].indexOf(session.provider || "") >= 0
    readonly property var capabilities: session.capabilities || ({})
    readonly property var tabs: [
        { id: "files", label: "Files", icon: "projects" }, { id: "preview", label: "Preview", icon: "copy" },
        { id: "changes", label: "Changes" + (pendingChanges ? " · " + pendingChanges : ""), icon: "edit" },
        { id: "images", label: "Images", icon: "image" }, { id: "runs", label: "Runs", icon: "terminal" }, { id: "shelf", label: "Shelf", icon: "star" } ]
    readonly property int pendingChanges: (App.state.workbench?.pendingChanges || []).filter(p => p.sessionId === sessionId).length
    property var roots: []
    property var grants: []
    signal closeRequested()
    color: Theme.background
    border.color: compact ? "transparent" : Theme.subtle
    Accessible.role: Accessible.Pane; Accessible.name: "Workbench"
    readonly property bool canBrowse: !!sessionId && session.id === sessionId && !session.temporary && !session.remote
    property bool initialized: false
    RpcClient { id: rpc; scope: bench.canBrowse ? bench.sessionId : "" }
    Timer {
        id: loadVisiblePane
        interval: 0
        onTriggered: {
            if (!bench.initialized || !bench.visible || !bench.canBrowse) return
            bench.refreshRoots()
            bench.ensurePane()
        }
    }
    function refreshRoots() {
        if (!sessionId) { roots = []; grants = []; return }
        rpc.call("workspace.roots", { sessionId: sessionId }, value => { if (!value.error) { roots = value.roots || []; grants = value.grants || [] } })
    }
    readonly property var paneLoaders: [filesLoader, previewLoader, changesLoader, imagesLoader, runsLoader, shelfLoader]
    function paneIndex(tab) { return Math.max(0, tabs.findIndex(t => t.id === tab)) }
    function resetPanes() { for (const loader of paneLoaders) loader.source = "" }
    function ensurePane() {
        if (!initialized || !visible || !canBrowse) return
        const index = paneIndex(WorkbenchState.tab), loader = paneLoaders[index]
        if (loader.status !== Loader.Null) return
        const selectedSession = sessionId, selectedTab = WorkbenchState.tab
        Qt.callLater(() => {
            if (!bench.visible || !bench.canBrowse || bench.sessionId !== selectedSession || WorkbenchState.tab !== selectedTab || loader.status !== Loader.Null) return
            const properties = { sessionId: selectedSession }
            if (selectedTab === "preview") properties.roots = filesLoader.item ? filesLoader.item.roots : bench.roots
            loader.setSource(loader.paneSource, properties)
        })
    }
    function setCapability(family, on) {
        const next = Object.assign({}, capabilities); if (on) next[family] = true; else delete next[family]
        rpc.call("session.capabilities", { id: sessionId, capabilities: next }, value => { if (value.error) capabilityError.text = value.error; else capabilityError.text = "" })
    }
    onSessionIdChanged: {
        if (!initialized) return
        rootSettings.close()
        rootSettings.sessionId = ""
        WorkbenchState.activateSession(sessionId)
        roots = []
        grants = []
        capabilityError.text = ""
        resetPanes()
        loadVisiblePane.restart()
    }
    onCanBrowseChanged: {
        if (!initialized) return
        if (canBrowse) loadVisiblePane.restart()
        else { rootSettings.close(); resetPanes(); roots = []; grants = [] }
    }
    onVisibleChanged: if (initialized && visible) loadVisiblePane.restart()
    onRootsChanged: if (previewLoader.item) previewLoader.item.roots = roots
    Component.onCompleted: {
        initialized = true
        WorkbenchState.activateSession(sessionId)
        loadVisiblePane.restart()
    }
    Connections { target: WorkbenchState; function onTabChanged() { bench.ensurePane() } }
    Keys.onEscapePressed: closeRequested()

    ColumnLayout {
        anchors.fill: parent; anchors.margins: bench.compact ? 0 : 12; spacing: 8
        RowLayout {
            Layout.fillWidth: true; spacing: 6
            CButton { objectName: "workbenchBack"; visible: bench.compact; text: "Chat"; iconName: "back"; quiet: true; help: "Back to the conversation"; onClicked: bench.closeRequested() }
            CText { Layout.fillWidth: true; text: "Workbench"; font.pixelSize: Theme.section; font.weight: Font.DemiBold; elide: Text.ElideRight; wrapMode: Text.NoWrap }
            CButton { objectName: "workbenchClose"; visible: !bench.compact; text: ""; iconName: "close"; quiet: true; help: "Close the Workbench"; Accessible.name: "Close the Workbench"; onClicked: bench.closeRequested() }
        }
        Flow {
            Layout.fillWidth: true; spacing: 4
            Repeater {
                model: bench.tabs
                CButton {
                    required property var modelData
                    objectName: "workbenchTab_" + modelData.id
                    text: modelData.label; quiet: WorkbenchState.tab !== modelData.id; primary: WorkbenchState.tab === modelData.id; implicitHeight: 32
                    Accessible.role: Accessible.PageTab; Accessible.onPressAction: if (enabled) click(); Accessible.selected: WorkbenchState.tab === modelData.id
                    onClicked: WorkbenchState.tab = modelData.id
                }
            }
        }
        CText { visible: !bench.sessionId; text: "Open a conversation to use the Workbench."; color: Theme.muted }
        CText { visible: !!bench.session.temporary; text: "Temporary conversations stay text-only: files, images and runs need a saved conversation."; color: Theme.amber; font.pixelSize: Theme.secondary }
        CText { visible: !!bench.session.remote; text: "This conversation is controlled from a phone. Workspace files are managed on the desktop after detaching it."; color: Theme.amber; font.pixelSize: Theme.secondary }
        ColumnLayout {
            visible: bench.managed && !bench.session.temporary && !bench.session.remote; Layout.fillWidth: true; spacing: 2
            Flow {
                Layout.fillWidth: true; spacing: 10
                CText { width: implicitWidth; height: 32; verticalAlignment: Text.AlignVCenter; text: "The model may use"; color: Theme.muted; font.pixelSize: Theme.secondary }
                CCheckBox { objectName: "capabilityFiles"; width: implicitContentWidth + leftPadding + rightPadding; text: "Files"; checked: !!bench.capabilities.files; onToggled: bench.setCapability("files", checked); Accessible.name: "Let the model use workspace files" }
                CCheckBox { objectName: "capabilityImages"; width: implicitContentWidth + leftPadding + rightPadding; text: "Images"; checked: !!bench.capabilities.images; onToggled: bench.setCapability("images", checked); Accessible.name: "Let the model create and edit images" }
                CCheckBox { objectName: "capabilityAnalysis"; width: implicitContentWidth + leftPadding + rightPadding; text: "Analysis"; checked: !!bench.capabilities.analysis; onToggled: bench.setCapability("analysis", checked); Accessible.name: "Let the model run analysis code" }
            }
            CText { text: "You can always use the Workbench yourself; these only decide what the model is offered."; color: Theme.muted; font.pixelSize: Theme.caption }
            CText { id: capabilityError; visible: !!text; color: Theme.danger; font.pixelSize: Theme.caption }
        }
        StackLayout {
            Layout.fillWidth: true; Layout.fillHeight: true
            visible: !!bench.sessionId && !bench.session.temporary && !bench.session.remote
            currentIndex: bench.paneIndex(WorkbenchState.tab)
            Loader { id: filesLoader; readonly property url paneSource: "WorkspaceFiles.qml" }
            Loader { id: previewLoader; readonly property url paneSource: "FilePreview.qml" }
            Loader { id: changesLoader; readonly property url paneSource: "ChangeReview.qml" }
            Loader { id: imagesLoader; readonly property url paneSource: "ArtifactBrowser.qml" }
            Loader { id: runsLoader; readonly property url paneSource: "RunsPane.qml" }
            Loader { id: shelfLoader; readonly property url paneSource: "ProjectShelf.qml" }
        }
        Connections {
            target: filesLoader.item
            ignoreUnknownSignals: true
            function onSettingsRequested(root) { rootSettings.openFor(bench.sessionId, root, bench.grants) }
            function onRootsChanged() { if (previewLoader.item) previewLoader.item.roots = filesLoader.item.roots }
        }
    }
    RootSettings { id: rootSettings; onSaved: { if (filesLoader.item) filesLoader.item.refreshRoots(); bench.refreshRoots() } }
}
