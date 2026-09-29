import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Item {
    id:bubble;objectName:"approvalBubble"
    property bool tailOnRight:true
    property real tailY:80
    property var approvals:App.state.approvals||[]
    implicitWidth:392
    implicitHeight:Math.min(460,body.implicitHeight+32)
    Rectangle {
        width:16;height:16;rotation:45;y:bubble.tailY-8
        x:bubble.tailOnRight?parent.width-20:4
        color:Theme.surface;border.color:"#867148"
    }
    Rectangle {
        anchors.fill:parent;anchors.leftMargin:10;anchors.rightMargin:10
        color:Theme.surface;border.color:"#867148";radius:12
        ScrollView {
            id:viewport;anchors.fill:parent;anchors.margins:12;clip:true
            contentWidth:availableWidth;contentHeight:body.implicitHeight
            ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
            ColumnLayout {
                id:body;width:viewport.availableWidth;spacing:10
                CText { text:"Permission needed"+(bubble.approvals.length>1?" · "+bubble.approvals.length:"");font.pixelSize:15;font.bold:true;color:Theme.amber }
                Repeater {
                    model:bubble.approvals
                    ColumnLayout {
                        required property var modelData
                        property var session:(App.state.sessions||[]).find(s=>s.id===modelData.sessionId)||({})
                        Layout.fillWidth:true;spacing:5
                        CText { text:session.title?(session.provider.toUpperCase()+" · "+session.title):"Cere desktop";color:Theme.muted;font.pixelSize:11 }
                        ApprovalCard { Layout.fillWidth:true;approval:modelData }
                    }
                }
                CText { visible:!App.connected;text:"Reconnecting…";color:Theme.muted;font.pixelSize:11 }
            }
        }
    }
}
