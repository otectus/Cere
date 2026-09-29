import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
    id:list
    signal createRequested()
    signal sessionActivated()
    function focusSearch() { filter.forceActiveFocus() }
    property var history: []
    property int historyRequest: -1
    property string error: ""
    property var filtered: (App.state.sessions||[]).filter(s=>(s.title+" "+s.cwd+" "+s.provider).toLowerCase().indexOf(filter.text.toLowerCase())>=0)
    spacing:12
    RowLayout {
        Layout.fillWidth:true
        CText { text:"Sessions";font.pixelSize:18;font.weight:Font.DemiBold }
        CButton { objectName:"newSession";text:"+ New";primary:true;onClicked:list.createRequested() }
    }
    CField { id:filter;placeholderText:"Find a session";Layout.fillWidth:true;Accessible.name:"Find a session" }
    PageScroll {
        Layout.fillWidth:true;Layout.fillHeight:true
        Repeater {
            model:list.filtered
            CActionRow {
                required property var modelData
                Layout.fillWidth:true
                objectName:"session_"+modelData.id
                text:modelData.title
                detail:modelData.provider.toUpperCase()+(modelData.parentId?" · delegated":"")+" · "+(modelData.mode==="linked"&&modelData.status==="idle"?"linked terminal":modelData.status)+"\n"+modelData.cwd
                mark:modelData.provider==="codex"?"C":modelData.provider==="claude"?"A":"O"
                primary:App.selectedId===modelData.id
                Accessible.name:modelData.title+", "+modelData.provider+", "+modelData.status
                Accessible.selected:App.selectedId===modelData.id
                onClicked:{App.selectedId=modelData.id;list.sessionActivated()}
            }
        }
        CText { visible:!list.filtered.length;text:filter.text?"No sessions match your search.":"Your next project starts here. Create a session to begin.";color:Theme.muted;font.pixelSize:12 }
        CText { visible:list.history.length>0;text:"CLI history";font.weight:Font.DemiBold }
        Repeater {
            model:list.history
            CActionRow { required property var modelData;Layout.fillWidth:true;text:modelData.title;detail:modelData.cwd||"Continue this conversation";onClicked:{importSession.imported=modelData;importSession.open()} }
        }
    }
    CText { visible:list.error.length>0;text:list.error;color:Theme.danger;font.pixelSize:12 }
    CText { text:list.historyRequest>=0?"Loading CLI history…":"Continue a completed CLI conversation";color:Theme.muted;font.pixelSize:11 }
    GridLayout {
        Layout.fillWidth:true;columns:width>=340?2:1;columnSpacing:8;rowSpacing:8
        CButton { text:"Codex history";Layout.fillWidth:true;enabled:list.historyRequest<0&&App.connected;onClicked:{list.error="";list.historyRequest=App.rpc("session.history",{provider:"codex"})} }
        CButton { text:"Claude history";Layout.fillWidth:true;enabled:list.historyRequest<0&&App.connected;onClicked:{list.error="";list.historyRequest=App.rpc("session.history",{provider:"claude"})} }
    }
    Connections { target:App;function onResult(id,value){if(id===list.historyRequest){list.historyRequest=-1;if(value?.error)list.error=value.error;else list.history=value}} }
    NewSession { id:importSession;onSessionOpened:list.sessionActivated() }
}
