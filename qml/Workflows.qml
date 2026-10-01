import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CDialog {
    id:workflow
    objectName:"workflowsDialog"
    ListModel { id:inputDefinitions }
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
    property var results:[]
    property var checkResult:({})
    property var checkScript:({})
    signal sessionRequested(string id)

    component Editor:TextArea {
        Layout.fillWidth:true;Layout.preferredHeight:100
        textFormat:TextEdit.PlainText;wrapMode:TextEdit.Wrap;selectByMouse:true
        color:Theme.text;selectionColor:Theme.selected;selectedTextColor:Theme.text
        font.family:Theme.font;font.pixelSize:12;padding:10
        background:Rectangle { color:Theme.input;radius:7;border.color:parent.activeFocus?Theme.cyan:Theme.line }
    }
    function failure(value){return typeof value?.error==="string"?value.error:value?.error?.message||value?.message||"The workflow request failed."}
    function call(method,params){if(requestId>=0)return;error="";feedback="";action=method;requestId=App.rpc(method,params||{})}
    function lines(value){return String(value||"").split("\n").map(item=>item.trim()).filter(item=>item.length>0)}
    function syncCapsule(value){
        capsule=value||({revision:"0",sources:[],relevantSessionIds:[]})
        capsuleGoal.text=capsule.goal||"";decisions.text=(capsule.decisions||[]).join("\n");constraints.text=(capsule.constraints||[]).join("\n")
        questions.text=(capsule.questions||[]).join("\n");nextSteps.text=(capsule.nextSteps||[]).join("\n");relatedSelection=(capsule.relevantSessionIds||[]).join(", ")
    }
    function loadProject(){if(App.selectedId){call("capsules.get",{sessionId:App.selectedId});relatedRequest=App.rpc("sessions.list",{cwd:App.session.cwd,limit:100})}}
    function loadRecipes(){call("recipes.list",{})}
    function loadResults(){call("results.list",{limit:100})}
    function refresh(){if(tab===0)loadProject();else if(tab===1)loadRecipes();else loadResults()}
    function chooseRecipe(){
        newDefinition=false
        preview=null;error="";feedback="";recipeValues={}
        const recipe=selectedRecipe;if(!recipe)return
        const values={};for(const input of recipe.inputs||[])if(input.default!==undefined)values[input.name]=input.default;recipeValues=values
        recipeName.text=recipe.name||"";recipeDescription.text=recipe.description||"";recipeInstructions.text=recipe.instructions||"";recipeOutput.text=recipe.expectedOutput||""
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
    onOpened:{tab=0;refresh()}
    onTabChanged:if(opened)refresh()

    RowLayout {
        Layout.fillWidth:true
        CText { text:"Project workflows";font.pixelSize:20;font.weight:Font.DemiBold }
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
        CText { text:"Scoped to the selected session’s exact working folder. Worktree grouping never merges capsules or changes permissions, memory, or the working directory.";color:Theme.muted;font.pixelSize:12 }
        CText { text:"Goal";color:Theme.muted;font.pixelSize:11 }
        CField { id:capsuleGoal;objectName:"capsuleGoal";Layout.fillWidth:true;placeholderText:"What is this project trying to achieve?";Accessible.name:"Project goal" }
        CText { text:"Decisions · one per line";color:Theme.muted;font.pixelSize:11 }
        Editor { id:decisions;objectName:"capsuleDecisions";Accessible.name:"Project decisions" }
        CText { text:"Constraints · one per line";color:Theme.muted;font.pixelSize:11 }
        Editor { id:constraints;objectName:"capsuleConstraints";Accessible.name:"Project constraints" }
        CText { text:"Open questions · one per line";color:Theme.muted;font.pixelSize:11 }
        Editor { id:questions;objectName:"capsuleQuestions";Accessible.name:"Project questions" }
        CText { text:"Next steps · one per line";color:Theme.muted;font.pixelSize:11 }
        Editor { id:nextSteps;objectName:"capsuleNextSteps";Accessible.name:"Project next steps" }
        CText { text:"Relevant conversations · recent sessions in this project";color:Theme.muted;font.pixelSize:11 }
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
                CText { text:modelData.text||"The referenced message is no longer available.";color:Theme.muted;font.pixelSize:11;maximumLineCount:6;elide:Text.ElideRight }
            }
        }
        CText { visible:!(workflow.capsule.sources||[]).length;text:"No source references. Adding capsule text does not promote model output automatically.";color:Theme.muted;font.pixelSize:11 }
        GridLayout {
            Layout.fillWidth:true;columns:2;columnSpacing:8;rowSpacing:8
            CButton {
                objectName:"saveCapsule";Layout.fillWidth:true;text:"Save capsule";primary:true;enabled:workflow.requestId<0&&!!App.selectedId
                onClicked:workflow.call("capsules.save",{sessionId:App.selectedId,expectedRevision:workflow.capsule.revision||"0",goal:capsuleGoal.text,decisions:workflow.lines(decisions.text),constraints:workflow.lines(constraints.text),questions:workflow.lines(questions.text),nextSteps:workflow.lines(nextSteps.text),relevantSessionIds:String(workflow.relatedSelection||"").split(",").map(item=>item.trim()).filter(item=>item),sources:(workflow.capsule.sources||[]).map(source=>({messageId:source.messageId,sessionId:source.sessionId,sourceRole:source.sourceRole}))})
            }
            CButton { objectName:"resumeCapsule";Layout.fillWidth:true;text:"Create resume draft";enabled:workflow.requestId<0&&!!App.selectedId;onClicked:workflow.call("capsules.resume",{sessionId:App.selectedId,expectedRevision:workflow.capsule.revision||"0"}) }
        }
    }

    ColumnLayout {
        visible:workflow.tab===1;Layout.fillWidth:true;spacing:10
        CText { text:"Recipe library";font.weight:Font.DemiBold }
        CText { text:"Recipes create a reviewed one-turn draft. They never run from search or preview, never grant permissions, and never send automatically.";color:Theme.muted;font.pixelSize:12 }
        CComboBox { id:recipePicker;objectName:"recipePicker";Layout.fillWidth:true;model:workflow.recipes;textRole:"name";Accessible.name:"Recipe";onActivated:workflow.chooseRecipe() }
        CText { visible:!!workflow.selectedRecipe;text:(workflow.selectedRecipe?.description||"")+" · version "+(workflow.selectedRecipe?.version||"");color:Theme.muted;font.pixelSize:11 }
        Repeater {
            model:workflow.selectedRecipe?.inputs||[]
            ColumnLayout {
                required property var modelData
                Layout.fillWidth:true;spacing:4
                CText { text:modelData.label+(modelData.required?" · required":"");font.pixelSize:11;color:Theme.muted }
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
            CText { text:"Source session: "+(workflow.preview?.sourceSessionId||"")+"\nProject: "+(workflow.preview?.source?.cwd||"")+"\nProvider: "+(workflow.preview?.source?.provider||"")+" · "+(workflow.preview?.source?.model||"default")+"\nConfiguration revision: "+(workflow.preview?.source?.configRevision||"");color:Theme.muted;font.pixelSize:11 }
            Editor { objectName:"completeRecipePrompt";text:workflow.preview?.prompt||"";readOnly:true;Layout.preferredHeight:Math.max(160,implicitHeight);Accessible.name:"Complete recipe prompt" }
            CText { text:"Declared access:\n"+(workflow.preview?.permissions?.nativeAccess||[]).join("\n");color:Theme.amber;font.pixelSize:11 }
            CText { text:"Additional attachments and per-turn public search are excluded from this review.";color:Theme.muted;font.pixelSize:11 }
            CText { text:workflow.preview?.permissions?.description||"";color:Theme.amber;font.pixelSize:11 }
            CButton { objectName:"createRecipeDraft";Layout.fillWidth:true;text:"I reviewed this · create draft";primary:true;enabled:workflow.requestId<0;onClicked:workflow.call("recipes.createDraft",{previewToken:workflow.preview.token,reviewed:true}) }
        }
        Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
        CText { text:workflow.newDefinition?"New recipe definition":"Definition authoring";font.weight:Font.DemiBold }
        CButton { text:"New recipe";onClicked:{workflow.newDefinition=true;recipeName.text="";recipeDescription.text="";recipeInstructions.text="";recipeOutput.text="";recipePermissions.text="Requires review under the session’s existing permissions.";recipeAccess.text="";inputDefinitions.clear();recipeSeconds.value=300} }
        CText { text:"Saving creates a new immutable version and invalidates unconsumed previews for this recipe.";color:Theme.muted;font.pixelSize:11 }
        CField { id:recipeName;Layout.fillWidth:true;placeholderText:"Recipe name";Accessible.name:"Recipe name" }
        CField { id:recipeDescription;Layout.fillWidth:true;placeholderText:"Description";Accessible.name:"Recipe description" }
        CText { text:"Recipe inputs";color:Theme.muted;font.pixelSize:11 }
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
        CText { text:"Pinned instructions";color:Theme.muted;font.pixelSize:11 }
        Editor { id:recipeInstructions;Layout.preferredHeight:150;Accessible.name:"Pinned recipe instructions" }
        CText { text:"Expected output";color:Theme.muted;font.pixelSize:11 }
        Editor { id:recipeOutput;Accessible.name:"Expected recipe output" }
        CText { text:"Requested native access · one capability per line";color:Theme.muted;font.pixelSize:11 }
        Editor { id:recipeAccess;Accessible.name:"Recipe native access" }
        CText { text:"Permission declaration";color:Theme.muted;font.pixelSize:11 }
        Editor { id:recipePermissions;Accessible.name:"Recipe permission declaration" }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Hard runtime";font.pixelSize:11;color:Theme.muted }
            CSpinBox { id:recipeSeconds;from:30;to:600;value:300;stepSize:30;Accessible.name:"Maximum recipe seconds" }
            CText { text:"seconds · one turn";font.pixelSize:11;color:Theme.muted }
        }
        CButton {
            objectName:"saveRecipeVersion";Layout.fillWidth:true;text:"Save new recipe version";enabled:workflow.requestId<0&&recipeName.text.trim().length>0
            onClicked:{
                try{const inputs=workflow.definitionInputs();workflow.call("recipes.save",{id:workflow.newDefinition?undefined:workflow.selectedRecipe?.id,expectedRevision:workflow.newDefinition?"0":workflow.selectedRecipe?.revision||"0",name:recipeName.text,description:recipeDescription.text,inputs:inputs,instructions:recipeInstructions.text,expectedOutput:recipeOutput.text,permissions:{nativeAccess:workflow.lines(recipeAccess.text),description:recipePermissions.text},runtime:{maxSeconds:recipeSeconds.value,maxTurns:1}})}catch(problem){workflow.error=problem.message}
            }
        }
    }

    ColumnLayout {
        visible:workflow.tab===2;Layout.fillWidth:true;spacing:10
        CText { text:"Result hub";font.weight:Font.DemiBold }
        CText { text:"Provider outcome and verification are separate. Passed or failed verification appears only from broker-observed exit codes; response text is read live from the transcript.";color:Theme.muted;font.pixelSize:12 }
        Repeater {
            model:workflow.results
            CSection {
                id:resultCard
                required property var modelData
                title:modelData.providerOutcome+" · verification "+modelData.verification
                description:new Date(modelData.time).toLocaleString(Qt.locale(),Locale.ShortFormat)
                CText { visible:!!modelData.source;text:modelData.source?.text||"";maximumLineCount:8;elide:Text.ElideRight }
                CText { visible:!modelData.source;text:"Source response is no longer available.";color:Theme.muted;font.pixelSize:11 }
                Repeater {
                    model:modelData.observed||[]
                    CText { required property var modelData;text:(modelData.verification==="reviewed-check"?"Reviewed verification check":"Observed command result")+" · "+modelData.name+(modelData.exitCode===undefined?"":" · exit "+modelData.exitCode);color:modelData.verification==="reviewed-check"?(modelData.exitCode===0?Theme.success:Theme.danger):Theme.muted;font.pixelSize:11 }
                }
                Repeater { model:modelData.artifacts||[];CButton { required property string modelData;text:"Open artifact · "+modelData;quiet:true;onClicked:App.rpc("action.run",{name:"files.open",args:{path:modelData}}) } }
                CText { visible:!!modelData.uncertainty;text:modelData.uncertainty||"";color:Theme.amber;font.pixelSize:11 }
                CButton { text:"Open session";onClicked:{workflow.close();workflow.sessionRequested(modelData.sessionId)} }
                CComboBox { id:checkPicker;Layout.fillWidth:true;model:(App.state.settings?.scripts||[]).filter(script=>script.cwd===resultCard.modelData.cwd);textRole:"name";Accessible.name:"Saved verification check" }
                CButton { text:"Review verification check";enabled:workflow.requestId<0&&checkPicker.count>0;onClicked:{workflow.checkResult=resultCard.modelData;workflow.checkScript=JSON.parse(JSON.stringify(checkPicker.model[checkPicker.currentIndex]));checkReview.open()} }
            }
        }
        CText { visible:!workflow.results.length;text:"No durable result metadata yet.";color:Theme.muted }
    }

    CText { visible:workflow.requestId>=0;text:"Working…";color:Theme.muted;font.pixelSize:11 }
    CText { visible:workflow.error.length>0;text:workflow.error;color:Theme.danger;font.pixelSize:12 }
    CText { visible:workflow.feedback.length>0;text:workflow.feedback;color:Theme.cyan;font.pixelSize:12 }
    CButton { Layout.fillWidth:true;text:"Done";onClicked:workflow.close() }
    CDialog {
        id:checkReview
        CText { text:"Run this saved verification check?";font.pixelSize:18 }
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
            if(id!==workflow.requestId)return
            workflow.requestId=-1
            if(value?.error){workflow.error=workflow.failure(value);return}
            if(workflow.action==="capsules.get"||workflow.action==="capsules.save"){workflow.syncCapsule(value);workflow.feedback=workflow.action==="capsules.save"?"Capsule saved.":""}
            else if(workflow.action==="capsules.resume"){workflow.close();workflow.sessionRequested(value.session.id)}
            else if(workflow.action==="recipes.list"){workflow.recipes=value.recipes||[];workflow.recipeVersions=value.versions||[];recipePicker.currentIndex=workflow.recipes.length?0:-1;workflow.chooseRecipe()}
            else if(workflow.action==="recipes.prepare")workflow.preview=value
            else if(workflow.action==="recipes.createDraft"){workflow.close();workflow.sessionRequested(value.session.id)}
            else if(workflow.action==="recipes.save"){workflow.feedback="Recipe version saved.";workflow.loadRecipes()}
            else if(workflow.action==="results.list")workflow.results=value||[]
            else if(workflow.action==="results.runVerification"){checkReview.close();workflow.loadResults()}
        }
    }
}
