import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M15: export a conversation, or one message, as Markdown or plain text through the system save dialog.
// Only visible messages are exported; attachments appear by name and their contents are never copied.
CDialog {
    id:exporter;objectName:"conversationExport"
    property string sessionId:""
    property var messageIds:[]
    property int request:-1
    property string error:""
    property string feedback:""
    readonly property var session:(App.state.sessions||[]).find(item=>item.id===sessionId)||({})
    function openFor(id,ids){sessionId=id;messageIds=ids||[];error="";feedback="";keepTemporary.checked=false;includeTools.checked=false;open()}
    function run(){
        error="";feedback=""
        const params={id:sessionId,format:format.currentIndex===1?"text":"markdown",includeTools:includeTools.checked,showCitations:App.showMemoryCitations,confirmTemporary:keepTemporary.checked}
        if(messageIds.length)params.messageIds=messageIds
        request=App.rpc("session.export",params)
    }
    CText { text:exporter.messageIds.length===1?"Save this message":"Export this conversation";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:"Only your messages and replies are included, with their source links. Attachments are listed by name; their contents are not copied.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CComboBox { id:format;objectName:"exportFormat";Layout.fillWidth:true;model:["Markdown (.md)","Plain text (.txt)"];Accessible.name:"Export format" }
    CCheckBox { id:includeTools;objectName:"exportIncludeTools";visible:exporter.messageIds.length===0;text:"Include tool activity" }
    CCheckBox { id:keepTemporary;objectName:"exportKeepTemporary";visible:exporter.session.temporary===true;text:"This conversation is temporary. Keep a copy of it anyway." }
    CText { visible:!!exporter.error;text:exporter.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"exportFeedback";visible:!!exporter.feedback;text:exporter.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Close";Layout.fillWidth:true;onClicked:exporter.close() }
        CButton { objectName:"exportSave";text:exporter.request>=0?"Preparing…":"Save as…";primary:true;Layout.fillWidth:true;enabled:App.connected&&exporter.request<0&&(exporter.session.temporary!==true||keepTemporary.checked);onClicked:exporter.run() }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==exporter.request)return
            exporter.request=-1
            if(value?.error){exporter.error=value.error;return}
            const path=App.saveTextAs(value.filename,value.text)
            exporter.feedback=path?"Saved "+value.messages+(value.messages===1?" message":" messages")+" to "+path:"Not saved."
        }
    }
}
