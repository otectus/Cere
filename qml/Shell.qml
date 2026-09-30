import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: shell
    property bool expanded: false
    property int page: 0
    property real pageOffset: 0
    readonly property bool animateNavigation: !expanded && !settings.reducedMotion && !settings.quiet
    onPageChanged: { pageSlide.stop();pageOffset=0;syncApprovals() }
    onAnimateNavigationChanged: if(!animateNavigation){pageSlide.stop();pageOffset=0}
    function openConversation() {
        const fromSessions=page===1
        page=0
        if(fromSessions&&animateNavigation){pageSlide.from=pageViewport.width;pageSlide.restart()}
        Qt.callLater(()=>conversation.focusComposer())
    }
    function showSessions() {
        page=1
        if(animateNavigation){pageSlide.from=-pageViewport.width;pageSlide.restart()}
        sessionsPage.focusSearch()
    }
    NumberAnimation { id:pageSlide;target:shell;property:"pageOffset";to:0;duration:180;easing.type:Easing.OutCubic }
    property var settings: App.state.settings || ({})
    property var sessions: App.state.sessions || []
    property var approvals: App.state.approvals || []
    property var globalApprovals: []
    property string approvalSessionId: App.selectedId
    function syncApprovals() {
        const next = approvals.filter(a => !(page===0 && a.sessionId===App.selectedId && (a.kind==="question" || (a.questions||[]).length>0)))
        if (JSON.stringify(next)!==JSON.stringify(globalApprovals)) globalApprovals=next
    }
    onApprovalsChanged: syncApprovals()
    onApprovalSessionIdChanged: syncApprovals()
    readonly property int activeAgents: sessions.reduce((count,s) => count+(s.agents||[]).filter(a => ["starting","running","waiting"].indexOf(a.status)>=0).length,0)
    readonly property int busySessions: sessions.filter(s => ["starting","working","stopping"].indexOf(s.status)>=0).length
    color: Theme.background
    radius: expanded ? 0 : 14
    border.color: Theme.line
    border.width: expanded ? 0 : 1
    implicitWidth: expanded ? 1040 : 440; implicitHeight: expanded ? 780 : 720
    focus: true
    Keys.onEscapePressed: { if(page!==0)page=0;else App.closePanel() }
    Shortcut { sequence: "Ctrl+K"; onActivated: { shell.page=2; desktop.focusSearch() } }
    Shortcut { sequence: "Ctrl+N"; onActivated: newSession.open() }
    Shortcut { sequence: "Ctrl+,"; onActivated: shell.page=3 }
    readonly property bool wide: expanded && width >= 920
    readonly property string statusText: !App.connected ? "Reconnecting…" : approvals.length ? approvals.length+" waiting for input" : busySessions ? busySessions+" conversations working" : "Ready when you are"
    component HeaderPortrait: CerePortrait {
        Layout.preferredWidth: 64
        Layout.preferredHeight: 64
        settings: shell.settings
        session: App.session
        messages: App.messages
        approvals: shell.approvals
        speech: App.state.speech || ({})
        connected: App.connected
        listening: conversation.listening
        assetRoot: App.assetPath
    }
    RowLayout {
        anchors.fill: parent
        anchors.margins: shell.expanded ? 0 : 1
        spacing: 0
        Rectangle {
            visible: shell.wide
            Layout.preferredWidth: shell.width >= 1400 ? 280 : 248
            Layout.fillHeight: true
            color: Theme.sidebar
            Rectangle { anchors.right:parent.right; width:1; height:parent.height; color:Theme.subtle }
            ColumnLayout {
                anchors.fill:parent; anchors.margins:16; spacing:16
                RowLayout {
                    Layout.fillWidth:true; spacing:12; Layout.topMargin:8; Layout.bottomMargin:8
                    HeaderPortrait {}
                    ColumnLayout {
                        Layout.fillWidth:true; spacing:2
                        Text { text:"CERE";color:Theme.text;font.family:Theme.font;font.pixelSize:19;font.weight:Font.Bold;font.letterSpacing:3 }
                        Text { text:"Your desktop companion";color:Theme.muted;font.family:Theme.font;font.pixelSize:11 }
                    }
                }
                ColumnLayout {
                    Layout.fillWidth:true;spacing:4
                    Repeater {
                        model:[{label:"Chat",icon:"chat"},{label:"Sessions",icon:"sessions"},{label:"Desktop",icon:"desktop"},{label:"Settings",icon:"settings"}]
                        CButton {
                            required property var modelData;required property int index
                            objectName:"tab_"+modelData.label
                            Layout.fillWidth:true;implicitHeight:42
                            text:modelData.label;iconName:modelData.icon;alignLeft:true;quiet:true;primary:shell.page===index
                            Accessible.role:Accessible.PageTab;Accessible.selected:shell.page===index
                            onClicked:shell.page=index
                        }
                    }
                }
                CButton { objectName:"sidebarNewSession";Layout.fillWidth:true;text:"New session";iconName:"plus";primary:true;help:"Start a session (Ctrl+N)";onClicked:newSession.open() }
                Rectangle { Layout.fillWidth:true;height:1;color:Theme.subtle }
                SessionList {
                    visible:shell.page!==1
                    Layout.fillWidth:true;Layout.fillHeight:true
                    compact:true
                    onCreateRequested:newSession.open()
                    onSessionActivated:shell.openConversation()
                }
                Item { visible:shell.page===1;Layout.fillHeight:true }
                Rectangle { Layout.fillWidth:true;height:1;color:Theme.subtle }
                RowLayout {
                    Layout.fillWidth:true;spacing:8
                    Rectangle { width:6;height:6;radius:3;color:App.connected?Theme.success:Theme.amber }
                    CText { text:shell.statusText;color:Theme.muted;font.pixelSize:11;maximumLineCount:2;elide:Text.ElideRight }
                    CButton { text:"";iconName:"hide";quiet:true;help:"Hide window";Accessible.name:"Hide window";onClicked:App.closePanel() }
                }
            }
        }
        ColumnLayout {
            Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0
            Layout.margins:shell.wide?24:14
            spacing:shell.wide?16:10
            RowLayout {
                visible:!shell.wide
                Layout.fillWidth:true;spacing:10
                HeaderPortrait {}
                ColumnLayout {
                    Layout.fillWidth:true;Layout.minimumWidth:0;spacing:2
                    Text { text:"CERE";color:Theme.text;font.family:Theme.font;font.pixelSize:17;font.weight:Font.Bold;font.letterSpacing:3 }
                    CText { text:shell.statusText;color:Theme.muted;font.pixelSize:11;maximumLineCount:1;elide:Text.ElideRight }
                }
                CButton { text:expanded?"Hide":"Expand";iconName:expanded?"hide":"expand";quiet:true;onClicked:expanded?App.closePanel():App.expand() }
            }
            RowLayout {
                visible:!shell.wide;Layout.fillWidth:true;spacing:4
                Repeater {
                    model:["Chat","Sessions","Desktop","Settings"]
                    CButton {
                        required property string modelData;required property int index
                        objectName:"tab_"+modelData;Layout.fillWidth:true;Layout.preferredWidth:1
                        text:modelData;quiet:true;primary:shell.page===index
                        leftPadding:6;rightPadding:6
                        Accessible.role:Accessible.PageTab;Accessible.selected:shell.page===index
                        onClicked:shell.page=index
                    }
                }
            }
            Rectangle { visible:!shell.wide;Layout.fillWidth:true;height:1;color:Theme.subtle }
            RowLayout {
                visible:(App.state.remote?.connected||[]).length>0;Layout.fillWidth:true
                CText { text:"Remote connected: "+(App.state.remote?.connected||[]).map(d=>d.name).join(", ");color:Theme.amber;font.pixelSize:12 }
                CButton { text:"Disable";danger:true;onClicked:App.rpc("remote.off",{}) }
            }
            Rectangle {
                visible:settings.paused;Layout.fillWidth:true;implicitHeight:pausedText.implicitHeight+20;radius:9;color:"#2b261e"
                CText { id:pausedText;anchors.fill:parent;anchors.margins:10;text:"AI actions, search and memory are paused.";color:Theme.amber;font.pixelSize:12 }
            }
            ScrollView {
                id:approvalsScroll;visible:shell.globalApprovals.length>0
                Layout.fillWidth:true;Layout.preferredHeight:Math.min(shell.height*.28,approvalColumn.implicitHeight)
                clip:true;contentWidth:availableWidth;contentHeight:approvalColumn.implicitHeight;rightPadding:10
                ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
                Column {
                    id:approvalColumn;width:approvalsScroll.availableWidth;spacing:8
                    Repeater { model:shell.globalApprovals;ApprovalCard { required property var modelData;width:approvalColumn.width;approval:modelData } }
                }
            }
            Item {
                id:pageViewport
                Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0;Layout.minimumHeight:120;clip:true
                StackLayout {
                    anchors.fill:parent;currentIndex:shell.page
                    transform:Translate { x:shell.pageOffset }
                    Chat { id:conversation;showBackButton:!shell.wide;onBackRequested:shell.showSessions();onCreateRequested:newSession.open() }
                    SessionList { id:sessionsPage;onSessionActivated:shell.openConversation();onCreateRequested:newSession.open() }
                    Desktop { id:desktop;onSettingsRequested:shell.page=3 }
                    Settings { }
                }
            }
            Rectangle {
                visible:App.toast.length>0;Layout.fillWidth:true;implicitHeight:toastText.implicitHeight+20
                radius:9;color:Theme.raised;border.color:Theme.line
                Text { id:toastText;anchors.fill:parent;anchors.margins:10;text:App.toast;color:Theme.text;font.family:Theme.font;font.pixelSize:12;wrapMode:Text.Wrap;maximumLineCount:5;elide:Text.ElideRight }
            }
            RowLayout {
                Layout.fillWidth:true;spacing:8
                CIcon { name:"settings";Layout.preferredWidth:16;Layout.preferredHeight:16;color:settings.paused?Theme.amber:Theme.muted }
                Text {
                    property bool bypass:settings.bypassCliPermissions||settings.bypassComputerPermissions
                    text:settings.paused?"Tools paused":bypass?[settings.bypassCliPermissions?"CLI bypass":"",settings.bypassComputerPermissions?"Computer bypass":""].filter(s=>s).join(" · "):settings.profile==="manual"?"Manual desktop controls":settings.profile==="broad"?"Broad control · project grants apply":(settings.categories||[]).length+" AI desktop categories enabled"
                    color:bypass?Theme.amber:Theme.muted;font.family:Theme.font;font.pixelSize:10
                    Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideRight
                }
                Text { text:App.connected?"Connected":"Offline";color:App.connected?Theme.success:Theme.amber;font.family:Theme.font;font.pixelSize:10 }
            }
        }
    }
    Connections { target:App;function onAttachmentRequested(path){shell.page=0} }
    NewSession { id:newSession;objectName:"createSessionDialog";onSessionOpened:shell.openConversation() }
    CDialog {
        id: welcome; closePolicy: Popup.NoAutoClose
        visible: App.connected && settings.onboarding === true
        CText { text:"Hey. I’m Cere.";color:Theme.cyan;font.pixelSize:24;font.bold:true }
        CText { text:"A little company. A place for your projects.\n\nClick me to talk, drag me somewhere comfortable, or right-click to change my size. Your sessions keep working when this panel closes." }
        CCheckBox { id:startup;text:"Keep me around after login" }
        CText { text:"Desktop AI tools start disabled. Enable the categories you want in Settings. Existing CLI permissions remain in effect.";color:Theme.muted;font.pixelSize:12 }
        CButton { text:"Make yourself at home";primary:true;Layout.fillWidth:true;onClicked:{if(startup.checked)App.setAutostart(true);App.rpc("settings.update",{onboarding:false});welcome.close()} }
    }
}
