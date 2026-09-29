import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
    id:panel
    property bool expanded:false
    property real maximumHeight:260
    property bool follow:true
    spacing:0
    implicitHeight:36+(expanded?maximumHeight:0)
    CButton {
        objectName:"activityToggle";Layout.fillWidth:true;implicitHeight:36
        text:(panel.expanded?"▾  ":"▸  ")+"Activity Panel"+(App.activityCount?" · "+App.activityCount:"")
        help:panel.expanded?"Hide tool activity":"Show tool activity"
        Accessible.name:"Activity Panel";Accessible.description:help
        onClicked:panel.expanded=!panel.expanded
    }
    Rectangle {
        visible:panel.expanded;Layout.fillWidth:true;Layout.preferredHeight:panel.maximumHeight
        color:Theme.input;border.color:Theme.line;radius:7;clip:true
        ListView {
            id:activity;objectName:"toolActivity";anchors.fill:parent;anchors.margins:8;clip:true
            model:App.activity;spacing:8;cacheBuffer:120;reuseItems:true
            ScrollBar.vertical:CScrollBar{}
            delegate:MessageCard { required property var entry;width:activity.width-12;message:entry;collapsed:false }
            onMovementStarted:panel.follow=false
            onMovementEnded:if(atYEnd)panel.follow=true
            onContentHeightChanged:if(panel.follow)Qt.callLater(()=>activity.positionViewAtEnd())
        }
        CText { anchors.centerIn:parent;width:parent.width-24;visible:!App.activityCount;text:"Tool activity will appear here.";color:Theme.muted;horizontalAlignment:Text.AlignHCenter }
        CButton { visible:!panel.follow&&App.activityCount>0;anchors.bottom:parent.bottom;anchors.horizontalCenter:parent.horizontalCenter;text:"↓ Latest activity";onClicked:{panel.follow=true;activity.positionViewAtEnd()} }
    }
    onExpandedChanged:if(expanded&&follow)Qt.callLater(()=>activity.positionViewAtEnd())
    onSessionIdChanged:follow=true
    property string sessionId:App.selectedId
}
