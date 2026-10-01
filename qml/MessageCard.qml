import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: card
    property var message
    signal quoteRequested(string text)
    signal proposalRequested(string kind)
    signal branchRequested(string text)
    property string directory: App.session.cwd || ""
    property bool collapsed: message.role==="tool"
    color: message.role==="user" ? "#112638" : message.role==="tool" ? Theme.input : Theme.surface
    radius: Theme.radius
    border.color: message.role==="user" ? "#203e54" : Theme.subtle
    implicitHeight: contents.implicitHeight+32
    ColumnLayout {
        id:contents;anchors.fill:parent;anchors.margins:16;spacing:12
        RowLayout {
            Text { text:card.message.role==="user" ? "You" : card.message.role==="tool" ? "Tool activity" : "Cere";color:card.message.role==="user"?Theme.muted:Theme.cyan;font.family:Theme.font;font.pixelSize:12;font.weight:Font.DemiBold;Layout.fillWidth:true }
            CButton{visible:card.message.role==="tool";quiet:true;text:card.collapsed?"Show":"Hide";implicitHeight:28;onClicked:card.collapsed=!card.collapsed}
            // A display copy shortened for transport copies the complete stored text instead.
            CButton{objectName:"copyMessage_"+card.message.id;text:"Copy";quiet:true;implicitHeight:28;help:"Copy message";onClicked:card.message.truncated?App.copySessionMessage(card.message.sessionId,card.message.id):App.copy(card.message.text)}
            CButton{objectName:"messageActions_"+card.message.id;text:"⋯";quiet:true;implicitHeight:28;Accessible.name:"Message actions";onClicked:messageMenu.popup()}
        }
        Text { visible:card.collapsed;text:card.message.text.split("\n")[0];color:Theme.muted;Layout.fillWidth:true;elide:Text.ElideRight;font.pixelSize:12 }
        Flickable {
            id:messageViewport;objectName:"messageViewport_"+card.message.id
            visible:!card.collapsed
            Layout.fillWidth:true;Layout.minimumWidth:0
            implicitHeight:body.implicitHeight+(contentWidth>width?12:0)
            contentWidth:Math.max(width,body.contentWidth);contentHeight:height
            flickableDirection:Flickable.HorizontalFlick;clip:true
            onWidthChanged:body.overflowWidth=0
            ScrollBar.horizontal:ScrollBar { policy:ScrollBar.AsNeeded }
            TextArea {
                id:body;objectName:"messageBody_"+card.message.id
                property bool formatting:false
                property real overflowWidth:0
                function expandForOverflow(){if(contentWidth>width+1)overflowWidth=Math.ceil(contentWidth)}
                function formatDocument(){
                    if(formatting||card.message.role==="tool")return
                    formatting=true;App.formatMessage(textDocument);formatting=false
                }
                onTextChanged:{if(!formatting)overflowWidth=0;formatDocument()}
                onContentWidthChanged:Qt.callLater(expandForOverflow)
                Component.onCompleted:formatDocument()
                // The item must cover the table so Qt paints columns reached by scrolling.
                width:Math.max(messageViewport.width,overflowWidth)
                text:card.message.text
                // Keep Markdown tables readable; Wrap can crush columns down to single letters.
                readOnly:true;selectByMouse:true;wrapMode:card.message.role==="tool"?TextEdit.Wrap:TextEdit.WordWrap
                textFormat:card.message.role==="tool"?TextEdit.PlainText:TextEdit.MarkdownText
                color:Theme.text;selectionColor:Theme.selected;selectedTextColor:Theme.text
                font.pixelSize:14;font.family:card.message.role==="tool"?"monospace":Theme.font
                padding:0;background:null
                palette.link:Theme.cyan
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
    }
    Menu {
        id:messageMenu
        MenuItem { text:body.selectedText?"Quote selection":"Quote reply";onTriggered:card.quoteRequested(body.selectedText||card.message.text) }
        MenuItem { text:(App.state.bookmarks||[]).some(b=>b.messageId===card.message.id)?"Remove bookmark":"Bookmark";onTriggered:App.rpc("message.bookmark",{sessionId:card.message.sessionId,messageId:card.message.id,bookmarked:!(App.state.bookmarks||[]).some(b=>b.messageId===card.message.id)}) }
        MenuItem { text:body.selectedText?"Speak selection":"Speak message";onTriggered:App.rpc("tts.speak",{text:(body.selectedText||card.message.text).slice(0,20000)}) }
        MenuItem { text:"Propose project decision";onTriggered:{card.proposalRequested("decision")} }
        MenuItem { text:"Propose project constraint";onTriggered:{card.proposalRequested("constraint")} }
        MenuItem { text:"Branch with reviewed context";onTriggered:card.branchRequested(body.selectedText||card.message.text) }
        MenuItem { text:"Stop speaking";onTriggered:App.rpc("tts.stop",{}) }
    }

}
