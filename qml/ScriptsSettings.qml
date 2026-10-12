import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Saved scripts: commands Cere may run, each reviewed in Desktop before it runs.
ColumnLayout {
    id:scripts
    Layout.fillWidth:true;spacing:14
    property var settings:App.state.settings||({})
    function update(value){return App.rpc("settings.update",value)}
    CSection {
        title:"Saved scripts"
        description:"Save an executable, its arguments and a working folder. Review it in Desktop before running."
        CButton { objectName:"addScript";text:"Add script";onClicked:scriptDialog.open() }
        Repeater {
            model:scripts.settings.scripts||[]
            RowLayout {
                required property var modelData;id:scriptRow;Layout.fillWidth:true
                CText { text:scriptRow.modelData.name }
                CButton { text:"Remove";danger:true;Accessible.name:"Remove "+scriptRow.modelData.name;onClicked:scripts.update({scripts:scripts.settings.scripts.filter(s=>s.id!==scriptRow.modelData.id)}) }
            }
        }
        CText { visible:!(scripts.settings.scripts||[]).length;text:"No saved scripts yet.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CDialog {
        id:scriptDialog;objectName:"scriptDialog";property int requestId:-1;property string error:""
        onOpened:error=""
        CText { text:"Add a saved script";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Name";font.pixelSize:Theme.secondary;color:Theme.muted }
        CField { id:scriptName;Layout.fillWidth:true;placeholderText:"e.g. Start development server";Accessible.name:"Script name" }
        CText { text:"Executable";font.pixelSize:Theme.secondary;color:Theme.muted }
        CField { id:executable;Layout.fillWidth:true;placeholderText:"Absolute executable path";Accessible.name:"Executable path" }
        CText { text:"Arguments (JSON array)";font.pixelSize:Theme.secondary;color:Theme.muted }
        CField { id:scriptArgs;objectName:"scriptArguments";Layout.fillWidth:true;placeholderText:'["--verbose"]';text:"[]";Accessible.name:"Script arguments" }
        CText { text:"Working folder";font.pixelSize:Theme.secondary;color:Theme.muted }
        RowLayout {
            Layout.fillWidth:true
            CField { id:scriptCwd;Layout.fillWidth:true;placeholderText:"Absolute working folder";text:App.session.cwd||"";Accessible.name:"Script working folder" }
            CButton { text:"Browse";onClicked:{const folder=App.chooseFolder();if(folder)scriptCwd.text=folder} }
        }
        CText { text:"Commands time out after 60 seconds.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CText { visible:scriptDialog.error.length>0;text:scriptDialog.error;color:Theme.danger;font.pixelSize:Theme.secondary }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";onClicked:scriptDialog.close() }
            CButton {
                Layout.fillWidth:true;text:scriptDialog.requestId>=0?"Saving…":"Save script";primary:true
                enabled:scriptDialog.requestId<0&&scriptName.text.trim().length>0&&executable.text.startsWith("/")&&scriptCwd.text.startsWith("/")
                onClicked:{
                    try {
                        const args=JSON.parse(scriptArgs.text)
                        if(!Array.isArray(args)||!args.every(a=>typeof a==="string"))throw Error("Use a JSON array of strings for arguments.")
                        scriptDialog.requestId=scripts.update({scripts:(scripts.settings.scripts||[]).concat([{id:"script-"+Date.now(),name:scriptName.text.trim(),executable:executable.text,args:args,cwd:scriptCwd.text,timeout:60000}])})
                    }catch(e){scriptDialog.error=e.message}
                }
            }
        }
    }
    Connections { target:App;function onResult(id,value){if(id===scriptDialog.requestId){scriptDialog.requestId=-1;if(value?.error)scriptDialog.error=value.error;else{scriptDialog.close();scriptName.clear();executable.clear();scriptArgs.text="[]"}}} }
}
