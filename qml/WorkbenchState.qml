pragma Singleton
import QtQuick
import QtCore
// Each UI host keeps its Workbench selections and unsent edits across session and layout changes.
// Only layout preferences are written to the shared desktop settings file.
QtObject {
    id: state
    property bool open: false
    property string tab: "files"
    property var roots: ({})
    property var folders: ({})
    // The scalar selections remain for compatibility with existing entry points; panes read the
    // session maps so one conversation can never display another conversation's file or review.
    property var file: ({})
    property var files: ({})
    property var scroll: ({})
    property string changeSetId: ""
    property var reviews: ({})
    property string artifactId: ""
    property string versionId: ""
    property var images: ({})
    property real zoom: 1
    property var editorDrafts: ({})
    property var fileDrafts: ({})
    property var references: ({})
    /** The palette's "Create image" opens the Images pane with its Create panel showing. */
    property bool createRequested: false
    readonly property Settings layout: Settings {
        id: preferences
        location: App.layoutSettingsUrl
        category: "navigation"
        property real paneWidth: 460
        property bool collapsed: false
    }
    property alias paneWidth: preferences.paneWidth
    signal requested()
    function show(tab) { if (tab) state.tab = tab; open = true; requested() }
    function hide() { open = false }
    function openReview(changeSetId, sessionId) { setReview(sessionId || App.selectedId, changeSetId); show("changes") }
    function setReview(sessionId, id) { if ((reviews[sessionId] || "") === (id || "")) { changeSetId = id || ""; return } const next = Object.assign({}, reviews); if (id) next[sessionId] = id; else delete next[sessionId]; reviews = next; changeSetId = id || "" }
    function changeSetFor(sessionId) { return reviews[sessionId] || "" }
    function openFile(sessionId, rootId, path, line) { const value = { sessionId: sessionId, rootId: rootId, path: path, line: line || 1 }, next = Object.assign({}, files); next[sessionId] = value; files = next; file = value; show("preview") }
    function fileFor(sessionId) { return files[sessionId] || ({}) }
    function selectImage(sessionId, artifact, version) { const next = Object.assign({}, images); if (artifact && version) next[sessionId] = { artifactId: artifact, versionId: version }; else delete next[sessionId]; images = next; artifactId = artifact || ""; versionId = version || "" }
    function imageFor(sessionId) { return images[sessionId] || ({ artifactId: "", versionId: "" }) }
    function clearImage(sessionId) { selectImage(sessionId, "", "") }
    function activateSession(sessionId) { const selectedFile = fileFor(sessionId), selectedImage = imageFor(sessionId); file = selectedFile; changeSetId = changeSetFor(sessionId); artifactId = selectedImage.artifactId; versionId = selectedImage.versionId }
    function rootFor(sessionId) { return roots[sessionId] || "" }
    function setRoot(sessionId, rootId) { const next = Object.assign({}, roots); next[sessionId] = rootId; roots = next }
    function folder(sessionId, rootId) { return folders[sessionId + ":" + rootId] || "" }
    function setFolder(sessionId, rootId, path) { const next = Object.assign({}, folders); next[sessionId + ":" + rootId] = path; folders = next }
    function position(key) { return scroll[key] || 0 }
    function remember(key, y) { const next = Object.assign({}, scroll); next[key] = y; scroll = next }
    function draft(key, sessionId) { return editorDrafts[(sessionId ? sessionId + ":" : "") + key] }
    function keepDraft(key, value, sessionId) { const id = (sessionId ? sessionId + ":" : "") + key, next = Object.assign({}, editorDrafts); if (value === undefined) delete next[id]; else next[id] = value; editorDrafts = next }
    function fileDraft(sessionId, rootId, path) { return fileDrafts[sessionId + ":" + rootId + ":" + path] }
    function keepFileDraft(sessionId, rootId, path, value) { const id = sessionId + ":" + rootId + ":" + path, next = Object.assign({}, fileDrafts); if (value === undefined) delete next[id]; else next[id] = value; fileDrafts = next }
    /** Text the person chose to put in a conversation's message box, such as a filled-in MCP prompt. */
    signal insertIntoComposer(string sessionId, string text)
    function referencesFor(sessionId) { return references[sessionId] || [] }
    function setReferences(sessionId, list) { const next = Object.assign({}, references); next[sessionId] = list; references = next }
}
