.pragma library

// Activity remains authoritative; conversational tone colors the current reply.
function resolve(input) {
    var session = input.session || {}, status = session.status || "idle"
    var approvals = input.approvals || [], mood = input.mood || "neutral"
    if (!input.connected) return { expression: "concerned", label: "Reconnecting", tone: "attention" }
    if (approvals.length || status === "waiting")
        return { expression: "curious", label: "Waiting for your input", tone: "attention" }
    if (status === "error") return { expression: "concerned", label: "Something needs attention", tone: "attention" }
    if (status === "interrupted" || status === "disconnected")
        return { expression: "concerned", label: status === "interrupted" ? "Interrupted" : "Session disconnected", tone: "attention" }
    if (input.paused) return { expression: "sleepy", label: "Taking a pause", tone: "calm" }
    if (status === "stopping") return { expression: "focused", label: "Stopping", tone: "active" }
    var busy = status === "working" || status === "starting"
    var replying = busy && session.activity === "speaking"
    if (busy && !replying) {
        var thinking = ["thinking", "planning", "compacting", ""].indexOf(session.activity || "") >= 0
        return { expression: thinking ? "thinking" : "focused", label: thinking ? "Thinking it through" : "Working on it", tone: "active" }
    }
    // A click acknowledges the user without obscuring an approval or failure.
    if (input.greeting) return { expression: "cheeky", label: "Hey, you", tone: "warm" }
    if (mood !== "neutral") {
        var labels = { curious:"Curious", thinking:"Thoughtful", happy:"Delighted", cheeky:"Feeling playful",
            skeptical:"A little skeptical", tender:"Here with you", concerned:"Concerned",
            surprised:"Surprised", focused:"Determined", sleepy:"Winding down" }
        return { expression:mood, label:labels[mood] || "With you", tone:["happy","cheeky","tender"].indexOf(mood)>=0 ? "warm" : "calm" }
    }
    if (replying) return { expression: "neutral", label: "Replying", tone: "active" }
    if (input.listening || input.hovered) return { expression: "curious", label: "Listening", tone: "calm" }
    return { expression: "neutral", label: "Right here", tone: "calm" }
}
