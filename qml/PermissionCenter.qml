import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CDialog {
    id:center
    accessibleTitle:"Permission Center"
    objectName:"permissionCenter"
    property string sessionId:""
    property var inspection:({power:[],effective:[],grants:[],categories:[],providers:[]})
    property int inspectRequest:-1
    property bool inspectionReady:false
    property int actionRequest:-1
    property string action:""
    property string error:""
    property double clock:Date.now()
    readonly property var inspectedAccess:(inspection.effective||[]).find(row=>row.sessionId===sessionId)||({})
    // The broker inspection remains authoritative. While it is in flight, use only blockers already
    // present in the selected session snapshot so the dialog never flashes an empty or enabling state.
    readonly property var localSession:sessionId&&sessionId===App.selectedId?(App.session||({})):({})
    readonly property var selectedAccess:inspectedAccess.sessionId?inspectedAccess:localSession.id?({
        sessionId:localSession.id,title:localSession.title||"Selected session",cwd:localSession.cwd||"",
        provider:localSession.provider||"unknown provider",status:localSession.status||"unavailable",
        mode:localSession.mode||"",remote:!!localSession.remote,temporary:!!localSession.temporary,
        canStartPower:false,powerUnavailableReason:localPowerReason(localSession)
    }):({})
    readonly property bool canStartPower:selectedAccess.canStartPower===true

    function localPowerReason(session){
        if(session.mode&&session.mode!=="managed")return "Power mode only supports managed sessions"
        if(session.temporary)return "Power mode is unavailable for temporary sessions"
        if(session.remote)return "Power mode is unavailable for remote sessions"
        if(session.status&&session.status!=="idle")return "Stop the selected session before enabling power mode"
        return "Checking power availability…"
    }

    function inspect(){
        if(inspectRequest>=0||!App.connected)return
        error=""
        inspectRequest=App.rpc("permissions.inspect",sessionId?{sessionId:sessionId}:{})
    }
    function call(method,params){
        if(actionRequest>=0||!App.connected)return
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
        inspectionReady=false;inspection={power:[],effective:[],grants:[],categories:[],providers:[]};inspect()
    }
    onClosed: { inspectRequest = -1; inspectionReady = false }
    onSessionIdChanged: {
        cliAccess.checked = false
        computerAccess.checked = false
        inspectionReady = false
        inspectRequest = -1
        if (opened) inspect()
    }

    CText { text:center.accessibleTitle;font.pixelSize:Theme.title;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading }
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
    CText { visible:!App.connected;text:qsTr("Reconnect to review or change access.");color:Theme.amber }
    SectionLabel { text:"SELECTED SESSION";Accessible.role:Accessible.Heading }
    CText {
        text:center.sessionId?(center.selectedAccess.title||"Selected session")+" · "+(center.selectedAccess.provider||"unknown provider")+" · "+(center.selectedAccess.status||"unavailable"):"Select a session before opening Permission Center."
        color:center.sessionId?Theme.text:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap
    }
    CText { visible:!!center.selectedAccess.cwd;text:center.selectedAccess.cwd||"";color:Theme.accentText;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    CText {
        visible:!!center.selectedAccess.leaseId
        text:"Power active: "+center.accessLabel(center.selectedAccess)+" · "+center.remaining(center.selectedAccess.expiresAt)+" remaining"
        color:Theme.amber;font.pixelSize:Theme.secondary;font.weight:Font.DemiBold;wrapMode:Text.Wrap
    }
    CText {
        visible:!!center.sessionId&&!center.canStartPower&&!center.selectedAccess.leaseId
        text:center.selectedAccess.powerUnavailableReason||"Power access is unavailable for this session."
        color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap
    }
    CCheckBox { id:cliAccess;objectName:"powerCliAccess";visible:center.inspectionReady&&!!center.sessionId;text:"CLI full access";checked:false;enabled:!center.selectedAccess.leaseId }
    CText { visible:center.inspectionReady&&!!center.sessionId;text:"Launch this session’s provider without its permission prompts or optional sandbox for the lease duration.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    CCheckBox { id:computerAccess;objectName:"powerComputerAccess";visible:center.inspectionReady&&!!center.sessionId;text:"Computer control";checked:false;enabled:!center.selectedAccess.leaseId }
    CText { visible:center.inspectionReady&&!!center.sessionId;text:"Allow Cere desktop tools and captures for this session without category prompts during the lease.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    RowLayout {
        visible:center.inspectionReady&&!!center.sessionId;Layout.fillWidth:true
        CText { text:"Duration";font.pixelSize:Theme.secondary;Layout.fillWidth:true }
        CSpinBox { id:duration;objectName:"powerDuration";from:1;to:120;value:15;Accessible.name:"Power duration in minutes" }
        CText { text:"minutes";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CButton {
        objectName:"startPower";Layout.fillWidth:true;primary:true
        prominent:true
        visible:center.inspectionReady&&!!center.sessionId
        text:center.actionRequest>=0&&center.action==="power.start"?"Starting…":"Start power access"
        enabled:App.connected && center.actionRequest<0&&!!center.sessionId&&center.canStartPower&&!center.selectedAccess.leaseId&&(cliAccess.checked||computerAccess.checked)
        onClicked:center.call("power.start",{sessionIds:[center.sessionId],minutes:duration.value,cli:cliAccess.checked,computer:computerAccess.checked})
    }

    SectionLabel { text:"ACTIVE & RECENT LEASES";Accessible.role:Accessible.Heading;Layout.topMargin:Theme.space1 }
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
                danger:true;enabled:App.connected && (modelData.state==="active"||modelData.state==="unconfirmed")&&center.actionRequest<0
                onClicked:center.call("power.end",{id:modelData.id})
            }
            Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
        }
    }

    SectionLabel { text:"CERE ACTIONS";Accessible.role:Accessible.Heading;Layout.topMargin:Theme.space1 }
    CText { text:"Profile: "+(center.inspection.profile||"manual")+" · enabled categories: "+((center.inspection.categories||[]).join(", ")||"none");color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    CButton {
        objectName:"pauseCereActions";Layout.fillWidth:true
        text:center.inspection.paused?"Resume Cere actions":"Pause Cere actions"
        onClicked:center.call("settings.update",{paused:!center.inspection.paused})
    }
    CButton {
        objectName:"stopPermissionProvider";Layout.fillWidth:true;danger:true;text:"Stop provider"
        enabled:App.connected && center.actionRequest<0&&!!center.sessionId&&["starting","working","waiting","stopping"].indexOf(center.selectedAccess.status)>=0
        onClicked:center.call("session.stop",{id:center.sessionId})
    }

    CText { text:center.selectedAccess.termination||"";visible:text.length>0;color:Theme.amber;wrapMode:Text.Wrap }
    SectionLabel { text:"STANDING PROJECT GRANTS";Accessible.role:Accessible.Heading;Layout.topMargin:Theme.space1 }
    CText { visible:!(center.inspection.grants||[]).length;text:"No standing desktop grants.";color:Theme.muted;font.pixelSize:Theme.secondary }
    Repeater {
        model:center.inspection.grants||[]
        RowLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { Layout.fillWidth:true;text:modelData.category+" · "+modelData.cwd;color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
            CButton { text:"Revoke";danger:true;enabled:App.connected && center.actionRequest<0;onClicked:center.call("permissions.revoke",{category:modelData.category,cwd:modelData.cwd}) }
        }
    }

    CText { visible:!!center.error;text:center.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    footerContent:Component { RowLayout {
        Layout.fillWidth:true;spacing:Theme.space2
        CButton { text:"Refresh";Layout.fillWidth:true;enabled:App.connected && center.inspectRequest<0&&center.actionRequest<0;onClicked:center.inspect() }
        CButton { text:"Done";Layout.fillWidth:true;onClicked:center.close() }
    } }

    Timer {
        interval:1000;repeat:true;running:center.opened
        onTriggered:{center.clock=Date.now();if(Math.floor(center.clock/5000)!==Math.floor((center.clock-1000)/5000))center.inspect()}
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id===center.inspectRequest){center.inspectRequest=-1;if(value?.error)center.error=value.error;else{center.inspection=value||({});center.inspectionReady=true}return}
            if(id!==center.actionRequest)return
            center.actionRequest=-1
            if(value?.error){center.error=value.error;return}
            if(center.action==="power.start"){cliAccess.checked=false;computerAccess.checked=false}
            center.inspect()
        }
        function onStateChanged(){if(center.opened&&center.inspectRequest<0)center.inspect()}
    }
}
