import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Shapes
ColumnLayout {
    id: chat
    signal createRequested()
    signal backRequested()
    property bool showBackButton: false
    function focusComposer() { if(composer.enabled)composer.forceActiveFocus() }
    property bool busy: ["starting","working","waiting","stopping"].indexOf(App.session.status)>=0
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
    spacing: 10
    onSessionIdChanged: { if(draftSession&&draftTimer.running)App.rpc("session.draft",{id:draftSession,text:composer.text,scroll:scroll.contentY});draftTimer.stop();draftSession=sessionId;composer.text=App.session.draft || "";attachments=[];activityPanel.expanded=false;chat.follow=true;Qt.callLater(()=>{scroll.contentY=App.session.scroll||0}) }
    Component.onDestruction: { App.setListening(false); if(draftSession&&App.connected)App.rpc("session.draft",{id:draftSession,text:composer.text,scroll:scroll.contentY}) }
    RowLayout {
        Layout.fillWidth: true
        CButton { objectName:"backToSessions";visible:chat.showBackButton;text:"‹";help:"Back to sessions";Accessible.name:"Back to sessions";onClicked:chat.backRequested() }
        ColumnLayout {
            Layout.fillWidth:true;Layout.minimumWidth:0;spacing:3
            Text { text:App.session.title||"A little help, a little company.";Layout.fillWidth:true;Layout.minimumWidth:0;color:Theme.text;font.bold:true;font.pixelSize:15;elide:Text.ElideRight;textFormat:Text.PlainText }
            Text { text:App.session.id?App.session.provider.toUpperCase()+(App.session.model?" · "+App.session.model:"")+(App.session.provider==="ollama"?(App.session.ollama?.tools?" · Assistant":" · Conversation"):"")+"  /  "+App.session.cwd:"Choose a project. I’ll meet you there.";Layout.fillWidth:true;Layout.minimumWidth:0;color:Theme.muted;font.pixelSize:11;elide:Text.ElideMiddle;textFormat:Text.PlainText }
        }
        CButton { objectName:"ollamaModelOptions";visible:App.session.provider==="ollama";text:"Model";enabled:!chat.busy&&App.connected;onClicked:ollamaOptions.open() }
        CButton { objectName:"chatHandoff";visible: !!App.session.id; text: "Handoff"; onClicked: handoffDialog.open() }
        CButton { visible: chat.linked; text: "Open terminal"; onClicked: App.rpc("session.terminal",{id:App.selectedId}) }
    }
    Rectangle {
        visible: !!App.session.error; Layout.fillWidth: true; implicitHeight: errorText.implicitHeight+18; radius: 7; color: "#382630"
        Text { id:errorText; anchors.fill:parent;anchors.margins:9;text:App.session.error || "";color:Theme.danger;wrapMode:Text.Wrap;font.pixelSize:12 }
    }
    Item {
        id:conversationArea;Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumHeight:24;clip:true
        ColumnLayout {
            visible:!App.session.id;anchors.centerIn:parent;width:Math.min(parent.width,340);spacing:12
            CereSprite { visible:conversationArea.height>=270;Layout.alignment:Qt.AlignHCenter;Layout.preferredHeight:Math.min(156,conversationArea.height*.4);Layout.preferredWidth:144;fillMode:Image.PreserveAspectFit }
            CText { text:"Let’s make something.";font.pixelSize:21;font.bold:true;horizontalAlignment:Text.AlignHCenter }
            CText { visible:conversationArea.height>=170;text:"Codex, Claude and Ollama, right here.\nYour tools. Your projects. My company.";color:Theme.muted;horizontalAlignment:Text.AlignHCenter }
            CButton { text: "Start a conversation"; primary: true; Layout.alignment: Qt.AlignHCenter; onClicked: chat.createRequested() }
        }
        ListView {
            id: scroll; visible: !!App.session.id; anchors.fill: parent; clip: true
            spacing:14;cacheBuffer:300;reuseItems:true
            ScrollBar.vertical: CScrollBar {}
            model: App.transcript
            delegate: MessageCard { required property var entry; width:scroll.width-12; message:entry }
            footer:Column {
                width:scroll.width;spacing:8
                Text { visible: chat.busy; text: App.session.status==="waiting" ? "Waiting for your input…" : "Working on it…"; color: Theme.cyan; font.pixelSize: 12 }
                Text { visible: !App.messages.length && !!App.session.id; text: chat.linked ? "Linked terminal · lifecycle observation only. Continue this conversation in its terminal. Once it ends, use CLI history to hand it to Cere." : App.session.nativeId ? "This session will continue its CLI context when you send a message." : "Ready when you are."; width: parent.width; wrapMode: Text.Wrap; color: Theme.muted; font.pixelSize: 13 }
            }
            onMovementStarted:chat.follow=false
            onMovementEnded:if(atYEnd)chat.follow=true
        }
        CButton { visible: !chat.follow && !!App.session.id; anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; text: "↓ Latest messages"; primary: true; onClicked: {chat.follow=true;scroll.positionViewAtEnd()} }
    }
    ActivityPanel {
        id:activityPanel;visible:!!App.session.id;Layout.fillWidth:true
        Layout.preferredHeight:implicitHeight
        maximumHeight:Math.max(32,Math.min(260,chat.height-250))
    }
    Text { visible: attachments.length>0; text: "Attached: "+attachments.map(p=>p.split("/").pop()).join(", "); color: Theme.cyan; font.pixelSize: 11; Layout.fillWidth: true; elide: Text.ElideMiddle }
    Rectangle {
        visible: !!App.session.id
        Layout.fillWidth:true;implicitHeight:Math.min(Math.max(72,chat.height*.28),Math.max(72,composer.contentHeight+24));radius:9;color:Theme.input;border.color:composer.activeFocus?Theme.cyan:Theme.line
        ScrollView {
            id:composerViewport;anchors.fill:parent;anchors.margins:10;clip:true
            contentWidth:availableWidth;ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
            TextArea {
                id: composer; objectName:"composer"; enabled: !!App.session.id && !chat.linked; placeholderText: chat.linked ? "Continue in the linked terminal" : App.session.id ? "Tell me what you have in mind…" : "Start a session to send a message"
                color: Theme.text; placeholderTextColor: Theme.muted; selectionColor: "#396982"; font.pixelSize: 13; font.family: Theme.font
                wrapMode: TextEdit.Wrap; selectByMouse: true; background: null
                onTextChanged: { if(App.session.id)draftTimer.restart() }
                Keys.onPressed: event => {if((event.key===Qt.Key_Return||event.key===Qt.Key_Enter)&&(event.modifiers&Qt.ControlModifier)){chat.send();event.accepted=true}}
            }
        }
    }
    RowLayout {
        Layout.fillWidth:true;spacing:6
        visible: !!App.session.id
        CButton { text:chat.width>=480?"+ Image":"+";help:"Attach an image";Accessible.name:"Attach an image";enabled:!!App.session.id&&attachments.length<4;onClicked:{const p=App.chooseImage();if(p){previewImage.source="file://"+p;imagePreview.imagePath=p;imagePreview.open()}} }
        CButton { visible:attachments.length>0;text:chat.width>=480?"Clear":"×";help:"Clear image attachments";onClicked:attachments=[] }
        CCheckBox { id:searchThisTurn;objectName:"searchThisTurn";visible:App.session.provider==="ollama"&&App.state.settings?.webSearch?.enabled===true;text:chat.width>=480?"Search web":"Web";enabled:!chat.busy&&!App.state.settings?.paused;Accessible.name:"Search web for this message";Accessible.description:"Search uses the next message as a public query, up to 500 characters";ToolTip.visible:hovered;ToolTip.text:Accessible.description }
        Item { Layout.fillWidth:true;Layout.minimumWidth:0 }
        Text { visible:chat.width>=480;text:"Ctrl + Enter";color:Theme.muted;font.pixelSize:10 }
        CButton { objectName:"stopMessage";visible:chat.busy;text:"■";implicitWidth:implicitHeight;leftPadding:6;rightPadding:6;font.pixelSize:20;help:"Stop";Accessible.name:"Stop";danger:true;onClicked:App.rpc("session.stop",{id:App.selectedId}) }
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
                        strokeColor:sendButton.enabled?Theme.cyan:"#64788a"
                        strokeWidth:1.5;fillColor:"transparent"
                        capStyle:ShapePath.RoundCap;joinStyle:ShapePath.RoundJoin
                        PathSvg { path:"M18 2 L12 18 L9 11 L2 8 Z M9 11 L18 2" }
                    }
                }
            }
        }
    }
    function send(){if(!App.session.id||busy||linked||!composer.text.trim())return;draftTimer.stop();pendingText=composer.text;pendingSession=App.selectedId;sendRequest=App.rpc("session.send",{id:App.selectedId,text:composer.text,images:attachments,webSearch:searchThisTurn.visible&&searchThisTurn.checked});follow=true}
    Timer { id:draftTimer;interval:600;onTriggered:if(App.selectedId)App.rpc("session.draft",{id:App.selectedId,text:composer.text,scroll:scroll.contentY}) }
    Connections { target:App;function onMessagesChanged(){if(chat.follow)Qt.callLater(()=>{scroll.positionViewAtEnd()})} }
    Connections { target:App;function onResult(id,value){if(id===chat.sendRequest&&chat.pendingSession===App.selectedId&&!value?.error){if(composer.text===chat.pendingText)composer.text="";chat.attachments=[];searchThisTurn.checked=false}} }
    Connections { target:App;function onAttachmentRequested(path){chat.attachments=chat.attachments.concat([path])} }
    CDialog {
        id:imagePreview;property string imagePath
        CText { text:"Share this image with "+(App.session.provider||"the provider")+"?";font.pixelSize:18;font.weight:Font.DemiBold }
        Image { id:previewImage;Layout.fillWidth:true;Layout.preferredHeight:Math.min(240,chat.height*.5);fillMode:Image.PreserveAspectFit }
        RowLayout { Layout.fillWidth:true;CButton{Layout.fillWidth:true;text:"Cancel";onClicked:imagePreview.close()}CButton{Layout.fillWidth:true;text:"Attach image";primary:true;onClicked:{chat.attachments=chat.attachments.concat([imagePreview.imagePath]);imagePreview.close()}} }
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
