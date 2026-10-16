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
    CText { text:"Programs that offer tools over the Model Context Protocol. Cere starts one when a conversation with desktop tools turned on needs it and gives it only the secrets you set here. Codex and Claude Code keep their own MCP settings.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
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
                CText { Layout.fillWidth:true;elide:Text.ElideMiddle;color:Theme.muted;font.pixelSize:Theme.caption;text:card.modelData.command+" "+card.modelData.args.join(" ") }
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
                        CText {
                            visible:!!modelData.description||modelData.readOnlyHint||modelData.destructiveHint;Layout.fillWidth:true;Layout.leftMargin:28;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.caption
                            text:modelData.description+(modelData.readOnlyHint?" The server says this tool only reads; Cere has not verified that.":"")+(modelData.destructiveHint?" The server says this tool can change or delete things.":"")
                        }
                    }
                }
                Flow {
                    Layout.fillWidth:true;spacing:8
                    CButton { objectName:"toolServerStart_"+card.index;text:card.live.state==="ready"?"Restart":"Start and list tools";enabled:card.modelData.enabled&&servers.request<0;onClicked:{servers.error="";servers.feedback="";servers.request=App.rpc("extensions.restart",{id:card.modelData.id})} }
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
        function openFor(server){existing=server;name.text=server?.name||"";command.text=server?.command||"";args.text=(server?.args||[]).join("\n");cwd.text=server?.cwd||"";projects.text=(server?.projects||[]).join("\n");secrets.text=(server?.secrets||[]).join("\n");timeout.text=String(server?.timeoutSeconds||60);enabledBox.checked=server?server.enabled:false;open()}
        CText { text:editor.existing?"Edit tool server":"Add a tool server";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Cere runs the program directly, without a shell, in the working folder. It receives PATH, HOME, LANG and the secrets you name, nothing else from your environment.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CField { id:name;objectName:"toolServerFormName";Layout.fillWidth:true;placeholderText:"Name, such as GitHub";maximumLength:40;Accessible.name:"Tool server name" }
        RowLayout {
            Layout.fillWidth:true
            CField { id:command;objectName:"toolServerFormCommand";Layout.fillWidth:true;placeholderText:"Program, such as /usr/bin/node";Accessible.name:"Tool server program" }
            CButton { text:"Browse";onClicked:{const path=App.chooseFile();if(path)command.text=path} }
        }
        CTextArea { id:args;objectName:"toolServerFormArgs";Layout.fillWidth:true;Layout.preferredHeight:70;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"Arguments, one per line";Accessible.name:"Tool server arguments" }
        RowLayout {
            Layout.fillWidth:true
            CField { id:cwd;objectName:"toolServerFormCwd";Layout.fillWidth:true;placeholderText:"Working folder";Accessible.name:"Tool server working folder" }
            CButton { text:"Browse";onClicked:{const path=App.chooseFolder();if(path)cwd.text=path} }
        }
        CTextArea { id:projects;objectName:"toolServerFormProjects";Layout.fillWidth:true;Layout.preferredHeight:56;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"Only in these project folders, one per line (empty: every project)";Accessible.name:"Tool server project folders" }
        CTextArea { id:secrets;objectName:"toolServerFormSecrets";Layout.fillWidth:true;Layout.preferredHeight:56;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"Secret variable names, one per line, such as GITHUB_TOKEN";Accessible.name:"Tool server secret variable names" }
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
                objectName:"toolServerFormSave";text:"Save";primary:true;Layout.fillWidth:true;enabled:servers.request<0&&name.text.trim().length>0&&command.text.trim().length>0&&cwd.text.trim().length>0
                onClicked:{
                    const value={name:name.text.trim(),command:command.text.trim(),args:servers.lines(args.text),cwd:cwd.text.trim(),projects:servers.lines(projects.text),secrets:servers.lines(secrets.text),timeoutSeconds:Number(timeout.text)||60,enabled:enabledBox.checked,allowed:editor.existing?.allowed||[]}
                    if(editor.existing){value.id=editor.existing.id;servers.save(servers.configs.map(item=>item.id===value.id?value:item),"Saved.")}
                    else servers.save(servers.configs.concat([value]),"Added. Start it to see its tools.")
                }
            }
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
