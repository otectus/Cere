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
    radius: 12
    border.color: Theme.line
    ColumnLayout {
        id: contents
        x: 16; y: 16; width: Math.max(0,parent.width-32); spacing: 12
        RowLayout {
            Layout.fillWidth: true
            CText { text: section.title; font.pixelSize: 15; font.weight: Font.DemiBold }
            Text { visible: section.hint.length>0; text: section.hint; color: Theme.muted; font.family: Theme.font; font.pixelSize: 11 }
        }
        CText { visible: text.length>0; text: section.description; color: Theme.muted; font.pixelSize: 12 }
    }
}
