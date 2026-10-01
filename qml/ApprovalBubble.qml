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
    property var replies:[]
    property var currentReply:null
    property bool followLatest:true
    // Set by this process's controller the moment a panel shows or hides, ahead of the broker's echo.
    property bool panelOpen:false
    onPanelOpenChanged:syncApprovals()
    readonly property int replyIndex:currentReply?replies.findIndex(reply=>reply.id===currentReply.id):-1
    readonly property bool needsInput:approvals.length>0
    readonly property color accent:needsInput?Theme.amber:currentReply?Theme.cyan:Theme.success
    function resetScroll() { Qt.callLater(function(){if(viewport.contentItem)viewport.contentItem.contentY=0}) }
    onCurrentCompletionChanged:if(!currentReply&&!needsInput)resetScroll()
    onCurrentReplyChanged:if(!needsInput)resetScroll()
    onNeedsInputChanged:{resetScroll();if(!needsInput&&followLatest&&!reading.hovered)syncApprovals()}
    function selectReply(index) {
        if(index<0||index>=replies.length)return
        followLatest=index===replies.length-1
        currentReply=replies[index]
    }
    HoverHandler {
        id:reading
        onHoveredChanged:if(!hovered&&bubble.followLatest)bubble.syncApprovals()
    }
    function syncApprovals() {
        const next=panelOpen?[]:(App.state.approvals||[])
        if(JSON.stringify(next)!==JSON.stringify(approvals))approvals=next
        const finished=(App.state.completions||[]).filter(completion=>!completion.companion)
        if(JSON.stringify(finished)!==JSON.stringify(completions))completions=finished
        const first=finished.length?finished[0]:null
        if(JSON.stringify(first)!==JSON.stringify(currentCompletion))currentCompletion=first
        const incoming=App.state.companionReplies||[]
        if(JSON.stringify(incoming)!==JSON.stringify(replies))replies=incoming
        const existing=currentReply?replies.find(reply=>reply.id===currentReply.id):null
        const speaking=replies.find(reply=>reply.id===App.state.speech?.replyId)
        const selected=existing&&(!followLatest||reading.hovered||needsInput)?existing:speaking||replies[replies.length-1]||null
        if(JSON.stringify(selected)!==JSON.stringify(currentReply))currentReply=selected
        if(!existing)followLatest=true
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
        color:Theme.surface;border.color:bubble.accent;radius:Theme.radiusCard
        ScrollView {
            id:viewport;anchors.fill:parent;anchors.margins:12;clip:true
            contentWidth:availableWidth;contentHeight:body.implicitHeight
            ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
            ColumnLayout {
                id:body;width:viewport.availableWidth;spacing:10
                CText {
                    objectName:"bubbleHeading"
                    text:bubble.needsInput?"Input needed"+(bubble.approvals.length>1?" · "+bubble.approvals.length:"")
                        :bubble.currentReply?"Cere · pinned conversation"
                        :"Run complete"+(bubble.completions.length>1?" · "+bubble.completions.length+" unread":"")
                    font.pixelSize:Theme.section;font.bold:true;color:bubble.accent
                }
                Repeater {
                    model:bubble.approvals
                    // The card itself identifies its requester on every surface.
                    ApprovalCard { required property var modelData;Layout.fillWidth:true;approval:modelData }
                }
                RowLayout {
                    visible:!bubble.needsInput&&bubble.replies.length>1
                    Layout.fillWidth:true
                    CButton { objectName:"companionPrevious";text:"Previous";enabled:bubble.replyIndex>0;onClicked:bubble.selectReply(bubble.replyIndex-1) }
                    CText { Layout.fillWidth:true;text:(bubble.replyIndex+1)+" / "+bubble.replies.length;color:Theme.muted;font.pixelSize:Theme.caption;horizontalAlignment:Text.AlignHCenter }
                    CButton { objectName:"companionNext";text:"Next";enabled:bubble.replyIndex<bubble.replies.length-1;onClicked:bubble.selectReply(bubble.replyIndex+1) }
                }
                Loader {
                    Layout.fillWidth:true
                    active:!bubble.needsInput&&bubble.currentReply!==null
                    visible:active
                    sourceComponent:CompanionCard { reply:bubble.currentReply||({}) }
                }
                // Requests take precedence; pinned replies share the same
                // anchored surface without duplicating their completion card.
                Loader {
                    Layout.fillWidth:true
                    active:!bubble.needsInput&&!bubble.currentReply&&bubble.currentCompletion!==null
                    visible:active
                    sourceComponent:CompletionCard { completion:bubble.currentCompletion||({}) }
                }
                CText { visible:!App.connected;text:"Reconnecting…";color:Theme.muted;font.pixelSize:Theme.caption }
            }
        }
    }
}
