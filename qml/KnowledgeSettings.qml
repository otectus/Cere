import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
    id:knowledge
    Layout.fillWidth:true;spacing:14
    property var search:App.state.settings?.webSearch||({enabled:false,provider:"auto",searxngUrl:""})
    property var memory:App.state.settings?.memory||({enabled:false,model:"nomic-embed-text"})
    property var status:App.state.memory||({})
    property int webRequest:-1
    property int memoryRequest:-1
    property int extractionRequest:-1
    property int extractionRefreshRequest:-1
    property var extractionCapability:App.state.capabilities?.ollama||({})
    property string selectedExtractionModel:memory.extractionModel||"nemotron-3-super"
    function matchesExtraction(id) { return id===selectedExtractionModel||id===selectedExtractionModel+":cloud"||id===selectedExtractionModel+"-cloud" }
    property var extractionChoices: {
        const models=(extractionCapability.models||[]).filter(m=>m.cloud)
        return models.some(m=>matchesExtraction(m.id))?models:models.concat([{id:selectedExtractionModel,displayName:selectedExtractionModel+" · unavailable"}])
    }
    property int extractionIndex:extractionChoices.findIndex(m=>matchesExtraction(m.id))
    property int checkRequest:-1
    property bool checkAfterSave:false
    property string webError:""
    property string memoryError:""
    property string checkResult:""
    property var providers:[{id:"auto",label:"Automatic · DuckDuckGo first"},{id:"duckduckgo",label:"DuckDuckGo"},{id:"brave",label:"Brave"},{id:"mojeek",label:"Mojeek"},{id:"searxng",label:"SearXNG · your server"}]
    CSection {
        title:"Web search"
        description:"Let Ollama look up current information and cite its sources. Desktop control is not required."
        CCheckBox { objectName:"webSearchEnabled";text:"Enable web search";checked:knowledge.search.enabled;enabled:knowledge.webRequest<0;onClicked:{knowledge.webError="";knowledge.webRequest=App.rpc("settings.update",{webSearch:{enabled:checked}})} }
        ColumnLayout {
            visible:knowledge.search.enabled;Layout.fillWidth:true;spacing:8
            RowLayout {
                Layout.fillWidth:true
                CComboBox { id:provider;objectName:"webSearchProvider";Layout.fillWidth:true;Layout.minimumWidth:0;model:knowledge.providers;textRole:"label";valueRole:"id";Accessible.name:"Search provider";currentIndex:Math.max(0,knowledge.providers.findIndex(p=>p.id===knowledge.search.provider)) }
                CButton { objectName:"webSearchSave";text:"Apply";enabled:knowledge.webRequest<0;onClicked:{knowledge.webError="";knowledge.webRequest=App.rpc("settings.update",{webSearch:{provider:provider.currentValue,searxngUrl:searx.text.trim()}})} }
            }
            CField { id:searx;objectName:"searxngUrl";visible:provider.currentValue==="searxng";Layout.fillWidth:true;placeholderText:"http://localhost:8080";text:knowledge.search.searxngUrl;Accessible.name:"SearXNG server base URL" }
            CText { visible:provider.currentValue==="searxng";text:"Use a SearXNG base URL with JSON search enabled. Queries go only to this server.";color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { visible:provider.currentValue!=="searxng";text:"Free, with no API key. Automatic tries DuckDuckGo, then Brave and Mojeek if needed. Public search pages can block or limit requests.";color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { text:"Models with tool support decide when to search. Use Search web beside the message box to search on this turn with any Ollama chat model. Queries go to the selected provider; page reading contacts the source website.";color:Theme.muted;font.pixelSize:Theme.secondary }
        }
        CText { visible:!!knowledge.webError;text:knowledge.webError;color:Theme.danger;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Memory"
        description:"Share project facts and earlier conversations across Codex, Claude and Ollama."
        CCheckBox { objectName:"memoryEnabled";text:"Remember and recall conversations";checked:knowledge.memory.enabled;enabled:knowledge.memoryRequest<0;onClicked:{knowledge.checkAfterSave=false;knowledge.memoryError="";knowledge.memoryRequest=App.rpc("settings.update",{memory:{enabled:checked}})} }
        ColumnLayout {
            visible:knowledge.memory.enabled;Layout.fillWidth:true;spacing:8
            CText { text:"Embedding model";color:Theme.muted;font.pixelSize:Theme.secondary }
            RowLayout {
                Layout.fillWidth:true
                CField { id:embedding;objectName:"embeddingModel";Layout.fillWidth:true;Layout.minimumWidth:0;text:knowledge.memory.model;placeholderText:"nomic-embed-text";Accessible.name:"Ollama embedding model" }
                CButton { objectName:"memoryCheck";text:knowledge.checkRequest>=0?"Checking…":"Check & save";enabled:knowledge.memoryRequest<0&&knowledge.checkRequest<0;onClicked:{knowledge.checkAfterSave=true;knowledge.memoryError="";knowledge.checkResult="";knowledge.memoryRequest=App.rpc("settings.update",{memory:{model:embedding.text.trim()}})} }
            }
            CText { text:"Default: nomic-embed-text. Install it with ollama pull nomic-embed-text. Codex and Claude use the Ollama server in Connections for memory. Ollama conversations retain their saved server.";color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { text:"Graph extraction model";color:Theme.muted;font.pixelSize:Theme.secondary }
            RowLayout {
                Layout.fillWidth:true
                CComboBox {
                    id:extraction;objectName:"extractionModel";Layout.fillWidth:true;Layout.minimumWidth:0
                    model:knowledge.extractionChoices;textRole:"displayName";valueRole:"id";Accessible.name:"Memory extraction model"
                    enabled:App.connected&&knowledge.extractionRequest<0&&knowledge.extractionCapability.modelsStatus==="ready"
                    currentIndex:knowledge.extractionIndex
                    onActivated:{knowledge.memoryError="";knowledge.extractionRequest=App.rpc("settings.update",{memory:{extractionModel:currentValue}})}
                }
                CButton { objectName:"extractionModelsRefresh";text:"Refresh";enabled:App.connected&&knowledge.extractionRefreshRequest<0&&knowledge.extractionCapability.modelsStatus!=="loading";onClicked:{knowledge.memoryError="";knowledge.extractionRefreshRequest=App.rpc("provider.models",{provider:"ollama"})} }
            }
            CText { text:"Extraction uses Nemotron 3 Super on Ollama Cloud by default and runs in the background. Source restrictions apply before sending text. Claims retain exact evidence and correction history.";color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { visible:knowledge.extractionCapability.modelsStatus==="loading";text:"Loading Ollama Cloud models…";color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { visible:!!knowledge.extractionCapability.modelsError;text:knowledge.extractionCapability.modelsError||"";color:Theme.danger;font.pixelSize:Theme.secondary }
            CText { visible:knowledge.extractionCapability.modelsStatus==="ready"&&!(knowledge.extractionCapability.models||[]).some(m=>m.cloud);text:"No cloud models are registered on your Ollama server. Add an Ollama Cloud model, then Refresh.";color:Theme.amber;font.pixelSize:Theme.secondary }
            CCheckBox { objectName:"cloudExtractionEnabled";text:"Allow Ollama Cloud memory extraction";checked:knowledge.memory.allowCloudExtraction===undefined?true:knowledge.memory.allowCloudExtraction;onClicked:knowledge.memoryRequest=App.rpc("settings.update",{memory:{allowCloudExtraction:checked}}) }
            CCheckBox { objectName:"cloudMemoryEnabled";text:"Share recalled memory with Codex, Claude and cloud models";checked:knowledge.memory.allowCloudMemory||false;onClicked:knowledge.memoryRequest=App.rpc("settings.update",{memory:{allowCloudMemory:checked}}) }
            CText { text:(knowledge.status.saved||0)+" saved facts · "+Math.max(0,(knowledge.status.total||0)-(knowledge.status.saved||0))+" conversation passages"+((knowledge.status.pending||0)?" · "+knowledge.status.pending+" awaiting embedding":"");color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { visible:!!knowledge.checkResult;text:knowledge.checkResult;color:Theme.cyan;font.pixelSize:Theme.secondary }
            CText { visible:knowledge.status.state==="degraded";text:knowledge.status.error||"Semantic memory is unavailable. Keyword recall is still available.";color:Theme.amber;font.pixelSize:Theme.secondary }
        }
        CText { visible:!!knowledge.memoryError;text:knowledge.memoryError;color:Theme.danger;font.pixelSize:Theme.secondary }
        CButton { objectName:"manageMemories";text:"Manage project memory";enabled:App.connected&&!!App.session.id&&!App.session.temporary;onClicked:manager.open() }
        CText { text:App.session.id?"Review, correct or forget shared facts and conversation passages. Memory stays separate for each project and server.":"Select a conversation to manage its project’s memory.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    MemoryDialog { id:manager }
    Connections { target:App;function onResult(id,value){
        if(id===knowledge.webRequest){knowledge.webRequest=-1;if(value?.error)knowledge.webError=value.error}
        else if(id===knowledge.memoryRequest){knowledge.memoryRequest=-1;if(value?.error)knowledge.memoryError=value.error;else if(knowledge.checkAfterSave)knowledge.checkRequest=App.rpc("memory.check",{});knowledge.checkAfterSave=false}
        else if(id===knowledge.extractionRequest){knowledge.extractionRequest=-1;if(value?.error)knowledge.memoryError=value.error;extraction.currentIndex=Qt.binding(()=>knowledge.extractionIndex)}
        else if(id===knowledge.extractionRefreshRequest){knowledge.extractionRefreshRequest=-1;if(value?.error)knowledge.memoryError=value.error}
        else if(id===knowledge.checkRequest){knowledge.checkRequest=-1;if(value?.error)knowledge.memoryError=value.error;else knowledge.checkResult="Ready · "+value.model}
    } }
}
