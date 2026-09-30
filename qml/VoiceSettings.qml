import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id:voiceSettings
    title:"Voice"
    description:"Read finished replies aloud using a local Piper voice. Quiet mode pauses automatic speech."
    property var settings:App.state.settings||({})
    property var speech:App.state.speech||({})
    property var voices:[]
    property int voicesRequest:-1
    property string error:""
    property bool loaded:false
    readonly property bool available: App.state.speech !== undefined
    visible: available
    function refresh(){if(!available)return;loaded=true;voicesRequest=App.rpc("tts.voices",{})}
    Component.onCompleted:if(App.connected&&available)refresh()
    CCheckBox {
        objectName:"speechEnabled";text:"Read replies aloud";checked:voiceSettings.settings.speechEnabled===true
        onClicked:App.rpc("settings.update",{speechEnabled:checked})
    }
    CComboBox {
        objectName:"speechVoice";Layout.fillWidth:true;Layout.minimumWidth:0
        model:voiceSettings.voices;textRole:"id"
        Accessible.name:"Piper voice"
        currentIndex:voiceSettings.voices.findIndex(v=>v.id===voiceSettings.settings.voice)
        displayText:voiceSettings.settings.voice||"en_US-amy-medium"
        onActivated:App.rpc("settings.update",{voice:voiceSettings.voices[currentIndex].id})
    }
    GridLayout {
        Layout.fillWidth:true;columns:width>=400?3:1;columnSpacing:8;rowSpacing:8
        CButton { objectName:"ttsTest";text:"Test voice";Layout.fillWidth:true;onClicked:App.rpc("tts.test",{}) }
        CButton { objectName:"ttsStop";text:"Stop speaking";Layout.fillWidth:true;onClicked:App.rpc("tts.stop",{}) }
        CButton { text:"Refresh voices";Layout.fillWidth:true;onClicked:voiceSettings.refresh() }
    }
    CText { text:"Add a voice’s .onnx and .onnx.json files to ~/.local/share/piper/voices/ or Cere’s config/voices/ folder, then refresh. Test voice plays even in quiet mode.";color:Theme.muted;font.pixelSize:12 }
    CText {
        objectName:"ttsStatus";font.pixelSize:12
        text:voiceSettings.speech.error||voiceSettings.error||(voiceSettings.speech.state==="preparing"?"Preparing voice…":voiceSettings.speech.state==="speaking"?"Speaking · "+voiceSettings.speech.backend:voiceSettings.speech.backend?"Ready · "+voiceSettings.speech.backend:"Ready to test")
        color:voiceSettings.speech.error||voiceSettings.error?Theme.danger:Theme.cyan
    }
    Connections {
        target:App
        function onStateChanged(){
            if(!App.connected)voiceSettings.loaded=false
            else if(voiceSettings.available&&!voiceSettings.loaded)voiceSettings.refresh()
        }
        function onResult(id,value){
            if(id!==voiceSettings.voicesRequest)return
            voiceSettings.voicesRequest=-1
            voiceSettings.error=value?.error||""
            if(!voiceSettings.error)voiceSettings.voices=value.voices||[]
        }
    }
}
