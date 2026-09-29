import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window
ColumnLayout {
    id: desktop
    objectName: "desktopPage"
    signal settingsRequested()
    property var apps: []
    property var windows: []
    property var audio: ({available:false})
    property var media: ({available:false})
    property string mediaError: ""
    property var requests: ({})
    property int appsRequest: -1
    property int windowsRequest: -1
    property int audioRequest: -1
    property int mediaRequest: -1
    property bool catalogLoaded: false
    readonly property bool loading: appsRequest>=0||windowsRequest>=0
    property string capturePath: ""
    property string feedback: ""
    property bool failed: false
    property string catalogError: ""
    property int category: 0
    property int appLimit: 12
    property string query: search.text.trim().toLowerCase()
    property var filteredApps: apps.filter(a=>matches(a.name))
    property var filteredWindows: windows.filter(w=>matches(w.title+" "+w.class))
    property var filteredScripts: (App.state.settings?.scripts||[]).filter(s=>matches(s.name))
    property bool controls: category===0 || category===1
    property bool showQuick: controls && matches("capture screenshot screen region satty crop annotate open folder file")
    property bool showAudio: controls && matches("sound volume audio music spotify media playback play pause next previous stop mute")
    property bool showTimers: controls && matches("timer reminder break")
    property bool showWindows: (category===0||category===3) && (!query || matches("workspace windows") || filteredWindows.length>0)
    property bool showApps: (category===0||category===2) && (!query || filteredApps.length>0)
    property bool showScripts: controls && (!query || filteredScripts.length>0)
    spacing: 12
    function matches(text) { return !query || String(text).toLowerCase().indexOf(query)>=0 }
    function focusSearch() { search.forceActiveFocus() }
    function pending(name) { return Object.values(requests).some(r=>r.name===name) }
    function action(name,args,label) {
        const id=App.rpc("action.run",{name:name,args:args||{}})
        if(id<0)return id
        const next=Object.assign({},requests);next[id]={name:name,label:label||"Done"};requests=next
        return id
    }
    function refresh() {
        if(!App.connected)return
        catalogError=""
        appsRequest=App.rpc("apps.list");windowsRequest=App.rpc("windows.list");audioRequest=App.rpc("audio.status")
        refreshMedia()
        catalogLoaded=true
    }
    function refreshMedia() { if(App.connected&&mediaRequest<0)mediaRequest=App.rpc("media.status") }
    onVisibleChanged: if(visible)refresh()
    onQueryChanged: { appLimit=12;desktopScroll.contentY=0 }
    onCategoryChanged: desktopScroll.contentY=0
    Component.onCompleted: if(visible)refresh()
    RowLayout {
        Layout.fillWidth:true
        ColumnLayout {
            Layout.fillWidth:true;spacing:3
            CText { text:"Desktop";font.pixelSize:22;font.weight:Font.DemiBold }
            CText { text:"Everyday controls, close at hand.";color:Theme.muted;font.pixelSize:12 }
        }
        CButton { text:desktop.loading?"Loading…":"Refresh";help:"Refresh applications, windows and volume";onClicked:desktop.refresh();enabled:App.connected&&!desktop.loading }
    }
    RowLayout {
        Layout.fillWidth:true
        CField { id:search;objectName:"desktopSearch";Layout.fillWidth:true;placeholderText:"Search controls, applications or windows";Accessible.name:"Search desktop actions" }
        CButton { visible:search.text.length>0;text:"Clear";onClicked:search.clear() }
    }
    RowLayout {
        Layout.fillWidth:true;spacing:5
        Repeater {
            model:["All","Controls","Apps","Windows"]
            CButton { required property string modelData;required property int index;objectName:"desktopFilter_"+index;Layout.fillWidth:true;Layout.preferredWidth:1;leftPadding:8;rightPadding:8;text:modelData;primary:desktop.category===index;onClicked:desktop.category=index }
        }
    }
    Rectangle {
        visible:desktop.feedback.length>0||desktop.catalogError.length>0
        Layout.fillWidth:true;implicitHeight:feedbackRow.implicitHeight+20
        color:desktop.failed||desktop.catalogError ? "#33232e" : Theme.selected;radius:8
        RowLayout {
            id:feedbackRow;x:10;y:10;width:parent.width-20
            CText { text:desktop.feedback||desktop.catalogError;color:desktop.failed||desktop.catalogError?Theme.danger:Theme.text;font.pixelSize:12 }
            CButton { text:"Dismiss";implicitHeight:30;onClicked:{desktop.feedback="";desktop.catalogError=""} }
        }
    }
    PageScroll {
        id:desktopScroll;objectName:"desktopScroll"
        Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumHeight:80
        GridLayout {
            id:sections;Layout.fillWidth:true;Layout.minimumWidth:0
            columns:desktopScroll.bodyWidth>=740?2:1
            rowSpacing:14;columnSpacing:14
            CSection {
                title:"Quick actions";visible:desktop.showQuick;Layout.columnSpan:sections.columns
                GridLayout {
                    Layout.fillWidth:true;columns:width>=560?3:1;columnSpacing:8;rowSpacing:8
                    CButton { objectName:"captureRegion";Layout.fillWidth:true;Layout.preferredWidth:1;text:desktop.pending("screenshot.capture")?"Editing in Satty…":"Capture in Satty";help:"Open the focused display in Satty to crop and annotate";enabled:App.connected&&!desktop.pending("screenshot.capture");onClicked:{if(desktop.action("screenshot.capture",{},"Capture saved")>=0)App.closePanel()} }
                    CButton { Layout.fillWidth:true;Layout.preferredWidth:1;text:"Open folder";onClicked:{const p=App.chooseFolder();if(p)desktop.action("files.open",{path:p},"Folder opened")} }
                    CButton { Layout.fillWidth:true;Layout.preferredWidth:1;text:"Open file";onClicked:{const p=App.chooseFile();if(p)desktop.action("files.open",{path:p},"File opened")} }
                }
                CText { text:"Crop or annotate in Satty. Enter saves; Escape cancels.";color:Theme.muted;font.pixelSize:11 }
            }
            CSection {
                title:"Sound & playback";visible:desktop.showAudio;Layout.preferredWidth:1
                RowLayout {
                    Layout.fillWidth:true
                    CText { text:"Output volume";font.pixelSize:12;color:Theme.muted }
                    Text { text:desktop.audio.available?(desktop.audio.muted?"Muted · ":"")+Math.round(volume.value)+"%":"Unavailable";color:Theme.cyan;font.family:Theme.font;font.pixelSize:12 }
                }
                RowLayout {
                    Layout.fillWidth:true
                    CSlider { id:volume;objectName:"desktopVolume";Layout.fillWidth:true;Layout.minimumWidth:0;from:0;to:100;stepSize:1;enabled:desktop.audio.available;Accessible.name:"Output volume";onMoved:volumeDebounce.restart() }
                    CButton { text:desktop.audio.muted?"Unmute":"Mute";enabled:desktop.audio.available&&!desktop.pending("audio.mute");onClicked:desktop.action("audio.mute",{},"Output updated") }
                }
                CText { visible:!desktop.audio.available;text:"No audio output is available. Refresh after connecting a device.";font.pixelSize:11;color:Theme.muted }
                Rectangle { Layout.fillWidth:true;implicitHeight:1;color:Theme.line }
                CText { objectName:"mediaStatus";text:desktop.media.available?desktop.media.name+" · "+desktop.media.status:desktop.mediaError|| (desktop.mediaRequest>=0?"Checking media players…":"Open Spotify or another media player to use playback controls.");font.pixelSize:12;color:desktop.media.available?Theme.cyan:Theme.muted }
                GridLayout {
                    Layout.fillWidth:true;columns:2;columnSpacing:8;rowSpacing:8
                    Repeater {
                        model:[{text:"Previous",command:"Previous",capability:"canPrevious"},{text:desktop.media.status==="Playing"?"Pause":"Play",command:"PlayPause",capability:"canPlayPause"},{text:"Next",command:"Next",capability:"canNext"},{text:"Stop",command:"Stop",capability:"canStop"}]
                        CButton { required property var modelData;objectName:"media_"+modelData.command;Layout.fillWidth:true;Layout.preferredWidth:1;text:modelData.text;help:desktop.media.available?modelData.text+" · "+desktop.media.name:"No media player is available";enabled:App.connected&&desktop.media.available&&desktop.media[modelData.capability]&&!desktop.pending("media.control");onClicked:desktop.action("media.control",{command:modelData.command,player:desktop.media.player},"Playback updated") }
                    }
                }
            }
            CSection {
                title:"Focus timer";visible:desktop.showTimers;Layout.preferredWidth:1
                RowLayout {
                    Layout.fillWidth:true
                    CText { text:"Duration";color:Theme.muted;font.pixelSize:12 }
                    CSpinBox { id:minutes;objectName:"timerMinutes";from:1;to:10080;value:25;Accessible.name:"Timer duration in minutes" }
                    Text { text:"min";color:Theme.muted;font.pixelSize:12;font.family:Theme.font }
                }
                CField { id:timerLabel;objectName:"timerLabel";Layout.fillWidth:true;placeholderText:"Reminder (optional)";Accessible.name:"Timer reminder" }
                CButton { objectName:"startTimer";Layout.fillWidth:true;primary:true;text:desktop.pending("timer.start")?"Starting…":"Start timer";enabled:App.connected&&!desktop.pending("timer.start");onClicked:desktop.action("timer.start",{minutes:minutes.value,label:timerLabel.text.trim()||"Time for a break"},"Timer started · "+minutes.value+" min") }
                CText { visible:!(App.state.timers||[]).length;text:"A gentle reminder when it’s time for a break.";color:Theme.muted;font.pixelSize:12 }
                Repeater {
                    model:App.state.timers||[]
                    RowLayout {
                        required property var modelData
                        id:timerRow;Layout.fillWidth:true
                        ColumnLayout {
                            Layout.fillWidth:true;Layout.minimumWidth:0;spacing:3
                            CText { text:timerRow.modelData.label;font.pixelSize:12 }
                            CText { text:"Ends "+new Date(timerRow.modelData.due).toLocaleTimeString(Qt.locale(),"h:mm AP");color:Theme.muted;font.pixelSize:11 }
                        }
                        CButton { text:"Cancel";help:"Cancel this timer";onClicked:App.rpc("timer.cancel",{id:timerRow.modelData.id}) }
                    }
                }
            }
            CSection {
                title:"Windows & workspaces";visible:desktop.showWindows;hint:desktop.filteredWindows.length+" open";Layout.columnSpan:sections.columns
                RowLayout {
                    Layout.fillWidth:true
                    CText { text:"Destination";color:Theme.muted;font.pixelSize:12 }
                    CSpinBox { id:workspace;objectName:"workspaceNumber";from:1;to:99;value:1;Accessible.name:"Destination workspace" }
                    CButton { text:"Switch";enabled:App.connected;onClicked:desktop.action("workspace.switch",{workspace:workspace.value},"Switched to workspace "+workspace.value) }
                }
                CText { text:"Select a window to focus it. Move sends it to workspace "+workspace.value+".";color:Theme.muted;font.pixelSize:12 }
                Repeater {
                    model:desktop.filteredWindows
                    RowLayout {
                        required property var modelData
                        id:windowRow;Layout.fillWidth:true;spacing:8
                        CActionRow { objectName:"desktopWindow";Layout.fillWidth:true;text:windowRow.modelData.title||windowRow.modelData.class||"Untitled window";detail:windowRow.modelData.class+" · Workspace "+(windowRow.modelData.workspace?.name||windowRow.modelData.workspace?.id||"—");mark:"▣";onClicked:desktop.action("windows.focus",{address:windowRow.modelData.address},"Window focused") }
                        CButton { text:"Move";help:"Move this window to workspace "+workspace.value;onClicked:desktop.action("windows.move",{address:windowRow.modelData.address,workspace:workspace.value},"Window moved to workspace "+workspace.value) }
                    }
                }
                CText { visible:!desktop.filteredWindows.length;text:desktop.windowsRequest>=0?"Loading open windows…":desktop.query?"No windows match your search.":"No application windows are open.";color:Theme.muted;font.pixelSize:12 }
            }
            CSection {
                title:"Applications";visible:desktop.showApps;hint:desktop.filteredApps.length+" available";Layout.columnSpan:sections.columns
                GridLayout {
                    Layout.fillWidth:true;columns:width>=600?2:1;columnSpacing:8;rowSpacing:8
                    Repeater {
                        model:desktop.filteredApps.slice(0,desktop.appLimit)
                        CActionRow { required property var modelData;objectName:"desktopApplication";Layout.fillWidth:true;Layout.preferredWidth:1;text:modelData.name;detail:"Open application";onClicked:desktop.action("apps.launch",{desktopId:modelData.id},modelData.name+" opened") }
                    }
                }
                CButton { visible:desktop.filteredApps.length>desktop.appLimit;Layout.fillWidth:true;text:"Show more applications ("+(desktop.filteredApps.length-desktop.appLimit)+" remaining)";onClicked:desktop.appLimit+=12 }
                CText { visible:!desktop.filteredApps.length;text:desktop.appsRequest>=0?"Loading applications…":"No applications found. Refresh to check again.";color:Theme.muted;font.pixelSize:12 }
            }
            CSection {
                title:"Saved scripts";visible:desktop.showScripts;Layout.preferredWidth:1
                Repeater {
                    model:desktop.filteredScripts
                    CActionRow { required property var modelData;Layout.fillWidth:true;text:modelData.name;detail:"Review and run";mark:"›_";onClicked:{scriptConfirm.script=modelData;scriptConfirm.open()} }
                }
                CText { visible:!desktop.filteredScripts.length;text:"Keep frequently used commands here. Add an executable and its arguments in Settings.";color:Theme.muted;font.pixelSize:12 }
                CButton { text:"Manage scripts";onClicked:desktop.settingsRequested() }
            }
            CSection {
                title:"Recent activity";visible:!desktop.query&&desktop.category===0;Layout.preferredWidth:1
                Repeater {
                    model:(App.state.activity||[]).slice(0,6)
                    RowLayout {
                        required property var modelData;id:activityRow;Layout.fillWidth:true
                        CText { text:(App.state.actions||[]).find(a=>a.name===activityRow.modelData.action)?.title||activityRow.modelData.action;font.pixelSize:12 }
                        Text { text:activityRow.modelData.status==="completed"?"Done":"Failed";color:activityRow.modelData.status==="failed"?Theme.danger:Theme.cyan;font.family:Theme.font;font.pixelSize:11 }
                    }
                }
                CText { visible:!(App.state.activity||[]).length;text:"Your completed desktop actions will appear here.";color:Theme.muted;font.pixelSize:12 }
            }
            CSection {
                visible:!desktop.showQuick&&!desktop.showAudio&&!desktop.showTimers&&!desktop.showWindows&&!desktop.showApps&&!desktop.showScripts
                title:"No matches";description:"Try an application name, window title, or a control such as volume or timer.";Layout.columnSpan:sections.columns
                CButton { text:"Clear search";onClicked:search.clear() }
            }
        }
    }
    Timer { id:volumeDebounce;interval:250;onTriggered:desktop.action("audio.volume",{percent:Math.round(volume.value)},"Volume updated") }
    Timer { interval:10000;running:desktop.visible&&desktop.Window.window&&desktop.Window.window.visible&&App.connected;repeat:true;onTriggered:desktop.audioRequest=App.rpc("audio.status") }
    Timer { interval:5000;running:desktop.visible&&desktop.Window.window&&desktop.Window.window.visible&&App.connected;repeat:true;onTriggered:desktop.refreshMedia() }
    Timer { id:mediaSettled;interval:300;onTriggered:desktop.refreshMedia() }
    Connections {
        target:App
        function onStateChanged() {
            if(!App.connected){desktop.catalogLoaded=false;desktop.appsRequest=-1;desktop.windowsRequest=-1;desktop.mediaRequest=-1;desktop.requests={}}
            else if(desktop.visible&&!desktop.catalogLoaded)desktop.refresh()
        }
        function onResult(id,value) {
            if(id===desktop.appsRequest){desktop.appsRequest=-1;if(value?.error)desktop.catalogError=value.error;else desktop.apps=value}
            if(id===desktop.windowsRequest){desktop.windowsRequest=-1;if(value?.error)desktop.catalogError=value.error;else desktop.windows=value}
            if(id===desktop.audioRequest&&!value?.error){desktop.audio=value;if(value.available&&!volume.pressed)volume.value=Math.min(100,value.percent)}
            if(id===desktop.mediaRequest){desktop.mediaRequest=-1;desktop.mediaError=value?.error||"";desktop.media=value?.error?({available:false}):value}
            const request=desktop.requests[id]
            if(!request)return
            const next=Object.assign({},desktop.requests);delete next[id];desktop.requests=next
            desktop.failed=!!value?.error;desktop.feedback=value?.error||value?.message||request.label
            if(request.name.startsWith("audio."))desktop.audioRequest=App.rpc("audio.status")
            if(request.name==="media.control")mediaSettled.restart()
            if(request.name==="windows.move")desktop.windowsRequest=App.rpc("windows.list")
            if(request.name==="screenshot.capture") {
                App.restorePanel()
                if(!value?.error&&value?.path){desktop.capturePath=value.path;capturePreview.open()}
            }
        }
    }
    CDialog {
        id:capturePreview;objectName:"capturePreview"
        CText { text:"Your capture";font.pixelSize:20;font.weight:Font.DemiBold }
        Image { source:desktop.capturePath?"file://"+desktop.capturePath:"";Layout.fillWidth:true;Layout.preferredHeight:Math.min(240,desktop.height*.4);fillMode:Image.PreserveAspectFit }
        CText { text:"Saved locally. Attach it to a conversation when you’re ready.";color:Theme.muted }
        GridLayout {
            Layout.fillWidth:true;columns:width>=380?3:1;columnSpacing:8;rowSpacing:8
            CButton { Layout.fillWidth:true;text:"Open file";onClicked:App.openPath(desktop.capturePath) }
            CButton { Layout.fillWidth:true;text:"Attach to chat";primary:true;enabled:!!App.session.id;onClicked:{App.attachImage(desktop.capturePath);capturePreview.close();App.notify("Image attached to the current chat draft")} }
            CButton { Layout.fillWidth:true;text:"Done";onClicked:capturePreview.close() }
        }
    }
    CDialog {
        id:scriptConfirm;property var script:({})
        CText { text:"Run "+(scriptConfirm.script.name||"script")+"?";font.pixelSize:20;font.weight:Font.DemiBold }
        CText { text:(scriptConfirm.script.executable||"")+"\n"+JSON.stringify(scriptConfirm.script.args||[])+"\n\n"+(scriptConfirm.script.cwd||"");color:Theme.muted;font.family:"monospace";font.pixelSize:12 }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";onClicked:scriptConfirm.close() }
            CButton { Layout.fillWidth:true;text:"Run script";primary:true;onClicked:{desktop.action("script.run",{id:scriptConfirm.script.id},"Script finished");scriptConfirm.close()} }
        }
    }
}
