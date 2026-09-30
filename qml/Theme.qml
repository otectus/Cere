pragma Singleton
import QtQuick
QtObject {
    readonly property color background: "#0b121b"
    readonly property color sidebar: "#080f17"
    readonly property color surface: "#101b27"
    readonly property color raised: "#182736"
    readonly property color input: "#0c1621"
    readonly property color selected: "#13334a"
    readonly property color line: "#263848"
    readonly property color subtle: "#192937"
    readonly property color text: "#edf5fc"
    readonly property color muted: "#9aafc2"
    readonly property color accent: "#149cff"
    readonly property color cyan: "#49dfff"
    readonly property color success: "#82dccc"
    readonly property color danger: "#ff9eae"
    readonly property color amber: "#ffd385"
    readonly property string font: "Adwaita Sans"
    readonly property int radius: 12
    readonly property bool reducedMotion: App.state.settings?.reducedMotion === true || App.state.settings?.quiet === true
}
