import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
    id:panel
    objectName:"elevenLabsSettings"
    Layout.fillWidth:true;spacing:8
    property var config:App.state.settings?.elevenlabs||({})
    property var status:App.state.elevenlabs||({})
    property var credential:status.credential||({})
    property var requests:({})
    property string error:""
    function call(method,params){error="";const id=App.rpc(method,params||{});if(id>=0){const next=Object.assign({},requests);next[id]=true;requests=next}}
    function save(patch){call("settings.update",{elevenlabs:patch})}
    CText { text:"ElevenLabs · cloud voice";font.weight:Font.DemiBold }
    CText { text:"Spoken reply text is sent to ElevenLabs when this provider is selected. API usage consumes your account credits. Local reference recordings are not uploaded.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CCheckBox { objectName:"elevenCloudConsent";text:"Allow sending spoken text to ElevenLabs";checked:panel.config.allowCloud===true;onClicked:panel.save({allowCloud:checked}) }
    CText { text:panel.credential.configured?(panel.credential.source==="environment"?"Using ELEVENLABS_API_KEY":"API key saved privately"):"Add an ElevenLabs API key";color:Theme.cyan;font.pixelSize:Theme.secondary }
    CField { id:key;objectName:"elevenApiKey";Layout.fillWidth:true;placeholderText:"ElevenLabs API key";echoMode:TextInput.Password;maximumLength:8192;Accessible.name:"ElevenLabs API key" }
    Flow {
        Layout.fillWidth:true;spacing:8
        CButton { text:"Save key";enabled:key.text.trim().length>0;onClicked:{panel.call("elevenlabs.credentials",{key:key.text.trim()});key.clear()} }
        CButton { text:"Remove saved key";visible:panel.credential.source==="saved";onClicked:panel.call("elevenlabs.credentials",{key:""}) }
        CButton { objectName:"elevenRefresh";text:panel.status.loading?"Connecting…":"Refresh voices and models";enabled:panel.credential.configured===true&&!panel.status.loading;onClicked:panel.call("elevenlabs.refresh") }
    }
    CText { text:"Voice";font.weight:Font.DemiBold }
    CComboBox { objectName:"elevenVoice";Layout.fillWidth:true;model:panel.status.voices||[];textRole:"name";currentIndex:model.findIndex(v=>v.id===panel.config.voiceId);displayText:(model.find(v=>v.id===panel.config.voiceId)||{}).name||panel.config.voiceId||"Choose a voice after refreshing";Accessible.name:"ElevenLabs voice";onActivated:panel.save({voiceId:model[currentIndex].id}) }
    CField { objectName:"elevenVoiceId";Layout.fillWidth:true;placeholderText:"Or paste an account voice ID";text:panel.config.voiceId||"";maximumLength:128;Accessible.name:"ElevenLabs voice ID";onEditingFinished:if(text!==panel.config.voiceId)panel.save({voiceId:text.trim()}) }
    CText { text:"Model";font.weight:Font.DemiBold }
    CComboBox { objectName:"elevenModel";Layout.fillWidth:true;model:panel.status.models||[];textRole:"name";currentIndex:model.findIndex(v=>v.id===panel.config.modelId);displayText:(model.find(v=>v.id===panel.config.modelId)||{}).name||panel.config.modelId||"Choose a model";Accessible.name:"ElevenLabs model";onActivated:panel.save({modelId:model[currentIndex].id}) }
    CField { objectName:"elevenModelId";Layout.fillWidth:true;placeholderText:"Model ID";text:panel.config.modelId||"";maximumLength:128;Accessible.name:"ElevenLabs model ID";onEditingFinished:if(text!==panel.config.modelId)panel.save({modelId:text.trim()}) }
    CText { text:"Flash v2.5 is the default. Account voices, including existing clones, appear after refreshing. To clone CERE, create the voice in your ElevenLabs account, then select its voice ID here.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CButton { text:"Open ElevenLabs";onClicked:Qt.openUrlExternally("https://elevenlabs.io/app/voice-lab") }
    CText { visible:!!panel.error||!!panel.status.error;text:panel.error||panel.status.error||"";color:Theme.danger;font.pixelSize:Theme.secondary }
    Connections { target:App;function onResult(id,value){if(panel.requests[id]){const next=Object.assign({},panel.requests);delete next[id];panel.requests=next;if(value?.error)panel.error=value.error}} }
}
