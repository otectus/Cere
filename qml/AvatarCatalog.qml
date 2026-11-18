pragma Singleton
import QtQuick

QtObject {
    // Production uses the validated native catalog. Standalone previews and
    // qmltestrunner read the same manifest without a broker or native host.
    readonly property var entries: typeof App !== "undefined" ? App.avatarCatalog : load()
    readonly property var defaultEntry: entries.find(function(entry) { return entry.default })
    readonly property string defaultId: defaultEntry.id
    function load() {
        const request = new XMLHttpRequest()
        request.open("GET", Qt.resolvedUrl("../assets/avatars.json"), false)
        request.send()
        return JSON.parse(request.responseText)
    }
    function avatarFor(id) {
        return entries.find(function(entry) { return entry.id === id || entry.aliases.indexOf(id) >= 0 }) || defaultEntry
    }
}
