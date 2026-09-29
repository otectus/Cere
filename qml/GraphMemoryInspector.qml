import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id: inspector; objectName:"graphMemoryInspector"
    focus:true
    property string sessionId:""
    property int pending:-1
    property string action:""
    property string error:""
    property var result:({})
    property var policy:({})
    property var inspected:({})
    property var preview:({})
    property string erasureJob:""
    function call(method,params){error="";action=method;pending=App.rpc("memory.graph",{sessionId:sessionId,method:method,params:params||{}})}
    function mutate(method){try{let body=JSON.parse(mutation.text);call(method,body)}catch(e){error="Enter valid structured JSON: "+e.message}}
    function openRecord(id){record.text=id;call("inspect",{id:id})}
    onOpened:{result={};inspected={};preview={};erasureJob="";call("health",{})}
    CText { text:"Graph memory inspector";font.pixelSize:20;font.weight:Font.DemiBold }
    CText { text:"Review sources, temporal history, task episodes and current workspace. Changes use the selected conversation’s project scope.";color:Theme.muted;font.pixelSize:12 }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Health";enabled:inspector.pending<0;onClicked:inspector.call("health",{}) }
        CButton { text:"Workspace";enabled:inspector.pending<0;onClicked:inspector.call("workspace",{}) }
        CButton { text:"Policy";enabled:inspector.pending<0;onClicked:inspector.call("policy_get",{}) }
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
            CButton { text:"Inspect evidence and history";onClicked:{record.text=modelData.id;inspector.call("inspect",{id:modelData.id})} }
        }
    }
    CField { id:record;objectName:"graphMemoryRecord";Layout.fillWidth:true;placeholderText:"Record ID";Accessible.name:"Memory record ID" }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Inspect";enabled:inspector.pending<0&&record.text.length>0;onClicked:inspector.call("inspect",{id:record.text}) }
        CButton { text:"Preview forgetting";enabled:inspector.pending<0&&record.text.length>0;onClicked:inspector.call("forget_preview",{id:record.text}) }
    }
    CText { visible:!!inspector.preview.count;text:"Forgetting suppresses "+inspector.preview.count+" records and dependent copies immediately. Physical purge waits for database acknowledgements.";color:Theme.amber;font.pixelSize:12 }
    CButton { visible:!!inspector.preview.count;text:"Forget these records";danger:true;enabled:inspector.pending<0;onClicked:inspector.call("forget",{id:record.text,expected_revision:inspector.preview.revision}) }
    CButton { visible:!!inspector.erasureJob;text:"Check purge progress";onClicked:inspector.call("erasure_status",{job_id:inspector.erasureJob}) }
    CText { text:"Details";font.weight:Font.DemiBold }
    TextArea { objectName:"graphMemoryDetails";Layout.fillWidth:true;Layout.preferredHeight:240;readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap;text:JSON.stringify(inspector.result,null,2);textFormat:TextEdit.PlainText;color:Theme.text;font.pixelSize:11;background:Rectangle{color:Theme.input;radius:7} }
    CText { text:"Correction / resolution";font.weight:Font.DemiBold }
    CText { text:"Inspect an assertion to load its revision. Supply the replacement claim and a source observation with an exact quotation. Dates are half-open UTC microsecond bounds. Ambiguous changes remain reviewable candidates.";color:Theme.muted;font.pixelSize:12 }
    TextArea { id:mutation;objectName:"graphMemoryMutation";Layout.fillWidth:true;Layout.preferredHeight:160;wrapMode:TextEdit.Wrap;selectByMouse:true;textFormat:TextEdit.PlainText;color:Theme.text;font.pixelSize:11;placeholderText:'{"id":"…","expected_revision":1,"claim":{},"witness":{"observation_id":"…","quote":"…"}}';background:Rectangle{color:Theme.input;radius:7} }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Correct";enabled:inspector.pending<0;onClicked:inspector.mutate("correct") }
        CButton { text:"Resolve conflict";enabled:inspector.pending<0;onClicked:inspector.mutate("resolve_conflict") }
        CButton { text:"Archive episode";enabled:inspector.pending<0&&record.text.length>0;onClicked:inspector.call("consolidate",{id:record.text}) }
    }
    CText { text:"Collector policy";font.weight:Font.DemiBold }
    CCheckBox { text:"Observe Hyprland workspace";checked:inspector.policy.hyprland_enabled||false;onClicked:inspector.call("policy_update",{policy:{hyprland_enabled:checked}}) }
    CCheckBox { text:"Enable Fish events";checked:inspector.policy.fish_enabled||false;onClicked:inspector.call("policy_update",{policy:{fish_enabled:checked}}) }
    CCheckBox { text:"Inspect configured Kitty endpoint";checked:inspector.policy.kitty_enabled||false;onClicked:inspector.call("policy_update",{policy:{kitty_enabled:checked}}) }
    CCheckBox { text:"Capture approved application titles";checked:inspector.policy.capture_titles||false;onClicked:inspector.call("policy_update",{policy:{capture_titles:checked}}) }
    CCheckBox { text:"Retain workspace history";checked:inspector.policy.history_enabled||false;onClicked:inspector.call("policy_update",{policy:{history_enabled:checked}}) }
    CField { id:roots;Layout.fillWidth:true;placeholderText:"Approved roots (one per line in JSON array)";Accessible.name:"Approved filesystem roots";text:JSON.stringify(inspector.policy.approved_roots||[]) }
    CButton { text:"Save roots";onClicked:{try{inspector.call("policy_update",{policy:{approved_roots:JSON.parse(roots.text)}})}catch(e){inspector.error="Enter a JSON array of absolute paths."}} }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Rebuild graph";enabled:inspector.pending<0;onClicked:inspector.call("rebuild",{backend:"graph"}) }
        CButton { text:"Rebuild vectors";enabled:inspector.pending<0;onClicked:inspector.call("rebuild",{backend:"vector"}) }
    }
    CText { visible:!!inspector.error;text:inspector.error;color:Theme.danger;font.pixelSize:12 }
    CButton { text:"Done";onClicked:inspector.close() }
    Connections { target:App;function onResult(id,value){if(id!==inspector.pending)return;inspector.pending=-1;if(value?.error){inspector.error=value.error;return}inspector.result=value;if(value.policy)inspector.policy=value.policy;if(inspector.action==="inspect"){inspector.inspected=value;let r=value.record;if(r?.version_id){mutation.text=JSON.stringify({id:r.version_id,expected_revision:r.aggregate_revision,claim:{subject:r.subject,predicate:r.predicate,object:r.object||undefined,value:r.value_json?JSON.parse(r.value_json):undefined,qualifiers:JSON.parse(r.qualifiers||"{}"),valid_mode:r.valid_mode,valid_from_us:r.valid_from_us,valid_to_us:r.valid_to_us},witness:{observation_id:"",quote:""}},null,2)}}if(inspector.action==="forget_preview")inspector.preview=value;if(inspector.action==="forget"){inspector.erasureJob=value.job_id;inspector.preview={}}} }
}
