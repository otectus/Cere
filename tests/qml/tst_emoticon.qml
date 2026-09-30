import QtQuick
import QtTest
import "../../qml" as Cere

Item {
    id: scene
    width: 180; height: 180; visible: true
    Item { id: host; anchors.fill: parent }
    TestCase {
        name: "EmoticonBadge"
        when: windowShown
        Component { id: component; Cere.EmoticonBadge {} }
        function make(properties) {
            var badge = createTemporaryObject(component, host, properties || {})
            verify(badge !== null)
            return badge
        }
        function state(settings) { return {sessions:[{id:"a",status:"idle",title:"Alpha"}],settings:settings || {}} }
        function test_liveToneAndNewTurn() {
            var badge = make({snapshot:state(), selectedId:"a"})
            badge.observe({id:"answer",sessionId:"a",role:"assistant",text:"You absolute menace. A tiny rebellion. 😏"})
            compare(badge.emotion.key, "cheeky")
            badge.observe({id:"tool",sessionId:"a",role:"tool",text:"I'm concerned!"})
            compare(badge.emotion.key, "cheeky")
            badge.observe({id:"user",sessionId:"a",role:"user",text:"Next task"})
            compare(badge.emotion.key, "idle")
            badge.observe({id:"reply",sessionId:"a",role:"assistant",text:"I'm here with you. Take your time."})
            compare(badge.emotion.key, "tender")
            badge.now += 90001
            compare(badge.emotion.key, "idle")
        }
        function test_rotationAndAccessibilityModes() {
            var badge = make({snapshot:state()})
            var timer = findChild(badge, "emoticonVariation")
            verify(timer !== null)
            timer.interval = 40
            tryVerify(function() { return badge.variant !== 0 })
            badge.snapshot = state({quiet:true})
            compare(timer.running, false)
            var glyph = badge.glyph
            wait(160); compare(badge.glyph, glyph)
            badge.snapshot = {settings:{reducedMotion:true},approvals:[{kind:"cli"}]}
            compare(badge.emotion.key, "approval")
            compare(timer.running, false)
            badge.snapshot = state({motionIntensity:0})
            compare(timer.running, false)
            badge.snapshot = state(); badge.visible = false
            compare(timer.running, false)
        }
        function test_renderAndMirror() {
            var badge = make({snapshot:state(),live:false,motion:"celebrate"})
            verify(badge.glyph.length > 0)
            verify(badge.width >= 48 && badge.width <= 116)
            verify(badge.height > 0)
            var rendered = grabImage(badge)
            verify(rendered.width > 0)
            var mirror = make({mirror:badge})
            compare(mirror.glyph, badge.glyph)
            badge.variant = 2
            compare(mirror.glyph, badge.glyph)
            badge.motion = "music"
            compare(mirror.emotion.key, "music")
        }
    }
}
