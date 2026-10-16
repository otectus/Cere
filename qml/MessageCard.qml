import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: card
    property var message
    signal quoteRequested(string text)
    signal proposalRequested(string kind)
    signal taskProposed(string text)
    signal branchRequested(string text)
    signal exportRequested()
    // Only the conversation view handles saving a message.
    property bool canExport:false
    property string directory: App.session.cwd || ""
    // Cere's no-progress notice from its own tool loop (broker/tool-progress.ts): a warning, never an action.
    readonly property bool noProgress: message.role==="tool"&&String(message.text||"").startsWith("No progress detected\n")
    property bool collapsed: message.role==="tool"&&!noProgress
    // The stored reply keeps its memory citations; while they are hidden this card leaves them out of
    // what it shows, copies, quotes, speaks and branches. Tool output stays as it was produced.
    readonly property bool hidesCitations: message.role!=="tool"&&!App.showMemoryCitations
    readonly property string displayText: hidesCitations?App.displayText(message.text,false):message.text
    // A hidden host (the other Cere window) skips document formatting while a reply streams and
    // formats once when it is shown again.
    readonly property bool hostVisible: Window.window ? Window.window.visible : true
    onHostVisibleChanged: if(hostVisible)Qt.callLater(body.formatDocument)
    Connections {
        target: App
        function onThemeChanged() { Qt.callLater(body.formatDocument) }
    }
    color: message.role==="user" ? Theme.userBubble : message.role==="tool" ? Theme.input : Theme.surface
    radius: Theme.radius
    border.color: noProgress ? Theme.amber : message.role==="user" ? Theme.userBubbleBorder : Theme.subtle
    implicitHeight: contents.implicitHeight+32
    ColumnLayout {
        id:contents;anchors.fill:parent;anchors.margins:16;spacing:12
        RowLayout {
            Text { objectName:"messageAuthor";text:card.message.role==="user" ? "You" : card.noProgress ? "No progress detected" : card.message.role==="tool" ? "Tool activity" : App.assistantName;elide:Text.ElideRight;textFormat:Text.PlainText;color:card.message.role==="user"?Theme.muted:Theme.accentText;font.family:Theme.font;font.pixelSize:Theme.secondary;font.weight:Font.DemiBold;Layout.fillWidth:true }
            CButton{objectName:"noProgressStop";visible:card.noProgress&&card.message.sessionId===App.selectedId&&["starting","working","waiting"].indexOf(App.session.status)>=0;danger:true;text:"Stop";implicitHeight:28;help:"Stop this turn";enabled:App.connected;onClicked:App.rpc("session.stop",{id:card.message.sessionId})}
            CButton{visible:card.message.role==="tool";quiet:true;text:card.collapsed?"Show":"Hide";implicitHeight:28;onClicked:card.collapsed=!card.collapsed}
            // A display copy shortened for transport copies the complete stored text instead.
            CButton{objectName:"copyMessage_"+card.message.id;text:"Copy";quiet:true;implicitHeight:28;help:"Copy message";onClicked:card.message.truncated?App.copySessionMessage(card.message.sessionId,card.message.id,card.hidesCitations):App.copy(card.displayText)}
            CButton{objectName:"messageActions_"+card.message.id;text:"⋯";quiet:true;implicitHeight:28;Accessible.name:"Message actions";onClicked:messageMenu.popup()}
        }
        Text { visible:card.collapsed;text:card.displayText.split("\n")[0];color:Theme.muted;Layout.fillWidth:true;elide:Text.ElideRight;font.pixelSize:Theme.secondary }
        Flickable {
            id:messageViewport;objectName:"messageViewport_"+card.message.id
            visible:!card.collapsed
            Layout.fillWidth:true;Layout.minimumWidth:0
            implicitHeight:body.implicitHeight+(contentWidth>width?12:0)
            contentWidth:Math.max(width,body.contentWidth);contentHeight:height
            flickableDirection:Flickable.HorizontalFlick;clip:true
            onWidthChanged:body.overflowWidth=0
            ScrollBar.horizontal:CScrollBar {}
            TextArea {
                id:body;objectName:"messageBody_"+card.message.id
                property bool formatting:false
                property real overflowWidth:0
                function expandForOverflow(){if(contentWidth>width+1)overflowWidth=Math.ceil(contentWidth)}
                // Prose is formatted to the visible width; only code and tables reach past it.
                function formatDocument(){
                    // A deferred call can run after its window (and App) is gone.
                    if(formatting||card.message.role==="tool"||typeof App==="undefined"||!card.hostVisible)return
                    formatting=true;App.formatMessage(textDocument,messageViewport.width);formatting=false
                }
                onTextChanged:{if(!formatting)overflowWidth=0;formatDocument()}
                onWidthChanged:Qt.callLater(formatDocument)
                onContentWidthChanged:Qt.callLater(expandForOverflow)
                Component.onCompleted:formatDocument()
                // The item must cover the table so Qt paints columns reached by scrolling.
                width:Math.max(messageViewport.width,overflowWidth)
                text:card.displayText
                // Long URLs and paths break where they must instead of widening the message. Table
                // columns still keep their longest word, so a table too wide for the view scrolls.
                readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap
                textFormat:card.message.role==="tool"?TextEdit.PlainText:TextEdit.MarkdownText
                color:Theme.text;selectionColor:Theme.selected;selectedTextColor:Theme.text
                font.pixelSize:Theme.message;font.family:card.message.role==="tool"?"monospace":Theme.font
                padding:0;background:null
                palette.link:Theme.accentText
                baseUrl:"file://"+card.directory+"/"
                onLinkActivated:link=>App.openMessageLink(link,card.directory)
                ToolTip.visible:hoveredLink.length>0
                ToolTip.text:hoveredLink
            }
        }
        Repeater {
            model:card.collapsed?[]:(card.message.sources||[])
            CButton { required property var modelData;Layout.fillWidth:true;text:"↗ "+modelData.title;help:modelData.url;Accessible.description:modelData.url;onClicked:if(/^https?:\/\//.test(modelData.url))Qt.openUrlExternally(modelData.url) }
        }
        // M02: a formatting check the reply missed. The reply's text is never changed.
        Text {
            objectName:"styleNotes";visible:!card.collapsed&&(card.message.styleNotes||[]).length>0;Layout.fillWidth:true
            text:"Formatting check missed: "+(card.message.styleNotes||[]).map(note=>note.label+(note.count>1?" ("+note.count+")":"")).join(" · ")+". The reply is shown as written."
            wrapMode:Text.Wrap;textFormat:Text.PlainText;color:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption
        }
    }
    CMenu {
        id:messageMenu
        CMenuItem { objectName:"quoteMessage";text:body.selectedText?"Quote selection":"Quote reply";onTriggered:card.quoteRequested(body.selectedText||card.displayText) }
        CMenuItem { text:(App.state.bookmarks||[]).some(b=>b.messageId===card.message.id)?"Remove bookmark":"Bookmark";onTriggered:App.rpc("message.bookmark",{sessionId:card.message.sessionId,messageId:card.message.id,bookmarked:!(App.state.bookmarks||[]).some(b=>b.messageId===card.message.id)}) }
        CMenuItem { text:body.selectedText?"Speak selection":"Speak message";onTriggered:App.rpc("tts.speak",{text:(body.selectedText||card.displayText).slice(0,20000)}) }
        CMenuItem { text:"Propose project decision";onTriggered:{card.proposalRequested("decision")} }
        CMenuItem { text:"Propose project constraint";onTriggered:{card.proposalRequested("constraint")} }
        CMenuItem { objectName:"proposeTask";text:body.selectedText?"Propose selection as a next step":"Propose as a next step";onTriggered:card.taskProposed(body.selectedText) }
        CMenuItem { text:"Branch with reviewed context";onTriggered:card.branchRequested(body.selectedText||card.displayText) }
        CMenuItem { objectName:"saveMessageAs";text:"Save message as…";visible:card.canExport&&card.message.role!=="tool";onTriggered:card.exportRequested() }
        CMenuItem { text:"Stop speaking";onTriggered:App.rpc("tts.stop",{}) }
    }

}
