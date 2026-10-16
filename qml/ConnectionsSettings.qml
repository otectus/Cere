import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Connections: the Ollama server, the coding CLIs Cere manages, and direct API keys.
ColumnLayout {
    id:connections
    Layout.fillWidth:true;spacing:14
    CSection {
        title:"Ollama"
        description:"Local and Ollama Cloud models, and the server memory uses for embeddings."
        OllamaConnection {}
    }
    CSection {
        title:"Command-line providers"
        description:"Codex, Claude Code and AntiGravity, as installed on this computer. Each keeps its own sign-in and settings."
        ColumnLayout {
            objectName:"cliProviders";Layout.fillWidth:true;spacing:12
            Repeater {
                model:["codex","claude","antigravity"]
                ColumnLayout {
                    required property string modelData
                    property var capability:(App.state.capabilities||{})[modelData]||({})
                    Layout.fillWidth:true;spacing:5
                    CText { text:(modelData==="codex"?"Codex":modelData==="antigravity"?"AntiGravity":"Claude Code")+" · "+(capability.available?"Ready":"Unavailable");color:capability.available?Theme.accentText:Theme.amber;font.weight:Font.DemiBold }
                    CText { text:capability.version||capability.error||"Checking installed CLI…";color:Theme.muted;font.pixelSize:Theme.secondary }
                    CText { visible:modelData==="antigravity";text:"Sign in with agy in a terminal first. Headless actions that need approval are skipped unless allowed in AntiGravity or Cere’s CLI bypass is enabled. Desktop only; text attachments supported.";color:Theme.muted;font.pixelSize:Theme.secondary }
                }
            }
        }
    }
    CSection {
        title:"API keys"
        description:"API keys stay on this computer in an owner-only credentials file, outside settings and backups. Shared memory follows Knowledge › Memory › cloud sharing."
        ApiConnection { provider:"openai";label:"OpenAI API" }
        ApiConnection { provider:"anthropic";label:"Claude API" }
        ApiConnection { provider:"google";label:"Google AI API" }
    }
    CSection {
        title:"Compatible endpoint"
        description:"One OpenAI-compatible chat server of your choice, local or hosted."
        CompatibleConnection {}
    }
}
