import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
    id:list
    property bool compact: false
    property bool activeOnly: false
    property bool historyExpanded: false
    signal createRequested()
    signal sessionActivated()
    function focusSearch() { filter.forceActiveFocus() }
    property var history: []
    property int historyRequest: -1
    property string error: ""
    property var filtered: (App.state.sessions||[]).filter(s=>(s.title+" "+s.cwd+" "+s.provider).toLowerCase().indexOf(filter.text.toLowerCase())>=0 && (!activeOnly || ["starting","working","waiting","stopping"].indexOf(s.status)>=0))
    function activeAgentCount(session) {
        return (session.agents || []).filter(agent => ["starting", "running", "waiting"].indexOf(agent.status) >= 0).length
    }
    function pendingInputCount(session) {
        return (App.state.approvals || []).filter(approval => approval.sessionId === session.id).length
    }
    function statusLabel(session) {
        const pending = pendingInputCount(session)
        const active = activeAgentCount(session)
        if (pending) return pending === 1 ? "waiting for input" : pending + " inputs needed"
        if (active) return active === 1 ? "1 subagent active" : active + " subagents active"
        switch (session.activity) {
        case "thinking": return "thinking"
        case "speaking": return "responding"
        case "working": return "using tools"
        case "delegating": return "delegating"
        case "waitingForAgents": return "waiting for subagents"
        case "compacting": return "compacting context"
        case "planning": return "planning"
        default: return session.mode === "linked" && session.status === "idle" ? "linked terminal" : session.status
        }
    }
    spacing: compact ? 10 : 16
    RowLayout {
        Layout.fillWidth:true
        CText { text:list.compact?"RECENT SESSIONS":"Sessions";color:list.compact?Theme.muted:Theme.text;font.pixelSize:list.compact?10:26;font.letterSpacing:list.compact?1.4:0;font.weight:Font.DemiBold }
        Text { visible:list.compact;text:(App.state.sessions||[]).length;color:Theme.muted;font.family:Theme.font;font.pixelSize:11 }
        CButton { visible:!list.compact;objectName:"newSession";text:"New session";iconName:"plus";primary:true;onClicked:list.createRequested() }
    }
    CText { visible:!list.compact;text:"Pick up where you left off, or start something new.";color:Theme.muted }
    CField { id:filter;objectName:list.compact?"sidebarSessionSearch":"sessionSearch";placeholderText:"Find a session…";Layout.fillWidth:true;Accessible.name:"Find a session" }
    RowLayout {
        visible:!list.compact;Layout.fillWidth:true;spacing:6
        CButton { text:"All";quiet:true;primary:!list.activeOnly;implicitHeight:30;onClicked:list.activeOnly=false;Accessible.role:Accessible.PageTab;Accessible.selected:!list.activeOnly }
        CButton { text:"Working";quiet:true;primary:list.activeOnly;implicitHeight:30;onClicked:list.activeOnly=true;Accessible.role:Accessible.PageTab;Accessible.selected:list.activeOnly }
        Item { Layout.fillWidth:true }
    }
    ListView {
        id:sessionViewport
        Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumHeight:48
        clip:true;spacing:4;boundsBehavior:Flickable.StopAtBounds
        ScrollBar.vertical:CScrollBar{}
        model:list.filtered
        delegate:CButton {
            id:sessionRow
            required property var modelData
            width:sessionViewport.width-10
            implicitHeight:list.compact?72:82
            objectName:"session_"+modelData.id
            text:modelData.title;quiet:true
            primary:App.selectedId===modelData.id
            help:modelData.title+"\n"+modelData.provider+" · "+list.statusLabel(modelData)+"\n"+modelData.cwd
            Accessible.name:modelData.title+", "+modelData.provider+", "+list.statusLabel(modelData)
            Accessible.selected:App.selectedId===modelData.id
            onClicked:{App.selectedId=modelData.id;list.sessionActivated()}
            contentItem:ColumnLayout {
                spacing:6
                RowLayout {
                    Layout.fillWidth:true;spacing:8
                    Text {
                        Layout.fillWidth:true;Layout.minimumWidth:0
                        text:sessionRow.modelData.title;wrapMode:Text.Wrap;maximumLineCount:2;elide:Text.ElideRight
                        color:Theme.text;font.family:Theme.font;font.pixelSize:13;font.weight:Font.Medium;textFormat:Text.PlainText
                    }
                    Rectangle {
                        width:6;height:6;radius:3
                        color:list.pendingInputCount(sessionRow.modelData)>0?Theme.amber:["starting","working","stopping"].indexOf(sessionRow.modelData.status)>=0?Theme.cyan:Theme.line
                    }
                }
                Text {
                    Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideRight
                    text:sessionRow.modelData.provider.charAt(0).toUpperCase()+sessionRow.modelData.provider.slice(1)+" · "+list.statusLabel(sessionRow.modelData)
                    color:Theme.muted;font.family:Theme.font;font.pixelSize:11
                }
                Text {
                    visible:!list.compact;Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideMiddle
                    text:sessionRow.modelData.cwd;color:Theme.muted;font.family:Theme.font;font.pixelSize:11;textFormat:Text.PlainText
                }
            }
        }
        CText {
            visible:!list.filtered.length;width:parent.width-12;anchors.top:parent.top;anchors.topMargin:12
            text:filter.text?"No sessions match your search.":list.activeOnly?"All caught up. No sessions are working.":"A fresh start. Create your first session."
            color:Theme.muted;font.pixelSize:12
        }
    }
    CText { visible:list.error.length>0;text:list.error;color:Theme.danger;font.pixelSize:12 }
    CButton {
        Layout.fillWidth:true;quiet:true;alignLeft:true;iconName:"sessions"
        text:list.historyExpanded?"Hide terminal history":"Import terminal session"
        help:"Continue a completed Codex or Claude conversation"
        onClicked:list.historyExpanded=!list.historyExpanded
    }
    ColumnLayout {
        visible:list.historyExpanded;Layout.fillWidth:true;spacing:8
        CText { text:list.historyRequest>=0?"Loading history…":"Continue a completed conversation.";color:Theme.muted;font.pixelSize:11 }
        RowLayout {
            Layout.fillWidth:true;spacing:6
            CButton { text:"Codex";Layout.fillWidth:true;enabled:list.historyRequest<0&&App.connected;onClicked:{list.error="";list.historyRequest=App.rpc("session.history",{provider:"codex"})} }
            CButton { text:"Claude";Layout.fillWidth:true;enabled:list.historyRequest<0&&App.connected;onClicked:{list.error="";list.historyRequest=App.rpc("session.history",{provider:"claude"})} }
        }
        PageScroll {
            visible:list.history.length>0;Layout.fillWidth:true;Layout.preferredHeight:Math.min(220,list.height*.35)
            Repeater {
                model:list.history
                CActionRow { required property var modelData;Layout.fillWidth:true;text:modelData.title;detail:modelData.cwd||"Continue this conversation";onClicked:{importSession.imported=modelData;importSession.open()} }
            }
        }
    }
    Connections { target:App;function onResult(id,value){if(id===list.historyRequest){list.historyRequest=-1;if(value?.error)list.error=value.error;else list.history=value}} }
    NewSession { id:importSession;onSessionOpened:list.sessionActivated() }
}
