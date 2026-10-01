import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:recovery
    property var review:({})
    property string feedback:""
    property int request:-1
    property string operation:""
    function call(method,args){if(request>=0)return;operation=method;request=App.rpc(method,args||{})}
    CText { text:"Backup and restore";font.pixelSize:Theme.page }
    CText { visible:recovery.request>=0;text:recovery.operation==="recovery.activate"?"Staging the reviewed restore. Editing is paused until the broker restarts.":"Working…";color:Theme.amber;Accessible.name:text }
    CText { text:"Backups exclude credentials, device keys, active grants, power sessions and executable actions. Temporary conversations are excluded. Files are private but not encrypted; text you typed may contain secrets.";color:Theme.muted;wrapMode:Text.Wrap }
    CCheckBox { id:content;text:"Include conversations, draft attachments, notes and memory";checked:false;onClicked:recovery.review={} }
    CButton { text:"Create private backup";onClicked:recovery.call("recovery.backup",{includeContent:content.checked}) }
    CField { id:source;Layout.fillWidth:true;placeholderText:"Backup directory";Accessible.name:"Backup directory";onTextChanged:recovery.review={} }
    RowLayout {
        CButton { text:"Choose backup";onClicked:{const path=App.chooseFolder();if(path)source.text=path} }
        CButton { text:"Review restore";enabled:source.text.length>0;onClicked:recovery.call("recovery.preview",{directory:source.text,includeContent:content.checked}) }
    }
    CText { visible:!!recovery.review.id;text:recovery.review.id?(recovery.review.folders+" folders · "+recovery.review.sessions+" conversations · "+recovery.review.messages+" messages\n"+recovery.review.warning+"\n"+(recovery.review.memory?"Backed-up memory will be restored with current forgetting records.":"Current memory is retained.")+"\nCere will restart its broker. The previous profile is retained in a private recovery directory."):"";wrapMode:Text.Wrap }
    CButton { visible:!!recovery.review.id;text:"Restore reviewed backup and restart";enabled:recovery.request<0;onClicked:recovery.call("recovery.activate",{id:recovery.review.id,digest:recovery.review.digest}) }
    CButton { text:"Cancel a pending restore";onClicked:recovery.call("recovery.cancel") }
    CText { text:recovery.feedback;visible:text.length>0;color:Theme.cyan;wrapMode:Text.Wrap;Accessible.name:text }
    CButton { text:"Close";onClicked:recovery.close() }
    Connections {
        target:App
        function onResult(id,value){if(id!==recovery.request)return;recovery.request=-1;if(value&&value.error){recovery.feedback=String(value.error.message||value.error);return}if(recovery.operation==="recovery.preview")recovery.review=value;else if(recovery.operation==="recovery.backup"){source.text=value.directory;recovery.feedback="Backup created: "+value.directory}else if(recovery.operation==="recovery.activate")recovery.feedback="Restarting. Previous profile: "+value.previous;else recovery.feedback="Pending restore cancelled."}
    }
}
