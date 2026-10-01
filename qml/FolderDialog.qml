import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CDialog {
    id: dialog
    objectName: "folderDialog"
    property string mode: "create"
    property var folder: ({})
    property int requestId: -1
    property string error: ""
    signal saved(var folder)
    signal deleted(string id)

    function createFolder() {
        mode="create";folder={};folderName.text="";error="";open()
        Qt.callLater(()=>folderName.forceActiveFocus())
    }
    function renameFolder(value) {
        mode="rename";folder=value||({});folderName.text=folder.name||"";error="";open()
        Qt.callLater(()=>{folderName.forceActiveFocus();folderName.selectAll()})
    }
    function deleteFolder(value) { mode="delete";folder=value||({});error="";open() }
    function submit() {
        if(requestId>=0)return
        error=""
        if(mode==="delete") { requestId=App.rpc("folders.delete",{id:folder.id,expectedRevision:folder.revision});return }
        const name=folderName.text.trim()
        if(!name)return
        const params={name:name}
        if(mode==="rename") { params.id=folder.id;params.expectedRevision=folder.revision }
        requestId=App.rpc("folders.save",params)
    }

    CText { text:dialog.mode==="delete"?"Delete folder?":dialog.mode==="rename"?"Rename folder":"Create folder";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText {
        visible:dialog.mode==="delete"
        text:"“"+(dialog.folder.name||"This folder")+"” will be removed. Its sessions will become unfiled; no conversations will be deleted."
        color:Theme.muted
    }
    CField {
        id:folderName;objectName:"folderName";visible:dialog.mode!=="delete";Layout.fillWidth:true
        placeholderText:"Folder name";Accessible.name:"Folder name";maximumLength:80
        onAccepted:dialog.submit()
    }
    CText { visible:dialog.error.length>0;text:dialog.error;color:Theme.danger;font.pixelSize:Theme.secondary }
    RowLayout {
        Layout.fillWidth:true
        CButton { Layout.fillWidth:true;text:"Cancel";enabled:dialog.requestId<0;onClicked:dialog.close() }
        CButton {
            objectName:dialog.mode==="delete"?"confirmDeleteFolder":"saveFolder";Layout.fillWidth:true
            text:dialog.requestId>=0?"Saving…":dialog.mode==="delete"?"Delete folder":dialog.mode==="rename"?"Save name":"Create"
            primary:dialog.mode!=="delete";danger:dialog.mode==="delete"
            enabled:dialog.requestId<0&&(dialog.mode==="delete"||folderName.text.trim().length>0)
            onClicked:dialog.submit()
        }
    }
    Connections {
        target:App
        function onResult(id,value) {
            if(id!==dialog.requestId)return
            dialog.requestId=-1
            if(value?.error){dialog.error=value.error;return}
            if(dialog.mode==="delete")dialog.deleted(dialog.folder.id);else dialog.saved(value)
            dialog.close()
        }
    }
}
