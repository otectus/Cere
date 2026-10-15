pragma Singleton
import QtQuick
// Shared colour, type, spacing and shape for every Cere surface.
// Palettes live in assets/palettes.json and follow the saved avatar.
// Text pairs meet WCAG 2.2 AA (4.5:1) and every control boundary 3:1 on the surfaces
// it sits on; tests/qml-tokens.test.ts checks both and keeps literals out of other files.
QtObject {
    // The native host and QML share the same catalog. Standalone component previews
    // read it directly (qmltestrunner enables local-file reads); production uses App.
    readonly property var palettes: typeof App !== "undefined" ? App.themes : loadPalettes()
    readonly property var colors: typeof App !== "undefined" ? App.theme : palettes.cere
    function loadPalettes() {
        const request = new XMLHttpRequest()
        request.open("GET", Qt.resolvedUrl("../assets/palettes.json"), false)
        request.send()
        return JSON.parse(request.responseText)
    }
    function paletteFor(avatarId) { return palettes[avatarId] || palettes.cere }
    readonly property color background: colors.background
    readonly property color sidebar: colors.sidebar
    readonly property color surface: colors.surface
    readonly property color raised: colors.raised
    readonly property color input: colors.input
    readonly property color selected: colors.selected
    readonly property color codeSurface: colors.codeSurface
    readonly property color userBubble: colors.userBubble
    readonly property color approvalSurface: colors.approvalSurface
    readonly property color questionSurface: colors.questionSurface
    readonly property color warningSurface: colors.warningSurface
    readonly property color dangerSurface: colors.dangerSurface
    readonly property color questionBadge: colors.questionBadge
    readonly property color permissionBadge: colors.permissionBadge
    readonly property color overlayScrim: colors.overlayScrim
    readonly property color line: colors.line
    readonly property color subtle: colors.subtle
    readonly property color userBubbleBorder: colors.userBubbleBorder
    readonly property color border: colors.border
    readonly property color borderHover: colors.borderHover
    readonly property color borderStrong: colors.borderStrong
    readonly property color primaryBorder: colors.primaryBorder
    readonly property color dangerBorder: colors.dangerBorder
    readonly property color warningBorder: colors.warningBorder
    readonly property color approvalBorder: colors.approvalBorder
    readonly property color activeBorder: colors.activeBorder
    readonly property color scrollThumb: colors.scrollThumb
    readonly property color scrollThumbHover: colors.scrollThumbHover
    readonly property color text: colors.text
    readonly property color muted: colors.muted
    readonly property color accent: colors.accent
    readonly property color accentText: colors.accentText
    readonly property color success: colors.success
    readonly property color danger: colors.danger
    readonly property color amber: colors.amber
    readonly property color warm: colors.warm
    readonly property color portraitSurface: colors.portraitSurface
    readonly property color portraitTop: colors.portraitTop
    readonly property color portraitBottom: colors.portraitBottom
    readonly property color portraitBorder: colors.portraitBorder
    readonly property color portraitAccent: colors.portraitAccent
    readonly property color portraitWarm: colors.portraitWarm
    readonly property color portraitAttention: colors.portraitAttention
    readonly property color portraitSpeech: colors.portraitSpeech
    readonly property color stageSurface: colors.stageSurface
    readonly property color stageBorder: colors.stageBorder
    readonly property color stageSpotlight: colors.stageSpotlight
    readonly property color stageSpotlightBorder: colors.stageSpotlightBorder
    readonly property color badgeSurface: colors.badgeSurface
    readonly property color petShadow: colors.petShadow
    readonly property color focus: accentText
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
    readonly property bool reducedMotion: typeof App !== "undefined" && (App.state.settings?.reducedMotion === true || App.state.settings?.quiet === true)
    readonly property real motionScale: reducedMotion ? 0 : Math.max(0, Math.min(1, (typeof App !== "undefined" ? (App.state.settings?.motionIntensity ?? 0.7) : 0.7) / 0.7))
    function duration(ms) { return Math.round(ms * motionScale) }
}
