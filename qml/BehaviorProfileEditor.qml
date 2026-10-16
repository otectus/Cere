import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M01/M02: a saved style's details. Traits are neutral unless moved; tool limits can only withhold;
// formatting checks annotate replies and never change them; checkpoints are immutable.
CDialog {
    id:editor;objectName:"behaviorProfileEditor"
    width:Math.min(640,parent?parent.width-32:640)
    property var profile:({})
    property int request:-1
    property int previewRequest:-1
    property string action:""
    property string error:""
    property string feedback:""
    property string previewText:""
    readonly property var traitRows:[
        {key:"verbosity",label:"Length",low:"Shorter",high:"Longer"},
        {key:"formality",label:"Register",low:"Casual",high:"Formal"},
        {key:"warmth",label:"Warmth",low:"Reserved",high:"Warm"},
        {key:"humor",label:"Humor",low:"None",high:"Playful"},
        {key:"directness",label:"Directness",low:"Diplomatic",high:"Blunt"}]
    property var traits:({})
    signal profileSaved()
    function load(value){profile=value||({});traits=Object.assign({},profile.traits||{});instructions.text=profile.instructions||"";posture.checked=profile.posture===true
        desktop.checked=profile.ceiling?.desktop===false;delegation.checked=profile.ceiling?.delegation===false;web.checked=profile.ceiling?.web===false;memory.checked=profile.ceiling?.memory===false;extensions.checked=profile.ceiling?.extensions===false
        const checks=profile.constraints||[];noEmoji.checked=checks.indexOf("no-emoji")>=0;noDash.checked=checks.indexOf("no-em-dash")>=0;noTable.checked=checks.indexOf("no-markdown-table")>=0
        error="";feedback="";previewText=""}
    function ceiling(){const c={};if(desktop.checked)c.desktop=false;if(delegation.checked)c.delegation=false;if(web.checked)c.web=false;if(memory.checked)c.memory=false;if(extensions.checked)c.extensions=false;return c}
    function constraints(){return [noEmoji.checked?"no-emoji":"",noDash.checked?"no-em-dash":"",noTable.checked?"no-markdown-table":""].filter(c=>c)}
    function call(method,params){error="";feedback="";action=method;request=App.rpc(method,params)}
    function save(){call("presets.save",{id:profile.id,label:profile.label,text:profile.text,expectedItemRevision:profile.revision,traits:traits,instructions:instructions.text,ceiling:ceiling(),posture:posture.checked,constraints:constraints()})}
    CText { text:"Style details · "+(editor.profile.label||"");font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:"These shape tone only. Tool limits can withhold Cere’s own tools but never grant any; native CLI tools keep their own permissions.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    Repeater {
        model:editor.traitRows
        RowLayout {
            required property var modelData
            Layout.fillWidth:true;spacing:8
            CText { text:modelData.label;Layout.preferredWidth:100 }
            CText { text:modelData.low;color:Theme.muted;font.pixelSize:Theme.caption }
            CSlider { objectName:"trait_"+modelData.key;Layout.fillWidth:true;from:-2;to:2;stepSize:1;snapMode:Slider.SnapAlways;value:editor.traits[modelData.key]||0;Accessible.name:modelData.label
                onMoved:{const next=Object.assign({},editor.traits);if(value===0)delete next[modelData.key];else next[modelData.key]=value;editor.traits=next} }
            CText { text:modelData.high;color:Theme.muted;font.pixelSize:Theme.caption }
        }
    }
    CText { text:"Standing instructions";font.weight:Font.DemiBold }
    CTextArea { id:instructions;objectName:"behaviorInstructions";Layout.fillWidth:true;Layout.preferredHeight:90;wrapMode:TextEdit.Wrap;textFormat:TextEdit.PlainText;placeholderText:"For example: Ask before long explanations. Use metric units.";Accessible.name:"Standing instructions" }
    CText { text:"Withhold Cere tools while this style is active";font.weight:Font.DemiBold }
    Flow {
        Layout.fillWidth:true;spacing:8
        CCheckBox { id:desktop;objectName:"withholdDesktop";text:"Desktop actions" }
        CCheckBox { id:delegation;objectName:"withholdDelegation";text:"Delegation" }
        CCheckBox { id:web;objectName:"withholdWeb";text:"Web search" }
        CCheckBox { id:memory;objectName:"withholdMemory";text:"Memory and notes" }
        CCheckBox { id:extensions;objectName:"withholdExtensions";text:"Tool servers and custom tools" }
    }
    CText { text:"Formatting checks · a reply that misses one gets a note; its text is never changed";font.weight:Font.DemiBold;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Flow {
        Layout.fillWidth:true;spacing:8
        CCheckBox { id:noEmoji;objectName:"checkNoEmoji";text:"No emoji" }
        CCheckBox { id:noDash;objectName:"checkNoDash";text:"No em dashes" }
        CCheckBox { id:noTable;objectName:"checkNoTable";text:"No Markdown tables" }
    }
    CCheckBox { id:posture;objectName:"offerAsPosture";text:"Offer this style as a posture for one message or a pinned stretch of a conversation" }
    RowLayout {
        Layout.fillWidth:true
        CButton { objectName:"behaviorProfileSave";text:"Save details";primary:true;enabled:editor.request<0&&!!editor.profile.id;onClicked:editor.save() }
        CButton { text:"Preview saved instructions";enabled:editor.previewRequest<0&&!!editor.profile.id;onClicked:editor.previewRequest=App.rpc("behavior.preview",{profileId:editor.profile.id}) }
    }
    CTextArea { visible:!!editor.previewText;objectName:"behaviorPreview";Layout.fillWidth:true;Layout.preferredHeight:160;readOnly:true;wrapMode:TextEdit.Wrap;text:editor.previewText;font.pixelSize:Theme.caption;Accessible.name:"Rendered behavior instructions" }
    CText { text:"Checkpoints";font.weight:Font.DemiBold }
    CText { text:"A checkpoint keeps this style exactly as it is now. Restoring one saves it as a new revision; checkpoints never change.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    RowLayout {
        Layout.fillWidth:true
        CField { id:checkpointLabel;Layout.fillWidth:true;placeholderText:"Checkpoint name (optional)";maximumLength:80;Accessible.name:"Checkpoint name" }
        CButton { objectName:"behaviorCheckpoint";text:"Save checkpoint";enabled:editor.request<0&&!!editor.profile.id;onClicked:editor.call("presets.checkpoint",{id:editor.profile.id,expectedItemRevision:editor.profile.revision,label:checkpointLabel.text}) }
    }
    Repeater {
        model:(editor.profile.checkpoints||[]).slice().reverse()
        RowLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { Layout.fillWidth:true;text:modelData.label+" · revision "+modelData.revision+" · "+new Date(modelData.created).toLocaleString(Qt.locale(),Locale.ShortFormat);font.pixelSize:Theme.secondary;elide:Text.ElideRight }
            CButton { text:"Restore";quiet:true;enabled:editor.request<0;onClicked:editor.call("presets.restore",{id:editor.profile.id,expectedItemRevision:editor.profile.revision,checkpointRevision:modelData.revision}) }
        }
    }
    CText { visible:!!editor.error;text:editor.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    CText { visible:!!editor.feedback;text:editor.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary }
    CButton { text:"Close";Layout.fillWidth:true;onClicked:editor.close() }
    Connections {
        target:App
        function onResult(id,value){
            if(id===editor.previewRequest){editor.previewRequest=-1;if(value?.error)editor.error=value.error;else editor.previewText=value.text;return}
            if(id!==editor.request)return
            editor.request=-1
            if(editor.action==="reload"){
                editor.action=""
                const fresh=(value?.items||[]).find(item=>item.id===editor.profile.id);if(fresh){const keep=editor.feedback;editor.load(fresh);editor.feedback=keep}
                return
            }
            if(value?.error){editor.error=value.error;return}
            if(editor.action==="presets.checkpoint"){checkpointLabel.text="";editor.feedback="Checkpoint saved."}
            else editor.feedback=editor.action==="presets.restore"?"Restored as a new revision.":"Saved. Conversations using this style get it from their next message."
            editor.profileSaved()
            // Reload the style so its revision and checkpoints are current.
            editor.action="reload";editor.request=App.rpc("presets.list",{})
        }
    }
}
