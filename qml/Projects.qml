import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id:page
    objectName:"projectsPage"
    spacing:10
    property var projects:[]
    property int requestId:-1
    property bool refreshPending:false
    property bool loaded:false
    property bool startAfterSave:false
    property string draftSessionName:""
    property string error:""
    readonly property int catalogRevision:App.state.sessionCatalogRevision||0
    readonly property bool connected:App.connected
    readonly property var filtered:projects.filter(p=>!search.text.trim()||(p.name+" "+p.cwd+" "+p.defaults.provider).toLowerCase().includes(search.text.trim().toLowerCase()))
    signal sessionActivated()
    signal projectRequested(string cwd,bool archived)
    function focusSearch(){search.forceActiveFocus()}
    function refresh(){
        if(!visible||!App.connected)return
        if(requestId>=0){refreshPending=true;return}
        requestId=App.rpc("projects.list",{})
    }
    function edit(project,thenStart,sessionName){startAfterSave=!!thenStart;draftSessionName=sessionName||"";editor.editProject(projects.find(p=>p.cwd===project.cwd)||project)}
    function start(project){
        const d=project.defaults
        if(!project.configured||(!d.trusted&&!App.state.settings?.bypassCliPermissions&&(!["ollama","openai","anthropic","google"].includes(d.provider)||d.tools)))edit(project,true)
        else quick.start(project)
    }
    function newProjectSession(){if(filtered.length)start(filtered[Math.max(0,rows.currentIndex)]||filtered[0]);else edit({},false)}
    onVisibleChanged:if(visible)refresh()
    onConnectedChanged:if(connected)refresh()
    onCatalogRevisionChanged:refreshDelay.restart()
    Component.onCompleted:refresh()
    Timer { id:refreshDelay;interval:150;onTriggered:page.refresh() }
    // Keep working/unread counts current without querying on every streamed token.
    Timer { interval:5000;repeat:true;running:page.visible&&App.connected;onTriggered:page.refresh() }
    RowLayout {
        Layout.fillWidth:true
        CText { text:"Projects";font.pixelSize:Theme.page;font.weight:Font.DemiBold;Layout.fillWidth:true }
        CButton { objectName:"addProject";text:"Add project";iconName:"plus";enabled:App.connected;onClicked:page.edit({},false) }
    }
    CField {
        id:search;objectName:"projectSearch";Layout.fillWidth:true;placeholderText:"Find a project…";Accessible.name:"Find a project"
        onAccepted:if(page.filtered.length)page.projectRequested(page.filtered[0].cwd,page.filtered[0].sessions===0&&page.filtered[0].total>0)
        Keys.onDownPressed:{rows.forceActiveFocus();rows.currentIndex=0}
    }
    CText { visible:page.error.length>0;text:page.error;color:Theme.danger;font.pixelSize:Theme.secondary }
    CText { visible:!App.connected;text:"Reconnecting… Projects will refresh when Cere is connected.";color:Theme.amber;font.pixelSize:Theme.secondary }
    CText { visible:page.loaded&&!page.filtered.length;text:search.text.trim()?"No projects match this search.":"Add a project folder and save its defaults. Your existing session folders also appear here.";color:Theme.muted }
    ListView {
        id:rows;objectName:"projectRows";Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumHeight:60
        clip:true;spacing:6;model:page.filtered;reuseItems:true;currentIndex:-1
        activeFocusOnTab:true;keyNavigationEnabled:true
        Accessible.role:Accessible.List;Accessible.name:"Projects"
        ScrollBar.vertical:CScrollBar{}
        delegate:Rectangle {
            id:row
            required property var modelData
            required property int index
            width:rows.width;implicitHeight:92;radius:Theme.radiusCard
            color:row.ListView.isCurrentItem?Theme.raised:Theme.surface;border.color:row.ListView.isCurrentItem?Theme.line:Theme.subtle
            RowLayout {
                anchors.fill:parent;anchors.margins:8;spacing:4
                CButton {
                    id:projectButton;objectName:"projectOpen_"+row.index;Layout.fillWidth:true;Layout.fillHeight:true
                    quiet:true;leftPadding:4;rightPadding:4;help:row.modelData.cwd;Accessible.name:"Open "+row.modelData.name+" sessions"
                    onClicked:{rows.currentIndex=row.index;page.projectRequested(row.modelData.cwd,row.modelData.sessions===0&&row.modelData.total>0)}
                    contentItem:ColumnLayout {
                        spacing:4
                        RowLayout {
                            Layout.fillWidth:true;spacing:6
                            CIcon { name:row.modelData.favorite?"star":"projects";color:row.modelData.favorite?Theme.amber:Theme.cyan;Layout.preferredWidth:18;Layout.preferredHeight:18 }
                            Text { text:row.modelData.name;Layout.fillWidth:true;elide:Text.ElideRight;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.message;font.weight:Font.DemiBold }
                        }
                        Text { text:row.modelData.cwd;Layout.fillWidth:true;elide:Text.ElideMiddle;color:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption }
                        Text {
                            text:(row.modelData.sessions?row.modelData.sessions+" session"+(row.modelData.sessions===1?"":"s"):row.modelData.total?row.modelData.total+" archived":"No sessions")+(row.modelData.active?" · "+row.modelData.active+" active":"")+(row.modelData.unread?" · "+row.modelData.unread+" unread":"")+(!row.modelData.configured?" · Set defaults":" · "+row.modelData.defaults.provider)
                            Layout.fillWidth:true;elide:Text.ElideRight;color:row.modelData.unread?Theme.cyan:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption
                        }
                    }
                }
                CButton {
                    objectName:"projectSettings_"+row.index;implicitWidth:36;implicitHeight:36;quiet:true
                    help:"Settings for "+row.modelData.name;Accessible.name:help;enabled:App.connected
                    contentItem:CIcon { name:"settings";color:Theme.muted }
                    onClicked:{rows.currentIndex=row.index;page.edit(row.modelData,false)}
                }
                CButton {
                    objectName:"projectNew_"+row.index;implicitWidth:36;implicitHeight:36;primary:true
                    help:"New session in "+row.modelData.name;Accessible.name:help;enabled:App.connected
                    contentItem:CIcon { name:"plus";color:Theme.cyan }
                    onClicked:{rows.currentIndex=row.index;page.start(row.modelData)}
                }
            }
        }
        Keys.onReturnPressed:if(currentIndex>=0)page.projectRequested(page.filtered[currentIndex].cwd,page.filtered[currentIndex].sessions===0&&page.filtered[currentIndex].total>0)
        Keys.onEnterPressed:if(currentIndex>=0)page.projectRequested(page.filtered[currentIndex].cwd,page.filtered[currentIndex].sessions===0&&page.filtered[currentIndex].total>0)
    }
    CText { visible:page.height>350;text:"Favorites first · Ctrl+N starts a session in the selected project";color:Theme.muted;font.pixelSize:Theme.caption }
    NewSession {
        id:editor;objectName:"projectSettingsDialog";projectSettings:true
        onProjectSaved:value=>{page.refresh();if(page.startAfterSave)quick.start(Object.assign({},value,{configured:true}),page.draftSessionName)}
    }
    ProjectSession { id:quick;onSessionOpened:page.sessionActivated();onSettingsRequested:(value,name)=>page.edit(value,true,name) }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==page.requestId)return
            page.requestId=-1;page.loaded=true
            if(value?.error)page.error=value.error
            else{
                page.error=""
                if(JSON.stringify(page.projects)!==JSON.stringify(value.projects||[])){
                    const selected=page.filtered[rows.currentIndex]?.cwd
                    page.projects=value.projects||[]
                    rows.currentIndex=page.filtered.findIndex(p=>p.cwd===selected)
                }
            }
            if(page.refreshPending){page.refreshPending=false;page.refresh()}
        }
    }
}
