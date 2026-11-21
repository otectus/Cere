import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:dialog
    accessibleTitle:"Conversation model"
    objectName:"sessionModelDialog"
    property string sessionId:""
    property var original:({})
    property var models:[]
    property bool isOllama:original.provider==="ollama"
    readonly property var providerTrait:(App.state.providerTraits||{})[original.provider]||({})
    property bool isApi:providerTrait.kind?providerTrait.kind==="api":["openai","anthropic","google","compatible"].includes(original.provider)
    property bool isNative:!isOllama&&!isApi
    property var labels:({codex:"Codex",claude:"Claude Code",ollama:"Ollama",antigravity:"AntiGravity",openai:"OpenAI API",anthropic:"Claude API",google:"Google AI API",compatible:App.state.settings?.compatible?.label||"Compatible endpoint"})
    property var defaultEfforts:(models.find(m=>m.isDefault)||{}).efforts||(!original.model&&original.effort?[{id:original.effort,displayName:original.effort}]:[])
    property var options:(isNative?[{id:"",displayName:"Provider default",efforts:defaultEfforts}]:[]).concat(models)
    property var selected:options[picker.currentIndex]||({})
    property string modelId:isApi&&custom.text.trim()?custom.text.trim():picker.currentValue||""
    property var efforts:[{id:"",displayName:"Provider default"}].concat(selected.efforts||[])
    property int loadRequest:-1
    property int connectionsRequest:-1
    property int saveRequest:-1
    property int optionsRequest:-1
    property string error:""
    property string loadError:""
    property var connections:[]
    readonly property var connection:original.connectionId?connections.find(row=>row.id===original.connectionId)||({}):({})
    readonly property var compatibleEndpoint:original.provider==="compatible"?(original.connectionId?(connection.endpoint||({})):(App.state.settings?.compatible||({}))):({})
    readonly property bool toolsSupported:isNative?false:isOllama?(selected.capabilities||[]).includes("tools"):original.provider!=="compatible"||compatibleEndpoint.tools===true
    readonly property string providerLabel:original.provider==="compatible"?(original.connectionId?(connection.name||"Compatible endpoint"):(App.state.settings?.compatible?.label||"Compatible endpoint")):(labels[original.provider]||"")
    function choose(model,effort){
        picker.currentIndex=options.findIndex(m=>m.id===model)
        reasoning.currentIndex=Math.max(0,efforts.findIndex(e=>e.id===effort))
    }
    function refresh(){
        loadError=""
        loadRequest=App.rpc("provider.models",{provider:original.provider,sessionId:sessionId})
    }
    function submissionBlocker(){
        if(!App.connected)return "Reconnect Cere to apply this change."
        if((isNative||isOllama)&&loadRequest>=0)return "Wait for the provider’s model list."
        if(isNative&&picker.currentIndex<0)return "Choose a provider model or its default."
        if(!isNative&&!modelId)return "Choose a model or enter its model ID."
        if(assistance.checked&&!toolsSupported)return isOllama?"This model does not support tools. Choose another model or turn desktop tools off.":"This endpoint is not declared to support tools. Turn desktop tools off, or update its saved declaration."
        if(trust.visible&&!trust.checked)return "Confirm that you trust this project before enabling desktop tools."
        return ""
    }
    readonly property string applyBlocker:saveRequest<0&&optionsRequest<0?submissionBlocker():""
    onOpened:{
        sessionId=App.selectedId;original=App.session;error="";loadError=""
        models=original.model?[{id:original.model,displayName:original.model,efforts:original.effort?[{id:original.effort,displayName:original.effort}]:[]}]:[]
        custom.text="";assistance.checked=!!(original.ollama?.tools||original.api?.tools);trust.checked=false
        const o=original.modelOptions||{};temperature.text=o.temperature!==undefined?String(o.temperature):"";maxOutput.text=o.maxOutputTokens?String(o.maxOutputTokens):"";contextTokens.text=o.contextTokens?String(o.contextTokens):"";keepAlive.text=o.keepAlive||""
        connections=[];connectionsRequest=original.provider==="compatible"?App.rpc("connections.list",{}):-1
        choose(original.model||"",original.effort||"");refresh()
    }
    onClosed:{loadRequest=-1;connectionsRequest=-1;saveRequest=-1;optionsRequest=-1}
    CText { Accessible.role:Accessible.Heading;text:dialog.accessibleTitle;font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:dialog.providerLabel+" · "+(dialog.original.model||"Provider default");color:Theme.accentText;font.pixelSize:Theme.secondary }
    CText { visible:dialog.isOllama||dialog.original.provider==="compatible";text:dialog.isOllama?(dialog.original.ollama?.host||""):(dialog.compatibleEndpoint.baseUrl||"Loading saved endpoint…");color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { text:"Changes apply to your next message. Your conversation stays in this session.";color:Theme.muted;font.pixelSize:Theme.secondary }
    SectionLabel { text:"MODEL";Accessible.role:Accessible.Heading }
    RowLayout { Layout.fillWidth:true;CText{text:"Model";color:Theme.muted}CButton{text:"Refresh";enabled:dialog.loadRequest<0&&dialog.saveRequest<0;onClicked:dialog.refresh()} }
    CComboBox {
        id:picker;objectName:"ollamaSessionModel";Layout.fillWidth:true;model:dialog.options;textRole:"displayName";valueRole:"id";Accessible.name:"Conversation model";enabled:dialog.saveRequest<0
        onActivated:{custom.text="";reasoning.currentIndex=0;if(dialog.isOllama&&!(dialog.selected.capabilities||[]).includes("tools"))assistance.checked=false}
    }
    CField { id:custom;objectName:"conversationCustomModel";visible:dialog.isApi;Layout.fillWidth:true;maximumLength:512;placeholderText:"Or enter an API model ID";Accessible.name:"Custom conversation model ID";enabled:dialog.saveRequest<0 }
    CText { text:dialog.selected.description||"";visible:!!text;color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { visible:dialog.isNative;text:"Reasoning effort";color:Theme.muted;font.pixelSize:Theme.secondary }
    CComboBox { id:reasoning;objectName:"conversationEffort";visible:dialog.isNative;Layout.fillWidth:true;model:dialog.efforts;textRole:"displayName";valueRole:"id";Accessible.name:"Conversation reasoning effort";enabled:dialog.saveRequest<0 }
    CText { visible:dialog.isApi&&dialog.modelId!==dialog.original.model;text:"Messages, attachments and recorded tool results stay available. Model-specific reasoning is reset. Image and tool support depend on the model you choose.";color:Theme.muted;font.pixelSize:Theme.secondary }
    SectionLabel { visible:!dialog.isNative;text:"ACCESS";Accessible.role:Accessible.Heading }
    CCheckBox { id:assistance;objectName:"ollamaSessionTools";visible:!dialog.isNative;text:"Enable desktop tools and delegation";enabled:!dialog.original.temporary&&dialog.saveRequest<0&&dialog.optionsRequest<0&&(checked||dialog.toolsSupported) }
    CText { visible:!dialog.isNative;text:dialog.original.provider==="compatible"?"Tool access follows this conversation’s saved endpoint declaration. Categories come from Settings → AI assistance; web search and memory follow Settings.":"Uses categories enabled in Settings → AI assistance. Web search and memory follow Settings.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CCheckBox { id:trust;visible:!dialog.isNative&&!App.state.settings?.bypassCliPermissions&&assistance.checked&&!(dialog.original.ollama?.tools||dialog.original.api?.tools);text:"I trust this project and its enabled tool access" }
    CText { visible:trust.visible;text:dialog.original.cwd||"";color:Theme.accentText;font.pixelSize:Theme.secondary }
    // Model options: sent only when set, each in the field this provider takes; empty keeps its default.
    ColumnLayout {
        visible:!dialog.isNative;Layout.fillWidth:true;spacing:6
        SectionLabel { text:"MODEL OPTIONS";Accessible.role:Accessible.Heading }
        CText { text:"Empty fields keep the model’s default.";color:Theme.muted;font.pixelSize:Theme.secondary }
        GridLayout {
            columns:dialog.width<440?1:2;Layout.fillWidth:true;columnSpacing:8;rowSpacing:4
            CText { text:"Temperature";Layout.fillWidth:false } CField { id:temperature;objectName:"optionTemperature";Layout.fillWidth:true;placeholderText:"0–2";validator:DoubleValidator{bottom:0;top:2;decimals:2} Accessible.name:"Temperature" }
            CText { text:"Maximum reply";Layout.fillWidth:false } CField { id:maxOutput;objectName:"optionMaxOutput";Layout.fillWidth:true;placeholderText:"tokens";validator:IntValidator{bottom:256} Accessible.name:"Maximum reply tokens" }
            CText { visible:dialog.isOllama;text:"Context window";Layout.fillWidth:false } CField { id:contextTokens;objectName:"optionContext";visible:dialog.isOllama;Layout.fillWidth:true;placeholderText:"tokens (smaller uses less memory)";validator:IntValidator{bottom:2048} Accessible.name:"Context window tokens" }
            CText { visible:dialog.isOllama;text:"Keep loaded";Layout.fillWidth:false } CField { id:keepAlive;objectName:"optionKeepAlive";visible:dialog.isOllama;Layout.fillWidth:true;placeholderText:"e.g. 10m, 0 to unload, -1 to keep";Accessible.name:"Keep the model loaded" }
        }
        CText { visible:dialog.original.provider==="openai";text:"Some OpenAI reasoning models reject a temperature; leave it empty for them.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible:dialog.isOllama;text:"A smaller context window uses less GPU memory and answers sooner, but older parts of the conversation drop out sooner.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    }
    CText { visible:!!dialog.loadError;text:dialog.loadError;color:Theme.amber;font.pixelSize:Theme.secondary }
    CText { visible:!!dialog.error;text:dialog.error;color:Theme.danger;font.pixelSize:Theme.secondary }
    footerContent:Component { ColumnLayout {
        Layout.fillWidth:true;spacing:Theme.space2
        CText { objectName:"modelApplyHint";visible:dialog.saveRequest<0&&dialog.optionsRequest<0&&!!dialog.applyBlocker;Layout.fillWidth:true;text:dialog.applyBlocker;color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Accessible.name:text }
        RowLayout {
            Layout.fillWidth:true;spacing:Theme.space2
            CButton { Layout.fillWidth:true;text:"Cancel";enabled:dialog.saveRequest<0&&dialog.optionsRequest<0;onClicked:dialog.close() }
            CButton { objectName:"ollamaSessionSave";Layout.fillWidth:true;text:dialog.saveRequest>=0||dialog.optionsRequest>=0?"Saving…":"Apply";primary:true;prominent:true
                enabled:dialog.saveRequest<0&&dialog.optionsRequest<0&&!dialog.applyBlocker
                onClicked:{dialog.error="";dialog.saveRequest=App.rpc("session.configure",{id:dialog.sessionId,model:dialog.modelId,effort:dialog.isNative?reasoning.currentValue||"":"",tools:!dialog.isNative&&assistance.checked,trusted:trust.checked,expectedConfigRevision:dialog.original.configRevision||"0"})}
            }
        }
    } }
    Connections { target:App;function onResult(id,value){
        if(id===dialog.connectionsRequest){
            dialog.connectionsRequest=-1
            if(value?.error)dialog.loadError=String(value.error.message||value.error)
            else dialog.connections=value||[]
        } else if(id===dialog.loadRequest){
            dialog.loadRequest=-1
            if(value?.error)dialog.loadError=value.error
            else {
                const selectedId=picker.currentIndex>=0?picker.currentValue||"":dialog.original.model||"",effort=reasoning.currentValue||""
                let catalog=value.slice()
                if(!dialog.isOllama&&selectedId&&!catalog.some(m=>m.id===selectedId))catalog.push({id:selectedId,displayName:selectedId+" (current)",efforts:effort?[{id:effort,displayName:effort}]:[]})
                dialog.models=catalog;dialog.choose(selectedId,effort)
            }
        } else if(id===dialog.saveRequest){dialog.saveRequest=-1;if(value?.error){dialog.error=value.error;return}
            if(dialog.isNative){dialog.close();return}
            const options={};if(temperature.text.trim())options.temperature=Number(temperature.text);if(maxOutput.text.trim())options.maxOutputTokens=Number(maxOutput.text);if(dialog.isOllama&&contextTokens.text.trim())options.contextTokens=Number(contextTokens.text);if(dialog.isOllama&&keepAlive.text.trim())options.keepAlive=keepAlive.text.trim()
            dialog.optionsRequest=App.rpc("session.modelOptions",{id:dialog.sessionId,options:options})
        } else if(id===dialog.optionsRequest){dialog.optionsRequest=-1;if(value?.error)dialog.error=value.error;else dialog.close()}
    } }
}
