import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M01: this conversation's style, pinned posture and standing instructions, and a posture for the next
// message only. The conversation's style wins over its project's, which wins over Settings.
CDialog {
    id:behavior;objectName:"sessionBehavior"
    width:Math.min(600,parent?parent.width-32:600)
    property string sessionId:""
    property var styles:[]
    property var postures:[]
    property var resolved:({})
    property int stylesRequest:-1
    property int posturesRequest:-1
    property int resolveRequest:-1
    property int saveRequest:-1
    property string error:""
    property string feedback:""
    property string nextPostureId:""
    signal turnPostureChosen(string id,string label)
    readonly property var session:(App.state.sessions||[]).find(item=>item.id===sessionId)||({})
    readonly property var styleOptions:[{id:"",label:"Use the project or Settings style"}].concat(styles.map(item=>({id:item.id,label:item.label})))
    readonly property var postureOptions:[{id:"",label:"No pinned posture"}].concat(postures.map(item=>({id:item.id,label:item.label})))
    readonly property var nextOptions:[{id:"",label:"No posture for the next message"}].concat(postures.map(item=>({id:item.id,label:item.label})))
    readonly property var sourceLabels:({session:"this conversation",project:"its project",global:"Settings › Personality"})
    readonly property var toolLabels:({desktop:"desktop actions",delegation:"delegation",web:"web search",memory:"memory and notes",extensions:"tool servers and custom tools",recall:"automatic memory recall"})
    function openFor(id,turnPostureId){
        sessionId=id;nextPostureId=turnPostureId||"";error="";feedback=""
        stylesRequest=App.rpc("presets.list",{});posturesRequest=App.rpc("behavior.postures",{});resolveRequest=App.rpc("behavior.resolve",{id:id})
        instructions.text=session.behavior?.instructions||""
        open()
    }
    function select(){
        const chosen=session.behavior||{}
        styleCombo.currentIndex=Math.max(0,styleOptions.findIndex(item=>item.id===(chosen.profileId||"")))
        postureCombo.currentIndex=Math.max(0,postureOptions.findIndex(item=>item.id===(chosen.postureId||"")))
        nextCombo.currentIndex=Math.max(0,nextOptions.findIndex(item=>item.id===nextPostureId))
    }
    function withheld(){return Object.keys(resolved.ceiling||{}).map(key=>toolLabels[key]||key)}
    CText { text:"Style and posture";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText {
        objectName:"behaviorSummary";Layout.fillWidth:true;wrapMode:Text.Wrap
        text:behavior.resolveRequest>=0?"Loading…":"Now using "+(behavior.resolved.profile?"“"+behavior.resolved.profile.label+"”":"the personality")+" from "+(behavior.sourceLabels[behavior.resolved.source]||"Settings")
            +(behavior.resolved.posture?" · posture "+behavior.resolved.posture.label+(behavior.resolved.posture.pinned?" (pinned)":""):"")
    }
    CText { objectName:"behaviorWithheld";visible:behavior.withheld().length>0;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.secondary;text:"Withheld while this style is active: "+behavior.withheld().join(", ")+". Native CLI tools keep their own permissions." }
    Repeater { model:(behavior.resolved.warnings||[]).concat(behavior.resolved.conflicts||[]);CText { required property string modelData;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.amber;font.pixelSize:Theme.secondary;text:modelData } }
    CText { text:"Style for this conversation";font.weight:Font.DemiBold }
    CComboBox { id:styleCombo;objectName:"sessionStyle";Layout.fillWidth:true;model:behavior.styleOptions;textRole:"label";Accessible.name:"Style for this conversation" }
    CText { text:"Pinned posture";font.weight:Font.DemiBold }
    CComboBox { id:postureCombo;objectName:"sessionPosture";Layout.fillWidth:true;model:behavior.postureOptions;textRole:"label";Accessible.name:"Pinned posture" }
    CText { text:"A pinned posture stays until you change it. Postures can withhold tools; they never add any. Without memory stops recall for its turns, but what you say is still remembered under your memory settings; a temporary conversation leaves nothing behind.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { text:"Standing instructions for this conversation";font.weight:Font.DemiBold }
    CTextArea { id:instructions;objectName:"sessionInstructions";Layout.fillWidth:true;Layout.preferredHeight:80;wrapMode:TextEdit.Wrap;textFormat:TextEdit.PlainText;placeholderText:"Added after the style’s own instructions";Accessible.name:"Standing instructions for this conversation" }
    CButton {
        objectName:"sessionBehaviorSave";text:behavior.saveRequest>=0?"Saving…":"Save for this conversation";primary:true;Layout.fillWidth:true
        enabled:App.connected&&behavior.saveRequest<0&&!!behavior.sessionId
        onClicked:{behavior.error="";behavior.feedback="";behavior.saveRequest=App.rpc("session.behavior",{id:behavior.sessionId,profileId:styleCombo.currentIndex>0?behavior.styleOptions[styleCombo.currentIndex].id:null,postureId:postureCombo.currentIndex>0?behavior.postureOptions[postureCombo.currentIndex].id:null,instructions:instructions.text})}
    }
    CText { text:"Next message only";font.weight:Font.DemiBold }
    CComboBox { id:nextCombo;objectName:"nextPosture";Layout.fillWidth:true;model:behavior.nextOptions;textRole:"label";Accessible.name:"Posture for the next message" }
    CButton {
        objectName:"nextPostureApply";text:"Use for the next message";Layout.fillWidth:true
        onClicked:{const item=behavior.nextOptions[nextCombo.currentIndex]||{id:"",label:""};behavior.turnPostureChosen(item.id,item.id?item.label:"");behavior.close()}
    }
    CText { visible:!!behavior.error;text:behavior.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"sessionBehaviorFeedback";visible:!!behavior.feedback;text:behavior.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CButton { text:"Close";Layout.fillWidth:true;onClicked:behavior.close() }
    Connections {
        target:App
        function onResult(id,value){
            if(id===behavior.stylesRequest){behavior.stylesRequest=-1;if(value?.error)behavior.error=value.error;else behavior.styles=value.items||[];behavior.select();return}
            if(id===behavior.posturesRequest){behavior.posturesRequest=-1;if(value?.error)behavior.error=value.error;else behavior.postures=value.postures||[];behavior.select();return}
            if(id===behavior.resolveRequest){behavior.resolveRequest=-1;if(value?.error)behavior.error=value.error;else behavior.resolved=value;return}
            if(id!==behavior.saveRequest)return
            behavior.saveRequest=-1
            if(value?.error){behavior.error=value.error;return}
            behavior.resolved=value.behavior||({})
            behavior.feedback="Saved. The next reply uses it."
        }
    }
}
