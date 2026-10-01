import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id:list
    property bool compact:false
    property bool activeOnly:false
    property bool historyExpanded:false
    property string selectedFilter:"all"
    property bool projectArchived:false
    property var remoteSessions:[]
    property bool remoteLoaded:false
    property var nextPage:null
    property int totalSessions:App.state.sessionCount||(App.state.sessions||[]).length
    property int listRequest:-1
    property bool loadingMore:false
    property int catalogSeen:-1
    property int catalogRequested:-1
    Timer { id:catalogRefresh;interval:100;onTriggered:list.refresh(true) }
    property var organizeRequests:({})
    property var history:[]
    property int historyRequest:-1
    property string error:""
    property string contextSessionId:""
    property string folderSessionId:""
    readonly property var contextSession:sessionById(contextSessionId)
    function sessionById(id){return sourceSessions.find(session=>session.id===id)||(App.state.sessions||[]).find(session=>session.id===id)||({})}
    function openSessionMenu(session,source,x,y){
        if(!session?.id)return
        contextSessionId=session.id
        const position=source.mapToItem(list,x,y)
        sessionMenu.popup(list,position)
    }
    function contextKey(event,session,source){
        if(event.key===Qt.Key_Menu||(event.key===Qt.Key_F10&&(event.modifiers&Qt.ShiftModifier))){
            openSessionMenu(session,source,source.width/2,source.height/2);event.accepted=true
        }
    }
    signal createRequested()
    signal sessionActivated()

    readonly property var folders:(App.state.folders||[]).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)))
    readonly property var sourceSessions:remoteLoaded?remoteSessions.map(remote=>{
        const live=(App.state.sessions||[]).find(session=>session.id===remote.id)
        return live?Object.assign({},remote,live):remote
    }):(App.state.sessions||[])
    readonly property var projects:Array.from(new Set(sourceSessions.map(session=>session.cwd).concat(selectedFilter.startsWith("project:")?[selectedFilter.substring(8)]:[]).filter(path=>!!path))).sort()
    readonly property var filterOptions:[
        {id:"all",label:"All sessions"},{id:"unread",label:"Unread"},{id:"working",label:"Working"},{id:"pinned",label:"Pinned"},
        {id:"unfiled",label:"Unfiled"},{id:"archived",label:"Archived"}
    ].concat(projects.map(path=>({id:"project:"+path,label:"Project · "+projectName(path),value:path})))
     .concat(folders.map(folder=>({id:"folder:"+folder.id,label:"Folder · "+folder.name,value:folder.id})))
    readonly property var filtered:sourceSessions.filter(session=>{
        const query=filter.text.trim().toLowerCase()
        const matches=!query||(String(session.title||"")+" "+String(session.cwd||"")+" "+String(session.provider||"")).toLowerCase().indexOf(query)>=0
        const working=["starting","working","waiting","stopping"].indexOf(session.status)>=0
        return matches&&(selectedFilter!=="unread"||session.unread===true)&&(!activeOnly||working)&&(selectedFilter!=="working"||working)
    })

    ListModel { id:sessionRows;dynamicRoles:true }
    property bool rowsReady:false
    function syncRows(){
        if(!rowsReady)return
        const desired=filtered
        for(let i=0;i<desired.length;i++){
            let found=-1
            for(let j=i;j<sessionRows.count;j++)if(sessionRows.get(j).sessionKey===desired[i].id){found=j;break}
            if(found<0)sessionRows.insert(i,{sessionKey:desired[i].id,entry:desired[i]})
            else {if(found!==i)sessionRows.move(found,i,1);sessionRows.setProperty(i,"entry",desired[i])}
        }
        if(sessionRows.count>desired.length)sessionRows.remove(desired.length,sessionRows.count-desired.length)
    }
    onFilteredChanged:syncRows()
    function projectName(path) {
        const pieces=String(path).split("/").filter(part=>part.length>0)
        return pieces.length?pieces[pieces.length-1]:path
    }
    function focusSearch(){filter.forceActiveFocus()}
    function setFilter(id){selectedFilter=id;projectArchived=false;activeOnly=id==="working";refresh(true)}
    function selectProject(cwd,archived){filter.text="";selectedFilter="project:"+cwd;projectArchived=!!archived;activeOnly=false;refresh(true);focusSearch()}
    function selectFolder(id){setFilter("folder:"+id)}
    function requestParams(before) {
        const params={limit:compact?24:60}
        const query=filter.text.trim()
        if(query)params.filter=query
        if(before)params.before=before
        params.archived=selectedFilter==="archived"||(selectedFilter.startsWith("project:")&&projectArchived)
        if(selectedFilter==="unread")params.unread=true
        if(selectedFilter==="pinned")params.pinned=true
        else if(selectedFilter==="unfiled")params.folderId=null
        else if(selectedFilter.startsWith("folder:"))params.folderId=selectedFilter.substring(7)
        else if(selectedFilter.startsWith("project:"))params.cwd=selectedFilter.substring(8)
        return params
    }
    function refresh(reset) {
        if(!App.connected)return
        if(reset===undefined)reset=true
        if(reset){nextPage=null;loadingMore=false}
        else if(!nextPage||listRequest>=0)return
        const request=App.rpc("sessions.list",requestParams(reset?null:nextPage))
        if(request<0)return
        listRequest=request;loadingMore=!reset;catalogRequested=App.state.sessionCatalogRevision||0
    }
    function activate(session) {
        if(!session?.id)return
        App.selectedId=session.id
        App.rpc("session.read",{id:session.id})
        App.rpc("navigation.record",{id:"session:"+session.id})
        sessionActivated()
    }
    function organize(session,patch) {
        if(!session?.id)return
        error=""
        const params=Object.assign({id:session.id},patch)
        if(session.revision!==undefined)params.expectedRevision=session.revision
        const request=App.rpc("session.organize",params)
        if(request<0)return
        const pending=Object.assign({},organizeRequests);pending[request]=session.id;organizeRequests=pending
    }
    function activeAgentCount(session){return(session.agents||[]).filter(agent=>["starting","running","waiting"].indexOf(agent.status)>=0).length}
    function pendingInputCount(session){return(App.state.approvals||[]).filter(approval=>approval.sessionId===session.id).length}
    function statusLabel(session) {
        const pending=pendingInputCount(session),active=activeAgentCount(session)
        if(pending)return pending===1?"waiting for input":pending+" inputs needed"
        if(active)return active===1?"1 subagent active":active+" subagents active"
        switch(session.activity){
        case"thinking":return"thinking";case"speaking":return"responding";case"working":return"using tools"
        case"delegating":return"delegating";case"waitingForAgents":return"waiting for subagents"
        case"compacting":return"compacting context";case"planning":return"planning"
        default:return session.mode==="linked"&&session.status==="idle"?"linked terminal":session.status
        }
    }

    spacing:compact?10:14
    RowLayout {
        Layout.fillWidth:true
        CText { text:list.compact?"RECENT SESSIONS":"Sessions";color:list.compact?Theme.muted:Theme.text;font.pixelSize:list.compact?10:26;font.letterSpacing:list.compact?1.4:0;font.weight:Font.DemiBold }
        Text { visible:list.compact;text:list.totalSessions;color:Theme.muted;font.family:Theme.font;font.pixelSize:11 }
        CButton { visible:!list.compact;objectName:"newSession";text:"New session";iconName:"plus";primary:true;onClicked:list.createRequested() }
    }
    CText { visible:!list.compact&&list.height>=420;text:"Pick up where you left off, or organize conversations by project and folder.";color:Theme.muted }
    CField {
        id:filter;objectName:list.compact?"sidebarSessionSearch":"sessionSearch"
        placeholderText:"Find a session…";Layout.fillWidth:true;Accessible.name:"Find a session"
        onTextChanged:searchDelay.restart()
        onAccepted:if(list.filtered.length)list.activate(list.filtered[0])
        Keys.onDownPressed:event=>{sessionViewport.currentIndex=Math.max(0,sessionViewport.currentIndex);sessionViewport.forceActiveFocus();event.accepted=true}
    }
    Timer { id:searchDelay;interval:220;onTriggered:list.refresh(true) }
    RowLayout {
        visible:!list.compact;Layout.fillWidth:true;spacing:8
        CComboBox {
            id:filterPicker;objectName:"sessionFilter";Layout.fillWidth:true
            model:list.filterOptions;textRole:"label";Accessible.name:"Filter sessions"
            currentIndex:Math.max(0,list.filterOptions.findIndex(option=>option.id===list.selectedFilter))
            onActivated:if(currentIndex>=0)list.setFilter(list.filterOptions[currentIndex].id)
        }
        CButton { objectName:"createFolder";text:"New folder";iconName:"plus";onClicked:folderDialog.createFolder() }
    }
    RowLayout {
        visible:!list.compact&&list.folders.length>0;Layout.fillWidth:true;spacing:8
        CComboBox { id:folderPicker;objectName:"folderPicker";Layout.fillWidth:true;model:list.folders;textRole:"name";Accessible.name:"Folder to manage" }
        CButton { text:"Rename";enabled:folderPicker.currentIndex>=0;onClicked:folderDialog.renameFolder(list.folders[folderPicker.currentIndex]) }
        CButton { text:"Delete";danger:true;enabled:folderPicker.currentIndex>=0;onClicked:folderDialog.deleteFolder(list.folders[folderPicker.currentIndex]) }
    }
    CCheckBox { visible:!list.compact&&list.selectedFilter.startsWith("project:");text:"Show archived sessions in this project";checked:list.projectArchived;onClicked:{list.projectArchived=checked;list.refresh(true)} }
    ListView {
        id:sessionViewport
        objectName:list.compact?"sidebarSessionList":"sessionList"
        Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumHeight:48
        clip:true;spacing:6;boundsBehavior:Flickable.StopAtBounds
        activeFocusOnTab:true;keyNavigationEnabled:true
        Accessible.role:Accessible.List;Accessible.name:"Sessions"
        ScrollBar.vertical:CScrollBar{}
        model:sessionRows
        Keys.onUpPressed:event=>{currentIndex=Math.max(0,currentIndex-1);positionViewAtIndex(currentIndex,ListView.Contain);event.accepted=true}
        Keys.onDownPressed:event=>{currentIndex=Math.min(count-1,currentIndex+1);positionViewAtIndex(currentIndex,ListView.Contain);event.accepted=true}
        Keys.onReturnPressed:event=>{if(currentIndex>=0)list.activate(list.filtered[currentIndex]);event.accepted=true}
        Keys.onEnterPressed:event=>{if(currentIndex>=0)list.activate(list.filtered[currentIndex]);event.accepted=true}
        Keys.onPressed:event=>{if(currentItem)list.contextKey(event,currentItem.modelData,currentItem)}
        delegate:Item {
            id:sessionDelegate
            required property var entry
            property var modelData:entry
            required property int index
            width:sessionViewport.width-10;height:list.compact?72:116
            CButton {
                id:sessionRow
                objectName:"session_"+sessionDelegate.modelData.id
                anchors.left:parent.left;anchors.right:parent.right;anchors.top:parent.top
                height:list.compact?72:76
                text:sessionDelegate.modelData.title||"Untitled session";quiet:true
                primary:App.selectedId===sessionDelegate.modelData.id
                help:(sessionDelegate.modelData.title||"Untitled session")+"\n"+sessionDelegate.modelData.provider+" · "+list.statusLabel(sessionDelegate.modelData)+"\n"+(sessionDelegate.modelData.cwd||"")
                Accessible.name:(sessionDelegate.modelData.title||"Untitled session")+", "+sessionDelegate.modelData.provider+", "+list.statusLabel(sessionDelegate.modelData)
                Accessible.selected:App.selectedId===sessionDelegate.modelData.id
                onClicked:{sessionViewport.currentIndex=sessionDelegate.index;list.activate(sessionDelegate.modelData)}
                Keys.onPressed:event=>list.contextKey(event,sessionDelegate.modelData,sessionRow)
                MouseArea {
                    anchors.fill:parent;acceptedButtons:Qt.RightButton
                    onClicked:mouse=>list.openSessionMenu(sessionDelegate.modelData,sessionRow,mouse.x,mouse.y)
                }
                contentItem:ColumnLayout {
                    spacing:5
                    RowLayout {
                        Layout.fillWidth:true;spacing:8
                        Text { visible:sessionDelegate.modelData.pinned===true;text:"★";color:Theme.amber;font.pixelSize:13;Accessible.ignored:true }
                        Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:(sessionDelegate.modelData.unread?"● ":"")+(sessionDelegate.modelData.title||"Untitled session");maximumLineCount:1;elide:Text.ElideRight;color:Theme.text;font.family:Theme.font;font.pixelSize:13;font.weight:Font.Medium;textFormat:Text.PlainText }
                        Rectangle { width:6;height:6;radius:3;color:list.pendingInputCount(sessionDelegate.modelData)>0?Theme.amber:["starting","working","stopping"].indexOf(sessionDelegate.modelData.status)>=0?Theme.cyan:Theme.line }
                    }
                    Text { Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideRight;text:sessionDelegate.modelData.provider.charAt(0).toUpperCase()+sessionDelegate.modelData.provider.slice(1)+" · "+list.statusLabel(sessionDelegate.modelData);color:Theme.muted;font.family:Theme.font;font.pixelSize:11 }
                    Text { visible:!list.compact;Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideMiddle;text:sessionDelegate.modelData.cwd||"";color:Theme.muted;font.family:Theme.font;font.pixelSize:11;textFormat:Text.PlainText }
                }
            }
            RowLayout {
                visible:!list.compact;anchors.left:parent.left;anchors.right:parent.right;anchors.bottom:parent.bottom;height:36;spacing:6
                CButton { objectName:"pinSession_"+sessionDelegate.modelData.id;text:sessionDelegate.modelData.pinned?"Unpin":"Pin";help:"Pinned replies appear beside Cere and are read aloud when voice is enabled.";quiet:true;implicitHeight:32;onClicked:list.organize(sessionDelegate.modelData,{pinned:!sessionDelegate.modelData.pinned}) }
                CComboBox {
                    objectName:"moveSession_"+sessionDelegate.modelData.id;Layout.fillWidth:true;implicitHeight:32
                    model:[{id:"",name:"Unfiled"}].concat(list.folders);textRole:"name";valueRole:"id"
                    Accessible.name:"Move "+(sessionDelegate.modelData.title||"session")+" to folder"
                    currentIndex:Math.max(0,model.findIndex(folder=>folder.id===(sessionDelegate.modelData.folderId||"")))
                    onActivated:list.organize(sessionDelegate.modelData,{folderId:currentValue||null})
                }
                CButton { objectName:"archiveSession_"+sessionDelegate.modelData.id;text:sessionDelegate.modelData.archived?"Unarchive":"Archive";quiet:true;implicitHeight:32;onClicked:list.organize(sessionDelegate.modelData,{archived:!sessionDelegate.modelData.archived}) }
            }
        }
        CText {
            visible:!list.filtered.length&&list.listRequest<0;width:parent.width-12;anchors.top:parent.top;anchors.topMargin:12
            text:filter.text?"No sessions match your search.":list.selectedFilter==="working"?"All caught up. No sessions are working.":"No sessions in this view."
            color:Theme.muted;font.pixelSize:12
        }
        footer:CButton { visible:list.nextPage!==null;width:sessionViewport.width-10;text:list.loadingMore?"Loading…":"Load more";enabled:!list.loadingMore;onClicked:list.refresh(false) }
    }
    CText { visible:list.listRequest>=0&&list.filtered.length===0;text:"Loading sessions…";color:Theme.muted;font.pixelSize:12 }
    CText { visible:list.error.length>0;text:list.error;color:Theme.danger;font.pixelSize:12 }
    CButton { Layout.fillWidth:true;quiet:true;alignLeft:true;iconName:"sessions";text:list.historyExpanded?"Hide terminal history":"Import terminal session";help:"Continue a completed Codex or Claude conversation";onClicked:list.historyExpanded=!list.historyExpanded }
    ColumnLayout {
        visible:list.historyExpanded;Layout.fillWidth:true;spacing:8
        CText { text:list.historyRequest>=0?"Loading history…":"Continue a completed conversation.";color:Theme.muted;font.pixelSize:11 }
        RowLayout {
            Layout.fillWidth:true;spacing:6
            CButton { text:"Codex";Layout.fillWidth:true;enabled:list.historyRequest<0&&App.connected;onClicked:{list.error="";list.historyRequest=App.rpc("session.history",{provider:"codex"})} }
            CButton { text:"Claude";Layout.fillWidth:true;enabled:list.historyRequest<0&&App.connected;onClicked:{list.error="";list.historyRequest=App.rpc("session.history",{provider:"claude"})} }
        }
        PageScroll { visible:list.history.length>0;Layout.fillWidth:true;Layout.preferredHeight:Math.min(220,list.height*.35);Repeater { model:list.history;CActionRow { required property var modelData;Layout.fillWidth:true;text:modelData.title;detail:modelData.cwd||"Continue this conversation";onClicked:{importSession.imported=modelData;importSession.open()} } } }
    }
    Menu {
        id:sessionMenu;objectName:"sessionContextMenu";parent:list;focus:true
        delegate:MenuItem { objectName:subMenu===folderMenu?"sessionContextFolderMenuItem":"" }
        enabled:App.connected&&!!list.contextSession.id
        MenuItem { objectName:"sessionContextOpen";text:"Open conversation";onTriggered:list.activate(list.contextSession) }
        MenuItem { objectName:"sessionContextRename";text:"Rename…";onTriggered:renameSession.openFor(list.contextSession) }
        MenuSeparator {}
        Menu {
            id:folderMenu;objectName:"sessionContextFolders";title:list.contextSession.folderId?"Move to folder":"Add to folder"
            Instantiator {
                model:list.folders
                delegate:MenuItem {
                    required property var modelData
                    objectName:"sessionContextFolder_"+modelData.id;text:modelData.name
                    checkable:true;checked:list.contextSession.folderId===modelData.id
                    onTriggered:list.organize(list.contextSession,{folderId:modelData.id})
                }
                onObjectAdded:(index,object)=>folderMenu.insertItem(index,object)
                onObjectRemoved:(index,object)=>folderMenu.removeItem(object)
            }
            MenuSeparator { visible:list.folders.length>0 }
            MenuItem { objectName:"sessionContextNewFolder";text:"New folder…";onTriggered:{list.folderSessionId=list.contextSessionId;folderDialog.createFolder()} }
        }
        MenuItem { objectName:"sessionContextUnfile";text:"Remove from folder";enabled:!!list.contextSession.folderId;onTriggered:list.organize(list.contextSession,{folderId:null}) }
        MenuSeparator {}
        MenuItem { objectName:"sessionContextPin";text:list.contextSession.pinned?"Unpin":"Pin";onTriggered:list.organize(list.contextSession,{pinned:!list.contextSession.pinned}) }
        MenuItem { objectName:"sessionContextArchive";text:list.contextSession.archived?"Unarchive":"Archive";onTriggered:list.organize(list.contextSession,{archived:!list.contextSession.archived}) }
    }
    CDialog {
        id:renameSession;objectName:"sessionContextRenameDialog"
        property string sessionId:""
        property string error:""
        property int requestId:-1
        function openFor(session){sessionId=session.id;sessionTitle.text=session.title||"";error="";open()}
        function save(){if(requestId<0&&App.connected)requestId=App.rpc("session.rename",{id:sessionId,title:sessionTitle.text.trim()||"Untitled session"})}
        onOpened:{sessionTitle.forceActiveFocus();sessionTitle.selectAll()}
        closePolicy:requestId>=0?Popup.NoAutoClose:Popup.CloseOnEscape|Popup.CloseOnPressOutside
        CText { text:"Rename session";font.pixelSize:22;font.weight:Font.DemiBold }
        CField { id:sessionTitle;objectName:"sessionContextTitle";Layout.fillWidth:true;maximumLength:100;Accessible.name:"Session title";onAccepted:renameSession.save() }
        CText { visible:renameSession.error.length>0;text:renameSession.error;color:Theme.danger }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;enabled:renameSession.requestId<0;onClicked:renameSession.close() }
            CButton { objectName:"sessionContextSaveTitle";text:renameSession.requestId>=0?"Saving…":"Save title";primary:true;Layout.fillWidth:true;enabled:App.connected&&renameSession.requestId<0;onClicked:renameSession.save() }
        }
        Connections {
            target:App
            function onResult(id,value){if(id!==renameSession.requestId)return;renameSession.requestId=-1;if(value?.error)renameSession.error=value.error;else{renameSession.close();list.refresh(true)}}
        }
    }
    FolderDialog {
        id:folderDialog
        onSaved:folder=>{
            list.error=""
            if(list.folderSessionId)list.organize(list.sessionById(list.folderSessionId),{folderId:folder.id})
            else list.selectFolder(folder.id)
        }
        onClosed:list.folderSessionId=""
        onDeleted:id=>{if(list.selectedFilter==="folder:"+id)list.setFilter("unfiled");else list.refresh(true)}
    }
    Connections {
        target:App
        function onStateChanged(){if(App.connected&&list.visible&&list.catalogSeen!==(App.state.sessionCatalogRevision||0))catalogRefresh.restart()}
        function onResult(id,value) {
            if(id===list.listRequest){
                const append=list.loadingMore
                list.listRequest=-1;list.loadingMore=false
                if(value?.error){list.error=value.error;return}
                const rows=value?.sessions||value||[]
                list.remoteSessions=append?list.remoteSessions.concat(rows):rows
                list.remoteLoaded=true;list.catalogSeen=list.catalogRequested;list.nextPage=value?.next||null
                if(list.catalogSeen!==(App.state.sessionCatalogRevision||0))catalogRefresh.restart()
                if(value?.total!==undefined)list.totalSessions=value.total
            }
            if(id===list.historyRequest){list.historyRequest=-1;if(value?.error)list.error=value.error;else list.history=value}
            if(list.organizeRequests[id]!==undefined){
                const pending=Object.assign({},list.organizeRequests);delete pending[id];list.organizeRequests=pending
                if(value?.error)list.error=value.error;else list.refresh(true)
            }
        }
    }
    onVisibleChanged:if(visible&&(!remoteLoaded||catalogSeen!==(App.state.sessionCatalogRevision||0)))refresh(true)
    Component.onCompleted:{rowsReady=true;syncRows();if(visible)refresh(true)}
    NewSession { id:importSession;onSessionOpened:list.sessionActivated() }
}
