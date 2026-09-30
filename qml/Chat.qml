import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Shapes
Item {
    id: chat
    signal createRequested()
    signal backRequested()
    property bool showBackButton: false
    function focusComposer() { if(composer.enabled)composer.forceActiveFocus() }
    readonly property var agents: App.session.agents || []
    readonly property var activeAgents: agents.filter(agent => ["starting", "running", "waiting"].indexOf(agent.status) >= 0)
    property var pendingApprovals: []
    readonly property var pendingQuestions: pendingApprovals.filter(approval => approval.kind === "question" || (approval.questions || []).length > 0)
    function syncApprovals() {
        const next = (App.state.approvals || []).filter(approval => approval.sessionId === App.selectedId)
        // Preserve focused editors during unrelated provider progress snapshots.
        if (JSON.stringify(next) !== JSON.stringify(pendingApprovals)) pendingApprovals = next
    }
    Component.onCompleted: syncApprovals()
    property bool busy: ["starting","working","waiting","stopping"].indexOf(App.session.status)>=0 || activeAgents.length>0 || pendingApprovals.length>0
    property bool linked: App.session.mode==="linked"
    property bool listening: visible && composer.activeFocus && composer.enabled && !busy
    onListeningChanged: App.setListening(listening)
    property string sessionId: App.selectedId
    property var attachments: []
    property bool follow: true
    property string handoff: ""
    property int sendRequest:-1
    property string pendingText:""
    property string pendingSession:""
    property string draftSession:""
    property string draftRevision:"0"
    property string draftBaseline:""
    property bool loadingDraft:false
    property bool draftConflict:false
    property var draftRequests:({})
    function activityStatus() {
        if (App.session.status === "stopping") return "Stopping…"
        if (pendingQuestions.length) return pendingQuestions.length === 1 ? "Waiting for your answer…" : "Waiting for your answers…"
        if (pendingApprovals.length) return "Waiting for permission…"
        if (activeAgents.length) {
            const waiting = activeAgents.filter(agent => agent.status === "waiting").length
            return activeAgents.length + (activeAgents.length === 1 ? " subagent active" : " subagents active") + (waiting ? " · " + waiting + " waiting…" : "…")
        }
        switch (App.session.activity) {
        case "thinking": return "Thinking…"
        case "speaking": return "Writing a response…"
        case "working": return "Using tools…"
        case "delegating": return "Delegating work…"
        case "waitingForAgents": return "Waiting for subagents…"
        case "compacting": return "Compacting context…"
        case "planning": return "Planning…"
        default: return App.session.status === "waiting" ? "Waiting for your input…" : "Working on it…"
        }
    }
    function loadDraft(){loadingDraft=true;draftRevision=App.session.draftRevision||"0";draftBaseline=App.session.draft||"";composer.text=draftBaseline;draftConflict=false;loadingDraft=false;draftTimer.stop()}
    function saveDraft(){
        if(!draftSession||!App.connected||draftConflict||composer.text===draftBaseline)return
        const id=App.rpc("session.draft",{id:draftSession,text:composer.text,scroll:scroll.contentY,expectedRevision:draftRevision})
        const pending=Object.assign({},draftRequests);pending[id]={session:draftSession,text:composer.text};draftRequests=pending
    }
    onSessionIdChanged: { if(draftSession&&draftTimer.running)saveDraft();draftTimer.stop();draftSession=sessionId;loadDraft();attachments=[];activityPanel.expanded=false;chat.follow=true;Qt.callLater(()=>{scroll.contentY=App.session.scroll||0}) }
    Component.onDestruction: { App.setListening(false);saveDraft() }
    ColumnLayout {
        anchors.horizontalCenter:parent.horizontalCenter
        width:Math.min(parent.width,1040);height:parent.height;spacing:12
        RowLayout {
            Layout.fillWidth:true;spacing:8
            CButton { objectName:"backToSessions";visible:chat.showBackButton;text:"";iconName:"back";quiet:true;help:"Back to sessions";Accessible.name:"Back to sessions";onClicked:chat.backRequested() }
            Text {
                text:App.session.title||"A little help. A little company."
                Layout.fillWidth:true;Layout.minimumWidth:0;color:Theme.text;font.family:Theme.font;font.weight:Font.DemiBold
                font.pixelSize:chat.width>=600?22:16;elide:Text.ElideRight;textFormat:Text.PlainText
            }
            CButton { objectName:"renameSession";visible:!!App.session.id;text:"";iconName:"edit";quiet:true;help:"Rename session";Accessible.name:"Rename session";onClicked:renameDialog.open() }
        }
        RowLayout {
            visible:!!App.session.id;Layout.fillWidth:true;spacing:8
            CText {
                text:App.session.provider?App.session.provider.charAt(0).toUpperCase()+App.session.provider.slice(1)+(App.session.model?" · "+App.session.model:"")+"  /  "+App.session.cwd:""
                color:Theme.muted;font.pixelSize:11;maximumLineCount:1;elide:Text.ElideMiddle
            }
            CButton { objectName:"ollamaModelOptions";visible:App.session.provider==="ollama";text:"Model";quiet:true;implicitHeight:30;enabled:!chat.busy&&App.connected;onClicked:ollamaOptions.open() }
            CButton { objectName:"chatHandoff";text:"Handoff";quiet:true;implicitHeight:30;help:"Continue with another provider";onClicked:handoffDialog.open() }
            CButton { visible:chat.linked;text:"Terminal";implicitHeight:30;onClicked:App.rpc("session.terminal",{id:App.selectedId}) }
        }
        Rectangle { Layout.fillWidth:true;height:1;color:Theme.subtle }
    Rectangle {
        visible: !!App.session.error; Layout.fillWidth: true; implicitHeight: errorText.implicitHeight+18; radius: 7; color: "#382630"
        Text { id:errorText; anchors.fill:parent;anchors.margins:9;text:App.session.error || "";color:Theme.danger;wrapMode:Text.Wrap;font.pixelSize:12 }
    }
    RowLayout {
        visible:!!App.session.remote;Layout.fillWidth:true
        CText { Layout.fillWidth:true;text:"Mobile restrictions remain active for this session, including desktop turns.";color:Theme.amber;font.pixelSize:12 }
        CButton { text:"Detach mobile";enabled:!chat.busy;onClicked:App.rpc("session.detachRemote",{id:App.selectedId}) }
    }
    RowLayout {
        objectName:"draftConflict";visible:chat.draftConflict;Layout.fillWidth:true
        CText { Layout.fillWidth:true;text:"Draft changed on another client. Your text is retained.";color:Theme.amber;font.pixelSize:12 }
        CButton { text:"Copy mine";onClicked:App.copy(composer.text) }
        CButton { objectName:"draftReload";text:"Reload";onClicked:chat.loadDraft() }
        CButton { objectName:"draftKeepMine";text:"Keep mine";onClicked:{chat.draftRevision=App.session.draftRevision||"0";chat.draftBaseline=App.session.draft||"";chat.draftConflict=false;chat.saveDraft()} }
    }
    Item {
        id:conversationArea;Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumHeight:24;clip:true
        ColumnLayout {
            visible:!App.session.id;anchors.centerIn:parent;width:Math.min(parent.width,400);spacing:18
            CereSprite { visible:conversationArea.height>=270;Layout.alignment:Qt.AlignHCenter;Layout.preferredHeight:Math.min(156,conversationArea.height*.4);Layout.preferredWidth:144;fillMode:Image.PreserveAspectFit }
            CText { text:"What are we making today?";font.pixelSize:chat.width>=600?28:22;font.bold:true;horizontalAlignment:Text.AlignHCenter }
            CText { visible:conversationArea.height>=170;text:"A fresh idea, an unfinished project, or a little help.\nChoose a provider and make yourself at home.";color:Theme.muted;horizontalAlignment:Text.AlignHCenter }
            CButton { text: "New session"; iconName:"plus"; primary: true; Layout.alignment: Qt.AlignHCenter; onClicked: chat.createRequested() }
        }
        ListView {
            id: scroll; visible: !!App.session.id; anchors.fill: parent; clip: true
            spacing:16;cacheBuffer:300;reuseItems:true
            boundsBehavior:Flickable.StopAtBounds
            ScrollBar.vertical: CScrollBar {}
            model: App.transcript
            delegate: MessageCard { required property var entry; width:scroll.width-12; message:entry }
            footer:Column {
                width:scroll.width;spacing:8
                Text { visible: chat.busy; text: chat.activityStatus(); color: chat.pendingApprovals.length ? Theme.amber : Theme.cyan; font.pixelSize: 12 }
                Repeater {
                    model: chat.pendingQuestions
                    ApprovalCard {
                        required property var modelData
                        width: scroll.width - 12
                        approval: modelData
                    }
                }
                Text { visible: !App.messages.length && !!App.session.id && !chat.busy; text: chat.linked ? "Linked terminal · lifecycle observation only. Continue this conversation in its terminal. Once it ends, use CLI history to hand it to Cere." : App.session.nativeId ? "This session will continue its CLI context when you send a message." : "Your session is ready. Tell me what you have in mind."; width: parent.width; wrapMode: Text.Wrap; color: Theme.muted; font.pixelSize: 13 }
            }
            onMovementStarted:chat.follow=false
            // Long histories load in bounded pages; reaching the top requests the previous one.
            onAtYBeginningChanged:if(atYBeginning&&App.hasOlderMessages)App.loadOlderMessages()
            onMovementEnded:if(atYEnd)chat.follow=true
        }
        CButton { visible: !chat.follow && !!App.session.id; anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; text: "↓ Latest messages"; primary: true; onClicked: {chat.follow=true;scroll.positionViewAtEnd()} }
    }
    ActivityPanel {
        id:activityPanel;visible:!!App.session.id&&(chat.busy||App.activityCount>0||chat.agents.length>0);Layout.fillWidth:true
        Layout.preferredHeight:implicitHeight
        maximumHeight:Math.max(0,Math.min(260,chat.height-300))
    }
    Text { visible: attachments.length>0; text: "Attached: "+attachments.map(p=>p.split("/").pop()).join(", "); color: Theme.cyan; font.pixelSize: 11; Layout.fillWidth: true; elide: Text.ElideMiddle }
    Rectangle {
        visible: !!App.session.id
        id:composerCard
        Layout.fillWidth:true;implicitHeight:Math.min(Math.max(122,chat.height*.32),Math.max(122,composer.contentHeight+76));radius:14;color:Theme.surface;border.color:composer.activeFocus?"#3275a0":Theme.line
        ScrollView {
            id:composerViewport;anchors.left:parent.left;anchors.right:parent.right;anchors.top:parent.top;anchors.bottom:composerActions.top;anchors.margins:12;clip:true
            contentWidth:availableWidth;ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
            TextArea {
                id: composer; objectName:"composer"; enabled: !!App.session.id && !chat.linked; placeholderText: chat.linked ? "Continue in the linked terminal" : App.session.id ? "Tell me what you have in mind…" : "Start a session to send a message"
                color: Theme.text; placeholderTextColor: Theme.muted; selectionColor: Theme.selected; font.pixelSize: 14; font.family: Theme.font
                wrapMode: TextEdit.Wrap; selectByMouse: true; background: null
                onTextChanged: { if(App.session.id&&!chat.loadingDraft)draftTimer.restart() }
                Keys.onPressed: event => {if((event.key===Qt.Key_Return||event.key===Qt.Key_Enter)&&(event.modifiers&Qt.ControlModifier)){chat.send();event.accepted=true}}
            }
        }
    RowLayout {
        id:composerActions
        anchors.left:parent.left;anchors.right:parent.right;anchors.bottom:parent.bottom;anchors.margins:10
        spacing:6
        CButton { text:chat.width>=480?"Attach image":"";iconName:"image";quiet:true;help:"Attach an image";Accessible.name:"Attach an image";enabled:!!App.session.id&&attachments.length<4;onClicked:{const p=App.chooseImage();if(p){previewImage.source="file://"+p;imagePreview.imagePath=p;imagePreview.open()}} }
        CButton { visible:attachments.length>0;text:chat.width>=480?"Clear":"×";help:"Clear image attachments";onClicked:attachments=[] }
        CCheckBox { id:searchThisTurn;objectName:"searchThisTurn";visible:App.session.provider==="ollama"&&App.state.settings?.webSearch?.enabled===true;text:chat.width>=480?"Search web":"Web";enabled:!chat.busy&&!App.state.settings?.paused;Accessible.name:"Search web for this message";Accessible.description:"Search uses the next message as a public query, up to 500 characters";ToolTip.visible:hovered;ToolTip.text:Accessible.description }
        Item { Layout.fillWidth:true;Layout.minimumWidth:0 }
        Text { visible:chat.width>=480;text:"Ctrl + Enter";color:Theme.muted;font.pixelSize:10 }
        CButton { objectName:"stopMessage";visible:chat.busy;text:"Stop";implicitWidth:64;leftPadding:6;rightPadding:6;font.pixelSize:13;help:"Stop";Accessible.name:"Stop";danger:true;onClicked:App.rpc("session.stop",{id:App.selectedId}) }
        CButton {
            id:sendButton;objectName:"sendMessage";visible:!chat.busy
            implicitWidth:implicitHeight;leftPadding:9;rightPadding:9
            help:"Send (Ctrl+Enter)";Accessible.name:"Send";primary:true
            enabled:!!App.session.id&&!chat.linked&&composer.text.trim().length>0&&App.connected
            onClicked:chat.send()
            contentItem: Item {
                implicitWidth:20;implicitHeight:20
                Shape {
                    anchors.centerIn:parent;width:20;height:20
                    ShapePath {
                        strokeColor:sendButton.enabled?Theme.cyan:Theme.muted
                        strokeWidth:1.5;fillColor:"transparent"
                        capStyle:ShapePath.RoundCap;joinStyle:ShapePath.RoundJoin
                        PathSvg { path:"M18 2 L12 18 L9 11 L2 8 Z M9 11 L18 2" }
                    }
                }
            }
        }
    }
    }
    }
    function send(){if(!App.session.id||busy||linked||draftConflict||!composer.text.trim())return;draftTimer.stop();pendingText=composer.text;pendingSession=App.selectedId;sendRequest=App.rpc("session.send",{id:App.selectedId,text:composer.text,images:attachments,webSearch:searchThisTurn.visible&&searchThisTurn.checked,expectedDraftRevision:draftRevision});follow=true}
    Timer { id:draftTimer;interval:600;onTriggered:chat.saveDraft() }
    // Edits shorter than the debounce are saved before this host hides, expands or quits,
    // so the other window loads the newest draft rather than an older one.
    Connections { target:App;function onFlushDrafts(){if(draftTimer.running){draftTimer.stop();chat.saveDraft()}} }
    Connections {
        target:App
        function onStateChanged(){
            if(!chat.draftSession||chat.draftSession!==App.selectedId)return
            if(Object.keys(chat.draftRequests).some(id=>chat.draftRequests[id].session===chat.draftSession))return
            const revision=App.session.draftRevision||"0"
            if(revision===chat.draftRevision)return
            if(composer.text===chat.draftBaseline||composer.text===(App.session.draft||""))chat.loadDraft()
            else {chat.draftConflict=true;draftTimer.stop()}
        }
        function onResult(id,value){
            const pending=chat.draftRequests[id];if(!pending)return
            const requests=Object.assign({},chat.draftRequests);delete requests[id];chat.draftRequests=requests
            if(pending.session!==chat.draftSession)return
            if(value?.error){chat.draftConflict=true;draftTimer.stop();return}
            chat.draftRevision=value.draftRevision||"0";chat.draftBaseline=pending.text
            if(composer.text!==pending.text)draftTimer.restart()
        }
    }
    Connections {
        target:App
        function onMessagesChanged(){if(chat.follow&&!chat.pendingQuestions.length)Qt.callLater(()=>{scroll.positionViewAtEnd()})}
        function onStateChanged(){chat.syncApprovals();if(chat.follow&&!chat.pendingQuestions.length)Qt.callLater(()=>{scroll.positionViewAtEnd()})}
    }
    onPendingQuestionsChanged: if (follow && pendingQuestions.length) Qt.callLater(() => {
        if (scroll.footerItem) scroll.contentY = Math.max(scroll.originY, Math.min(scroll.footerItem.y, scroll.originY + scroll.contentHeight - scroll.height))
    })
    Connections { target:App;function onResult(id,value){if(id===chat.sendRequest&&chat.pendingSession===App.selectedId&&!value?.error){if(composer.text===chat.pendingText)composer.text="";chat.attachments=[];searchThisTurn.checked=false}} }
    Connections { target:App;function onAttachmentRequested(path){chat.attachments=chat.attachments.concat([path])} }
    CDialog {
        id:imagePreview;property string imagePath
        CText { text:"Share this image with "+(App.session.provider||"the provider")+"?";font.pixelSize:18;font.weight:Font.DemiBold }
        Image { id:previewImage;Layout.fillWidth:true;Layout.preferredHeight:Math.min(240,chat.height*.5);fillMode:Image.PreserveAspectFit }
        RowLayout { Layout.fillWidth:true;CButton{Layout.fillWidth:true;text:"Cancel";onClicked:imagePreview.close()}CButton{Layout.fillWidth:true;text:"Attach image";primary:true;onClicked:{chat.attachments=chat.attachments.concat([imagePreview.imagePath]);imagePreview.close()}} }
    }
    CDialog {
        id:renameDialog
        property int requestId:-1
        property string sessionId:""
        property string error:""
        onOpened:{sessionId=App.selectedId;renameTitle.text=App.session.title||"";error="";renameTitle.forceActiveFocus();renameTitle.selectAll()}
        CText { text:"Rename session";font.pixelSize:22;font.weight:Font.DemiBold }
        CText { text:"Give this conversation a name you’ll recognize.";color:Theme.muted }
        CField { id:renameTitle;objectName:"renameSessionTitle";Layout.fillWidth:true;maximumLength:100;placeholderText:"Untitled session";Accessible.name:"Session title";onAccepted:if(renameSave.enabled)renameSave.clicked() }
        CText { visible:renameDialog.error.length>0;text:renameDialog.error;color:Theme.danger }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;onClicked:renameDialog.close() }
            CButton { id:renameSave;objectName:"saveSessionTitle";text:renameDialog.requestId>=0?"Saving…":"Save title";primary:true;Layout.fillWidth:true;enabled:App.connected&&renameDialog.requestId<0;onClicked:renameDialog.requestId=App.rpc("session.rename",{id:renameDialog.sessionId,title:renameTitle.text.trim()||"Untitled session"}) }
        }
        Connections { target:App;function onResult(id,value){if(id!==renameDialog.requestId)return;renameDialog.requestId=-1;if(value?.error)renameDialog.error=value.error;else renameDialog.close()} }
    }
    OllamaSessionDialog { id:ollamaOptions }
    CDialog {
        id:handoffDialog;objectName:"handoffDialog"
        property string error:""
        property var targets:[{id:"codex",displayName:"Codex"},{id:"claude",displayName:"Claude"},{id:"ollama",displayName:"Ollama"}].filter(p=>p.id!==App.session.provider)
        onOpened: {error="";handoffTrust.checked=false;handoffProvider.currentIndex=0;handoffText.text="Continue this work in "+(App.session.cwd||"")+".\n\n"+App.messages.filter(m=>m.role!=="tool").slice(-8).map(m=>m.role+": "+m.text).join("\n\n");if(handoffProvider.currentValue==="ollama")App.rpc("provider.models",{provider:"ollama"})}
        CText { text:"Review context before sharing";font.pixelSize:18;font.bold:true }
        CText { text:"Choose a provider for the new conversation. Nothing is sent until you submit its draft.";color:Theme.muted;font.pixelSize:12 }
        CComboBox { id:handoffProvider;objectName:"handoffProvider";Layout.fillWidth:true;model:handoffDialog.targets;textRole:"displayName";valueRole:"id";Accessible.name:"Handoff provider";onActivated:if(currentValue==="ollama")App.rpc("provider.models",{provider:"ollama"}) }
        CComboBox { id:handoffModel;visible:handoffProvider.currentValue==="ollama";Layout.fillWidth:true;model:App.state.capabilities?.ollama?.models||[];textRole:"displayName";valueRole:"id";Accessible.name:"Handoff model";currentIndex:Math.max(0,model.findIndex(m=>m.id===App.state.settings?.ollama?.model)) }
        CCheckBox { id:handoffTrust;objectName:"handoffTrust";visible:!App.state.settings?.bypassCliPermissions&&App.session.provider==="ollama"&&!App.session.ollama?.tools&&handoffProvider.currentValue!=="ollama";text:"I trust this project’s CLI configuration and hooks" }
        CText { visible:!!handoffDialog.error;text:handoffDialog.error;color:Theme.danger;font.pixelSize:12 }
        ScrollView {
            Layout.fillWidth:true;Layout.preferredHeight:Math.min(240,chat.height*.5);clip:true;contentWidth:availableWidth
            ScrollBar.horizontal.policy:ScrollBar.AlwaysOff
            ScrollBar.vertical:CScrollBar{}
            TextArea{id:handoffText;color:Theme.text;font.family:Theme.font;font.pixelSize:13;wrapMode:TextEdit.Wrap;selectByMouse:true;background:Rectangle{color:Theme.input;radius:7}}
        }
        CButton { objectName:"handoffCreate";Layout.fillWidth:true;text:"Create handoff draft";primary:true;enabled:App.connected&&chat.handoffRequest<0&&(!handoffTrust.visible||handoffTrust.checked)&&(handoffProvider.currentValue!=="ollama"||!!handoffModel.currentValue);onClicked:{chat.handoff=handoffText.text;chat.handoffRequest=App.rpc("session.create",{provider:handoffProvider.currentValue,model:handoffProvider.currentValue==="ollama"?handoffModel.currentValue:"",cwd:App.session.cwd,trusted:!handoffTrust.visible||handoffTrust.checked,title:"Handoff · "+App.session.title})} }
    }
    property int handoffRequest:-1
    Connections{target:App;function onResult(id,value){if(id===chat.handoffRequest){chat.handoffRequest=-1;if(value.error)handoffDialog.error=value.error;else{handoffDialog.close();composer.text=chat.handoff;App.rpc("session.draft",{id:value.id,text:chat.handoff})}}}}
}
