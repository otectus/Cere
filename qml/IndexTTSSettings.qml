import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs
ColumnLayout {
    id:panel
    objectName:"indexTtsSettings"
    Layout.fillWidth:true
    spacing:10
    property var config:App.state.settings?.indextts||({})
    property var status:App.state.indextts||({})
    property var caps:status.capabilities||({})
    property var profiles:(status.profiles||[]).filter(p=>p.version===config.version)
    property var requests:({})
    property string error:""
    property string editId:""
    property var vector:[0,0,0,0,0,0,0,0]
    property var sourceLabels:({"same-as-speaker":"Same as speaker","reference-audio":"Reference recording","vector":"Emotion vector","synthesis-text":"Derived from synthesis text","text-description":"Text description"})
    property var sources:caps.emotionModes||["same-as-speaker"]
    property var devices:[{id:"auto",label:"Automatic",precisions:["auto"]}].concat(caps.devices||[])
    property var selectedDevice:devices.find(d=>d.id===config.device)||devices[0]
    property var precisions:["auto"].concat(selectedDevice.id==="auto"?((caps.devices||[]).find(d=>d.id.startsWith("cuda:"))||caps.devices?.[0]||{}).precisions||[]:selectedDevice.precisions)
    function call(method,args){const id=App.rpc(method,args||{});if(id>=0){const r=Object.assign({},requests);r[id]=method;requests=r}error=""}
    function save(patch){call("settings.update",{indextts:patch})}
    function edit(profile){
        editId=profile?.id||"";voiceName.text=profile?.name||"";reference.text="";emotionReference.text=""
        language.currentIndex=Math.max(0,(caps.languages||[]).indexOf(profile?.language||"en"))
        source.currentIndex=Math.max(0,sources.indexOf(profile?.emotion?.source||"same-as-speaker"))
        alpha.value=profile?.emotion?.alpha===undefined?1:profile.emotion.alpha
        random.checked=profile?.emotion?.random||false;description.text=profile?.emotion?.text||""
        vector=profile?.emotion?.vector||[0,0,0,0,0,0,0,0];duration.value=profile?.durationFactor||1
    }
    function saveVoice(){
        call("indextts.saveVoice",{id:editId||undefined,name:voiceName.text,language:language.currentText,
            referencePath:reference.text||undefined,emotionReferencePath:emotionReference.text||undefined,
            durationFactor:caps.durationControl?duration.value:1,
            emotion:{source:sources[source.currentIndex],alpha:alpha.value,random:random.checked,vector:vector,text:description.text}})
    }
    Component.onCompleted:call("indextts.refresh")
    CText { text:"IndexTTS · local voice cloning";font.weight:Font.DemiBold }
    CText { text:"Audio is pipelined in completed chunks. Text, reference recordings and emotion descriptions stay on this computer.";font.pixelSize:12;color:Theme.muted }
    CComboBox {
        Layout.fillWidth:true;model:["2.5","2"];currentIndex:model.indexOf(panel.config.version||"2.5")
        Accessible.name:"IndexTTS model version";enabled:!panel.status.busy
        onActivated:{panel.edit(null);panel.save({version:currentText,precision:"auto",profileId:"",modelDir:""})}
    }
    CField { id:modelDirectory;Layout.fillWidth:true;text:panel.config.modelDir||"";placeholderText:"Model directory · blank uses the platform data directory";Accessible.name:"IndexTTS model directory" }
    CButton { text:"Save model directory";enabled:!panel.status.busy;onClicked:panel.save({modelDir:modelDirectory.text.trim()}) }
    CText {
        text:"The bilibili model license is conditional. Commercial use is subject to its terms and voice authorization; large organizations may need a separate license. You must have rights to the reference voice."
        font.pixelSize:12;color:Theme.muted
    }
    RowLayout {
        CButton { text:"Read license";onClicked:Qt.openUrlExternally("https://github.com/index-tts/index-tts/blob/d9e41aac89fd00b3d71497fddb287b7f24613712/LICENSE") }
        CButton { text:"Read disclaimer";onClicked:Qt.openUrlExternally("https://github.com/index-tts/index-tts/blob/d9e41aac89fd00b3d71497fddb287b7f24613712/DISCLAIMER") }
    }
    CCheckBox { id:license; text:"I have reviewed and accept the model license and disclaimer." }
    CCheckBox { id:installEmotion;text:"Include Qwen text emotion · about 1.13 GiB extra download";checked:panel.caps.emotionInstalled===true }
    CText { text:"Text emotion also needs additional working memory (roughly 1.1 GiB for FP16 weights, plus inference buffers). It loads on first use; on a small GPU it may run out of memory.";font.pixelSize:12;color:Theme.muted }
    GridLayout {
        Layout.fillWidth:true;columns:width>440?3:1
        CButton { text:"Download / repair";enabled:license.checked&&!panel.status.busy;onClicked:panel.call("indextts.install",{acceptLicense:true,emotion:installEmotion.checked,deepspeed:installDeepSpeed.checked}) }
        CButton { text:"Verify installation";enabled:!panel.status.busy;onClicked:panel.call("indextts.verify") }
        CButton { text:"Cancel download";enabled:panel.status.state==="downloading";onClicked:panel.call("indextts.cancelDownload") }
    }
    ProgressBar { Layout.fillWidth:true;visible:panel.status.busy;value:panel.status.progress||0;indeterminate:panel.status.state==="loading" }
    CText { text:panel.error||panel.status.message||"Not installed";color:panel.error||panel.status.code?Theme.danger:Theme.cyan;font.pixelSize:12 }
    CText { visible:!!panel.status.code;text:(panel.status.code||"")+" · "+(panel.status.recovery||"");color:Theme.muted;font.pixelSize:12 }
    RowLayout {
        CButton { text:"Refresh devices";enabled:!panel.status.busy;onClicked:panel.call("indextts.refresh") }
        CButton { text:"Load";enabled:!panel.status.busy;onClicked:panel.call("indextts.load") }
        CButton { text:"Unload";onClicked:panel.call("indextts.unload") }
    }
    CComboBox {
        Layout.fillWidth:true;model:panel.devices;textRole:"label";currentIndex:panel.devices.findIndex(d=>d.id===panel.config.device)
        Accessible.name:"IndexTTS device";enabled:!panel.status.busy
        onActivated:panel.save({device:panel.devices[currentIndex].id,precision:"auto",cudaKernel:false,deepspeed:false})
    }
    CComboBox {
        Layout.fillWidth:true;model:panel.precisions;currentIndex:panel.precisions.indexOf(panel.config.precision||"auto")
        Accessible.name:"IndexTTS precision";enabled:!panel.status.busy;onActivated:panel.save({precision:currentText})
    }
    CText { visible:panel.config.device==="cpu";text:"CPU synthesis can be much slower than playback. Only FP32 is supported on CPU.";font.pixelSize:12;color:Theme.muted }
    CText { visible:panel.caps.referenceDevice==="cpu"&&panel.caps.device?.startsWith("cuda:")===true;text:"GPU speech with CPU reference preparation saves video memory. The prepared reference is reused while the model stays loaded.";font.pixelSize:12;color:Theme.muted }
    CCheckBox { text:"Compiled CUDA kernels";checked:panel.config.cudaKernel===true;enabled:panel.caps.cudaKernel===true&&panel.config.device!=="cpu"&&!panel.status.busy;onClicked:panel.save({cudaKernel:checked}) }
    CCheckBox { id:installDeepSpeed;text:"Install experimental DeepSpeed support on the next download" }
    CCheckBox { text:"Use DeepSpeed · experimental; may be slower";checked:panel.config.deepspeed===true;enabled:panel.caps.deepspeed===true&&panel.config.device!=="cpu"&&!panel.status.busy;onClicked:panel.save({deepspeed:checked}) }
    RowLayout {
        CText { text:"Unload after idle minutes";font.pixelSize:12 }
        SpinBox { from:1;to:120;value:panel.config.idleMinutes||10;editable:true;enabled:!panel.status.busy;onValueModified:panel.save({idleMinutes:value}) }
    }
    RowLayout {
        CText { text:"Target characters per chunk";font.pixelSize:12 }
        SpinBox { from:20;to:1000;value:panel.config.chunkChars||160;editable:true;enabled:!panel.status.busy;onValueModified:panel.save({chunkChars:value}) }
    }
    CText { text:"Small GPUs use shorter chunks. Stop ends playback immediately and unloads the worker; the next request reloads the model.";color:Theme.muted;font.pixelSize:12 }
    Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
    CText { text:"Voice profiles";font.weight:Font.DemiBold }
    Repeater {
        model:panel.profiles
        delegate:ColumnLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { text:modelData.name+" · "+modelData.language+(panel.config.profileId===modelData.id?" · default":"") }
            Flow {
                Layout.fillWidth:true;spacing:6
                CButton { text:"Edit";onClicked:panel.edit(modelData) }
                CButton { text:"Preview";enabled:!panel.status.busy;onClicked:panel.call("indextts.preview",{profileId:modelData.id}) }
                CButton { text:"Set default";enabled:!panel.status.busy;onClicked:panel.save({profileId:modelData.id}) }
                CButton { text:"Delete";enabled:!panel.status.busy;onClicked:{deleteVoice.profileId=modelData.id;deleteVoice.open()} }
            }
        }
    }
    CButton { text:"New voice";onClicked:panel.edit(null) }
    CField { id:voiceName;objectName:"indexVoiceName";Layout.fillWidth:true;placeholderText:"Voice name";Accessible.name:"IndexTTS voice name" }
    CComboBox { id:language;Layout.fillWidth:true;model:panel.caps.languages||[];Accessible.name:"Voice language" }
    CText { text:"Use a clean 3–15 second recording. Cere keeps the original privately and creates a mono reference. When editing, blank paths keep existing recordings.";font.pixelSize:12;color:Theme.muted }
    RowLayout {
        Layout.fillWidth:true
        CField { id:reference;Layout.fillWidth:true;placeholderText:"Speaker reference audio path";Accessible.name:"Speaker reference path" }
        CButton { text:"Browse";onClicked:{audioFile.emotion=false;audioFile.open()} }
    }
    CComboBox {
        id:source;Layout.fillWidth:true;model:panel.sources.map(s=>panel.sourceLabels[s]);Accessible.name:"Emotion source"
        onActivated:alpha.value=["synthesis-text","text-description"].includes(panel.sources[currentIndex]) ? 0.6 : 1
    }
    CText { visible:!panel.caps.emotionInstalled;text:"Text emotion modes become available after installing Qwen and refreshing devices.";color:Theme.muted;font.pixelSize:12 }
    RowLayout {
        visible:panel.sources[source.currentIndex]==="reference-audio";Layout.fillWidth:true
        CField { id:emotionReference;Layout.fillWidth:true;placeholderText:"Emotion reference audio path";Accessible.name:"Emotion reference path" }
        CButton { text:"Browse";onClicked:{audioFile.emotion=true;audioFile.open()} }
    }
    CField { id:description;Layout.fillWidth:true;visible:panel.sources[source.currentIndex]==="text-description";placeholderText:"Describe the emotion";Accessible.name:"Emotion description" }
    ColumnLayout {
        Layout.fillWidth:true;visible:panel.sources[source.currentIndex]==="vector"
        Repeater {
            model:["Happy","Angry","Sad","Afraid","Disgusted","Melancholic","Surprised","Calm"]
            delegate:RowLayout {
                required property int index
                required property string modelData
                Layout.fillWidth:true
                CText { text:modelData;Layout.preferredWidth:95;font.pixelSize:12 }
                CSlider { Layout.fillWidth:true;from:0;to:1;stepSize:.05;value:panel.vector[index];Accessible.name:modelData;onMoved:{const v=panel.vector.slice();v[index]=value;panel.vector=v} }
            }
        }
    }
    RowLayout {
        Layout.fillWidth:true;visible:panel.sources[source.currentIndex]!=="same-as-speaker"
        CText { text:"Emotion strength · "+alpha.value.toFixed(2);font.pixelSize:12 }
        CSlider { id:alpha;Layout.fillWidth:true;from:0;to:1;stepSize:.01;value:1;Accessible.name:"Emotion strength" }
    }
    CCheckBox { id:random;visible:["vector","synthesis-text","text-description"].includes(panel.sources[source.currentIndex]);text:"Random emotion sampling · reduces cloning fidelity" }
    RowLayout {
        objectName:"indexDuration";visible:panel.caps.durationControl===true;Layout.fillWidth:true
        CText { text:"Duration · "+duration.value.toFixed(2)+"×";font.pixelSize:12 }
        CSlider { id:duration;Layout.fillWidth:true;from:.5;to:2;stepSize:.01;value:1;Accessible.name:"Duration factor" }
    }
    CButton { text:panel.editId?"Save voice changes":"Add voice";enabled:!!panel.caps.languages&&!panel.status.busy&&voiceName.text.trim().length>0;onClicked:panel.saveVoice() }
    FileDialog {
        id:audioFile
        property bool emotion:false
        title:"Choose a reference recording";nameFilters:["Audio (*.wav *.flac *.ogg)"]
        onAccepted:{const path=decodeURIComponent(selectedFile.toString().replace(/^file:\/\//,""));if(emotion)emotionReference.text=path;else reference.text=path}
    }
    Dialog {
        id:deleteVoice
        property string profileId:""
        title:"Delete voice and its recordings?";modal:true;standardButtons:Dialog.Ok|Dialog.Cancel
        onAccepted:panel.call("indextts.deleteVoice",{id:profileId})
    }
    Connections {
        target:App
        function onResult(id,value){
            const method=panel.requests[id];if(!method)return
            const r=Object.assign({},panel.requests);delete r[id];panel.requests=r
            panel.error=value?.error||""
            if(!panel.error&&method==="settings.update")panel.call("indextts.refresh")
            if(!panel.error&&method==="indextts.saveVoice")panel.edit(value)
        }
    }
}
