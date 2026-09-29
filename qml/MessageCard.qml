import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: card
    property var message
    property bool collapsed: message.role==="tool"
    color: message.role==="user" ? "#1b303e" : message.role==="tool" ? "#161e28" : Theme.surface
    radius: 9
    border.color: message.role==="user" ? "#315064" : "#293948"
    implicitHeight: contents.implicitHeight+22
    ColumnLayout {
        id:contents;anchors.fill:parent;anchors.margins:11;spacing:8
        RowLayout {
            Text { text:card.message.role==="user" ? "YOU" : card.message.role==="tool" ? "TOOL ACTIVITY" : "REPLY";color:card.message.role==="user"?Theme.muted:Theme.cyan;font.pixelSize:10;font.letterSpacing:1.4;Layout.fillWidth:true }
            CButton{visible:card.message.role==="tool";text:card.collapsed?"Show":"Hide";implicitHeight:26;onClicked:card.collapsed=!card.collapsed}
            CButton{objectName:"copyMessage_"+card.message.id;text:"Copy";implicitHeight:26;onClicked:App.copy(card.message.text)}
        }
        Text { visible:card.collapsed;text:card.message.text.split("\n")[0];color:Theme.muted;Layout.fillWidth:true;elide:Text.ElideRight;font.pixelSize:12 }
        Flickable {
            id:messageViewport;objectName:"messageViewport_"+card.message.id
            visible:!card.collapsed
            Layout.fillWidth:true;Layout.minimumWidth:0
            implicitHeight:body.implicitHeight+(contentWidth>width?12:0)
            contentWidth:Math.max(width,body.contentWidth);contentHeight:height
            flickableDirection:Flickable.HorizontalFlick;clip:true
            ScrollBar.horizontal:ScrollBar { policy:ScrollBar.AsNeeded }
            TextArea {
                id:body;objectName:"messageBody_"+card.message.id
                property bool formatting:false
                function formatDocument(){
                    if(formatting||card.message.role==="tool")return
                    formatting=true;App.formatMessage(textDocument);formatting=false
                }
                onTextChanged:formatDocument()
                Component.onCompleted:formatDocument()
                width:messageViewport.width
                text:card.message.text
                readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap
                textFormat:card.message.role==="tool"?TextEdit.PlainText:TextEdit.MarkdownText
                color:Theme.text;selectionColor:"#396982";selectedTextColor:"white"
                font.pixelSize:13;font.family:card.message.role==="tool"?"monospace":Theme.font
                padding:0;background:null
                palette.link:Theme.cyan
                baseUrl:"file://"+(App.session.cwd||"")+"/"
                onLinkActivated:link=>App.openMessageLink(link,App.session.cwd||"")
                ToolTip.visible:hoveredLink.length>0
                ToolTip.text:hoveredLink
            }
        }
        Repeater {
            model:card.collapsed?[]:(card.message.sources||[])
            CButton { required property var modelData;Layout.fillWidth:true;text:"↗ "+modelData.title;help:modelData.url;Accessible.description:modelData.url;onClicked:if(/^https?:\/\//.test(modelData.url))Qt.openUrlExternally(modelData.url) }
        }
    }
}
