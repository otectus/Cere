import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Application: the compositor shortcut, backups and health, and quitting.
ColumnLayout {
    id:application
    Layout.fillWidth:true;spacing:14
    CSection {
        title:"Shortcut"
        description:"Find Cere in your application menu or tray, or bind cere toggle to a key."
        CButton { objectName:"copyShortcut";text:"Copy Hyprland shortcut";help:"Copy a suggested Super+C binding for a Lua configuration";onClicked:App.copy('hl.bind("SUPER + C", hl.dsp.exec_cmd("cere toggle"))') }
    }
    CSection {
        title:"Maintenance"
        description:"Back up or restore Cere’s state, or check the application’s health."
        GridLayout {
            Layout.fillWidth:true;columns:width>=520?2:1;columnSpacing:8;rowSpacing:8
            CButton { objectName:"openBackup";Layout.fillWidth:true;text:"Backup and restore";onClicked:recovery.open() }
            CButton { objectName:"openHealth";Layout.fillWidth:true;text:"Health and recovery";onClicked:health.open() }
        }
    }
    CSection {
        title:"Quit"
        description:"Closing a panel keeps your sessions running. Quitting can too."
        GridLayout {
            Layout.fillWidth:true;columns:width>=520?2:1;columnSpacing:8;rowSpacing:8
            CButton { objectName:"quitKeepSessions";Layout.fillWidth:true;text:"Quit · keep sessions running";onClicked:App.quit(false) }
            CButton { objectName:"stopAndQuit";Layout.fillWidth:true;text:"Stop sessions and quit";danger:true;onClicked:quitConfirm.open() }
        }
    }
    CDialog {
        id:quitConfirm
        CText { text:"Stop sessions and quit?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Any running turns will be interrupted. Their conversation history will stay available.";color:Theme.muted }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";onClicked:quitConfirm.close() }
            CButton { Layout.fillWidth:true;text:"Stop and quit";danger:true;onClicked:App.quit(true) }
        }
    }
    Health { id:health }
    Recovery { id:recovery }
}
