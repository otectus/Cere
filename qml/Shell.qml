import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: shell
    property bool expanded: false
    property int page: 0
    readonly property var tabs: [
        {key:"Chat", label:qsTr("Chat"), icon:"chat", page:0},
        {key:"Sessions", label:qsTr("Sessions"), icon:"sessions", page:1},
        {key:"Projects", label:qsTr("Projects"), icon:"projects", page:4},
        {key:"Desktop", label:qsTr("Desktop"), icon:"desktop", page:2},
        {key:"Settings", label:qsTr("Settings"), icon:"settings", page:3}
    ]
    property real pageOffset: 0
    // Reduced motion, quiet mode and zero intensity keep page changes instant (Theme.duration is then 0).
    readonly property bool animateNavigation: !expanded && Theme.duration(180) > 0
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
        if(target===0)Qt.callLater(()=>conversation.focusComposer())
        else if(target===1)Qt.callLater(()=>sessionsPage.focusSearch())
        else if(target===2)Qt.callLater(()=>desktop.focusSearch())
        else if(target===3)Qt.callLater(()=>settingsPage.focusSearch())
        else if(target===4)Qt.callLater(()=>projectsPage.focusSearch())
    }
    function openFolder(id) { page=1;Qt.callLater(()=>sessionsPage.selectFolder(id)) }
    NumberAnimation { id:pageSlide;target:shell;property:"pageOffset";to:0;duration:Theme.duration(180);easing.type:Easing.OutCubic }
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
    Keys.onEscapePressed: { if(WorkbenchState.open&&page===0)WorkbenchState.hide();else if(page!==0)page=0;else App.closePanel() }
    Shortcut { sequence: "Ctrl+K"; onActivated: commandPalette.openPalette() }
    Shortcut { sequence: "Ctrl+N"; onActivated: shell.page===4?projectsPage.newProjectSession():newSession.open() }
    Shortcut { sequence: "Ctrl+,"; onActivated: shell.navigate(3) }
    readonly property bool wide: expanded && width >= 920
    readonly property bool splitWorkbench: wide && WorkbenchState.open && page === 0
    // At intermediate widths keep both working panes usable by reducing the navigation to icons.
    readonly property bool autoRail: splitWorkbench && width < 1280
    readonly property bool rail: wide && (WorkbenchState.layout.collapsed || autoRail)
    readonly property int sidebarWidth: rail ? 72 : width >= 1400 ? 280 : 248
    readonly property real maxPaneWidth: Math.max(360, Math.min(width * 0.55, width - sidebarWidth - 416))
    readonly property string statusText: App.brokerUnresponsive ? "Cere is not responding…" : !App.connected ? "Reconnecting…" : approvals.length ? approvals.length+" waiting for input" : busySessions ? busySessions+(busySessions===1?" conversation working":" conversations working") : "Ready"
    readonly property bool bypassActive: settings.bypassCliPermissions||settings.bypassComputerPermissions
    readonly property string permissionText: settings.paused?"Tools paused":bypassActive?[settings.bypassCliPermissions?"CLI bypass":"",settings.bypassComputerPermissions?"Computer bypass":""].filter(s=>s).join(" · "):settings.profile==="manual"?"Manual desktop controls":settings.profile==="broad"?"Broad control · project grants apply":(settings.categories||[]).length+" AI desktop categories enabled"
    // Paused tools and permission bypasses stay visible in the one-row compact header.
    readonly property string compactStatus: statusText+(settings.paused||bypassActive?" · "+permissionText:"")
    // The conversation's own error banner already says what failed there.
    readonly property bool toastVisible: App.toast.length>0&&!(page===0&&App.toast===(App.session.error||""))
    component HeaderPortrait: CerePortrait {
        avatar: App.avatar
        Layout.preferredWidth: shell.wide && !shell.rail ? 52 : 44
        Layout.preferredHeight: Layout.preferredWidth
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
            Layout.preferredWidth: shell.sidebarWidth
            Layout.fillHeight: true
            color: Theme.sidebar
            Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.line }
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: shell.rail ? 10 : Theme.space3
                spacing: Theme.space2
                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: Theme.space2
                    Layout.bottomMargin: Theme.space2
                    spacing: Theme.space3
                    HeaderPortrait { Layout.alignment: Qt.AlignHCenter }
                    ColumnLayout {
                        visible: !shell.rail
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: 2
                        Text {
                            Layout.fillWidth: true; Layout.minimumWidth: 0
                            text: App.assistantName; textFormat: Text.PlainText; elide: Text.ElideRight
                            color: Theme.text; font.family: Theme.font; font.pixelSize: Theme.wordmark; font.weight: Font.DemiBold
                        }
                        CText { text: shell.statusText; color: App.connected && !shell.approvals.length ? Theme.muted : Theme.amber; font.pixelSize: Theme.caption }
                    }
                }
                CButton {
                    objectName: "sidebarNewSession"; Layout.fillWidth: true
                    text: shell.rail ? "" : qsTr("New session"); iconName: "plus"; prominent: !!App.session.id || shell.page !== 0; primary: true
                    help: qsTr("Start a session (Ctrl+N)"); Accessible.name: qsTr("New session")
                    onClicked: newSession.open()
                }
                CButton {
                    objectName: "sidebarCommandPalette"; Layout.fillWidth: true
                    text: shell.rail ? "" : qsTr("Search Cere"); iconName: "search"
                    alignLeft: !shell.rail; quiet: true; implicitHeight: 34
                    Accessible.name: qsTr("Search Cere"); help: qsTr("Search Cere (Ctrl+K)")
                    rightPadding: shell.rail ? Theme.space3 : 62
                    Text {
                        visible: !shell.rail; anchors.right: parent.right; anchors.rightMargin: Theme.space3; anchors.verticalCenter: parent.verticalCenter
                        text: "Ctrl K"; color: Theme.muted; font.family: Theme.font; font.pixelSize: Theme.caption; Accessible.ignored: true
                    }
                    onClicked: commandPalette.openPalette()
                }
                Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: Theme.subtle }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Repeater {
                        model: shell.tabs
                        CButton {
                            required property var modelData
                            required property int index
                            objectName: "tab_" + modelData.key
                            Layout.fillWidth: true
                            implicitHeight: 34
                            text: shell.rail ? "" : modelData.label
                            iconName: modelData.icon
                            alignLeft: !shell.rail; quiet: true; primary: shell.page === modelData.page
                            help: shell.rail ? modelData.label : ""
                            Accessible.name: modelData.label; Accessible.role: Accessible.PageTab; Accessible.onPressAction: if (enabled) click(); Accessible.selected: primary
                            Rectangle {
                                visible: parent.primary; width: 3; height: 16; radius: 2
                                anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter; color: Theme.accentText
                            }
                            onClicked: shell.navigate(modelData.page)
                        }
                    }
                    CButton {
                        objectName: "sidebarWorkflows"; Layout.fillWidth: true; implicitHeight: 34
                        text: shell.rail ? "" : qsTr("Project workflows"); iconName: "workflow"
                        quiet: true; alignLeft: !shell.rail; help: "Project workflows"
                        onClicked: workflows.open()
                    }
                }
                Rectangle { visible: !shell.rail && shell.page !== 1; Layout.fillWidth: true; implicitHeight: 1; color: Theme.subtle }
                SessionList {
                    visible: !shell.rail && shell.page !== 1
                    Layout.fillWidth: true; Layout.fillHeight: true
                    compact: true
                    onCreateRequested: newSession.open()
                    onSessionActivated: shell.openConversation()
                }
                Item { visible: shell.rail || shell.page === 1; Layout.fillHeight: true }
                Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: Theme.subtle }
                RowLayout {
                    Layout.fillWidth: true
                    CButton {
                        objectName: "sidebarToggle"; Layout.fillWidth: true; implicitHeight: 32
                        visible: !shell.autoRail
                        text: shell.rail ? "" : "Collapse sidebar"; iconName: "sidebar"; quiet: true; alignLeft: !shell.rail
                        help: shell.rail ? "Expand sidebar" : "Collapse sidebar"; Accessible.name: help
                        onClicked: WorkbenchState.layout.collapsed = !WorkbenchState.layout.collapsed
                    }
                    CButton {
                        visible: !shell.rail; iconName: "hide"; implicitHeight: 32
                        quiet: true; help: "Hide window"; onClicked: App.closePanel()
                    }
                }
            }
        }
        ColumnLayout {
            Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0
            Layout.margins:shell.wide ? (shell.splitWorkbench ? 12 : 20) : 12
            spacing:shell.wide ? 12 : 6
            RowLayout {
                visible:!shell.wide
                Layout.fillWidth:true;spacing:10
                HeaderPortrait {}
                ColumnLayout {
                    Layout.fillWidth:true;Layout.minimumWidth:0;spacing:2
                    Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:App.assistantName;textFormat:Text.PlainText;elide:Text.ElideRight;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.wordmark;font.weight:Font.DemiBold }
                    CText { objectName:"compactStatus";Layout.fillWidth:true;text:shell.compactStatus;color:!App.connected||settings.paused||shell.bypassActive?Theme.amber:Theme.muted;font.pixelSize:Theme.caption;maximumLineCount:1;elide:Text.ElideRight;Accessible.name:text }
                }
                CButton {
                    objectName:"openCommandPalette";implicitWidth:40;implicitHeight:40;leftPadding:10;rightPadding:10
                    quiet:true;help:"Search Cere (Ctrl+K)";Accessible.name:"Search Cere"
                    contentItem:CIcon { name:"search";color:Theme.text }
                    onClicked:commandPalette.openPalette()
                }
                CButton {
                    objectName:"shellPermissionCenter";implicitWidth:40;implicitHeight:40;leftPadding:10;rightPadding:10
                    quiet:true;help:"Permissions · "+shell.permissionText;Accessible.name:"Permissions"
                    contentItem:CIcon { name:"shield";color:settings.paused||shell.bypassActive?Theme.amber:Theme.text }
                    onClicked:permissionCenter.open()
                }
                CButton { objectName:"expandWindow";text:"";iconName:expanded?"hide":"expand";quiet:true;help:expanded?"Hide window":"Expand workspace";onClicked:expanded?App.closePanel():App.expand() }
            }
            RowLayout {
                visible:!shell.wide;Layout.fillWidth:true;spacing:4
                Repeater {
                    model:shell.tabs
                    CButton {
                        required property var modelData;required property int index
                        id: compactTab
                        objectName:"tab_"+modelData.key;Layout.fillWidth:true;Layout.preferredWidth:1
                        text:"";help:modelData.label;quiet:true;primary:shell.page===modelData.page
                        leftPadding:6;rightPadding:6
                        Accessible.name:modelData.label;Accessible.role:Accessible.PageTab; Accessible.onPressAction: if (enabled) click();Accessible.selected:shell.page===modelData.page
                        implicitHeight: shell.height < 570 || shell.width < 350 ? 32 : 46
                        contentItem: Column {
                            spacing: 1
                            CIcon { visible:shell.height >= 570 || shell.width < 350; anchors.horizontalCenter:parent.horizontalCenter; width:18;height:18;name:compactTab.modelData.icon;color:compactTab.primary?Theme.accentText:Theme.muted }
                            Text { visible:shell.width >= 350;width:parent.width;height:implicitHeight;text:compactTab.modelData.label;elide:Text.ElideRight;horizontalAlignment:Text.AlignHCenter;verticalAlignment:Text.AlignVCenter;font.family:Theme.font;font.pixelSize:Theme.caption;font.weight:compactTab.primary?Font.DemiBold:Font.Normal;color:compactTab.primary?Theme.accentText:Theme.text }
                        }
                        onClicked:shell.navigate(modelData.page)
                    }
                }
            }
            Rectangle { visible:!shell.wide;Layout.fillWidth:true;height:1;color:Theme.subtle }
            RowLayout {
                visible:(App.state.remote?.connected||[]).length>0;Layout.fillWidth:true
                CText { text:"Remote connected: "+(App.state.remote?.connected||[]).map(d=>d.name).join(", ");color:Theme.amber;font.pixelSize:Theme.secondary }
                CButton { text:"Disable";danger:true;onClicked:App.rpc("remote.off",{}) }
            }
            Rectangle {
                visible:settings.paused;Layout.fillWidth:true;implicitHeight:pausedText.implicitHeight+20;radius:Theme.radiusControl;color:Theme.warningSurface;border.color:Theme.warningBorder
                CText { id:pausedText;anchors.fill:parent;anchors.margins:10;text:"AI actions, search and memory are paused.";color:Theme.amber;font.pixelSize:Theme.secondary }
            }
            RowLayout {
                visible:!!App.state.recoveryWarning;Layout.fillWidth:true
                CText { Layout.fillWidth:true;text:App.state.recoveryWarning||"";color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
                CButton { text:"Dismiss";onClicked:App.rpc("recovery.dismissWarning",{}) }
            }
            Rectangle {
                visible:!shell.wide&&shell.powerText.length>0;Layout.fillWidth:true;implicitHeight:powerStatusRow.implicitHeight+20
                radius:Theme.radiusControl;color:shell.unconfirmedPower?Theme.dangerSurface:Theme.warningSurface;border.color:shell.unconfirmedPower?Theme.dangerBorder:Theme.warningBorder
                RowLayout {
                    id:powerStatusRow;x:10;y:10;width:parent.width-20;spacing:8
                    CText { text:shell.powerText;color:shell.unconfirmedPower?Theme.danger:Theme.amber;font.pixelSize:Theme.secondary;font.weight:Font.DemiBold }
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
                    // Under the compact Workbench sheet the conversation is hidden, not just covered, so
                    // Tab and screen readers cannot reach a composer the person cannot see.
                    anchors.fill:parent;currentIndex:shell.page;visible:!workbenchSheet.visible
                    transform:Translate { x:shell.pageOffset }
                    Chat { id:conversation;showBackButton:!shell.wide;onBackRequested:shell.showSessions();onCreateRequested:newSession.open()
                        onNavigateRequested:target=>{if(target==="connections"){shell.navigate(3);settingsPage.open("connections","")}else if(target==="settings")shell.navigate(3);else if(target==="sessions")shell.showSessions();else if(target==="desktop")shell.navigate(2);else if(target==="new")newSession.open();else shell.navigate(0)} }
                    SessionList { id:sessionsPage;onSessionActivated:shell.openConversation();onCreateRequested:newSession.open() }
                    Desktop { id:desktop;onSettingsRequested:category=>{shell.navigate(3);settingsPage.open(category,"")} }
                    Settings { id:settingsPage }
                    Projects { id:projectsPage;onSessionActivated:shell.openConversation();onProjectRequested:(cwd,archived)=>{shell.page=1;sessionsPage.selectProject(cwd,archived)} }
                }
                // Notices float over the page instead of pushing it down. They take no input, so the
                // controls beneath stay usable, and fade while the pointer is over them.
                Rectangle {
                    objectName:"toast";visible:shell.toastVisible;z:10;opacity:toastHover.hovered?0.2:1
                    anchors.top:parent.top;anchors.left:parent.left;anchors.right:parent.right;anchors.margins:8
                    implicitHeight:toastText.implicitHeight+20
                    radius:Theme.radiusControl;color:Theme.raised;border.color:Theme.borderStrong
                    Accessible.role:Accessible.AlertMessage;Accessible.name:App.toast
                    Text { id:toastText;anchors.fill:parent;anchors.margins:10;text:App.toast;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;maximumLineCount:5;elide:Text.ElideRight }
                    HoverHandler { id:toastHover }
                }
                // The compact panel shows the Workbench as one focused sheet over the conversation.
                Item { id:workbenchSheet;objectName:"workbenchSheet";anchors.fill:parent;z:5;visible:!shell.wide&&WorkbenchState.open&&shell.page===0;onVisibleChanged:if(visible)Qt.callLater(()=>workbench.forceActiveFocus()) }
            }
            RowLayout {
                visible:shell.wide;Layout.fillWidth:true;spacing:8
                CIcon { name:"settings";Layout.preferredWidth:16;Layout.preferredHeight:16;color:settings.paused?Theme.amber:Theme.muted }
                Text {
                    text:shell.permissionText
                    color:shell.bypassActive?Theme.amber:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption
                    Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideRight
                }
                // A04: downloads, indexing and file transcription, listed together while any is running.
                CButton {
                    id:backgroundWork;objectName:"backgroundWork";visible:(App.state.jobs||[]).length>0;quiet:true;implicitHeight:30;font.pixelSize:Theme.caption
                    text:(App.state.jobs||[]).length===1?"1 background task":(App.state.jobs||[]).length+" background tasks"
                    onClicked:jobsPopup.open()
                    Popup {
                        id:jobsPopup;objectName:"backgroundWorkList";y:-height-6;x:Math.min(0,parent.width-width);width:340;padding:12
                        background:Rectangle { color:Theme.surface;radius:Theme.radiusControl;border.color:Theme.borderStrong }
                        contentItem:ColumnLayout {
                            spacing:8
                            Repeater {
                                model:App.state.jobs||[]
                                RowLayout {
                                    required property var modelData
                                    required property int index
                                    Layout.fillWidth:true
                                    CText { objectName:"backgroundJob_"+index;Layout.fillWidth:true;elide:Text.ElideRight;font.pixelSize:Theme.secondary
                                        text:modelData.label+(modelData.progress?" · "+Math.round(100*modelData.progress.done/Math.max(1,modelData.progress.total))+"%":"") }
                                    CButton { objectName:"backgroundJobCancel_"+index;text:"Cancel";danger:true;implicitHeight:28;onClicked:App.rpc("jobs.cancel",{id:modelData.id}) }
                                }
                            }
                            CText { visible:!(App.state.jobs||[]).length;text:"Nothing is running in the background.";color:Theme.muted;font.pixelSize:Theme.secondary }
                        }
                    }
                }
                Text { text:App.connected?"Connected":App.brokerUnresponsive?"Not responding":"Offline";color:App.connected?Theme.success:Theme.amber;font.family:Theme.font;font.pixelSize:Theme.caption }
                CButton { objectName:"shellPermissionCenter";visible:shell.wide;text:"Permissions";quiet:true;implicitHeight:30;onClicked:permissionCenter.open() }
            }
        }
        // The expanded workspace shows the Workbench beside the conversation, resizable from its edge.
        Item {
            id:workbenchSide;objectName:"workbenchSide"
            visible:shell.splitWorkbench
            Layout.preferredWidth:Math.max(360,Math.min(shell.maxPaneWidth,WorkbenchState.paneWidth));Layout.fillHeight:true
            Rectangle { anchors.left:parent.left;width:1;height:parent.height;color:Theme.subtle }
            MouseArea {
                id: splitter
                objectName:"workbenchResize";anchors.left:parent.left;width:8;height:parent.height;cursorShape:Qt.SplitHCursor;z:2
                activeFocusOnTab: true
                hoverEnabled: true
                Accessible.role: Accessible.Grip
                Accessible.name: "Resize Workbench"
                Accessible.description: "Left widens the Workbench. Right narrows it."
                Keys.onLeftPressed: WorkbenchState.paneWidth = Math.min(shell.maxPaneWidth, workbenchSide.width + 24)
                Keys.onRightPressed: WorkbenchState.paneWidth = Math.max(360, workbenchSide.width - 24)
                Rectangle {
                    anchors.centerIn: parent; width: splitter.activeFocus || splitter.containsMouse ? 4 : 2; height: 48
                    color: splitter.activeFocus ? Theme.focus : Theme.scrollThumb; radius: 2
                }
                property real startX:0;property real startWidth:0
                onPressed:mouse=>{startX=mapToItem(shell,mouse.x,0).x;startWidth=workbenchSide.width}
                onPositionChanged:mouse=>{if(pressed)WorkbenchState.paneWidth=Math.max(360,Math.min(shell.maxPaneWidth,startWidth-(mapToItem(shell,mouse.x,0).x-startX)))}
            }
        }
    }
    // One Workbench per window, moved between the side pane and the compact sheet so its panes, scroll
    // positions and drafts survive a resize.
    Workbench {
        id:workbench
        parent:shell.wide?workbenchSide:workbenchSheet
        anchors.fill:parent;anchors.leftMargin:shell.wide?8:0
        compact:!shell.wide
        onCloseRequested:{WorkbenchState.hide();Qt.callLater(()=>conversation.focusComposer())}
    }
    Connections { target:WorkbenchState;function onRequested(){if(shell.page!==0)shell.page=0} }
    Connections { target:App;function onAttachmentRequested(path){shell.page=0} }
    // M16: while responsiveness is measured, the window samples how late its own timer fires and sends an
    // aggregate every thirty seconds. When off, the timer is stopped.
    property var lagSamples:[]
    property real lagExpected:0
    Timer {
        id:lagTimer;interval:250;repeat:true;running:App.connected&&App.state.settings?.responsiveness===true
        onRunningChanged:{shell.lagSamples=[];shell.lagExpected=0}
        onTriggered:{
            const now=Date.now();if(shell.lagExpected)shell.lagSamples.push(Math.max(0,now-shell.lagExpected));shell.lagExpected=now+interval
            if(shell.lagSamples.length>=120){const sorted=shell.lagSamples.slice().sort((a,b)=>a-b);App.rpc("diagnostics.uiLag",{p50:sorted[Math.floor(sorted.length*.5)],p90:sorted[Math.floor(sorted.length*.9)],max:sorted[sorted.length-1],samples:sorted.length});shell.lagSamples=[]}
        }
    }
    // The compact panel is for a quick ask: opening it puts the keyboard in the composer.
    Connections {
        target:shell.Window.window
        function onVisibleChanged(){if(shell.Window.window&&shell.Window.window.visible&&!shell.expanded&&shell.page===0)Qt.callLater(()=>conversation.focusComposer())}
    }
    Connections { target:App;function onNewConversationRequested(folder){if(shell.expanded)newSession.openFolder(folder)} }
    NewSession { id:newSession;objectName:"createSessionDialog";onSessionOpened:shell.openConversation();onClosed:imported=({}) }
    PermissionCenter { id:permissionCenter }
    Workflows { id:workflows;onSessionRequested:id=>{App.selectedId=id;shell.openConversation()} }
    CommandPalette {
        id:commandPalette
        onSessionRequested:id=>{App.selectedId=id;App.rpc("session.read",{id:id});shell.openConversation()}
        onFolderRequested:id=>shell.openFolder(id)
        onSettingsRequested:(category,target)=>{shell.page=3;Qt.callLater(()=>settingsPage.open(category,target))}
        onPageRequested:target=>shell.navigate(target)
        onDesktopRequested:query=>{shell.page=2;Qt.callLater(()=>desktop.showSearch(query))}
        onWorkflowsRequested:workflows.openRecipes()
    }
    Shortcut { sequence:"Ctrl+Shift+W";onActivated:WorkbenchState.open?WorkbenchState.hide():WorkbenchState.show("") }
    CDialog {
        id: welcome; objectName: "welcomeDialog"; closePolicy: Popup.NoAutoClose
        accessibleTitle: qsTr("Meet %1").arg(App.assistantName)
        onOpened: startup.forceActiveFocus(Qt.TabFocusReason)
        visible: App.connected && settings.onboarding === true
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space3
            HeaderPortrait { enabled: false }
            CText { text: welcome.accessibleTitle; font.pixelSize: Theme.page; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
        }
        CText { text:qsTr("Click your companion to open chat. Drag to move them, or right-click for appearance and visibility. Conversations keep working when you close the panel.") }
        CCheckBox { id:startup;objectName:"welcomeAutostart";text:qsTr("Start Cere when I log in") }
        CText { text:"Desktop AI tools start disabled. Enable the categories you want in Settings. Existing CLI permissions remain in effect.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CButton { objectName:"welcomeDone";text:qsTr("Get started");prominent:true;Layout.fillWidth:true;onClicked:{if(startup.checked&&!App.setAutostart(true))return;App.rpc("settings.update",{onboarding:false});welcome.close()} }
    }
}
