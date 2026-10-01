import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
    id:settingsView
    spacing:16
    function focusSearch(){settingsSearch.forceActiveFocus()}
    property var settings:App.state.settings||({})
    property var categoryNames:({apps:"Applications",files:"Files and folders",windows:"Windows and workspaces",audio:"Volume and mute",media:"Media playback",capture:"Screen captures",timers:"Timers",scripts:"Saved scripts",providers:"Provider orchestration"})
    readonly property var navigationEntries:[
        {label:"Companion",detail:"window, size, roaming, login",target:companionSection},
        {label:"Personality",detail:"tone and response style",target:personalitySection},
        {label:"Voice",detail:"voices, pitch, speed and volume",target:voiceSection},
        {label:"Motion & expressions",detail:"animation, quiet mode, previews",target:motionSection},
        {label:"Cere Mobile",detail:"pairing and remote access",target:remoteSection},
        {label:"AI assistance",detail:"permissions, categories, grants",target:assistanceSection},
        {label:"Saved scripts",detail:"commands and working folders",target:scriptsSection},
        {label:"Connections",detail:"Ollama, Codex, Claude Code, AntiGravity, OpenAI API, Claude API, Google AI API, keys",target:connectionsSection},
        {label:"Web search & memory",detail:"search providers and recall",target:knowledgeSection},
        {label:"Workspace telemetry",detail:"workspaces, shell hooks, recent edits",target:telemetrySection},
        {label:"Application",detail:"Hyprland shortcut and quit",target:applicationSection}
    ]
    readonly property string navigationQuery:settingsSearch.text.trim().toLowerCase()
    readonly property var matchingNavigationEntries:navigationEntries.filter(entry=>(entry.target!==voiceSection||voiceSection.available)&&(!navigationQuery||(entry.label+" "+entry.detail).toLowerCase().indexOf(navigationQuery)>=0))
    function update(value){return App.rpc("settings.update",value)}
    function jumpTo(item){
        if(!item)return
        const point=item.mapToItem(settingsScroll,0,0)
        settingsScroll.contentY=Math.max(0,Math.min(settingsScroll.contentHeight-settingsScroll.height,settingsScroll.contentY+point.y-12))
    }
    RowLayout {
        Layout.fillWidth:true
        ColumnLayout {
            Layout.fillWidth:true;spacing:4
            CText { text:"Settings";font.pixelSize:24;font.weight:Font.DemiBold }
            CText { text:"Shape how Cere looks, speaks, connects, and acts on your desktop.";color:Theme.muted;font.pixelSize:12 }
        }
        CButton { text:"Backup";onClicked:recovery.open() }
        CButton { text:"Health";onClicked:health.open() }
    }
    RowLayout {
        Layout.fillWidth:true;spacing:8
        CField {
            id:settingsSearch;objectName:"settingsSearch";Layout.fillWidth:true;Layout.preferredWidth:1
            placeholderText:"Find a setting…";Accessible.name:"Find a settings section"
            onAccepted:if(settingsView.matchingNavigationEntries.length===1)settingsView.jumpTo(settingsView.matchingNavigationEntries[0].target)
        }
        CComboBox {
            id:sectionPicker;objectName:"settingsSectionPicker";Layout.fillWidth:true;Layout.preferredWidth:1;Layout.minimumWidth:0
            model:settingsView.matchingNavigationEntries;textRole:"label";Accessible.name:"Jump to settings section"
            displayText:settingsView.navigationQuery?(count?count+" matching section"+(count===1?"":"s"):"No matching sections"):"Jump to section…"
            onActivated:if(currentIndex>=0)settingsView.jumpTo(settingsView.matchingNavigationEntries[currentIndex].target)
        }
    }
    PageScroll {
        id:settingsScroll;objectName:"settingsScroll"
        Layout.fillWidth:true;Layout.fillHeight:true;maximumContentWidth:820
    TelemetrySettings { id:telemetrySection;backend:App;Layout.fillWidth:true }
    CSection {
        id:companionSection
        title:"Companion"
        CComboBox { model:["Normal","Focus","Gaming","Presentation"];currentIndex:["normal","focus","gaming","presentation"].indexOf(settingsView.settings.desktopProfile||"normal");Accessible.name:"Desktop profile";onActivated:settingsView.update({desktopProfile:["normal","focus","gaming","presentation"][currentIndex]}) }
        CText { text:"Profiles coordinate visibility, speech, motion and ordinary notifications. Pending approvals remain available from Cere’s tray.";color:Theme.muted;font.pixelSize:12 }
        RowLayout {
            CText { text:"Interface size" }
            CSlider { Layout.fillWidth:true;from:.8;to:1.5;stepSize:.1;value:settingsView.settings.interfaceScale||1;Accessible.name:"Interface size";onMoved:settingsView.update({interfaceScale:value}) }
            CText { text:Math.round((settingsView.settings.interfaceScale||1)*100)+"%" }
        }
        Flow {
            Layout.fillWidth:true;spacing:6
            CButton { text:"Save monitor home";onClicked:App.saveHomePosition() }
            CButton { text:"Go home";onClicked:App.goHomePosition() }
            CButton { text:"Dock left";onClicked:App.dockPet("left") }
            CButton { text:"Dock right";onClicked:App.dockPet("right") }
        }
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
    PersonalitySettings { id:personalitySection }
    VoiceSettings { id:voiceSection }
    RemoteSettings { id:remoteSection }
    CSection {
        id:motionSection
        title:"Motion & expressions"
        description:"A little attitude, a little grace. Make her movement feel like home."
        CCheckBox { text:"Quiet mode";checked:settingsView.settings.quiet===true;onClicked:settingsView.update({quiet:checked}) }
        CText { text:"Pause animations, spoken replies and ordinary notifications.";color:Theme.muted;font.pixelSize:12 }
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
        CText { text:"From a quiet presence to full personality: soften her breathing, gaze, hair sway and gestures together. Zero keeps state poses still.";color:Theme.muted;font.pixelSize:12 }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Idle energy";font.pixelSize:12 }
            CComboBox {
                objectName:"idleEnergy";Layout.fillWidth:true;textRole:"label";valueRole:"value"
                model:[{label:"Calm",value:"calm"},{label:"Lively",value:"lively"}]
                currentIndex:settingsView.settings.idleEnergy === "calm" ? 0 : 1
                Accessible.name:"Idle energy"
                onActivated:settingsView.update({idleEnergy:currentValue})
            }
        }
        MotionStage { Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0 }
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
        Flow {
            Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:6
            Repeater {
                model:[{name:"wave",label:"Say hello"},{name:"nod",label:"A knowing nod"},{name:"giggle",label:"Try to behave"},{name:"stretch",label:"Stretch"},{name:"glassesAdjust",label:"Adjust glasses"},{name:"hairTuck",label:"Tuck her hair"},{name:"smallShrug",label:"Who, me?"},{name:"hairToss",label:"A little drama"},{name:"music",label:"Find the rhythm"}]
                CButton {
                    required property var modelData
                    text:modelData.label
                    enabled:!settingsView.settings.quiet&&!settingsView.settings.reducedMotion&&!settingsView.settings.hidden&&settingsView.settings.motionIntensity!==0
                    onClicked:App.preview(modelData.name)
                }
            }
        }
        CText { visible:settingsView.settings.quiet||settingsView.settings.reducedMotion||settingsView.settings.hidden;text:"Show Cere and turn off quiet mode and reduced motion to preview expressions.";color:Theme.muted;font.pixelSize:12 }
        CButton { text:settingsView.settings.hidden?"Show Cere":"Hide Cere";onClicked:settingsView.update({hidden:!settingsView.settings.hidden}) }
    }
    CSection {
        id:assistanceSection
        title:"AI assistance"
        description:"Choose which actions your assistant sessions can request. Manual controls in the Desktop tab remain available."
        CCheckBox {
            objectName:"bypassCliPermissions";text:"Skip CLI permission prompts"
            checked:settingsView.settings.bypassCliPermissions===true
            onClicked:settingsView.update({bypassCliPermissions:checked})
        }
        CCheckBox {
            objectName:"bypassComputerPermissions";text:"Skip computer permission prompts"
            checked:settingsView.settings.bypassComputerPermissions===true
            onClicked:settingsView.update({bypassComputerPermissions:checked})
        }
        CText { text:"These switches stay on until you turn them off. CLI includes project trust, commands, file changes, scripts, delegation and new terminals launched through Cere. Computer includes desktop actions. Questions still require an answer.";color:Theme.muted;font.pixelSize:12 }
        CButton { objectName:"openPermissionCenter";text:"Permission Center and power sessions";Layout.fillWidth:true;onClicked:permissionCenter.open() }
        CText { text:"Power sessions grant project-bound access for a limited time. Power does not approve existing requests or change already-running terminals.";color:Theme.muted;font.pixelSize:12 }
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
        CText { text:"Provider orchestration and saved scripts follow the selected profile and grants. A power session can grant temporary access. Native CLI shell access remains outside Cere’s desktop grants.";color:Theme.muted;font.pixelSize:12 }
        CButton { text:settingsView.settings.paused?"Resume AI actions":"Pause AI actions";Layout.fillWidth:true;onClicked:settingsView.update({paused:!settingsView.settings.paused}) }
        ColumnLayout {
            visible:settingsView.settings.profile==="broad";Layout.fillWidth:true;spacing:12
            CText { text:"Standing grants";color:Theme.amber;font.weight:Font.DemiBold }
            CText { text:"Allow enabled desktop categories in this project for one hour. Provider delegation asks first unless CLI bypass is enabled.";color:Theme.muted;font.pixelSize:12 }
            CText { text:App.session.cwd||"Select a session to grant access.";color:Theme.cyan;font.pixelSize:12 }
            GridLayout {
                Layout.fillWidth:true;columns:width>=340?2:1;columnSpacing:8;rowSpacing:8
                CButton { Layout.fillWidth:true;text:"Grant for 1 hour";enabled:!!App.session.cwd;onClicked:settingsView.update({grants:(settingsView.settings.grants||[]).filter(g=>g.cwd!==App.session.cwd).concat((settingsView.settings.categories||[]).filter(c=>c!=="providers").map(c=>({category:c,cwd:App.session.cwd,expires:Date.now()+3600000})))}) }
                CButton { Layout.fillWidth:true;text:"Revoke all";onClicked:settingsView.update({grants:[]}) }
            }
            Repeater { model:settingsView.settings.grants||[];CText { required property var modelData;text:modelData.category+" · expires "+new Date(modelData.expires).toLocaleTimeString(Qt.locale(),"h:mm AP");color:Theme.muted;font.pixelSize:11 } }
        }
    }
    CSection {
        id:scriptsSection
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
        id:connectionsSection
        title:"Connections"
        OllamaConnection {}
        Repeater {
            model:["codex","claude","antigravity"]
            ColumnLayout {
                required property string modelData
                property var capability:(App.state.capabilities||{})[modelData]||({})
                Layout.fillWidth:true;spacing:5
                CText { text:(modelData==="codex"?"Codex":modelData==="antigravity"?"AntiGravity":"Claude Code")+" · "+(capability.available?"Ready":"Unavailable");color:capability.available?Theme.cyan:Theme.amber;font.weight:Font.DemiBold }
                CText { text:capability.version||capability.error||"Checking installed CLI…";color:Theme.muted;font.pixelSize:12 }
                CText { visible:modelData==="antigravity";text:"Sign in with agy in a terminal first. Headless actions that need approval are skipped unless allowed in AntiGravity or Cere’s CLI bypass is enabled. Desktop only; text attachments supported.";color:Theme.muted;font.pixelSize:12 }
            }
        }
        CText { text:"API keys stay on this computer in an owner-only credentials file, outside settings and backups. Shared memory follows Settings → Knowledge → cloud sharing.";color:Theme.muted;font.pixelSize:12 }
        ApiConnection { provider:"openai";label:"OpenAI API" }
        ApiConnection { provider:"anthropic";label:"Claude API" }
        ApiConnection { provider:"google";label:"Google AI API" }
    }
    KnowledgeSettings { id:knowledgeSection }
    CSection {
        id:applicationSection
        title:"Application"
        description:"Find Cere in your application menu or tray. Closing a panel keeps your sessions running."
        CButton { text:"Copy Hyprland shortcut";help:"Copy a suggested Super+C binding for a Lua configuration";onClicked:App.copy('hl.bind("SUPER + C", hl.dsp.exec_cmd("cere toggle"))') }
        GridLayout {
            Layout.fillWidth:true;columns:width>=520?2:1;columnSpacing:8;rowSpacing:8
            CButton { objectName:"quitKeepSessions";Layout.fillWidth:true;text:"Quit · keep sessions running";onClicked:App.quit(false) }
            CButton { Layout.fillWidth:true;text:"Stop sessions and quit";danger:true;onClicked:quitConfirm.open() }
        }
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
    PermissionCenter { id:permissionCenter }
    Health { id:health }
    Recovery { id:recovery }
}
