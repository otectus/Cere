import QtQuick
import QtQuick.Layouts
CDialog {
    id:inbox
    CText { text:"Completion inbox";font.pixelSize:22 }
    CText { text:"Provider completion records are distinct from verified results. Open Workflows → Results for observed checks and artifacts.";color:Theme.muted;wrapMode:Text.Wrap }
    CText { visible:!(App.state.completions||[]).length;text:"All caught up.";color:Theme.muted }
    Repeater {
        model:(App.state.completions||[]).slice().reverse()
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true
            CText { text:modelData.title+" · "+modelData.provider+" · "+new Date(modelData.time).toLocaleString();wrapMode:Text.Wrap }
            CText { text:modelData.message.text.slice(0,350);wrapMode:Text.Wrap;font.pixelSize:12 }
            RowLayout {
                CButton { text:"Open conversation";onClicked:{App.openCompletion(modelData.id);inbox.close()} }
                CButton { text:"Mark read";onClicked:App.rpc("completion.dismiss",{id:modelData.id}) }
            }
        }
    }
    CButton { text:"Close";onClicked:inbox.close() }
}
