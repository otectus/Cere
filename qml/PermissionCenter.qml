import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CDialog {
    id:center
    objectName:"permissionCenter"
    property string sessionId:""
    property var inspection:({power:[],effective:[],grants:[],categories:[],providers:[]})
    property int inspectRequest:-1
    property int actionRequest:-1
    property string action:""
    property string error:""
    property double clock:Date.now()
    readonly property var selectedAccess:(inspection.effective||[]).find(row=>row.sessionId===sessionId)||({})
    readonly property bool selectedIdle:selectedAccess.status==="idle"

    function inspect(){
        if(inspectRequest>=0||!App.connected)return
        error=""
        inspectRequest=App.rpc("permissions.inspect",sessionId?{sessionId:sessionId}:{})
    }
    function call(method,params){
        if(actionRequest>=0)return
        error="";action=method;actionRequest=App.rpc(method,params||{})
    }
    function remaining(expiresAt){
        const seconds=Math.max(0,Math.ceil((Number(expiresAt||0)-clock)/1000))
        if(seconds<60)return seconds+"s"
        return Math.floor(seconds/60)+"m "+String(seconds%60).padStart(2,"0")+"s"
    }
    function accessLabel(row){
        let access=[]
        if(row.cli)access.push("CLI full access")
        if(row.computer)access.push("computer control")
        return access.length?access.join(" + "):"manual permissions"
    }

    onOpened:{
        sessionId=App.selectedId||""
        cliAccess.checked=false;computerAccess.checked=false
        inspection={power:[],effective:[],grants:[],categories:[],providers:[]};inspect()
    }
    onSessionIdChanged:{cliAccess.checked=false;computerAccess.checked=false;if(opened)inspect()}

    CText { text:"Permission Center";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText {
        text:"Review Cere’s standing desktop permissions and grant short, project-bound power access to an idle managed session. Existing permission requests still need your answer."
        color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap
    }
    CText {
        visible:!!center.inspection.warning
        text:center.inspection.warning||""
        color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap
    }
    CText {
        text:"Power access changes Cere and provider permission handling for the selected sessions. It is not operating-system containment and cannot constrain processes outside Cere."
        color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap
    }

    CText {
        visible:center.inspection.persistent?.cli===true||center.inspection.persistent?.computer===true
        text:"Persistent permission skipping: "+[center.inspection.persistent?.cli?"CLI":"",center.inspection.persistent?.computer?"computer":""].filter(value=>value).join(" + ")+". Change these switches in Settings → AI assistance."
        color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap
    }
    Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
    CText { text:"Selected session";font.weight:Font.DemiBold }
    CText {
        text:center.sessionId?(center.selectedAccess.title||"Selected session")+" · "+(center.selectedAccess.provider||"unknown provider")+" · "+(center.selectedAccess.status||"unavailable"):"Select a session before opening Permission Center."
        color:center.sessionId?Theme.text:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap
    }
    CText { visible:!!center.selectedAccess.cwd;text:center.selectedAccess.cwd||"";color:Theme.cyan;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    CText {
        visible:!!center.selectedAccess.leaseId
        text:"Power active: "+center.accessLabel(center.selectedAccess)+" · "+center.remaining(center.selectedAccess.expiresAt)+" remaining"
        color:Theme.amber;font.pixelSize:Theme.secondary;font.weight:Font.DemiBold;wrapMode:Text.Wrap
    }
    CText {
        visible:!!center.sessionId&&!center.selectedIdle&&!center.selectedAccess.leaseId
        text:"Stop the provider turn before starting power access. Linked, historical, and remote sessions are excluded."
        color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap
    }
    CCheckBox { id:cliAccess;objectName:"powerCliAccess";text:"CLI full access";checked:false;enabled:!center.selectedAccess.leaseId }
    CText { text:"Launch this session’s provider without its permission prompts or optional sandbox for the lease duration.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    CCheckBox { id:computerAccess;objectName:"powerComputerAccess";text:"Computer control";checked:false;enabled:!center.selectedAccess.leaseId }
    CText { text:"Allow Cere desktop tools and captures for this session without category prompts during the lease.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    RowLayout {
        Layout.fillWidth:true
        CText { text:"Duration";font.pixelSize:Theme.secondary;Layout.fillWidth:true }
        CSpinBox { id:duration;objectName:"powerDuration";from:1;to:120;value:15;Accessible.name:"Power duration in minutes" }
        CText { text:"minutes";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CButton {
        objectName:"startPower";Layout.fillWidth:true;primary:true
        text:center.actionRequest>=0&&center.action==="power.start"?"Starting…":"Start power access"
        enabled:center.actionRequest<0&&!!center.sessionId&&center.selectedIdle&&!center.selectedAccess.leaseId&&(cliAccess.checked||computerAccess.checked)
        onClicked:center.call("power.start",{sessionIds:[center.sessionId],minutes:duration.value,cli:cliAccess.checked,computer:computerAccess.checked})
    }

    CText { text:"Active and recent leases";font.weight:Font.DemiBold }
    CText { visible:!(center.inspection.power||[]).length;text:"No power leases in this broker process.";color:Theme.muted;font.pixelSize:Theme.secondary }
    Repeater {
        model:center.inspection.power||[]
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true;spacing:5
            CText {
                text:center.accessLabel(modelData)+" · "+modelData.state+(modelData.state==="active"?" · "+center.remaining(modelData.expiresAt):"")
                color:modelData.state==="active"?Theme.amber:modelData.state==="unconfirmed"?Theme.danger:Theme.text
                font.pixelSize:Theme.secondary;font.weight:Font.DemiBold;wrapMode:Text.Wrap
            }
            CText { text:modelData.cwd+" · "+(modelData.sessionIds||[]).length+" session"+((modelData.sessionIds||[]).length===1?"":"s")+" · revision "+modelData.revision;color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
            CText { visible:!!modelData.reason;text:"Reason: "+modelData.reason;color:Theme.muted;font.pixelSize:Theme.caption }
            CButton {
                visible:modelData.state==="active"||modelData.state==="ending"||modelData.state==="unconfirmed"
                text:modelData.state==="ending"?"Ending…":modelData.state==="unconfirmed"?"Retry provider stop":"End power access"
                danger:true;enabled:(modelData.state==="active"||modelData.state==="unconfirmed")&&center.actionRequest<0
                onClicked:center.call("power.end",{id:modelData.id})
            }
            Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
        }
    }

    CText { text:"Cere actions";font.weight:Font.DemiBold }
    CText { text:"Profile: "+(center.inspection.profile||"manual")+" · enabled categories: "+((center.inspection.categories||[]).join(", ")||"none");color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    CButton {
        objectName:"pauseCereActions";Layout.fillWidth:true
        text:center.inspection.paused?"Resume Cere actions":"Pause Cere actions"
        onClicked:center.call("settings.update",{paused:!center.inspection.paused})
    }
    CButton {
        objectName:"stopPermissionProvider";Layout.fillWidth:true;danger:true;text:"Stop provider"
        enabled:center.actionRequest<0&&!!center.sessionId&&["starting","working","waiting","stopping"].indexOf(center.selectedAccess.status)>=0
        onClicked:center.call("session.stop",{id:center.sessionId})
    }

    CText { text:center.selectedAccess.termination||"";visible:text.length>0;color:Theme.amber;wrapMode:Text.Wrap }
    CText { text:"Standing project grants";font.weight:Font.DemiBold }
    CText { visible:!(center.inspection.grants||[]).length;text:"No standing desktop grants.";color:Theme.muted;font.pixelSize:Theme.secondary }
    Repeater {
        model:center.inspection.grants||[]
        RowLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { Layout.fillWidth:true;text:modelData.category+" · "+modelData.cwd;color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
            CButton { text:"Revoke";danger:true;enabled:center.actionRequest<0;onClicked:center.call("permissions.revoke",{category:modelData.category,cwd:modelData.cwd}) }
        }
    }

    CText { visible:!!center.error;text:center.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Refresh";Layout.fillWidth:true;enabled:center.inspectRequest<0&&center.actionRequest<0;onClicked:center.inspect() }
        CButton { text:"Done";Layout.fillWidth:true;onClicked:center.close() }
    }

    Timer {
        interval:1000;repeat:true;running:center.opened
        onTriggered:{center.clock=Date.now();if(Math.floor(center.clock/5000)!==Math.floor((center.clock-1000)/5000))center.inspect()}
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id===center.inspectRequest){center.inspectRequest=-1;if(value?.error)center.error=value.error;else center.inspection=value||({});return}
            if(id!==center.actionRequest)return
            center.actionRequest=-1
            if(value?.error){center.error=value.error;return}
            if(center.action==="power.start"){cliAccess.checked=false;computerAccess.checked=false}
            center.inspect()
        }
        function onStateChanged(){if(center.opened&&center.inspectRequest<0)center.inspect()}
    }
}
