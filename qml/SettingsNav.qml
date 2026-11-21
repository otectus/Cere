pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "SettingsCatalog.js" as Catalog
// Settings categories from the catalog: a grouped rail beside wide pages, a scrolling strip of
// chips above narrow ones. Both use the sidebar tab idiom from Shell.qml.
Item {
    id:nav
    property string category
    property bool rail:true
    // Category ids that are unavailable right now (Voice without speech).
    property var hidden:[]
    signal selected(string id)
    readonly property var categories:Catalog.visibleCategories(hidden)
    // The strip keeps room for its scroll bar, so its height never depends on its width inside a layout.
    implicitWidth:rail?railColumn.implicitWidth:0
    implicitHeight:rail?railColumn.implicitHeight:chipStrip.height
    Accessible.role:Accessible.PageTabList
    Accessible.name:"Settings categories"
    // The current chip stays in view as categories change and as Tab moves along the strip.
    function revealChip(chip){
        if(!chip||rail)return
        if(chip.x<chipStrip.contentX)chipStrip.contentX=chip.x
        else if(chip.x+chip.width>chipStrip.contentX+chipStrip.width)chipStrip.contentX=Math.min(chipStrip.contentWidth-chipStrip.width,chip.x+chip.width-chipStrip.width)
    }
    function revealCurrent(){const index=categories.findIndex(entry=>entry.id===category);if(index>=0)revealChip(chips.itemAt(index))}
    // Arrow keys move through the same ordered catalog in both layouts. Selection follows focus so
    // keyboard users do not need to press Enter after every category change.
    function categoryButton(item,id){
        if(!item)return null
        if(item.objectName==="settingsCategory_"+id)return item
        for(let index=0;index<item.children.length;++index){const match=categoryButton(item.children[index],id);if(match)return match}
        return null
    }
    function selectAndFocus(id){
        selected(id)
        Qt.callLater(()=>{const button=categoryButton(nav.rail?railScroll:chipStrip,id);if(button)button.forceActiveFocus(Qt.TabFocusReason)})
    }
    function move(step){
        const index=categories.findIndex(entry=>entry.id===category)
        if(index<0||!categories.length)return
        const next=Math.max(0,Math.min(categories.length-1,index+step))
        if(next!==index)selectAndFocus(categories[next].id)
    }
    function moveTo(index){if(categories.length)selectAndFocus(categories[Math.max(0,Math.min(categories.length-1,index))].id)}
    function handleKey(event){
        if(event.key===Qt.Key_Left||event.key===Qt.Key_Up){move(-1);event.accepted=true}
        else if(event.key===Qt.Key_Right||event.key===Qt.Key_Down){move(1);event.accepted=true}
        else if(event.key===Qt.Key_Home){moveTo(0);event.accepted=true}
        else if(event.key===Qt.Key_End){moveTo(categories.length-1);event.accepted=true}
    }
    onCategoryChanged:Qt.callLater(revealCurrent)
    onRailChanged:Qt.callLater(revealCurrent)
    onWidthChanged:Qt.callLater(revealCurrent)

    Flickable {
        id:railScroll
        visible:nav.rail;anchors.fill:parent
        contentWidth:width;contentHeight:railColumn.implicitHeight
        clip:true;boundsBehavior:Flickable.StopAtBounds;flickableDirection:Flickable.VerticalFlick
        ScrollBar.vertical:CScrollBar {}
        ColumnLayout {
            id:railColumn
            width:railScroll.width-(railScroll.contentHeight>railScroll.height?12:0);spacing:2
            Repeater {
                model:Catalog.groups
                ColumnLayout {
                    id:groupColumn
                    required property var modelData
                    required property int index
                    readonly property var members:nav.categories.filter(entry=>entry.group===modelData.id)
                    visible:members.length>0;Layout.fillWidth:true;spacing:2
                    SectionLabel { text:groupColumn.modelData.label.toUpperCase();leftPadding:12;Layout.topMargin:groupColumn.index?Theme.space4:0;Layout.bottomMargin:Theme.space1;Accessible.role:Accessible.Heading;Accessible.name:groupColumn.modelData.label }
                    Repeater {
                        model:groupColumn.members
                        CButton {
                            required property var modelData
                            readonly property bool current:nav.category===modelData.id
                            objectName:"settingsCategory_"+modelData.id
                            Layout.fillWidth:true;implicitHeight:38
                            text:modelData.label;iconName:modelData.icon;alignLeft:true;quiet:true;primary:current
                            help:modelData.blurb
                            Accessible.role:Accessible.PageTab; Accessible.onPressAction: if (enabled) click();Accessible.selected:current;Accessible.description:modelData.blurb
                            onClicked:nav.selected(modelData.id)
                            Keys.onPressed:event=>nav.handleKey(event)
                        }
                    }
                }
            }
        }
    }
    Flickable {
        id:chipStrip;objectName:"settingsChipStrip"
        visible:!nav.rail;width:parent.width
        height:chipRow.implicitHeight+14
        contentWidth:chipRow.implicitWidth;contentHeight:chipRow.implicitHeight
        clip:true;boundsBehavior:Flickable.StopAtBounds;flickableDirection:Flickable.HorizontalFlick
        ScrollBar.horizontal:CScrollBar {}
        // A mouse wheel turns the strip sideways.
        WheelHandler {
            acceptedDevices:PointerDevice.Mouse
            onWheel:event=>{
                if(Math.abs(event.angleDelta.y)<=Math.abs(event.angleDelta.x)){event.accepted=false;return}
                chipStrip.contentX=Math.max(0,Math.min(chipStrip.contentWidth-chipStrip.width,chipStrip.contentX-event.angleDelta.y/2))
            }
        }
        Row {
            id:chipRow;spacing:6
            Repeater {
                id:chips
                model:nav.categories
                CButton {
                    required property var modelData
                    readonly property bool current:nav.category===modelData.id
                    objectName:"settingsCategory_"+modelData.id
                    implicitHeight:34
                    text:modelData.chip||modelData.label;primary:current
                    help:modelData.blurb
                    Accessible.name:modelData.label;Accessible.role:Accessible.PageTab; Accessible.onPressAction: if (enabled) click();Accessible.selected:current;Accessible.description:modelData.blurb
                    onActiveFocusChanged:if(activeFocus)nav.revealChip(this)
                    onClicked:nav.selected(modelData.id)
                    Keys.onPressed:event=>nav.handleKey(event)
                }
            }
        }
    }
}
