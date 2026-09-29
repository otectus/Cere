import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CButton {
    id: control
    property string detail
    property string mark: text.slice(0,1).toUpperCase()
    property bool selected: false
    implicitHeight: detail.length ? 66 : 48
    implicitWidth: 180
    help: detail.length ? text+"\n"+detail : text
    contentItem: RowLayout {
        spacing: 12
        Rectangle {
            Layout.preferredWidth: 32; Layout.preferredHeight: 32; radius: 9
            color: Theme.selected
            Text { anchors.centerIn: parent; text: control.mark; color: Theme.cyan; font.family: Theme.font; font.pixelSize: 14 }
        }
        ColumnLayout {
            Layout.fillWidth: true; Layout.minimumWidth: 0; spacing: 4
            Text { Layout.fillWidth: true; Layout.minimumWidth: 0; text: control.text; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold; elide: Text.ElideRight; textFormat: Text.PlainText }
            Text { visible: control.detail.length>0; Layout.fillWidth: true; Layout.minimumWidth: 0; text: control.detail; color: Theme.muted; font.family: Theme.font; font.pixelSize: 11; elide: Text.ElideMiddle; textFormat: Text.PlainText }
        }
        Text { text: "›"; color: Theme.muted; font.pixelSize: 20 }
    }
}
