import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Popup {
    id:rootPalette
    objectName:"commandPalette"
    parent:Overlay.overlay
    anchors.centerIn:parent
    width:Math.min(680,parent?parent.width-28:680)
    height:Math.min(600,parent?parent.height-28:600)
    modal:true;dim:true;focus:true;padding:16;margins:14
    closePolicy:Popup.CloseOnEscape|Popup.CloseOnPressOutside
    background:Rectangle { color:Theme.surface;radius:16;border.color:"#36536a" }
    Overlay.modal:Rectangle { color:"#b304090f" }

    signal sessionRequested(string id)
    signal folderRequested(string id)
    signal settingsRequested(string section)
    signal pageRequested(int page)
    signal desktopRequested(string query)

    property var apps:[]
    property var windows:[]
    property int appsRequest:-1
    property int windowsRequest:-1
    property int searchRequest:-1
    property string searchRequestQuery:""
    property var brokerEntries:[]
    property string error:""
    readonly property string query:search.text.trim().toLowerCase()
    readonly property var navigation:App.state.navigation||({favorites:[],recents:[]})
    readonly property var favorites:navigation.favorites||[]
    readonly property var recents:navigation.recents||[]
    readonly property var settingsEntries:[
        {label:"Companion",detail:"window, size, roaming, login"},{label:"Personality",detail:"tone and response style"},
        {label:"Voice",detail:"speech and Piper voices"},{label:"Motion & expressions",detail:"animation, quiet mode, previews"},
        {label:"Cere Mobile",detail:"pairing and remote access"},{label:"AI assistance",detail:"permissions, categories, grants"},
        {label:"Saved scripts",detail:"commands and working folders"},{label:"Connections",detail:"Ollama, Codex, Claude"},
        {label:"Web search & memory",detail:"search providers and recall"},{label:"Application",detail:"shortcut and quit"}
    ]
    readonly property var allEntries:buildEntries().concat(brokerEntries||[])
    readonly property var results:rankedEntries()

    function buildEntries() {
        let entries=[
            {id:"page:chat",kind:"page",title:"Chat",detail:"Open the current conversation",page:0},
            {id:"page:sessions",kind:"page",title:"Sessions",detail:"Browse and organize conversations",page:1},
            {id:"page:desktop",kind:"page",title:"Desktop",detail:"Actions, apps, and windows",page:2},
            {id:"page:settings",kind:"page",title:"Settings",detail:"Configure Cere",page:3},
            {id:"page:projects",kind:"page",title:"Projects",detail:"Project folders, defaults and quick sessions",page:4}
        ]
        entries=entries.concat((App.state.sessions||[]).map(session=>({
            id:"session:"+session.id,kind:"session",title:session.title||"Untitled session",
            detail:(session.provider||"")+" · "+(session.cwd||""),search:(session.title||"")+" "+(session.cwd||"")+" "+(session.provider||""),value:session.id
        })))
        entries=entries.concat((App.state.folders||[]).map(folder=>({id:"folder:"+folder.id,kind:"folder",title:folder.name,detail:"Session folder",value:folder.id})))
        entries=entries.concat(settingsEntries.map(section=>({id:"settings:"+section.label,kind:"settings",title:section.label,detail:section.detail,value:section.label})))
        entries=entries.concat((App.state.actions||[]).map(action=>({
            id:"action:"+action.name,kind:"action",title:action.title||action.name,detail:action.description||action.category||"Desktop action",search:(action.title||"")+" "+(action.name||"")+" "+(action.description||"")
        })))
        entries=entries.concat(apps.map(app=>({id:"app:"+app.id,kind:"app",title:app.name,detail:"Application · review in Desktop",search:(app.name||"")+" "+(app.id||"")})))
        entries=entries.concat(windows.map(window=>({id:"window:"+window.address,kind:"window",title:window.title||window.class||"Untitled window",detail:(window.class||"Window")+" · review in Desktop",search:(window.title||"")+" "+(window.class||"")})))
        entries=entries.concat((App.state.settings?.scripts||[]).map(script=>({id:"script:"+script.id,kind:"script",title:script.name,detail:"Saved script · review before running",value:script})))
        return entries
    }
    function rankedEntries() {
        const seen={}
        let matches=allEntries.filter(entry=>{
            if(seen[entry.id])return false
            seen[entry.id]=true
            if(!query){const destination=destinationId(entry);return favorites.indexOf(destination)>=0||recents.indexOf(destination)>=0||entry.kind==="page"||entry.kind==="bookmark"}
            return (entry.search||entry.title+" "+entry.detail+" "+entry.kind).toLowerCase().indexOf(query)>=0
        })
        matches.sort((a,b)=>{
            const destinationA=destinationId(a),destinationB=destinationId(b)
            const favoriteA=favorites.indexOf(destinationA),favoriteB=favorites.indexOf(destinationB)
            if((favoriteA>=0)!==(favoriteB>=0))return favoriteA>=0?-1:1
            if(favoriteA>=0&&favoriteA!==favoriteB)return favoriteA-favoriteB
            const recentA=recents.indexOf(destinationA),recentB=recents.indexOf(destinationB)
            if((recentA>=0)!==(recentB>=0))return recentA>=0?-1:1
            if(recentA>=0&&recentA!==recentB)return recentA-recentB
            if(query){
                const titleA=a.title.toLowerCase(),titleB=b.title.toLowerCase()
                const exactA=titleA===query?0:titleA.startsWith(query)?1:2,exactB=titleB===query?0:titleB.startsWith(query)?1:2
                if(exactA!==exactB)return exactA-exactB
                const kinds={bookmark:0,capsule:1,transcript:2,settings:3,session:4,folder:5,project:6,page:7,action:8,app:9,window:10,script:11}
                const kindA=kinds[a.kind]===undefined?20:kinds[a.kind],kindB=kinds[b.kind]===undefined?20:kinds[b.kind]
                if(kindA!==kindB)return kindA-kindB
            }
            return a.title.localeCompare(b.title)
        })
        return matches.slice(0,80)
    }
    function destinationId(entry){return entry?.navigationId||entry?.id||""}
    function scheduleSearch(){brokerEntries=[];searchDelay.restart()}
    function requestBrokerSearch(){
        searchDelay.stop()
        if(!App.connected){searchRequest=-1;return}
        searchRequestQuery=query
        searchRequest=App.rpc("navigation.search",{query:searchRequestQuery,tag:searchRequestQuery,limit:80})
    }
    function openPalette() {
        error="";search.text="";brokerEntries=[];open();refreshCatalog();requestBrokerSearch()
        Qt.callLater(()=>search.forceActiveFocus())
    }
    onClosed:searchDelay.stop()
    function refreshCatalog() {
        if(!App.connected)return
        if(appsRequest<0)appsRequest=App.rpc("apps.list")
        if(windowsRequest<0)windowsRequest=App.rpc("windows.list")
    }
    function activate(entry) {
        if(!entry)return
        App.rpc("navigation.record",{id:destinationId(entry)})
        if(entry.kind==="session")sessionRequested(entry.value)
        else if(entry.kind==="transcript"||entry.kind==="bookmark")sessionRequested(entry.sessionId||entry.value)
        else if(entry.kind==="project"||entry.kind==="capsule")App.rpc("action.run",{name:"files.open",args:{path:entry.cwd}})
        else if(entry.kind==="folder")folderRequested(entry.value)
        else if(entry.kind==="settings")settingsRequested(entry.value)
        else if(entry.kind==="page")pageRequested(entry.page)
        else if(entry.kind==="script"){
            scriptReview.script=entry.value
            close();Qt.callLater(()=>scriptReview.open())
            return
        } else desktopRequested(entry.title)
        close()
    }
    function toggleFavorite(entry) {
        const id=destinationId(entry);App.rpc("navigation.favorite",{id:id,favorite:favorites.indexOf(id)<0})
    }

    Timer { id:searchDelay;interval:180;repeat:false;onTriggered:rootPalette.requestBrokerSearch() }
    function moveSelection(amount) {
        if(!results.length)return
        resultList.currentIndex=Math.max(0,Math.min(results.length-1,resultList.currentIndex+amount))
        resultList.positionViewAtIndex(resultList.currentIndex,ListView.Contain)
    }

    contentItem:ColumnLayout {
        spacing:10
        RowLayout {
            Layout.fillWidth:true
            CIcon { name:"search";Layout.preferredWidth:22;Layout.preferredHeight:22;color:Theme.cyan }
            CField {
                id:search;objectName:"commandPaletteSearch";Layout.fillWidth:true
                placeholderText:"Search sessions, folders, settings, or desktop…";Accessible.name:"Command palette search"
                onTextChanged:{resultList.currentIndex=rootPalette.results.length?0:-1;rootPalette.scheduleSearch()}
                onAccepted:if(resultList.currentIndex>=0)rootPalette.activate(rootPalette.results[resultList.currentIndex])
                Keys.onDownPressed:event=>{rootPalette.moveSelection(1);event.accepted=true}
                Keys.onUpPressed:event=>{rootPalette.moveSelection(-1);event.accepted=true}
            }
            CButton { text:"Close";quiet:true;onClicked:rootPalette.close() }
        }
        CText {
            text:rootPalette.query?rootPalette.results.length+" result"+(rootPalette.results.length===1?"":"s"):"Favorites and recent destinations"
            color:Theme.muted;font.pixelSize:11
        }
        ListView {
            id:resultList;objectName:"commandPaletteResults"
            Layout.fillWidth:true;Layout.fillHeight:true;clip:true;spacing:5
            model:rootPalette.results;currentIndex:count?0:-1
            activeFocusOnTab:true;keyNavigationEnabled:true
            Accessible.role:Accessible.List;Accessible.name:"Command palette results"
            ScrollBar.vertical:CScrollBar{}
            Keys.onReturnPressed:event=>{if(currentIndex>=0)rootPalette.activate(rootPalette.results[currentIndex]);event.accepted=true}
            Keys.onEnterPressed:event=>{if(currentIndex>=0)rootPalette.activate(rootPalette.results[currentIndex]);event.accepted=true}
            delegate:RowLayout {
                id:resultRow
                required property var modelData
                required property int index
                width:resultList.width-10;spacing:6
                CButton {
                    objectName:"command_"+resultRow.modelData.id.replace(/[^a-zA-Z0-9_-]/g,"_")
                    Layout.fillWidth:true;implicitHeight:56;quiet:true;alignLeft:true
                    text:resultRow.modelData.title
                    help:resultRow.modelData.detail
                    Accessible.name:resultRow.modelData.title+", "+resultRow.modelData.detail
                    onClicked:{resultList.currentIndex=resultRow.index;rootPalette.activate(resultRow.modelData)}
                    contentItem:ColumnLayout {
                        spacing:3
                        Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:resultRow.modelData.title;color:Theme.text;font.family:Theme.font;font.pixelSize:13;font.weight:Font.Medium;elide:Text.ElideRight;textFormat:Text.PlainText }
                        Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:resultRow.modelData.detail;color:Theme.muted;font.family:Theme.font;font.pixelSize:11;elide:Text.ElideMiddle;textFormat:Text.PlainText }
                    }
                }
                CButton {
                    objectName:"favorite_"+resultRow.modelData.id.replace(/[^a-zA-Z0-9_-]/g,"_")
                    text:rootPalette.favorites.indexOf(rootPalette.destinationId(resultRow.modelData))>=0?"★":"☆";quiet:true
                    help:rootPalette.favorites.indexOf(rootPalette.destinationId(resultRow.modelData))>=0?"Remove from favorites":"Add to favorites"
                    Accessible.name:help
                    onClicked:rootPalette.toggleFavorite(resultRow.modelData)
                }
            }
            CText { visible:resultList.count===0;width:parent.width;text:rootPalette.query?"No matching destination.":"Search to find anything in Cere.";color:Theme.muted;horizontalAlignment:Text.AlignHCenter }
        }
        CText { visible:rootPalette.error.length>0;text:rootPalette.error;color:Theme.danger;font.pixelSize:12 }
        CText { text:"↑ ↓ navigate  ·  Enter open  ·  Esc close";color:Theme.muted;font.pixelSize:11;horizontalAlignment:Text.AlignRight }
    }

    CDialog {
        id:scriptReview;objectName:"commandScriptReview";property var script:({});property int requestId:-1;property string error:""
        onOpened:error=""
        CText { text:"Run "+(scriptReview.script.name||"saved script")+"?";font.pixelSize:20;font.weight:Font.DemiBold }
        CText { text:"Executable";color:Theme.muted;font.pixelSize:11 }
        CText { text:scriptReview.script.executable||"";font.family:"monospace";font.pixelSize:12 }
        CText { text:"Arguments";color:Theme.muted;font.pixelSize:11 }
        CText { text:JSON.stringify(scriptReview.script.args||[]);font.family:"monospace";font.pixelSize:12 }
        CText { text:"Working folder";color:Theme.muted;font.pixelSize:11 }
        CText { text:scriptReview.script.cwd||"";font.family:"monospace";font.pixelSize:12 }
        CText { visible:scriptReview.error.length>0;text:scriptReview.error;color:Theme.danger;font.pixelSize:12 }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";enabled:scriptReview.requestId<0;onClicked:scriptReview.close() }
            CButton {
                objectName:"commandRunScript";Layout.fillWidth:true;text:scriptReview.requestId>=0?"Running…":"Run script";primary:true
                enabled:scriptReview.requestId<0&&App.connected
                onClicked:scriptReview.requestId=App.rpc("action.run",{name:"script.run",args:{id:scriptReview.script.id},expectedScript:scriptReview.script})
            }
        }
    }
    Connections {
        target:App
        function onResult(id,value) {
            if(id===rootPalette.appsRequest){rootPalette.appsRequest=-1;if(value?.error)rootPalette.error=value.error;else rootPalette.apps=value}
            if(id===rootPalette.windowsRequest){rootPalette.windowsRequest=-1;if(value?.error)rootPalette.error=value.error;else rootPalette.windows=value}
            if(id===rootPalette.searchRequest){
                const expectedQuery=rootPalette.searchRequestQuery
                rootPalette.searchRequest=-1
                if(expectedQuery===rootPalette.query){
                    if(value?.error)rootPalette.error=typeof value.error==="string"?value.error:value.error.message||"Search failed"
                    else if(value?.query===rootPalette.query&&value?.tag===expectedQuery)rootPalette.brokerEntries=(value.entries||[]).map(entry=>Object.assign({broker:true},entry))
                }
            }
            if(id===scriptReview.requestId){scriptReview.requestId=-1;if(value?.error)scriptReview.error=value.error;else{scriptReview.close();App.notify(value?.message||"Script finished")}}
        }
    }
}
