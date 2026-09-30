import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Item {
    id:bubble;objectName:"approvalBubble"
    property bool tailOnRight:true
    property real tailY:80
    property var approvals:[]
    property var completions:[]
    property var currentCompletion:null
    readonly property bool needsInput:approvals.length>0
    readonly property color accent:needsInput?Theme.amber:Theme.success
    function resetScroll() { Qt.callLater(function(){if(viewport.contentItem)viewport.contentItem.contentY=0}) }
    onCurrentCompletionChanged:resetScroll()
    onNeedsInputChanged:resetScroll()
    function syncApprovals() {
        const next=App.state.approvals||[]
        if(JSON.stringify(next)!==JSON.stringify(approvals))approvals=next
        const finished=App.state.completions||[]
        if(JSON.stringify(finished)!==JSON.stringify(completions))completions=finished
        const first=finished.length?finished[0]:null
        if(JSON.stringify(first)!==JSON.stringify(currentCompletion))currentCompletion=first
    }
    Component.onCompleted: syncApprovals()
    Connections { target:App; function onStateChanged(){bubble.syncApprovals()} }
    implicitWidth:392
    implicitHeight:Math.min(460,body.implicitHeight+32)
    Rectangle {
        width:16;height:16;rotation:45;y:bubble.tailY-8
        x:bubble.tailOnRight?parent.width-20:4
        color:Theme.surface;border.color:bubble.accent
    }
    Rectangle {
        anchors.fill:parent;anchors.leftMargin:10;anchors.rightMargin:10
        color:Theme.surface;border.color:bubble.accent;radius:12
        ScrollView {
            id:viewport;anchors.fill:parent;anchors.margins:12;clip:true
            contentWidth:availableWidth;contentHeight:body.implicitHeight
            ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
            ColumnLayout {
                id:body;width:viewport.availableWidth;spacing:10
                CText {
                    objectName:"bubbleHeading"
                    text:bubble.needsInput?"Input needed"+(bubble.approvals.length>1?" · "+bubble.approvals.length:"")
                        :"Run complete"+(bubble.completions.length>1?" · "+bubble.completions.length+" unread":"")
                    font.pixelSize:15;font.bold:true;color:bubble.accent
                }
                Repeater {
                    model:bubble.approvals
                    // The card itself identifies its requester on every surface.
                    ApprovalCard { required property var modelData;Layout.fillWidth:true;approval:modelData }
                }
                // Input always takes precedence. Completed runs wait in order.
                Loader {
                    Layout.fillWidth:true
                    active:!bubble.needsInput&&bubble.currentCompletion!==null
                    visible:active
                    sourceComponent:CompletionCard { completion:bubble.currentCompletion||({}) }
                }
                CText { visible:!App.connected;text:"Reconnecting…";color:Theme.muted;font.pixelSize:11 }
            }
        }
    }
}
