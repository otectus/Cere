import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Shapes
Item {
    id: chat
    objectName:"chatView"
    signal createRequested()
    signal backRequested()
    property bool showBackButton: false
    // Short pages fold the conversation tools into one menu so the conversation keeps its room.
    readonly property bool toolsFolded: height < 560
    component ConversationTool: CButton {
        id:tool
        readonly property bool iconOnly:chat.width<480
        property bool badge:false
        quiet:true;implicitHeight:30;implicitWidth:iconOnly?34:contentItem.implicitWidth+16
        leftPadding:8;rightPadding:8;font.pixelSize:Theme.secondary
        help:text
        contentItem:Item {
            implicitWidth:tool.iconOnly?18:caption.implicitWidth
            CIcon { anchors.centerIn:parent;visible:tool.iconOnly;name:tool.iconName;color:tool.enabled?Theme.text:Theme.muted }
            Rectangle { visible:tool.iconOnly&&tool.badge;anchors.right:parent.right;anchors.top:parent.top;width:5;height:5;radius:3;color:Theme.cyan }
            Text { id:caption;anchors.fill:parent;visible:!tool.iconOnly;text:tool.text;font:tool.font;color:tool.enabled?Theme.text:Theme.muted;verticalAlignment:Text.AlignVCenter;horizontalAlignment:Text.AlignHCenter }
        }
    }
    function focusComposer() { if(composer.enabled)composer.forceActiveFocus() }
    readonly property var agents: App.session.agents || []
    readonly property var activeAgents: agents.filter(agent => ["starting", "running", "waiting"].indexOf(agent.status) >= 0)
    property var pendingApprovals: []
    readonly property var pendingQuestions: pendingApprovals.filter(approval => approval.kind === "question" || (approval.questions || []).length > 0)
    function syncApprovals() {
        const next = (App.state.approvals || []).filter(approval => approval.sessionId === App.selectedId || agents.some(agent => agent.id === approval.sessionId))
        // Preserve focused editors during unrelated provider progress snapshots.
        if (JSON.stringify(next) !== JSON.stringify(pendingApprovals)) pendingApprovals = next
    }
    Component.onCompleted: syncApprovals()
    property bool busy: ["starting","working","waiting","stopping"].indexOf(App.session.status)>=0 || activeAgents.length>0 || pendingApprovals.length>0
    readonly property bool canSendWhileBusy: App.session.provider === "ollama" && App.session.status !== "stopping"
    property bool linked: App.session.mode==="linked"
    readonly property var motionSettings: App.state.settings || ({})
    readonly property bool idleWhileReading: !!(((App.animations.idleProfiles || {})[motionSettings.idleEnergy || App.animations.defaultIdleProfile] || {}).idleWhileReading)
        && !motionSettings.quiet && !motionSettings.reducedMotion && motionSettings.motionIntensity !== 0
    property bool listening: visible && composer.activeFocus && composer.enabled && !busy
        && (!idleWhileReading || composer.text.length > 0 || attachments.length > 0)
    onListeningChanged: App.setListening(listening)
    property string sessionId: App.selectedId
    property var attachments: []
    property string attachmentBaseline: "[]"
    property var attachmentRequests: ({})
    property string attachmentError: ""
    property var recoverable:({})
    property int recoveryRequest:-1
    property int recoveryRestoreRequest:-1
    property string restoreOwner:""
    property string recoveryOwner:""
    readonly property string recoveryStatus:App.session.status||""
    onRecoveryStatusChanged: if(recoveryStatus==="error"||recoveryStatus==="interrupted")inspectRecovery()
    function inspectRecovery(){if(!App.selectedId||!App.connected)return;recoveryOwner=App.selectedId;recoveryRequest=App.rpc("session.recovery",{id:App.selectedId})}
    property string pendingAttachments: "[]"
    property bool sendAfterSave: false
    function attachmentIds() { return attachments.map(a=>a.id) }
    readonly property bool importingAttachments:Object.keys(attachmentRequests).some(id=>attachmentRequests[id]===App.selectedId)
    function draftDirty() { return composer.text!==draftBaseline || JSON.stringify(attachmentIds())!==attachmentBaseline }
    onAttachmentsChanged: if(draftSession&&!loadingDraft)draftTimer.restart()
    function importAttachment(path) {
        if(!App.session.id||chat.linked||!App.connected)return
        if(App.session.temporary){attachmentError="Temporary conversations accept pasted text only.";return}
        const importing=Object.keys(attachmentRequests).filter(id=>attachmentRequests[id]===App.selectedId).length
        if(attachments.length+importing>=8){attachmentError="Choose up to eight attachments.";return}
        attachmentError=""
        const request=App.rpc("attachments.import",{sessionId:App.selectedId,path:path})
        const next=Object.assign({},attachmentRequests);next[request]=App.selectedId;attachmentRequests=next
    }
    function pasteClipboard() {
        if(!composer.enabled)return
        attachmentError=""
        const content=App.clipboardContent()
        if(content.handled){
            if(content.error){attachmentError=content.error;return}
            for(const path of content.paths||[])importAttachment(path)
        }else{
            // TextEdit preserves cursor placement, selections and undo history.
            composer.paste()
        }
        composer.forceActiveFocus()
    }
    property int proposalRequest:-1
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
    property bool saveQueued:false
    // Composer and reading position carried between the compact panel and the workspace.
    property string viewBaseline:""
    property string remoteView:""
    property bool viewPristine:true
    property bool restoringView:false
    property double viewRestoredAt:0
    property var pendingAnchor:null
    property var settlingAnchor:null
    property var trackedAnchor:({anchorId:"",anchorOffset:0,atEnd:true})
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
    function loadDraft(){loadingDraft=true;draftRevision=App.session.draftRevision||"0";draftBaseline=App.session.draft||"";if(composer.text!==draftBaseline)composer.text=draftBaseline;attachments=App.session.draftAttachments||[];attachmentBaseline=JSON.stringify(attachmentIds());draftConflict=false;loadingDraft=false;draftTimer.stop();recoverable={};inspectRecovery()}
    // flush: the surface is hiding or closing, so a save waiting on another hands over to the controller.
    // previous: the selection already moved on, so the reading position comes from the tracked anchor.
    function saveDraft(flush,previous){
        if(!draftSession||!App.connected||draftConflict||importingAttachments)return
        const view=viewState(previous),key=viewKey(view),textDirty=draftDirty()
        if(!textDirty&&key===viewBaseline)return
        const ids=attachmentIds(),params={id:draftSession,text:composer.text,attachmentIds:ids,scroll:previous?0:scroll.contentY,view:view}
        const inflight=Object.keys(draftRequests).find(id=>draftRequests[id].session===draftSession)
        if(inflight!==undefined){
            if(flush){App.deferDraft(Number(inflight),params);draftRequests[inflight].deferred=true;saveQueued=false}
            else saveQueued=true
            return
        }
        params.expectedRevision=draftRevision
        const id=App.rpc("session.draft",params);if(id<0)return
        const pending=Object.assign({},draftRequests);pending[id]={session:draftSession,text:composer.text,attachments:JSON.stringify(ids),view:key,viewOnly:!textDirty};draftRequests=pending
    }
    function viewKey(v){v=v||({});return [Math.trunc(v.cursor||0),Math.trunc(v.selectionStart||0),Math.trunc(v.selectionEnd||0),v.webSearch===true,v.activityExpanded===true,v.anchorId||"",Math.round(v.anchorOffset||0),v.atEnd!==false,v.focus||""].join("|")}
    // The message at the top of the conversation and how far into it the reader is.
    function computeAnchor(){
        // A hidden page (Sessions, Settings…) keeps the last position the reader saw.
        if(!chat.visible||!scroll.visible)return null
        if(!App.session.id||scroll.count===0||chat.follow||scroll.atYEnd)return {anchorId:"",anchorOffset:0,atEnd:true}
        for(const probe of [1,scroll.spacing+2]){
            const index=scroll.indexAt(scroll.width/2,scroll.contentY+probe)
            const card=index<0?null:scroll.itemAtIndex(index)
            // The offset is a share of the message's height (in ten-thousandths), so it survives reflow.
            if(card&&card.message&&card.message.id)return {anchorId:String(card.message.id),anchorOffset:Math.round(10000*Math.max(0,scroll.contentY-card.y)/Math.max(1,card.height)),atEnd:false}
        }
        return null
    }
    function viewState(previous){
        const anchor=previous?trackedAnchor:(computeAnchor()||trackedAnchor)
        return {cursor:composer.cursorPosition,selectionStart:composer.selectionStart,selectionEnd:composer.selectionEnd,webSearch:searchThisTurn.checked,activityExpanded:activityPanel.expanded,
            anchorId:anchor.anchorId,anchorOffset:anchor.anchorOffset,atEnd:anchor.atEnd,focus:composer.activeFocus?"composer":""}
    }
    function restoreView(view){
        restoringView=true
        const v=view||({})
        if(view){
            searchThisTurn.checked=v.webSearch===true
            activityPanel.expanded=v.activityExpanded===true
            // A new editor applies its text when it completes, which would reset the cursor.
            Qt.callLater(()=>{
                if(sessionId!==App.selectedId)return
                restoringView=true
                const length=composer.length,clamp=n=>Math.max(0,Math.min(length,Math.trunc(Number(n)||0)))
                const start=clamp(v.selectionStart),end=clamp(v.selectionEnd),cursor=clamp(v.cursor)
                if(end>start){composer.cursorPosition=cursor===start?end:start;composer.moveCursorSelection(cursor===start?start:end,TextEdit.SelectCharacters)}
                else composer.cursorPosition=cursor
                restoringView=false
            })
        }
        pendingAnchor=view&&v.atEnd===false&&v.anchorId?{id:String(v.anchorId),offset:Number(v.anchorOffset)||0}:null
        follow=!pendingAnchor
        if(pendingAnchor)Qt.callLater(restoreAnchor)
        else if(view)Qt.callLater(()=>scroll.positionViewAtEnd())
        else Qt.callLater(()=>{scroll.contentY=App.session.scroll||0})
        if(view&&v.focus==="composer")Qt.callLater(focusComposer)
        remoteView=viewKey(view);viewBaseline=view?remoteView:"";viewRestoredAt=Date.now();viewPristine=true
        restoringView=false
    }
    // Restores by message, not pixels: the same message stays on top when widths reflow.
    function restoreAnchor(){
        if(!pendingAnchor||!App.session.id)return
        const row=App.transcriptRow(pendingAnchor.id)
        if(row<0){if(Date.now()-viewRestoredAt>5000){pendingAnchor=null;follow=true;scroll.positionViewAtEnd()}return}
        restoringView=true
        scroll.positionViewAtIndex(row,ListView.Beginning)
        placeAnchor(row,pendingAnchor.offset)
        // Cards finish formatting a moment later; keep the anchor in place until they settle.
        settlingAnchor={row:row,offset:pendingAnchor.offset,passes:6};anchorSettle.restart()
        pendingAnchor=null;follow=false
        restoringView=false
    }
    function placeAnchor(row,offset){
        const card=scroll.itemAtIndex(row)
        if(!card){scroll.positionViewAtIndex(row,ListView.Beginning);return}
        // Rounding after reflow must not slip the anchored message past the top edge.
        const target=card.y+Math.min(Math.max(0,card.height-2),Math.round(card.height*Math.max(0,Math.min(9999,offset))/10000))
        scroll.contentY=Math.max(scroll.originY,Math.min(scroll.originY+scroll.contentHeight-scroll.height,target))
    }
    onSessionIdChanged: {
        submissionRecovery.close()
        if(draftSession){draftTimer.stop();saveDraft(false,true)}
        draftSession=sessionId;loadDraft();attachmentError="";sendAfterSave=false;saveQueued=false
        activityPanel.expanded=false;trackedAnchor={anchorId:"",anchorOffset:0,atEnd:true}
        restoreView(App.session.view)
    }
    Component.onDestruction: { App.setListening(false);saveDraft(true) }
    // Below its minimum height the page scrolls, so every control stays reachable.
    Flickable {
        id:chatPage;objectName:"chatPage"
        anchors.fill:parent;clip:true
        contentWidth:width;contentHeight:Math.max(height,column.implicitHeight)
        interactive:contentHeight>height+1;boundsBehavior:Flickable.StopAtBounds
        ScrollBar.vertical:CScrollBar { policy:chatPage.interactive?ScrollBar.AlwaysOn:ScrollBar.AlwaysOff }
    ColumnLayout {
        id:column
        x:Math.max(0,(chatPage.width-(chatPage.interactive?12:0)-width)/2)
        width:Math.min(chatPage.width-(chatPage.interactive?12:0),1040);height:chatPage.contentHeight;spacing:chat.height<500?8:12
        RowLayout {
            Layout.fillWidth:true;spacing:8
            CButton { objectName:"backToSessions";visible:chat.showBackButton;text:"";iconName:"back";quiet:true;help:"Back to sessions";Accessible.name:"Back to sessions";onClicked:chat.backRequested() }
            // Title and provider share one block so short panels keep the conversation's room.
            ColumnLayout {
                Layout.fillWidth:true;Layout.minimumWidth:0;spacing:1
                Text {
                    id:sessionTitle;objectName:"sessionTitle"
                    text:App.session.title||"A little help. A little company."
                    Layout.fillWidth:true;Layout.minimumWidth:0;color:Theme.text;font.family:Theme.font;font.weight:Font.DemiBold
                    font.pixelSize:chat.width>=600?Theme.page:Theme.section;elide:Text.ElideRight;textFormat:Text.PlainText
                    HoverHandler { id:titleHover }
                    ToolTip.visible:titleHover.hovered&&sessionTitle.truncated;ToolTip.text:sessionTitle.text;ToolTip.delay:600
                }
                Text {
                    id:sessionSubtitle;objectName:"sessionSubtitle";visible:!!App.session.id
                    text:App.session.provider?App.session.provider.charAt(0).toUpperCase()+App.session.provider.slice(1)+(App.session.model?" · "+App.session.model:"")+"  /  "+App.session.cwd:""
                    Layout.fillWidth:true;Layout.minimumWidth:0;color:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption
                    maximumLineCount:1;elide:Text.ElideMiddle;textFormat:Text.PlainText
                    HoverHandler { id:subtitleHover }
                    ToolTip.visible:subtitleHover.hovered&&sessionSubtitle.truncated;ToolTip.text:sessionSubtitle.text;ToolTip.delay:600
                }
            }
            CButton { objectName:"renameSession";visible:!!App.session.id;text:"";iconName:"edit";quiet:true;help:"Rename session";Accessible.name:"Rename session";onClicked:renameDialog.open() }
        }
        Rectangle { Layout.fillWidth:true;height:1;color:Theme.subtle }
    RowLayout {
        visible:App.session.temporary===true;Layout.fillWidth:true
        CText { Layout.fillWidth:true;text:"Temporary · no Cere history or memory. External providers may retain this conversation.";color:Theme.amber;font.pixelSize:Theme.caption }
        CButton { text:"Discard";danger:true;onClicked:App.rpc("session.discardTemporary",{id:App.selectedId}) }
    }
    Rectangle {
        visible: !!App.session.error; Layout.fillWidth: true; implicitHeight: errorText.implicitHeight+18; radius: Theme.radiusControl; color: Theme.dangerSurface; border.color: Theme.dangerBorder
        Text { id:errorText; anchors.fill:parent;anchors.margins:9;text:App.session.error || "";color:Theme.danger;wrapMode:Text.Wrap;font.pixelSize:Theme.secondary }
    }
    RowLayout {
        visible:!!App.session.remote;Layout.fillWidth:true
        CText { Layout.fillWidth:true;text:"Mobile restrictions remain active for this session, including desktop turns.";color:Theme.amber;font.pixelSize:Theme.secondary }
        CButton { text:"Detach mobile";enabled:!chat.busy;onClicked:App.rpc("session.detachRemote",{id:App.selectedId}) }
    }
    RowLayout {
        objectName:"draftConflict";visible:chat.draftConflict;Layout.fillWidth:true
        CText { Layout.fillWidth:true;text:"Draft changed on another client. Your text is retained.";color:Theme.amber;font.pixelSize:Theme.secondary }
        CButton { text:"Copy mine";onClicked:App.copy(composer.text) }
        CButton { objectName:"draftReload";text:"Reload";onClicked:chat.loadDraft() }
        CButton { objectName:"draftKeepMine";text:"Keep mine";onClicked:{chat.draftRevision=App.session.draftRevision||"0";chat.draftBaseline=App.session.draft||"";chat.draftConflict=false;chat.saveDraft()} }
    }
    Item {
        id:conversationArea;objectName:"conversationArea";Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumHeight:24;clip:true
        // The page scrolls rather than squeezing the conversation (and any pending question) to a sliver.
        implicitHeight:chat.pendingQuestions.length?300:160
        ColumnLayout {
            visible:!App.session.id;anchors.centerIn:parent;width:Math.min(parent.width,400);spacing:18
            CereSprite { visible:conversationArea.height>=270;Layout.alignment:Qt.AlignHCenter;Layout.preferredHeight:Math.min(156,conversationArea.height*.4);Layout.preferredWidth:144;fillMode:Image.PreserveAspectFit }
            CText { text:"What are we making today?";font.pixelSize:chat.width>=600?Theme.display:Theme.page;font.bold:true;horizontalAlignment:Text.AlignHCenter }
            CText { visible:conversationArea.height>=170;text:"A fresh idea, an unfinished project, or a little help.\nChoose a provider and make yourself at home.";color:Theme.muted;horizontalAlignment:Text.AlignHCenter }
            CButton { text: "New session"; iconName:"plus"; primary: true; Layout.alignment: Qt.AlignHCenter; onClicked: chat.createRequested() }
        }
        ListView {
            id: scroll; objectName:"messageList"; visible: !!App.session.id; anchors.fill: parent; clip: true
            spacing:16;cacheBuffer:300;reuseItems:true
            boundsBehavior:Flickable.StopAtBounds
            // Dragging the scrollbar is reading too: it must stop new output from pulling the view down.
            ScrollBar.vertical: CScrollBar { onPressedChanged: if(pressed){chat.follow=false;chat.viewPristine=false}else if(scroll.atYEnd)chat.follow=true }
            model: App.transcript
            delegate: MessageCard { required property var entry; width:scroll.width-12; message:entry;onProposalRequested:kind=>{chat.proposalRequest=App.rpc("memoryReview.propose",{sessionId:entry.sessionId,messageId:entry.id,kind:kind})};onBranchRequested:text=>{branch.contextText=text;branch.open()};onQuoteRequested:text=>{composer.text+=(composer.text?"\n\n":"")+text.split("\n").map(line=>"> "+line).join("\n")+"\n\n";chat.focusComposer()} }
            footer:Column {
                width:scroll.width;spacing:8
                Text { visible: (App.session.queuedCount||0)>0; text: App.session.queuedCount+" message(s) queued · will send after this turn"; color:Theme.cyan;font.pixelSize:Theme.secondary }
                Text { visible: chat.busy; text: chat.activityStatus(); color: chat.pendingApprovals.length ? Theme.amber : Theme.cyan; font.pixelSize: Theme.secondary }
                Repeater {
                    model: chat.pendingQuestions
                    ApprovalCard {
                        required property var modelData
                        width: scroll.width - 12
                        approval: modelData
                    }
                }
                Text { visible: !App.messages.length && !!App.session.id && !chat.busy; text: chat.linked ? "Linked terminal · lifecycle observation only. Continue this conversation in its terminal. Once it ends, use CLI history to hand it to Cere." : App.session.nativeId ? "This session will continue its CLI context when you send a message." : "Your session is ready. Tell me what you have in mind."; width: parent.width; wrapMode: Text.Wrap; color: Theme.muted; font.pixelSize: Theme.body }
            }
            onMovementStarted:{chat.follow=false;chat.viewPristine=false}
            onContentYChanged:if(!chat.restoringView&&!chat.pendingAnchor)anchorTracker.restart()
            // Long histories load in bounded pages; reaching the top requests the previous one.
            onAtYBeginningChanged:if(atYBeginning&&App.hasOlderMessages)App.loadOlderMessages()
            onMovementEnded:if(atYEnd)chat.follow=true
        }
        CButton { visible: !chat.follow && !!App.session.id; anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; text: "↓ Latest messages"; primary: true; onClicked: {chat.follow=true;scroll.positionViewAtEnd()} }
    }
    ActivityPanel {
        id:activityPanel;objectName:"activityPanel";visible:!!App.session.id&&(chat.busy||App.activityCount>0||chat.agents.length>0);Layout.fillWidth:true
        onExpandedChanged:if(!chat.restoringView)chat.viewPristine=false
        Layout.preferredHeight:implicitHeight
        maximumHeight:Math.max(0,Math.min(260,chat.height-300))
    }
    CText { visible:!!chat.attachmentError;text:chat.attachmentError;color:Theme.danger;Layout.fillWidth:true;font.pixelSize:Theme.secondary }
    Flickable {
        visible:chat.attachments.length>0;Layout.fillWidth:true;Layout.preferredHeight:68;contentWidth:attachmentRow.width;clip:true
        Row {
            id:attachmentRow;spacing:8
            Repeater {
                model:chat.attachments
                Rectangle {
                    required property var modelData;required property int index
                    objectName:"attachmentChip_"+modelData.id
                    width:180;height:60;radius:Theme.radiusControl;color:Theme.surface;border.color:Theme.border
                    Image { x:4;y:4;width:48;height:48;fillMode:Image.PreserveAspectFit;visible:parent.modelData.kind==="image";source:visible?"file://"+parent.modelData.path:"";asynchronous:true }
                    Text { x:parent.modelData.kind==="image"?58:8;y:8;width:90;text:parent.modelData.name;elide:Text.ElideMiddle;color:Theme.text;font.pixelSize:Theme.caption }
                    Text { x:parent.modelData.kind==="image"?58:8;y:30;text:Math.ceil(parent.modelData.size/1024)+" KiB";color:Theme.muted;font.pixelSize:Theme.caption }
                    CButton { anchors.right:parent.right;anchors.verticalCenter:parent.verticalCenter;text:"×";quiet:true;implicitWidth:28;Accessible.name:"Remove "+parent.modelData.name;onClicked:chat.attachments=chat.attachments.filter((a,i)=>i!==parent.index) }
                }
            }
        }
    }
    Rectangle {
        visible: !!App.session.id
        id:composerCard;objectName:"composerCard"
        readonly property int minimumHeight:chat.height<560?96:122
        Layout.fillWidth:true;implicitHeight:Math.min(Math.max(minimumHeight,chat.height*.32),Math.max(minimumHeight,composer.contentHeight+76));radius:Theme.radiusPanel;color:Theme.surface;border.color:composer.activeFocus?Theme.focus:Theme.border;border.width:composer.activeFocus?Theme.focusWidth:1
        DropArea { anchors.fill:parent;onDropped:drop=>{if(drop.hasUrls){for(const url of drop.urls){const value=String(url);if(value.startsWith("file://"))chat.importAttachment(decodeURIComponent(value.slice(7)))}}else if(drop.hasText)composer.text+=(composer.text?"\n":"")+drop.text;drop.acceptProposedAction()} }
        ScrollView {
            id:composerViewport;anchors.left:parent.left;anchors.right:parent.right;anchors.top:parent.top;anchors.bottom:composerActions.top;anchors.margins:12;clip:true
            contentWidth:availableWidth;ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
            TextArea {
                id: composer; objectName:"composer"; enabled: !!App.session.id && !chat.linked; placeholderText: chat.linked ? "Continue in the linked terminal" : App.session.id ? "Tell me what you have in mind…" : "Start a session to send a message"
                color: Theme.text; placeholderTextColor: Theme.muted; selectionColor: Theme.selected; font.pixelSize: Theme.message; font.family: Theme.font
                // Moving to another control keeps the selection, so it survives switching surfaces too.
                wrapMode: TextEdit.Wrap; selectByMouse: true; persistentSelection: true; background: null
                onTextChanged: { if(App.session.id&&!chat.loadingDraft)draftTimer.restart() }
                onCursorPositionChanged: if(!chat.restoringView&&!chat.loadingDraft)chat.viewPristine=false
                Keys.onPressed: event => {
                    if(event.matches(StandardKey.Paste)){chat.pasteClipboard();event.accepted=true}
                    else if((event.key===Qt.Key_Return||event.key===Qt.Key_Enter)&&!composer.inputMethodComposing&&!(event.modifiers&Qt.ShiftModifier)){
                        event.accepted=true
                        if(!event.isAutoRepeat)chat.send()
                    }
                }
            }
        }
    RowLayout {
        id:composerActions
        anchors.left:parent.left;anchors.right:parent.right;anchors.bottom:parent.bottom;anchors.margins:10
        spacing:6
        CButton { text:chat.width>=480?"Attach":"";iconName:"image";quiet:true;help:"Attach an image or text file";Accessible.name:"Attach a file";enabled:!!App.session.id&&!App.session.temporary&&attachments.length<8;onClicked:{const p=App.chooseFile();if(p)chat.importAttachment(p)} }
        CButton { objectName:"pasteClipboard";text:"Paste";quiet:true;help:"Paste text, images or files (Ctrl+V)";enabled:composer.enabled;onClicked:chat.pasteClipboard() }
        CButton { visible:attachments.length>0;text:chat.width>=480?"Clear":"×";help:"Clear image attachments";onClicked:attachments=[] }
        CCheckBox { id:searchThisTurn;objectName:"searchThisTurn";visible:["ollama","openai","anthropic","google"].includes(App.session.provider)&&App.state.settings?.webSearch?.enabled===true;text:chat.width>=480?"Search web":"Web";enabled:(!chat.busy||chat.canSendWhileBusy)&&!App.state.settings?.paused;Accessible.name:"Search web for this message";Accessible.description:"Search uses the next message as a public query, up to 500 characters";ToolTip.visible:hovered;ToolTip.text:Accessible.description;onToggled:chat.viewPristine=false }
        Item { Layout.fillWidth:true;Layout.minimumWidth:0 }
        Text { visible:chat.width>=480;text:"Shift+Enter · new line";color:Theme.muted;font.pixelSize:Theme.caption }
        CButton {
            id:moreTools;objectName:"conversationMore";visible:chat.toolsFolded&&!!App.session.id
            implicitWidth:implicitHeight;leftPadding:9;rightPadding:9;quiet:true
            help:"More conversation tools";Accessible.name:"More conversation tools"
            contentItem:CIcon { name:"more";color:Theme.text }
            onClicked:toolsMenu.popup(moreTools,0,-toolsMenu.implicitHeight)
        }
        VoiceInput {
            id:voiceInput;sessionId:App.selectedId;available:composer.enabled
            onTranscriptionAccepted:text=>{composer.insert(composer.cursorPosition,(composer.text?"\n":"")+text);composer.forceActiveFocus()}
        }
        CButton { objectName:"stopMessage";visible:chat.busy;text:"Stop";implicitWidth:64;leftPadding:6;rightPadding:6;font.pixelSize:Theme.body;help:"Stop";Accessible.name:"Stop";danger:true;onClicked:App.rpc("session.stop",{id:App.selectedId}) }
        CButton {
            id:sendButton;objectName:"sendMessage";visible:!chat.busy||chat.canSendWhileBusy
            implicitWidth:implicitHeight;leftPadding:9;rightPadding:9
            help:chat.busy?"Queue message after this turn (Enter)":"Send (Enter) · Shift+Enter for a new line";Accessible.name:"Send";primary:true
            enabled:!!App.session.id&&!chat.linked&&!chat.importingAttachments&&composer.text.trim().length>0&&App.connected
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
    RowLayout {
        visible:!!voiceInput.statusText;Layout.fillWidth:true;spacing:6
        CText { objectName:"voiceInputStatus";Layout.fillWidth:true;text:voiceInput.statusText;wrapMode:Text.Wrap;font.pixelSize:Theme.caption;color:voiceInput.error?Theme.danger:Theme.amber }
        CButton { objectName:"voiceCancel";visible:voiceInput.recording;quiet:true;danger:true;text:"Cancel";implicitHeight:30;onClicked:voiceInput.cancel() }
    }
        Flow {
            objectName:"conversationTools";visible:!!App.session.id&&!chat.toolsFolded;Layout.fillWidth:true;spacing:2
            ConversationTool { objectName:"ollamaModelOptions";visible:App.session.mode==="managed";text:"Model";iconName:"model";enabled:!chat.busy&&App.connected;help:"Choose the model for your next message";onClicked:modelOptions.open() }
            ConversationTool { objectName:"chatHandoff";text:"Handoff";iconName:"arrow";help:"Continue with another provider";onClicked:handoffDialog.open() }
            ConversationTool { objectName:"chatInbox";text:"Inbox · "+(App.state.completions||[]).length;iconName:"inbox";badge:(App.state.completions||[]).length>0;onClicked:inbox.open() }
            ConversationTool { objectName:"chatMemoryReview";text:"Memory review";iconName:"memory";onClicked:memoryReview.open() }
            ConversationTool { objectName:"contextDrawerButton";text:"Context";iconName:"context";onClicked:contextDrawer.open() }
            ConversationTool { visible:!!chat.recoverable.text&&chat.recoverable.state!=="accepted";text:"Recover submission";iconName:"back";onClicked:submissionRecovery.open() }
            ConversationTool { visible:chat.linked;text:"Terminal";iconName:"terminal";onClicked:App.rpc("session.terminal",{id:App.selectedId}) }
        }
    }
    }
    // The same tools as the row below the composer, for pages too short to show it.
    CMenu {
        id:toolsMenu;objectName:"conversationToolsMenu"
                CMenuItem { objectName:"menuModelOptions";text:"Model";visible:App.session.mode==="managed";enabled:!chat.busy&&App.connected;onTriggered:modelOptions.open() }
        CMenuItem { objectName:"menuHandoff";text:"Handoff";onTriggered:handoffDialog.open() }
        CMenuItem { objectName:"menuInbox";text:"Inbox · "+(App.state.completions||[]).length;onTriggered:inbox.open() }
        CMenuItem { objectName:"menuMemoryReview";text:"Memory review";onTriggered:memoryReview.open() }
        CMenuItem { objectName:"menuContext";text:"Context";onTriggered:contextDrawer.open() }
        CMenuItem { text:"Recover submission";visible:!!chat.recoverable.text&&chat.recoverable.state!=="accepted";onTriggered:submissionRecovery.open() }
        CMenuItem { text:"Terminal";visible:chat.linked;onTriggered:App.rpc("session.terminal",{id:App.selectedId}) }
    }
    function send(){if(!App.connected||sendRequest>=0||!App.session.id||(busy&&!canSendWhileBusy)||linked||draftConflict||importingAttachments||!composer.text.trim())return;if(Object.keys(draftRequests).some(id=>draftRequests[id].session===draftSession)){sendAfterSave=true;return}draftTimer.stop();pendingText=composer.text;pendingSession=App.selectedId;pendingAttachments=JSON.stringify(attachmentIds());sendRequest=App.rpc("session.send",{id:App.selectedId,text:composer.text,attachmentIds:attachmentIds(),webSearch:searchThisTurn.visible&&searchThisTurn.checked,expectedDraftRevision:draftRevision});follow=true}
    Timer { id:draftTimer;interval:600;onTriggered:chat.saveDraft(false) }
    Timer { id:anchorTracker;interval:150;onTriggered:chat.trackedAnchor=chat.computeAnchor()||chat.trackedAnchor }
    Timer {
        id:anchorSettle;interval:50;repeat:true
        onTriggered:{
            const settling=chat.settlingAnchor
            if(!settling||!chat.viewPristine||scroll.moving){stop();chat.settlingAnchor=null;return}
            chat.restoringView=true;chat.placeAnchor(settling.row,settling.offset);chat.restoringView=false
            if(--settling.passes<=0){stop();chat.settlingAnchor=null;chat.trackedAnchor=chat.computeAnchor()||chat.trackedAnchor}
        }
    }
    // Edits shorter than the debounce are saved before this host hides, expands or quits,
    // so the other window loads the newest draft rather than an older one.
    Connections { target:App;function onFlushDrafts(){draftTimer.stop();chat.saveDraft(true)} }
    Connections {
        target:App
        function onStateChanged(){
            if(!chat.draftSession||chat.draftSession!==App.selectedId)return
            if(Object.keys(chat.attachmentRequests).some(id=>chat.attachmentRequests[id]===chat.draftSession))return
            if(Object.keys(chat.draftRequests).some(id=>chat.draftRequests[id].session===chat.draftSession))return
            const revision=App.session.draftRevision||"0"
            if(revision!==chat.draftRevision){
                if(!chat.draftDirty()||(composer.text===(App.session.draft||"")&&JSON.stringify(chat.attachmentIds())===JSON.stringify((App.session.draftAttachments||[]).map(a=>a.id))))chat.loadDraft()
                else {chat.draftConflict=true;draftTimer.stop();return}
            }
            // The surface this one replaced may save its view just after this one opened.
            const incoming=chat.viewKey(App.session.view)
            if(incoming!==chat.remoteView){
                chat.remoteView=incoming
                if(App.session.view&&chat.viewPristine&&Date.now()-chat.viewRestoredAt<4000)chat.restoreView(App.session.view)
            }
        }
        function onResult(id,value){
            const pending=chat.draftRequests[id];if(!pending)return
            const requests=Object.assign({},chat.draftRequests);delete requests[id];chat.draftRequests=requests
            if(pending.session!==chat.draftSession)return
            // A view-only save never blocks the draft; the newer draft arrives with the next state.
            if(value?.error){if(!pending.viewOnly){chat.draftConflict=true;draftTimer.stop()}return}
            chat.draftRevision=value.draftRevision||"0";chat.draftBaseline=pending.text;chat.attachmentBaseline=pending.attachments
            chat.viewBaseline=pending.view;chat.remoteView=chat.viewKey(value.view)
            if(pending.deferred)return
            if(chat.sendAfterSave){chat.sendAfterSave=false;Qt.callLater(()=>chat.send())}
            else if(chat.saveQueued){chat.saveQueued=false;chat.saveDraft(false)}
            else if(chat.draftDirty())draftTimer.restart()
        }
    }
    Connections {
        target:App
        function onMessagesChanged(){if(chat.pendingAnchor)Qt.callLater(chat.restoreAnchor);else if(chat.follow&&!chat.pendingQuestions.length)Qt.callLater(()=>{scroll.positionViewAtEnd()})}
        function onStateChanged(){chat.syncApprovals();if(chat.follow&&!chat.pendingQuestions.length)Qt.callLater(()=>{scroll.positionViewAtEnd()})}
    }
    onPendingQuestionsChanged: if (follow && pendingQuestions.length) Qt.callLater(() => {
        if (scroll.footerItem) scroll.contentY = Math.max(scroll.originY, Math.min(scroll.footerItem.y, scroll.originY + scroll.contentHeight - scroll.height))
    })
    Connections { target:App;function onResult(id,value){if(id!==chat.sendRequest)return;chat.sendRequest=-1;if(chat.pendingSession===App.selectedId&&!value?.error){if(composer.text===chat.pendingText)composer.text="";if(JSON.stringify(chat.attachmentIds())===chat.pendingAttachments)chat.attachments=[];chat.draftRevision=App.session.draftRevision||"0";chat.draftBaseline=App.session.draft||"";chat.attachmentBaseline=JSON.stringify((App.session.draftAttachments||[]).map(a=>a.id));chat.draftConflict=false;searchThisTurn.checked=false}} }
    Connections { target:App;function onAttachmentRequested(path){chat.importAttachment(path)} }
    Connections { target:App;function onResult(id,value){if(!(id in chat.attachmentRequests))return;const owner=chat.attachmentRequests[id],next=Object.assign({},chat.attachmentRequests);delete next[id];chat.attachmentRequests=next;if(owner!==App.selectedId){if(!value?.error){App.rpc("attachments.keepInDraft",{sessionId:owner,attachmentId:value.id});App.notify("Attachment saved in its original conversation’s draft.")}return}if(value?.error)chat.attachmentError=String(value.error.message||value.error);else {if(!chat.attachments.some(a=>a.id===value.id))chat.attachments=chat.attachments.concat([value]);chat.draftRevision=App.session.draftRevision||"0";chat.attachmentBaseline=JSON.stringify((App.session.draftAttachments||[]).map(a=>a.id));if((App.session.draft||"")!==chat.draftBaseline)chat.draftConflict=true;else chat.saveDraft()}} }
    ContextDrawer { id:contextDrawer;sessionId:App.selectedId;draftText:composer.text;attachmentIds:chat.attachmentIds() }
    Connections { target:App;function onResult(id,value){if(id===chat.recoveryRequest){chat.recoveryRequest=-1;if(chat.recoveryOwner===App.selectedId&&!value?.error)chat.recoverable=value||{}}else if(id===chat.recoveryRestoreRequest){chat.recoveryRestoreRequest=-1;if(value?.error)App.notify(String(value.error.message||value.error));else if(chat.restoreOwner===App.selectedId)chat.loadDraft()}} }
    CDialog {
        id:submissionRecovery
        CText { text:"Recover the last submission";font.pixelSize:Theme.title }
        CText { text:"The provider’s acceptance was not confirmed. Restoring this text and its attachments replaces your current draft and sends nothing. Check the transcript before sending again.";color:Theme.amber }
        CText { text:chat.recoverable.text||"";wrapMode:Text.Wrap }
        CText { text:(chat.recoverable.attachmentIds||[]).length+" retained attachments";color:Theme.muted }
        CButton { text:"Replace draft with this submission";enabled:!chat.busy;onClicked:{draftTimer.stop();chat.restoreOwner=App.selectedId;chat.recoveryRestoreRequest=App.rpc("session.recoverDraft",{id:App.selectedId,expectedRevision:chat.draftRevision});submissionRecovery.close()} }
        CButton { text:"Discard this recovery copy";onClicked:{App.rpc("session.dismissRecovery",{id:App.selectedId});chat.recoverable={};submissionRecovery.close()} }
        CButton { text:"Close";onClicked:submissionRecovery.close() }
    }
    CDialog {
        id:imagePreview;property string imagePath
        CText { text:"Share this image with "+(App.session.provider||"the provider")+"?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        Image { id:previewImage;Layout.fillWidth:true;Layout.preferredHeight:Math.min(240,chat.height*.5);fillMode:Image.PreserveAspectFit }
        RowLayout { Layout.fillWidth:true;CButton{Layout.fillWidth:true;text:"Cancel";onClicked:imagePreview.close()}CButton{Layout.fillWidth:true;text:"Attach image";primary:true;onClicked:{chat.importAttachment(imagePreview.imagePath);imagePreview.close()}} }
    }
    CDialog {
        id:renameDialog
        property int requestId:-1
        property string sessionId:""
        property string error:""
        onOpened:{sessionId=App.selectedId;renameTitle.text=App.session.title||"";error="";renameTitle.forceActiveFocus();renameTitle.selectAll()}
        CText { text:"Rename session";font.pixelSize:Theme.page;font.weight:Font.DemiBold }
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
    SessionModelDialog { id:modelOptions }
    CDialog {
        id:handoffDialog;objectName:"handoffDialog"
        property string error:""
        property var targets:[{id:"codex",displayName:"Codex"},{id:"claude",displayName:"Claude"},{id:"ollama",displayName:"Ollama"},{id:"antigravity",displayName:"AntiGravity"},{id:"openai",displayName:"OpenAI API"},{id:"anthropic",displayName:"Claude API"},{id:"google",displayName:"Google AI API"}].filter(p=>p.id!==App.session.provider)
        onOpened: {error="";handoffTrust.checked=false;handoffProvider.currentIndex=0;handoffText.text="Continue this work in "+(App.session.cwd||"")+".\n\n"+App.messages.filter(m=>m.role!=="tool").slice(-8).map(m=>m.role+": "+m.text).join("\n\n");if(handoffProvider.currentValue)App.rpc("provider.models",{provider:handoffProvider.currentValue})}
        CText { text:"Review context before sharing";font.pixelSize:Theme.title;font.bold:true }
        CText { text:"Choose a provider for the new conversation. Nothing is sent until you submit its draft.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox { id:handoffProvider;objectName:"handoffProvider";Layout.fillWidth:true;model:handoffDialog.targets;textRole:"displayName";valueRole:"id";Accessible.name:"Handoff provider";onActivated:if(currentValue)App.rpc("provider.models",{provider:currentValue}) }
        CComboBox { id:handoffModel;visible:["ollama","openai","anthropic","google"].includes(handoffProvider.currentValue);Layout.fillWidth:true;model:(App.state.capabilities||{})[handoffProvider.currentValue]?.models||[];textRole:"displayName";valueRole:"id";Accessible.name:"Handoff model";currentIndex:Math.max(0,model.findIndex(m=>m.id===App.state.settings?.ollama?.model)) }
        CCheckBox { id:handoffTrust;objectName:"handoffTrust";visible:!App.state.settings?.bypassCliPermissions&&["codex","claude","antigravity"].includes(handoffProvider.currentValue);text:"I trust this project’s CLI configuration and hooks" }
        CText { visible:!!handoffDialog.error;text:handoffDialog.error;color:Theme.danger;font.pixelSize:Theme.secondary }
        ScrollView {
            Layout.fillWidth:true;Layout.preferredHeight:Math.min(240,chat.height*.5);clip:true;contentWidth:availableWidth
            ScrollBar.horizontal.policy:ScrollBar.AlwaysOff
            ScrollBar.vertical:CScrollBar{}
            CTextArea{id:handoffText;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.body;wrapMode:TextEdit.Wrap;selectByMouse:true}
        }
        CButton { objectName:"handoffCreate";Layout.fillWidth:true;text:"Create handoff draft";primary:true;enabled:App.connected&&chat.handoffRequest<0&&(!handoffTrust.visible||handoffTrust.checked)&&(!handoffModel.visible||!!handoffModel.currentValue);onClicked:{chat.handoff=handoffText.text;chat.handoffRequest=App.rpc("session.create",{provider:handoffProvider.currentValue,model:handoffModel.visible?handoffModel.currentValue:"",cwd:App.session.cwd,temporary:App.session.temporary===true,trusted:!handoffTrust.visible||handoffTrust.checked,title:"Handoff · "+App.session.title})} }
    }
    property int handoffRequest:-1
    Connections{target:App;function onResult(id,value){if(id===chat.handoffRequest){chat.handoffRequest=-1;if(value.error)handoffDialog.error=value.error;else{handoffDialog.close();composer.text=chat.handoff;App.rpc("session.draft",{id:value.id,text:chat.handoff})}}}}
    MemoryReview { id:memoryReview;sessionId:App.selectedId }
    BranchDialog { id:branch }
    CompletionInbox { id:inbox }
    Connections { target:App;function onResult(id,value){if(id!==chat.proposalRequest)return;chat.proposalRequest=-1;if(value?.error)App.notify(String(value.error.message||value.error));else memoryReview.open()} }
}
