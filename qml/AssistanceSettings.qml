import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › AI assistance: what assistant sessions may do on the desktop, and when they must ask.
ColumnLayout {
    id:assistance
    Layout.fillWidth:true;spacing:14
    property var settings:App.state.settings||({})
    property var categoryNames:({apps:"Applications",files:"Files and folders",windows:"Windows and workspaces",audio:"Volume and mute",media:"Media playback",capture:"Screen captures",timers:"Timers",scripts:"Saved scripts",providers:"Provider orchestration"})
    function update(value){return App.rpc("settings.update",value)}
    CSection {
        title:"Permission switches"
        description:"Prompts you can switch off for good. Questions always still need your answer."
        CCheckBox {
            objectName:"bypassCliPermissions";text:"Skip CLI permission prompts"
            Accessible.description:"Also allows authorized CLI requests from paired devices and delegated sessions. Questions still need your answer."
            checked:assistance.settings.bypassCliPermissions===true
            onClicked:assistance.update({bypassCliPermissions:checked})
        }
        CCheckBox {
            objectName:"bypassComputerPermissions";text:"Skip computer permission prompts"
            checked:assistance.settings.bypassComputerPermissions===true
            onClicked:assistance.update({bypassComputerPermissions:checked})
        }
        CText { text:"These switches stay on until you turn them off. CLI includes project trust, commands, file changes, scripts, delegation and new terminals launched through Cere. Computer includes desktop actions. Questions still require an answer.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CButton { objectName:"openPermissionCenter";text:"Permission Center and power sessions";Layout.fillWidth:true;onClicked:permissionCenter.open() }
        CText { text:"Power sessions grant project-bound access for a limited time. Power does not approve existing requests or change already-running terminals.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Desktop assistance"
        description:"Choose which actions your assistant sessions can request. Manual controls in the Desktop tab remain available."
        CComboBox {
            objectName:"assistanceProfile";Layout.fillWidth:true;Layout.minimumWidth:0;model:["Manual controls only","Scoped assistance","Broad control"]
            Accessible.name:"Desktop assistance profile"
            currentIndex:assistance.settings.profile==="manual"?0:assistance.settings.profile==="broad"?2:1
            onActivated:assistance.update({profile:["manual","scoped","broad"][currentIndex]})
        }
        GridLayout {
            objectName:"assistanceCategories"
            Layout.fillWidth:true;columns:width>=460?2:1;columnSpacing:12;rowSpacing:4
            Repeater {
                model:Object.keys(assistance.categoryNames)
                CCheckBox {
                    required property string modelData
                    text:assistance.categoryNames[modelData]
                    property bool bypassed:modelData==="scripts"||modelData==="providers"?assistance.settings.bypassCliPermissions===true:assistance.settings.bypassComputerPermissions===true
                    checked:bypassed||(assistance.settings.categories||[]).indexOf(modelData)>=0
                    enabled:!bypassed&&assistance.settings.profile!=="manual"
                    onClicked:{let c=(assistance.settings.categories||[]).filter(x=>x!==modelData);if(checked)c.push(modelData);assistance.update({categories:c})}
                }
            }
        }
        CText { text:"Provider orchestration and saved scripts follow the selected profile and grants. A power session can grant temporary access. Native CLI shell access remains outside Cere’s desktop grants.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CButton { objectName:"pauseActions";text:assistance.settings.paused?"Resume AI actions":"Pause AI actions";Layout.fillWidth:true;onClicked:assistance.update({paused:!assistance.settings.paused}) }
    }
    CSection {
        visible:assistance.settings.profile==="broad"
        title:"Standing grants"
        description:"Allow enabled desktop categories in this project for one hour. Provider delegation asks first unless CLI bypass is enabled."
        CText { text:App.session.cwd||"Select a session to grant access.";color:Theme.cyan;font.pixelSize:Theme.secondary }
        GridLayout {
            Layout.fillWidth:true;columns:width>=340?2:1;columnSpacing:8;rowSpacing:8
            CButton { objectName:"grantHour";Layout.fillWidth:true;text:"Grant for 1 hour";enabled:!!App.session.cwd;onClicked:assistance.update({grants:(assistance.settings.grants||[]).filter(g=>g.cwd!==App.session.cwd).concat((assistance.settings.categories||[]).filter(c=>c!=="providers").map(c=>({category:c,cwd:App.session.cwd,expires:Date.now()+3600000})))}) }
            CButton { objectName:"revokeGrants";Layout.fillWidth:true;text:"Revoke all";onClicked:assistance.update({grants:[]}) }
        }
        Repeater { model:assistance.settings.grants||[];CText { required property var modelData;text:modelData.category+" · expires "+new Date(modelData.expires).toLocaleTimeString(Qt.locale(),"h:mm AP");color:Theme.muted;font.pixelSize:Theme.caption } }
    }
    PermissionCenter { id:permissionCenter }
}
