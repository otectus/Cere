import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id:personality
    title:"Personality"
    description:"Choose how Cere talks with you. Saved changes apply to the next reply in new and existing Cere conversations with Codex, Claude and Ollama."
    property string savedText:App.state.settings?.personality??""
    property string savedBaseline:""
    property string savedRevision:"0"
    property bool conflict:false
    property bool loaded:false
    property int requestId:-1
    property string error:""
    property string feedback:""
    readonly property int maximumLength:App.state.personality?.maxLength||8000
    readonly property bool dirty:editor.text!==savedBaseline
    function syncSaved(){
        if(!loaded||!dirty){editor.text=savedText;savedBaseline=savedText;savedRevision=App.state.settingsRevision||"0";conflict=false}
        else if(savedText!==savedBaseline)conflict=true
        else savedRevision=App.state.settingsRevision||"0"
        loaded=true
    }
    onSavedTextChanged:syncSaved()
    Component.onCompleted:syncSaved()
    ScrollView {
        Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredHeight:280
        clip:true
        ScrollBar.horizontal.policy:ScrollBar.AlwaysOff
        ScrollBar.vertical:CScrollBar {}
        TextArea {
            id:editor;objectName:"personalityText"
            textFormat:TextEdit.PlainText
            wrapMode:TextEdit.Wrap;selectByMouse:true
            readOnly:personality.requestId>=0
            color:Theme.text;selectionColor:Theme.selected;selectedTextColor:Theme.text
            font.family:Theme.font;font.pixelSize:13
            padding:12
            placeholderText:"Leave blank for a clear, helpful, neutral voice."
            Accessible.name:"Cere personality"
            onTextChanged:{personality.error="";personality.feedback=""}
            background:Rectangle { color:Theme.input;radius:7;border.color:editor.activeFocus?Theme.cyan:Theme.line }
        }
    }
    CText {
        text:editor.length+" / "+personality.maximumLength+" characters"+(personality.dirty?" · Unsaved changes":"")
        color:editor.length>personality.maximumLength?Theme.danger:Theme.muted;font.pixelSize:12
    }
    CText { text:"Personality changes voice and manner, not permissions. Leave blank for a neutral voice. Restore default fills the editor; Save applies it.";color:Theme.muted;font.pixelSize:12 }
    GridLayout {
        Layout.fillWidth:true;columns:width>=480?3:1;columnSpacing:8;rowSpacing:8
        CButton {
            objectName:"personalitySave";text:personality.requestId>=0?"Saving…":"Save personality";primary:true;Layout.fillWidth:true
            enabled:App.connected&&personality.loaded&&personality.requestId<0&&personality.dirty&&editor.length<=personality.maximumLength
            onClicked:{personality.error="";personality.feedback="";personality.requestId=App.rpc("settings.update",{personality:editor.text,expectedRevision:personality.savedRevision})}
        }
        CButton {
            objectName:"personalityDiscard";text:"Discard changes";Layout.fillWidth:true
            enabled:personality.requestId<0&&personality.dirty
            onClicked:{editor.text=personality.savedText;personality.savedBaseline=personality.savedText;personality.savedRevision=App.state.settingsRevision||"0";personality.conflict=false;personality.error="";personality.feedback=""}
        }
        CButton {
            objectName:"personalityReset";text:"Restore default";Layout.fillWidth:true
            enabled:personality.requestId<0&&App.state.personality?.defaultText!==undefined&&editor.text!==App.state.personality.defaultText
            onClicked:editor.text=App.state.personality.defaultText
        }
    }
    CText { objectName:"personalityError";visible:!!personality.error;text:personality.error;color:Theme.danger;font.pixelSize:12 }
    CText { visible:personality.conflict;text:"Personality changed on another client. Copy your text, then reload before saving.";color:Theme.amber;font.pixelSize:12 }
    CText { visible:!!personality.feedback;text:personality.feedback;color:Theme.cyan;font.pixelSize:12 }
    Connections {
        target:App
        function onStateChanged(){personality.syncSaved()}
        function onResult(id,value){
            if(id!==personality.requestId)return
            personality.requestId=-1
            if(value?.error){personality.error=value.error;return}
            editor.text=value.personality
            personality.savedBaseline=value.personality
            personality.savedRevision=App.state.settingsRevision||"0"
            personality.conflict=false
            personality.feedback="Saved · applies on the next reply."
        }
    }
}
