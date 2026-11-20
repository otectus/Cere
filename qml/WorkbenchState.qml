pragma Singleton
import QtQuick
// Workbench state shared by the compact panel and the expanded workspace, which run in one QML engine:
// the open pane, chosen folders, the previewed file and its position, the reviewed change set and
// unsent image edits survive moving between the two windows.
QtObject {
    id: state
    property bool open: false
    property string tab: "files"
    property var roots: ({})
    property var folders: ({})
    property var file: ({})
    property var scroll: ({})
    property string changeSetId: ""
    property string artifactId: ""
    property string versionId: ""
    property real zoom: 1
    property var editorDrafts: ({})
    property var references: ({})
    /** The palette's "Create image" opens the Images pane with its Create panel showing. */
    property bool createRequested: false
    property real paneWidth: 460
    signal requested()
    function show(tab) { if (tab) state.tab = tab; open = true; requested() }
    function hide() { open = false }
    function openReview(changeSetId) { state.changeSetId = changeSetId; show("changes") }
    function openFile(sessionId, rootId, path, line) { file = { sessionId: sessionId, rootId: rootId, path: path, line: line || 1 }; show("preview") }
    function rootFor(sessionId) { return roots[sessionId] || "" }
    function setRoot(sessionId, rootId) { const next = Object.assign({}, roots); next[sessionId] = rootId; roots = next }
    function folder(sessionId, rootId) { return folders[sessionId + ":" + rootId] || "" }
    function setFolder(sessionId, rootId, path) { const next = Object.assign({}, folders); next[sessionId + ":" + rootId] = path; folders = next }
    function position(key) { return scroll[key] || 0 }
    function remember(key, y) { const next = Object.assign({}, scroll); next[key] = y; scroll = next }
    function draft(key) { return editorDrafts[key] }
    function keepDraft(key, value) { const next = Object.assign({}, editorDrafts); if (value === undefined) delete next[key]; else next[key] = value; editorDrafts = next }
    /** Text the person chose to put in a conversation's message box, such as a filled-in MCP prompt. */
    signal insertIntoComposer(string sessionId, string text)
    function referencesFor(sessionId) { return references[sessionId] || [] }
    function setReferences(sessionId, list) { const next = Object.assign({}, references); next[sessionId] = list; references = next }
}
