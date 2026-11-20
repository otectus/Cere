import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Connections › Saved connections (11.1): more Ollama hosts and OpenAI-compatible endpoints,
// each under a name. A conversation keeps the connection it was created on; the entries above are the
// defaults for new conversations. Keys are saved per endpoint address, never in settings.
ColumnLayout {
    id: named
    objectName: "namedConnections"
    Layout.fillWidth: true; spacing: 8
    property var items: []
    property string error: ""
    RpcClient { id: rpc }
    function refresh() { rpc.call("connections.list", {}, value => { if (!value.error) items = value }) }
    Component.onCompleted: refresh()
    Connections { target: App; function onConnectedChanged() { if (App.connected) named.refresh() } }
    CText { text: "Keep another Ollama computer or another compatible server under a name, and choose it in New conversation. Each conversation stays on the connection it started with; moving one asks you to confirm the new destination."; color: Theme.muted; font.pixelSize: Theme.secondary }
    Repeater {
        model: named.items.filter(item => !item.migrated)
        Rectangle {
            required property var modelData; required property int index
            objectName: "namedConnection_" + index
            Layout.fillWidth: true; implicitHeight: row.implicitHeight + 20; radius: Theme.radiusControl; color: Theme.raised; border.color: Theme.border
            RowLayout {
                id: row; anchors.fill: parent; anchors.margins: 10; spacing: 8
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 1
                    CText { text: modelData.name; font.weight: Font.DemiBold; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                    CText { text: (modelData.kind === "ollama" ? "Ollama · " + modelData.host : "Compatible · " + (modelData.endpoint?.baseUrl || "") + " · processes on " + (modelData.endpoint?.processing || "unknown") + (modelData.endpoint?.requiresKey ? (modelData.keySet ? " · key set" : " · key missing") : ""))
                        + " · " + modelData.conversations + (modelData.conversations === 1 ? " conversation" : " conversations"); color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
                }
                CButton { text: "Edit…"; quiet: true; onClicked: editor.openFor(modelData) }
                CButton { text: "Remove"; quiet: true; danger: true; onClicked: rpc.call("connections.remove", { id: modelData.id }, value => { named.error = value.error || ""; named.refresh() }) }
            }
        }
    }
    CButton { objectName: "addNamedConnection"; text: "Add a connection…"; iconName: "plus"; enabled: App.connected; onClicked: editor.openFor(null) }
    CText { visible: !!named.error; text: named.error; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    CDialog {
        id: editor; objectName: "namedConnectionEditor"
        property var existing: null
        readonly property bool ollama: kind.currentIndex === 0
        function openFor(item) {
            existing = item; kind.currentIndex = item?.kind === "compatible" ? 1 : 0; kind.enabled = !item; name.text = item?.name || ""
            address.text = item ? (item.host || item.endpoint?.baseUrl || "") : ""; processing.currentIndex = Math.max(0, ["local", "remote", "cloud", "unknown"].indexOf(item?.endpoint?.processing || "unknown"))
            needsKey.checked = !!item?.endpoint?.requiresKey; tools.checked = !!item?.endpoint?.tools; images.checked = !!item?.endpoint?.images; key.text = ""; message.text = ""; open()
        }
        CText { text: editor.existing ? "Edit connection" : "Add a connection"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CComboBox { id: kind; objectName: "namedConnectionKind"; Layout.fillWidth: true; model: ["Ollama on another computer or port", "OpenAI-compatible endpoint"]; Accessible.name: "Kind of connection" }
        CField { id: name; objectName: "namedConnectionName"; Layout.fillWidth: true; maximumLength: 60; placeholderText: "Name, such as Workstation GPU"; Accessible.name: "Connection name" }
        CField { id: address; objectName: "namedConnectionAddress"; Layout.fillWidth: true; placeholderText: editor.ollama ? "http://192.168.1.20:11434" : "https://gateway.example.com/v1"; Accessible.name: "Address" }
        CComboBox { id: processing; visible: !editor.ollama; Layout.fillWidth: true; model: ["Processes on this computer", "Processes on my own server", "Processes in a cloud service", "Not sure"]; Accessible.name: "Where it processes requests" }
        Flow {
            visible: !editor.ollama; Layout.fillWidth: true; spacing: 12
            CCheckBox { id: needsKey; width: implicitContentWidth + leftPadding + rightPadding; text: "Needs a key" }
            CCheckBox { id: tools; width: implicitContentWidth + leftPadding + rightPadding; text: "Supports tools" }
            CCheckBox { id: images; width: implicitContentWidth + leftPadding + rightPadding; text: "Accepts images" }
        }
        CField { id: key; visible: !editor.ollama && needsKey.checked; Layout.fillWidth: true; echoMode: TextInput.Password; placeholderText: editor.existing?.keySet ? "Leave empty to keep the saved key" : "Key for this address"; Accessible.name: "Endpoint key" }
        CText { visible: !editor.ollama; text: "What you declare is what Cere sends; it is not verified. Where it processes decides which files and images may go to it."; color: Theme.muted; font.pixelSize: Theme.caption }
        CText { id: message; visible: !!text; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
        RowLayout {
            Layout.fillWidth: true
            Item { Layout.fillWidth: true }
            CButton { text: "Cancel"; onClicked: editor.close() }
            CButton {
                objectName: "namedConnectionSave"; text: "Save"; primary: true; enabled: name.text.trim().length > 0 && address.text.trim().length > 0
                onClicked: {
                    const value = Object.assign({ name: name.text.trim() }, editor.existing ? { id: editor.existing.id, expectedRevision: editor.existing.revision } : { kind: editor.ollama ? "ollama" : "compatible" },
                        editor.ollama ? { host: address.text.trim() } : { endpoint: { baseUrl: address.text.trim(), processing: ["local", "remote", "cloud", "unknown"][processing.currentIndex], requiresKey: needsKey.checked, tools: tools.checked, images: images.checked } })
                    rpc.call("connections.save", value, saved => {
                        if (saved.error) { message.text = saved.error; return }
                        if (!editor.ollama && key.text) rpc.call("provider.credentials", { provider: "compatible", key: key.text, connectionId: saved.id }, () => named.refresh())
                        editor.close(); named.refresh()
                    })
                }
            }
        }
    }
}
