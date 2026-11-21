import QtQuick
import QtQuick.Layouts
Rectangle {
    id: section
    default property alias body: contents.data
    property string title
    property string description
    property string hint
    Layout.fillWidth: true
    Layout.minimumWidth: 0
    Layout.alignment: Qt.AlignTop
    implicitHeight: contents.implicitHeight + Theme.space4 * 2
    color: Theme.surface
    radius: Theme.radiusCard
    border.color: Theme.subtle
    ColumnLayout {
        id: contents
        x: Theme.space4; y: Theme.space4; width: Math.max(0,parent.width - x * 2); spacing: Theme.space3
        RowLayout {
            Layout.fillWidth: true
            CText { text: section.title; Accessible.role: Accessible.Heading; font.pixelSize: Theme.section; font.weight: Font.DemiBold }
            Text { Layout.maximumWidth: contents.width * 0.45; elide: Text.ElideRight; visible: section.hint.length>0; text: section.hint; color: Theme.muted; font.family: Theme.font; font.pixelSize: Theme.caption }
        }
        CText { visible: text.length>0; text: section.description; color: Theme.muted; font.pixelSize: Theme.secondary }
    }
}
