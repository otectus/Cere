pragma Singleton
import QtQuick

Item {
    id: hub
    property var liveMessage: null
    property bool liveReaction: false
    Component.onCompleted: App.registerMoodSource()
    readonly property var settings: App.state.settings || ({})
    readonly property string sessionId: App.moodSession
    readonly property var session: (App.state.sessions || []).filter(function(s) { return s.id === hub.sessionId })[0] || ({})
    readonly property var samples: {
        var messages=App.messages.filter(function(m) { return m.sessionId === hub.sessionId })
        if (liveMessage && liveMessage.sessionId === sessionId) {
            messages=messages.filter(function(m) { return m.id !== hub.liveMessage.id })
            messages.push(liveMessage)
        }
        return messages
    }
    function forSession(id) {
        var mood=App.conversationMoods[id] || ({mood:"neutral",moodConfidence:0})
        return settings.expressiveCues === false ? {mood:"neutral",moodConfidence:0} : mood
    }
    function publish() {
        var previous=App.conversationMoods[sessionId]
        if (App.moodSourceEnabled && sessionId && (!previous || previous.mood !== source.mood))
            App.setConversationMood(sessionId, {mood:source.mood, moodConfidence:source.moodConfidence,
                reactive:liveReaction, time:Date.now(), messageId:liveMessage ? liveMessage.id : ""})
    }
    onSessionIdChanged: { liveMessage=null; liveReaction=false }
    Connections {
        target: App
        function onConversationMessage(message) {
            if (!App.moodSourceEnabled || message.sessionId !== hub.sessionId) return
            if (message.role !== "user" && (message.role !== "assistant" || (message.kind && message.kind !== "text"))) return
            hub.liveReaction=true
            hub.liveMessage=message
        }
        function onMoodContextChanged() {
            if (!App.moodSourceEnabled) { hub.liveReaction=false; hub.liveMessage=null }
        }
    }
    MoodSource {
        id: source
        settings: hub.settings; session: hub.session; messages: hub.samples
        config: App.animations.bodyMoods
        active: App.moodSourceEnabled
        onSettled: hub.publish()
    }
}
