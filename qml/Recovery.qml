import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CDialog {
    id:recovery
    accessibleTitle:"Backup and restore"
    objectName:"recoveryDialog"
    property var review:({})
    property string feedback:""
    property bool failed:false
    property int request:-1
    property string operation:""
    readonly property bool compactForm:width<440
    function call(method,args){if(request>=0)return;operation=method;feedback="";failed=false;request=App.rpc(method,args||{})}

    CText { text:recovery.accessibleTitle;font.pixelSize:Theme.page;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading }
    CText {
        text:"Back up your conversations and review what will change before restoring a profile. Credentials and active permissions stay with this computer."
        color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap
    }
    CText { visible:recovery.request>=0;text:recovery.operation==="recovery.activate"?"Staging the reviewed restore. Editing is paused until the broker restarts.":"Working…";color:Theme.amber;Accessible.name:text }

    CText { visible:!App.connected;text:"Reconnect to create a backup or review a restore.";color:Theme.amber;wrapMode:Text.Wrap }
    CSection {
        title:"Create a backup"
        description:"Settings are always included. Choose whether to add private conversation content and file bytes."
        CCheckBox { id:content;text:"Include conversations, draft attachments, notes, conversation files and memory";checked:false;onClicked:recovery.review={} }
        CCheckBox {
            id:artifactBytes;objectName:"backupArtifactBytes";visible:content.checked
            text:"Include the contents of conversation files (images, imports, results)";checked:true
            Accessible.description:"Without them a restore keeps each file's record but not its bytes"
        }
        CText {
            Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.caption
            text:"Backups exclude credentials, device keys, active grants, power sessions, executable actions and temporary conversations. They are private but not encrypted."
        }
        CButton {
            objectName:"createBackup";Layout.fillWidth:true;primary:true;prominent:true
            text:recovery.request>=0&&recovery.operation==="recovery.backup"?"Creating backup…":"Create private backup"
            enabled:App.connected && recovery.request<0
            onClicked:recovery.call("recovery.backup",{includeContent:content.checked,includeArtifactBytes:artifactBytes.checked})
        }
    }

    CSection {
        title:"Restore from a backup"
        description:"Review the exact contents and replacement behavior before Cere changes anything. This computer keeps its connections, keys, paired phones and preferences."
        CField { id:source;objectName:"restoreDirectory";Layout.fillWidth:true;placeholderText:"Backup directory";Accessible.name:"Backup directory";onTextChanged:recovery.review={} }
        GridLayout {
            Layout.fillWidth:true;columns:recovery.compactForm?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space2
            CButton { Layout.fillWidth:true;text:"Choose backup";enabled:App.connected && recovery.request<0;onClicked:{const path=App.chooseFolder();if(path)source.text=path} }
            CButton { objectName:"reviewRestore";Layout.fillWidth:true;text:"Review restore";enabled:App.connected && recovery.request<0&&source.text.length>0;onClicked:recovery.call("recovery.preview",{directory:source.text,includeContent:content.checked}) }
        }
        CText {
            objectName:"restoreReview";visible:!!recovery.review.id;Layout.fillWidth:true
            text:recovery.review.id?(recovery.review.folders+" folders · "+recovery.review.sessions+" conversations · "+recovery.review.messages+" messages"+(recovery.review.artifacts?" · "+recovery.review.artifacts.artifacts+" files"+(recovery.review.artifacts.missingBytes?" ("+recovery.review.artifacts.missingBytes+" versions would come back without their contents)":""):"")+"\n"+recovery.review.warning+"\n"+(recovery.review.replaced||"")+"\n"+(recovery.review.kept||"")+"\n"+(recovery.review.memory?"Backed-up memory will be restored with current forgetting records.":"Current memory is retained.")+"\nCere will restart its broker. The previous profile, including its backups folder, is retained in a private recovery directory."):""
            wrapMode:Text.Wrap;color:Theme.text;font.pixelSize:Theme.secondary
        }
        CButton {
            objectName:"activateRestore";visible:!!recovery.review.id;Layout.fillWidth:true;danger:true
            text:recovery.request>=0&&recovery.operation==="recovery.activate"?"Preparing restore…":"Restore reviewed backup and restart"
            enabled:App.connected && recovery.request<0
            onClicked:recovery.call("recovery.activate",{id:recovery.review.id,digest:recovery.review.digest})
        }
    }

    CSection {
        title:"Pending restore"
        description:"If a previously staged restore has not restarted Cere yet, cancel it here."
        CButton { objectName:"cancelRestore";Layout.fillWidth:true;text:"Cancel a pending restore";enabled:App.connected && recovery.request<0;onClicked:recovery.call("recovery.cancel") }
    }

    CText { text:recovery.feedback;visible:text.length>0;color:recovery.failed?Theme.danger:Theme.accentText;wrapMode:Text.Wrap;Accessible.name:text }
    footerContent:Component {
        CButton { Layout.fillWidth:true;text:"Close";enabled:recovery.request<0;onClicked:recovery.close() }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==recovery.request)return
            recovery.request=-1
            if(value&&value.error){recovery.failed=true;recovery.feedback=String(value.error.message||value.error);return}
            if(recovery.operation==="recovery.preview")recovery.review=value
            else if(recovery.operation==="recovery.backup"){source.text=value.directory;recovery.feedback="Backup created: "+value.directory}
            else if(recovery.operation==="recovery.activate")recovery.feedback="Restarting. Previous profile: "+value.previous
            else recovery.feedback="Pending restore cancelled."
        }
    }
}
