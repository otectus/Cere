import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:dialog
    objectName:"sessionModelDialog"
    property string sessionId:""
    property var original:({})
    property var models:[]
    property bool isOllama:original.provider==="ollama"
    property bool isApi:["openai","anthropic","google"].includes(original.provider)
    property bool isNative:!isOllama&&!isApi
    property var labels:({codex:"Codex",claude:"Claude Code",ollama:"Ollama",antigravity:"AntiGravity",openai:"OpenAI API",anthropic:"Claude API",google:"Google AI API"})
    property var defaultEfforts:(models.find(m=>m.isDefault)||{}).efforts||(!original.model&&original.effort?[{id:original.effort,displayName:original.effort}]:[])
    property var options:(isNative?[{id:"",displayName:"Provider default",efforts:defaultEfforts}]:[]).concat(models)
    property var selected:options[picker.currentIndex]||({})
    property string modelId:isApi&&custom.text.trim()?custom.text.trim():picker.currentValue||""
    property var efforts:[{id:"",displayName:"Provider default"}].concat(selected.efforts||[])
    property int loadRequest:-1
    property int saveRequest:-1
    property string error:""
    property string loadError:""
    function choose(model,effort){
        picker.currentIndex=options.findIndex(m=>m.id===model)
        reasoning.currentIndex=Math.max(0,efforts.findIndex(e=>e.id===effort))
    }
    function refresh(){
        loadError=""
        loadRequest=App.rpc("provider.models",{provider:original.provider,sessionId:sessionId})
    }
    onOpened:{
        sessionId=App.selectedId;original=App.session;error="";loadError=""
        models=original.model?[{id:original.model,displayName:original.model,efforts:original.effort?[{id:original.effort,displayName:original.effort}]:[]}]:[]
        custom.text="";assistance.checked=!!(original.ollama?.tools||original.api?.tools);trust.checked=false
        choose(original.model||"",original.effort||"");refresh()
    }
    onClosed:{loadRequest=-1;saveRequest=-1}
    CText { text:"Conversation model";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:(dialog.labels[dialog.original.provider]||"")+" · "+(dialog.original.model||"Provider default");color:Theme.cyan;font.pixelSize:Theme.secondary }
    CText { visible:dialog.isOllama;text:dialog.original.ollama?.host||"";color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { text:"Changes apply to your next message. Your conversation stays in this session.";color:Theme.muted;font.pixelSize:Theme.secondary }
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
    CCheckBox { id:assistance;objectName:"ollamaSessionTools";visible:!dialog.isNative;text:"Enable desktop tools and delegation";enabled:!dialog.original.temporary&&dialog.saveRequest<0&&(dialog.isApi||(dialog.selected.capabilities||[]).includes("tools")) }
    CText { visible:!dialog.isNative;text:"Uses categories enabled in Settings → AI assistance. Web search and memory follow Settings.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CCheckBox { id:trust;visible:!dialog.isNative&&!App.state.settings?.bypassCliPermissions&&assistance.checked&&!(dialog.original.ollama?.tools||dialog.original.api?.tools);text:"I trust this project and its enabled tool access" }
    CText { visible:trust.visible;text:dialog.original.cwd||"";color:Theme.cyan;font.pixelSize:Theme.secondary }
    CText { visible:!!dialog.loadError;text:dialog.loadError;color:Theme.amber;font.pixelSize:Theme.secondary }
    CText { visible:!!dialog.error;text:dialog.error;color:Theme.danger;font.pixelSize:Theme.secondary }
    RowLayout {
        Layout.fillWidth:true
        CButton { Layout.fillWidth:true;text:"Cancel";enabled:dialog.saveRequest<0;onClicked:dialog.close() }
        CButton { objectName:"ollamaSessionSave";Layout.fillWidth:true;text:dialog.saveRequest>=0?"Saving…":"Apply";primary:true
            enabled:App.connected&&dialog.saveRequest<0&&(dialog.isApi||dialog.loadRequest<0)&&(dialog.isNative?picker.currentIndex>=0:!!dialog.modelId)&&(!trust.visible||trust.checked)
            onClicked:{dialog.error="";dialog.saveRequest=App.rpc("session.configure",{id:dialog.sessionId,model:dialog.modelId,effort:dialog.isNative?reasoning.currentValue||"":"",tools:!dialog.isNative&&assistance.checked,trusted:trust.checked,expectedConfigRevision:dialog.original.configRevision||"0"})}
        }
    }
    Connections { target:App;function onResult(id,value){
        if(id===dialog.loadRequest){
            dialog.loadRequest=-1
            if(value?.error)dialog.loadError=value.error
            else {
                const selectedId=picker.currentIndex>=0?picker.currentValue||"":dialog.original.model||"",effort=reasoning.currentValue||""
                let catalog=value.slice()
                if(!dialog.isOllama&&selectedId&&!catalog.some(m=>m.id===selectedId))catalog.push({id:selectedId,displayName:selectedId+" (current)",efforts:effort?[{id:effort,displayName:effort}]:[]})
                dialog.models=catalog;dialog.choose(selectedId,effort)
            }
        } else if(id===dialog.saveRequest){dialog.saveRequest=-1;if(value?.error)dialog.error=value.error;else dialog.close()}
    } }
}
