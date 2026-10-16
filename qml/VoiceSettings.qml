import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id:voiceSettings
    title:"Voice"
    description:"Read replies aloud using a local voice or ElevenLabs. Pinned conversations also speak each conversational update in the background and show it beside "+App.assistantName+". Quiet mode pauses automatic speech."
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
            CText { text:tuning.label;font.pixelSize:Theme.secondary }
            CText {
                Layout.fillWidth:false
                text:(tuning.signed&&control.value>0?"+":"")+(control.value*tuning.displayScale).toFixed(tuning.decimals)+tuning.suffix
                color:Theme.accentText;font.pixelSize:Theme.secondary
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
    Component.onCompleted:{if(App.connected&&available)refresh();loadDevices()}
    CCheckBox {
        objectName:"speechEnabled";text:"Read replies aloud";checked:voiceSettings.settings.speechEnabled===true
        onClicked:App.rpc("settings.update",{speechEnabled:checked})
    }
    CText { text:"Speak replies from";font.weight:Font.DemiBold }
    CText { text:"Choose conversation providers for automatic speech, including pinned conversations. Turning one off stops its current and queued speech; message bubbles remain visible. Test voice still works.";font.pixelSize:Theme.secondary;color:Theme.muted }
    Flow {
        Layout.fillWidth:true;spacing:8
        Repeater {
            model:[{id:"codex",name:"Codex"},{id:"claude",name:"Claude Code"},{id:"ollama",name:"Ollama"},{id:"antigravity",name:"AntiGravity"},{id:"openai",name:"OpenAI API"},{id:"anthropic",name:"Claude API"},{id:"google",name:"Google AI API"},{id:"compatible",name:"Compatible endpoint"}]
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
        Accessible.name:App.assistantName+" speaking voice"
        currentIndex:voiceSettings.voices.findIndex(v=>v.id===voiceSettings.settings.voice)
        displayText:(voiceSettings.voices.find(voice=>voice.id===voiceSettings.settings.voice)||{}).label||voiceSettings.settings.voice||"en_US-amy-medium"
        onActivated:App.rpc("settings.update",{voice:voiceSettings.voices[currentIndex].id})
    }
    TuningSlider { visible:voiceSettings.settings.ttsProvider!=="indextts";settingKey:"speechRate";label:"Speaking speed";minimum:.5;maximum:2;suffix:"×" }
    TuningSlider { settingKey:"speechPitch";label:"Pitch · lower / higher";minimum:-6;maximum:6;increment:.5;neutral:0;decimals:1;suffix:" semitones";signed:true }
    TuningSlider { settingKey:"speechVolume";label:App.assistantName+"’s volume";displayScale:100;decimals:0;suffix:"%" }
    CText { text:"Pitch changes tone without changing speed. Adjustments apply to new replies and Test voice. Volume affects speech only; 0% mutes the voice.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CButton {
        objectName:"resetVoiceTuning";text:"Reset voice adjustments";enabled:!voiceSettings.savingTuning
        onClicked:voiceSettings.saveTuning({speechRate:1,speechPitch:0,speechVolume:1})
    }
    CCheckBox { objectName:"speechBrief";text:"Read a brief opening instead of the full response";checked:voiceSettings.settings.speechBrief===true;onClicked:App.rpc("settings.update",{speechBrief:checked}) }
    GridLayout {
        Layout.fillWidth:true;columns:width>=400?3:1;columnSpacing:8;rowSpacing:8
        CButton { objectName:"ttsTest";text:"Test voice";Layout.fillWidth:true;enabled:!voiceSettings.savingTuning;onClicked:App.rpc("tts.test",{}) }
        CButton { objectName:"ttsStop";text:"Stop speaking";Layout.fillWidth:true;onClicked:App.rpc("tts.stop",{}) }
        CButton { text:"Refresh voices";Layout.fillWidth:true;onClicked:voiceSettings.refresh() }
    }
    CText {
        objectName:"ttsStatus";font.pixelSize:Theme.secondary
        text:voiceSettings.speech.error||voiceSettings.error||(voiceSettings.settings.speechVolume===0?"Voice muted · raise the volume to preview":voiceSettings.speech.state==="preparing"?"Preparing voice…":voiceSettings.speech.state==="speaking"?"Speaking · "+voiceSettings.speech.backend:voiceSettings.speech.backend?"Ready · "+voiceSettings.speech.backend:"Ready to test")
        color:voiceSettings.speech.error||voiceSettings.error?Theme.danger:Theme.accentText
    }
    CText { visible:!voiceSettings.settings.ttsProvider||voiceSettings.settings.ttsProvider==="local";text:"Add a voice’s .onnx and .onnx.json files to ~/.local/share/piper/voices/ or Cere’s config/voices/ folder, then refresh. Test voice plays even in quiet mode.";color:Theme.muted;font.pixelSize:Theme.secondary }
    Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
    CText { text:"Local voice input";font.weight:Font.DemiBold }
    CText { text:"Push-to-talk uses a whisper.cpp executable and model already installed on this computer. Cere never uploads recordings and does not download a model at startup.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
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
    CText { text:"Follow the whisper.cpp README at github.com/ggml-org/whisper.cpp: build whisper-cli locally and download a GGML model with the project’s model script. Paste both absolute paths above. Audio capture uses PipeWire pw-record, with ALSA arecord as a fallback. Recordings are limited to 60 seconds and deleted after finish, cancel, or error.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    // M21: spoken commands from a fixed list; the transcript stays ordinary text unless it is one of them.
    CText { text:"Voice commands";font.weight:Font.DemiBold }
    CCheckBox { objectName:"voiceCommandsEnabled";text:"Recognize spoken commands";checked:voiceSettings.settings.voiceCommands?.enabled===true;onClicked:App.rpc("settings.update",{voiceCommands:{enabled:checked}}) }
    CCheckBox { objectName:"voiceCommandsConfirm";visible:voiceSettings.settings.voiceCommands?.enabled===true;text:"Show a command before running it";checked:voiceSettings.settings.voiceCommands?.confirm!==false;onClicked:App.rpc("settings.update",{voiceCommands:{confirm:checked}}) }
    CCheckBox { objectName:"voiceCommandsSpeak";visible:voiceSettings.settings.voiceCommands?.enabled===true;text:"Say navigation commands aloud";checked:voiceSettings.settings.voiceCommands?.speakFeedback===true;onClicked:App.rpc("settings.update",{voiceCommands:{speakFeedback:checked}}) }
    CText { text:"Say only the command, optionally starting with "+App.assistantName+": “stop speaking”, “read that again”, “stop the reply”, “open settings”, “show conversations”, “open desktop” or “new conversation”. Anything else stays text for your draft. Commands never answer a permission question; the Stop button always works.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    // M10: which microphone records and which speaker plays. A chosen device that is unplugged is
    // reported instead of quietly using another one.
    CText { text:"Audio devices";font.weight:Font.DemiBold }
    property var audioDevices:({backend:"",inputs:[],outputs:[]})
    property int devicesRequest:-1
    property string devicesError:""
    function loadDevices(){devicesError="";devicesRequest=App.rpc("audio.devices",{})}
    function deviceChoices(list,chosen){
        const items=[{id:"",label:"System default"}].concat(list.map(device=>({id:device.id,label:device.label+(device.isDefault?" · current default":"")})))
        return chosen&&!list.some(device=>device.id===chosen)?items.concat([{id:chosen,label:chosen.replace(/^(pw|alsa):/,"")+" · not connected"}]):items
    }
    readonly property var audioChoice:settings.audio||({input:"",output:""})
    readonly property var inputChoices:deviceChoices(audioDevices.inputs||[],audioChoice.input)
    readonly property var outputChoices:deviceChoices(audioDevices.outputs||[],audioChoice.output)
    GridLayout {
        Layout.fillWidth:true;columns:width>=520?2:1;columnSpacing:8;rowSpacing:6
        CText { text:"Microphone";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox {
            id:inputDevice;objectName:"audioInputDevice";Layout.fillWidth:true;model:voiceSettings.inputChoices;textRole:"label";valueRole:"id";Accessible.name:"Microphone"
            currentIndex:Math.max(0,voiceSettings.inputChoices.findIndex(item=>item.id===voiceSettings.audioChoice.input))
            onActivated:App.rpc("settings.update",{audio:{input:currentValue}})
        }
        CText { text:"Speaker";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox {
            id:outputDevice;objectName:"audioOutputDevice";Layout.fillWidth:true;model:voiceSettings.outputChoices;textRole:"label";valueRole:"id";Accessible.name:"Speaker"
            currentIndex:Math.max(0,voiceSettings.outputChoices.findIndex(item=>item.id===voiceSettings.audioChoice.output))
            onActivated:App.rpc("settings.update",{audio:{output:currentValue}})
        }
    }
    RowLayout {
        Layout.fillWidth:true
        CText { objectName:"audioDevicesStatus";Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.caption;color:voiceSettings.devicesError||voiceSettings.audioDevices.error?Theme.amber:Theme.muted
            text:voiceSettings.devicesError||voiceSettings.audioDevices.error||(voiceSettings.audioDevices.backend?(voiceSettings.audioDevices.backend==="pipewire"?"Devices from PipeWire":"Devices from ALSA")+" · "+(voiceSettings.audioDevices.inputs||[]).length+" microphones, "+(voiceSettings.audioDevices.outputs||[]).length+" speakers. A chosen speaker plays through Cere’s own player.":"Listing devices…") }
        CButton { objectName:"audioDevicesRefresh";text:"Refresh";enabled:voiceSettings.devicesRequest<0;onClicked:voiceSettings.loadDevices() }
    }
    Connections { target:App;function onResult(id,value){if(id!==voiceSettings.devicesRequest)return;voiceSettings.devicesRequest=-1;if(value?.error)voiceSettings.devicesError=String(value.error);else voiceSettings.audioDevices=value} }
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
