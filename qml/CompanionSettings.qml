import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Cere.Native 1.0
// Settings › Companion: appearance, visibility, placement and interface size.
ColumnLayout {
    id:companion
    Layout.fillWidth:true;spacing:14
    property var settings:App.state.settings||({})
    property string savedAvatar:"cere"
    property string draftAvatar:"cere"
    property string savedPersonality:""
    property string savedName:"Cere"
    property string savedRevision:"0"
    property bool avatarConflict:false
    property bool avatarLoaded:false
    property int avatarRequestId:-1
    property string avatarError:""
    property string avatarFeedback:""
    readonly property bool avatarDirty:draftAvatar!==savedAvatar
    function update(value){return App.rpc("settings.update",value)}
    function adoptAvatar(value){
        savedAvatar=value.avatar||"cere"
        savedPersonality=value.personality??""
        savedName=value.assistantName||"Cere"
        draftAvatar=savedAvatar;savedRevision=App.state.settingsRevision||"0"
        avatarConflict=false;avatarLoaded=true
    }
    function syncAvatar(){
        const value=App.state.settings||{}
        if(!avatarLoaded||!avatarDirty)adoptAvatar(value)
        else if((value.avatar||"cere")!==savedAvatar||(value.personality??"")!==savedPersonality||(value.assistantName||"Cere")!==savedName)avatarConflict=true
        else savedRevision=App.state.settingsRevision||"0"
    }
    Component.onCompleted:syncAvatar()
    CSection {
        title:"Avatar & colors"
        description:"Choose your companion’s appearance and matching color theme."
        GridLayout {
            id:avatarGrid
            objectName:"avatarSelection";Layout.fillWidth:true
            readonly property bool compactCards:width<400
            columns:width>=340?2:1;uniformCellWidths:true;columnSpacing:12;rowSpacing:12
            Repeater {
                model:App.avatars
                CButton {
                    id:avatarCard
                    required property var modelData
                    objectName:"avatar_"+modelData.id
                    Layout.fillWidth:true;implicitHeight:avatarGrid.compactCards?180:214
                    text:modelData.label;help:modelData.description||modelData.label
                    checkable:true;autoExclusive:true
                    checked:companion.draftAvatar===modelData.id;primary:checked
                    enabled:companion.avatarRequestId<0
                    Accessible.name:modelData.label+" avatar"
                    Accessible.description:modelData.description||""
                    onClicked:{companion.draftAvatar=modelData.id;companion.avatarError="";companion.avatarFeedback=""}
                    contentItem:ColumnLayout {
                        spacing:4
                        AvatarPuppet {
                            objectName:"avatarPreview_"+avatarCard.modelData.id
                            Layout.alignment:Qt.AlignHCenter
                            Layout.preferredWidth:avatarGrid.compactCards?112:144
                            Layout.preferredHeight:avatarGrid.compactCards?121:156
                            source:App.assetPath+avatarCard.modelData.puppet.texture
                            definition:avatarCard.modelData.puppet
                            pose:avatarCard.modelData.puppet.poses["0"].joints
                        }
                        CText { text:avatarCard.modelData.label;font.weight:Font.DemiBold;horizontalAlignment:Text.AlignHCenter }
                        CText { text:(avatarCard.checked?"Selected · ":"")+(avatarCard.modelData.themeLabel||"Choose avatar");color:avatarCard.checked?Theme.accentText:Theme.muted;font.pixelSize:Theme.caption;horizontalAlignment:Text.AlignHCenter }
                    }
                }
            }
        }
        CText { text:"Save applies the avatar and matching colors throughout Cere. Name, personality and speaking voice stay independent.";color:Theme.muted;font.pixelSize:Theme.secondary }
        RowLayout {
            Layout.fillWidth:true;spacing:8
            CButton {
                objectName:"avatarSave";text:companion.avatarRequestId>=0?"Saving…":"Save avatar";primary:true;Layout.fillWidth:true
                enabled:App.connected&&companion.avatarLoaded&&companion.avatarRequestId<0&&companion.avatarDirty&&!companion.avatarConflict
                onClicked:{companion.avatarError="";companion.avatarFeedback="";companion.avatarRequestId=App.rpc("settings.update",{avatar:companion.draftAvatar,expectedRevision:companion.savedRevision,expectedIdentity:{personality:companion.savedPersonality,assistantName:companion.savedName,avatar:companion.savedAvatar}})}
            }
            CButton {
                objectName:"avatarDiscard";text:"Discard avatar change";Layout.fillWidth:true
                enabled:companion.avatarRequestId<0&&companion.avatarDirty
                onClicked:{companion.adoptAvatar(App.state.settings||{});companion.avatarError="";companion.avatarFeedback=""}
            }
        }
        CText { objectName:"avatarError";visible:!!companion.avatarError;text:companion.avatarError;color:Theme.danger;font.pixelSize:Theme.secondary }
        CText { objectName:"avatarConflict";visible:companion.avatarConflict;text:"Name, avatar or personality changed in another window. Discard the avatar draft to load the saved settings.";color:Theme.amber;font.pixelSize:Theme.secondary }
        CText { visible:!!companion.avatarFeedback;text:companion.avatarFeedback;color:Theme.accentText;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Presence"
        description:"How much of your companion you see, and when they appear."
        CText { text:"Desktop profile";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox { objectName:"desktopProfile";Layout.fillWidth:true;Layout.minimumWidth:0;model:["Normal","Focus","Gaming","Presentation"];currentIndex:["normal","focus","gaming","presentation"].indexOf(companion.settings.desktopProfile||"normal");Accessible.name:"Desktop profile";onActivated:companion.update({desktopProfile:["normal","focus","gaming","presentation"][currentIndex]}) }
        CText { text:"Profiles coordinate visibility, speech, motion and ordinary notifications. Pending approvals remain available from Cere’s tray.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"alwaysOnTop";text:"Always on top";checked:companion.settings.topmost===true;onClicked:companion.update({topmost:checked}) }
        CText { text:"Keep "+App.assistantName+" above your applications, including fullscreen windows.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"autostart";text:"Start Cere at login";checked:App.autostartEnabled();onClicked:App.setAutostart(checked) }
        CButton { objectName:"hideCere";text:(companion.settings.hidden?"Show ":"Hide ")+App.assistantName;onClicked:companion.update({hidden:!companion.settings.hidden}) }
    }
    CSection {
        title:"Placement"
        description:"Companion size and placement on each monitor."
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Character size";font.pixelSize:Theme.secondary;Layout.fillWidth:false }
            CSlider { objectName:"characterSize";Layout.fillWidth:true;Layout.minimumWidth:0;from:.5;to:3;stepSize:.25;value:companion.settings.scale||1;Accessible.name:"Character size";onMoved:App.resizePet(value) }
            Text { text:Math.round((companion.settings.scale||1)*100)+"%";color:Theme.accentText;font.family:Theme.font;font.pixelSize:Theme.secondary }
        }
        Flow {
            Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:6
            CButton { objectName:"saveHome";text:"Save monitor home";onClicked:App.saveHomePosition() }
            CButton { objectName:"goHome";text:"Go home";onClicked:App.goHomePosition() }
            CButton { objectName:"dockLeft";text:"Dock left";onClicked:App.dockPet("left") }
            CButton { objectName:"dockRight";text:"Dock right";onClicked:App.dockPet("right") }
        }
        CText { text:"Save a home on each monitor; Go home returns your companion to the one under your pointer. Docking stops roaming.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"roaming";text:"Roaming · gently follow the mouse";checked:companion.settings.roaming===true;onClicked:companion.update({roaming:checked}) }
        CText { visible:companion.settings.roaming===true;text:"Your companion follows across displays and stops short of the pointer. Hovering, dragging, open panels, fullscreen apps and active tasks pause movement.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Interface"
        description:"Scale everything in Cere’s panel and workspace."
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Interface size";Layout.fillWidth:false }
            CSlider { objectName:"interfaceScale";Layout.fillWidth:true;Layout.minimumWidth:0;from:.8;to:1.5;stepSize:.1;value:companion.settings.interfaceScale||1;Accessible.name:"Interface size";onMoved:companion.update({interfaceScale:value}) }
            CText { text:Math.round((companion.settings.interfaceScale||1)*100)+"%";Layout.fillWidth:false }
        }
    }
    Connections {
        target:App
        function onStateChanged(){companion.syncAvatar()}
        function onResult(id,value){
            if(id!==companion.avatarRequestId)return
            companion.avatarRequestId=-1
            if(value?.error){companion.avatarError=value.error;return}
            companion.adoptAvatar(value)
            companion.avatarFeedback="Saved · avatar and colors update now."
        }
    }
}
