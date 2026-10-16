import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:popup
    signal sessionOpened()
    signal projectSaved(var project)
    property bool projectSettings:false
    property var project:({})
    objectName:"newSessionDialog"
    property var imported: ({})
    property int requestId:-1
    property string error:""
    property string modelError:""
    property string desiredModel:""
    property string desiredEffort:""
    // A general conversation opens with the choices saved by "Save as my defaults". Project settings and
    // CLI imports do not, and no other way of starting a conversation (a project, delegation, a branch,
    // a phone) reads them. Trust is never saved: it is confirmed for each conversation's folder.
    readonly property bool general:!projectSettings&&!imported.nativeId
    property bool prefilled:false
    // M01/A06: a project's style and its convention files are saved after its defaults, each with the
    // revision the previous step returned.
    property var styleChoices:[{id:"",label:"The personality in Settings"}]
    property int stylesRequest:-1
    property string projectStage:""
    function nextProjectStep(saved){
        const profileId=projectStyle.currentIndex>0?styleChoices[projectStyle.currentIndex].id:null
        if((saved.behaviorProfileId||null)!==profileId){projectStage="style";requestId=App.rpc("projects.setProfile",{cwd:saved.cwd,expectedRevision:saved.revision,profileId:profileId});return true}
        if(!!saved.conventions!==conventions.checked){projectStage="conventions";requestId=App.rpc("projects.setConventions",{cwd:saved.cwd,expectedRevision:saved.revision,enabled:conventions.checked});return true}
        return false
    }
    property var pendingDefaults:null
    closePolicy:requestId>=0?Popup.NoAutoClose:Popup.CloseOnEscape|Popup.CloseOnPressOutside
    function editProject(value) {
        project=value||({})
        imported=Object.assign({},project.defaults||{},{cwd:project.cwd||"",title:project.name||""})
        open()
    }
    property var modelRequests: ({})
    property string providerName:["codex","claude","ollama","antigravity","openai","anthropic","google","compatible"][provider.currentIndex]||"codex"
    property bool isOllama:providerName==="ollama"
    property bool isApi:["openai","anthropic","google","compatible"].includes(providerName)
    // M13: a compatible endpoint takes tools only when they are declared in Settings › Connections.
    readonly property bool apiTools:providerName!=="compatible"||App.state.settings?.compatible?.tools===true
    property bool isConversation:isOllama||isApi
    property string savedDefault:App.state.settings?.ollama?.model||""
    property var capability:(App.state.capabilities||{})[providerName]||({})
    property var modelOptions:[{id:"",displayName:isApi?"Choose a model":isOllama?(savedDefault?"Default · "+savedDefault:"Choose a model"):"CLI default",description:isApi?"Select from the catalog or enter a model ID below":isOllama?"Choose a default in Settings → Connections":"Use the model configured by the CLI",efforts:[],defaultEffort:"",isDefault:true}].concat(capability.models||[]).concat((projectSettings||prefilled)&&desiredModel&&!(capability.models||[]).some(m=>m.id===desiredModel)?[{id:desiredModel,displayName:desiredModel+" · saved",description:"Saved selection. Availability is checked when you open a session.",efforts:[],defaultEffort:""}]:[])
    property var effectiveModel:isOllama?(capability.models||[]).find(m=>m.id===(modelName.currentValue||savedDefault)):selectedModel
    property var selectedModel:modelName.currentIndex>=0&&modelName.currentIndex<modelOptions.length?modelOptions[modelName.currentIndex]:modelOptions[0]
    property var effortOptions:[{id:"",displayName:"CLI default",description:"Use the CLI’s configured effort"}].concat(selectedModel&&selectedModel.efforts?selectedModel.efforts:[]).concat((projectSettings||prefilled)&&desiredEffort&&!(selectedModel?.efforts||[]).some(e=>e.id===desiredEffort)?[{id:desiredEffort,displayName:desiredEffort+" · saved"}]:[])
    function chooseEffort(value) {
        const wanted=value===undefined?"":value
        const index=effortOptions.findIndex(option=>option.id===wanted)
        reasoningEffort.currentIndex=index>=0?index:0
        desiredEffort=reasoningEffort.currentValue||""
    }
    function chooseModel(modelValue) {
        let index=modelOptions.findIndex(option=>option.id===(modelValue||""))
        if(index<0)index=modelOptions.findIndex(option=>option.isDefault)
        modelName.currentIndex=index>=0?index:0
        desiredModel=modelName.currentValue||""
        // The effort follows once the model's efforts are listed. It is read when that pass runs: an effort
        // chosen after this pass was scheduled must not be replaced by the one wanted before.
        Qt.callLater(()=>{if(popup)popup.chooseEffort(popup.desiredEffort)})
    }
    function refreshModels() {
        if(!App.connected)return
        modelError=""
        const id=App.rpc("provider.models",{provider:providerName})
        const requests=Object.assign({},modelRequests);requests[id]=providerName;modelRequests=requests
    }
    onModelOptionsChanged:Qt.callLater(()=>{if(popup)popup.chooseModel(popup.desiredModel)})
    // Each opening starts at the top, where the heading and the saved-defaults note are.
    onAboutToShow:scrollToTop()
    onOpened:{
        const saved=general?App.state.settings?.conversationDefaults:null
        prefilled=!!saved
        const start=saved||imported
        sessionTitle.text=imported.title||""
        folder.text=imported.cwd||""
        provider.currentIndex=Math.max(0,["codex","claude","ollama","antigravity","openai","anthropic","google","compatible"].indexOf(start.provider||"codex"))
        desiredModel=start.model||"";desiredEffort=start.effort||""
        chooseModel(desiredModel);refreshModels()
        customModel.text="";temporary.checked=(projectSettings||prefilled)&&!!start.temporary;tools.checked=(projectSettings||prefilled)&&!!start.tools;trust.checked=projectSettings&&!!imported.trusted;favorite.checked=!!project.favorite;conventions.checked=projectSettings&&!!project.conventions;projectStage="";if(projectSettings)stylesRequest=App.rpc("presets.list",{});handoff.checked=false;saveDefaults.checked=false;error="";modelError=""
        Qt.callLater(()=>sessionTitle.forceActiveFocus())
    }
    CText { text:popup.projectSettings?"Project settings":popup.imported.nativeId?"Continue a CLI session":"Start a conversation";font.pixelSize:Theme.page;font.weight:Font.DemiBold }
    CText { text:popup.projectSettings?"New sessions inherit these defaults. Existing conversations keep their settings.":popup.imported.nativeId?"Review the details before bringing this session into Cere.":"Name the conversation, then choose where and how it should run.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    CText { objectName:"savedDefaultsNote";visible:popup.prefilled;text:"Filled in from your saved defaults. Change anything you like for this one.";color:Theme.accentText;font.pixelSize:Theme.secondary }
    CText { text:popup.projectSettings?"Project name":"Title (optional)";color:Theme.muted;font.pixelSize:Theme.secondary }
    CField {
        id:sessionTitle;objectName:"sessionTitle";Layout.fillWidth:true;maximumLength:100
        placeholderText:popup.projectSettings?"Project name":"Untitled session";Accessible.name:popup.projectSettings?"Project name":"Session title"
    }
    CCheckBox { id:favorite;objectName:"projectFavorite";visible:popup.projectSettings;text:"Keep this project at the top" }
    CText { text:"Provider";color:Theme.muted;font.pixelSize:Theme.secondary }
    CComboBox {
        id:provider;objectName:"sessionProvider";Layout.fillWidth:true;model:["Codex","Claude Code","Ollama","AntiGravity","OpenAI API","Claude API","Google AI API",App.state.settings?.compatible?.label||"Compatible endpoint"];enabled:!popup.imported.nativeId;Accessible.name:"Session provider"
        onActivated:{customModel.text="";tools.checked=false;if(popup.projectSettings)trust.checked=false;popup.desiredModel="";popup.desiredEffort="";popup.chooseModel("");popup.refreshModels()}
    }
    CText { text:!popup.projectSettings&&popup.isConversation&&!tools.checked?"Project folder (optional)":"Project folder";color:Theme.muted;font.pixelSize:Theme.secondary }
    RowLayout {
        Layout.fillWidth:true
        CField { id:folder;objectName:"sessionProjectPath";Layout.fillWidth:true;placeholderText:"Absolute project path";Accessible.name:"Project folder";readOnly:popup.projectSettings&&!!popup.project.cwd }
        CButton { visible:!popup.projectSettings||!popup.project.cwd;text:"Browse";onClicked:{const p=App.chooseFolder();if(p){folder.text=p;if(popup.projectSettings&&!sessionTitle.text.trim())sessionTitle.text=p.split("/").filter(v=>!!v).pop()||p}} }
    }
    RowLayout {
        Layout.fillWidth:true
        CText { text:"Model";color:Theme.muted;font.pixelSize:Theme.secondary;Layout.fillWidth:true }
        CButton { objectName:"sessionModelsRefresh";text:popup.capability.modelsStatus==="loading"?"Loading…":"Refresh";enabled:App.connected&&popup.capability.modelsStatus!=="loading";onClicked:popup.refreshModels() }
    }
    CComboBox {
        id:modelName;objectName:"sessionModel";Layout.fillWidth:true;model:popup.modelOptions;textRole:"displayName";valueRole:"id";Accessible.name:"Session model"
        onActivated:{if(!popup.isApi&&!popup.effectiveModel?.capabilities?.includes("tools"))tools.checked=false;popup.desiredModel=currentValue||"";popup.desiredEffort="";popup.chooseEffort("")}
    }
    CField { id:customModel;objectName:"sessionCustomModel";visible:popup.isApi;Layout.fillWidth:true;maximumLength:512;placeholderText:"Or enter an API model ID";Accessible.name:"Custom API model ID" }
    CText { visible:popup.isApi&&popup.providerName!=="compatible";text:"Uses your API key from Settings → Connections. API usage may incur charges. Desktop only.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { visible:popup.providerName==="compatible";text:App.state.settings?.compatible?.baseUrl?"Uses "+App.state.settings.compatible.baseUrl+" from Settings → Connections, with the capabilities you declared there. Desktop only.":"Set the compatible endpoint in Settings → Connections first.";color:App.state.settings?.compatible?.baseUrl?Theme.muted:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:popup.providerName==="antigravity";text:"Uses your agy sign-in. Actions needing approval may be skipped by headless mode. Images are not supported.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { visible:!popup.isOllama&&popup.selectedModel&&!!popup.selectedModel.description;text:popup.selectedModel?popup.selectedModel.description:"";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    CText { visible:!popup.isConversation;text:"Effort";color:Theme.muted;font.pixelSize:Theme.secondary }
    CComboBox {
        id:reasoningEffort;visible:!popup.isConversation;objectName:"sessionEffort";Layout.fillWidth:true;model:popup.effortOptions;textRole:"displayName";valueRole:"id";Accessible.name:"Session effort"
        onActivated:popup.desiredEffort=currentValue||""
    }
    CText { visible:!!reasoningEffort.currentValue&&reasoningEffort.currentIndex>=0&&!!popup.effortOptions[reasoningEffort.currentIndex].description;text:reasoningEffort.currentIndex>=0?(popup.effortOptions[reasoningEffort.currentIndex].description||""):"";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    CText { visible:popup.isOllama;text:popup.effectiveModel?.description||(popup.capability.modelsStatus==="ready"?"No chat model selected. Choose a model above or pull one with Ollama and Refresh.":"Connect to Ollama in Settings → Connections.");color:Theme.muted;font.pixelSize:Theme.secondary }
    CCheckBox { id:temporary;objectName:"temporarySession";visible:!popup.imported.nativeId;text:"Temporary conversation";onClicked:if(checked)tools.checked=false }
    CText { visible:temporary.checked;text:"Cere keeps this text conversation in broker memory until you close it or the broker exits. Files, memory and Cere tools are unavailable. Native CLIs and external providers may retain their own histories.";color:Theme.amber;font.pixelSize:Theme.secondary }
    CCheckBox { id:tools;objectName:"sessionTools";visible:popup.isConversation;text:"Enable desktop tools and delegation";enabled:!temporary.checked&&(popup.isApi&&popup.apiTools||!!popup.effectiveModel?.capabilities?.includes("tools")) }
    CText { visible:popup.isConversation;text:tools.checked?"Uses categories enabled in Settings → AI assistance. Delegated tasks ask for review unless CLI permission bypass is enabled.":"Web search and memory follow Settings. Desktop access stays off.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CCheckBox { id:trust;objectName:"sessionTrust";visible:(popup.projectSettings||!App.state.settings?.bypassCliPermissions)&&(!popup.isConversation||tools.checked);text:popup.projectSettings?(popup.isConversation?"Allow desktop tools for new sessions in this project":"Trust this project’s CLI configuration for new sessions"):popup.isApi?"Allow this conversation to use the enabled desktop tool categories":"I trust this project’s CLI configuration and hooks" }
    CText { visible:popup.projectSettings&&trust.visible;text:"Saved trust applies to this project’s new sessions. Tool approval settings still apply.";color:Theme.muted;font.pixelSize:Theme.caption }
    CText { visible:popup.projectSettings;text:"Conversation style";color:Theme.muted;font.pixelSize:Theme.secondary }
    CComboBox { id:projectStyle;objectName:"projectStyle";visible:popup.projectSettings;Layout.fillWidth:true;model:popup.styleChoices;textRole:"label";Accessible.name:"Conversation style for this project" }
    CText { visible:popup.projectSettings;text:"This project’s conversations use this style unless a conversation picks its own. Save styles in Settings › Personality.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CCheckBox { id:conventions;objectName:"projectConventions";visible:popup.projectSettings;text:"Read AGENTS.md, CLAUDE.md and CONVENTIONS.md for Ollama and API conversations" }
    CText { visible:popup.projectSettings&&conventions.checked;text:"Read fresh for every message, up to 8,000 characters, never through links. Codex and Claude Code read their own instruction files, so Cere does not add them there.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CCheckBox { id:handoff;visible:!!popup.imported.nativeId;text:"I stopped the external session before handing it over" }
    CText { visible:!!popup.imported.nativeId;text:"Cere continues the provider’s history. Close its terminal session before handing it over.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CCheckBox {
        id:saveDefaults;objectName:"saveDefaults";visible:popup.general;text:"Save as my defaults"
        Accessible.description:"New conversations start with this provider, model, effort and mode"
    }
    CText { visible:saveDefaults.visible&&saveDefaults.checked;text:"Next time, a new conversation will use these settings. Titles, folders and trust stay your call; projects keep their own defaults.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { objectName:"newSessionError";visible:popup.error.length>0||popup.modelError.length>0;text:popup.error||popup.modelError;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    footerContent:Component { RowLayout {
        Layout.fillWidth:true
        CButton { Layout.fillWidth:true;text:"Cancel";enabled:popup.requestId<0;onClicked:popup.close() }
        CButton {
            objectName:"sessionOpen";Layout.fillWidth:true;text:popup.requestId>=0?"Saving…":popup.projectSettings?"Save defaults":"Open session";primary:true
            enabled:popup.requestId<0&&App.connected&&(popup.projectSettings?(sessionTitle.text.trim().length>0&&folder.text.trim().startsWith("/")&&(!popup.isApi||!!(customModel.text.trim()||modelName.currentValue))):((!trust.visible||trust.checked)&&(folder.text.startsWith("/")||(popup.isConversation&&!tools.checked&&!folder.text.trim()))&&(!popup.isOllama||(popup.capability.modelsStatus==="ready"&&!!popup.effectiveModel))&&(!popup.isApi||(!!(customModel.text.trim()||modelName.currentValue)&&popup.capability.configured))&&(!popup.imported.nativeId||handoff.checked)))
            onClicked:{
                const defaults={provider:popup.providerName,trusted:trust.checked,temporary:temporary.visible&&temporary.checked,tools:popup.isConversation&&tools.checked,model:popup.isApi&&customModel.text.trim()?customModel.text.trim():modelName.currentValue||"",effort:popup.isConversation?"":reasoningEffort.currentValue||""}
                popup.error=""
                popup.pendingDefaults=popup.general&&saveDefaults.checked?{provider:defaults.provider,model:defaults.model,effort:defaults.effort,tools:defaults.tools,temporary:defaults.temporary}:null
                popup.requestId=popup.projectSettings?App.rpc("projects.save",{cwd:folder.text.trim(),name:sessionTitle.text.trim(),favorite:favorite.checked,expectedRevision:popup.project.revision||"0",defaults:defaults}):App.rpc("session.create",Object.assign(defaults,{cwd:folder.text.trim(),nativeId:popup.imported.nativeId||"",handoffConfirmed:handoff.checked,title:sessionTitle.text.trim()||"Untitled session"}))
            }
        }
    } }
    Connections { target:App;function onResult(id,value){
        const requestedProvider=popup.modelRequests[id]
        if(requestedProvider){const requests=Object.assign({},popup.modelRequests);delete requests[id];popup.modelRequests=requests;if(requestedProvider===popup.providerName&&value?.error)popup.modelError=value.error;return}
        // Defaults are saved once the conversation they describe has opened.
        if(id===popup.stylesRequest){
            popup.stylesRequest=-1
            popup.styleChoices=[{id:"",label:"The personality in Settings"}].concat((value?.items||[]).map(item=>({id:item.id,label:item.label})))
            if(popup.project.behaviorProfileId&&!popup.styleChoices.some(item=>item.id===popup.project.behaviorProfileId))popup.styleChoices=popup.styleChoices.concat([{id:popup.project.behaviorProfileId,label:"A deleted style · falls back to Settings"}])
            projectStyle.currentIndex=Math.max(0,popup.styleChoices.findIndex(item=>item.id===(popup.project.behaviorProfileId||"")))
            return
        }
        if(id===popup.requestId&&popup.projectSettings&&!value?.error&&popup.nextProjectStep(value))return
        if(id===popup.requestId&&popup.projectStage&&value?.error){popup.requestId=-1;popup.error="The defaults were saved, but not the "+popup.projectStage+": "+value.error;popup.projectStage="";return}
        if(id===popup.requestId){popup.requestId=-1;popup.projectStage="";if(value?.error)popup.error=value.error;else{if(popup.pendingDefaults)App.rpc("settings.update",{conversationDefaults:popup.pendingDefaults});popup.pendingDefaults=null;popup.imported={};popup.close();if(popup.projectSettings)popup.projectSaved(value);else popup.sessionOpened()}}
    } }
}
