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
    property string selectedExtractionModel:memory.extractionModel||"glm-5.3-flash:cloud"
    function matchesExtraction(id) { return id===selectedExtractionModel||id===selectedExtractionModel+":cloud"||id===selectedExtractionModel+"-cloud" }
    property var extractionChoices: {
        const models=(extractionCapability.models||[]).filter(m=>m.cloud)
        return models.some(m=>matchesExtraction(m.id))?models:models.concat([{id:selectedExtractionModel,displayName:selectedExtractionModel+" · unavailable"}])
    }
    property int extractionIndex:extractionChoices.findIndex(m=>matchesExtraction(m.id))
    property int checkRequest:-1
    // M07: an optional Markdown notes folder; the folder stays the source of truth.
    property var vault:App.state.settings?.notesVault||({path:"",enabled:false,allowCloud:false})
    property int vaultRequest:-1
    property int vaultStatusRequest:-1
    property var vaultStatus:null
    property string vaultError:""
    property string vaultFeedback:""
    function updateVault(patch,done){vaultError="";vaultFeedback=done||"";vaultRequest=App.rpc("settings.update",{notesVault:patch})}
    function scanVault(){if(App.connected&&vault.enabled)vaultStatusRequest=App.rpc("notes.status",{})}
    Component.onCompleted:scanVault()
    // M09: switching the embedding model is reviewed first: what has vectors in the new space and what will be re-embedded.
    property int impactRequest:-1
    property var impact:null
    property string impactError:""
    function saveEmbedding(){impact=null;impactError="";checkAfterSave=true;memoryError="";checkResult="";memoryRequest=App.rpc("settings.update",{memory:{model:embedding.text.trim()}})}
    function impactText(){
        if(!impact)return ""
        const next=impact.next||{},current=impact.current||{}
        if(impact.unchanged)return next.model+" uses the same embedding space as "+current.model+". Nothing needs re-embedding."
        return impact.artifacts+" stored memories. "+next.records+" already have vectors for "+next.model+" ("+next.dimension+" dimensions); "+impact.missing+" will be re-embedded in the background after switching. "
            +"Vectors from "+current.model+" are kept in their own space and never mixed with the new ones. Until a memory is re-embedded, recall finds it by keywords."
            +(current.error?" The current model could not be checked: "+current.error:"")
    }
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
                CButton {
                    objectName:"memoryCheck";text:knowledge.checkRequest>=0||knowledge.impactRequest>=0?"Checking…":"Check & save";enabled:knowledge.memoryRequest<0&&knowledge.checkRequest<0&&knowledge.impactRequest<0&&embedding.text.trim().length>0
                    onClicked:{
                        if(embedding.text.trim()===knowledge.memory.model){knowledge.saveEmbedding();return}
                        knowledge.impact=null;knowledge.impactError="";knowledge.checkResult="";knowledge.impactRequest=App.rpc("memory.embeddingImpact",{model:embedding.text.trim()})
                    }
                }
            }
            ColumnLayout {
                objectName:"embeddingImpact";visible:!!knowledge.impact||!!knowledge.impactError;Layout.fillWidth:true;spacing:6
                CText { objectName:"embeddingImpactText";Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.secondary;color:knowledge.impactError?Theme.danger:Theme.text;text:knowledge.impactError?"Could not check "+embedding.text.trim()+": "+knowledge.impactError:knowledge.impactText() }
                RowLayout {
                    Layout.fillWidth:true
                    CButton { objectName:"embeddingSwitch";Layout.fillWidth:true;primary:!knowledge.impactError;text:knowledge.impactError?"Save anyway":"Switch to "+embedding.text.trim();enabled:knowledge.memoryRequest<0;onClicked:knowledge.saveEmbedding() }
                    CButton { objectName:"embeddingKeep";Layout.fillWidth:true;text:"Keep "+knowledge.memory.model;onClicked:{embedding.text=knowledge.memory.model;knowledge.impact=null;knowledge.impactError=""} }
                }
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
            CText { visible:!!knowledge.checkResult;text:knowledge.checkResult;color:Theme.accentText;font.pixelSize:Theme.secondary }
            CText { visible:knowledge.status.state==="degraded";text:knowledge.status.error||"Semantic memory is unavailable. Keyword recall is still available.";color:Theme.amber;font.pixelSize:Theme.secondary }
        }
        CText { visible:!!knowledge.memoryError;text:knowledge.memoryError;color:Theme.danger;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"showMemoryCitations";text:"Show memory citations in replies";checked:App.state.settings?.showMemoryCitations===true;onClicked:App.rpc("settings.update",{showMemoryCitations:checked}) }
        CText { text:"Replies that draw on memory cite it as [evidence:…]. Off keeps those markers out of the conversation and out of copies, quotes and speech. Saved replies keep them, and Cere still records what each reply cited.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CButton { objectName:"manageMemories";text:"Manage project memory";enabled:App.connected&&!!App.session.id&&!App.session.temporary;onClicked:manager.open() }
        CText { text:App.session.id?"Review, correct or forget shared facts and conversation passages. Memory stays separate for each project and server.":"Select a conversation to manage its project’s memory.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Documents and notes"
        description:"Ground answers in your own files. Everything is read on this computer, and answers name the file they used."
        CButton { objectName:"manageCollections";text:"Document collections…";enabled:App.connected;onClicked:collections.openFor(App.session.id&&!App.session.temporary?App.session.id:"") }
        CText { text:"Index folders of text and Markdown files, then use a collection in one conversation, a project or everywhere.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CCheckBox { objectName:"notesVaultEnabled";text:"Use a Markdown notes folder";checked:knowledge.vault.enabled;enabled:knowledge.vaultRequest<0&&!!knowledge.vault.path;onClicked:knowledge.updateVault({enabled:checked},checked?"Notes are available to conversations.":"Notes are no longer available to conversations.") }
        RowLayout {
            Layout.fillWidth:true
            CText { objectName:"notesVaultPath";Layout.fillWidth:true;elide:Text.ElideMiddle;text:knowledge.vault.path||"No folder chosen";color:knowledge.vault.path?Theme.text:Theme.muted;font.pixelSize:Theme.secondary }
            CButton { objectName:"notesVaultChoose";text:knowledge.vault.path?"Change folder…":"Choose folder…";enabled:knowledge.vaultRequest<0;onClicked:{const path=App.chooseFolder();if(path)knowledge.updateVault({path:path,enabled:true},"Notes folder set.")} }
        }
        CCheckBox { objectName:"notesVaultCloud";visible:!!knowledge.vault.path;text:"Codex, Claude and cloud models may search and read notes";checked:knowledge.vault.allowCloud;enabled:knowledge.vaultRequest<0;onClicked:knowledge.updateVault({allowCloud:checked}) }
        CText { objectName:"notesVaultStatus";visible:knowledge.vault.enabled&&!!knowledge.vaultStatus;color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true
            text:knowledge.vaultStatus?knowledge.vaultStatus.notes+" readable notes · "+knowledge.vaultStatus.private+" private notes skipped"+(knowledge.vaultStatus.unreadable?" · "+knowledge.vaultStatus.unreadable+" notes skipped because their front matter could not be read":""):"" }
        CText { text:"Notes marked private: true, or whose privacy settings Cere cannot read, are never searched. Hidden folders and linked files are skipped. A model can only propose an edit: you review the exact change, it is refused if the note changed meanwhile, and the previous text is kept as a private backup.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout {
            visible:!!knowledge.vault.path;Layout.fillWidth:true
            CButton { text:"Recount notes";enabled:knowledge.vault.enabled&&knowledge.vaultStatusRequest<0;onClicked:knowledge.scanVault() }
            CButton { objectName:"notesVaultClearBackups";text:"Delete edit backups";enabled:knowledge.vaultRequest<0;onClicked:{knowledge.vaultError="";knowledge.vaultFeedback="Deleted the backups of earlier note edits.";knowledge.vaultRequest=App.rpc("notes.clearBackups",{})} }
        }
        CText { visible:!!knowledge.vaultError;text:knowledge.vaultError;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible:!!knowledge.vaultFeedback;text:knowledge.vaultFeedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    }
    MemoryDialog { id:manager }
    KnowledgeCollections { id:collections }
    Connections { target:App;function onResult(id,value){
        if(id===knowledge.webRequest){knowledge.webRequest=-1;if(value?.error)knowledge.webError=value.error}
        else if(id===knowledge.memoryRequest){knowledge.memoryRequest=-1;if(value?.error)knowledge.memoryError=value.error;else if(knowledge.checkAfterSave)knowledge.checkRequest=App.rpc("memory.check",{});knowledge.checkAfterSave=false}
        else if(id===knowledge.extractionRequest){knowledge.extractionRequest=-1;if(value?.error)knowledge.memoryError=value.error;extraction.currentIndex=Qt.binding(()=>knowledge.extractionIndex)}
        else if(id===knowledge.extractionRefreshRequest){knowledge.extractionRefreshRequest=-1;if(value?.error)knowledge.memoryError=value.error}
        else if(id===knowledge.checkRequest){knowledge.checkRequest=-1;if(value?.error)knowledge.memoryError=value.error;else knowledge.checkResult="Ready · "+value.model}
        else if(id===knowledge.impactRequest){knowledge.impactRequest=-1;if(value?.error)knowledge.impactError=String(value.error);else knowledge.impact=value}
        else if(id===knowledge.vaultRequest){knowledge.vaultRequest=-1;if(value?.error){knowledge.vaultError=String(value.error);knowledge.vaultFeedback=""}else if(value?.notesVault?.enabled)knowledge.vaultStatusRequest=App.rpc("notes.status",{});else if(value?.notesVault)knowledge.vaultStatus=null}
        else if(id===knowledge.vaultStatusRequest){knowledge.vaultStatusRequest=-1;if(value?.error)knowledge.vaultError=String(value.error);else knowledge.vaultStatus=value}
    } }
}
