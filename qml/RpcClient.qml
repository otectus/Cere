import QtQuick
// Calls a broker method and runs one callback with its result; a result with `error` is a failure.
// A call made while disconnected, or still waiting when the broker goes away, answers with an error
// instead of waiting forever, so a pane is never stuck "busy" after a broker restart.
QtObject {
    id: client
    property var pending: ({})
    readonly property bool busy: Object.keys(pending).length > 0
    function call(method, params, callback) {
        const id = App.rpc(method, params || {})
        if (id < 0) { if (callback) Qt.callLater(() => callback({ error: "Cere is reconnecting to her session broker.", code: "DISCONNECTED" })); return id }
        if (callback) { const next = Object.assign({}, pending); next[id] = callback; pending = next }
        return id
    }
    property Connections watcher: Connections {
        target: App
        function onResult(id, value) {
            const callback = client.pending[id]
            if (!callback) return
            const next = Object.assign({}, client.pending); delete next[id]; client.pending = next
            callback(value === undefined || value === null ? ({}) : value)
        }
    }
    // App.connected is notified through stateChanged; a bound copy reports the actual change.
    property bool online: App.connected
    onOnlineChanged: {
        if (online || !Object.keys(pending).length) return
        const waiting = pending; pending = ({})
        for (const id of Object.keys(waiting)) waiting[id]({ error: "The session broker restarted before answering.", code: "CONNECTION_LOST" })
    }
}
