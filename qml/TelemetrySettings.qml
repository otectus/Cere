pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id: telemetry
    title: "Workspace telemetry"
    required property var backend
    property var config: telemetry.backend.state.settings?.telemetry || ({enabled:false,roots:[],ignores:[],commands:false,output:false})
    property var status: telemetry.backend.state.telemetry || ({})
    property string error: ""
    property int request: -1
    function update(patch) { error=""; request=telemetry.backend.rpc("settings.update",{telemetry:patch}) }
    CText { text:"Share recent shell and file activity with Cere for workspaces you select. Linux only. Off by default.";wrapMode:Text.Wrap;Layout.fillWidth:true }
    CCheckBox { objectName:"telemetryEnabled";text:"Enable workspace telemetry";checked:telemetry.config.enabled;onClicked:telemetry.update({enabled:checked}) }
    Repeater {
        model:telemetry.config.roots || []
        RowLayout {
            id:workspaceRow
            required property string modelData
            Layout.fillWidth:true
            CText { text:workspaceRow.modelData;Layout.fillWidth:true;wrapMode:Text.Wrap }
            CButton { text:"Remove";onClicked:telemetry.update({roots:telemetry.config.roots.filter(p=>p!==workspaceRow.modelData)}) }
        }
    }
    CButton { objectName:"telemetryAddWorkspace";text:"Add workspace…";onClicked:{const path=telemetry.backend.chooseFolder();if(path)telemetry.update({roots:[...telemetry.config.roots,path]})} }
    CText { text:"Ignore patterns (one per line, relative to each workspace)";color:Theme.muted;font.pixelSize:Theme.secondary }
    CTextArea { id:ignores;objectName:"telemetryIgnores";Layout.fillWidth:true;Layout.preferredHeight:80;text:telemetry.config.ignores.join("\n");color:Theme.text;wrapMode:TextEdit.Wrap;Accessible.name:"Telemetry ignore patterns" }
    CButton { text:"Save ignore patterns";onClicked:telemetry.update({ignores:ignores.text.split("\n").map(p=>p.trim()).filter(Boolean)}) }
    CCheckBox { objectName:"telemetryCommands";text:"Include command text (secrets are redacted)";checked:telemetry.config.commands;onClicked:telemetry.update({commands:checked}) }
    CCheckBox { objectName:"telemetryOutput";text:"Include stderr from explicit cere-run commands";checked:telemetry.config.output;onClicked:telemetry.update({output:checked}) }
    CText { text:"Install hooks using cere-telemetry-hooks install fish (or bash / zsh), then open a new shell. cere-run captures only the command you wrap; it cannot read terminal scrollback.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    RowLayout {
        CButton { objectName:"telemetryPause";text:telemetry.status.paused?"Resume":"Pause";enabled:telemetry.config.enabled;onClicked:telemetry.backend.rpc("telemetry.pause",{paused:!telemetry.status.paused}) }
        CButton { objectName:"telemetryClear";text:"Clear";onClicked:telemetry.backend.rpc("telemetry.clear") }
    }
    CText { objectName:"telemetryStatus";text:"Listener: "+(telemetry.status.listener==="in use"?"in use by another instance":telemetry.status.listener||"stopped")+" · Watcher: "+(telemetry.status.watcher||"stopped")+"\nEvents: "+(telemetry.status.events||0)+" · Dropped: "+(telemetry.status.drops||0)+" · Invalid: "+(telemetry.status.invalid||0);wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:telemetry.status.hookWarning===true;text:"Shell hook version differs. Reinstall hooks and open a new shell.";color:Theme.danger;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { text:"Context injection supports Ollama and direct API conversations. CLI providers are withheld because their conversation history can retain prompts.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:!!telemetry.error||!!telemetry.status.lastError;text:telemetry.error||telemetry.status.lastError||"";color:Theme.danger;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Connections { target:telemetry.backend;function onResult(id,value){if(id===telemetry.request){telemetry.request=-1;if(value.error)telemetry.error=value.error}} }
}
