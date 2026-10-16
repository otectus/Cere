import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:health
    property var report:({})
    property var preview:({})
    property int request:-1
    property string operation:""
    property string feedback:""
    function call(method,params){operation=method;request=App.rpc(method,params||{});feedback=""}
    onOpened:call("health.inspect")
    CText { text:"Health and recovery";font.pixelSize:Theme.title;font.bold:true }
    CText { text:"Repairs run only when you select them. A provider executable being available does not establish that its account is signed in.";font.pixelSize:Theme.secondary;color:Theme.muted }
    Repeater {
        model:health.report.providers||[]
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { text:modelData.id+" · "+(modelData.problem||modelData.modelsStatus);color:modelData.problem?Theme.amber:Theme.text }
            CText { text:"Account: "+modelData.authentication;font.pixelSize:Theme.caption;color:Theme.muted }
            CButton { text:"Refresh "+modelData.id;enabled:health.request<0;onClicked:health.call("provider.models",{provider:modelData.id}) }
        }
    }
    CText { text:"Memory: "+(health.report.memory?.state||"unknown")+" · "+(health.report.memory?.coverage||"") }
    CText { objectName:"healthMemoryError";visible:!!health.report.memory?.error;text:health.report.memory?.error||"";color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText {
        objectName:"healthMigrationBackup";visible:(health.report.memory?.backups||[]).length>0;color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true
        readonly property var newest:(health.report.memory?.backups||[])[0]||({})
        text:"Pre-migration backup from "+new Date((newest.created_us||0)/1000).toLocaleDateString()+(newest.from?" (memory schema "+newest.from+" to "+newest.to+")":"")+". It is deleted after 14 days, or when memory is cleared."
    }
    CButton { text:"Check memory connection";enabled:health.request<0;onClicked:health.call("memory.check") }
    CText { text:"Speech: "+(health.report.speech?.state||"unknown") }
        RowLayout { Layout.fillWidth:true;CButton {text:"Test voice";onClicked:health.call("tts.test")} CButton{text:"Stop voice";onClicked:health.call("tts.stop")} }
    // M16: durations only, measured while switched on; the summary is part of the reviewed export below.
    CText { text:"Responsiveness";font.weight:Font.DemiBold }
    CCheckBox { objectName:"measureResponsiveness";text:"Measure how long replies, recall, tools, speech and Stop take";checked:App.state.settings?.responsiveness===true;onClicked:{App.rpc("settings.update",{responsiveness:checked});if(checked)spansTimer.restart()} }
    readonly property var spans:health.report.responsiveness||({enabled:false})
    readonly property var spanNames:({turn:"Whole reply","first-token":"First reply text",memory:"Memory recall",tool:"Tool calls",synthesis:"First speech audio",cancel:"Stop"})
    Repeater {
        model:health.spans.enabled?Object.keys(health.spanNames):[]
        CText {
            required property string modelData
            readonly property var row:health.spans.spans[modelData]||({count:0})
            objectName:"span_"+modelData;Layout.fillWidth:true;font.pixelSize:Theme.secondary;color:row.count?Theme.text:Theme.muted
            text:health.spanNames[modelData]+" · "+(row.count?row.count+" measured · median "+Math.round(row.p50)+" ms · 90% under "+Math.round(row.p90)+" ms · slowest "+Math.round(row.max)+" ms"+(row.failed?" · "+row.failed+" failed":"")+(row.stopped?" · "+row.stopped+" stopped":""):"not measured yet")
        }
    }
    CText { visible:health.spans.enabled===true;Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.caption;color:Theme.muted
        text:"Broker delay: median "+(health.spans.brokerLag?.p50||0)+" ms, slowest "+(health.spans.brokerLag?.max||0)+" ms."+(health.spans.uiLag?" Window delay: median "+health.spans.uiLag.p50+" ms, slowest "+health.spans.uiLag.max+" ms.":" Window delay appears after half a minute.")+" No conversation text, paths, arguments or audio are recorded." }
    RowLayout {
        visible:health.spans.enabled===true;Layout.fillWidth:true
        CButton { text:"Refresh";enabled:health.request<0;onClicked:health.call("health.inspect") }
        CButton { text:"Clear measurements";enabled:health.request<0;onClicked:health.call("diagnostics.clearSpans") }
    }
    Timer { id:spansTimer;interval:1500;onTriggered:health.call("health.inspect") }
    CButton { text:"Preview redacted diagnostics";Layout.fillWidth:true;enabled:health.request<0;onClicked:health.call("diagnostics.preview") }
    CTextArea { visible:!!health.preview.text;text:health.preview.text||"";readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap;color:Theme.text;Layout.fillWidth:true;Layout.preferredHeight:200 }
    CButton { visible:!!health.preview.id;text:"Save this reviewed export";Layout.fillWidth:true;enabled:health.request<0;onClicked:health.call("diagnostics.export",{id:health.preview.id,digest:health.preview.digest}) }
    CText { visible:!!health.feedback;text:health.feedback;color:Theme.amber;font.pixelSize:Theme.secondary }
    CButton { text:"Close";Layout.fillWidth:true;onClicked:health.close() }
    Connections { target:App;function onResult(id,value){if(id!==health.request)return;health.request=-1;if(value?.error){health.feedback=String(value.error.message||value.error);return}if(health.operation==="health.inspect")health.report=value;else if(health.operation==="diagnostics.preview")health.preview=value;else if(health.operation==="diagnostics.export"){health.feedback="Saved to "+value.path;health.preview={}}else health.call("health.inspect")} }
}
