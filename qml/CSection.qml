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
    implicitHeight: contents.implicitHeight + 32
    color: Theme.surface
    radius: Theme.radiusCard
    border.color: Theme.subtle
    ColumnLayout {
        id: contents
        x: 16; y: 16; width: Math.max(0,parent.width-32); spacing: 12
        RowLayout {
            Layout.fillWidth: true
            CText { text: section.title; font.pixelSize: Theme.section; font.weight: Font.DemiBold }
            Text { visible: section.hint.length>0; text: section.hint; color: Theme.muted; font.family: Theme.font; font.pixelSize: Theme.caption }
        }
        CText { visible: text.length>0; text: section.description; color: Theme.muted; font.pixelSize: Theme.secondary }
    }
}
