import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CButton {
    id:voiceInput
    objectName:"voiceRecord"
    property string sessionId:""
    onSessionIdChanged:error=""
    property bool available:true
    property var transcription:App.state.transcription||({state:"unavailable",sessionId:"",error:""})
    property int requestId:-1
    property string request:""
    property string error:""
    property string resultSessionId:""
    readonly property bool ownsRecording:transcription.sessionId===sessionId
    readonly property bool recording:transcription.state==="recording"&&ownsRecording
    readonly property bool transcribing:transcription.state==="transcribing"&&ownsRecording
    readonly property string statusText:error||(recording?"Listening… Click the microphone to finish.":transcribing?"Transcribing… Click to cancel.":transcription.state==="error"&&ownsRecording?transcription.error:"")
    signal transcriptionAccepted(string text)
    implicitWidth:40;implicitHeight:40;Layout.preferredWidth:40;Layout.preferredHeight:40
    leftPadding:10;rightPadding:10;quiet:true;primary:recording;danger:transcribing
    Accessible.name:recording?"Finish voice input":transcribing?"Cancel transcription":"Voice input"
    help:transcription.state==="unavailable"?"Set up local voice input in Settings → Voice":recording?"Finish recording":transcribing?"Cancel transcription":"Record a voice message"
    enabled:available&&App.connected&&!!sessionId&&(requestId<0||transcribing)&&((transcription.state!=="recording"&&transcription.state!=="transcribing")||ownsRecording)
    contentItem:CIcon { name:voiceInput.recording?"stop":voiceInput.transcribing?"close":"microphone";color:!voiceInput.enabled?Theme.muted:voiceInput.recording?Theme.cyan:Theme.text }
    function call(method,params){
        if(requestId>=0&&method!=="transcription.cancel")return
        error="";request=method;requestId=App.rpc(method,params||{})
    }
    function cancel(){call("transcription.cancel",{})}
    onClicked:{
        if(transcribing)cancel()
        else if(recording)call("transcription.finish",{})
        else call("transcription.start",{sessionId:sessionId})
    }

    CDialog {
        id:review;objectName:"transcriptionReview"
        CText { text:"Review voice input";font.pixelSize:20;font.weight:Font.DemiBold }
        CText { text:"Edit the local transcript before inserting it. Nothing is sent automatically.";color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap }
        CText { visible:voiceInput.resultSessionId!==voiceInput.sessionId;text:"This transcript belongs to another session. Return to that session before inserting it.";color:Theme.amber;font.pixelSize:12;wrapMode:Text.Wrap }
        TextArea {
            id:transcript;objectName:"transcriptionText";Layout.fillWidth:true;Layout.preferredHeight:180
            wrapMode:TextEdit.Wrap;selectByMouse:true;color:Theme.text;font.family:Theme.font
            Accessible.name:"Editable voice transcript";background:Rectangle{color:Theme.input;radius:7}
        }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Discard";Layout.fillWidth:true;onClicked:{transcript.clear();review.close()} }
            CButton {
                objectName:"acceptTranscription";text:"Insert into draft";primary:true;Layout.fillWidth:true
                enabled:voiceInput.resultSessionId===voiceInput.sessionId&&transcript.text.trim().length>0
                onClicked:{voiceInput.transcriptionAccepted(transcript.text);transcript.clear();review.close()}
            }
        }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==voiceInput.requestId)return
            voiceInput.requestId=-1
            if(value?.error){voiceInput.error=voiceInput.transcription.state==="unavailable"?"Set up local voice input in Settings → Voice.":String(value.error.message||value.error);return}
            if(voiceInput.request==="transcription.finish"){
                voiceInput.resultSessionId=value.sessionId||""
                transcript.text=value.text||""
                review.open()
            }
        }
    }
}
