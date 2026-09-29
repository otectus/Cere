import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: shell
    property bool expanded: false
    property int page: 0
    property real pageOffset: 0
    readonly property bool animateNavigation: !expanded && !settings.reducedMotion && !settings.quiet
    onPageChanged: { pageSlide.stop();pageOffset=0 }
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
    ColumnLayout {
        anchors.fill: parent; anchors.margins: expanded && shell.width>=900 ? 24 : 16; spacing: 12
        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            Rectangle {
                width: 44; height: 44; radius: 12; color: "#183243"; border.color: "#31566c"
                CereSprite { anchors.fill: parent; anchors.margins: 2; fillMode: Image.PreserveAspectFit }
            }
            ColumnLayout {
                spacing: 2; Layout.fillWidth: true; Layout.minimumWidth: 0
                RowLayout {
                    Text { text: "CERE"; color: Theme.text; font.pixelSize: 20; font.weight: Font.Bold; font.letterSpacing: 4; font.family: Theme.font }
                    Rectangle { width: 6; height: 6; radius: 3; color: App.connected ? Theme.cyan : Theme.amber }
                }
                Text { Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideRight;text:!App.connected?"Reconnecting…":approvals.length?approvals.length+" waiting for your input":"Your desktop companion";color:Theme.muted;font.pixelSize:11;font.family:Theme.font }
            }
            CButton { text: expanded ? "Hide" : "Expand"; onClicked: expanded ? App.closePanel() : App.expand() }
        }
        Rectangle { Layout.fillWidth: true; height: 1; color: Theme.line }
        RowLayout {
            Layout.fillWidth: true
            spacing: 6
            Repeater {
                model: ["Chat", "Sessions", "Desktop", "Settings"]
                CButton { required property string modelData; required property int index; objectName:"tab_"+modelData; Layout.fillWidth: true;Layout.preferredWidth:1;text:modelData;primary:shell.page===index;Accessible.role:Accessible.PageTab;Accessible.selected:shell.page===index;onClicked:shell.page=index }
            }
        }
        Rectangle {
            visible: settings.paused || (shell.expanded && settings.profile==="broad")
            Layout.fillWidth: true; implicitHeight: 34; radius: 6; color: "#332e22"
            Text { anchors.centerIn: parent; color: Theme.amber; font.pixelSize: 12; text: settings.paused ? "AI actions, search and memory are paused" : "Broad control · project grants apply" }
        }
        ScrollView {
            id:approvalsScroll
            visible: approvals.length>0
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(shell.height*.28, approvalColumn.implicitHeight)
            clip: true
            contentWidth:availableWidth;contentHeight:approvalColumn.implicitHeight
            rightPadding:10
            ScrollBar.horizontal.policy:ScrollBar.AlwaysOff
            ScrollBar.vertical:CScrollBar{}
            Column {
                id: approvalColumn; width: approvalsScroll.availableWidth; spacing: 8
                Repeater { model: shell.approvals; ApprovalCard { required property var modelData; width: approvalColumn.width; approval: modelData } }
            }
        }
        RowLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; spacing: 18
            SessionList {
                visible: shell.expanded && shell.width>=920 && shell.page===0
                Layout.preferredWidth:220;Layout.minimumWidth:200;Layout.maximumWidth:240;Layout.fillWidth:false;Layout.fillHeight:true
                onCreateRequested: newSession.open()
                onSessionActivated: shell.openConversation()
            }
            Item {
                id:pageViewport
                Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0;Layout.minimumHeight:120;clip:true
                StackLayout {
                    anchors.fill:parent;currentIndex:shell.page
                    transform:Translate { x:shell.pageOffset }
                    Chat { id:conversation;showBackButton:!shell.expanded;onBackRequested:shell.showSessions();onCreateRequested:newSession.open() }
                    SessionList { id:sessionsPage;onSessionActivated:shell.openConversation();onCreateRequested:newSession.open() }
                    Desktop { id:desktop;onSettingsRequested:shell.page=3 }
                    Settings { }
                }
            }
        }
        Rectangle {
            visible: App.toast.length>0
            Layout.fillWidth: true; implicitHeight: toastText.implicitHeight + 18
            radius: 7; color: Theme.raised; border.color: Theme.line
            Text { id: toastText; anchors.fill: parent; anchors.margins: 9; text: App.toast; color: Theme.text; font.pixelSize: 12; wrapMode: Text.Wrap; maximumLineCount: 5; elide: Text.ElideRight }
        }
        RowLayout {
            Layout.fillWidth:true
            spacing: 6
            Text { text: "✦"; color: Theme.cyan; font.pixelSize: 12 }
            Text {
                property bool bypass:settings.bypassCliPermissions||settings.bypassComputerPermissions
                text:settings.paused?"Cere tools paused":bypass?[settings.bypassCliPermissions?"CLI bypass":"",settings.bypassComputerPermissions?"Computer bypass":""].filter(s=>s).join(" · "):settings.profile==="manual"?"Manual desktop controls":(settings.categories||[]).length+" AI desktop categories enabled"
                color:bypass?Theme.amber:Theme.muted;font.pixelSize:10;Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideRight
            }
            Text { text:App.connected?"Connected":"Offline";color:App.connected?Theme.cyan:Theme.amber;font.pixelSize:10 }
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
