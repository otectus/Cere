import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M09: models on the user's own Ollama server. Cere lists, downloads one at a time, loads or unloads,
// and deletes only after confirmation, never a model in use or chosen as a default.
CDialog {
    id:models;objectName:"localModels"
    width:Math.min(640,parent?parent.width-32:640)
    property var items:[]
    property string host:""
    property int listRequest:-1
    property int request:-1
    property string busyModel:""
    property string error:""
    property string feedback:""
    property string deleteName:""
    property string pullKey:""
    readonly property var pull:App.state.modelPull||null
    readonly property bool pulling:!!pull&&!pull.done
    function openList(){error="";feedback="";reload();open()}
    function reload(){if(App.connected)listRequest=App.rpc("models.local",{})}
    function call(method,params,model,done){error="";feedback=done||"";busyModel=model||"";request=App.rpc(method,params)}
    function size(bytes){return bytes>=1e9?(bytes/1e9).toFixed(1)+" GB":Math.max(1,Math.round(bytes/1e6))+" MB"}
    CText { text:"Local models";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:"Models on your Ollama server"+(models.host?" at "+models.host:"")+". Cere does not start or stop the server.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    RowLayout {
        Layout.fillWidth:true
        CField { id:pullName;objectName:"modelPullName";Layout.fillWidth:true;placeholderText:"Model to download, such as qwen3:8b";maximumLength:200;Accessible.name:"Model to download";onAccepted:if(pullButton.enabled)pullButton.clicked() }
        CButton { id:pullButton;objectName:"modelPull";text:"Download";enabled:App.connected&&!models.pulling&&models.request<0&&pullName.text.trim().length>0;onClicked:models.call("models.pull",{model:pullName.text.trim()}) }
    }
    ColumnLayout {
        visible:!!models.pull;Layout.fillWidth:true;spacing:6
        CText {
            objectName:"modelPullStatus";Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.secondary
            color:models.pull?.status==="failed"?Theme.danger:models.pull?.status==="success"?Theme.accentText:Theme.text
            text:!models.pull?"":models.pull.status==="success"?"Downloaded "+models.pull.model+".":models.pull.status==="cancelled"?"Download of "+models.pull.model+" cancelled.":models.pull.status==="failed"?"Could not download "+models.pull.model+": "+models.pull.error
                :models.pull.model+" · "+models.pull.status+(models.pull.total?" · "+models.size(models.pull.completed)+" of "+models.size(models.pull.total):"")
        }
        Rectangle {
            visible:models.pulling&&(models.pull?.total||0)>0;Layout.fillWidth:true;height:4;radius:2;color:Theme.border
            Rectangle { width:parent.width*Math.min(1,(models.pull?.completed||0)/Math.max(1,models.pull?.total||1));height:parent.height;radius:2;color:Theme.accentText }
        }
        RowLayout {
            CButton { visible:models.pulling;text:"Cancel download";danger:true;onClicked:App.rpc("models.cancelPull",{}) }
            CButton { visible:!!models.pull&&models.pull.done;text:"Dismiss";quiet:true;onClicked:App.rpc("models.dismissPull",{}) }
        }
    }
    CText { objectName:"localModelsEmpty";visible:models.listRequest<0&&models.items.length===0&&!models.error;text:"No models on this server yet.";color:Theme.muted }
    Repeater {
        model:models.items
        Rectangle {
            id:row
            required property var modelData
            required property int index
            Layout.fillWidth:true;implicitHeight:rowColumn.implicitHeight+20;radius:Theme.radiusControl;color:Theme.raised;border.color:Theme.border
            ColumnLayout {
                id:rowColumn;anchors.fill:parent;anchors.margins:10;spacing:6
                RowLayout {
                    Layout.fillWidth:true
                    CText { objectName:"localModelName_"+row.index;Layout.fillWidth:true;text:row.modelData.name;font.weight:Font.DemiBold;elide:Text.ElideRight }
                    CText { visible:row.modelData.loaded;text:"Loaded"+(row.modelData.vram?" · "+models.size(row.modelData.vram)+" GPU":"");color:Theme.accentText;font.pixelSize:Theme.caption }
                }
                CText { Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.secondary;text:[models.size(row.modelData.size),row.modelData.parameters,row.modelData.quantization,row.modelData.family,row.modelData.remote?"cloud-hosted":""].filter(part=>!!part).join(" · ")+(row.modelData.conversations?" · named by "+row.modelData.conversations+(row.modelData.conversations===1?" conversation":" conversations"):"") }
                CText { visible:row.modelData.inUse.length>0;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.amber;font.pixelSize:Theme.caption;text:row.modelData.inUse.join(" ") }
                Flow {
                    Layout.fillWidth:true;spacing:8
                    CButton { objectName:"localModelLoad_"+row.index;visible:!row.modelData.remote;text:models.request>=0&&models.busyModel===row.modelData.name?"Working…":row.modelData.loaded?"Unload":"Load for 10 minutes";enabled:models.request<0;onClicked:models.call(row.modelData.loaded?"models.unload":"models.load",{model:row.modelData.name},row.modelData.name,row.modelData.loaded?"Unloaded "+row.modelData.name+".":"Loaded "+row.modelData.name+".") }
                    CButton { objectName:"localModelDelete_"+row.index;text:"Delete…";danger:true;enabled:models.request<0&&row.modelData.inUse.length===0;help:row.modelData.inUse.length?row.modelData.inUse.join(" "):"Delete this model from the Ollama server";onClicked:{models.deleteName=row.modelData.name;deleteConfirm.open()} }
                }
            }
        }
    }
    CText { objectName:"localModelsError";visible:!!models.error;text:models.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:!!models.feedback;text:models.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Refresh";Layout.fillWidth:true;enabled:models.listRequest<0;onClicked:models.reload() }
        CButton { text:"Close";Layout.fillWidth:true;onClicked:models.close() }
    }
    CDialog {
        id:deleteConfirm
        readonly property var target:models.items.find(item=>item.name===models.deleteName)||({})
        CText { text:"Delete "+models.deleteName+"?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"The model is removed from the Ollama server and must be downloaded again to use it."+(deleteConfirm.target.conversations?" "+deleteConfirm.target.conversations+(deleteConfirm.target.conversations===1?" conversation names":" conversations name")+" it and will need another model.":"");color:Theme.muted;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;onClicked:deleteConfirm.close() }
            CButton { objectName:"localModelDeleteConfirmed";text:"Delete model";danger:true;Layout.fillWidth:true;onClicked:{deleteConfirm.close();models.call("models.delete",{model:models.deleteName,confirmed:true},models.deleteName,"Deleted "+models.deleteName+".")} }
        }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id===models.listRequest){models.listRequest=-1;if(value?.error)models.error=String(value.error);else{models.items=value.models||[];models.host=value.host||""};return}
            if(id!==models.request)return
            models.request=-1;models.busyModel=""
            if(value?.error){models.error=String(value.error);models.feedback=""}
            else if(value?.status!==undefined)pullName.text=""
            models.reload()
        }
        function onStateChanged(){
            const key=JSON.stringify(models.pull||null)
            if(key!==models.pullKey){const finished=!!models.pull?.done&&models.pullKey!=="";models.pullKey=key;if(models.opened&&finished)models.reload()}
        }
    }
}
