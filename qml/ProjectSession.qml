import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CDialog {
    id:dialog
    objectName:"projectSessionDialog"
    property var project:({})
    property int requestId:-1
    property string error:""
    signal sessionOpened()
    signal settingsRequested(var project,string sessionName)
    closePolicy:requestId>=0?Popup.NoAutoClose:Popup.CloseOnEscape|Popup.CloseOnPressOutside
    function start(value,name){project=value;sessionName.text=name||"";error="";open();Qt.callLater(()=>sessionName.forceActiveFocus())}
    function submit(){
        if(!openButton.enabled)return
        error=""
        requestId=App.rpc("projects.createSession",{cwd:project.cwd,expectedRevision:project.revision,title:sessionName.text.trim()})
    }
    CText { text:"New session";font.pixelSize:Theme.page;font.weight:Font.DemiBold }
    CText { text:dialog.project.name||"Project";color:Theme.cyan;font.weight:Font.DemiBold }
    CText { text:dialog.project.cwd||"";font.pixelSize:Theme.caption;color:Theme.muted;wrapMode:Text.WrapAnywhere }
    CField {
        id:sessionName;objectName:"projectSessionName";Layout.fillWidth:true;maximumLength:100
        placeholderText:"Session name";Accessible.name:"Session name";onAccepted:dialog.submit()
    }
    CText {
        text:[dialog.project.defaults?.provider,dialog.project.defaults?.model||"Default model",dialog.project.defaults?.effort,dialog.project.defaults?.tools?"Desktop tools enabled":"",dialog.project.defaults?.temporary?"Temporary":""].filter(v=>!!v).join(" · ")
        color:Theme.muted;font.pixelSize:Theme.secondary
    }
    CText { visible:!!dialog.error;text:dialog.error;color:Theme.danger;font.pixelSize:Theme.secondary }
    CButton { objectName:"quickProjectSettings";text:"Edit project defaults";iconName:"settings";quiet:true;enabled:dialog.requestId<0;onClicked:{dialog.close();dialog.settingsRequested(dialog.project,sessionName.text)} }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Cancel";Layout.fillWidth:true;enabled:dialog.requestId<0;onClicked:dialog.close() }
        CButton { id:openButton;objectName:"openProjectSession";text:dialog.requestId>=0?"Opening…":"Open session";Layout.fillWidth:true;primary:true;enabled:App.connected&&dialog.requestId<0&&sessionName.text.trim().length>0;onClicked:dialog.submit() }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==dialog.requestId)return
            dialog.requestId=-1
            if(value?.error){dialog.error=value.error;return}
            App.selectedId=value.id
            dialog.close();dialog.sessionOpened()
        }
    }
}
