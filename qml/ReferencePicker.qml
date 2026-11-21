import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// The composer's @ picker: files and folders in this conversation's workspace folders, its files and
// project shares, bound collections and other conversations in the project. Choosing one adds a
// structured reference that the broker resolves and re-checks when the message is sent; the text keeps
// only a readable @name. Typing stays in the composer: arrows move, Enter or Tab picks, Escape closes.
Popup {
    id: picker
    objectName: "referencePicker"
    property string sessionId: ""
    property string query: ""
    property var candidates: []
    property int current: 0
    property string error: ""
    property bool loading: false
    signal chosen(var candidate)
    padding: 4
    focus: false
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutsideParent
    background: Rectangle { color: Theme.raised; border.color: Theme.borderStrong; radius: Theme.radiusControl }
    RpcClient { id: rpc }
    Timer { id: debounce; interval: 150; onTriggered: picker.fetch() }
    onQueryChanged: if (opened) debounce.restart()
    onOpened: { current = 0; fetch() }
    function fetch() {
        if (!sessionId) return
        const asked = query; loading = true
        rpc.call("references.search", { sessionId: sessionId, query: asked }, value => {
            if (asked !== picker.query) return
            loading = false; error = value.error || ""; candidates = value.error ? [] : (value.candidates || []); current = 0
        })
    }
    function move(delta) { if (!candidates.length) return; current = (current + delta + candidates.length) % candidates.length; list.positionViewAtIndex(current, ListView.Contain) }
    function accept() { if (candidates[current]) chosen(candidates[current]) }
    function iconFor(kind) { return kind === "folder" ? "projects" : kind === "artifact" ? "image" : kind === "collection" ? "memory" : kind === "conversation" ? "chat" : "file" }
    function kindLabel(kind) { return ({ file: "File", folder: "Folder", artifact: "Conversation file", collection: "Collection", conversation: "Conversation" })[kind] || kind }
    contentItem: ColumnLayout {
        spacing: 2
        CText {
            objectName: "referencePickerStatus"
            visible: !picker.candidates.length
            text: picker.loading ? "Looking…" : picker.error || (picker.query ? "Nothing matches “" + picker.query + "”." : "Nothing to reference yet. Choose a workspace folder or add files in the Workbench.")
            color: picker.error ? Theme.danger : Theme.muted; font.pixelSize: Theme.caption
            Accessible.role: Accessible.StaticText; Accessible.name: text
        }
        ListView {
            id: list; objectName: "referenceCandidates"
            Layout.fillWidth: true; Layout.preferredHeight: Math.min(contentHeight, 264); clip: true
            visible: picker.candidates.length > 0
            model: picker.candidates; currentIndex: picker.current
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: CScrollBar {}
            Accessible.role: Accessible.List; Accessible.name: picker.candidates.length + " references for @" + picker.query
            delegate: ItemDelegate {
                required property var modelData; required property int index
                objectName: "referenceCandidate_" + index
                width: list.width; height: 44; highlighted: index === picker.current
                Accessible.role: Accessible.ListItem; Accessible.onPressAction: if (enabled) click(); Accessible.name: picker.kindLabel(modelData.kind) + " " + modelData.label + ", " + modelData.detail
                background: Rectangle { radius: Theme.radiusChip; color: parent.highlighted || parent.hovered ? Theme.selected : "transparent" }
                onClicked: { picker.current = index; picker.accept() }
                contentItem: RowLayout {
                    spacing: 8
                    CIcon { name: picker.iconFor(modelData.kind); Layout.preferredWidth: 18; Layout.preferredHeight: 18 }
                    ColumnLayout {
                        Layout.fillWidth: true; spacing: 0
                        CText { text: modelData.label; elide: Text.ElideMiddle; wrapMode: Text.NoWrap; font.pixelSize: Theme.secondary }
                        CText { text: picker.kindLabel(modelData.kind) + " · " + modelData.detail; elide: Text.ElideMiddle; wrapMode: Text.NoWrap; color: Theme.muted; font.pixelSize: Theme.caption }
                    }
                }
            }
        }
    }
}
