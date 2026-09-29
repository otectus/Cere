import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:popup
    signal sessionOpened()
    objectName:"newSessionDialog"
    property var imported: ({})
    property int requestId:-1
    property string error:""
    property string modelError:""
    property string desiredModel:""
    property string desiredEffort:""
    property var modelRequests: ({})
    property string providerName:["codex","claude","ollama"][provider.currentIndex]||"codex"
    property bool isOllama:providerName==="ollama"
    property string savedDefault:App.state.settings?.ollama?.model||""
    property var capability:(App.state.capabilities||{})[providerName]||({})
    property var modelOptions:[{id:"",displayName:isOllama?(savedDefault?"Default · "+savedDefault:"Choose a model"):"CLI default",description:isOllama?"Choose a default in Settings → Connections":"Use the model configured by the CLI",efforts:[],defaultEffort:"",isDefault:true}].concat(capability.models||[])
    property var effectiveModel:isOllama?(capability.models||[]).find(m=>m.id===(modelName.currentValue||savedDefault)):selectedModel
    property var selectedModel:modelName.currentIndex>=0&&modelName.currentIndex<modelOptions.length?modelOptions[modelName.currentIndex]:modelOptions[0]
    property var effortOptions:[{id:"",displayName:"CLI default",description:"Use the CLI’s configured effort"}].concat(selectedModel&&selectedModel.efforts?selectedModel.efforts:[])
    function chooseEffort(value) {
        const wanted=value===undefined?"":value
        const index=effortOptions.findIndex(option=>option.id===wanted)
        reasoningEffort.currentIndex=index>=0?index:0
        desiredEffort=reasoningEffort.currentValue||""
    }
    function chooseModel(modelValue,effortValue) {
        let index=modelOptions.findIndex(option=>option.id===(modelValue||""))
        if(index<0)index=modelOptions.findIndex(option=>option.isDefault)
        modelName.currentIndex=index>=0?index:0
        desiredModel=modelName.currentValue||""
        Qt.callLater(()=>chooseEffort(effortValue))
    }
    function refreshModels() {
        if(!App.connected)return
        modelError=""
        const id=App.rpc("provider.models",{provider:providerName})
        const requests=Object.assign({},modelRequests);requests[id]=providerName;modelRequests=requests
    }
    onModelOptionsChanged:Qt.callLater(()=>chooseModel(desiredModel,desiredEffort))
    onOpened:{
        if(imported.cwd)folder.text=imported.cwd
        provider.currentIndex=imported.provider==="claude"?1:imported.provider==="ollama"?2:0
        desiredModel=imported.model||"";desiredEffort=imported.effort||""
        chooseModel(desiredModel,desiredEffort);refreshModels()
        tools.checked=false;trust.checked=false;handoff.checked=false;error="";modelError=""
    }
    CText { text:popup.imported.nativeId?"Continue a CLI session":"Start a conversation";font.pixelSize:20;font.weight:Font.DemiBold }
    CText { text:"Provider";color:Theme.muted;font.pixelSize:12 }
    CComboBox {
        id:provider;objectName:"sessionProvider";Layout.fillWidth:true;model:["Codex","Claude","Ollama"];enabled:!popup.imported.nativeId;Accessible.name:"Session provider"
        onActivated:{tools.checked=false;popup.desiredModel="";popup.desiredEffort="";popup.chooseModel("","");popup.refreshModels()}
    }
    CText { text:popup.isOllama&&!tools.checked?"Project folder (optional)":"Project folder";color:Theme.muted;font.pixelSize:12 }
    RowLayout {
        Layout.fillWidth:true
        CField { id:folder;Layout.fillWidth:true;placeholderText:"Absolute project path";Accessible.name:"Project folder" }
        CButton { text:"Browse";onClicked:{const p=App.chooseFolder();if(p)folder.text=p} }
    }
    RowLayout {
        Layout.fillWidth:true
        CText { text:"Model";color:Theme.muted;font.pixelSize:12;Layout.fillWidth:true }
        CButton { objectName:"sessionModelsRefresh";text:popup.capability.modelsStatus==="loading"?"Loading…":"Refresh";enabled:App.connected&&popup.capability.modelsStatus!=="loading";onClicked:popup.refreshModels() }
    }
    CComboBox {
        id:modelName;objectName:"sessionModel";Layout.fillWidth:true;model:popup.modelOptions;textRole:"displayName";valueRole:"id";Accessible.name:"Session model"
        onActivated:{if(!popup.effectiveModel?.capabilities?.includes("tools"))tools.checked=false;popup.desiredModel=currentValue||"";popup.desiredEffort="";popup.chooseEffort("")}
    }
    CText { visible:!popup.isOllama&&popup.selectedModel&&!!popup.selectedModel.description;text:popup.selectedModel?popup.selectedModel.description:"";color:Theme.muted;font.pixelSize:11;wrapMode:Text.Wrap }
    CText { visible:!popup.isOllama;text:"Effort";color:Theme.muted;font.pixelSize:12 }
    CComboBox {
        id:reasoningEffort;visible:!popup.isOllama;objectName:"sessionEffort";Layout.fillWidth:true;model:popup.effortOptions;textRole:"displayName";valueRole:"id";Accessible.name:"Session effort"
        onActivated:popup.desiredEffort=currentValue||""
    }
    CText { visible:!!reasoningEffort.currentValue&&reasoningEffort.currentIndex>=0&&!!popup.effortOptions[reasoningEffort.currentIndex].description;text:reasoningEffort.currentIndex>=0?(popup.effortOptions[reasoningEffort.currentIndex].description||""):"";color:Theme.muted;font.pixelSize:11;wrapMode:Text.Wrap }
    CText { visible:popup.isOllama;text:popup.effectiveModel?.description||(popup.capability.modelsStatus==="ready"?"No chat model selected. Choose a model above or pull one with Ollama and Refresh.":"Connect to Ollama in Settings → Connections.");color:Theme.muted;font.pixelSize:12 }
    CCheckBox { id:tools;objectName:"sessionTools";visible:popup.isOllama;text:"Enable desktop tools and delegation";enabled:!!popup.effectiveModel?.capabilities?.includes("tools") }
    CText { visible:popup.isOllama;text:tools.checked?"Uses categories enabled in Settings → AI assistance. Delegated tasks ask for review unless CLI permission bypass is enabled.":"Web search and memory follow Settings. Desktop access stays off.";color:Theme.muted;font.pixelSize:12 }
    CCheckBox { id:trust;visible:!App.state.settings?.bypassCliPermissions&&(!popup.isOllama||tools.checked);text:"I trust this project’s CLI configuration and hooks" }
    CCheckBox { id:handoff;visible:!!popup.imported.nativeId;text:"I stopped the external session before handing it over" }
    CText { visible:!!popup.imported.nativeId;text:"Cere continues the provider’s history. Close its terminal session before handing it over.";color:Theme.muted;font.pixelSize:12 }
    CText { visible:popup.error.length>0||popup.modelError.length>0;text:popup.error||popup.modelError;color:Theme.danger;font.pixelSize:12;wrapMode:Text.Wrap }
    RowLayout {
        Layout.fillWidth:true
        CButton { Layout.fillWidth:true;text:"Cancel";onClicked:popup.close() }
        CButton {
            objectName:"sessionOpen";Layout.fillWidth:true;text:popup.requestId>=0?"Opening…":"Open session";primary:true
            enabled:popup.requestId<0&&App.connected&&(!trust.visible||trust.checked)&&(folder.text.startsWith("/")||(popup.isOllama&&!tools.checked&&!folder.text.trim()))&&(!popup.isOllama||(popup.capability.modelsStatus==="ready"&&!!popup.effectiveModel))&&(!popup.imported.nativeId||handoff.checked)
            onClicked:popup.requestId=App.rpc("session.create",{provider:popup.providerName,cwd:folder.text.trim(),trusted:trust.checked,tools:popup.isOllama&&tools.checked,nativeId:popup.imported.nativeId||"",handoffConfirmed:handoff.checked,title:popup.imported.title||"New conversation",model:modelName.currentValue||"",effort:popup.isOllama?"":reasoningEffort.currentValue||""})
        }
    }
    Connections { target:App;function onResult(id,value){
        const requestedProvider=popup.modelRequests[id]
        if(requestedProvider){const requests=Object.assign({},popup.modelRequests);delete requests[id];popup.modelRequests=requests;if(requestedProvider===popup.providerName&&value?.error)popup.modelError=value.error;return}
        if(id===popup.requestId){popup.requestId=-1;if(value?.error)popup.error=value.error;else{popup.imported={};popup.close();popup.sessionOpened()}}
    } }
}
