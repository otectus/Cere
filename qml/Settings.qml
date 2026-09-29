import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
PageScroll {
    id:settingsView
    objectName:"settingsScroll"
    maximumContentWidth:900
    property var settings:App.state.settings||({})
    property var categoryNames:({apps:"Applications",files:"Files and folders",windows:"Windows and workspaces",audio:"Volume and mute",media:"Media playback",capture:"Screen captures",timers:"Timers",scripts:"Saved scripts",providers:"Provider orchestration"})
    function update(value){return App.rpc("settings.update",value)}
    CText { text:"Settings";font.pixelSize:22;font.weight:Font.DemiBold }
    CText { text:"Make Cere feel at home on your desktop.";color:Theme.muted;font.pixelSize:12 }
    CSection {
        title:"Companion"
        CCheckBox { text:"Always on top";checked:settingsView.settings.topmost===true;onClicked:settingsView.update({topmost:checked}) }
        CText { text:"Keep Cere above your applications, including fullscreen windows.";color:Theme.muted;font.pixelSize:12 }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Character size";font.pixelSize:12;Layout.fillWidth:false }
            CSlider { Layout.fillWidth:true;Layout.minimumWidth:0;from:.5;to:3;stepSize:.25;value:settingsView.settings.scale||1;Accessible.name:"Character size";onMoved:App.resizePet(value) }
            Text { text:Math.round((settingsView.settings.scale||1)*100)+"%";color:Theme.cyan;font.family:Theme.font;font.pixelSize:12 }
        }
        CCheckBox { text:"Roaming · gently follow the mouse";checked:settingsView.settings.roaming===true;onClicked:settingsView.update({roaming:checked}) }
        CText { visible:settingsView.settings.roaming;text:"She follows across your displays and stops short of the pointer. Hovering, dragging, open panels, fullscreen apps and active tasks pause her movement.";color:Theme.muted;font.pixelSize:12 }
        CCheckBox { text:"Start Cere at login";checked:App.autostartEnabled();onClicked:App.setAutostart(checked) }
    }
    PersonalitySettings {}
    CSection {
        title:"Motion & expressions"
        CCheckBox { text:"Quiet mode";checked:settingsView.settings.quiet===true;onClicked:settingsView.update({quiet:checked}) }
        CText { text:"Pause animations and ordinary notifications.";color:Theme.muted;font.pixelSize:12 }
        CCheckBox { objectName:"reducedMotion";text:"Reduce motion";checked:settingsView.settings.reducedMotion===true;onClicked:settingsView.update({reducedMotion:checked}) }
        CText { text:"Use still poses for her current state. Breathing, blinking, transitions and roaming stop; permission requests stay visible.";color:Theme.muted;font.pixelSize:12 }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Motion intensity";font.pixelSize:12;Layout.fillWidth:false }
            CSlider {
                objectName:"motionIntensity";Layout.fillWidth:true;Layout.minimumWidth:0
                from:0;to:1;stepSize:.1;value:settingsView.settings.motionIntensity === undefined ? 0.7 : settingsView.settings.motionIntensity
                enabled:!settingsView.settings.quiet&&!settingsView.settings.reducedMotion
                Accessible.name:"Motion intensity";onMoved:settingsView.update({motionIntensity:Math.round(value*10)/10})
            }
            Text { text:Math.round((settingsView.settings.motionIntensity === undefined ? 0.7 : settingsView.settings.motionIntensity)*100)+"%";color:Theme.cyan;font.pixelSize:12 }
        }
        CText { text:"Lower intensity softens movement and spaces out idle gestures. Zero keeps state poses still.";color:Theme.muted;font.pixelSize:12 }
        CCheckBox { objectName:"expressiveCues";text:"Respond to conversational tone";checked:settingsView.settings.expressiveCues!==false;onClicked:settingsView.update({expressiveCues:checked}) }
        CText { text:"Occasional expressions from clear English conversational cues, interpreted locally. Task results always come from the app.";color:Theme.muted;font.pixelSize:12 }
        RowLayout {
            Layout.fillWidth:true
            CComboBox {
                id:expression;objectName:"animationPicker";Layout.fillWidth:true;Layout.minimumWidth:0;textRole:"label";valueRole:"name"
                model:Object.keys(App.animations.clips||{}).filter(n=>!App.animations.clips[n].loop).map(n=>({name:n,label:App.animations.clips[n].label}))
                Accessible.name:"Choose Cere’s expression"
            }
            CButton { objectName:"previewAnimation";text:"Preview";enabled:!settingsView.settings.quiet&&!settingsView.settings.reducedMotion&&!settingsView.settings.hidden&&settingsView.settings.motionIntensity!==0;onClicked:App.preview(expression.currentValue) }
        }
        CText { visible:settingsView.settings.quiet||settingsView.settings.reducedMotion||settingsView.settings.hidden;text:"Show Cere and turn off quiet mode and reduced motion to preview expressions.";color:Theme.muted;font.pixelSize:12 }
        CButton { text:settingsView.settings.hidden?"Show Cere":"Hide Cere";onClicked:settingsView.update({hidden:!settingsView.settings.hidden}) }
    }
    CSection {
        title:"AI assistance"
        description:"Choose which actions your assistant sessions can request. Manual controls in the Desktop tab remain available."
        CCheckBox {
            objectName:"bypassCliPermissions";text:"Bypass all CLI permissions"
            checked:settingsView.settings.bypassCliPermissions===true
            onClicked:settingsView.update({bypassCliPermissions:checked})
        }
        CText { text:"Automatically allow CLI actions, saved scripts and delegation. Codex and Claude run with full access, without permission prompts or their optional sandbox. Applies to every session and new cere terminal launches.";color:Theme.muted;font.pixelSize:12 }
        CCheckBox {
            objectName:"bypassComputerPermissions";text:"Bypass all computer-control permissions"
            checked:settingsView.settings.bypassComputerPermissions===true
            onClicked:settingsView.update({bypassComputerPermissions:checked})
        }
        CText { text:"Allow all Cere desktop tools and share captures with the requesting session without asking. Overrides desktop categories and standing grants.";color:Theme.muted;font.pixelSize:12 }
        CText { visible:settingsView.settings.bypassCliPermissions||settingsView.settings.bypassComputerPermissions;text:"Bypass is active. Matching pending requests are accepted. CLI sandbox changes apply on the next turn; stop the current turn to end its existing access. Restart linked terminals to change their permissions. Pause still blocks Cere tools.";color:Theme.amber;font.pixelSize:12 }
        CComboBox {
            id:profile;Layout.fillWidth:true;Layout.minimumWidth:0;model:["Manual controls only","Scoped assistance","Broad control"]
            Accessible.name:"Desktop assistance profile"
            currentIndex:settingsView.settings.profile==="manual"?0:settingsView.settings.profile==="broad"?2:1
            onActivated:settingsView.update({profile:["manual","scoped","broad"][currentIndex]})
        }
        GridLayout {
            Layout.fillWidth:true;columns:width>=460?2:1;columnSpacing:12;rowSpacing:4
            Repeater {
                model:Object.keys(settingsView.categoryNames)
                CCheckBox {
                    required property string modelData
                    text:settingsView.categoryNames[modelData]
                    property bool bypassed:modelData==="scripts"||modelData==="providers"?settingsView.settings.bypassCliPermissions===true:settingsView.settings.bypassComputerPermissions===true
                    checked:bypassed||(settingsView.settings.categories||[]).indexOf(modelData)>=0
                    enabled:!bypassed&&settingsView.settings.profile!=="manual"
                    onClicked:{let c=(settingsView.settings.categories||[]).filter(x=>x!==modelData);if(checked)c.push(modelData);settingsView.update({categories:c})}
                }
            }
        }
        CText { text:"Without CLI bypass, provider orchestration asks you to review each task and saved scripts follow the profile and grant settings. CLI full access can also control the desktop through shell commands.";color:Theme.muted;font.pixelSize:12 }
        CButton { text:settingsView.settings.paused?"Resume AI actions":"Pause AI actions";Layout.fillWidth:true;onClicked:settingsView.update({paused:!settingsView.settings.paused}) }
        ColumnLayout {
            visible:settingsView.settings.profile==="broad";Layout.fillWidth:true;spacing:12
            CText { text:"Standing grants";color:Theme.amber;font.weight:Font.DemiBold }
            CText { text:"Allow enabled desktop categories in this project for one hour. Provider delegation asks first unless CLI bypass is enabled.";color:Theme.muted;font.pixelSize:12 }
            CText { text:App.session.cwd||"Select a session to grant access.";color:Theme.cyan;font.pixelSize:12 }
            GridLayout {
                Layout.fillWidth:true;columns:width>=340?2:1;columnSpacing:8;rowSpacing:8
                CButton { Layout.fillWidth:true;text:"Grant for 1 hour";enabled:!!App.session.cwd;onClicked:settingsView.update({grants:(settingsView.settings.categories||[]).filter(c=>c!=="providers").map(c=>({category:c,cwd:App.session.cwd,expires:Date.now()+3600000}))}) }
                CButton { Layout.fillWidth:true;text:"Revoke all";onClicked:settingsView.update({grants:[]}) }
            }
            Repeater { model:settingsView.settings.grants||[];CText { required property var modelData;text:modelData.category+" · expires "+new Date(modelData.expires).toLocaleTimeString(Qt.locale(),"h:mm AP");color:Theme.muted;font.pixelSize:11 } }
        }
    }
    CSection {
        title:"Saved scripts"
        description:"Save an executable, its arguments and a working folder. Review it in Desktop before running."
        CButton { objectName:"addScript";text:"Add script";onClicked:scriptDialog.open() }
        Repeater {
            model:settingsView.settings.scripts||[]
            RowLayout {
                required property var modelData;id:scriptRow;Layout.fillWidth:true
                CText { text:scriptRow.modelData.name }
                CButton { text:"Remove";danger:true;onClicked:settingsView.update({scripts:settingsView.settings.scripts.filter(s=>s.id!==scriptRow.modelData.id)}) }
            }
        }
        CText { visible:!(settingsView.settings.scripts||[]).length;text:"No saved scripts yet.";color:Theme.muted;font.pixelSize:12 }
    }
    CSection {
        title:"Connections"
        OllamaConnection {}
        Repeater {
            model:["codex","claude"]
            ColumnLayout {
                required property string modelData
                property var capability:(App.state.capabilities||{})[modelData]||({})
                Layout.fillWidth:true;spacing:5
                CText { text:(modelData==="codex"?"Codex":"Claude")+" · "+(capability.available?"Ready":"Unavailable");color:capability.available?Theme.cyan:Theme.amber;font.weight:Font.DemiBold }
                CText { text:capability.version||capability.error||"Checking installed CLI…";color:Theme.muted;font.pixelSize:12 }
            }
        }
    }
    KnowledgeSettings {}
    CSection {
        title:"Application"
        description:"Find Cere in your application menu or tray. Closing a panel keeps your sessions running."
        CButton { text:"Copy Hyprland shortcut";help:"Copy a suggested Super+C binding for a Lua configuration";onClicked:App.copy('hl.bind("SUPER + C", hl.dsp.exec_cmd("cere toggle"))') }
        GridLayout {
            Layout.fillWidth:true;columns:width>=520?2:1;columnSpacing:8;rowSpacing:8
            CButton { objectName:"quitKeepSessions";Layout.fillWidth:true;text:"Quit · keep sessions running";onClicked:App.quit(false) }
            CButton { Layout.fillWidth:true;text:"Stop sessions and quit";danger:true;onClicked:quitConfirm.open() }
        }
    }
    CDialog {
        id:quitConfirm
        CText { text:"Stop sessions and quit?";font.pixelSize:20;font.weight:Font.DemiBold }
        CText { text:"Any running turns will be interrupted. Their conversation history will stay available.";color:Theme.muted }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";onClicked:quitConfirm.close() }
            CButton { Layout.fillWidth:true;text:"Stop and quit";danger:true;onClicked:App.quit(true) }
        }
    }
    CDialog {
        id:scriptDialog;objectName:"scriptDialog";property int requestId:-1;property string error:""
        onOpened:error=""
        CText { text:"Add a saved script";font.pixelSize:20;font.weight:Font.DemiBold }
        CText { text:"Name";font.pixelSize:12;color:Theme.muted }
        CField { id:scriptName;Layout.fillWidth:true;placeholderText:"e.g. Start development server";Accessible.name:"Script name" }
        CText { text:"Executable";font.pixelSize:12;color:Theme.muted }
        CField { id:executable;Layout.fillWidth:true;placeholderText:"Absolute executable path";Accessible.name:"Executable path" }
        CText { text:"Arguments (JSON array)";font.pixelSize:12;color:Theme.muted }
        CField { id:scriptArgs;objectName:"scriptArguments";Layout.fillWidth:true;placeholderText:'["--verbose"]';text:"[]";Accessible.name:"Script arguments" }
        CText { text:"Working folder";font.pixelSize:12;color:Theme.muted }
        RowLayout {
            Layout.fillWidth:true
            CField { id:scriptCwd;Layout.fillWidth:true;placeholderText:"Absolute working folder";text:App.session.cwd||"";Accessible.name:"Script working folder" }
            CButton { text:"Browse";onClicked:{const folder=App.chooseFolder();if(folder)scriptCwd.text=folder} }
        }
        CText { text:"Commands time out after 60 seconds.";color:Theme.muted;font.pixelSize:12 }
        CText { visible:scriptDialog.error.length>0;text:scriptDialog.error;color:Theme.danger;font.pixelSize:12 }
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
                        scriptDialog.requestId=settingsView.update({scripts:(settingsView.settings.scripts||[]).concat([{id:"script-"+Date.now(),name:scriptName.text.trim(),executable:executable.text,args:args,cwd:scriptCwd.text,timeout:60000}])})
                    }catch(e){scriptDialog.error=e.message}
                }
            }
        }
    }
    Connections { target:App;function onResult(id,value){if(id===scriptDialog.requestId){scriptDialog.requestId=-1;if(value?.error)scriptDialog.error=value.error;else{scriptDialog.close();scriptName.clear();executable.clear();scriptArgs.text="[]"}}} }
}
