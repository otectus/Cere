import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Images: this conversation's images and files, a Create panel that works whatever the chat
// model can do, and the image editor. Removing a card from the conversation is not deleting a file
// someone exported elsewhere; each has its own action.
Item {
    id: browser
    objectName: "artifactBrowser"
    property string sessionId: ""
    property var items: []
    property var before: undefined
    property string filter: "image"
    property string source: ""
    property string error: ""
    property string notice: ""
    property var thumbnails: ({})
    property var selected: null
    property var details: null
    property var connections: []
    property var capabilities: null
    property var references: []
    property var mask: null
    property bool creating: WorkbenchState.createRequested
    readonly property var imageSelection: WorkbenchState.imageFor(sessionId)
    property bool editing: !!imageSelection.artifactId && !!imageSelection.versionId
    RpcClient { id: rpc; scope: browser.sessionId }
    function refresh() {
        if (!sessionId) return
        rpc.call("artifacts.list", { sessionId: sessionId, kind: filter, source: source, query: query.text, limit: 60 }, value => {
            if (value.error) { error = value.error; return }
            items = value.artifacts || []; before = value.before; error = ""
            for (const item of items) if (!thumbnails[item.latestVersionId] && (item.kind === "image" || item.kind === "plot")) fetchThumb(item.id, item.latestVersionId)
        })
        rpc.call("images.connections", {}, value => { if (!value.error) { connections = value.connections || []; if (connections.length && !capabilities) loadCapabilities(connections[0].id) } })
    }
    function fetchThumb(artifactId, versionId) {
        rpc.call("artifacts.thumbnail", { sessionId: sessionId, artifactId: artifactId, versionId: versionId, size: 192 }, value => { if (!value.error && value.data) { const next = Object.assign({}, thumbnails); next[versionId] = value.data; thumbnails = next } })
    }
    function select(item) {
        selected = item
        rpc.call("artifacts.get", { sessionId: sessionId, artifactId: item.id }, value => { if (!value.error) details = value })
        App.rpc("images.select", { sessionId: sessionId, ref: { artifactId: item.id, versionId: item.latestVersionId } })
    }
    function loadCapabilities(connectionId) { rpc.call("images.capabilities", { connectionId: connectionId }, value => { capabilities = value.error ? null : value; if (value.error) notice = value.error }) }
    function request() {
        const r = { prompt: prompt.text, count: count.value, format: format.currentText }
        const caps = capabilities?.summary || {}
        if (sizeBox.visible && sizeBox.currentText && sizeBox.currentText !== "auto") r.size = sizeBox.currentText
        if (ratioBox.visible && ratioBox.currentText) r.aspectRatio = ratioBox.currentText
        if (resolutionBox.visible && resolutionBox.currentText) r.imageSize = resolutionBox.currentText
        if (qualityBox.visible && qualityBox.currentText && qualityBox.currentText !== "auto") r.quality = qualityBox.currentText
        if (transparent.checked) r.background = "transparent"
        if (seedField.visible && seedField.text.trim()) r.seed = Number(seedField.text)
        if (negative.visible && negative.text.trim()) r.negativePrompt = negative.text
        if (references.length) r.references = references.map((ref, i) => ({ artifactId: ref.artifactId, versionId: ref.versionId, role: i === 0 ? "edit-base" : ref.role || "subject" }))
        if (mask) { r.mask = { artifactId: mask.artifactId, versionId: mask.versionId, feather: feather.value }; r.protectOutside = protect.checked }
        if (previews.checked) r.partials = true
        return r
    }
    function generate(acknowledge) {
        const connection = connections[connectionBox.currentIndex]; if (!connection) return
        notice = ""; error = ""
        rpc.call("images.generate", Object.assign({ sessionId: sessionId, connectionId: connection.id, request: request() }, acknowledge ? { acknowledgeBilling: true } : {}), value => {
            if (value.error) { if (value.code === "ACKNOWLEDGE_BILLING") billing.open(); else error = value.error; return }
            notice = value.duplicate ? "That request is already running." : "Started. The result appears here and in the conversation."; WorkbenchState.tab = "runs"
        })
    }
    function checkRequest() {
        const connection = connections[connectionBox.currentIndex]; if (!connection) return
        rpc.call("images.preview", { sessionId: sessionId, connectionId: connection.id, request: request() }, value => { if (value.error) error = value.error; else { error = ""; notice = value.adjustments.length ? "Will be adjusted: " + value.adjustments.join("; ") : "Ready to send as shown." } })
    }
    onSessionIdChanged: { items = []; selected = null; details = null; references = []; mask = null; refresh() }
    Component.onCompleted: refresh()
    // Reload when this conversation's files change (an import, a finished run, a removal) or a run starts or ends.
    Connections { target: App; function onStateChanged() { const mark = (App.state.workbench?.artifactRevision || 0) + ":" + (App.state.workbench?.activeOperations || []).length; if (mark !== browser.seen) { browser.seen = mark; if (browser.visible) browser.refresh(); else browser.stale = true } } }
    property string seen: ""
    property bool stale: false
    onVisibleChanged: if (visible && stale) { stale = false; refresh() }
    Connections { target: WorkbenchState; function onImagesChanged() { if (WorkbenchState.imageFor(browser.sessionId).artifactId) browser.refresh() } }

    ColumnLayout {
        anchors.fill: parent; spacing: 8; visible: !browser.editing
        RowLayout {
            Layout.fillWidth: true; spacing: 6
            CComboBox { id: kindBox; objectName: "artifactKind"; Layout.preferredWidth: 130; model: ["Images", "All files"]; Accessible.name: "Show"; onActivated: index => { browser.filter = index === 0 ? "image" : ""; browser.refresh() } }
            CComboBox { objectName: "artifactSource"; Layout.preferredWidth: 140; model: ["Any source", "Generated", "Imported", "Derived"]; Accessible.name: "Source"; onActivated: index => { browser.source = ["", "model-generation", "user-import", "derived"][index]; browser.refresh() } }
            CField { id: query; objectName: "artifactQuery"; Layout.fillWidth: true; placeholderText: "Search names and tags"; onAccepted: browser.refresh(); Accessible.name: "Search files" }
        }
        Flow {
            Layout.fillWidth: true; spacing: 6
            CButton { objectName: "imagesCreate"; text: browser.creating ? "Hide Create" : "Create image"; iconName: "image"; primary: !browser.creating; onClicked: { browser.creating = !browser.creating; WorkbenchState.createRequested = false } }
            CButton { objectName: "imagesImport"; text: "Import…"; iconName: "plus"; onClicked: { const path = browser.filter === "image" ? App.chooseImage() : App.chooseFile(); if (path) importDialog.openFor(path) } }
            CButton { objectName: "imagesSketch"; text: "New sketch"; iconName: "edit"; onClicked: rpc.call("images.sketch", { sessionId: browser.sessionId, width: 1024, height: 768 }, value => { if (value.error) browser.error = value.error; else { browser.refresh(); WorkbenchState.selectImage(browser.sessionId, value.artifactId, value.versionId) } }) }
        }
        CText { visible: !!browser.error; text: browser.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { visible: !!browser.notice; text: browser.notice; color: Theme.accentText; font.pixelSize: Theme.secondary }
        // Create works without any chat model: these controls call the same image service the model uses.
        ColumnLayout {
            visible: browser.creating; Layout.fillWidth: true; spacing: 6
            CText { visible: !browser.connections.length; text: "No image backend is set up yet. Add OpenAI, Google or your ComfyUI server in Settings → Connections → Images."; color: Theme.amber; font.pixelSize: Theme.secondary }
            RowLayout {
                visible: browser.connections.length > 0; Layout.fillWidth: true
                CComboBox { id: connectionBox; objectName: "imagesConnection"; Layout.fillWidth: true; model: browser.connections.map(c => c.name + " · " + (c.kind === "comfyui" ? "your server" : "billed cloud API")); Accessible.name: "Image backend"; onActivated: index => browser.loadCapabilities(browser.connections[index].id) }
            }
            CText { visible: !!browser.capabilities; text: browser.capabilities ? (browser.capabilities.summary.notes || []).join(" ") + " Processes on " + browser.capabilities.summary.processes + "." : ""; color: Theme.muted; font.pixelSize: Theme.caption }
            CTextArea { id: prompt; objectName: "imagesPrompt"; Layout.fillWidth: true; Layout.preferredHeight: 80; placeholderText: "Describe the image"; Accessible.name: "Image prompt" }
            CField { id: negative; visible: (browser.capabilities?.summary?.negativePrompt || "").startsWith("supported"); Layout.fillWidth: true; placeholderText: "Avoid (negative prompt)"; Accessible.name: "Negative prompt" }
            Flow {
                Layout.fillWidth: true; spacing: 6
                CComboBox { id: sizeBox; visible: (browser.capabilities?.summary?.sizes || []).length > 0 || !!browser.capabilities?.summary?.customSize; implicitWidth: 150; editable: !!browser.capabilities?.summary?.customSize
                    model: (browser.capabilities?.summary?.sizes || []).length ? browser.capabilities.summary.sizes : ["1024x1024", "768x512", "512x768"]; Accessible.name: "Size" }
                CComboBox { id: ratioBox; visible: (browser.capabilities?.summary?.aspectRatios || []).length > 0; implicitWidth: 110; model: browser.capabilities?.summary?.aspectRatios || []; Accessible.name: "Aspect ratio" }
                CComboBox { id: resolutionBox; visible: (browser.capabilities?.summary?.imageSizes || []).length > 0; implicitWidth: 90; model: browser.capabilities?.summary?.imageSizes || []; Accessible.name: "Image size" }
                CComboBox { id: qualityBox; visible: (browser.capabilities?.summary?.qualities || []).length > 0; implicitWidth: 110; model: browser.capabilities?.summary?.qualities || []; Accessible.name: "Quality" }
                CComboBox { id: format; implicitWidth: 100; model: browser.capabilities?.summary?.formats || ["png"]; Accessible.name: "Format" }
                CSpinBox { id: count; from: 1; to: browser.capabilities?.summary?.maxCount || 1; value: 1; Accessible.name: "Number of images" }
                CField { id: seedField; visible: (browser.capabilities?.summary?.seed || "").startsWith("supported"); implicitWidth: 110; placeholderText: "Seed"; validator: IntValidator { bottom: 0 } Accessible.name: "Seed" }
            }
            Flow {
                Layout.fillWidth: true; spacing: 12
                CCheckBox { id: transparent; width: implicitContentWidth + leftPadding + rightPadding; visible: !(browser.capabilities?.summary?.transparency || "").startsWith("unsupported"); text: "Transparent background" }
                CCheckBox { id: previews; width: implicitContentWidth + leftPadding + rightPadding; visible: count.value === 1 && !(browser.capabilities?.summary?.backend !== "openai"); text: "Show previews (provisional)" }
            }
            CText { visible: browser.references.length > 0; text: "Using " + browser.references.length + " reference image" + (browser.references.length === 1 ? "" : "s") + " (the first is edited)" + (browser.mask ? " with a mask" : ""); font.pixelSize: Theme.secondary }
            RowLayout {
                visible: !!browser.mask; Layout.fillWidth: true
                CCheckBox { id: protect; Layout.fillWidth: false; implicitWidth: 300; checked: true; text: "Keep pixels outside the selection unchanged" }
                CText { Layout.fillWidth: false; text: "Feather" } CSpinBox { id: feather; from: 0; to: 64; value: 4; Accessible.name: "Feather" }
            }
            Flow {
                Layout.fillWidth: true; spacing: 6
                CButton { visible: browser.references.length > 0; text: "Clear references"; quiet: true; onClicked: { browser.references = []; browser.mask = null } }
                CButton { objectName: "imagesCheck"; text: "Check settings"; enabled: prompt.text.trim().length > 0 && browser.connections.length > 0; onClicked: browser.checkRequest() }
                CButton { objectName: "imagesGenerate"; text: browser.references.length ? "Make edit" : "Generate"; primary: true; enabled: prompt.text.trim().length > 0 && browser.connections.length > 0 && App.connected; onClicked: browser.generate(false) }
            }
        }
        GridView {
            id: grid; objectName: "artifactGrid"
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true
            cellWidth: Math.max(160, Math.floor(width / Math.max(1, Math.floor(width / 180)))); cellHeight: 200
            model: browser.items
            ScrollBar.vertical: CScrollBar {}
            keyNavigationEnabled: true; activeFocusOnTab: true
            delegate: Item {
                required property var modelData; required property int index
                objectName: "artifactTile_" + index
                width: grid.cellWidth; height: grid.cellHeight
                Rectangle {
                    anchors.fill: parent; anchors.margins: 4; radius: Theme.radiusControl
                    color: browser.selected && browser.selected.id === modelData.id ? Theme.selected : Theme.surface; border.color: grid.currentIndex === index && grid.activeFocus ? Theme.focus : Theme.subtle
                    Accessible.role: Accessible.Button; Accessible.name: modelData.name + (modelData.latest?.image ? ", " + modelData.latest.image.width + " by " + modelData.latest.image.height : "")
                    ColumnLayout {
                        anchors.fill: parent; anchors.margins: 6; spacing: 2
                        Rectangle {
                            Layout.fillWidth: true; Layout.fillHeight: true; color: Theme.codeSurface; radius: 4; clip: true
                            Image { anchors.fill: parent; fillMode: Image.PreserveAspectFit; asynchronous: true; source: browser.thumbnails[modelData.latestVersionId] || "" }
                            CText { anchors.centerIn: parent; width: implicitWidth; visible: !browser.thumbnails[modelData.latestVersionId]; text: modelData.kind === "image" ? "…" : modelData.kind; color: Theme.muted; font.pixelSize: Theme.caption }
                        }
                        CText { text: modelData.name; elide: Text.ElideMiddle; wrapMode: Text.NoWrap; font.pixelSize: Theme.caption }
                        CText { text: [modelData.latest?.image ? modelData.latest.image.width + "×" + modelData.latest.image.height : "", modelData.latest?.image?.transparent ? "transparency" : "", modelData.versions > 1 ? modelData.versions + " versions" : "",
                            modelData.latest?.source === "model-generation" ? "generated" : modelData.latest?.source === "user-import" ? "imported" : ""].filter(s => s).join(" · "); color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                    }
                    MouseArea { anchors.fill: parent; onClicked: { grid.currentIndex = index; browser.select(modelData) } onDoubleClicked: WorkbenchState.selectImage(browser.sessionId, modelData.id, modelData.latestVersionId) }
                }
            }
            Keys.onReturnPressed: if (currentIndex >= 0) browser.select(model[currentIndex])
            CText { anchors.centerIn: parent; width: parent.width - 40; horizontalAlignment: Text.AlignHCenter; visible: !browser.items.length; text: browser.filter === "image" ? "No images yet. Create one, import one, or ask in the conversation." : "No files yet."; color: Theme.muted }
        }
        ColumnLayout {
            visible: !!browser.selected; Layout.fillWidth: true; spacing: 4
            Flow {
                Layout.fillWidth: true; spacing: 4
                CButton { objectName: "imageView"; text: "View and edit"; quiet: true; implicitHeight: 30; onClicked: WorkbenchState.selectImage(browser.sessionId, browser.selected.id, browser.selected.latestVersionId) }
                CButton { objectName: "imageReference"; text: "Use as reference"; quiet: true; implicitHeight: 30; visible: browser.selected?.kind === "image"; onClicked: { if (!browser.references.some(r => r.versionId === browser.selected.latestVersionId)) browser.references = browser.references.concat([{ artifactId: browser.selected.id, versionId: browser.selected.latestVersionId, role: "subject" }]); browser.creating = true } }
                CButton { objectName: "imageSaveAs"; text: "Save as…"; quiet: true; implicitHeight: 30; onClicked: { const path = App.chooseSavePath(browser.selected.name); if (path) rpc.call("artifacts.saveAs", { sessionId: browser.sessionId, artifactId: browser.selected.id, versionId: browser.selected.latestVersionId, path: path, replace: true }, value => browser.notice = value.error ? value.error : "Saved to " + value.path) } }
                CButton { objectName: "imagePin"; text: browser.selected?.pinned ? "Unpin" : "Pin"; quiet: true; implicitHeight: 30; onClicked: rpc.call("artifacts.update", { sessionId: browser.sessionId, artifactId: browser.selected.id, pinned: !browser.selected.pinned }, () => browser.refresh()) }
                CButton { objectName: "imageShare"; text: browser.selected?.shared ? "Stop sharing with project" : "Share with project"; quiet: true; implicitHeight: 30; onClicked: rpc.call("artifacts.update", { sessionId: browser.sessionId, artifactId: browser.selected.id, shared: !browser.selected.shared }, () => browser.refresh()) }
                CButton { objectName: "imageRemove"; text: "Remove from conversation"; danger: true; quiet: true; implicitHeight: 30; onClicked: removeConfirm.open() }
            }
            CText { visible: !!browser.details; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap
                text: { const v = browser.details ? browser.details.versions[browser.details.versions.length - 1] : null; if (!v) return ""; const p = v.provenance || {}
                    return [p.prompt ? "Prompt: " + p.prompt : "", p.revisedPrompt ? "Revised by the provider: " + p.revisedPrompt : "", p.backend ? "Made with " + (p.connection || p.backend) + (p.model ? " (" + p.model + ")" : "") + " on " + (p.route || "unknown") : "", p.parameters ? "Settings: " + p.parameters : "", p.protection || "", (v.exports || []).length ? "Saved to " + v.exports[0].destination : ""].filter(s => s).join("\n") } }
        }
    }
    ImageWorkbench {
        anchors.fill: parent; visible: browser.editing; sessionId: browser.sessionId
        onCloseRequested: { WorkbenchState.clearImage(browser.sessionId); browser.refresh() }
        onMaskReady: ref => { const selected = WorkbenchState.imageFor(browser.sessionId); browser.mask = ref; if (!browser.references.some(r => r.versionId === selected.versionId)) browser.references = [{ artifactId: selected.artifactId, versionId: selected.versionId, role: "edit-base" }].concat(browser.references); browser.creating = true; WorkbenchState.clearImage(browser.sessionId) }
    }
    CDialog {
        id: billing; objectName: "imagesBilling"
        CText { text: "This backend may bill you"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: (browser.connections[connectionBox.currentIndex]?.name || "This connection") + " sends your prompt and any reference images to a paid API, which may charge your account for each image. Cere will not ask again for this connection." }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: billing.close() } CButton { objectName: "imagesBillingConfirm"; text: "Continue"; primary: true; onClicked: { billing.close(); browser.generate(true) } } }
    }
    CDialog {
        id: removeConfirm; objectName: "artifactRemoveDialog"
        property var derived: []
        onOpened: { derived = []; withDerived.checked = false; rpc.call("artifacts.derived", { sessionId: browser.sessionId, artifactId: browser.selected.id }, value => { if (!value.error) removeConfirm.derived = value.derived || [] }) }
        CText { text: "Remove from this conversation?"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: "Cere forgets this file here. If nothing else uses it, its stored copy and thumbnails are deleted. Copies you saved or exported elsewhere are not touched." }
        CCheckBox { id: withDerived; objectName: "artifactRemoveDerived"; visible: removeConfirm.derived.length > 0
            text: "Also remove what was made from it: " + removeConfirm.derived.slice(0, 3).map(d => d.name).join(", ") + (removeConfirm.derived.length > 3 ? " and " + (removeConfirm.derived.length - 3) + " more" : "") }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: removeConfirm.close() }
            CButton { objectName: "artifactRemoveConfirm"; text: "Remove"; danger: true; onClicked: { removeConfirm.close(); rpc.call("artifacts.remove", { sessionId: browser.sessionId, artifactId: browser.selected.id, scope: withDerived.checked ? "derived" : "artifact" }, value => { if (value.error) browser.error = value.error; browser.selected = null; browser.details = null; browser.refresh() }) } } }
    }
    CDialog {
        id: importDialog
        property string path: ""
        function openFor(path) { importDialog.path = path; importRemote.checked = false; importCloud.checked = false; open() }
        CText { text: "Import a copy"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: importDialog.path; font.family: "monospace"; font.pixelSize: Theme.caption; wrapMode: Text.WrapAnywhere; color: Theme.muted }
        CText { text: "Cere keeps a private copy; the original is not changed or watched. Who may process it:" }
        CCheckBox { checked: true; enabled: false; text: "Models and tools on this computer" }
        CCheckBox { id: importRemote; text: "Also your own servers (another computer running Ollama or ComfyUI)" }
        CCheckBox { id: importCloud; text: "Also cloud services (hosted image and vision APIs)" }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: importDialog.close() }
            CButton { objectName: "imagesImportConfirm"; text: "Import"; primary: true; onClicked: { importDialog.close(); rpc.call("artifacts.import", { sessionId: browser.sessionId, path: importDialog.path, destinations: { remote: importRemote.checked || importCloud.checked, cloud: importCloud.checked } }, value => { if (value.error) browser.error = value.error; else { browser.notice = "Imported " + value.name; browser.refresh() } }) } } }
    }
}
