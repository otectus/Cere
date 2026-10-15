import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id:personality
    title:"Personality"
    description:"Choose your companion’s name and conversation style."
    property string savedBaseline:""
    property string savedName:"Cere"
    property string savedAvatar:"cere"
    property string savedRevision:"0"
    property bool conflict:false
    property bool loaded:false
    property int requestId:-1
    property string error:""
    property string feedback:""
    readonly property int maximumLength:App.state.personality?.maxLength||8000
    readonly property bool dirty:editor.text!==savedBaseline||nameField.text!==savedName
    function adopt(settings){
        savedBaseline=settings.personality??""
        savedName=settings.assistantName||"Cere"
        savedAvatar=settings.avatar||"cere"
        editor.text=savedBaseline;nameField.text=savedName
        savedRevision=App.state.settingsRevision||"0";conflict=false;loaded=true
    }
    function syncSaved(){
        const settings=App.state.settings||{}
        if(!loaded||!dirty)adopt(settings)
        else if((settings.personality??"")!==savedBaseline||(settings.assistantName||"Cere")!==savedName||(settings.avatar||"cere")!==savedAvatar)conflict=true
        else savedRevision=App.state.settingsRevision||"0"
    }
    Component.onCompleted:syncSaved()
    CText { text:"Name";font.weight:Font.DemiBold }
    CField {
        id:nameField;objectName:"assistantName";Layout.fillWidth:true
        placeholderText:"Cere";maximumLength:64;readOnly:personality.requestId>=0
        Accessible.name:"Assistant name"
        onTextChanged:{personality.error="";personality.feedback=""}
    }
    CText { text:"Used in conversation and on companion labels. Up to 64 characters; leave blank to use Cere.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { text:"Personality";font.weight:Font.DemiBold }
    ScrollView {
        Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredHeight:280
        clip:true
        ScrollBar.horizontal.policy:ScrollBar.AlwaysOff
        ScrollBar.vertical:CScrollBar {}
        CTextArea {
            id:editor;objectName:"personalityText"
            textFormat:TextEdit.PlainText
            wrapMode:TextEdit.Wrap;selectByMouse:true
            readOnly:personality.requestId>=0
            font.family:Theme.font;font.pixelSize:Theme.body
            padding:12
            placeholderText:"Leave blank for a clear, helpful, neutral voice."
            Accessible.name:"Assistant personality"
            onTextChanged:{personality.error="";personality.feedback=""}
        }
    }
    CText {
        text:editor.length+" / "+personality.maximumLength+" characters"+(personality.dirty?" · Unsaved changes":"")
        color:editor.length>personality.maximumLength?Theme.danger:Theme.muted;font.pixelSize:Theme.secondary
    }
    CText { text:"Personality changes voice and manner, not permissions. Leave blank for a neutral voice. Restore default fills the editor; Save applies it.";color:Theme.muted;font.pixelSize:Theme.secondary }
    GridLayout {
        Layout.fillWidth:true;columns:width>=480?3:1;columnSpacing:8;rowSpacing:8
        CButton {
            objectName:"personalitySave";text:personality.requestId>=0?"Saving…":"Save changes";primary:true;Layout.fillWidth:true
            enabled:App.connected&&personality.loaded&&personality.requestId<0&&personality.dirty&&!personality.conflict&&editor.length<=personality.maximumLength&&nameField.length<=64
            onClicked:{personality.error="";personality.feedback="";personality.requestId=App.rpc("settings.update",{personality:editor.text,assistantName:nameField.text,expectedRevision:personality.savedRevision,expectedIdentity:{personality:personality.savedBaseline,assistantName:personality.savedName,avatar:personality.savedAvatar}})}
        }
        CButton {
            objectName:"personalityDiscard";text:"Discard changes";Layout.fillWidth:true
            enabled:personality.requestId<0&&personality.dirty
            onClicked:{personality.adopt(App.state.settings||{});personality.error="";personality.feedback=""}
        }
        CButton {
            objectName:"personalityReset";text:"Restore default personality";Layout.fillWidth:true
            enabled:personality.requestId<0&&App.state.personality?.defaultText!==undefined&&editor.text!==App.state.personality.defaultText
            onClicked:editor.text=App.state.personality.defaultText
        }
    }
    CText { objectName:"personalityError";visible:!!personality.error;text:personality.error;color:Theme.danger;font.pixelSize:Theme.secondary }
    CText { objectName:"personalityConflict";visible:personality.conflict;text:"Name, avatar or personality changed in another window. Keep a copy of your draft, then discard changes to load the saved settings.";color:Theme.amber;font.pixelSize:Theme.secondary }
    CText { visible:!!personality.feedback;text:personality.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary }
    Connections {
        target:App
        function onStateChanged(){personality.syncSaved()}
        function onResult(id,value){
            if(id!==personality.requestId)return
            personality.requestId=-1
            if(value?.error){personality.error=value.error;return}
            personality.adopt(value)
            personality.feedback="Saved · labels update now; conversation changes apply on the next reply."
        }
    }
}
