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
    CText { text:"Health and recovery";font.pixelSize:20;font.bold:true }
    CText { text:"Repairs run only when you select them. A provider executable being available does not establish that its account is signed in.";font.pixelSize:12;color:Theme.muted }
    Repeater {
        model:health.report.providers||[]
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { text:modelData.id+" · "+(modelData.problem||modelData.modelsStatus);color:modelData.problem?Theme.amber:Theme.text }
            CText { text:"Account: "+modelData.authentication;font.pixelSize:11;color:Theme.muted }
            CButton { text:"Refresh "+modelData.id;enabled:health.request<0;onClicked:health.call("provider.models",{provider:modelData.id}) }
        }
    }
    CText { text:"Memory: "+(health.report.memory?.state||"unknown")+" · "+(health.report.memory?.coverage||"") }
    CButton { text:"Check memory connection";enabled:health.request<0;onClicked:health.call("memory.check") }
    CText { text:"Speech: "+(health.report.speech?.state||"unknown") }
        RowLayout { Layout.fillWidth:true;CButton {text:"Test voice";onClicked:health.call("tts.test")} CButton{text:"Stop voice";onClicked:health.call("tts.stop")} }
    CButton { text:"Preview redacted diagnostics";Layout.fillWidth:true;enabled:health.request<0;onClicked:health.call("diagnostics.preview") }
    TextArea { visible:!!health.preview.text;text:health.preview.text||"";readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap;color:Theme.text;Layout.fillWidth:true;Layout.preferredHeight:200;background:Rectangle{color:Theme.input} }
    CButton { visible:!!health.preview.id;text:"Save this reviewed export";Layout.fillWidth:true;enabled:health.request<0;onClicked:health.call("diagnostics.export",{id:health.preview.id,digest:health.preview.digest}) }
    CText { visible:!!health.feedback;text:health.feedback;color:Theme.amber;font.pixelSize:12 }
    CButton { text:"Close";Layout.fillWidth:true;onClicked:health.close() }
    Connections { target:App;function onResult(id,value){if(id!==health.request)return;health.request=-1;if(value?.error){health.feedback=String(value.error.message||value.error);return}if(health.operation==="health.inspect")health.report=value;else if(health.operation==="diagnostics.preview")health.preview=value;else if(health.operation==="diagnostics.export"){health.feedback="Saved to "+value.path;health.preview={}}else health.call("health.inspect")} }
}
