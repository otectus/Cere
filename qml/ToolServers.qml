import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A02: outbound MCP tool servers. Their tools reach only tool-enabled Ollama and API conversations on this
// desktop, every call asks first unless the user allowed that tool, and a server's own hints grant nothing.
ColumnLayout {
    id:servers
    Layout.fillWidth:true;spacing:10
    // Rows are rebuilt only when their content changes, not on every state snapshot, so a click or a
    // half-typed secret is never lost to an unrelated update.
    readonly property string configsKey:JSON.stringify(App.state.settings?.extensions||[])
    readonly property string statusesKey:JSON.stringify(App.state.extensions||[])
    property var configs:JSON.parse(configsKey)
    property var statuses:JSON.parse(statusesKey)
    onConfigsKeyChanged:configs=JSON.parse(configsKey)
    onStatusesKeyChanged:statuses=JSON.parse(statusesKey)
    property int request:-1
    property string error:""
    property string feedback:""
    readonly property var stateNames:({stopped:"Not running · starts when a conversation needs it",starting:"Starting…",ready:"Running",failed:"Stopped unexpectedly · starts again on next use",quarantined:"Paused after repeated failures"})
    function status(id){return statuses.find(item=>item.id===id)||({state:"stopped",tools:[],secrets:[],error:""})}
    function save(list,done){error="";feedback=done||"";request=App.rpc("settings.update",{extensions:list})}
    function replace(id,patch){save(configs.map(item=>item.id===id?Object.assign({},item,patch):item))}
    function lines(text){return String(text||"").split("\n").map(item=>item.trim()).filter(item=>item.length>0)}
    CText { text:"Programs or HTTP addresses that offer tools, resources and prompts over the Model Context Protocol. Cere starts a program, or connects to an address, when a conversation with desktop tools turned on needs it, and gives it only the secrets you set here. Codex and Claude Code keep their own MCP settings.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Repeater {
        model:servers.configs
        Rectangle {
            id:card
            required property var modelData
            required property int index
            readonly property var live:servers.status(modelData.id)
            Layout.fillWidth:true;implicitHeight:cardColumn.implicitHeight+24;radius:Theme.radiusControl;color:Theme.raised;border.color:Theme.border
            ColumnLayout {
                id:cardColumn;anchors.fill:parent;anchors.margins:12;spacing:8
                RowLayout {
                    Layout.fillWidth:true
                    CText { objectName:"toolServerName_"+card.index;Layout.fillWidth:true;text:card.modelData.name;font.weight:Font.DemiBold;elide:Text.ElideRight }
                    CCheckBox { objectName:"toolServerEnabled_"+card.index;text:"On";checked:card.modelData.enabled;enabled:servers.request<0;onToggled:servers.replace(card.modelData.id,{enabled:checked}) }
                }
                CText { Layout.fillWidth:true;elide:Text.ElideMiddle;color:Theme.muted;font.pixelSize:Theme.caption
                    text:card.modelData.transport==="http"?card.modelData.url+" · "+(card.modelData.network==="local"?"this computer or your network":"internet"):card.modelData.command+" "+card.modelData.args.join(" ") }
                CText { visible:card.live.state==="ready"&&card.live.discovered>0;Layout.fillWidth:true;color:Theme.muted;font.pixelSize:Theme.caption
                    text:"Listed "+new Date(card.live.discovered).toLocaleTimeString(Qt.locale(),Locale.ShortFormat)+" · MCP "+(card.live.protocol||"?")+" · "+[card.live.offers?.tools?card.live.tools.length+" tools":"",card.live.offers?.resources?"resources":"",card.live.offers?.prompts?"prompts":""].filter(s=>s).join(", ") }
                CText {
                    objectName:"toolServerState_"+card.index;Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.secondary
                    color:card.live.state==="ready"?Theme.accentText:card.live.state==="failed"||card.live.state==="quarantined"?Theme.amber:Theme.muted
                    text:(card.modelData.enabled?(servers.stateNames[card.live.state]||card.live.state):"Off")+(card.modelData.projects.length?" · only in "+card.modelData.projects.length+(card.modelData.projects.length===1?" project":" projects"):" · every project")
                }
                CText { visible:!!card.live.error;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.danger;font.pixelSize:Theme.caption;text:card.live.error }
                Repeater {
                    model:card.live.secrets
                    RowLayout {
                        required property var modelData
                        Layout.fillWidth:true
                        CText { text:modelData.name+(modelData.set?" · set":" · not set");Layout.preferredWidth:180;font.pixelSize:Theme.secondary;color:modelData.set?Theme.text:Theme.amber }
                        CField { id:secretValue;Layout.fillWidth:true;echoMode:TextInput.Password;placeholderText:modelData.set?"Leave empty to keep":"Value";Accessible.description:"Secret value for "+modelData.name }
                        CButton { text:"Save";enabled:secretValue.text.length>0;onClicked:{servers.error="";App.rpc("extensions.secret",{id:card.modelData.id,name:modelData.name,value:secretValue.text});secretValue.clear()} }
                    }
                }
                CText { visible:card.live.tools.length>0;text:"Tools · run without asking only those you trust";font.weight:Font.DemiBold;font.pixelSize:Theme.secondary }
                Repeater {
                    model:card.live.tools
                    ColumnLayout {
                        required property var modelData
                        required property int index
                        Layout.fillWidth:true;spacing:2
                        CCheckBox {
                            objectName:"toolServerAllow_"+card.index+"_"+modelData.name;enabled:modelData.usable&&servers.request<0
                            text:modelData.title+(modelData.usable?"":" · unusable: "+modelData.problem)
                            checked:card.modelData.allowed.indexOf(modelData.name)>=0
                            onToggled:servers.replace(card.modelData.id,{allowed:checked?card.modelData.allowed.concat([modelData.name]):card.modelData.allowed.filter(name=>name!==modelData.name)})
                        }
                        // RC-13: a hidden tool is neither offered to models nor callable.
                        CCheckBox {
                            objectName:"toolServerHide_"+card.index+"_"+modelData.name;enabled:servers.request<0;Layout.leftMargin:28
                            text:"Hide from models";checked:(card.modelData.hidden||[]).indexOf(modelData.name)>=0
                            onToggled:servers.replace(card.modelData.id,{hidden:checked?(card.modelData.hidden||[]).concat([modelData.name]):(card.modelData.hidden||[]).filter(name=>name!==modelData.name)})
                        }
                        CText {
                            visible:!!modelData.description||modelData.readOnlyHint||modelData.destructiveHint;Layout.fillWidth:true;Layout.leftMargin:28;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.caption
                            text:modelData.description+(modelData.readOnlyHint?" The server says this tool only reads; Cere has not verified that.":"")+(modelData.destructiveHint?" The server says this tool can change or delete things.":"")
                        }
                    }
                }
                Flow {
                    Layout.fillWidth:true;spacing:8
                    CButton { objectName:"toolServerStart_"+card.index;text:card.live.state==="ready"?"Restart":"Start and list tools";enabled:card.modelData.enabled&&servers.request<0;onClicked:{servers.error="";servers.feedback="";servers.request=App.rpc("extensions.restart",{id:card.modelData.id})} }
                    CButton { objectName:"toolServerResources_"+card.index;visible:card.live.state==="ready"&&!!card.live.offers?.resources;text:"Resources…";onClicked:resourcesDialog.openFor(card.modelData) }
                    CButton { objectName:"toolServerPrompts_"+card.index;visible:card.live.state==="ready"&&!!card.live.offers?.prompts;text:"Prompts…";onClicked:promptsDialog.openFor(card.modelData) }
                    CButton { text:"Edit…";enabled:servers.request<0;onClicked:editor.openFor(card.modelData) }
                    CButton { text:"Remove";danger:true;enabled:servers.request<0;onClicked:servers.save(servers.configs.filter(item=>item.id!==card.modelData.id),"Removed the tool server and its secrets.") }
                }
            }
        }
    }
    CButton { objectName:"addToolServer";text:"Add a tool server…";enabled:App.connected&&servers.configs.length<8;onClicked:editor.openFor(null) }
    CText { objectName:"toolServersError";visible:!!servers.error;text:servers.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:!!servers.feedback;text:servers.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CDialog {
        id:editor;objectName:"toolServerEditor"
        property var existing:null
        property bool http:transportBox.currentIndex===1
        function openFor(server){existing=server;transportBox.currentIndex=server?.transport==="http"?1:0;url.text=server?.url||"";networkBox.currentIndex=server?.network==="local"?1:0;bearer.checked=(server?.secrets||[]).indexOf("BEARER_TOKEN")>=0;name.text=server?.name||"";command.text=server?.command||"";args.text=(server?.args||[]).join("\n");cwd.text=server?.cwd||"";projects.text=(server?.projects||[]).join("\n");secrets.text=(server?.secrets||[]).join("\n");timeout.text=String(server?.timeoutSeconds||60);enabledBox.checked=server?server.enabled:false;open()}
        CText { text:editor.existing?"Edit tool server":"Add a tool server";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CComboBox { id:transportBox;objectName:"toolServerFormTransport";Layout.fillWidth:true;model:["A program on this computer (stdio)","An HTTP address (Streamable HTTP)"];Accessible.name:"How Cere reaches the tool server" }
        CText { text:editor.http?"Cere connects to the address only when needed. Its BEARER_TOKEN secret, if you add one, is sent to that address only, never to another site or across a redirect. Servers that need an OAuth sign-in are not supported yet.":"Cere runs the program directly, without a shell, in the working folder. It receives PATH, HOME, LANG and the secrets you name, nothing else from your environment.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CField { id:name;objectName:"toolServerFormName";Layout.fillWidth:true;placeholderText:"Name, such as GitHub";maximumLength:40;Accessible.name:"Tool server name" }
        CField { id:url;objectName:"toolServerFormUrl";visible:editor.http;Layout.fillWidth:true;placeholderText:"Address, such as https://example.com/mcp";Accessible.name:"Tool server address" }
        CComboBox { id:networkBox;objectName:"toolServerFormNetwork";visible:editor.http;Layout.fillWidth:true;model:["On the internet (HTTPS, public addresses only)","On this computer or my own network"];Accessible.name:"Where the server is" }
        CCheckBox { id:bearer;objectName:"toolServerFormBearer";visible:editor.http;text:"It needs a bearer token (set it after saving)" }
        RowLayout {
            Layout.fillWidth:true;visible:!editor.http
            CField { id:command;objectName:"toolServerFormCommand";Layout.fillWidth:true;placeholderText:"Program, such as /usr/bin/node";Accessible.name:"Tool server program" }
            CButton { text:"Browse";onClicked:{const path=App.chooseFile();if(path)command.text=path} }
        }
        CTextArea { id:args;objectName:"toolServerFormArgs";visible:!editor.http;Layout.fillWidth:true;Layout.preferredHeight:70;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"Arguments, one per line";Accessible.name:"Tool server arguments" }
        RowLayout {
            Layout.fillWidth:true;visible:!editor.http
            CField { id:cwd;objectName:"toolServerFormCwd";Layout.fillWidth:true;placeholderText:"Working folder";Accessible.name:"Tool server working folder" }
            CButton { text:"Browse";onClicked:{const path=App.chooseFolder();if(path)cwd.text=path} }
        }
        CTextArea { id:projects;objectName:"toolServerFormProjects";Layout.fillWidth:true;Layout.preferredHeight:56;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"Only in these project folders, one per line (empty: every project)";Accessible.name:"Tool server project folders" }
        CTextArea { id:secrets;objectName:"toolServerFormSecrets";visible:!editor.http;Layout.fillWidth:true;Layout.preferredHeight:56;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"Secret variable names, one per line, such as GITHUB_TOKEN";Accessible.name:"Tool server secret variable names" }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Call time limit (seconds)";font.pixelSize:Theme.secondary }
            CField { id:timeout;objectName:"toolServerFormTimeout";Layout.preferredWidth:90;Accessible.name:"Call time limit in seconds" }
            Item { Layout.fillWidth:true }
            CCheckBox { id:enabledBox;objectName:"toolServerFormEnabled";text:"On" }
        }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;onClicked:editor.close() }
            CButton {
                objectName:"toolServerFormSave";text:"Save";primary:true;Layout.fillWidth:true;enabled:servers.request<0&&name.text.trim().length>0&&(editor.http?url.text.trim().length>0:command.text.trim().length>0&&cwd.text.trim().length>0)
                onClicked:{
                    const common={name:name.text.trim(),projects:servers.lines(projects.text),timeoutSeconds:Number(timeout.text)||60,enabled:enabledBox.checked,allowed:editor.existing?.allowed||[],hidden:editor.existing?.hidden||[]}
                    const value=editor.http?Object.assign(common,{transport:"http",url:url.text.trim(),network:networkBox.currentIndex===1?"local":"public",secrets:bearer.checked?["BEARER_TOKEN"]:[]})
                        :Object.assign(common,{command:command.text.trim(),args:servers.lines(args.text),cwd:cwd.text.trim(),secrets:servers.lines(secrets.text)})
                    if(editor.existing){value.id=editor.existing.id;servers.save(servers.configs.map(item=>item.id===value.id?value:item),"Saved.")}
                    else servers.save(servers.configs.concat([value]),"Added. Start it to see its tools.")
                }
            }
        }
    }
    RpcClient { id:serverRpc }
    // Resources are browsed and read only when the person asks; nothing here reaches a model by itself.
    CDialog {
        id:resourcesDialog;objectName:"toolServerResourcesDialog"
        property var server:null
        property var items:[]
        property var reading:null
        property string message:""
        function openFor(target){server=target;items=[];reading=null;message="Loading…";open();serverRpc.call("extensions.resources",{id:target.id},value=>{if(value.error){message=value.error;return}items=value.resources||[];message=items.length?"":"This server lists no resources."})}
        CText { text:"Resources from "+(resourcesDialog.server?.name||"");font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { visible:!!resourcesDialog.message;text:resourcesDialog.message;color:Theme.muted;font.pixelSize:Theme.secondary;Layout.fillWidth:true }
        ListView {
            id:resourceList;Layout.fillWidth:true;Layout.preferredHeight:Math.min(contentHeight,220);clip:true;model:resourcesDialog.items;spacing:2
            delegate:CButton {
                required property var modelData;required property int index
                objectName:"toolServerResource_"+index;width:resourceList.width;quiet:true;alignLeft:true;implicitHeight:36
                text:(modelData.title||modelData.name)+(modelData.mimeType?" · "+modelData.mimeType:"");help:modelData.uri+(modelData.description?"\n"+modelData.description:"")
                onClicked:serverRpc.call("extensions.resource",{id:resourcesDialog.server.id,uri:modelData.uri},value=>{resourcesDialog.reading=value.error?{error:value.error}:Object.assign({uri:modelData.uri},value)})
            }
        }
        CTextArea {
            objectName:"toolServerResourceText";visible:!!resourcesDialog.reading;readOnly:true;Layout.fillWidth:true;Layout.preferredHeight:160;wrapMode:TextEdit.Wrap;textFormat:TextEdit.PlainText
            text:!resourcesDialog.reading?"":resourcesDialog.reading.error||(resourcesDialog.reading.contents||[]).map(c=>c.text!==undefined?c.text+(c.truncated?"\n[shortened]":""):"["+(c.mimeType||"binary")+", "+(c.binaryBytes||0)+" bytes]").join("\n\n")
        }
        RowLayout {
            Layout.fillWidth:true
            CButton { objectName:"toolServerResourceKeep";visible:!!resourcesDialog.reading&&!resourcesDialog.reading.error&&["ollama","openai","anthropic","google","compatible"].includes(App.session.provider||"")&&!App.session.temporary
                text:"Keep in this conversation";onClicked:serverRpc.call("extensions.resource",{id:resourcesDialog.server.id,uri:resourcesDialog.reading.uri,sessionId:App.selectedId},value=>resourcesDialog.message=value.error?value.error:"Kept "+(value.kept||[]).map(k=>k.name).join(", ")+" in the conversation’s files.") }
            Item { Layout.fillWidth:true }
            CButton { text:"Close";onClicked:resourcesDialog.close() }
        }
    }
    // A prompt template is filled in by the server and lands in the composer for the person to review.
    CDialog {
        id:promptsDialog;objectName:"toolServerPromptsDialog"
        property var server:null
        property var items:[]
        property int chosen:-1
        property var values:({})
        property string result:""
        property string message:""
        function openFor(target){server=target;items=[];chosen=-1;values={};result="";message="Loading…";open();serverRpc.call("extensions.prompts",{id:target.id},value=>{if(value.error){message=value.error;return}items=value.prompts||[];message=items.length?"":"This server offers no prompts."})}
        CText { text:"Prompts from "+(promptsDialog.server?.name||"");font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { visible:!!promptsDialog.message;text:promptsDialog.message;color:Theme.muted;font.pixelSize:Theme.secondary;Layout.fillWidth:true }
        CComboBox { objectName:"toolServerPromptChoice";visible:promptsDialog.items.length>0;Layout.fillWidth:true;model:["Choose a prompt…"].concat(promptsDialog.items.map(p=>p.title||p.name))
            onActivated:index=>{promptsDialog.chosen=index-1;promptsDialog.values={};promptsDialog.result=""} }
        CText { visible:promptsDialog.chosen>=0&&!!promptsDialog.items[promptsDialog.chosen]?.description;text:promptsDialog.items[promptsDialog.chosen]?.description||"";color:Theme.muted;font.pixelSize:Theme.caption;Layout.fillWidth:true }
        Repeater {
            model:promptsDialog.chosen>=0?promptsDialog.items[promptsDialog.chosen].arguments:[]
            CField { required property var modelData;Layout.fillWidth:true;placeholderText:modelData.name+(modelData.required?" (required)":"")+(modelData.description?" · "+modelData.description:"");Accessible.name:modelData.name
                onTextChanged:{const next=Object.assign({},promptsDialog.values);next[modelData.name]=text;promptsDialog.values=next} }
        }
        CTextArea { objectName:"toolServerPromptText";visible:!!promptsDialog.result;readOnly:true;Layout.fillWidth:true;Layout.preferredHeight:120;wrapMode:TextEdit.Wrap;textFormat:TextEdit.PlainText;text:promptsDialog.result }
        RowLayout {
            Layout.fillWidth:true
            CButton { objectName:"toolServerPromptGet";visible:promptsDialog.chosen>=0;text:"Fill in";enabled:(promptsDialog.items[promptsDialog.chosen]?.arguments||[]).every(a=>!a.required||!!(promptsDialog.values[a.name]||"").trim())
                onClicked:serverRpc.call("extensions.prompt",{id:promptsDialog.server.id,name:promptsDialog.items[promptsDialog.chosen].name,arguments:promptsDialog.values},value=>{if(value.error)promptsDialog.message=value.error;else{promptsDialog.message="";promptsDialog.result=value.text}}) }
            CButton { objectName:"toolServerPromptUse";visible:!!promptsDialog.result&&!!App.selectedId;text:"Put in the message box";onClicked:{WorkbenchState.insertIntoComposer(App.selectedId,promptsDialog.result);promptsDialog.close()} }
            CButton { visible:!!promptsDialog.result;text:"Copy";onClicked:App.copy(promptsDialog.result) }
            Item { Layout.fillWidth:true }
            CButton { text:"Close";onClicked:promptsDialog.close() }
        }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==servers.request)return
            servers.request=-1
            if(value?.error){servers.error=String(value.error);servers.feedback="";return}
            editor.close()
        }
    }
}
