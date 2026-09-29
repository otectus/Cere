import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:dialog
    objectName:"ollamaSessionDialog"
    property string sessionId:""
    property var original:({})
    property var models:[]
    property var selected:models[picker.currentIndex]||({})
    property int loadRequest:-1
    property int saveRequest:-1
    property string error:""
    function refresh(){error="";loadRequest=App.rpc("provider.models",{provider:"ollama",sessionId:sessionId})}
    onOpened:{sessionId=App.selectedId;original=App.session;models=[];assistance.checked=!!original.ollama?.tools;trust.checked=false;refresh()}
    CText { text:"Ollama conversation";font.pixelSize:20;font.weight:Font.DemiBold }
    CText { text:dialog.original.ollama?.host||"";color:Theme.muted;font.pixelSize:12 }
    CText { text:"Choose the model for your next reply. Your conversation history stays available.";color:Theme.muted;font.pixelSize:12 }
    RowLayout { Layout.fillWidth:true;CText{text:"Model";color:Theme.muted}CButton{text:"Refresh";enabled:dialog.loadRequest<0;onClicked:dialog.refresh()} }
    CComboBox { id:picker;objectName:"ollamaSessionModel";Layout.fillWidth:true;model:dialog.models;textRole:"displayName";valueRole:"id";Accessible.name:"Conversation model";onActivated:if(!(dialog.selected.capabilities||[]).includes("tools"))assistance.checked=false }
    CText { text:dialog.selected.description||"";color:Theme.muted;font.pixelSize:12 }
    CCheckBox { id:assistance;objectName:"ollamaSessionTools";text:"Enable desktop tools and delegation";enabled:(dialog.selected.capabilities||[]).includes("tools") }
    CText { text:"Uses categories enabled in Settings → AI assistance. Delegation asks for review unless CLI permission bypass is enabled. Web search and memory follow Settings in either mode.";color:Theme.muted;font.pixelSize:12 }
    CCheckBox { id:trust;visible:!App.state.settings?.bypassCliPermissions&&assistance.checked&&!dialog.original.ollama?.tools;text:"I trust this project’s CLI configuration and hooks" }
    CText { visible:trust.visible;text:dialog.original.cwd||"";color:Theme.cyan;font.pixelSize:12 }
    CText { visible:!!dialog.error;text:dialog.error;color:Theme.danger;font.pixelSize:12 }
    RowLayout {
        Layout.fillWidth:true
        CButton { Layout.fillWidth:true;text:"Cancel";onClicked:dialog.close() }
        CButton { objectName:"ollamaSessionSave";Layout.fillWidth:true;text:dialog.saveRequest>=0?"Saving…":"Apply";primary:true;enabled:App.connected&&dialog.loadRequest<0&&dialog.saveRequest<0&&!!picker.currentValue&&(!trust.visible||trust.checked);onClicked:dialog.saveRequest=App.rpc("session.configure",{id:dialog.sessionId,model:picker.currentValue,tools:assistance.checked,trusted:trust.checked}) }
    }
    Connections { target:App;function onResult(id,value){
        if(id===dialog.loadRequest){dialog.loadRequest=-1;if(value?.error)dialog.error=value.error;else{dialog.models=value;picker.currentIndex=Math.max(0,value.findIndex(m=>m.id===dialog.original.model))}}
        else if(id===dialog.saveRequest){dialog.saveRequest=-1;if(value?.error)dialog.error=value.error;else dialog.close()}
    } }
}
