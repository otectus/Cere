import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
    id:connection
    required property string provider
    required property string label
    property var capability:(App.state.capabilities||{})[provider]||({})
    property int saveRequest:-1
    property int refreshRequest:-1
    property string error:""
    Layout.fillWidth:true;spacing:6
    CText { text:connection.label+" · "+(connection.capability.available?"Ready":connection.capability.configured?"Key configured":"Key needed");font.weight:Font.DemiBold;color:connection.capability.available?Theme.cyan:Theme.amber }
    CText { text:connection.capability.source==="environment"?"Using "+connection.capability.environment:connection.capability.source==="saved"?"Using a saved key. Leave the field empty to keep it.":"Use an API key for this provider. API usage is billed separately from chat subscriptions.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CField { id:apiKey;objectName:"apiKey_"+connection.provider;Layout.fillWidth:true;placeholderText:"API key";echoMode:TextInput.Password;maximumLength:8192;Accessible.name:connection.label+" API key"
        // Qt drops the accessible name of password fields; screen readers still announce the description.
        Accessible.description:connection.label+" API key" }
    GridLayout {
        Layout.fillWidth:true;columns:width>=520?3:1
        CButton { Layout.fillWidth:true;text:"Save key";enabled:App.connected&&connection.saveRequest<0&&apiKey.text.trim().length>0;onClicked:{connection.error="";connection.saveRequest=App.rpc("provider.credentials",{provider:connection.provider,key:apiKey.text.trim()});apiKey.clear()} }
        CButton { Layout.fillWidth:true;text:connection.capability.modelsStatus==="loading"?"Connecting…":"Connect / refresh";enabled:App.connected&&connection.saveRequest<0&&connection.capability.modelsStatus!=="loading";onClicked:{connection.error="";connection.refreshRequest=App.rpc("provider.models",{provider:connection.provider})} }
        CButton { Layout.fillWidth:true;text:"Remove saved key";visible:connection.capability.source==="saved";enabled:App.connected&&connection.saveRequest<0;onClicked:{connection.error="";connection.saveRequest=App.rpc("provider.credentials",{provider:connection.provider,key:""});apiKey.clear()} }
    }
    CText { visible:!!connection.error||!!connection.capability.modelsError;text:connection.error||connection.capability.modelsError||"";color:Theme.danger;font.pixelSize:Theme.secondary }
    Connections { target:App;function onResult(id,value){
        if(id===connection.saveRequest){connection.saveRequest=-1;if(value?.error)connection.error=value.error;else if(value?.configured)connection.refreshRequest=App.rpc("provider.models",{provider:connection.provider})}
        else if(id===connection.refreshRequest){connection.refreshRequest=-1;if(value?.error)connection.error=value.error}
    } }
}
