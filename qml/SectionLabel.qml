import QtQuick
Text {
    Accessible.role: Accessible.Heading
    Accessible.name: text
    Accessible.focusable: false
    color: Theme.muted
    font.family: Theme.font
    font.pixelSize: Theme.caption
    font.weight: Font.DemiBold
    font.letterSpacing: 1.4
}
