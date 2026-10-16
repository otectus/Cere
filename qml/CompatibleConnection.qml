import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M13: one OpenAI-compatible chat endpoint. Its capabilities are the user's declaration: Cere sends only
// what is declared and does not verify it. The key is saved for this endpoint's origin and is never sent
// to another one.
ColumnLayout {
    id:endpoint
    Layout.fillWidth:true;spacing:8
    readonly property var saved:App.state.settings?.compatible||({baseUrl:"",label:"",requiresKey:true,tools:false,images:false,streaming:true,usage:false,contextLength:0,maxOutputTokens:0})
    readonly property var capability:(App.state.capabilities||{}).compatible||({})
    readonly property string origin:(/^(https?:\/\/[^/]+)/.exec(saved.baseUrl||"")||["",""])[1]
    readonly property bool keyElsewhere:!!capability.boundTo&&capability.boundTo!==origin
    property int saveRequest:-1
    property int keyRequest:-1
    property int refreshRequest:-1
    property string error:""
    property string feedback:""
    function load(){baseUrl.text=saved.baseUrl||"";label.text=saved.label||"";requiresKey.checked=saved.requiresKey!==false;tools.checked=saved.tools===true;images.checked=saved.images===true;streaming.checked=saved.streaming!==false;usage.checked=saved.usage===true;contextLength.text=saved.contextLength?String(saved.contextLength):"";maxOutput.text=saved.maxOutputTokens?String(saved.maxOutputTokens):""}
    function number(text){const value=text.trim();return value?Number(value):0}
    Component.onCompleted:load()
    CText {
        objectName:"compatibleStatus";font.weight:Font.DemiBold;Layout.fillWidth:true;wrapMode:Text.Wrap
        color:endpoint.capability.available?Theme.accentText:Theme.amber
        text:(endpoint.saved.label||"Compatible endpoint")+" · "+(!endpoint.saved.baseUrl?"Not set":endpoint.capability.modelsStatus==="loading"?"Connecting…":endpoint.capability.available?"Ready":endpoint.saved.requiresKey&&!endpoint.capability.configured?"Key needed":"Not connected")
    }
    CText { text:"Any server that speaks the OpenAI chat-completions API, such as LM Studio, llama.cpp, vLLM or a hosted gateway. Conversations with it are desktop only and count as cloud for memory and notes, because Cere cannot tell where the endpoint sends text.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CField { id:baseUrl;objectName:"compatibleBaseUrl";Layout.fillWidth:true;placeholderText:"Base URL, such as http://127.0.0.1:1234/v1";maximumLength:2048;Accessible.name:"Compatible endpoint base URL" }
    CField { id:label;objectName:"compatibleLabel";Layout.fillWidth:true;placeholderText:"Name (optional), such as Workstation";maximumLength:60;Accessible.name:"Compatible endpoint name" }
    CText { text:"What this endpoint supports · your declaration; Cere does not verify it";font.weight:Font.DemiBold;Layout.fillWidth:true;wrapMode:Text.Wrap }
    Flow {
        Layout.fillWidth:true;spacing:8
        CCheckBox { id:requiresKey;objectName:"compatibleRequiresKey";text:"Needs a key" }
        CCheckBox { id:tools;objectName:"compatibleTools";text:"Tool calling" }
        CCheckBox { id:images;objectName:"compatibleImages";text:"Image input" }
        CCheckBox { id:streaming;objectName:"compatibleStreaming";text:"Streaming replies" }
        CCheckBox { id:usage;objectName:"compatibleUsage";text:"Reports token usage" }
    }
    GridLayout {
        Layout.fillWidth:true;columns:width>=480?2:1;columnSpacing:8;rowSpacing:8
        CField {
            id:contextLength;objectName:"compatibleContext";Layout.fillWidth:true;placeholderText:"Context window in tokens (not declared: 8,192 assumed)";Accessible.name:"Declared context window"
            validator:IntValidator { bottom:0;top:10000000 }
        }
        CField {
            id:maxOutput;objectName:"compatibleMaxOutput";Layout.fillWidth:true;placeholderText:"Output limit in tokens (optional)";Accessible.name:"Declared output limit"
            validator:IntValidator { bottom:0;top:1000000 }
        }
    }
    CText { text:"Cere sends tools, images, a usage request or an output limit only when declared here. Token counts appear in Context only when the endpoint reports them; Cere never estimates cost. Saving stops replies in progress on this endpoint.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CButton {
        objectName:"compatibleSave";text:endpoint.saveRequest>=0?"Saving…":"Save endpoint";primary:true;Layout.fillWidth:true
        enabled:App.connected&&endpoint.saveRequest<0
        onClicked:{endpoint.error="";endpoint.feedback="";endpoint.saveRequest=App.rpc("settings.update",{compatible:{baseUrl:baseUrl.text.trim(),label:label.text.trim(),requiresKey:requiresKey.checked,tools:tools.checked,images:images.checked,streaming:streaming.checked,usage:usage.checked,contextLength:endpoint.number(contextLength.text),maxOutputTokens:endpoint.number(maxOutput.text)}})}
    }
    CText {
        objectName:"compatibleKeyNote";Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.secondary
        color:endpoint.keyElsewhere?Theme.amber:Theme.muted
        text:endpoint.keyElsewhere?"The saved key belongs to "+endpoint.capability.boundTo+" and is not sent to this endpoint. Enter a key for this endpoint.":!endpoint.saved.baseUrl?"Save the endpoint before adding its key.":endpoint.capability.source==="saved"?"A key is saved for "+endpoint.origin+". Leave the field empty to keep it.":endpoint.saved.requiresKey?"Enter the key for "+endpoint.origin+".":"This endpoint is declared to need no key."
    }
    CField { id:apiKey;objectName:"apiKey_compatible";Layout.fillWidth:true;placeholderText:"Key";echoMode:TextInput.Password;maximumLength:8192;enabled:!!endpoint.saved.baseUrl;Accessible.description:"Compatible endpoint key" }
    GridLayout {
        Layout.fillWidth:true;columns:width>=520?3:1
        CButton { objectName:"compatibleSaveKey";Layout.fillWidth:true;text:"Save key";enabled:App.connected&&!!endpoint.saved.baseUrl&&endpoint.keyRequest<0&&apiKey.text.trim().length>0;onClicked:{endpoint.error="";endpoint.keyRequest=App.rpc("provider.credentials",{provider:"compatible",key:apiKey.text.trim()});apiKey.clear()} }
        CButton { objectName:"compatibleRefresh";Layout.fillWidth:true;text:endpoint.capability.modelsStatus==="loading"?"Connecting…":"Connect / refresh";enabled:App.connected&&!!endpoint.saved.baseUrl&&endpoint.capability.modelsStatus!=="loading";onClicked:{endpoint.error="";endpoint.refreshRequest=App.rpc("provider.models",{provider:"compatible"})} }
        CButton { Layout.fillWidth:true;text:"Remove saved key";visible:endpoint.capability.source==="saved"||endpoint.keyElsewhere;enabled:App.connected&&endpoint.keyRequest<0;onClicked:{endpoint.error="";endpoint.keyRequest=App.rpc("provider.credentials",{provider:"compatible",key:""})} }
    }
    CText { objectName:"compatibleModels";visible:endpoint.capability.modelsStatus==="ready";Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.secondary;text:endpoint.capability.modelsWarning||((endpoint.capability.models||[]).length+" models listed by the endpoint.") }
    CText { objectName:"compatibleError";visible:!!endpoint.error||!!endpoint.capability.modelsError;text:endpoint.error||endpoint.capability.modelsError||"";color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:!!endpoint.feedback;text:endpoint.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Connections {
        target:App
        function onResult(id,value){
            if(id===endpoint.saveRequest){endpoint.saveRequest=-1;if(value?.error)endpoint.error=String(value.error);else{endpoint.load();endpoint.feedback="Saved. Conversations with this endpoint reconnect on their next message."}}
            else if(id===endpoint.keyRequest){endpoint.keyRequest=-1;if(value?.error)endpoint.error=String(value.error);else if(value?.configured)endpoint.refreshRequest=App.rpc("provider.models",{provider:"compatible"})}
            else if(id===endpoint.refreshRequest){endpoint.refreshRequest=-1;if(value?.error)endpoint.error=String(value.error)}
        }
    }
}
