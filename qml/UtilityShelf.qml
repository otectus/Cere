import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:shelf
    width:Math.min(700,parent?parent.width-32:700)
    property var entries:[]
    property var selected:({})
    property var pending:({})
    property var preview:({})
    property var routineResult:({})
    property var apps:[]
    property var windows:[]
    property string runningRoutineId:""
    property string feedback:""
    function call(method,args){const id=App.rpc(method,args||{});const p=Object.assign({},pending);p[id]=method;pending=p}
    function refresh(){call("utility.list")}
    onOpened:refresh()
    CText { text:"Offline utility shelf";font.pixelSize:Theme.page }
    CText { text:"Notes, tasks and calculations stay local and do not need a model.";color:Theme.muted }
    CSection {
        title:"Notes and tasks"
        Repeater {
            model:shelf.entries
            RowLayout {
                required property var modelData
                Layout.fillWidth:true
                CCheckBox { visible:modelData.kind==="task";checked:modelData.done;Accessible.name:"Complete "+modelData.title;onClicked:shelf.call("utility.save",Object.assign({},modelData,{done:checked,expectedRevision:modelData.revision})) }
                CButton { Layout.fillWidth:true;text:modelData.title;alignLeft:true;onClicked:{shelf.selected=modelData;entryTitle.text=modelData.title;entryText.text=modelData.text;entryKind.currentIndex=modelData.kind==="task"?1:0} }
                CButton { text:"Delete";onClicked:shelf.call("utility.delete",{id:modelData.id,expectedRevision:modelData.revision}) }
            }
        }
        CField { id:entryTitle;Layout.fillWidth:true;placeholderText:"Title";Accessible.name:"Note or task title" }
        CTextArea { color:Theme.text;wrapMode:TextEdit.Wrap;selectByMouse:true; id:entryText;Layout.fillWidth:true;placeholderText:"Details";Accessible.name:"Note or task details" }
        RowLayout {
            CComboBox { id:entryKind;model:["Note","Task"];Accessible.name:"Entry type" }
            CButton { text:shelf.selected.id?"Save changes":"Add";enabled:entryTitle.text.trim().length>0;onClicked:shelf.call("utility.save",{id:shelf.selected.id,expectedRevision:shelf.selected.revision,kind:entryKind.currentIndex?"task":"note",title:entryTitle.text,text:entryText.text,done:shelf.selected.done===true}) }
            CButton { text:"New";onClicked:{shelf.selected={};entryTitle.clear();entryText.clear()} }
        }
    }
    CSection {
        title:"Calculator and conversions"
        RowLayout {
            CField { id:expression;Layout.fillWidth:true;placeholderText:"(12 + 8) * 3";Accessible.name:"Arithmetic expression";onAccepted:shelf.call("utility.calculate",{expression:text}) }
            CButton { text:"Calculate";onClicked:shelf.call("utility.calculate",{expression:expression.text}) }
        }
        RowLayout {
            CField { id:amount;Layout.fillWidth:true;placeholderText:"Value";Accessible.name:"Conversion value" }
            CComboBox { id:fromUnit;model:["m","cm","km","in","ft","mi","g","kg","oz","lb","s","min","h","B","KiB","MiB","GiB","C","F","K"];Accessible.name:"From unit" }
            CComboBox { id:toUnit;model:fromUnit.model;currentIndex:1;Accessible.name:"To unit" }
            CButton { text:"Convert";onClicked:shelf.call("utility.convert",{value:Number(amount.text),from:fromUnit.currentText,to:toUnit.currentText}) }
        }
    }
    CSection {
        title:"Timers"
        Repeater {
            model:App.state.timers||[]
            RowLayout {
                required property var modelData
                CText { Layout.fillWidth:true;text:modelData.label+(modelData.paused?" · paused":" · "+new Date(modelData.due).toLocaleTimeString())+(modelData.repeatMinutes?" · repeats":"") }
                CButton { text:modelData.paused?"Resume":"Pause";onClicked:shelf.call(modelData.paused?"timer.resume":"timer.pause",{id:modelData.id}) }
                CButton { text:modelData.repeatMinutes?"Once":"Repeat";onClicked:shelf.call("timer.repeat",{id:modelData.id,minutes:modelData.repeatMinutes?0:Number(minutes.text)}) }
                CButton { text:"Cancel";onClicked:shelf.call("timer.cancel",{id:modelData.id}) }
            }
        }
        RowLayout {
            CField { id:timerLabel;Layout.fillWidth:true;placeholderText:"Timer label";Accessible.name:"Timer label" }
            CField { id:minutes;Layout.preferredWidth:80;text:"25";Accessible.name:"Timer minutes" }
            CButton { text:"Start";onClicked:shelf.call("action.run",{name:"timer.start",args:{minutes:Number(minutes.text),label:timerLabel.text||"Focus"}}) }
        }
    }
    CSection {
        title:"Start work routine"
        CText { text:"Open a project and optional application, move an existing window to a workspace, and start a timer. Review every step before running.";color:Theme.muted }
        CField { id:project;Layout.fillWidth:true;placeholderText:"Project folder";Accessible.name:"Routine project folder";onTextChanged:shelf.preview={} }
        CButton { text:"Load applications and windows";onClicked:{shelf.call("apps.list");shelf.call("windows.list")} }
        CComboBox { id:routineApp;Layout.fillWidth:true;model:[{id:"",name:"No application launch"}].concat(shelf.apps);textRole:"name";Accessible.name:"Application to open";onActivated:shelf.preview={} }
        CComboBox { id:routineWindow;Layout.fillWidth:true;model:[{address:"",title:"No window to move"}].concat(shelf.windows);textRole:"title";Accessible.name:"Existing window to move";onActivated:shelf.preview={} }
        RowLayout {
            CButton { text:"Choose folder";onClicked:{const path=App.chooseFolder();if(path)project.text=path} }
            CField { id:workspace;Layout.fillWidth:true;placeholderText:"Workspace number (optional)";Accessible.name:"Routine workspace";onTextChanged:shelf.preview={} }
            CButton { text:"Review";enabled:project.text.length>0&&!shelf.runningRoutineId;onClicked:{const steps=[];if(workspace.text)steps.push({name:"workspace.switch",args:{workspace:Number(workspace.text)}});const app=routineApp.model[routineApp.currentIndex];if(app?.id)steps.push({name:"apps.launch",args:{desktopId:app.id}});const window=routineWindow.model[routineWindow.currentIndex];if(window?.address){if(!workspace.text){shelf.feedback="Choose a destination workspace for the window.";return}steps.push({name:"windows.move",args:{address:window.address,workspace:Number(workspace.text)}})}steps.push({name:"files.open",args:{path:project.text}},{name:"timer.start",args:{minutes:Number(minutes.text),label:timerLabel.text||"Project focus"}});shelf.call("routine.preview",{steps:steps})} }
        }
        CText { visible:!!shelf.preview.id;text:(shelf.preview.steps||[]).map(s=>s.name+": "+JSON.stringify(s.args)).join("\n")+"\n"+(shelf.preview.undo||"");wrapMode:Text.Wrap }
        CButton { visible:!!shelf.preview.id;text:"Run reviewed steps";enabled:!shelf.runningRoutineId;onClicked:{shelf.runningRoutineId=shelf.preview.id;shelf.call("routine.run",{id:shelf.preview.id,digest:shelf.preview.digest})} }
        CButton { visible:!!shelf.runningRoutineId;text:"Cancel remaining steps";danger:true;onClicked:shelf.call("routine.cancel",{id:shelf.runningRoutineId}) }
        Repeater {
            model:shelf.routineResult.results||[]
            RowLayout {
                required property var modelData
                CText { Layout.fillWidth:true;text:modelData.name+" · completed" }
                CButton { visible:!!modelData.undoTimerId;text:"Undo timer";onClicked:shelf.call("timer.cancel",{id:modelData.undoTimerId}) }
            }
        }
    }
    CText { visible:shelf.feedback.length>0;text:shelf.feedback;Accessible.name:text;color:Theme.cyan }
    CButton { text:"Close";onClicked:shelf.close() }
    Connections {
        target:App
        function onResult(id,value){
            const method=shelf.pending[id];if(!method)return
            const p=Object.assign({},shelf.pending);delete p[id];shelf.pending=p
            if(method==="routine.run")shelf.runningRoutineId=""
            if(value&&value.error){shelf.feedback=String(value.error.message||value.error);return}
            if(method==="apps.list"){shelf.apps=value||[];return}
            if(method==="windows.list"){shelf.windows=value||[];return}
            if(method==="utility.list")shelf.entries=value||[]
            else if(method==="utility.save"||method==="utility.delete"){shelf.refresh();shelf.selected={};entryTitle.clear();entryText.clear()}
            else if(method==="utility.calculate"||method==="utility.convert")shelf.feedback="Result: "+value.value
            else if(method==="routine.preview")shelf.preview=value
            else if(method==="routine.run"){shelf.routineResult=value;shelf.preview={};shelf.feedback="Routine "+value.state+(value.error?": "+value.error:"")}
        }
    }
}
