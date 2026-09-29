import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: card
    property var approval
    property var answers: ({})
    property int requestId: -1
    property string error: ""
    property string approvalId: approval.id
    onApprovalIdChanged: { answers={};requestId=-1;error="" }
    Connections {
        target:App
        function onStateChanged() {
            if(!App.connected&&card.requestId>=0){card.requestId=-1;card.error="Response was not confirmed. Please try again after reconnecting."}
        }
        function onResult(id,value) { if(id===card.requestId){card.requestId=-1;card.error=value?.error||""} }
    }
    color: "#29291f"; border.color: "#867148"; radius: 9
    implicitHeight: contents.implicitHeight+24
    ColumnLayout {
        id: contents; anchors.fill: parent; anchors.margins: 12; spacing: 8
        Text { text: card.approval.title; textFormat:Text.PlainText; Layout.fillWidth: true; color: Theme.amber; font.bold: true; font.pixelSize: 13; wrapMode: Text.Wrap }
        Image { visible:!!card.approval.image;source:card.approval.image ? "file://"+card.approval.image : "";Layout.fillWidth:true;Layout.preferredHeight:160;fillMode:Image.PreserveAspectFit }
        ScrollView {
            id:details;visible:!!card.approval.detail;Layout.fillWidth:true;Layout.preferredHeight:Math.min(130,detailText.implicitHeight)
            clip:true;contentWidth:availableWidth;ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
            TextArea { id:detailText;text:card.approval.detail||"";readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap;color:Theme.text;font.pixelSize:11;font.family:"monospace";background:null }
        }
        Repeater {
            model: card.approval.questions || []
            ColumnLayout {
                required property var modelData
                Layout.fillWidth: true
                Text { text: modelData.question; textFormat:Text.PlainText; color: Theme.text; wrapMode: Text.Wrap; Layout.fillWidth: true; font.pixelSize: 12 }
                CComboBox {
                    visible: (modelData.options || []).length>0; Layout.fillWidth: true
                    model: (modelData.options || []).map(o=>o.label); currentIndex: -1; displayText: currentIndex<0 ? "Choose an answer…" : currentText
                    onActivated: { const a=Object.assign({},card.answers);a[modelData.id]={answers:[currentText]};card.answers=a }
                }
                CField { placeholderText: "Or type your answer"; Layout.fillWidth: true; onTextEdited: { const a=Object.assign({},card.answers);a[modelData.id]={answers:[text]};card.answers=a } }
            }
        }
        CText { visible:card.error.length>0;text:card.error;color:Theme.danger;font.pixelSize:12 }
        Flow {
            Layout.fillWidth:true;spacing:8
            Repeater {
                model: card.approval.choices
                CButton { required property string modelData;objectName:"approval_"+card.approval.id+"_"+modelData;enabled:App.connected&&card.requestId<0;width:Math.min(implicitWidth,parent.width);text:modelData==="allow"?"Allow once":modelData==="answer"?"Send answer":modelData==="deny"?"Decline":"Cancel turn";primary:modelData==="allow"||modelData==="answer";onClicked:card.requestId=App.rpc("approval.answer",{id:card.approval.id,choice:modelData,answers:card.answers}) }
            }
        }
    }
}
