import QtQuick
// Calls a broker method and runs one callback with its result; a result with `error` is a failure.
// A call made while disconnected, or still waiting when the broker goes away, answers with an error
// instead of waiting forever, so a pane is never stuck "busy" after a broker restart.
QtObject {
    id: client
    // A pane can bind this to its owner (usually a session, file or artifact). Changing owner
    // forgets its old callbacks, so a late reply can never populate the new owner's UI.
    property var scope: undefined
    property var pending: ({})
    readonly property bool busy: Object.keys(pending).length > 0
    function call(method, params, callback) {
        const callScope = scope
        const id = App.rpc(method, params || {})
        if (id < 0) { if (callback) Qt.callLater(() => { if (callScope === scope) callback({ error: "Cere is reconnecting to her session broker.", code: "DISCONNECTED" }) }); return id }
        if (callback) { const next = Object.assign({}, pending); next[id] = { callback: callback, scope: callScope }; pending = next }
        return id
    }
    onScopeChanged: pending = ({})
    property Connections watcher: Connections {
        target: App
        function onResult(id, value) {
            const entry = client.pending[id]
            if (!entry) return
            const next = Object.assign({}, client.pending); delete next[id]; client.pending = next
            if (entry.scope === client.scope) entry.callback(value === undefined || value === null ? ({}) : value)
        }
    }
    // App.connected is notified through stateChanged; a bound copy reports the actual change.
    property bool online: App.connected
    onOnlineChanged: {
        if (online || !Object.keys(pending).length) return
        const waiting = pending; pending = ({})
        for (const id of Object.keys(waiting)) if (waiting[id].scope === scope) waiting[id].callback({ error: "The session broker restarted before answering.", code: "CONNECTION_LOST" })
    }
}
