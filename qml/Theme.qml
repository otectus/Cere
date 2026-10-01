pragma Singleton
import QtQuick
// The one source of colour, type, spacing and shape for every Cere surface.
// Text pairs meet WCAG 2.2 AA (4.5:1) and every control boundary 3:1 on the surfaces
// it sits on; tests/qml-tokens.test.ts checks both and keeps literals out of other files.
QtObject {
    // Surfaces
    readonly property color background: "#0b121b"
    readonly property color sidebar: "#080f17"
    readonly property color surface: "#101b27"
    readonly property color raised: "#182736"
    readonly property color input: "#0c1621"
    readonly property color selected: "#13334a"
    readonly property color codeSurface: "#0d131c"
    readonly property color userBubble: "#112638"
    readonly property color approvalSurface: "#29291f"
    readonly property color questionSurface: "#22272c"
    readonly property color warningSurface: "#2b261e"
    readonly property color dangerSurface: "#33232e"
    readonly property color questionBadge: "#173746"
    readonly property color permissionBadge: "#3a3021"
    readonly property color overlayScrim: "#b304090f"
    // Lines: decorative outlines and dividers, then control boundaries (3:1 or more)
    readonly property color line: "#263848"
    readonly property color subtle: "#192937"
    readonly property color userBubbleBorder: "#2d5373"
    readonly property color border: "#61788f"
    readonly property color borderHover: "#7e96ae"
    readonly property color borderStrong: "#6b839c"
    readonly property color primaryBorder: "#2f86c2"
    readonly property color dangerBorder: "#a86b7a"
    readonly property color warningBorder: "#94784a"
    readonly property color approvalBorder: "#9a8150"
    readonly property color activeBorder: "#2f86c2"
    readonly property color scrollThumb: "#6b839c"
    readonly property color scrollThumbHover: "#8ba3ba"
    // Text and accents
    readonly property color text: "#edf5fc"
    readonly property color muted: "#9aafc2"
    readonly property color accent: "#149cff"
    readonly property color cyan: "#49dfff"
    readonly property color success: "#82dccc"
    readonly property color danger: "#ff9eae"
    readonly property color amber: "#ffd385"
    // Focus: a 2 px cyan ring on every focusable control
    readonly property color focus: cyan
    readonly property int focusWidth: 2
    // Type scale (logical px); nothing is smaller than caption
    readonly property string font: "Adwaita Sans"
    readonly property int caption: 11
    readonly property int secondary: 12
    readonly property int body: 13
    readonly property int message: 14
    readonly property int section: 15
    readonly property int title: 20
    readonly property int page: 22
    readonly property int display: 28
    readonly property int wordmark: 18
    readonly property int glyph: 20
    // Spacing scale
    readonly property int space1: 4
    readonly property int space2: 8
    readonly property int space3: 12
    readonly property int space4: 16
    readonly property int space5: 24
    // Shape
    readonly property int radiusChip: 6
    readonly property int radiusControl: 9
    readonly property int radiusCard: 12
    readonly property int radiusPanel: 14
    readonly property int radiusDialog: 16
    readonly property int radius: radiusCard
    // Motion: reduced motion and quiet mode stop transitions; lower intensity shortens them and 0 stops them.
    readonly property bool reducedMotion: App.state.settings?.reducedMotion === true || App.state.settings?.quiet === true
    readonly property real motionScale: reducedMotion ? 0 : Math.max(0, Math.min(1, (App.state.settings?.motionIntensity ?? 0.7) / 0.7))
    function duration(ms) { return Math.round(ms * motionScale) }
}
