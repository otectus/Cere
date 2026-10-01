import QtQuick
import QtQuick.Layouts

ColumnLayout {
    id: card
    property var completion: ({})
    spacing: 10
    SessionIdentity {
        objectName: "completionRequester"
        Layout.fillWidth: true
        provider: card.completion.provider || ""
        sessionId: card.completion.sessionId || ""
        title: card.completion.title || "Conversation"
        cwd: card.completion.cwd || ""
    }
    RowLayout {
        Layout.fillWidth: true
        CButton {
            objectName: "completionOpen"; Layout.fillWidth: true
            text: "Open conversation"; primary: true
            onClicked: App.openCompletion(card.completion.id)
        }
        CButton {
            objectName: "completionDismiss"; text: "Dismiss"
            onClicked: App.rpc("completion.dismiss", {id:card.completion.id})
        }
    }
    MessageCard {
        Layout.fillWidth: true
        message: card.completion.message || ({id:"",role:"assistant",text:""})
        directory: card.completion.cwd || ""
    }
}
