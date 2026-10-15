import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Motion & expressions: how Cere moves while idle and how she reacts to a conversation.
ColumnLayout {
    id:motion
    Layout.fillWidth:true;spacing:14
    property var settings:App.state.settings||({})
    readonly property real intensity:settings.motionIntensity===undefined?0.7:settings.motionIntensity
    // Expressions need her visible and moving; the hint below says what is in the way.
    readonly property bool canPreview:!settings.quiet&&!settings.reducedMotion&&!settings.hidden&&settings.motionIntensity!==0
    function update(value){return App.rpc("settings.update",value)}
    CSection {
        title:"Motion"
        description:"A little attitude, a little grace. Make her movement feel like home."
        CCheckBox { objectName:"quietMode";text:"Quiet mode";checked:motion.settings.quiet===true;onClicked:motion.update({quiet:checked}) }
        CText { text:"Pause animations, spoken replies and ordinary notifications.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"reducedMotion";text:"Reduce motion";checked:motion.settings.reducedMotion===true;onClicked:motion.update({reducedMotion:checked}) }
        CText { text:"Use still poses for her current state. Breathing, blinking, transitions and roaming stop; permission requests stay visible.";color:Theme.muted;font.pixelSize:Theme.secondary }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Motion intensity";font.pixelSize:Theme.secondary;Layout.fillWidth:false }
            CSlider {
                objectName:"motionIntensity";Layout.fillWidth:true;Layout.minimumWidth:0
                from:0;to:1;stepSize:.1;value:motion.intensity
                enabled:!motion.settings.quiet&&!motion.settings.reducedMotion
                Accessible.name:"Motion intensity";onMoved:motion.update({motionIntensity:Math.round(value*10)/10})
            }
            Text { text:Math.round(motion.intensity*100)+"%";color:Theme.accentText;font.family:Theme.font;font.pixelSize:Theme.secondary }
        }
        CText { text:"From a quiet presence to full personality: soften her breathing, gaze, hair sway and gestures together. Zero keeps state poses still.";color:Theme.muted;font.pixelSize:Theme.secondary }
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Idle energy";font.pixelSize:Theme.secondary }
            CComboBox {
                objectName:"idleEnergy";Layout.fillWidth:true;textRole:"label";valueRole:"value"
                model:[{label:"Calm",value:"calm"},{label:"Lively",value:"lively"}]
                currentIndex:motion.settings.idleEnergy==="calm"?0:1
                Accessible.name:"Idle energy"
                onActivated:motion.update({idleEnergy:currentValue})
            }
        }
        MotionStage { Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0 }
    }
    CSection {
        title:"Expressions"
        description:"Little reactions to how a conversation feels, and a few on request."
        CCheckBox { objectName:"expressiveCues";text:"Respond to conversational tone";checked:motion.settings.expressiveCues!==false;onClicked:motion.update({expressiveCues:checked}) }
        CText { text:"Occasional expressions from clear English conversational cues, interpreted locally. Task results always come from the app.";color:Theme.muted;font.pixelSize:Theme.secondary }
        RowLayout {
            Layout.fillWidth:true
            CComboBox {
                id:expression;objectName:"animationPicker";Layout.fillWidth:true;Layout.minimumWidth:0;textRole:"label";valueRole:"name"
                model:Object.keys(App.animations.clips||{}).filter(n=>!App.animations.clips[n].loop).map(n=>({name:n,label:App.animations.clips[n].label}))
                Accessible.name:"Choose "+App.assistantName+"’s expression"
            }
            CButton { objectName:"previewAnimation";text:"Preview";enabled:motion.canPreview;onClicked:App.preview(expression.currentValue) }
        }
        Flow {
            Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:6
            Repeater {
                model:[{name:"wave",label:"Say hello"},{name:"nod",label:"A knowing nod"},{name:"giggle",label:"Try to behave"},{name:"stretch",label:"Stretch"},{name:"glassesAdjust",label:"Adjust glasses"},{name:"hairTuck",label:"Tuck her hair"},{name:"smallShrug",label:"Who, me?"},{name:"hairToss",label:"A little drama"},{name:"music",label:"Find the rhythm"}]
                CButton {
                    required property var modelData
                    text:modelData.label
                    enabled:motion.canPreview
                    onClicked:App.preview(modelData.name)
                }
            }
        }
        CText { visible:!motion.canPreview;text:motion.settings.hidden?"She is hidden. Show her from Companion › Presence, then preview away.":motion.settings.motionIntensity===0?"Raise motion intensity above zero to preview expressions.":"Turn off quiet mode and reduced motion to preview expressions.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
}
