import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M23: declarative HTTP and command tools. The model fills only the slots a template names; the
// address, headers, program and credential stay as written here. Every call asks first unless allowed.
ColumnLayout {
    id:tools
    Layout.fillWidth:true;spacing:10
    readonly property string configsKey:JSON.stringify(App.state.settings?.customTools||[])
    readonly property string statusKey:JSON.stringify(App.state.customTools||[])
    property var configs:JSON.parse(configsKey)
    property var statuses:JSON.parse(statusKey)
    onConfigsKeyChanged:configs=JSON.parse(configsKey)
    onStatusKeyChanged:statuses=JSON.parse(statusKey)
    property int request:-1
    property string error:""
    property string feedback:""
    function status(id){return statuses.find(item=>item.id===id)||({credential:"none",credentialSet:false})}
    function save(list,done){error="";feedback=done||"";request=App.rpc("settings.update",{customTools:list})}
    function replace(id,patch){save(configs.map(item=>item.id===id?Object.assign({},item,patch):item))}
    function lines(text){return String(text||"").split("\n").map(item=>item.trim()).filter(item=>item.length>0)}
    function summary(tool){return tool.kind==="http"?tool.http.method+" "+tool.http.url:tool.command.executable+" "+tool.command.args.join(" ")}
    CText { text:"The model can only fill the {slots} you write; the address, headers, program and key stay as written. Values are encoded into the address or passed as single arguments, never through a shell.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Repeater {
        model:tools.configs
        Rectangle {
            id:card
            required property var modelData
            required property int index
            readonly property var live:tools.status(modelData.id)
            Layout.fillWidth:true;implicitHeight:cardColumn.implicitHeight+24;radius:Theme.radiusControl;color:Theme.raised;border.color:Theme.border
            ColumnLayout {
                id:cardColumn;anchors.fill:parent;anchors.margins:12;spacing:6
                RowLayout {
                    Layout.fillWidth:true
                    CText { objectName:"customToolName_"+card.index;Layout.fillWidth:true;text:card.modelData.name;font.weight:Font.DemiBold;elide:Text.ElideRight }
                    CCheckBox { objectName:"customToolEnabled_"+card.index;text:"On";checked:card.modelData.enabled;enabled:tools.request<0;onToggled:tools.replace(card.modelData.id,{enabled:checked}) }
                }
                CText { objectName:"customToolSummary_"+card.index;Layout.fillWidth:true;elide:Text.ElideMiddle;color:Theme.muted;font.pixelSize:Theme.caption;text:tools.summary(card.modelData) }
                CCheckBox { objectName:"customToolAllowed_"+card.index;text:"Run without asking";checked:card.modelData.allowed;enabled:tools.request<0;onToggled:tools.replace(card.modelData.id,{allowed:checked}) }
                RowLayout {
                    visible:card.live.credential!=="none";Layout.fillWidth:true
                    CText { text:card.live.credentialSet?"Key saved for this address":"Key not set";color:card.live.credentialSet?Theme.text:Theme.amber;font.pixelSize:Theme.secondary;Layout.preferredWidth:180 }
                    CField { id:credential;objectName:"customToolCredential_"+card.index;Layout.fillWidth:true;echoMode:TextInput.Password;placeholderText:card.live.credentialSet?"Leave empty to keep":"Key";Accessible.description:"Key for "+card.modelData.name }
                    CButton { text:"Save";enabled:credential.text.length>0;onClicked:{App.rpc("customTools.credential",{id:card.modelData.id,value:credential.text});credential.clear()} }
                }
                Flow {
                    Layout.fillWidth:true;spacing:8
                    CButton { text:"Edit…";enabled:tools.request<0;onClicked:editor.openFor(card.modelData) }
                    CButton { text:"Remove";danger:true;enabled:tools.request<0;onClicked:tools.save(tools.configs.filter(item=>item.id!==card.modelData.id),"Removed the tool and its key.") }
                }
            }
        }
    }
    CButton { objectName:"addCustomTool";text:"Add a custom tool…";enabled:App.connected&&tools.configs.length<20;onClicked:editor.openFor(null) }
    CText { objectName:"customToolsError";visible:!!tools.error;text:tools.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:!!tools.feedback;text:tools.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CDialog {
        id:editor;objectName:"customToolEditor"
        width:Math.min(640,parent?parent.width-32:640)
        property var existing:null
        readonly property bool isHttp:kind.currentIndex===0
        readonly property var methods:["GET","POST","PUT","PATCH","DELETE"]
        function openFor(tool){
            existing=tool;name.text=tool?.name||"";description.text=tool?.description||"";kind.currentIndex=tool?.kind==="command"?1:0
            inputs.text=(tool?.inputs||[]).map(input=>[input.name,input.type,input.required?"required":"optional",input.description||""].join(" | ")).join("\n")
            method.currentIndex=Math.max(0,methods.indexOf(tool?.http?.method||"GET"));url.text=tool?.http?.url||"";headers.text=Object.entries(tool?.http?.headers||{}).map(([key,value])=>key+": "+value).join("\n")
            body.currentIndex=tool?.http?.body==="json"?1:0;credentialKind.currentIndex=Math.max(0,["none","bearer","header"].indexOf(tool?.http?.credential||"none"));credentialHeader.text=tool?.http?.credentialHeader||"";allowPrivate.checked=tool?.http?.allowPrivate===true
            program.text=tool?.command?.executable||"";args.text=(tool?.command?.args||[]).join("\n");cwd.text=tool?.command?.cwd||"";timeout.text=String(tool?.timeoutSeconds||30);enabledBox.checked=tool?tool.enabled:false
            open()
        }
        function parsedInputs(){
            return tools.lines(inputs.text).map(line=>{const parts=line.split("|").map(part=>part.trim());return {name:parts[0]||"",type:parts[1]||"string",required:(parts[2]||"").toLowerCase()==="required",description:parts.slice(3).join(" | ")}})
        }
        function value(){
            const tool={name:name.text.trim(),description:description.text.trim(),kind:isHttp?"http":"command",enabled:enabledBox.checked,allowed:existing?.allowed===true,timeoutSeconds:Number(timeout.text)||30,inputs:parsedInputs()}
            if(isHttp){
                const headerMap={};for(const line of tools.lines(headers.text)){const at=line.indexOf(":");if(at>0)headerMap[line.slice(0,at).trim()]=line.slice(at+1).trim()}
                tool.http={method:methods[method.currentIndex],url:url.text.trim(),headers:headerMap,body:body.currentIndex===1?"json":"none",credential:["none","bearer","header"][credentialKind.currentIndex],credentialHeader:credentialHeader.text.trim(),allowPrivate:allowPrivate.checked}
            } else tool.command={executable:program.text.trim(),args:tools.lines(args.text),cwd:cwd.text.trim()}
            if(existing)tool.id=existing.id
            return tool
        }
        CText { text:editor.existing?"Edit custom tool":"Add a custom tool";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CField { id:name;objectName:"customToolFormName";Layout.fillWidth:true;placeholderText:"Name, such as create_issue";maximumLength:40;Accessible.name:"Custom tool name" }
        CField { id:description;objectName:"customToolFormDescription";Layout.fillWidth:true;placeholderText:"What it does, for the model";maximumLength:1000;Accessible.name:"Custom tool description" }
        CComboBox { id:kind;objectName:"customToolFormKind";Layout.fillWidth:true;model:["HTTP request","Command"];Accessible.name:"Custom tool kind" }
        CText { text:"Inputs · one per line: name | type | required or optional | description. Types: string, number, integer, boolean.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CTextArea { id:inputs;objectName:"customToolFormInputs";Layout.fillWidth:true;Layout.preferredHeight:70;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"title | string | required | Issue title";Accessible.name:"Custom tool inputs" }
        ColumnLayout {
            visible:editor.isHttp;Layout.fillWidth:true;spacing:8
            RowLayout {
                Layout.fillWidth:true
                CComboBox { id:method;objectName:"customToolFormMethod";Layout.preferredWidth:110;model:editor.methods;Accessible.name:"HTTP method" }
                CField { id:url;objectName:"customToolFormUrl";Layout.fillWidth:true;placeholderText:"https://api.example.com/items/{id}?q={query}";Accessible.name:"Request address with slots" }
            }
            CTextArea { id:headers;objectName:"customToolFormHeaders";Layout.fillWidth:true;Layout.preferredHeight:50;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"Fixed headers, one per line: Accept: application/json";Accessible.name:"Fixed request headers" }
            RowLayout {
                Layout.fillWidth:true
                CComboBox { id:body;objectName:"customToolFormBody";Layout.fillWidth:true;model:["No body","JSON body with the other inputs"];Accessible.name:"Request body" }
                CComboBox { id:credentialKind;objectName:"customToolFormCredential";Layout.fillWidth:true;model:["No key","Bearer key","Key in a header"];Accessible.name:"Credential" }
            }
            CField { id:credentialHeader;visible:credentialKind.currentIndex===2;Layout.fillWidth:true;placeholderText:"Header that carries the key, such as X-Api-Key";Accessible.name:"Credential header" }
            CCheckBox { id:allowPrivate;objectName:"customToolFormPrivate";text:"Allow this computer and local network addresses" }
        }
        ColumnLayout {
            visible:!editor.isHttp;Layout.fillWidth:true;spacing:8
            RowLayout {
                Layout.fillWidth:true
                CField { id:program;objectName:"customToolFormProgram";Layout.fillWidth:true;placeholderText:"Program, such as /usr/bin/rg";Accessible.name:"Program" }
                CButton { text:"Browse";onClicked:{const path=App.chooseFile();if(path)program.text=path} }
            }
            CTextArea { id:args;objectName:"customToolFormArgs";Layout.fillWidth:true;Layout.preferredHeight:60;wrapMode:TextEdit.NoWrap;textFormat:TextEdit.PlainText;placeholderText:"Arguments, one per line, such as --max-count=20 and {pattern}";Accessible.name:"Program arguments" }
            RowLayout {
                Layout.fillWidth:true
                CField { id:cwd;objectName:"customToolFormCwd";Layout.fillWidth:true;placeholderText:"Working folder";Accessible.name:"Working folder" }
                CButton { text:"Browse";onClicked:{const path=App.chooseFolder();if(path)cwd.text=path} }
            }
        }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Time limit (seconds)";font.pixelSize:Theme.secondary }
            CField { id:timeout;objectName:"customToolFormTimeout";Layout.preferredWidth:80;Accessible.name:"Time limit in seconds" }
            Item { Layout.fillWidth:true }
            CCheckBox { id:enabledBox;objectName:"customToolFormEnabled";text:"On" }
        }
        CText { objectName:"customToolPreview";Layout.fillWidth:true;wrapMode:Text.Wrap;font.family:"monospace";font.pixelSize:Theme.caption;color:Theme.muted;text:"Runs as: "+(editor.isHttp?editor.methods[method.currentIndex]+" "+url.text:program.text+" "+tools.lines(args.text).join(" ")) }
        CText { visible:!!tools.error&&editor.opened;text:tools.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;onClicked:editor.close() }
            CButton {
                objectName:"customToolFormSave";text:"Save";primary:true;Layout.fillWidth:true;enabled:tools.request<0&&name.text.trim().length>0&&description.text.trim().length>0
                onClicked:{const value=editor.value();if(editor.existing)tools.save(tools.configs.map(item=>item.id===value.id?value:item),"Saved.");else tools.save(tools.configs.concat([value]),"Added.")}
            }
        }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==tools.request)return
            tools.request=-1
            if(value?.error){tools.error=String(value.error);tools.feedback="";return}
            tools.error="";editor.close()
        }
    }
}
