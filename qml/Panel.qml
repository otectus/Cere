import QtQuick
Item {
    property alias expanded:shellContent.expanded
    property alias page:shellContent.page
    property alias pageOffset:shellContent.pageOffset
    readonly property real interfaceScale: App.state.settings?.interfaceScale || 1
    Shell { id:shellContent;expanded: false;width:parent.width/parent.interfaceScale;height:parent.height/parent.interfaceScale;scale:parent.interfaceScale;transformOrigin:Item.TopLeft }
}
