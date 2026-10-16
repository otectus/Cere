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
    // Saved styles: named copies of personality text. Loading one only fills the editor.
    property var presetCatalog:({revision:"",items:[]})
    readonly property var presets:presetCatalog.items||[]
    readonly property var selectedPreset:presetPicker.currentIndex>=0&&presetPicker.currentIndex<presets.length?presets[presetPicker.currentIndex]:null
    property int presetsRequest:-1
    property int presetRequest:-1
    property string presetError:""
    // The instruction preview has its own request and remembers the editor text it rendered.
    property bool previewOpen:false
    property var preview:({})
    property int previewRequest:-1
    property string previewFingerprint:""
    property string previewShown:""
    property string previewError:""
    readonly property bool previewStale:preview.draft!==undefined&&(previewShown!==fingerprint()||preview.settingsRevision!==(App.state.settingsRevision||"0"))
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
    function fingerprint(){return JSON.stringify([editor.text,nameField.text])}
    function requestPreview(){
        previewDelay.stop()
        if(!App.connected||!previewOpen)return
        previewFingerprint=fingerprint()
        previewRequest=App.rpc("personality.preview",{personality:editor.text,assistantName:nameField.text})
    }
    function schedulePreview(){if(previewOpen)previewDelay.restart()}
    function loadPresets(){if(App.connected&&presetsRequest<0)presetsRequest=App.rpc("presets.list",{})}
    function adoptPresets(catalog){
        const selected=selectedPreset?.id||""
        presetCatalog=catalog||({revision:"",items:[]})
        const index=presets.findIndex(item=>item.id===selected)
        presetPicker.currentIndex=index>=0?index:presets.length?0:-1
    }
    function loadPreset(){
        const preset=selectedPreset;if(!preset)return
        // Only unsaved personality edits that differ from the style would be lost.
        if(editor.text!==savedBaseline&&editor.text!==preset.text)replaceConfirm.open()
        else applyPreset()
    }
    function applyPreset(){
        const preset=selectedPreset;if(!preset)return
        editor.text=preset.text
        feedback="Loaded “"+preset.label+"” into the editor. Save changes to apply it."
    }
    function savePreset(replace){
        presetError="";feedback=""
        const preset=selectedPreset
        if(replace&&!preset)return
        const label=presetLabel.text.trim()||(replace?preset.label:"")
        presetRequest=App.rpc("presets.save",replace?{id:preset.id,label:label,text:editor.text,expectedItemRevision:preset.revision}:{label:label,text:editor.text,expectedRevision:presetCatalog.revision||"0"})
    }
    function deletePreset(){
        const preset=selectedPreset;if(!preset)return
        presetError="";feedback=""
        presetRequest=App.rpc("presets.delete",{id:preset.id,expectedItemRevision:preset.revision})
    }
    Component.onCompleted:{syncSaved();loadPresets()}
    CText { text:"Name";font.weight:Font.DemiBold }
    CField {
        id:nameField;objectName:"assistantName";Layout.fillWidth:true
        placeholderText:"Cere";maximumLength:64;readOnly:personality.requestId>=0
        Accessible.name:"Assistant name"
        onTextChanged:{personality.error="";personality.feedback="";personality.schedulePreview()}
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
            onTextChanged:{personality.error="";personality.feedback="";personality.schedulePreview()}
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
    CText { objectName:"personalityFeedback";visible:!!personality.feedback;text:personality.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary }

    CText { text:"Saved styles";font.weight:Font.DemiBold }
    CText { text:"Keep named copies of personality text. Loading a style only fills the editor; Save changes applies it. A project or a single conversation can also use a saved style, from project settings or the conversation’s Style tool. Styles never change the name, avatar, voice or models, and can withhold Cere tools but never grant them.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    GridLayout {
        Layout.fillWidth:true;columns:width>=480?2:1;columnSpacing:8;rowSpacing:8
        CComboBox {
            id:presetPicker;objectName:"behaviorPresetPicker";Layout.fillWidth:true
            model:personality.presets;textRole:"label";enabled:personality.presets.length>0
            displayText:personality.presets.length?currentText:"No saved styles yet"
            Accessible.name:"Saved style"
        }
        CButton {
            objectName:"behaviorPresetLoad";Layout.fillWidth:true;text:"Load into editor"
            enabled:!!personality.selectedPreset&&personality.requestId<0&&personality.presetRequest<0&&!editor.readOnly
            onClicked:personality.loadPreset()
        }
        CField {
            id:presetLabel;objectName:"behaviorPresetLabel";Layout.fillWidth:true
            placeholderText:"Name for the editor text";maximumLength:80
            Accessible.name:"Saved style name"
            onTextChanged:personality.presetError=""
        }
        CButton {
            objectName:"behaviorPresetSave";Layout.fillWidth:true;text:"Save editor as a new style"
            enabled:App.connected&&personality.presetRequest<0&&presetLabel.text.trim().length>0&&editor.length<=personality.maximumLength
            onClicked:personality.savePreset(false)
        }
        CButton {
            objectName:"behaviorPresetUpdate";Layout.fillWidth:true;text:"Replace selected style with editor text"
            enabled:App.connected&&!!personality.selectedPreset&&personality.presetRequest<0&&editor.length<=personality.maximumLength&&(editor.text!==personality.selectedPreset.text||(presetLabel.text.trim().length>0&&presetLabel.text.trim()!==personality.selectedPreset.label))
            onClicked:personality.savePreset(true)
        }
        CButton {
            objectName:"behaviorPresetDelete";Layout.fillWidth:true;text:"Delete selected style";danger:true
            enabled:App.connected&&!!personality.selectedPreset&&personality.presetRequest<0
            onClicked:deleteConfirm.open()
        }
    }
    CText { objectName:"behaviorPresetError";visible:!!personality.presetError;text:personality.presetError;color:Theme.danger;font.pixelSize:Theme.secondary }
    GridLayout {
        Layout.fillWidth:true;columns:width>=480?3:1;columnSpacing:8;rowSpacing:8
        CButton { objectName:"behaviorPresetDetails";Layout.fillWidth:true;text:"Style details…";help:"Traits, standing instructions, tool limits, formatting checks and checkpoints";enabled:App.connected&&!!personality.selectedPreset&&personality.presetRequest<0;onClicked:{profileEditor.load(personality.selectedPreset);profileEditor.open()} }
        CButton { objectName:"packageExport";Layout.fillWidth:true;text:"Export styles and recipes…";enabled:App.connected;onClicked:packageDialog.openExport() }
        CButton { objectName:"packageImport";Layout.fillWidth:true;text:"Import a package…";enabled:App.connected;onClicked:{const path=App.chooseFile();if(path)packageDialog.previewFile(path)} }
    }
    BehaviorProfileEditor { id:profileEditor }
    PackageDialog { id:packageDialog }

    CButton {
        objectName:"personalityPreviewToggle";Layout.fillWidth:true;quiet:true;alignLeft:true
        text:(personality.previewOpen?"▾  ":"▸  ")+"Preview the personality instructions"
        help:"Show the exact personality block Cere adds for this draft and for the saved settings"
        Accessible.description:help
        onClicked:{personality.previewOpen=!personality.previewOpen;if(personality.previewOpen)personality.requestPreview()}
    }
    ColumnLayout {
        visible:personality.previewOpen;Layout.fillWidth:true;spacing:8
        CText { text:personality.preview.note||"Cere’s personality block. Provider and project instructions may add other context.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CText {
            objectName:"personalityPreviewStatus"
            text:personality.previewError?personality.previewError
                :personality.previewRequest>=0?"Updating the preview…"
                :personality.preview.draft===undefined?""
                :personality.previewStale?"Out of date · the editor or saved settings changed since this preview."
                :personality.preview.matchesSaved?"The draft matches the saved block.":"The draft differs from the saved block."
            color:personality.previewError?Theme.danger:personality.previewStale?Theme.amber:Theme.muted;font.pixelSize:Theme.secondary
        }
        CText { text:"Draft · "+(personality.preview.characters?.draft||0)+" characters";font.pixelSize:Theme.caption;color:Theme.muted }
        ScrollView {
            Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredHeight:180;clip:true
            ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar {}
            CTextArea { objectName:"personalityPreviewDraft";readOnly:true;textFormat:TextEdit.PlainText;wrapMode:TextEdit.Wrap;selectByMouse:true;font.family:Theme.font;font.pixelSize:Theme.secondary;padding:10;text:personality.preview.draft||"";Accessible.name:"Draft personality instructions" }
        }
        CText { text:"Saved · settings revision "+(personality.preview.settingsRevision||"0")+" · "+(personality.preview.characters?.saved||0)+" characters";font.pixelSize:Theme.caption;color:Theme.muted }
        ScrollView {
            Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredHeight:180;clip:true
            ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar {}
            CTextArea { objectName:"personalityPreviewSaved";readOnly:true;textFormat:TextEdit.PlainText;wrapMode:TextEdit.Wrap;selectByMouse:true;font.family:Theme.font;font.pixelSize:Theme.secondary;padding:10;text:personality.preview.saved||"";Accessible.name:"Saved personality instructions" }
        }
        CButton { objectName:"personalityPreviewRefresh";text:"Refresh preview";quiet:true;enabled:App.connected&&personality.previewRequest<0;onClicked:personality.requestPreview() }
    }
    Timer { id:previewDelay;interval:250;repeat:false;onTriggered:personality.requestPreview() }
    CDialog {
        id:replaceConfirm;objectName:"behaviorPresetReplaceConfirm"
        CText { text:"Replace your unsaved edits?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Loading “"+(personality.selectedPreset?.label||"")+"” replaces the personality text you have not saved. The saved personality stays in effect until you save.";color:Theme.muted;wrapMode:Text.Wrap }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Keep editing";onClicked:replaceConfirm.close() }
            CButton { objectName:"behaviorPresetReplace";Layout.fillWidth:true;text:"Replace editor text";primary:true;onClicked:{replaceConfirm.close();personality.applyPreset()} }
        }
    }
    CDialog {
        id:deleteConfirm;objectName:"behaviorPresetDeleteConfirm"
        CText { text:"Delete “"+(personality.selectedPreset?.label||"")+"”?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Only the saved copy is removed. The personality in use and the editor text do not change.";color:Theme.muted;wrapMode:Text.Wrap }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";onClicked:deleteConfirm.close() }
            CButton { objectName:"behaviorPresetDeleteConfirmed";Layout.fillWidth:true;text:"Delete style";danger:true;onClicked:{deleteConfirm.close();personality.deletePreset()} }
        }
    }
    Connections {
        target:App
        function onStateChanged(){
            personality.syncSaved()
            if((App.state.behaviorPresets?.revision||"")!==(personality.presetCatalog.revision||""))personality.loadPresets()
            if(personality.previewOpen&&personality.preview.settingsRevision!==undefined&&personality.preview.settingsRevision!==(App.state.settingsRevision||"0"))personality.schedulePreview()
        }
        function onResult(id,value){
            if(id===personality.presetsRequest){
                personality.presetsRequest=-1
                if(value?.error)personality.presetError=value.error
                else personality.adoptPresets(value)
                return
            }
            if(id===personality.presetRequest){
                personality.presetRequest=-1
                if(value?.error){personality.presetError=value.error;return}
                presetLabel.text="";personality.presetsRequest=-1;personality.loadPresets()
                personality.feedback=value?.items?"Deleted the saved style. The personality in use is unchanged.":"Saved “"+(value?.label||"")+"”. The personality in use is unchanged."
                return
            }
            if(id===personality.previewRequest){
                personality.previewRequest=-1
                // A response for text the editor no longer holds is dropped; the newer text is previewed instead.
                if(personality.previewFingerprint!==personality.fingerprint()){personality.schedulePreview();return}
                if(value?.error){personality.previewError=value.error;personality.preview=({})}
                else{personality.previewError="";personality.preview=value;personality.previewShown=personality.previewFingerprint}
                return
            }
            if(id!==personality.requestId)return
            personality.requestId=-1
            if(value?.error){personality.error=value.error;return}
            personality.adopt(value)
            personality.feedback="Saved · labels update now; conversation changes apply on the next reply."
        }
    }
}
