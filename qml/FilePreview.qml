import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Preview: one file as numbered lines (or rendered Markdown), with a small-file editor whose
// Save makes a change set reviewed like any other. Nothing here writes a file directly.
Item {
    id: preview
    objectName: "filePreview"
    property string sessionId: ""
    property var roots: []
    readonly property var target: WorkbenchState.fileFor(sessionId)
    readonly property var root: roots.find(r => r.id === target.rootId) || null
    readonly property string absolute: root && target.path ? root.path + "/" + target.path : ""
    property var page: ({})
    property var lines: []
    property string error: ""
    property bool markdown: false
    property bool editing: false
    property var editable: null
    property bool recoveredDraft: false
    property string reviewError: ""
    readonly property string ownerKey: sessionId + ":" + (target.rootId || "") + ":" + (target.path || "")
    RpcClient { id: rpc; scope: preview.ownerKey }
    Timer { id: initialLoad; interval: 0; onTriggered: { preview.load(1); if (WorkbenchState.fileDraft(preview.sessionId, preview.target.rootId, preview.target.path) !== undefined) preview.startEditing() } }
    function load(from) {
        if (!target.path || target.sessionId !== sessionId) { lines = []; page = ({}); return }
        error = ""
        const start = from || 1
        rpc.call("files.read", { sessionId: sessionId, rootId: target.rootId, path: target.path, startLine: start, lineCount: 300 }, value => {
            if (value.error) { error = value.error; return }
            page = value
            const rows = (value.text || "").length ? value.text.split("\n").map(row => { const bar = row.indexOf("| "); return { line: Number(row.slice(0, bar)), text: row.slice(bar + 2) } }) : []
            lines = start > 1 ? lines.concat(rows) : rows
            if (start === 1 && target.line > 1) Qt.callLater(() => body.positionViewAtIndex(Math.max(0, target.line - 1), ListView.Center))
        })
    }
    function startEditing() {
        reviewError = ""
        rpc.call("files.text", { sessionId: sessionId, rootId: target.rootId, path: target.path }, value => {
            if (value.error) { reviewError = value.error; return }
            const saved = WorkbenchState.fileDraft(sessionId, target.rootId, target.path)
            recoveredDraft = saved !== undefined
            // Recovered text keeps the exact version and original content it began from. Pairing it
            // with the latest version would weaken the change review's concurrency precondition.
            editable = saved && typeof saved === "object" ? Object.assign({}, value, { version: saved.baseVersion, text: saved.baseText }) : value
            editor.text = saved && typeof saved === "object" ? saved.text : value.text
            editing = true; Qt.callLater(() => editor.forceActiveFocus())
        })
    }
    function cancelEditing() { WorkbenchState.keepFileDraft(sessionId, target.rootId, target.path, undefined); editing = false; editable = null; recoveredDraft = false }
    function proposeEdit() {
        reviewError = ""
        rpc.call("changes.propose", { sessionId: sessionId, reason: "Edited in the Workbench",
            operations: [{ kind: "patch_text", rootId: target.rootId, path: target.path, baseVersion: editable.version, content: editor.text }] }, value => {
            if (value.error) { reviewError = value.error; return }
            WorkbenchState.keepFileDraft(sessionId, target.rootId, target.path, undefined)
            editing = false; recoveredDraft = false; WorkbenchState.openReview(value.id, sessionId)
        })
    }
    onTargetChanged: { editing = false; editable = null; recoveredDraft = false; markdown = false; error = ""; reviewError = ""; lines = []; page = ({}); initialLoad.restart() }
    onSessionIdChanged: { editing = false; editable = null; recoveredDraft = false; lines = []; page = ({}); initialLoad.restart() }
    Component.onCompleted: initialLoad.restart()

    ColumnLayout {
        anchors.fill: parent; spacing: 8
        CText { visible: !preview.target.path; text: "Choose a file in Files to preview it here."; color: Theme.muted }
        RowLayout {
            visible: !!preview.target.path; Layout.fillWidth: true; spacing: 6
            ColumnLayout {
                Layout.fillWidth: true; spacing: 0
                CText { objectName: "previewPath"; text: preview.target.path || ""; font.weight: Font.DemiBold; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
                CText { text: preview.page.binary ? preview.page.kind : preview.page.version ? (preview.page.totalLines + " lines · " + (preview.page.newline || "").toUpperCase() + " line endings · version " + String(preview.page.version).slice(7, 19)) : ""; color: Theme.muted; font.pixelSize: Theme.caption }
            }
            CButton { objectName: "previewMarkdown"; visible: /\.(md|markdown)$/i.test(preview.target.path || "") && !preview.editing; text: preview.markdown ? "Source" : "Rendered"; quiet: true; onClicked: preview.markdown = !preview.markdown }
            CButton { objectName: "previewEdit"; visible: !!preview.root && preview.root.policy.write && !preview.page.binary && !preview.editing; text: "Edit"; iconName: "edit"; onClicked: preview.startEditing() }
            CButton { objectName: "previewOpen"; visible: !!preview.absolute; text: ""; iconName: "expand"; help: "Open in its application"; Accessible.name: "Open in its application"; onClicked: App.openPath(preview.absolute) }
            CButton { objectName: "previewReveal"; visible: !!preview.absolute; text: ""; iconName: "projects"; help: "Show in the file manager"; Accessible.name: "Show in the file manager"; onClicked: App.openPath(preview.absolute.slice(0, preview.absolute.lastIndexOf("/"))) }
        }
        CText { visible: !!preview.error; text: preview.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { visible: !!preview.reviewError; text: preview.reviewError; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { visible: !!preview.page.binary; text: "This file is not text (" + (preview.page.kind || "binary") + "), so Cere does not show it here. Open it in its application instead."; color: Theme.muted }
        CText { visible: !!preview.page.versionChanged; text: "The file changed while you were viewing it."; color: Theme.amber; font.pixelSize: Theme.secondary }
        // Interactive web previews need an isolated browser process (no cookies, network or file access);
        // this build does not include that optional module, so the source is shown and nothing runs.
        CText { objectName: "previewHtmlUnavailable"; visible: /\.(html?|xhtml|svg)$/i.test(preview.target.path || "") && !preview.page.binary
            text: "Interactive preview is not available in this installation: it needs Cere’s optional isolated preview module. The source is shown instead, and nothing in it runs. Opening it in its application uses your normal browser profile."
            color: Theme.muted; font.pixelSize: Theme.caption }
        ListView {
            id: body; objectName: "previewLines"
            visible: !!preview.target.path && !preview.page.binary && !preview.markdown && !preview.editing
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true
            boundsBehavior: Flickable.StopAtBounds; activeFocusOnTab: true
            ScrollBar.vertical: CScrollBar {}
            ScrollBar.horizontal: ScrollBar { policy: ScrollBar.AsNeeded }
            contentWidth: Math.max(width, 2000); flickableDirection: Flickable.AutoFlickIfNeeded
            model: preview.lines
            Keys.onUpPressed: flick(0, 800); Keys.onDownPressed: flick(0, -800)
            delegate: Row {
                required property var modelData
                spacing: 10
                Text { width: 52; horizontalAlignment: Text.AlignRight; text: modelData.line; color: modelData.line === preview.target.line ? Theme.accentText : Theme.muted; font.family: "monospace"; font.pixelSize: Theme.caption; textFormat: Text.PlainText }
                Text { text: modelData.text; color: Theme.text; font.family: "monospace"; font.pixelSize: Theme.caption; textFormat: Text.PlainText }
            }
            footer: CButton { visible: !!preview.page.nextStartLine; quiet: true; text: "Show more lines"; onClicked: preview.load(preview.page.nextStartLine) }
        }
        ScrollView {
            visible: preview.markdown && !preview.editing
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true
            contentWidth: availableWidth
            Text { width: parent.width; text: preview.lines.map(row => row.text).join("\n"); textFormat: Text.MarkdownText; wrapMode: Text.Wrap; color: Theme.text; font.family: Theme.font; font.pixelSize: Theme.body; onLinkActivated: link => App.openMessageLink(link, preview.root ? preview.root.path : "") }
        }
        ScrollView {
            visible: preview.editing; Layout.fillWidth: true; Layout.fillHeight: true; clip: true
            CTextArea { id: editor; objectName: "previewEditor"; font.family: Theme.mono; font.pixelSize: Theme.caption; wrapMode: TextEdit.NoWrap; selectByMouse: true; Accessible.name: "Edit " + (preview.target.path || "")
                onTextChanged: if (preview.editing && preview.editable) WorkbenchState.keepFileDraft(preview.sessionId, preview.target.rootId, preview.target.path, { text: text, baseVersion: preview.editable.version, baseText: preview.editable.text }) }
        }
        RowLayout {
            visible: preview.editing; Layout.fillWidth: true
            CText { Layout.fillWidth: true; text: preview.recoveredDraft ? "Recovered your unsent edit. Its original file version will still be checked during review." : "Saving creates a change you review before anything is written."; color: preview.recoveredDraft ? Theme.amber : Theme.muted; font.pixelSize: Theme.caption }
            CButton { text: "Cancel"; onClicked: preview.cancelEditing() }
            CButton { objectName: "previewProposeEdit"; text: "Review change"; primary: true; enabled: !!preview.editable && editor.text !== preview.editable.text; onClicked: preview.proposeEdit() }
        }
    }
}
