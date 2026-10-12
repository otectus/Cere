import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Companion: how present Cere is, where she settles, and how large her panels are.
ColumnLayout {
    id:companion
    Layout.fillWidth:true;spacing:14
    property var settings:App.state.settings||({})
    function update(value){return App.rpc("settings.update",value)}
    CSection {
        title:"Presence"
        description:"How much of her you see, and when she turns up."
        CText { text:"Desktop profile";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox { objectName:"desktopProfile";Layout.fillWidth:true;Layout.minimumWidth:0;model:["Normal","Focus","Gaming","Presentation"];currentIndex:["normal","focus","gaming","presentation"].indexOf(companion.settings.desktopProfile||"normal");Accessible.name:"Desktop profile";onActivated:companion.update({desktopProfile:["normal","focus","gaming","presentation"][currentIndex]}) }
        CText { text:"Profiles coordinate visibility, speech, motion and ordinary notifications. Pending approvals remain available from Cere’s tray.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"alwaysOnTop";text:"Always on top";checked:companion.settings.topmost===true;onClicked:companion.update({topmost:checked}) }
        CText { text:"Keep Cere above your applications, including fullscreen windows.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"autostart";text:"Start Cere at login";checked:App.autostartEnabled();onClicked:App.setAutostart(checked) }
        CButton { objectName:"hideCere";text:companion.settings.hidden?"Show Cere":"Hide Cere";onClicked:companion.update({hidden:!companion.settings.hidden}) }
    }
    CSection {
        title:"Placement"
        description:"Her size, and where she settles on each monitor."
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Character size";font.pixelSize:Theme.secondary;Layout.fillWidth:false }
            CSlider { objectName:"characterSize";Layout.fillWidth:true;Layout.minimumWidth:0;from:.5;to:3;stepSize:.25;value:companion.settings.scale||1;Accessible.name:"Character size";onMoved:App.resizePet(value) }
            Text { text:Math.round((companion.settings.scale||1)*100)+"%";color:Theme.cyan;font.family:Theme.font;font.pixelSize:Theme.secondary }
        }
        Flow {
            Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:6
            CButton { objectName:"saveHome";text:"Save monitor home";onClicked:App.saveHomePosition() }
            CButton { objectName:"goHome";text:"Go home";onClicked:App.goHomePosition() }
            CButton { objectName:"dockLeft";text:"Dock left";onClicked:App.dockPet("left") }
            CButton { objectName:"dockRight";text:"Dock right";onClicked:App.dockPet("right") }
        }
        CText { text:"Save a home on each monitor; Go home returns her to the one under your pointer. Docking stops roaming.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"roaming";text:"Roaming · gently follow the mouse";checked:companion.settings.roaming===true;onClicked:companion.update({roaming:checked}) }
        CText { visible:companion.settings.roaming===true;text:"She follows across your displays and stops short of the pointer. Hovering, dragging, open panels, fullscreen apps and active tasks pause her movement.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Interface"
        description:"Scale everything in Cere’s panel and workspace."
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Interface size";Layout.fillWidth:false }
            CSlider { objectName:"interfaceScale";Layout.fillWidth:true;Layout.minimumWidth:0;from:.8;to:1.5;stepSize:.1;value:companion.settings.interfaceScale||1;Accessible.name:"Interface size";onMoved:companion.update({interfaceScale:value}) }
            CText { text:Math.round((companion.settings.interfaceScale||1)*100)+"%";Layout.fillWidth:false }
        }
    }
}
