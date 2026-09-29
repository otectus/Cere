import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:dialog;objectName:"memoryDialog"
    property string sessionId:""
    property var listing:({rows:[],total:0})
    property int offset:0
    property int requestId:-1
    property int changeId:-1
    property string error:""
    function reload(){error="";requestId=App.rpc("memory.list",{sessionId:sessionId,kind:["saved","conversation","assertions","episodes","entities"][kind.currentIndex],offset:offset,filter:filter.text})}
    onOpened:{sessionId=App.selectedId;offset=0;kind.currentIndex=0;filter.text="";listing={rows:[],total:0};reload()}
    CText { text:"Project memory";font.pixelSize:20;font.weight:Font.DemiBold }
    CButton { objectName:"openGraphInspector";text:"Graph, evidence and workspace inspector";onClicked:{graphInspector.sessionId=dialog.sessionId;graphInspector.open()} }
    GraphMemoryInspector { id:graphInspector }
    CText { text:(dialog.listing.project||"")+"\n"+(dialog.listing.host||"");color:Theme.muted;font.pixelSize:12 }
    CComboBox { id:kind;objectName:"memoryKind";Layout.fillWidth:true;model:["Saved notes","Conversation passages","Graph assertions","Task episodes","Entities"];Accessible.name:"Memory type";onActivated:{dialog.offset=0;dialog.reload()} }
    RowLayout {
        Layout.fillWidth:true
        CField { id:filter;Layout.fillWidth:true;Layout.minimumWidth:0;placeholderText:"Find text in memory";Accessible.name:"Find memory";onAccepted:{dialog.offset=0;dialog.reload()} }
        CButton { text:"Find";enabled:dialog.requestId<0;onClicked:{dialog.offset=0;dialog.reload()} }
    }
    CText { visible:kind.currentIndex===1;text:"Completed turns are recalled as excerpts. Assistant statements may be inaccurate. These passages are not saved facts.";color:Theme.muted;font.pixelSize:12 }
    CButton { objectName:"addMemory";text:"Add a saved fact";onClicked:{editor.memoryId="";memoryText.text="";editor.open()} }
    CText { visible:dialog.requestId>=0||!dialog.listing.rows.length;text:dialog.requestId>=0?"Loading…":"No memories here yet.";color:Theme.muted;font.pixelSize:12 }
    Repeater {
        model:dialog.listing.rows
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true;spacing:5
            CText { text:modelData.text;font.pixelSize:12 }
            RowLayout {
                Layout.fillWidth:true
                CText { text:modelData.updated?new Date(modelData.updated).toLocaleDateString():(modelData.status||modelData.state||modelData.type||"");color:Theme.muted;font.pixelSize:11 }
                CButton { text:"Evidence";onClicked:{graphInspector.sessionId=dialog.sessionId;graphInspector.open();graphInspector.openRecord(modelData.id)} }
                CButton { visible:modelData.kind==="saved";text:"Edit";onClicked:{editor.memoryId=modelData.id;memoryText.text=modelData.text;editor.open()} }
                CButton { text:"Forget";danger:true;enabled:dialog.changeId<0;onClicked:dialog.changeId=App.rpc("memory.forget",{sessionId:dialog.sessionId,id:modelData.id}) }
            }
            Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
        }
    }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Previous";enabled:dialog.offset>0&&dialog.requestId<0;onClicked:{dialog.offset=Math.max(0,dialog.offset-25);dialog.reload()} }
        CText { text:dialog.listing.total+" total";horizontalAlignment:Text.AlignHCenter;color:Theme.muted;font.pixelSize:12 }
        CButton { text:"Next";enabled:dialog.offset+25<dialog.listing.total&&dialog.requestId<0;onClicked:{dialog.offset+=25;dialog.reload()} }
    }
    CText { visible:!!dialog.error;text:dialog.error;color:Theme.danger;font.pixelSize:12 }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Clear this project";danger:true;Layout.fillWidth:true;onClicked:clearConfirm.open() }
        CButton { objectName:"closeMemory";text:"Done";Layout.fillWidth:true;onClicked:dialog.close() }
    }
    CDialog {
        id:editor;property string memoryId:"";property int saveId:-1;property string error:""
        onOpened:error=""
        CText { text:editor.memoryId?"Edit saved fact":"Remember a fact";font.pixelSize:20;font.weight:Font.DemiBold }
        TextArea { id:memoryText;objectName:"memoryText";Layout.fillWidth:true;Layout.preferredHeight:160;wrapMode:TextEdit.Wrap;selectByMouse:true;color:Theme.text;font.family:Theme.font;Accessible.name:"Memory text";background:Rectangle{color:Theme.input;radius:7} }
        CText { text:memoryText.length+" / 2000 characters";color:Theme.muted;font.pixelSize:12 }
        CText { visible:!!editor.error;text:editor.error;color:Theme.danger;font.pixelSize:12 }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;onClicked:editor.close() }
            CButton { objectName:"saveMemory";text:"Save";primary:true;Layout.fillWidth:true;enabled:editor.saveId<0&&memoryText.text.trim().length>0&&memoryText.length<=2000;onClicked:{let p={sessionId:dialog.sessionId,text:memoryText.text};if(editor.memoryId)p.id=editor.memoryId;editor.saveId=App.rpc("memory.save",p)} }
        }
    }
    CDialog {
        id:clearConfirm
        CText { text:"Clear this project’s memory?";font.pixelSize:20;font.weight:Font.DemiBold }
        CText { text:"This suppresses project memory and removes matching source passages from Cere’s managed chat history. Physical deletion from memory indexes continues in the background. Future turns can be remembered while memory is enabled.";color:Theme.muted }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;onClicked:clearConfirm.close() }
            CButton { text:"Clear memory";danger:true;Layout.fillWidth:true;enabled:dialog.changeId<0;onClicked:{dialog.changeId=App.rpc("memory.clear",{sessionId:dialog.sessionId});clearConfirm.close()} }
        }
    }
    Connections { target:App;function onResult(id,value){
        if(id===dialog.requestId){dialog.requestId=-1;if(value?.error)dialog.error=value.error;else dialog.listing=value}
        else if(id===editor.saveId){editor.saveId=-1;if(value?.error)editor.error=value.error;else{editor.close();dialog.offset=0;kind.currentIndex=0;dialog.reload()}}
        else if(id===dialog.changeId){dialog.changeId=-1;if(value?.error)dialog.error=value.error;else{dialog.offset=0;dialog.reload()}}
    } }
}
