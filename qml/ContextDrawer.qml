import QtQuick
import QtQuick.Layouts
import "ContextExplain.js" as ContextExplain
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
    CText { text:"Conversation context";font.pixelSize:Theme.title;font.bold:true }
    CText { text:drawer.error;color:Theme.danger;visible:!!drawer.error }
    CText { text:(drawer.context.destination?.provider||"")+" · "+(drawer.context.destination?.model||"")+"\n"+(drawer.context.destination?.cwd||"");color:Theme.accentText }
    CText { text:drawer.context.destination?.host||"";visible:!!text;color:Theme.muted }
    CText { text:"Cere will attach "+drawer.attachmentIds.length+" selected files and your message." }
    Repeater { model:drawer.context.attachments||[];CText { required property var modelData;text:modelData.name+" · "+Math.ceil(modelData.size/1024)+" KiB";font.pixelSize:Theme.secondary } }
    CText { text:"Your next message";font.weight:Font.DemiBold }
    CText { text:"Approximately "+(drawer.context.estimatedTokens||0)+" text tokens";color:Theme.accentText }
    CText { text:drawer.context.estimateLabel||"";font.pixelSize:Theme.secondary;color:Theme.muted }
    CText { text:drawer.context.nativeContext||"";font.pixelSize:Theme.secondary;color:Theme.amber }
    // The plan of the last request actually sent, recorded when it was sent; nothing is recomputed here.
    CText { text:"Last request sent";font.weight:Font.DemiBold;visible:!!drawer.context.lastPlan }
    CText { objectName:"planSummary";text:ContextExplain.planSummary(drawer.context.lastPlan);visible:!!drawer.context.lastPlan;color:Theme.accentText }
    CText { objectName:"planReported";text:ContextExplain.reportedUsage(drawer.context.lastPlan);visible:!!text;font.pixelSize:Theme.secondary;color:Theme.muted;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Repeater {
        model:ContextExplain.planRows(drawer.context.lastPlan)
        RowLayout {
            required property var modelData
            Layout.fillWidth:true;spacing:8
            CText { objectName:"planLayer_"+modelData.id;Layout.preferredWidth:200;text:modelData.label;font.pixelSize:Theme.secondary;color:modelData.included?Theme.text:Theme.muted;elide:Text.ElideRight }
            CText { Layout.preferredWidth:110;text:modelData.size;font.pixelSize:Theme.secondary;color:Theme.muted }
            CText { Layout.fillWidth:true;text:modelData.status;font.pixelSize:Theme.caption;color:Theme.muted;wrapMode:Text.Wrap }
        }
    }
    CText { objectName:"planUnknown";visible:(drawer.context.lastPlan?.unknown||[]).length>0;text:"Not visible to Cere: "+(drawer.context.lastPlan?.unknown||[]).join("; ")+".";font.pixelSize:Theme.secondary;color:Theme.amber;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:!!drawer.context.lastPlan;text:"Sizes are estimates (UTF-8 bytes ÷ 2); the provider counts its own tokens. Supplied context is not proof the model used it.";font.pixelSize:Theme.caption;color:Theme.muted }
    // What automatic recall did for the last turn, as recorded then; opening this runs no recall.
    readonly property var recallText:ContextExplain.describe(drawer.context.recallOutcome||null)
    CText { text:"Memory for the last turn";font.weight:Font.DemiBold;visible:drawer.context.destination!==undefined }
    CText { objectName:"recallOutcomeTitle";text:drawer.recallText.title;visible:drawer.context.destination!==undefined }
    CText { objectName:"recallOutcomeDetail";text:drawer.recallText.detail;visible:!!text;font.pixelSize:Theme.secondary;color:Theme.muted }
    CText { objectName:"recallOutcomeTime";text:drawer.recallText.when;visible:!!text;font.pixelSize:Theme.caption;color:Theme.muted }
    CText { text:drawer.context.memoryLabel||"";font.pixelSize:Theme.secondary;color:Theme.muted }
    // Recent web searches in this conversation, as they happened; nothing is fetched again here.
    CText { text:"Web searches in this conversation";font.weight:Font.DemiBold;visible:(drawer.context.webSearches||[]).length>0 }
    Repeater {
        model:(drawer.context.webSearches||[]).slice(0,5)
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true;spacing:2
            CText { objectName:"webSearchTrace";Layout.fillWidth:true;text:ContextExplain.searchLine(modelData);font.pixelSize:Theme.secondary;color:modelData.outcome==="ok"?Theme.text:Theme.amber;elide:Text.ElideRight }
            CText { objectName:"webSearchDetail";Layout.fillWidth:true;text:ContextExplain.searchDetail(modelData);visible:!!text;font.pixelSize:Theme.caption;color:Theme.muted;wrapMode:Text.Wrap }
        }
    }
    Repeater { model:(drawer.context.memories||[]).slice(0,12);CText { required property var modelData;text:modelData.quote||modelData.text||JSON.stringify(modelData);font.pixelSize:Theme.secondary } }
    CText { text:drawer.recalled.reason||"";color:Theme.muted;font.pixelSize:Theme.secondary }
    Repeater { model:drawer.recalled.rows||[];CButton { required property var modelData;text:"Why was this recalled? · "+modelData.id.slice(0,10);onClicked:{inspector.sessionId=drawer.sessionId;inspector.open();inspector.openRecord(modelData.id)} } }
    GraphMemoryInspector { id:inspector }
    CButton { objectName:"closeContextDrawer";text:"Close";Layout.fillWidth:true;onClicked:drawer.close() }
    Connections { target:App;function onResult(id,value){if(id===drawer.recallRequest){drawer.recallRequest=-1;if(!value?.error)drawer.recalled=value;return}if(id!==drawer.request)return;drawer.request=-1;if(value?.error)drawer.error=String(value.error.message||value.error);else drawer.context=value} }
}
