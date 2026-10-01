import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:review
    width:Math.min(680,parent?parent.width-32:680)
    property string sessionId:""
    property var listing:({rows:[],assertions:[]})
    property var selected:({})
    property int offset:0
    property int request:-1
    property string operation:""
    property string feedback:""
    function call(method,args){operation=method;request=App.rpc(method,Object.assign({sessionId:sessionId},args||{}))}
    function reload(){call("memoryReview.list",{offset:offset})}
    onOpened:reload()
    CText { text:"Project memory review";font.pixelSize:22 }
    CText { text:"Proposed decisions and constraints keep their supporting passage. Confirm or Correct adds your reviewed project note and capsule entry. Keep local restricts the note to local recall.";color:Theme.muted;wrapMode:Text.Wrap }
    CButton { text:"Browse memory and older facts";onClicked:{allMemory.sessionId=review.sessionId;allMemory.open()} }
    Repeater {
        model:review.listing.rows||[]
        CButton { required property var modelData;Layout.fillWidth:true;alignLeft:true;text:modelData.sourceLabel+" · "+modelData.kind+" · "+modelData.text.slice(0,90);onClicked:{review.selected=modelData;note.text=modelData.text} }
    }
    CText { visible:!(review.listing.rows||[]).length;text:"No message proposals. Use a message’s menu to propose a decision or constraint.";color:Theme.muted }
    CText { visible:!!review.selected.id;text:review.selected.sourceLabel||"";color:Theme.amber }
    TextArea { visible:!!review.selected.id;Layout.fillWidth:true;Layout.preferredHeight:100;readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap;text:review.selected.sourceText||"";color:Theme.text;Accessible.name:"Supporting passage" }
    TextArea { id:note;visible:!!review.selected.id;Layout.fillWidth:true;Layout.preferredHeight:100;wrapMode:TextEdit.Wrap;color:Theme.text;Accessible.name:"Reviewed memory text" }
    Flow {
        Layout.fillWidth:true;spacing:6
        visible:!!review.selected.id
        Repeater {
            model:[{label:"Confirm",choice:"confirm"},{label:"Correct",choice:"correct"},{label:"Keep local",choice:"local"},{label:"Forget proposal",choice:"forget"}]
            CButton { required property var modelData;text:modelData.label;enabled:review.request<0;onClicked:review.call("memoryReview.resolve",{id:review.selected.id,expectedRevision:review.selected.currentRevision,text:note.text,choice:modelData.choice}) }
        }
    }
    CText { text:"Graph proposals and conflicts";font.bold:true }
    Repeater {
        model:review.listing.assertions||[]
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { text:(modelData.status||"Candidate")+" · "+(modelData.text||modelData.id);wrapMode:Text.Wrap }
            CButton { text:"Review evidence / correct / forget";onClicked:{inspector.sessionId=review.sessionId;inspector.open();inspector.openRecord(modelData.id)} }
        }
    }
    Repeater { model:review.listing.olderNotes||[];CButton { required property var modelData;text:"Review older note · "+modelData.text.slice(0,80);onClicked:{allMemory.sessionId=review.sessionId;allMemory.open()} } }
    RowLayout {
        CButton { text:"Previous";enabled:review.offset>0;onClicked:{review.offset=Math.max(0,review.offset-25);review.reload()} }
        CText { text:"Memory records "+(review.offset+1)+"–"+(review.offset+25);color:Theme.muted }
        CButton { text:"Next";enabled:review.offset+25<Math.max(review.listing.totalAssertions||0,review.listing.totalNotes||0);onClicked:{review.offset+=25;review.reload()} }
    }
    CText { text:review.feedback;visible:text.length>0;color:Theme.cyan;wrapMode:Text.Wrap }
    CButton { text:"Close";onClicked:review.close() }
    MemoryDialog { id:allMemory }
    GraphMemoryInspector { id:inspector }
    Connections {
        target:App
        function onResult(id,value){if(id!==review.request)return;review.request=-1;if(value&&value.error){review.feedback=String(value.error.message||value.error);return}if(review.operation==="memoryReview.list")review.listing=value;else{review.feedback=value.notice||"Saved";review.selected={};review.reload()}}
    }
}
