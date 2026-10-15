pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "SettingsCatalog.js" as Catalog
// Settings, one category at a time. SettingsCatalog.js lists the categories and their settings for
// the rail or chips, the search and deep links. Every category page stays instantiated in one scroll
// with only the current one visible, so pages keep their requests on load and their objectNames.
ColumnLayout {
    id:settingsView
    objectName:"settingsPage"
    spacing:12
    property string category:Catalog.lastCategory
    property string pendingTarget:""
    readonly property bool rail:width>=700
    // Derived from a bool so the arrays below change only when speech availability does.
    readonly property bool voiceAvailable:App.state.speech!==undefined
    readonly property var hiddenCategories:voiceAvailable?[]:["voice"]
    readonly property var current:Catalog.category(category)||Catalog.category(Catalog.defaultCategory)
    readonly property string query:settingsSearch.text.trim()
    readonly property var results:Catalog.search(query,hiddenCategories)
    readonly property var pages:({companion:companionPage,personality:personalityPage,voice:voicePage,motion:motionPage,connections:connectionsPage,knowledge:knowledgePage,assistance:assistancePage,scripts:scriptsPage,mobile:mobilePage,telemetry:telemetryPage,application:applicationPage})
    onCategoryChanged:{Catalog.remember(category);settingsScroll.contentY=0}
    // A remembered category can be unavailable when this page is made (Voice before speech is ready).
    onHiddenCategoriesChanged:if(hiddenCategories.indexOf(category)>=0)category=Catalog.defaultCategory
    Component.onCompleted:if(hiddenCategories.indexOf(category)>=0)category=Catalog.defaultCategory
    function focusSearch(){settingsSearch.forceActiveFocus()}
    // Opens a category; with a target, the control with that objectName instead.
    function open(id,target){
        settingsSearch.text=""
        if(target&&revealControl(target))return
        if(Catalog.category(id)&&hiddenCategories.indexOf(id)<0)category=id
    }
    function openResult(result){if(result)open(result.category.id,result.setting?result.setting.target:"")}
    // Shows the category holding a control, scrolls to it and focuses it; a brief outline marks it.
    // A control in a part of the page that is switched off reveals that part instead.
    function revealControl(name){
        let id=Catalog.categoryOf(name)
        if(!id)for(const key in pages)if(find(pages[key],name)){id=key;break}
        if(!id||hiddenCategories.indexOf(id)>=0)return false
        settingsSearch.text=""
        category=id;pendingTarget=name
        Qt.callLater(finishReveal)
        return true
    }
    function find(item,name){
        if(!item)return null
        if(item.objectName===name)return item
        for(let index=0;index<item.children.length;++index){const match=find(item.children[index],name);if(match)return match}
        return null
    }
    // Lays the visible pages out now rather than at the next frame. The page was hidden a moment ago, and
    // wrapped text learns its height only once it has its width, so passes repeat until the item holds still.
    function settle(item){
        const polish=node=>{if(!node.visible)return;node.ensurePolished();for(let index=0;index<node.children.length;++index)polish(node.children[index])}
        let top=NaN
        for(let pass=0;pass<4;++pass){
            polish(settingsScroll.contentItem)
            const y=item.mapToItem(settingsScroll.contentItem,0,0).y
            if(y===top)break
            top=y
        }
        return top
    }
    function finishReveal(){
        const page=pages[category],target=find(page,pendingTarget);pendingTarget=""
        let shown=target;while(shown&&shown!==page&&!shown.visible)shown=shown.parent
        if(!shown)return
        const top=settle(shown)
        settingsScroll.contentY=Math.max(0,Math.min(settingsScroll.contentHeight-settingsScroll.height,top-Math.min(96,settingsScroll.height/4)))
        if(shown===target&&target.activeFocusOnTab)target.forceActiveFocus(Qt.OtherFocusReason)
        spotlight.show(shown)
    }
    ColumnLayout {
        Layout.fillWidth:true;spacing:4
        CText { text:"Settings";font.pixelSize:Theme.page;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading }
        // Narrow pages give this line to the chips; the category blurb below still speaks for her.
        CText { visible:settingsView.rail;text:"Shape how "+App.assistantName+" looks, speaks, connects, and acts on your desktop.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CField {
        id:settingsSearch;objectName:"settingsSearch";Layout.fillWidth:true
        leftPadding:38;placeholderText:"Find a setting…";Accessible.name:"Find a setting"
        CIcon { name:"search";x:12;anchors.verticalCenter:parent.verticalCenter;color:settingsSearch.activeFocus?Theme.accentText:Theme.muted }
        onAccepted:settingsView.openResult(settingsView.results[0])
        // Escape clears a search first; on an empty field it leaves Settings as before.
        Keys.onEscapePressed:event=>{if(text.length){clear();event.accepted=true}else event.accepted=false}
        Keys.onDownPressed:event=>{event.accepted=resultList.count>0;if(event.accepted){resultList.currentIndex=0;resultList.itemAtIndex(0).forceActiveFocus(Qt.TabFocusReason)}}
    }
    SettingsNav {
        visible:!settingsView.rail&&!settingsView.query
        rail:false;Layout.fillWidth:true;Layout.preferredHeight:implicitHeight
        category:settingsView.category;hidden:settingsView.hiddenCategories
        onSelected:id=>settingsView.open(id,"")
    }
    RowLayout {
        Layout.fillWidth:true;Layout.fillHeight:true;spacing:12
        SettingsNav {
            visible:settingsView.rail
            rail:true;Layout.preferredWidth:196;Layout.fillHeight:true
            category:settingsView.category;hidden:settingsView.hiddenCategories
            onSelected:id=>settingsView.open(id,"")
        }
        Rectangle { visible:settingsView.rail;Layout.fillHeight:true;implicitWidth:1;color:Theme.subtle }
        ColumnLayout {
            visible:settingsView.query.length>0
            Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0;spacing:8
            CText {
                objectName:"settingsResultSummary";color:Theme.muted;font.pixelSize:Theme.caption
                text:settingsView.results.length?settingsView.results.length+(settingsView.results.length===1?" match":" matches")+" · Enter opens the first":"Nothing by that name. Try a broader word, like voice or memory."
            }
            ListView {
                id:resultList;objectName:"settingsResults"
                Layout.fillWidth:true;Layout.fillHeight:true;clip:true;spacing:4
                model:settingsView.results
                Accessible.role:Accessible.List;Accessible.name:"Matching settings"
                ScrollBar.vertical:CScrollBar {}
                delegate:CButton {
                    id:result
                    required property var modelData
                    required property int index
                    readonly property string detail:modelData.setting?Catalog.group(modelData.category.group).label+" › "+modelData.category.label:"Category · "+modelData.category.blurb
                    objectName:"settingsResult_"+index
                    width:resultList.width-12;implicitHeight:54;quiet:true;alignLeft:true
                    text:modelData.setting?modelData.setting.label:modelData.category.label
                    help:detail;Accessible.name:text+", "+detail
                    onClicked:settingsView.openResult(modelData)
                    contentItem:ColumnLayout {
                        spacing:2
                        Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:result.text;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.body;font.weight:Font.Medium;elide:Text.ElideRight;textFormat:Text.PlainText }
                        Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:result.detail;color:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption;elide:Text.ElideRight;textFormat:Text.PlainText }
                    }
                }
            }
        }
        PageScroll {
            id:settingsScroll;objectName:"settingsScroll"
            visible:!settingsView.query
            Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0;maximumContentWidth:820
            ColumnLayout {
                Layout.fillWidth:true;spacing:2
                // The rail already names the group beside a wide page.
                SectionLabel { visible:!settingsView.rail;text:(Catalog.group(settingsView.current.group)||{label:""}).label.toUpperCase() }
                CText { objectName:"settingsCategoryTitle";text:settingsView.current.label;font.pixelSize:Theme.title;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading }
                CText { text:settingsView.current.blurb;color:Theme.muted;font.pixelSize:Theme.secondary }
            }
            CompanionSettings { id:companionPage;visible:settingsView.category==="companion" }
            PersonalitySettings { id:personalityPage;visible:settingsView.category==="personality" }
            VoiceSettings { id:voicePage;visible:voicePage.available&&settingsView.category==="voice" }
            MotionSettings { id:motionPage;visible:settingsView.category==="motion" }
            ConnectionsSettings { id:connectionsPage;visible:settingsView.category==="connections" }
            KnowledgeSettings { id:knowledgePage;visible:settingsView.category==="knowledge" }
            AssistanceSettings { id:assistancePage;visible:settingsView.category==="assistance" }
            ScriptsSettings { id:scriptsPage;visible:settingsView.category==="scripts" }
            RemoteSettings { id:mobilePage;visible:settingsView.category==="mobile" }
            TelemetrySettings { id:telemetryPage;backend:App;Layout.fillWidth:true;visible:settingsView.category==="telemetry" }
            ApplicationSettings { id:applicationPage;visible:settingsView.category==="application" }
        }
    }
    // A brief outline around whatever revealControl() brought into view.
    Rectangle {
        id:spotlight;objectName:"settingsSpotlight"
        parent:settingsScroll.contentItem
        z:2;opacity:0;visible:opacity>0
        color:"transparent";radius:Theme.radiusCard;border.color:Theme.accentText;border.width:Theme.focusWidth
        function show(item){
            const point=item.mapToItem(parent,0,0)
            x=point.x-6;y=point.y-6;width=item.width+12;height=item.height+12
            pulse.restart()
        }
        SequentialAnimation {
            id:pulse
            NumberAnimation { target:spotlight;property:"opacity";to:1;duration:Theme.duration(120) }
            PauseAnimation { duration:900 }
            NumberAnimation { target:spotlight;property:"opacity";to:0;duration:Theme.duration(450) }
        }
    }
}
