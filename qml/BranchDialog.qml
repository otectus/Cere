import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:branch
    property string contextText:""
    property int request:-1
    property string error:""
    onOpened:{context.text=contextText;error="";mode.currentIndex=0}
    CText { text:"Branch conversation";font.pixelSize:Theme.page }
    CComboBox { id:mode;Layout.fillWidth:true;model:App.session.provider==="codex"&&App.session.nativeId&&!App.session.temporary&&!App.session.remote?["New conversation with selected context","Native Codex history fork"]:["New conversation with selected context"];Accessible.name:"Branch type" }
    CText { text:mode.currentIndex===1?"Creates a separate provider session with the native conversation history, which may include context beyond Cere’s transcript. No message is sent by creating the fork.":"Review the selected text below. It becomes an editable draft in a new conversation; this does not fork provider history.";color:Theme.muted;wrapMode:Text.Wrap }
    CComboBox { id:provider;visible:mode.currentIndex===0;model:["codex","claude","ollama","antigravity","openai","anthropic","google"];currentIndex:model.indexOf(App.session.provider);Accessible.name:"Destination provider" }
    CField { id:branchModel;visible:mode.currentIndex===0&&["openai","anthropic","google"].includes(provider.currentText)&&provider.currentText!==App.session.provider;Layout.fillWidth:true;placeholderText:"API model ID";Accessible.name:"Branch model ID" }
    CTextArea { id:context;visible:mode.currentIndex===0;Layout.fillWidth:true;Layout.preferredHeight:220;wrapMode:TextEdit.Wrap;color:Theme.text;Accessible.name:"Reviewed branch context" }
    CText { text:branch.error;visible:text.length>0;color:Theme.danger;wrapMode:Text.Wrap }
    CButton { text:branch.request>=0?"Creating…":"Create branch";enabled:branch.request<0&&(!branchModel.visible||!!branchModel.text.trim())&&(mode.currentIndex===1||context.text.trim().length>0);onClicked:branch.request=App.rpc(mode.currentIndex===1?"session.nativeFork":"session.branch",{id:App.selectedId,text:context.text,provider:provider.currentText,model:branchModel.visible?branchModel.text.trim():"",trusted:true}) }
    CButton { text:"Cancel";onClicked:branch.close() }
    Connections { target:App;function onResult(id,value){if(id!==branch.request)return;branch.request=-1;if(value?.error)branch.error=String(value.error.message||value.error);else{App.selectedId=value.id;branch.close()}} }
}
