import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CDialog {
    id:health
    accessibleTitle:"Health and recovery"
    objectName:"healthDialog"
    property var report:({})
    property var preview:({})
    property int request:-1
    property string operation:""
    property string feedback:""
    readonly property bool compactForm:width<440
    function call(method,params){if(request>=0)return;operation=method;request=App.rpc(method,params||{});feedback=""}
    onOpened:call("health.inspect")

    CText { text:health.accessibleTitle;font.pixelSize:Theme.title;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading }
    CText {
        text:"Inspect connections, optional services and responsiveness. Nothing is repaired or exported until you choose it."
        font.pixelSize:Theme.secondary;color:Theme.muted;wrapMode:Text.Wrap
    }
    CText {
        objectName:"healthPreviousShutdown";visible:health.report.previousShutdown?.confirmed===false;color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true
        text:"The last time Cere stopped, it could not confirm that everything it was running had finished: "+(health.report.previousShutdown?.problems||[]).join(" ")
    }
    CText {
        objectName:"healthMissingDependencies";visible:(health.report.dependencies||[]).some(d=>!d.available);color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true
        text:"Unavailable until installed: "+(health.report.dependencies||[]).filter(d=>!d.available).map(d=>d.name+" ("+d.feature.toLowerCase()+")").join(", ")+". Chat is not affected."
    }

    CSection {
        title:"Model providers"
        description:"Ready means the executable or endpoint responded. It does not confirm that a CLI account is signed in."
        GridLayout {
            Layout.fillWidth:true;columns:health.compactForm?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space2
            Repeater {
                model:health.report.providers||[]
                Rectangle {
                    id:providerTile
                    required property var modelData
                    Layout.fillWidth:true;implicitHeight:providerCard.implicitHeight+Theme.space4
                    color:Theme.raised;border.color:Theme.subtle;radius:Theme.radiusControl
                    ColumnLayout {
                        id:providerCard;x:Theme.space2;y:Theme.space2;width:parent.width-Theme.space4;spacing:Theme.space1
                        CText { Layout.fillWidth:true;text:providerTile.modelData.id+" · "+(providerTile.modelData.problem||providerTile.modelData.modelsStatus);color:providerTile.modelData.problem?Theme.amber:Theme.text;font.weight:Font.DemiBold;wrapMode:Text.Wrap }
                        CText { Layout.fillWidth:true;text:"Account: "+providerTile.modelData.authentication;font.pixelSize:Theme.caption;color:Theme.muted;wrapMode:Text.Wrap }
                        CButton { Layout.fillWidth:true;text:"Refresh "+providerTile.modelData.id;enabled:health.request<0;onClicked:health.call("provider.models",{provider:providerTile.modelData.id}) }
                    }
                }
            }
        }
    }

    CSection {
        title:"Local services"
        description:"Check memory storage and voice playback independently."
        CText { text:"Memory · "+(health.report.memory?.state||"unknown")+" · "+(health.report.memory?.coverage||"");font.weight:Font.DemiBold }
        CText { objectName:"healthMemoryError";visible:!!health.report.memory?.error;text:health.report.memory?.error||"";color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText {
            objectName:"healthMigrationBackup";visible:(health.report.memory?.backups||[]).length>0;color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true
            readonly property var newest:(health.report.memory?.backups||[])[0]||({})
            text:"Pre-migration backup from "+new Date((newest.created_us||0)/1000).toLocaleDateString()+(newest.from?" (memory schema "+newest.from+" to "+newest.to+")":"")+". It is deleted after 14 days, or when memory is cleared."
        }
        CButton { objectName:"checkMemoryConnection";Layout.fillWidth:true;text:"Check memory connection";enabled:health.request<0;onClicked:health.call("memory.check") }
        Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
        CText { text:"Speech · "+(health.report.speech?.state||"unknown");font.weight:Font.DemiBold }
        GridLayout {
            Layout.fillWidth:true;columns:health.compactForm?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space2
            CButton { Layout.fillWidth:true;text:"Test voice";enabled:health.request<0;onClicked:health.call("tts.test") }
            CButton { Layout.fillWidth:true;text:"Stop voice";enabled:health.request<0;onClicked:health.call("tts.stop") }
        }
    }

    CSection {
        id:responsivenessSection
        title:"Responsiveness"
        description:"Measure durations only—never conversation text, paths, arguments or audio."
        CCheckBox { objectName:"measureResponsiveness";text:"Measure replies, recall, tools, speech and Stop";checked:App.state.settings?.responsiveness===true;onClicked:{App.rpc("settings.update",{responsiveness:checked});if(checked)spansTimer.restart()} }
        readonly property var spans:health.report.responsiveness||({enabled:false})
        readonly property var spanNames:({turn:"Whole reply","first-token":"First reply text",memory:"Memory recall",tool:"Tool calls",synthesis:"First speech audio",cancel:"Stop"})
        Repeater {
            model:responsivenessSection.spans.enabled?Object.keys(responsivenessSection.spanNames):[]
            CText {
                required property string modelData
                readonly property var row:responsivenessSection.spans.spans[modelData]||({count:0})
                objectName:"span_"+modelData;Layout.fillWidth:true;font.pixelSize:Theme.secondary;color:row.count?Theme.text:Theme.muted;wrapMode:Text.Wrap
                text:responsivenessSection.spanNames[modelData]+" · "+(row.count?row.count+" measured · median "+Math.round(row.p50)+" ms · 90% under "+Math.round(row.p90)+" ms · slowest "+Math.round(row.max)+" ms"+(row.failed?" · "+row.failed+" failed":"")+(row.stopped?" · "+row.stopped+" stopped":""):"not measured yet")
            }
        }
        CText {
            visible:responsivenessSection.spans.enabled===true;Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.caption;color:Theme.muted
            text:"Broker delay: median "+(responsivenessSection.spans.brokerLag?.p50||0)+" ms, slowest "+(responsivenessSection.spans.brokerLag?.max||0)+" ms."+(responsivenessSection.spans.uiLag?" Window delay: median "+responsivenessSection.spans.uiLag.p50+" ms, slowest "+responsivenessSection.spans.uiLag.max+" ms.":" Window delay appears after half a minute.")
        }
        GridLayout {
            visible:responsivenessSection.spans.enabled===true;Layout.fillWidth:true;columns:health.compactForm?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space2
            CButton { Layout.fillWidth:true;text:"Refresh measurements";enabled:health.request<0;onClicked:health.call("health.inspect") }
            CButton { Layout.fillWidth:true;text:"Clear measurements";enabled:health.request<0;onClicked:health.call("diagnostics.clearSpans") }
        }
    }
    Timer { id:spansTimer;interval:1500;onTriggered:health.call("health.inspect") }

    CSection {
        title:"Diagnostics export"
        description:"Preview the redacted report first. Saving exports only that reviewed version."
        CButton { objectName:"previewDiagnostics";text:"Preview redacted diagnostics";Layout.fillWidth:true;enabled:health.request<0;onClicked:health.call("diagnostics.preview") }
        CTextArea { objectName:"diagnosticsPreview";visible:!!health.preview.text;text:health.preview.text||"";readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap;color:Theme.text;Layout.fillWidth:true;Layout.preferredHeight:200 }
        CButton { objectName:"saveDiagnostics";visible:!!health.preview.id;text:"Save this reviewed export";primary:true;prominent:true;Layout.fillWidth:true;enabled:health.request<0;onClicked:health.call("diagnostics.export",{id:health.preview.id,digest:health.preview.digest}) }
    }

    CText { visible:!!health.feedback;text:health.feedback;color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    footerContent:Component { CButton { Layout.fillWidth:true;text:"Close";onClicked:health.close() } }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==health.request)return
            health.request=-1
            if(value?.error){health.feedback=String(value.error.message||value.error);return}
            if(health.operation==="health.inspect")health.report=value
            else if(health.operation==="diagnostics.preview")health.preview=value
            else if(health.operation==="diagnostics.export"){health.feedback="Saved to "+value.path;health.preview={}}
            else health.call("health.inspect")
        }
    }
}
