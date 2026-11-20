import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A file Cere produced or kept, resolved through the broker by its artifact and version IDs. A link
// written in a reply is never shown this way; only broker-issued references are.
Rectangle {
    id: card
    objectName: "artifactCard_" + (reference.versionId || "")
    property var reference: ({})
    property string sessionId: ""
    property var info: null
    property string thumbnail: ""
    property string error: ""
    property string notice: ""
    readonly property var version: info ? (info.versions || []).find(v => v.versionId === reference.versionId) || null : null
    readonly property bool image: !!version && (version.kind === "image" || version.kind === "plot")
    implicitHeight: row.implicitHeight + 16
    radius: Theme.radiusControl; color: Theme.input; border.color: Theme.subtle
    Accessible.role: Accessible.Grouping; Accessible.name: version ? "File " + version.name : "File"
    RpcClient { id: rpc }
    function size(bytes) { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? Math.round(bytes / 1024) + " KiB" : (bytes / 1048576).toFixed(1) + " MiB" }
    function load() {
        if (!reference.artifactId || !sessionId) return
        rpc.call("artifacts.get", { sessionId: sessionId, artifactId: reference.artifactId }, value => {
            if (value.error) { error = value.error; return }
            info = value; error = ""
            if (version && !version.available) error = "The stored file is missing; it cannot be opened."
            else if (image) rpc.call("artifacts.thumbnail", { sessionId: sessionId, artifactId: reference.artifactId, versionId: reference.versionId, size: 160 }, thumb => { if (!thumb.error) card.thumbnail = thumb.data || "" })
        })
    }
    function openIt() {
        if (image) { WorkbenchState.artifactId = reference.artifactId; WorkbenchState.versionId = reference.versionId; App.selectedId = sessionId; WorkbenchState.show("images"); App.rpc("images.select", { sessionId: sessionId, ref: { artifactId: reference.artifactId, versionId: reference.versionId } }); return }
        rpc.call("artifacts.file", { sessionId: sessionId, artifactId: reference.artifactId, versionId: reference.versionId }, value => { if (value.error) error = value.error; else App.openPath(value.path) })
    }
    function saveAs() {
        const path = App.chooseSavePath(version ? version.name : "export")
        if (!path) return
        rpc.call("artifacts.saveAs", { sessionId: sessionId, artifactId: reference.artifactId, versionId: reference.versionId, path: path, replace: true }, value => { if (value.error) error = value.error; else { notice = "Saved to " + value.path; load() } })
    }
    Component.onCompleted: load()
    onReferenceChanged: load()
    RowLayout {
        id: row; anchors.fill: parent; anchors.margins: 8; spacing: 10
        Rectangle {
            visible: card.image; Layout.preferredWidth: 96; Layout.preferredHeight: 72; radius: 4; color: Theme.codeSurface; clip: true
            Image { anchors.fill: parent; source: card.thumbnail; fillMode: Image.PreserveAspectFit; asynchronous: true; smooth: true
                Accessible.role: Accessible.Graphic; Accessible.name: card.version ? "Thumbnail of " + card.version.name : "Thumbnail" }
            CText { anchors.centerIn: parent; visible: !card.thumbnail; text: card.error ? "Missing" : "…"; color: Theme.muted; font.pixelSize: Theme.caption; horizontalAlignment: Text.AlignHCenter }
        }
        ColumnLayout {
            Layout.fillWidth: true; spacing: 2
            CText { text: card.version ? card.version.name : "Loading file…"; font.weight: Font.DemiBold; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
            CText { visible: !!card.version; color: Theme.muted; font.pixelSize: Theme.caption
                text: card.version ? [card.version.image ? card.version.image.width + "×" + card.version.image.height : card.version.mime, card.size(card.version.bytes), card.version.source === "model-generation" ? "generated" : card.version.source === "user-import" ? "imported" : card.version.source === "derived" ? "derived" : "tool output",
                    (card.info?.versions || []).length > 1 ? "version " + ((card.info.versions || []).findIndex(v => v.versionId === card.reference.versionId) + 1) + " of " + card.info.versions.length : "", card.reference.purpose || ""].filter(s => s).join(" · ") : "" }
            CText { visible: !!card.error; text: card.error; color: Theme.danger; font.pixelSize: Theme.caption; Accessible.role: Accessible.AlertMessage }
            CText { visible: !!card.notice; text: card.notice; color: Theme.muted; font.pixelSize: Theme.caption }
            Flow {
                Layout.fillWidth: true; spacing: 4; visible: !!card.version && !card.error
                CButton { objectName: "artifactOpen"; text: card.image ? "View" : "Open"; implicitHeight: 28; quiet: true; onClicked: card.openIt() }
                CButton { objectName: "artifactSaveAs"; text: "Save as…"; implicitHeight: 28; quiet: true; onClicked: card.saveAs() }
                CButton { objectName: "artifactUse"; text: "Use in next message"; implicitHeight: 28; quiet: true; visible: card.image || (card.version && card.version.mime.startsWith("text/"))
                    onClicked: rpc.call("artifacts.useInDraft", { sessionId: card.sessionId, artifactId: card.reference.artifactId, versionId: card.reference.versionId }, value => { card.notice = value.error ? "" : "Attached to your draft"; card.error = value.error || "" }) }
                CButton { objectName: "artifactRevealExport"; visible: !!card.version && (card.version.exports || []).length > 0; text: "Show saved copy"; implicitHeight: 28; quiet: true
                    onClicked: { const path = card.version.exports[0].destination; App.openPath(path.slice(0, path.lastIndexOf("/"))) } }
            }
        }
    }
}
