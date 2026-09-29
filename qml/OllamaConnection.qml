import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
    id:connection
    Layout.fillWidth:true;spacing:10
    property var settings:App.state.settings?.ollama||({host:"http://127.0.0.1:11434",model:""})
    property var capability:App.state.capabilities?.ollama||({})
    property var choices:[{id:"",displayName:"Choose for each conversation"}].concat(capability.models||[]).concat(settings.model&&!(capability.models||[]).some(m=>m.id===settings.model)?[{id:settings.model,displayName:settings.model+" · unavailable"}]:[])
    property int saveRequest:-1
    property int refreshRequest:-1
    property string error:""
    property bool connecting:false
    CText { text:"Ollama · "+(connection.capability.modelsStatus==="loading"?"Connecting…":connection.capability.available?"Ready":"Unavailable");color:connection.capability.available?Theme.cyan:Theme.amber;font.weight:Font.DemiBold }
    CText { text:"Server URL";color:Theme.muted;font.pixelSize:12 }
    RowLayout {
        Layout.fillWidth:true
        CField { id:host;objectName:"ollamaHost";Layout.fillWidth:true;text:connection.settings.host;placeholderText:"http://127.0.0.1:11434";Accessible.name:"Ollama server URL" }
        CButton { objectName:"ollamaConnect";text:"Connect";enabled:App.connected&&connection.saveRequest<0;onClicked:{connection.connecting=true;connection.error="";connection.saveRequest=App.rpc("settings.update",{ollama:{host:host.text.trim()}})} }
    }
    CText { text:"Messages go to this server. Models marked Cloud run through Ollama Cloud. Existing conversations keep their server.";color:Theme.muted;font.pixelSize:11 }
    RowLayout {
        Layout.fillWidth:true
        CText { text:"Default model for new conversations";color:Theme.muted;font.pixelSize:12 }
        CButton { objectName:"ollamaModelsRefresh";text:"Refresh";enabled:App.connected&&connection.capability.modelsStatus!=="loading";onClicked:{connection.error="";connection.refreshRequest=App.rpc("provider.models",{provider:"ollama"})} }
    }
    CComboBox {
        objectName:"ollamaDefaultModel";Layout.fillWidth:true;model:connection.choices;textRole:"displayName";valueRole:"id";Accessible.name:"Default Ollama model"
        enabled:App.connected&&connection.saveRequest<0&&connection.capability.modelsStatus==="ready"
        currentIndex:Math.max(0,connection.choices.findIndex(m=>m.id===connection.settings.model))
        onActivated:{connection.connecting=false;connection.error="";connection.saveRequest=App.rpc("settings.update",{ollama:{model:currentValue}})}
    }
    CText { visible:connection.capability.modelsStatus==="ready"&&!(connection.capability.models||[]).length;text:"No chat models are available. Pull a chat model with Ollama, then Refresh.";color:Theme.amber;font.pixelSize:12 }
    CText { visible:!!connection.error||!!connection.capability.modelsError;text:connection.error||connection.capability.modelsError||"";color:Theme.danger;font.pixelSize:12 }
    Connections { target:App;function onResult(id,value){
        if(id===connection.saveRequest){connection.saveRequest=-1;if(value?.error)connection.error=value.error;else{host.text=connection.settings.host;if(connection.connecting&&connection.capability.modelsStatus!=="loading")connection.refreshRequest=App.rpc("provider.models",{provider:"ollama"})}}
        else if(id===connection.refreshRequest){connection.refreshRequest=-1;if(value?.error)connection.error=value.error}
    } }
}
