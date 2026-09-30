import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id: inspector; objectName:"graphMemoryInspector"
    focus:true
    property string sessionId:""
    property int pending:-1
    property int policyRequest:-1
    property string action:""
    property string error:""
    property var result:({})
    // Collector controls stay disabled until the persisted policy has actually loaded.
    property var policy:({})
    property bool policyLoaded:false
    property var inspected:({})
    // An immutable forget selection: the record, session, revision and binding token
    // captured when the preview completed. Confirmation submits exactly this record.
    property var preview:({})
    property string erasureJob:""
    property string previewTarget:""
    readonly property bool previewCurrent:!!preview.id&&preview.sessionId===sessionId&&preview.id===record.text
    function call(method,params){error="";action=method;pending=App.rpc("memory.graph",{sessionId:sessionId,method:method,params:params||{}})}
    function mutate(method){try{let body=JSON.parse(mutation.text);preview={};call(method,body)}catch(e){error="Enter valid structured JSON: "+e.message}}
    function openRecord(id){record.text=id;preview={};call("inspect",{id:id})}
    function loadPolicy(){policyLoaded=false;policyRequest=App.rpc("memory.graph",{sessionId:sessionId,method:"policy_get",params:{}})}
    function updatePolicy(patch){if(!policyLoaded)return;policyLoaded=false;preview={};policyRequest=App.rpc("memory.graph",{sessionId:sessionId,method:"policy_update",params:{policy:patch}})}
    // Reset before the popup becomes visible, so a reopened inspector never shows stale enabled controls.
    onAboutToShow:{result={};inspected={};preview={};erasureJob="";policy={};loadPolicy();call("health",{})}
    onSessionIdChanged:preview={}
    CText { text:"Graph memory inspector";font.pixelSize:20;font.weight:Font.DemiBold }
    CText { text:"Review sources, temporal history, task episodes and current workspace. Changes use the selected conversation’s project scope.";color:Theme.muted;font.pixelSize:12 }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Health";enabled:inspector.pending<0;onClicked:inspector.call("health",{}) }
        CButton { text:"Workspace";enabled:inspector.pending<0;onClicked:inspector.call("workspace",{}) }
        CButton { text:"Policy";enabled:inspector.policyRequest<0;onClicked:inspector.loadPolicy() }
    }
    CField { id:query;objectName:"graphMemoryQuery";Layout.fillWidth:true;placeholderText:"Entity, task, source or project decision";Accessible.name:"Search graph memory";onAccepted:search.clicked() }
    RowLayout {
        Layout.fillWidth:true
        CField { id:world;Layout.fillWidth:true;placeholderText:"World date (ISO, optional)";Accessible.name:"World time" }
        CField { id:known;Layout.fillWidth:true;placeholderText:"Knowledge revision";Accessible.name:"Knowledge revision" }
    }
    CButton { id:search;text:"Search evidence";enabled:inspector.pending<0&&query.text.trim().length>0;onClicked:{let p={text:query.text};if(world.text){let time=Date.parse(world.text);if(isNaN(time)){inspector.error="Enter an ISO date with a timezone.";return}p.world_at_us=time*1000}if(known.text)p.known_revision=Number(known.text);inspector.call("retrieve",p)} }
    Repeater {
        model:inspector.result.results||[]
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { text:modelData.text;font.pixelSize:12 }
            CButton { text:"Inspect evidence and history";onClicked:inspector.openRecord(modelData.id) }
        }
    }
    // Editing or reselecting the record invalidates any earlier forget preview.
    CField { id:record;objectName:"graphMemoryRecord";Layout.fillWidth:true;placeholderText:"Record ID";Accessible.name:"Memory record ID";onTextChanged:if(inspector.preview.id&&text!==inspector.preview.id)inspector.preview={} }
    RowLayout {
        Layout.fillWidth:true
        CButton { objectName:"graphMemoryInspect";text:"Inspect";enabled:inspector.pending<0&&record.text.length>0;onClicked:{inspector.preview={};inspector.call("inspect",{id:record.text})} }
        CButton { objectName:"graphMemoryPreviewForget";text:"Preview forgetting";enabled:inspector.pending<0&&record.text.length>0;onClicked:{inspector.preview={};inspector.previewTarget=record.text;inspector.call("forget_preview",{id:record.text})} }
    }
    CText { objectName:"graphMemoryForgetImpact";visible:inspector.previewCurrent;text:"Forgetting "+(inspector.preview.selector?.kind||"record").replace("_"," ")+" "+inspector.preview.id+" suppresses "+inspector.preview.count+" records and dependent copies immediately. Physical purge waits for database acknowledgements.";color:Theme.amber;font.pixelSize:12;wrapMode:Text.Wrap }
    CButton { objectName:"graphMemoryForget";visible:inspector.previewCurrent;text:"Forget "+inspector.preview.id;danger:true;enabled:inspector.pending<0&&inspector.previewCurrent;onClicked:inspector.call("forget",{id:inspector.preview.id,expected_revision:inspector.preview.revision,selection:inspector.preview.selection}) }
    CButton { visible:!!inspector.erasureJob;text:"Check purge progress";onClicked:inspector.call("erasure_status",{job_id:inspector.erasureJob}) }
    CText { text:"Details";font.weight:Font.DemiBold }
    CText { visible:inspector.result?.recorded_only===true;text:"Identity decision recorded. It does not change entity resolution yet.";color:Theme.amber;font.pixelSize:12 }
    TextArea { objectName:"graphMemoryDetails";Layout.fillWidth:true;Layout.preferredHeight:240;readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap;text:JSON.stringify(inspector.result,null,2);textFormat:TextEdit.PlainText;color:Theme.text;font.pixelSize:11;background:Rectangle{color:Theme.input;radius:7} }
    CText { text:"Correction / resolution";font.weight:Font.DemiBold }
    CText { text:"Inspect an assertion to load its complete claim and revision. Change only what you intend to correct, and supply a source observation with an exact quotation. Dates are half-open UTC microsecond bounds. Ambiguous changes remain reviewable candidates.";color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap }
    TextArea { id:mutation;objectName:"graphMemoryMutation";Layout.fillWidth:true;Layout.preferredHeight:160;wrapMode:TextEdit.Wrap;selectByMouse:true;textFormat:TextEdit.PlainText;color:Theme.text;font.pixelSize:11;placeholderText:'{"id":"…","expected_revision":1,"claim":{},"witness":{"observation_id":"…","quote":"…"}}';background:Rectangle{color:Theme.input;radius:7} }
    RowLayout {
        Layout.fillWidth:true
        CButton { objectName:"graphMemoryCorrect";text:"Correct";enabled:inspector.pending<0;onClicked:inspector.mutate("correct") }
        CButton { text:"Resolve conflict";enabled:inspector.pending<0;onClicked:inspector.mutate("resolve_conflict") }
        CButton { text:"Archive episode";enabled:inspector.pending<0&&record.text.length>0;onClicked:{inspector.preview={};inspector.call("consolidate",{id:record.text})} }
    }
    CText { text:"Collector policy";font.weight:Font.DemiBold }
    CText { visible:!inspector.policyLoaded;text:inspector.policyRequest>=0?"Loading the saved collector policy…":"The saved collector policy could not be loaded; controls stay disabled.";color:Theme.muted;font.pixelSize:12 }
    CCheckBox { objectName:"policyHyprland";text:"Observe Hyprland workspace";enabled:inspector.policyLoaded;checked:inspector.policy.hyprland_enabled===true;onClicked:inspector.updatePolicy({hyprland_enabled:checked}) }
    CCheckBox { objectName:"policyFish";text:"Enable Fish events";enabled:inspector.policyLoaded;checked:inspector.policy.fish_enabled===true;onClicked:inspector.updatePolicy({fish_enabled:checked}) }
    CCheckBox { objectName:"policyKitty";text:"Inspect configured Kitty endpoint";enabled:inspector.policyLoaded;checked:inspector.policy.kitty_enabled===true;onClicked:inspector.updatePolicy({kitty_enabled:checked}) }
    CCheckBox { objectName:"policyTitles";text:"Capture titles of approved applications";enabled:inspector.policyLoaded;checked:inspector.policy.capture_titles===true;onClicked:inspector.updatePolicy({capture_titles:checked}) }
    CField { id:titleApps;objectName:"policyTitleApplications";Layout.fillWidth:true;enabled:inspector.policyLoaded;placeholderText:"Application classes for titles, comma-separated (for example kitty)";Accessible.name:"Approved title applications";text:(inspector.policy.title_applications||[]).join(", ") }
    CButton { text:"Save title applications";enabled:inspector.policyLoaded;onClicked:inspector.updatePolicy({title_applications:titleApps.text.split(",").map(s=>s.trim()).filter(s=>s.length)}) }
    CText { text:"Titles are captured only when title capture is on and the window’s application class is listed.";color:Theme.muted;font.pixelSize:11;wrapMode:Text.Wrap }
    CCheckBox { objectName:"policyHistory";text:"Retain workspace history";enabled:inspector.policyLoaded;checked:inspector.policy.history_enabled===true;onClicked:inspector.updatePolicy({history_enabled:checked}) }
    CField { id:roots;objectName:"policyRoots";Layout.fillWidth:true;enabled:inspector.policyLoaded;placeholderText:"Approved roots (JSON array of absolute paths)";Accessible.name:"Approved filesystem roots";text:JSON.stringify(inspector.policy.approved_roots||[]) }
    CButton { text:"Save roots";enabled:inspector.policyLoaded;onClicked:{try{inspector.updatePolicy({approved_roots:JSON.parse(roots.text)})}catch(e){inspector.error="Enter a JSON array of absolute paths."}} }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Rebuild graph";enabled:inspector.pending<0;onClicked:inspector.call("rebuild",{backend:"graph"}) }
        CButton { text:"Rebuild vectors";enabled:inspector.pending<0;onClicked:inspector.call("rebuild",{backend:"vector"}) }
    }
    CText { visible:!!inspector.error;text:inspector.error;color:Theme.danger;font.pixelSize:12;wrapMode:Text.Wrap }
    CButton { text:"Done";onClicked:inspector.close() }
    Connections { target:App;function onResult(id,value){
        if(id===inspector.policyRequest){
            inspector.policyRequest=-1
            if(value?.error){inspector.error=value.error;inspector.policyLoaded=false;return}
            inspector.policy=value.policy||{};inspector.policyLoaded=!!value.policy;return
        }
        if(id!==inspector.pending)return
        inspector.pending=-1
        if(value?.error){inspector.error=value.error;if(value.code==="REVISION_CONFLICT"||value.code==="SELECTION_MISMATCH"||value.code==="CONNECTION_LOST")inspector.preview={};return}
        inspector.result=value
        if(inspector.action==="inspect"){
            inspector.inspected=value
            const r=value.record
            // The complete typed claim round-trips; nothing falls back to schema defaults.
            if(r?.version_id&&r.claim_data)mutation.text=JSON.stringify({id:r.version_id,expected_revision:r.aggregate_revision,claim:r.claim_data,witness:{observation_id:"",quote:""}},null,2)
        }
        // The selection binds to the ID the preview was requested for, never a later edit.
        if(inspector.action==="forget_preview"&&value.selection&&inspector.previewTarget===record.text)inspector.preview={sessionId:inspector.sessionId,id:inspector.previewTarget,revision:value.revision,selection:value.selection,selector:value.selector,target_ids:value.target_ids,count:value.count}
        if(inspector.action==="forget"){inspector.erasureJob=value.job_id;inspector.preview={}}
        if(["correct","resolve_conflict","consolidate","rebuild"].includes(inspector.action))inspector.preview={}
    } }
    Connections { target:App;function onStateChanged(){if(!App.connected){inspector.preview={};inspector.policyLoaded=false}} }
}
