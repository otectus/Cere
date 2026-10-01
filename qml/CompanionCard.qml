import QtQuick
import QtQuick.Layouts

ColumnLayout {
    id:card
    property var reply:({})
    spacing:10
    CText {
        objectName:"companionRequester"
        Layout.fillWidth:true
        text:card.reply.title||"Pinned conversation"
        textFormat:Text.PlainText
        color:Theme.muted;font.pixelSize:Theme.secondary
    }
    RowLayout {
        Layout.fillWidth:true
        CButton {
            objectName:"companionOpen";Layout.fillWidth:true
            text:"Open conversation";primary:true
            onClicked:App.openCompanionReply(card.reply.id)
        }
        CButton {
            objectName:"companionDismiss";text:"Dismiss"
            onClicked:App.rpc("companion.dismiss",{id:card.reply.id})
        }
    }
    CButton {
        objectName:"companionStopSpeaking";Layout.fillWidth:true
        visible:["preparing","speaking"].indexOf(App.state.speech?.state)>=0||(App.state.speech?.queued||0)>0
        text:"Stop speaking";onClicked:App.rpc("tts.stop",{})
    }
    MessageCard {
        Layout.fillWidth:true
        message:card.reply.message||({id:"",role:"assistant",text:""})
        directory:card.reply.cwd||""
    }
}
