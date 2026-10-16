import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CDialog {
    id:workflow
    objectName:"workflowsDialog"
    ListModel { id:inputDefinitions }
    // A06: recipes travel in the same reviewed packages as saved styles.
    PackageDialog { id:recipePackages;onClosed:if(workflow.opened)workflow.loadRecipes() }
    property int tab:0
    property int requestId:-1
    property string action:""
    property string error:""
    property string feedback:""
    property var relatedSessions:[]
    property int relatedRequest:-1
    property string relatedSelection:""
    property var capsule:({revision:"0",sources:[],relevantSessionIds:[]})
    property var recipes:[]
    property var recipeVersions:[]
    property var selectedRecipe:recipes.length?recipes[Math.max(0,recipePicker.currentIndex)]:null
    property var recipeValues:({})
    property bool newDefinition:false
    property var preview:null
    property var schedules:[]
    function loadSchedules(){const id=App.rpc("schedules.list",{});scheduleRequests=Object.assign({},scheduleRequests,{[id]:true})}
    property var scheduleRequests:({})
    property var results:[]
    property var checkResult:({})
    property var checkScript:({})
    signal sessionRequested(string id)

    component Editor:CTextArea {
        Layout.fillWidth:true;Layout.preferredHeight:100
        textFormat:TextEdit.PlainText;wrapMode:TextEdit.Wrap;selectByMouse:true
        font.family:Theme.font;font.pixelSize:Theme.secondary;padding:10
    }
    function failure(value){return typeof value?.error==="string"?value.error:value?.error?.message||value?.message||"The workflow request failed."}
    function call(method,params){if(requestId>=0)return;error="";feedback="";action=method;requestId=App.rpc(method,params||{})}
    // Saved scripts for this project; the list changes only when its content does, not on every snapshot.
    readonly property string projectScriptsKey:JSON.stringify((App.state.settings?.scripts||[]).filter(script=>script.cwd===capsule.cwd))
    property var projectScripts:JSON.parse(projectScriptsKey)
    onProjectScriptsKeyChanged:projectScripts=JSON.parse(projectScriptsKey)
    function lines(value){return String(value||"").split("\n").map(item=>item.trim()).filter(item=>item.length>0)}
    function syncCapsule(value){
        capsule=value||({revision:"0",sources:[],relevantSessionIds:[]})
        capsuleGoal.text=capsule.goal||"";decisions.text=(capsule.decisions||[]).join("\n");constraints.text=(capsule.constraints||[]).join("\n")
        questions.text=(capsule.questions||[]).join("\n");relatedSelection=(capsule.relevantSessionIds||[]).join(", ")
    }
    // Project tasks: shown by state; every change is one capsules.task call with the capsule revision.
    property bool showDropped:false
    property var doneTask:null
    property var passingResults:[]
    property int passingRequest:-1
    readonly property var taskOrder:({proposed:0,active:1,accepted:2,done:3,dropped:4})
    readonly property var visibleTasks:(capsule.tasks||[]).filter(task=>showDropped||task.state!=="dropped").slice().sort((a,b)=>(taskOrder[a.state]-taskOrder[b.state])||(b.updated-a.updated))
    function stateLabel(task){return ({proposed:"Proposed",accepted:"Next",active:"In progress",done:"Done",dropped:"Dropped"})[task.state]||task.state}
    function originLabel(task){return task.origin==="model-suggestion"?"Model suggestion":task.origin==="observed"?"Observed in a tool or document":"Your task"}
    function taskDetail(task){
        const parts=[stateLabel(task)+" · "+originLabel(task)]
        if(task.completion)parts.push(task.completion.kind==="observed-check"?"Completed by a passing reviewed check":"Completed by your decision: "+(task.completion.note||""))
        if((task.files||[]).length)parts.push("Files: "+task.files.join(", "))
        return parts.join(" · ")
    }
    function changeTask(params){call("capsules.task",Object.assign({sessionId:App.selectedId,expectedRevision:capsule.revision||"0"},params))}
    function transition(task,state,completion){changeTask({op:"transition",taskId:task.id,expectedTaskRevision:task.revision,state:state,completion:completion})}
    function openDone(task){doneTask=task;passingResults=[];doneNote.text="";doneDialog.open();passingRequest=App.rpc("results.list",{cwd:capsule.cwd||App.session.cwd,limit:50})}
    function loadProject(){if(App.selectedId){call("capsules.get",{sessionId:App.selectedId});relatedRequest=App.rpc("sessions.list",{cwd:App.session.cwd,limit:100})}}
    function loadRecipes(){call("recipes.list",{})}
    function loadResults(){call("results.list",{limit:100})}
    function refresh(){if(tab===0)loadProject();else if(tab===1){loadRecipes();loadSchedules()}else loadResults()}
    function chooseRecipe(){
        newDefinition=false
        preview=null;error="";feedback="";recipeValues={}
        const recipe=selectedRecipe;if(!recipe)return
        const values={};for(const input of recipe.inputs||[])if(input.default!==undefined)values[input.name]=input.default;recipeValues=values
        recipeName.text=recipe.name||"";recipeDescription.text=recipe.description||"";recipeInstructions.text=recipe.instructions||"";recipeOutput.text=recipe.expectedOutput||"";recipeSections.text=(recipe.outputSections||[]).join("\n")
        recipePermissions.text=recipe.permissions?.description||"";recipeAccess.text=(recipe.permissions?.nativeAccess||[]).join("\n");inputDefinitions.clear();for(const input of recipe.inputs||[])inputDefinitions.append({inputName:input.name,label:input.label,inputType:input.type,isRequired:input.required===true,hasDefault:input.default!==undefined,defaultText:input.default===undefined?"":String(input.default)});recipeSeconds.value=recipe.runtime?.maxSeconds||300
    }
    function definitionInputs(){
        const inputs=[]
        for(let i=0;i<inputDefinitions.count;i++){const row=inputDefinitions.get(i),value={name:row.inputName,label:row.label,type:row.inputType,required:row.isRequired};if(row.hasDefault)value.default=row.inputType==="number"?Number(row.defaultText):row.inputType==="boolean"?row.defaultText==="true":row.defaultText;inputs.push(value)}
        return inputs
    }
    function inputPayload(){
        const recipe=selectedRecipe,result={}
        for(const input of recipe?.inputs||[]){let value=recipeValues[input.name];if(input.type==="number"&&value!==undefined&&value!=="")value=Number(value);result[input.name]=value}
        return result
    }
    // The tab to show when the dialog next opens: the command palette asks for Recipes once, and
    // every other opening starts on Project. Changing the tab refreshes it; one request at a time.
    property int requestedTab:0
    function openRecipes(){requestedTab=1;open()}
    onOpened:{const next=requestedTab;requestedTab=0;if(tab!==next)tab=next;else refresh()}
    onTabChanged:if(opened)refresh()

    RowLayout {
        Layout.fillWidth:true
        CText { text:"Project workflows";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CButton { text:"Refresh";quiet:true;enabled:workflow.requestId<0&&App.connected;onClicked:workflow.refresh() }
    }
    RowLayout {
        Layout.fillWidth:true;spacing:5
        Repeater {
            model:["Project","Recipes","Results"]
            CButton { required property string modelData;required property int index;objectName:"workflowTab"+index;Layout.fillWidth:true;Layout.preferredWidth:1;text:modelData;primary:workflow.tab===index;Accessible.role:Accessible.PageTab;Accessible.selected:workflow.tab===index;onClicked:workflow.tab=index }
        }
    }
    CText { visible:!App.selectedId&&workflow.tab!==2;text:"Select a saved session to use project workflows.";color:Theme.amber }

    ColumnLayout {
        visible:workflow.tab===0;Layout.fillWidth:true;spacing:10
        CText { text:"Project capsule";font.weight:Font.DemiBold }
        CText { text:"Scoped to the selected session’s exact working folder. Worktree grouping never merges capsules or changes permissions, memory, or the working directory.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CText { text:"Goal";color:Theme.muted;font.pixelSize:Theme.caption }
        CField { id:capsuleGoal;objectName:"capsuleGoal";Layout.fillWidth:true;placeholderText:"What is this project trying to achieve?";Accessible.name:"Project goal" }
        CText { text:"Decisions · one per line";color:Theme.muted;font.pixelSize:Theme.caption }
        Editor { id:decisions;objectName:"capsuleDecisions";Accessible.name:"Project decisions" }
        CText { text:"Constraints · one per line";color:Theme.muted;font.pixelSize:Theme.caption }
        Editor { id:constraints;objectName:"capsuleConstraints";Accessible.name:"Project constraints" }
        CText { text:"Open questions · one per line";color:Theme.muted;font.pixelSize:Theme.caption }
        Editor { id:questions;objectName:"capsuleQuestions";Accessible.name:"Project questions" }
        CText { text:"Tasks";font.weight:Font.DemiBold }
        CText { text:"Suggestions from replies stay proposed until you accept them. Done needs a passing reviewed check from Results, or your own decision with a reason.";color:Theme.muted;font.pixelSize:Theme.secondary }
        RowLayout {
            Layout.fillWidth:true
            CField { id:newTask;objectName:"capsuleNewTask";Layout.fillWidth:true;placeholderText:"Add a next step";Accessible.name:"New project task";onAccepted:if(text.trim()&&workflow.requestId<0){workflow.changeTask({op:"add",text:text});text=""} }
            CButton { objectName:"capsuleAddTask";text:"Add";enabled:workflow.requestId<0&&!!App.selectedId&&newTask.text.trim().length>0;onClicked:{workflow.changeTask({op:"add",text:newTask.text});newTask.text=""} }
        }
        Repeater {
            model:workflow.visibleTasks
            Rectangle {
                id:taskCard
                required property var modelData
                required property int index
                objectName:"capsuleTask_"+index
                Layout.fillWidth:true;implicitHeight:taskColumn.implicitHeight+20;radius:Theme.radiusControl
                color:Theme.input;border.color:modelData.state==="proposed"?Theme.amber:Theme.border
                ColumnLayout {
                    id:taskColumn;anchors.left:parent.left;anchors.right:parent.right;anchors.top:parent.top;anchors.margins:10;spacing:4
                    CText { Layout.fillWidth:true;text:taskCard.modelData.text;font.strikeout:taskCard.modelData.state==="dropped" }
                    CText { Layout.fillWidth:true;text:workflow.taskDetail(taskCard.modelData);color:Theme.muted;font.pixelSize:Theme.caption }
                    Repeater { model:taskCard.modelData.sources||[];CText { required property var modelData;Layout.fillWidth:true;text:"Source · "+(modelData.label||"")+(modelData.text?" · "+modelData.text:"");color:Theme.muted;font.pixelSize:Theme.caption;maximumLineCount:2;elide:Text.ElideRight } }
                    Flow {
                        Layout.fillWidth:true;spacing:6
                        CButton { objectName:"taskAccept_"+taskCard.index;visible:taskCard.modelData.state==="proposed";text:"Accept";primary:true;enabled:workflow.requestId<0;onClicked:workflow.transition(taskCard.modelData,"accepted") }
                        CButton { objectName:"taskStart_"+taskCard.index;visible:taskCard.modelData.state==="accepted";text:"Start";enabled:workflow.requestId<0;onClicked:workflow.transition(taskCard.modelData,"active") }
                        CButton { objectName:"taskPause_"+taskCard.index;visible:taskCard.modelData.state==="active";text:"Pause";enabled:workflow.requestId<0;onClicked:workflow.transition(taskCard.modelData,"accepted") }
                        CButton { objectName:"taskDone_"+taskCard.index;visible:taskCard.modelData.state==="accepted"||taskCard.modelData.state==="active";text:"Done…";enabled:workflow.requestId<0;onClicked:workflow.openDone(taskCard.modelData) }
                        CButton { objectName:"taskReopen_"+taskCard.index;visible:taskCard.modelData.state==="done"||taskCard.modelData.state==="dropped";text:taskCard.modelData.state==="done"?"Reopen":"Restore";quiet:true;enabled:workflow.requestId<0;onClicked:workflow.transition(taskCard.modelData,"accepted") }
                        CButton { objectName:"taskDrop_"+taskCard.index;visible:["proposed","accepted","active"].indexOf(taskCard.modelData.state)>=0;text:taskCard.modelData.state==="proposed"?"Reject":"Drop";quiet:true;enabled:workflow.requestId<0;onClicked:workflow.transition(taskCard.modelData,"dropped") }
                    }
                }
            }
        }
        CText { visible:!workflow.visibleTasks.length;text:"No project tasks yet. Add one, or propose one from a reply’s ⋯ menu.";color:Theme.muted;font.pixelSize:Theme.caption }
        CCheckBox { objectName:"showDroppedTasks";visible:(workflow.capsule.tasks||[]).some(task=>task.state==="dropped");text:"Show dropped tasks";checked:workflow.showDropped;onToggled:workflow.showDropped=checked }
        CText { text:"Relevant conversations · recent sessions in this project";color:Theme.muted;font.pixelSize:Theme.caption }
        Repeater {
            model:workflow.relatedSessions
            CCheckBox { required property var modelData;Layout.fillWidth:true;text:modelData.title||"Untitled conversation";checked:workflow.relatedSelection.split(", ").indexOf(modelData.id)>=0
                onClicked:{let ids=workflow.relatedSelection.split(", ").filter(id=>!!id&&id!==modelData.id);if(checked)ids.push(modelData.id);workflow.relatedSelection=ids.join(", ")}
            }
        }
        CText { text:"Sources";font.weight:Font.DemiBold }
        Repeater {
            model:workflow.capsule.sources||[]
            CSection {
                required property var modelData
                title:modelData.sourceRole||"source";description:modelData.label||"Source no longer available"
                CText { text:modelData.text||"The referenced message is no longer available.";color:Theme.muted;font.pixelSize:Theme.caption;maximumLineCount:6;elide:Text.ElideRight }
            }
        }
        CText { visible:!(workflow.capsule.sources||[]).length;text:"No source references. Adding capsule text does not promote model output automatically.";color:Theme.muted;font.pixelSize:Theme.caption }
        // M17: saved checks every result here must pass. Only a check's latest observed exit counts.
        CText { text:"Required checks";font.weight:Font.DemiBold }
        CText { text:"A result passes its gate only when each required check’s latest run, with its current definition, exited 0. Not-run, cancelled, failed or changed checks never count.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        Repeater {
            model:workflow.projectScripts
            CCheckBox {
                required property var modelData;required property int index
                objectName:"requiredCheck_"+index;text:modelData.name
                checked:(workflow.capsule.requiredChecks||[]).some(check=>check.scriptId===modelData.id)
                enabled:workflow.requestId<0&&!!App.selectedId
                onToggled:{const ids=(workflow.capsule.requiredChecks||[]).map(check=>check.scriptId).filter(id=>id!==modelData.id).concat(checked?[modelData.id]:[]);workflow.call("capsules.setRequiredChecks",{sessionId:App.selectedId,expectedRevision:workflow.capsule.revision||"0",scriptIds:ids})}
            }
        }
        CText { visible:!workflow.projectScripts.length;text:"Save a script for this project folder in Settings › Saved scripts to require it.";color:Theme.muted;font.pixelSize:Theme.caption }
        GridLayout {
            Layout.fillWidth:true;columns:2;columnSpacing:8;rowSpacing:8
            CButton {
                objectName:"saveCapsule";Layout.fillWidth:true;text:"Save capsule";primary:true;enabled:workflow.requestId<0&&!!App.selectedId
                onClicked:workflow.call("capsules.save",{sessionId:App.selectedId,expectedRevision:workflow.capsule.revision||"0",goal:capsuleGoal.text,decisions:workflow.lines(decisions.text),constraints:workflow.lines(constraints.text),questions:workflow.lines(questions.text),relevantSessionIds:String(workflow.relatedSelection||"").split(",").map(item=>item.trim()).filter(item=>item),sources:(workflow.capsule.sources||[]).map(source=>({messageId:source.messageId,sessionId:source.sessionId,sourceRole:source.sourceRole}))})
            }
            CButton { objectName:"resumeCapsule";Layout.fillWidth:true;text:"Create resume draft";enabled:workflow.requestId<0&&!!App.selectedId;onClicked:workflow.call("capsules.resume",{sessionId:App.selectedId,expectedRevision:workflow.capsule.revision||"0"}) }
        }
    }

    ColumnLayout {
        visible:workflow.tab===1;Layout.fillWidth:true;spacing:10
        CText { text:"Recipe library";font.weight:Font.DemiBold }
        CText { text:"Recipes create a reviewed one-turn draft. They never run from search or preview, never grant permissions, and never send automatically.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox { id:recipePicker;objectName:"recipePicker";Layout.fillWidth:true;model:workflow.recipes;textRole:"name";Accessible.name:"Recipe";onActivated:workflow.chooseRecipe() }
        CText { visible:!!workflow.selectedRecipe;text:(workflow.selectedRecipe?.description||"")+" · version "+(workflow.selectedRecipe?.version||"");color:Theme.muted;font.pixelSize:Theme.caption }
        Repeater {
            model:workflow.selectedRecipe?.inputs||[]
            ColumnLayout {
                required property var modelData
                Layout.fillWidth:true;spacing:4
                CText { text:modelData.label+(modelData.required?" · required":"");font.pixelSize:Theme.caption;color:Theme.muted }
                CField {
                    visible:modelData.type==="number";Layout.fillWidth:true;placeholderText:modelData.type==="number"?"Number":"Text";Accessible.name:modelData.label
                    text:workflow.recipeValues[modelData.name]===undefined?"":String(workflow.recipeValues[modelData.name])
                    inputMethodHints:modelData.type==="number"?Qt.ImhFormattedNumbersOnly:Qt.ImhNone
                    onTextEdited:{const values=Object.assign({},workflow.recipeValues);values[modelData.name]=text;workflow.recipeValues=values;workflow.preview=null}
                }
                Editor {
                    objectName:"recipeInput_"+modelData.name;visible:modelData.type==="text";Accessible.name:modelData.label
                    text:workflow.recipeValues[modelData.name]===undefined?"":String(workflow.recipeValues[modelData.name])
                    onTextChanged:{if(modelData.type!=="text"||String(workflow.recipeValues[modelData.name]??"")===text)return;const values=Object.assign({},workflow.recipeValues);values[modelData.name]=text;workflow.recipeValues=values;workflow.preview=null}
                }
                CCheckBox {
                    visible:modelData.type==="boolean";text:modelData.label;checked:workflow.recipeValues[modelData.name]===true
                    onClicked:{const values=Object.assign({},workflow.recipeValues);values[modelData.name]=checked;workflow.recipeValues=values;workflow.preview=null}
                }
            }
        }
        CButton { objectName:"prepareRecipe";Layout.fillWidth:true;text:"Preview exact draft";primary:true;enabled:workflow.requestId<0&&!!workflow.selectedRecipe&&!!App.selectedId;onClicked:workflow.call("recipes.prepare",{sessionId:App.selectedId,recipeId:workflow.selectedRecipe.id,version:workflow.selectedRecipe.version,inputs:workflow.inputPayload()}) }
        CSection {
            visible:!!workflow.preview;title:"Reviewed preview";description:"One turn · up to "+(workflow.preview?.limits?.maxSeconds||0)+" seconds"
            CText { text:"Source session: "+(workflow.preview?.sourceSessionId||"")+"\nProject: "+(workflow.preview?.source?.cwd||"")+"\nProvider: "+(workflow.preview?.source?.provider||"")+" · "+(workflow.preview?.source?.model||"default")+"\nConfiguration revision: "+(workflow.preview?.source?.configRevision||"");color:Theme.muted;font.pixelSize:Theme.caption }
            Editor { objectName:"completeRecipePrompt";text:workflow.preview?.prompt||"";readOnly:true;Layout.preferredHeight:Math.max(160,implicitHeight);Accessible.name:"Complete recipe prompt" }
            CText { text:"Declared access:\n"+(workflow.preview?.permissions?.nativeAccess||[]).join("\n");color:Theme.amber;font.pixelSize:Theme.caption }
            CText { text:"Additional attachments and per-turn public search are excluded from this review.";color:Theme.muted;font.pixelSize:Theme.caption }
            CText { text:workflow.preview?.permissions?.description||"";color:Theme.amber;font.pixelSize:Theme.caption }
            CButton { objectName:"createRecipeDraft";Layout.fillWidth:true;text:"I reviewed this · create draft";primary:true;enabled:workflow.requestId<0;onClicked:workflow.call("recipes.createDraft",{previewToken:workflow.preview.token,reviewed:true}) }
            CButton { objectName:"scheduleRecipe";Layout.fillWidth:true;text:"Schedule this reviewed recipe…";enabled:workflow.requestId<0;onClicked:{scheduleLabel.text=workflow.selectedRecipe?.name||"";scheduleDialog.open()} }
        }
        // M14: reviewed recipes at set times. Any change to the recipe or its permissions pauses a schedule.
        Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
        CText { text:"Schedules";font.weight:Font.DemiBold }
        CText { visible:!workflow.schedules.length;text:"No schedules. Preview a recipe, then schedule it.";color:Theme.muted;font.pixelSize:Theme.caption }
        Repeater {
            model:workflow.schedules
            RowLayout {
                required property var modelData
                required property int index
                Layout.fillWidth:true
                ColumnLayout {
                    Layout.fillWidth:true;spacing:2
                    CText { objectName:"scheduleLabel_"+index;text:modelData.label;font.weight:Font.DemiBold;elide:Text.ElideRight;Layout.fillWidth:true }
                    CText {
                        objectName:"scheduleStatus_"+index;Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.caption
                        color:modelData.lastRun&&["paused","failed","missed","skipped"].indexOf(modelData.lastRun.outcome)>=0?Theme.amber:Theme.muted
                        text:(modelData.enabled&&modelData.next?"Next: "+new Date(modelData.next).toLocaleString(Qt.locale(),Locale.ShortFormat):"Off")+(modelData.lastRun?" · last "+modelData.lastRun.outcome+(modelData.lastRun.reason?": "+modelData.lastRun.reason:""):"")
                    }
                }
                CCheckBox { text:"On";checked:modelData.enabled;enabled:workflow.requestId<0;onToggled:workflow.call("schedules.setEnabled",{id:modelData.id,enabled:checked}) }
                CButton { text:"Delete";danger:true;quiet:true;enabled:workflow.requestId<0;onClicked:workflow.call("schedules.delete",{id:modelData.id}) }
            }
        }
        Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
        CText { text:workflow.newDefinition?"New recipe definition":"Definition authoring";font.weight:Font.DemiBold }
        RowLayout {
            Layout.fillWidth:true
            CButton { objectName:"recipesExport";Layout.fillWidth:true;text:"Export recipes…";onClicked:recipePackages.openExport() }
            CButton { objectName:"recipesImport";Layout.fillWidth:true;text:"Import a package…";onClicked:{const path=App.chooseFile();if(path)recipePackages.previewFile(path)} }
        }
        CButton { text:"New recipe";onClicked:{workflow.newDefinition=true;recipeName.text="";recipeDescription.text="";recipeInstructions.text="";recipeOutput.text="";recipeSections.text="";recipePermissions.text="Requires review under the session’s existing permissions.";recipeAccess.text="";inputDefinitions.clear();recipeSeconds.value=300} }
        CText { text:"Saving creates a new immutable version and invalidates unconsumed previews for this recipe.";color:Theme.muted;font.pixelSize:Theme.caption }
        CField { id:recipeName;Layout.fillWidth:true;placeholderText:"Recipe name";Accessible.name:"Recipe name" }
        CField { id:recipeDescription;Layout.fillWidth:true;placeholderText:"Description";Accessible.name:"Recipe description" }
        CText { text:"Recipe inputs";color:Theme.muted;font.pixelSize:Theme.caption }
        Repeater {
            model:inputDefinitions
            ColumnLayout {
                id:inputDefinitionRow
                required property int index
                required property string inputName
                required property string label
                required property string inputType
                required property bool isRequired
                required property bool hasDefault
                required property string defaultText
                Layout.fillWidth:true
                RowLayout {
                    CField { Layout.fillWidth:true;text:inputName;placeholderText:"Input name";Accessible.name:"Input name";onTextEdited:inputDefinitions.setProperty(inputDefinitionRow.index,"inputName",text) }
                    CField { Layout.fillWidth:true;text:label;placeholderText:"Label";Accessible.name:"Input label";onTextEdited:inputDefinitions.setProperty(inputDefinitionRow.index,"label",text) }
                    CButton { text:"Remove";onClicked:inputDefinitions.remove(inputDefinitionRow.index) }
                }
                RowLayout {
                    CComboBox { model:["text","number","boolean"];currentIndex:model.indexOf(inputType);Accessible.name:"Input type";onActivated:inputDefinitions.setProperty(inputDefinitionRow.index,"inputType",currentText) }
                    CCheckBox { text:"Required";checked:isRequired;onClicked:inputDefinitions.setProperty(inputDefinitionRow.index,"isRequired",checked) }
                    CCheckBox { text:"Default";checked:hasDefault;onClicked:inputDefinitions.setProperty(inputDefinitionRow.index,"hasDefault",checked) }
                }
                CField { visible:hasDefault;Layout.fillWidth:true;text:defaultText;placeholderText:inputType==="boolean"?"true or false":"Default value";Accessible.name:"Default value";onTextEdited:inputDefinitions.setProperty(inputDefinitionRow.index,"defaultText",text) }
            }
        }
        CButton { text:"Add input";enabled:inputDefinitions.count<16;onClicked:inputDefinitions.append({inputName:"input"+(inputDefinitions.count+1),label:"New input",inputType:"text",isRequired:false,hasDefault:false,defaultText:""}) }
        CText { text:"Pinned instructions";color:Theme.muted;font.pixelSize:Theme.caption }
        Editor { id:recipeInstructions;Layout.preferredHeight:150;Accessible.name:"Pinned recipe instructions" }
        CText { text:"Expected output";color:Theme.muted;font.pixelSize:Theme.caption }
        Editor { id:recipeOutput;Accessible.name:"Expected recipe output" }
        CText { text:"Output sections · one heading per line, optional. A reply missing one is flagged; it is never changed.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        Editor { id:recipeSections;objectName:"recipeSections";Accessible.name:"Recipe output sections" }
        CText { text:"Requested native access · one capability per line";color:Theme.muted;font.pixelSize:Theme.caption }
        Editor { id:recipeAccess;Accessible.name:"Recipe native access" }
        CText { text:"Permission declaration";color:Theme.muted;font.pixelSize:Theme.caption }
        Editor { id:recipePermissions;Accessible.name:"Recipe permission declaration" }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Hard runtime";font.pixelSize:Theme.caption;color:Theme.muted }
            CSpinBox { id:recipeSeconds;from:30;to:600;value:300;stepSize:30;Accessible.name:"Maximum recipe seconds" }
            CText { text:"seconds · one turn";font.pixelSize:Theme.caption;color:Theme.muted }
        }
        CButton {
            objectName:"saveRecipeVersion";Layout.fillWidth:true;text:"Save new recipe version";enabled:workflow.requestId<0&&recipeName.text.trim().length>0
            onClicked:{
                try{const inputs=workflow.definitionInputs();workflow.call("recipes.save",{id:workflow.newDefinition?undefined:workflow.selectedRecipe?.id,expectedRevision:workflow.newDefinition?"0":workflow.selectedRecipe?.revision||"0",name:recipeName.text,description:recipeDescription.text,inputs:inputs,instructions:recipeInstructions.text,expectedOutput:recipeOutput.text,outputSections:workflow.lines(recipeSections.text),permissions:{nativeAccess:workflow.lines(recipeAccess.text),description:recipePermissions.text},runtime:{maxSeconds:recipeSeconds.value,maxTurns:1}})}catch(problem){workflow.error=problem.message}
            }
        }
    }

    ColumnLayout {
        visible:workflow.tab===2;Layout.fillWidth:true;spacing:10
        CText { text:"Result hub";font.weight:Font.DemiBold }
        CText { text:"Provider outcome and verification are separate. Passed or failed verification appears only from broker-observed exit codes; response text is read live from the transcript.";color:Theme.muted;font.pixelSize:Theme.secondary }
        Repeater {
            model:workflow.results
            CSection {
                id:resultCard
                required property var modelData
                title:modelData.providerOutcome+" · verification "+modelData.verification+(modelData.gate&&modelData.gate!=="none"?" · required checks "+({passed:"passed",failed:"failed",incomplete:"incomplete"})[modelData.gate]:"")
                description:new Date(modelData.time).toLocaleString(Qt.locale(),Locale.ShortFormat)
                CText { visible:!!modelData.source;text:modelData.source?.text||"";maximumLineCount:8;elide:Text.ElideRight }
                CText { visible:!modelData.source;text:"Source response is no longer available.";color:Theme.muted;font.pixelSize:Theme.caption }
                Repeater {
                    model:modelData.observed||[]
                    CText { required property var modelData;text:(modelData.verification==="reviewed-check"?"Reviewed verification check":"Observed command result")+" · "+modelData.name+(modelData.exitCode===undefined?"":" · exit "+modelData.exitCode);color:modelData.verification==="reviewed-check"?(modelData.exitCode===0?Theme.success:Theme.danger):Theme.muted;font.pixelSize:Theme.caption }
                }
                Repeater {
                    model:modelData.checklist||[]
                    CText {
                        required property var modelData;required property int index
                        objectName:"resultCheck_"+index
                        readonly property var words:({passed:"passed",failed:"failed","not-run":"not run",stale:"changed since it ran",cancelled:"cancelled",error:"could not start",missing:"no longer saved"})
                        text:"Required · "+modelData.label+" · "+words[modelData.status]+(modelData.exitCode!==undefined?" · exit "+modelData.exitCode:"")+(modelData.durationMs!==undefined?" · "+(modelData.durationMs/1000).toFixed(1)+" s":"")+(modelData.reason?" · "+modelData.reason:"")
                        color:modelData.status==="passed"?Theme.success:modelData.status==="failed"?Theme.danger:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true
                    }
                }
                CText {
                    objectName:"resultContract";visible:!!modelData.contract;Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.caption
                    color:modelData.contract?.status==="met"?Theme.muted:Theme.amber
                    readonly property var mentioned:(modelData.contract?.sections||[]).filter(section=>section.how==="mentioned").map(section=>section.name)
                    text:!modelData.contract?"":(modelData.contract.status==="met"?"Output sections: all present.":"Output sections missing: "+modelData.contract.sections.filter(section=>!section.present).map(section=>section.name).join(", ")+". The reply is shown as written.")
                        +(mentioned.length?" "+mentioned.join(", ")+(mentioned.length===1?" is":" are")+" mentioned, not as a heading.":"")
                }
                Repeater { model:modelData.artifacts||[];CButton { required property string modelData;text:"Open artifact · "+modelData;quiet:true;onClicked:App.rpc("action.run",{name:"files.open",args:{path:modelData}}) } }
                CText { visible:!!modelData.uncertainty;text:modelData.uncertainty||"";color:Theme.amber;font.pixelSize:Theme.caption }
                CButton { text:"Open session";onClicked:{workflow.close();workflow.sessionRequested(modelData.sessionId)} }
                CComboBox { id:checkPicker;Layout.fillWidth:true;model:(App.state.settings?.scripts||[]).filter(script=>script.cwd===resultCard.modelData.cwd);textRole:"name";Accessible.name:"Saved verification check" }
                CButton { text:"Review verification check";enabled:workflow.requestId<0&&checkPicker.count>0;onClicked:{workflow.checkResult=resultCard.modelData;workflow.checkScript=JSON.parse(JSON.stringify(checkPicker.model[checkPicker.currentIndex]));checkReview.open()} }
            }
        }
        CText { visible:!workflow.results.length;text:"No durable result metadata yet.";color:Theme.muted }
    }

    CText { visible:workflow.requestId>=0;text:"Working…";color:Theme.muted;font.pixelSize:Theme.caption }
    CText { visible:workflow.error.length>0;text:workflow.error;color:Theme.danger;font.pixelSize:Theme.secondary }
    CText { visible:workflow.feedback.length>0;text:workflow.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary }
    CButton { Layout.fillWidth:true;text:"Done";onClicked:workflow.close() }
    CDialog {
        id:doneDialog;objectName:"taskDoneDialog"
        property int choice:-1
        onOpened:choice=-1
        CText { text:"Mark this task done?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:workflow.doneTask?.text||"";wrapMode:Text.Wrap }
        CText { text:"Cite what shows it is done: a passing reviewed check from this project’s results, or your own decision.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
        Repeater {
            model:workflow.passingResults
            CCheckBox { required property var modelData;required property int index;objectName:"taskEvidence_"+index;Layout.fillWidth:true;text:"Reviewed check passed · "+new Date(modelData.time).toLocaleString(Qt.locale(),Locale.ShortFormat);checked:doneDialog.choice===index;onToggled:doneDialog.choice=checked?index:-1 }
        }
        CText { visible:!workflow.passingResults.length;text:workflow.passingRequest>=0?"Looking for passing checks…":"No passing reviewed check in this project. Run one from Results, or decide yourself.";color:Theme.muted;font.pixelSize:Theme.caption }
        CText { text:"Or my decision, with a reason";color:Theme.muted;font.pixelSize:Theme.caption }
        CField { id:doneNote;objectName:"taskDoneNote";Layout.fillWidth:true;placeholderText:"Why is it done?";enabled:doneDialog.choice<0;Accessible.name:"Reason the task is done" }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";onClicked:doneDialog.close() }
            CButton {
                objectName:"taskDoneConfirm";Layout.fillWidth:true;text:"Mark done";primary:true
                enabled:workflow.requestId<0&&!!workflow.doneTask&&(doneDialog.choice>=0||doneNote.text.trim().length>0)
                onClicked:{workflow.transition(workflow.doneTask,"done",doneDialog.choice>=0?{kind:"observed-check",resultId:workflow.passingResults[doneDialog.choice].id}:{kind:"user-decision",note:doneNote.text});doneDialog.close()}
            }
        }
    }
    // M14: the schedule dialog. The reviewed preview becomes the schedule; nothing runs now.
    CDialog {
        id:scheduleDialog;objectName:"scheduleDialog"
        readonly property var kinds:[{id:"daily",label:"Every day"},{id:"weekdays",label:"Weekdays"},{id:"weekly",label:"Chosen days"},{id:"once",label:"Once"}]
        readonly property var dayNames:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
        property var days:[1]
        CText { text:"Schedule this reviewed recipe";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"At each time Cere checks that the recipe, its inputs, the conversation settings and the permission switches are exactly as reviewed now. Any change pauses the schedule. A time missed while Cere was not running is reported, not run late.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CField { id:scheduleLabel;objectName:"scheduleFormLabel";Layout.fillWidth:true;placeholderText:"Name";maximumLength:80;Accessible.name:"Schedule name" }
        RowLayout {
            Layout.fillWidth:true
            CComboBox { id:scheduleKind;objectName:"scheduleFormKind";Layout.fillWidth:true;model:scheduleDialog.kinds;textRole:"label";Accessible.name:"How often" }
            CField { id:scheduleTime;objectName:"scheduleFormTime";Layout.preferredWidth:90;text:"08:00";placeholderText:"HH:MM";Accessible.name:"Time" }
        }
        Flow {
            visible:scheduleKind.currentIndex===2;Layout.fillWidth:true;spacing:6
            Repeater { model:7;CCheckBox { required property int index;text:scheduleDialog.dayNames[index];checked:scheduleDialog.days.indexOf(index)>=0;onToggled:scheduleDialog.days=checked?scheduleDialog.days.concat([index]):scheduleDialog.days.filter(day=>day!==index) } }
        }
        CField { id:scheduleDate;visible:scheduleKind.currentIndex===3;Layout.fillWidth:true;placeholderText:"Date, YYYY-MM-DD";Accessible.name:"Date" }
        CCheckBox { id:scheduleUnattended;objectName:"scheduleFormUnattended";text:"It may run while I am away; permission questions wait for me" }
        CText { objectName:"scheduleFormError";visible:!!workflow.error&&scheduleDialog.opened;text:workflow.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;onClicked:scheduleDialog.close() }
            CButton {
                objectName:"scheduleFormSave";text:"Schedule";primary:true;Layout.fillWidth:true;enabled:workflow.requestId<0&&!!workflow.preview&&scheduleUnattended.checked&&scheduleLabel.text.trim().length>0
                onClicked:{
                    const kind=scheduleDialog.kinds[scheduleKind.currentIndex].id,when={kind:kind,time:scheduleTime.text.trim()}
                    if(kind==="weekly")when.days=scheduleDialog.days
                    if(kind==="once")when.date=scheduleDate.text.trim()
                    workflow.call("schedules.create",{previewToken:workflow.preview.token,label:scheduleLabel.text.trim(),when:when,unattended:true})
                }
            }
        }
    }
    CDialog {
        id:checkReview
        CText { text:"Run this saved verification check?";font.pixelSize:Theme.title }
        CText { text:"Project: "+(workflow.checkScript.cwd||"")+"\nExecutable: "+(workflow.checkScript.executable||"")+"\nArguments: "+JSON.stringify(workflow.checkScript.args||[])+"\nTimeout: "+Math.ceil((workflow.checkScript.timeout||0)/1000)+" seconds";wrapMode:Text.Wrap;font.family:"monospace" }
        CText { text:"This executes the saved command. Passing establishes only this check’s result; it does not certify the entire task.";color:Theme.amber }
        CButton { text:"Run reviewed check";primary:true;enabled:workflow.requestId<0;onClicked:workflow.call("results.runVerification",{sessionId:workflow.checkResult.sessionId,resultId:workflow.checkResult.id,scriptId:workflow.checkScript.id,expectedScript:workflow.checkScript,reviewed:true}) }
        CButton { visible:workflow.requestId>=0&&workflow.action==="results.runVerification";text:"Cancel check";danger:true;onClicked:App.rpc("results.cancelVerification",{sessionId:workflow.checkResult.sessionId}) }
        CText { visible:workflow.error.length>0;text:workflow.error;color:Theme.danger }
        CButton { text:"Close";onClicked:checkReview.close() }
    }

    Connections {
        target:App
        function onResult(id,value){
            if(id===workflow.relatedRequest){workflow.relatedRequest=-1;if(!value?.error)workflow.relatedSessions=value.sessions||[];return}
            if(workflow.scheduleRequests[id]){const pending=Object.assign({},workflow.scheduleRequests);delete pending[id];workflow.scheduleRequests=pending;if(!value?.error)workflow.schedules=value||[];return}
            if(id===workflow.passingRequest){workflow.passingRequest=-1;if(!value?.error)workflow.passingResults=(value||[]).filter(result=>result.verification==="passed"&&(!result.gate||result.gate==="none"||result.gate==="passed"));return}
            if(id!==workflow.requestId)return
            workflow.requestId=-1
            if(value?.error){workflow.error=workflow.failure(value);return}
            if(workflow.action==="capsules.get"||workflow.action==="capsules.save"){workflow.syncCapsule(value);workflow.feedback=workflow.action==="capsules.save"?"Capsule saved.":""}
            else if(workflow.action==="capsules.task")workflow.capsule=value.capsule
            else if(workflow.action==="capsules.setRequiredChecks"){workflow.capsule=value;workflow.feedback="Required checks saved."}
            else if(workflow.action==="capsules.resume"){workflow.close();workflow.sessionRequested(value.session.id)}
            else if(workflow.action==="recipes.list"){workflow.recipes=value.recipes||[];workflow.recipeVersions=value.versions||[];recipePicker.currentIndex=workflow.recipes.length?0:-1;workflow.chooseRecipe()}
            else if(workflow.action==="recipes.prepare")workflow.preview=value
            else if(workflow.action==="schedules.create"){scheduleDialog.close();workflow.preview=null;workflow.feedback="Scheduled. Runs wait for you on any permission question; results go to the inbox.";workflow.loadSchedules()}
            else if(workflow.action==="schedules.setEnabled"||workflow.action==="schedules.delete")workflow.loadSchedules()
            else if(workflow.action==="recipes.createDraft"){workflow.close();workflow.sessionRequested(value.session.id)}
            else if(workflow.action==="recipes.save"){workflow.feedback="Recipe version saved.";workflow.loadRecipes()}
            else if(workflow.action==="results.list")workflow.results=value||[]
            else if(workflow.action==="results.runVerification"){checkReview.close();workflow.loadResults()}
        }
    }
}
