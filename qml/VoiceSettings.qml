import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id:voiceSettings
    title:"Voice"
    description:"Read replies aloud using a local voice or ElevenLabs. Pinned conversations also speak each conversational update in the background and show it beside Cere. Quiet mode pauses automatic speech."
    property var settings:App.state.settings||({})
    property var speech:App.state.speech||({})
    property var transcriptionSettings:settings.transcription||({})
    property var voices:[]
    property int voicesRequest:-1
    property string error:""
    property bool loaded:false
    property var tuningRequests:({})
    readonly property bool savingTuning:Object.keys(tuningRequests).length>0
    readonly property bool available: App.state.speech !== undefined
    visible: available
    function refresh(){if(!available)return;loaded=true;voicesRequest=App.rpc("tts.voices",{})}
    function saveTuning(patch){
        error=""
        const id=App.rpc("settings.update",patch)
        if(id<0){error="Reconnect before changing voice settings.";return}
        const pending=Object.assign({},tuningRequests);pending[id]=true;tuningRequests=pending
    }
    component TuningSlider:ColumnLayout {
        id:tuning
        required property string settingKey
        required property string label
        property real minimum:0
        property real maximum:1
        property real increment:.05
        property real neutral:1
        property real displayScale:1
        property int decimals:2
        property string suffix:""
        property bool signed:false
        Layout.fillWidth:true;spacing:2
        function saveValue(value){const patch={};patch[settingKey]=Math.round(value*100)/100;voiceSettings.saveTuning(patch)}
        function save(){saveValue(control.value)}
        RowLayout {
            Layout.fillWidth:true
            CText { text:tuning.label;font.pixelSize:12 }
            CText {
                Layout.fillWidth:false
                text:(tuning.signed&&control.value>0?"+":"")+(control.value*tuning.displayScale).toFixed(tuning.decimals)+tuning.suffix
                color:Theme.cyan;font.pixelSize:12
            }
        }
        CSlider {
            id:control;objectName:tuning.settingKey;Layout.fillWidth:true;Layout.minimumWidth:0
            from:tuning.minimum;to:tuning.maximum;stepSize:tuning.increment
            snapMode:Slider.SnapAlways
            value:voiceSettings.settings[tuning.settingKey]===undefined?tuning.neutral:voiceSettings.settings[tuning.settingKey]
            Accessible.name:tuning.label
            // Persist once when a pointer drag ends; keyboard adjustments save immediately.
            onMoved:if(!pressed)tuning.save()
            onPressedChanged:if(!pressed)tuning.save()
            Keys.onPressed:event=>{
                if(event.key===Qt.Key_Home||event.key===Qt.Key_End){
                    tuning.saveValue(event.key===Qt.Key_Home?from:to);event.accepted=true
                }else event.accepted=false
            }
        }
    }
    Component.onCompleted:if(App.connected&&available)refresh()
    CCheckBox {
        objectName:"speechEnabled";text:"Read replies aloud";checked:voiceSettings.settings.speechEnabled===true
        onClicked:App.rpc("settings.update",{speechEnabled:checked})
    }
    CText { text:"Speak replies from";font.weight:Font.DemiBold }
    CText { text:"Choose conversation providers for automatic speech, including pinned conversations. Turning one off stops its current and queued speech; message bubbles remain visible. Test voice still works.";font.pixelSize:12;color:Theme.muted }
    Flow {
        Layout.fillWidth:true;spacing:8
        Repeater {
            model:[{id:"codex",name:"Codex"},{id:"claude",name:"Claude Code"},{id:"ollama",name:"Ollama"},{id:"antigravity",name:"AntiGravity"},{id:"openai",name:"OpenAI API"},{id:"anthropic",name:"Claude API"},{id:"google",name:"Google AI API"}]
            delegate:CCheckBox {
                required property var modelData
                objectName:"speechProvider_"+modelData.id;text:modelData.name
                checked:voiceSettings.settings.speechProviders?.[modelData.id]!==false
                onClicked:{const patch={};patch[modelData.id]=checked;App.rpc("settings.update",{speechProviders:patch})}
            }
        }
    }
    CComboBox {
        objectName:"ttsProvider";Layout.fillWidth:true
        model:["Local voices · Piper / Kokoro","IndexTTS · voice cloning","ElevenLabs · API"]
        currentIndex:voiceSettings.settings.ttsProvider==="elevenlabs"?2:voiceSettings.settings.ttsProvider==="indextts"?1:0
        Accessible.name:"Speech provider"
        onActivated:App.rpc("settings.update",{ttsProvider:currentIndex===2?"elevenlabs":currentIndex===1?"indextts":"local"})
    }
    Loader { Layout.fillWidth:true;active:voiceSettings.settings.ttsProvider==="indextts";visible:active;source:"IndexTTSSettings.qml" }
    Loader { Layout.fillWidth:true;active:voiceSettings.settings.ttsProvider==="elevenlabs";visible:active;source:"ElevenLabsSettings.qml" }
    CComboBox {
        visible:!voiceSettings.settings.ttsProvider||voiceSettings.settings.ttsProvider==="local"
        objectName:"speechVoice";Layout.fillWidth:true;Layout.minimumWidth:0
        model:voiceSettings.voices;textRole:"label"
        Accessible.name:"Cere speaking voice"
        currentIndex:voiceSettings.voices.findIndex(v=>v.id===voiceSettings.settings.voice)
        displayText:(voiceSettings.voices.find(voice=>voice.id===voiceSettings.settings.voice)||{}).label||voiceSettings.settings.voice||"en_US-amy-medium"
        onActivated:App.rpc("settings.update",{voice:voiceSettings.voices[currentIndex].id})
    }
    TuningSlider { visible:voiceSettings.settings.ttsProvider!=="indextts";settingKey:"speechRate";label:"Speaking speed";minimum:.5;maximum:2;suffix:"×" }
    TuningSlider { settingKey:"speechPitch";label:"Pitch · lower / higher";minimum:-6;maximum:6;increment:.5;neutral:0;decimals:1;suffix:" semitones";signed:true }
    TuningSlider { settingKey:"speechVolume";label:"Cere’s volume";displayScale:100;decimals:0;suffix:"%" }
    CText { text:"Pitch changes tone without changing speed. Adjustments apply to new replies and Test voice. Volume affects Cere only; 0% mutes her voice.";color:Theme.muted;font.pixelSize:12 }
    CButton {
        objectName:"resetVoiceTuning";text:"Reset voice adjustments";enabled:!voiceSettings.savingTuning
        onClicked:voiceSettings.saveTuning({speechRate:1,speechPitch:0,speechVolume:1})
    }
    CCheckBox { text:"Read a brief opening instead of the full response";checked:voiceSettings.settings.speechBrief===true;onClicked:App.rpc("settings.update",{speechBrief:checked}) }
    GridLayout {
        Layout.fillWidth:true;columns:width>=400?3:1;columnSpacing:8;rowSpacing:8
        CButton { objectName:"ttsTest";text:"Test voice";Layout.fillWidth:true;enabled:!voiceSettings.savingTuning;onClicked:App.rpc("tts.test",{}) }
        CButton { objectName:"ttsStop";text:"Stop speaking";Layout.fillWidth:true;onClicked:App.rpc("tts.stop",{}) }
        CButton { text:"Refresh voices";Layout.fillWidth:true;onClicked:voiceSettings.refresh() }
    }
    CText {
        objectName:"ttsStatus";font.pixelSize:12
        text:voiceSettings.speech.error||voiceSettings.error||(voiceSettings.settings.speechVolume===0?"Voice muted · raise Cere’s volume to preview":voiceSettings.speech.state==="preparing"?"Preparing voice…":voiceSettings.speech.state==="speaking"?"Speaking · "+voiceSettings.speech.backend:voiceSettings.speech.backend?"Ready · "+voiceSettings.speech.backend:"Ready to test")
        color:voiceSettings.speech.error||voiceSettings.error?Theme.danger:Theme.cyan
    }
    CText { visible:!voiceSettings.settings.ttsProvider||voiceSettings.settings.ttsProvider==="local";text:"Add a voice’s .onnx and .onnx.json files to ~/.local/share/piper/voices/ or Cere’s config/voices/ folder, then refresh. Test voice plays even in quiet mode.";color:Theme.muted;font.pixelSize:12 }
    Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
    CText { text:"Local voice input";font.weight:Font.DemiBold }
    CText { text:"Push-to-talk uses a whisper.cpp executable and model already installed on this computer. Cere never uploads recordings and does not download a model at startup.";color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap }
    CField {
        id:whisperExecutable;objectName:"whisperExecutable";Layout.fillWidth:true
        placeholderText:"Absolute path to whisper-cli";text:voiceSettings.transcriptionSettings.executable||""
        Accessible.name:"whisper.cpp executable path"
    }
    CField {
        id:whisperModel;objectName:"whisperModel";Layout.fillWidth:true
        placeholderText:"Absolute path to a local GGML model";text:voiceSettings.transcriptionSettings.model||""
        Accessible.name:"whisper.cpp model path"
    }
    CButton {
        objectName:"saveTranscription";text:"Save local voice-input paths"
        enabled:whisperExecutable.text.trim().startsWith("/")&&whisperModel.text.trim().startsWith("/")
        onClicked:App.rpc("settings.update",{transcription:{executable:whisperExecutable.text.trim(),model:whisperModel.text.trim()}})
    }
    CText { text:"Follow the whisper.cpp README at github.com/ggml-org/whisper.cpp: build whisper-cli locally and download a GGML model with the project’s model script. Paste both absolute paths above. Audio capture uses PipeWire pw-record, with ALSA arecord as a fallback. Recordings are limited to 60 seconds and deleted after finish, cancel, or error.";color:Theme.muted;font.pixelSize:11;wrapMode:Text.Wrap }
    Connections {
        target:App
        function onStateChanged(){
            if(!App.connected)voiceSettings.loaded=false
            else if(voiceSettings.available&&!voiceSettings.loaded)voiceSettings.refresh()
        }
        function onResult(id,value){
            if(voiceSettings.tuningRequests[id]){
                const pending=Object.assign({},voiceSettings.tuningRequests);delete pending[id];voiceSettings.tuningRequests=pending
                voiceSettings.error=value?.error||""
                return
            }
            if(id!==voiceSettings.voicesRequest)return
            voiceSettings.voicesRequest=-1
            voiceSettings.error=value?.error||""
            if(!voiceSettings.error)voiceSettings.voices=(value.voices||[]).map(voice=>Object.assign({},voice,{label:voice.id==="kokoro-af_heart"?"Heart · natural feminine":voice.id==="kokoro-af_bella"?"Bella · warm feminine":voice.id}))
        }
    }
}
