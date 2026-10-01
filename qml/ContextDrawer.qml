import QtQuick
import QtQuick.Layouts
CDialog {
    id:drawer
    property string sessionId:""
    property string draftText:""
    property var attachmentIds:[]
    property var context:({})
    property string error:""
    property int request:-1
    property int recallRequest:-1
    property var recalled:({rows:[]})
    onOpened:{recallRequest=App.rpc("memoryReview.recalled",{sessionId:sessionId});error="";context={};request=App.rpc("session.context",{id:sessionId,text:draftText,attachmentIds:attachmentIds})}
    CText { text:"Conversation context";font.pixelSize:20;font.bold:true }
    CText { text:drawer.error;color:Theme.danger;visible:!!drawer.error }
    CText { text:(drawer.context.destination?.provider||"")+" · "+(drawer.context.destination?.model||"")+"\n"+(drawer.context.destination?.cwd||"");color:Theme.cyan }
    CText { text:drawer.context.destination?.host||"";visible:!!text;color:Theme.muted }
    CText { text:"Cere will attach "+drawer.attachmentIds.length+" selected files and your message." }
    Repeater { model:drawer.context.attachments||[];CText { required property var modelData;text:modelData.name+" · "+Math.ceil(modelData.size/1024)+" KiB";font.pixelSize:12 } }
    CText { text:"Approximately "+(drawer.context.estimatedTokens||0)+" text tokens";color:Theme.cyan }
    CText { text:drawer.context.estimateLabel||"";font.pixelSize:12;color:Theme.muted }
    CText { text:drawer.context.nativeContext||"";font.pixelSize:12;color:Theme.amber }
    CText { text:drawer.context.memoryLabel||"";font.pixelSize:12;color:Theme.muted }
    Repeater { model:(drawer.context.memories||[]).slice(0,12);CText { required property var modelData;text:modelData.quote||modelData.text||JSON.stringify(modelData);font.pixelSize:12 } }
    CText { text:drawer.recalled.reason||"";color:Theme.muted;font.pixelSize:12 }
    Repeater { model:drawer.recalled.rows||[];CButton { required property var modelData;text:"Why was this recalled? · "+modelData.id.slice(0,10);onClicked:{inspector.sessionId=drawer.sessionId;inspector.open();inspector.openRecord(modelData.id)} } }
    GraphMemoryInspector { id:inspector }
    CButton { objectName:"closeContextDrawer";text:"Close";Layout.fillWidth:true;onClicked:drawer.close() }
    Connections { target:App;function onResult(id,value){if(id===drawer.recallRequest){drawer.recallRequest=-1;if(!value?.error)drawer.recalled=value;return}if(id!==drawer.request)return;drawer.request=-1;if(value?.error)drawer.error=String(value.error.message||value.error);else drawer.context=value} }
}
