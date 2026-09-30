import QtQuick
import QtQuick.Layouts

ColumnLayout {
    id: card
    property var completion: ({})
    spacing: 10
    CText {
        objectName: "completionRequester"
        Layout.fillWidth: true
        text: (card.completion.title || "Conversation") + " · " + (card.completion.provider || "")
              + " · " + (card.completion.sessionId || "").slice(0, 8) + "\n" + (card.completion.cwd || "")
        color: Theme.muted; font.pixelSize: 11
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
