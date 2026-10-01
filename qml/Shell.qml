import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: shell
    property bool expanded: false
    property int page: 0
    readonly property var tabs:[{label:"Chat",icon:"chat",page:0},{label:"Sessions",icon:"sessions",page:1},{label:"Projects",icon:"projects",page:4},{label:"Desktop",icon:"desktop",page:2},{label:"Settings",icon:"settings",page:3}]
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
    function navigate(target) {
        page=target
        App.rpc("navigation.record",{id:["page:chat","page:sessions","page:desktop","page:settings","page:projects"][target]})
        if(target===1)Qt.callLater(()=>sessionsPage.focusSearch())
        else if(target===2)Qt.callLater(()=>desktop.focusSearch())
        else if(target===3)Qt.callLater(()=>settingsPage.focusSearch())
        else if(target===4)Qt.callLater(()=>projectsPage.focusSearch())
    }
    function openFolder(id) { page=1;Qt.callLater(()=>sessionsPage.selectFolder(id)) }
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
    readonly property var power: App.state.power || []
    readonly property int activePower: power.filter(lease=>lease.state==="active").length
    readonly property int endingPower: power.filter(lease=>lease.state==="ending").length
    readonly property int unconfirmedPower: power.filter(lease=>lease.state==="unconfirmed").length
    readonly property string powerText: unconfirmedPower ? unconfirmedPower+" power session"+(unconfirmedPower===1?" needs":"s need")+" attention" : endingPower ? endingPower+" power session"+(endingPower===1?" is":"s are")+" ending" : activePower ? activePower+" power session"+(activePower===1?" is":"s are")+" active" : ""
    color: Theme.background
    radius: expanded ? 0 : 14
    border.color: Theme.line
    border.width: expanded ? 0 : 1
    implicitWidth: expanded ? 1040 : 440; implicitHeight: expanded ? 780 : 860
    focus: true
    Keys.onEscapePressed: { if(page!==0)page=0;else App.closePanel() }
    Shortcut { sequence: "Ctrl+K"; onActivated: commandPalette.openPalette() }
    Shortcut { sequence: "Ctrl+N"; onActivated: shell.page===4?projectsPage.newProjectSession():newSession.open() }
    Shortcut { sequence: "Ctrl+,"; onActivated: shell.navigate(3) }
    readonly property bool wide: expanded && width >= 920
    readonly property string statusText: !App.connected ? "Reconnecting…" : approvals.length ? approvals.length+" waiting for input" : busySessions ? busySessions+" conversations working" : "Ready when you are"
    component HeaderPortrait: CerePortrait {
        Layout.preferredWidth: 64
        Layout.preferredHeight: 64
        settings: shell.settings
        session: App.session
        messages: App.messages
        moodSource: ConversationMood.forSession(App.selectedId)
        approvals: shell.approvals
        speech: App.state.speech || ({})
        connected: App.connected
        listening: conversation.listening
        assetRoot: App.assetPath
        enabled:App.connected
        speechMuted:shell.settings.speechEnabled===false
        onActivated:App.rpc("settings.update",{speechEnabled:speechMuted})
    }
    RowLayout {
        enabled:!App.state.recoveryPending
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
                        model:shell.tabs
                        CButton {
                            required property var modelData;required property int index
                            objectName:"tab_"+modelData.label
                            Layout.fillWidth:true;implicitHeight:42
                            text:modelData.label;iconName:modelData.icon;alignLeft:true;quiet:true;primary:shell.page===modelData.page
                            Accessible.role:Accessible.PageTab;Accessible.selected:shell.page===modelData.page
                            onClicked:shell.navigate(modelData.page)
                        }
                    }
                }
                CButton { objectName:"sidebarNewSession";Layout.fillWidth:true;text:"New session";iconName:"plus";primary:true;help:"Start a session (Ctrl+N)";onClicked:newSession.open() }
                CButton { objectName:"sidebarCommandPalette";Layout.fillWidth:true;text:"Search Cere";iconName:"search";quiet:true;alignLeft:true;help:"Command palette (Ctrl+K)";onClicked:commandPalette.openPalette() }
                CButton { objectName:"sidebarWorkflows";Layout.fillWidth:true;text:"Project workflows";quiet:true;alignLeft:true;onClicked:workflows.open() }
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
                CButton {
                    objectName:"openCommandPalette";implicitWidth:40;implicitHeight:40;leftPadding:10;rightPadding:10
                    quiet:true;help:"Search Cere (Ctrl+K)";Accessible.name:"Search Cere"
                    contentItem:CIcon { name:"search";color:Theme.text }
                    onClicked:commandPalette.openPalette()
                }
                CButton { objectName:"expandWindow";text:expanded?"Hide":"Expand";iconName:expanded?"hide":"expand";quiet:true;onClicked:expanded?App.closePanel():App.expand() }
            }
            RowLayout {
                visible:!shell.wide;Layout.fillWidth:true;spacing:4
                Repeater {
                    model:shell.tabs
                    CButton {
                        required property var modelData;required property int index
                        objectName:"tab_"+modelData.label;Layout.fillWidth:true;Layout.preferredWidth:1
                        text:"";help:modelData.label;quiet:true;primary:shell.page===modelData.page
                        leftPadding:6;rightPadding:6
                        Accessible.name:modelData.label;Accessible.role:Accessible.PageTab;Accessible.selected:shell.page===modelData.page
                        contentItem:CIcon { name:parent.modelData.icon;color:parent.primary?Theme.cyan:Theme.text }
                        onClicked:shell.navigate(modelData.page)
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
            RowLayout {
                visible:!!App.state.recoveryWarning;Layout.fillWidth:true
                CText { Layout.fillWidth:true;text:App.state.recoveryWarning||"";color:Theme.amber;font.pixelSize:11;wrapMode:Text.Wrap }
                CButton { text:"Dismiss";onClicked:App.rpc("recovery.dismissWarning",{}) }
            }
            Rectangle {
                visible:!shell.wide&&shell.powerText.length>0;Layout.fillWidth:true;implicitHeight:powerStatusRow.implicitHeight+20
                radius:9;color:shell.unconfirmedPower?"#33232e":"#2b261e";border.color:shell.unconfirmedPower?"#704452":"#6b5836"
                RowLayout {
                    id:powerStatusRow;x:10;y:10;width:parent.width-20;spacing:8
                    CText { text:shell.powerText;color:shell.unconfirmedPower?Theme.danger:Theme.amber;font.pixelSize:12;font.weight:Font.DemiBold }
                    CButton { text:"Review";quiet:true;implicitHeight:30;onClicked:permissionCenter.open() }
                }
            }
            ScrollView {
                id:approvalsScroll;objectName:"globalApprovals";visible:shell.globalApprovals.length>0
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
                    Desktop { id:desktop;onSettingsRequested:shell.navigate(3) }
                    Settings { id:settingsPage }
                    Projects { id:projectsPage;onSessionActivated:shell.openConversation();onProjectRequested:(cwd,archived)=>{shell.page=1;sessionsPage.selectProject(cwd,archived)} }
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
                CButton { objectName:"shellPermissionCenter";text:"Permissions";quiet:true;implicitHeight:30;onClicked:permissionCenter.open() }
            }
        }
    }
    Connections { target:App;function onAttachmentRequested(path){shell.page=0} }
    NewSession { id:newSession;objectName:"createSessionDialog";onSessionOpened:shell.openConversation() }
    PermissionCenter { id:permissionCenter }
    Workflows { id:workflows;onSessionRequested:id=>{App.selectedId=id;shell.openConversation()} }
    CommandPalette {
        id:commandPalette
        onSessionRequested:id=>{App.selectedId=id;App.rpc("session.read",{id:id});shell.openConversation()}
        onFolderRequested:id=>shell.openFolder(id)
        onSettingsRequested:section=>{
            shell.page=3
            Qt.callLater(()=>{
                const destination=settingsPage.navigationEntries.find(entry=>entry.label===section)
                if(destination)settingsPage.jumpTo(destination.target);else settingsPage.focusSearch()
            })
        }
        onPageRequested:target=>shell.navigate(target)
        onDesktopRequested:query=>{shell.page=2;Qt.callLater(()=>desktop.focusSearch())}
    }
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
