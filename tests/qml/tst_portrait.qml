import QtQuick
import QtTest
import "../../qml" as Cere

Item {
    id: scene
    width: 180
    height: 180
    visible: true
    Item { id: host; anchors.fill: parent }

    TestCase {
    id: testCase
    anchors.fill: parent
    name: "CerePortrait"
    when: windowShown

    Component {
        id: portraitComponent
        Cere.CerePortrait {
            width: 96
            height: 96
            settings: ({ motionIntensity: .7, expressiveCues: true })
            session: ({ id: "alpha", status: "idle" })
        }
    }

    function make(properties) {
        var portrait = createTemporaryObject(portraitComponent, host, properties || {})
        verify(portrait !== null)
        tryVerify(function() { return portrait.artworkReady }, 10000)
        compare(portrait.loadedFaces, 12)
        return portrait
    }

    function test_activity_precedes_mood_and_speech_is_an_overlay() {
        var portrait = make({
            session: ({ id: "alpha", status: "working", activity: "thinking" }),
            mood: "cheeky",
            speech: ({ state: "speaking" })
        })
        compare(portrait.expression, "thinking")
        compare(portrait.face, 2)
        verify(portrait.speaking)
        portrait.session = ({ id: "alpha", status: "working", activity: "working" })
        tryCompare(portrait, "expression", "focused")
        compare(portrait.face, 9)
    }

    function test_cues_can_be_disabled_without_changing_activity() {
        var portrait = make()
        portrait.mood = "tender"
        compare(portrait.expression, "tender")
        portrait.settings = ({ motionIntensity: .7, expressiveCues: false })
        tryCompare(portrait, "expression", "neutral")
        portrait.session = ({ id: "alpha", status: "working", activity: "thinking" })
        tryCompare(portrait, "expression", "thinking")
    }

    function test_selected_session_messages_are_isolated_and_switch_cleanly() {
        var now = Date.now()
        var portrait = make({
            messages: [
                { id: "a", sessionId: "alpha", role: "assistant", text: "I'm curious; tell me more.", time: now },
                { id: "b", sessionId: "beta", role: "assistant", text: "I'm concerned; please be careful.", time: now }
            ]
        })
        wait(220)
        compare(portrait.mood, "curious")
        portrait.session = ({ id: "beta", status: "idle" })
        portrait.refreshMood()
        wait(220)
        compare(portrait.mood, "concerned")
        portrait.session = ({ id: "alpha", status: "idle" })
        portrait.refreshMood()
        wait(220)
        compare(portrait.mood, "curious")
    }

    function test_old_timestamp_streaming_reply_is_fresh_when_text_grows() {
        var old = Date.now() - 60 * 60 * 1000
        var portrait = make({
            session: ({ id: "alpha", status: "working", activity: "speaking" }),
            messages: [{ id: "live", sessionId: "alpha", role: "assistant", text: "I'm curious", time: old }]
        })
        wait(220)
        portrait.messages = [{ id: "live", sessionId: "alpha", role: "assistant", text: "I'm curious; tell me more about this.", time: old }]
        wait(220)
        compare(portrait.mood, "curious")
    }

    function test_reduced_quiet_zero_and_hidden_stop_animation() {
        var portrait = make()
        tryVerify(function() { return portrait.renderedFrames > 2 }, 3000)
        portrait.settings = ({ motionIntensity: .7, reducedMotion: true })
        tryCompare(portrait, "animated", false)
        var still = portrait.renderedFrames
        wait(180)
        compare(portrait.renderedFrames, still)
        portrait.settings = ({ motionIntensity: .7, quiet: true })
        compare(portrait.animated, false)
        portrait.settings = ({ motionIntensity: 0 })
        compare(portrait.animated, false)
        portrait.visible = false
        compare(portrait.animated, false)
    }

    function test_hover_click_and_every_expression_texture_is_ready() {
        var portrait = make()
        var expected = ["neutral", "curious", "thinking", "happy", "cheeky", "skeptical", "tender", "concerned", "surprised", "focused", "sleepy"]
        for (var frame = 0; frame < expected.length; ++frame) {
            portrait.mood = expected[frame]
            tryCompare(portrait, "face", frame)
            verify(portrait.artworkReady)
            compare(portrait.loadedFaces, 12)
            var image = grabImage(portrait)
            compare(image.width, 96)
            compare(image.height, 96)
            verify(image.alpha(48, 48) > 0)
        }
        portrait.mood = "neutral"
        mouseMove(host, portrait.x + 48, portrait.y + 48)
        tryVerify(function() { return portrait.hovered })
        tryCompare(portrait, "expression", "curious")
        mouseClick(host, portrait.x + 48, portrait.y + 48)
        tryVerify(function() { return portrait.greeting })
        tryCompare(portrait, "expression", "cheeky")
    }
    }
}
