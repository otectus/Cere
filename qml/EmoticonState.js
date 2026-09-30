.pragma library

// Faces are grouped by meaning. Variation stays within that meaning, so a
// permission request or a failed run can never randomly turn into a celebration.
var faces = {
    idle:         { label:"Right here", tone:"calm", faces:["(•‿•)", "(◕‿◕)", "(·ᴗ·)"] },
    listening:    { label:"Listening", tone:"warm", faces:["(◕ᴗ◕)", "(•ᴗ•)", "(ᵔᴗᵔ)"] },
    curious:      { label:"Curious", tone:"calm", faces:["(・ω・)?", "(•ᴗ•)?", "(o‿o)?"] },
    thinking:     { label:"Thinking it through", tone:"active", faces:["(¬‿¬)…", "(・_・)…", "(˘⌣˘)…"] },
    planning:     { label:"Making a plan", tone:"active", faces:["(•̀ᴗ•́)و", "(•_•)✎", "(¬ᴗ¬)✎"] },
    working:      { label:"Working on it", tone:"active", faces:["(ง •̀_•́)ง", "(•̀ᴗ•́)و", "(｀・ω・´)"] },
    starting:     { label:"Getting started", tone:"active", faces:["(•‿•)ゞ", "(ง •ᴗ•)ง", "(•̀ᴗ•́)↗"] },
    replying:     { label:"Replying", tone:"active", faces:["(•ᴗ•)⋯", "(◕‿◕)⋯", "(・o・)⋯"] },
    speaking:     { label:"Speaking", tone:"warm", faces:["(•o•)♪", "(◕o◕)♪", "(・ᴗ・)♫"] },
    delegating:   { label:"Coordinating agents", tone:"active", faces:["(•‿•)人(•‿•)", "(•ᴗ•)↔", "(•̀ᴗ•́)☞"] },
    agents:       { label:"Waiting for agents", tone:"active", faces:["(・ω・)⌛", "(•_•)⋯", "(¬ᴗ¬)⌛"] },
    multitasking: { label:"Several conversations working", tone:"active", faces:["(＠_＠)", "(•̀ω•́)ง", "(ง •ᴗ•)ง"] },
    compacting:   { label:"Organizing the conversation", tone:"active", faces:["(•_•)≡", "(¬ᴗ¬)≡", "(˘⌣˘)≡"] },
    approval:     { label:"Permission needed", tone:"attention", faces:["(・_・)?", "(•_•)?", "(◕_◕)?"] },
    question:     { label:"Waiting for your answer", tone:"attention", faces:["(・ω・)?", "(◕ᴗ◕)?", "(•‿•)?"] },
    stopping:     { label:"Stopping", tone:"attention", faces:["(・_・)ノ", "(•_•)✋", "(－_－)ノ"] },
    error:        { label:"Something needs attention", tone:"danger", faces:["(×_×)", "(；_；)", "(>_<)"] },
    interrupted:  { label:"Run interrupted", tone:"attention", faces:["(・_・;)", "(；¬_¬)", "(￣_￣;)"] },
    reconnecting: { label:"Reconnecting", tone:"attention", faces:["(・_・)⋯", "(・・;)", "(・・)↻"] },
    disconnected: { label:"Session disconnected", tone:"attention", faces:["(・・)", "(・_・;)", "(－_－)"] },
    success:      { label:"Run complete", tone:"success", faces:["(๑•̀ㅂ•́)و✧", "(＾▽＾)", "(•̀ᴗ•́)✓"] },
    happy:        { label:"Delighted", tone:"success", faces:["(≧▽≦)", "(＾▽＾)", "(ᵔ▽ᵔ)"] },
    cheeky:       { label:"Feeling playful", tone:"warm", faces:["(¬‿¬)", "(￣▽￣)ゞ", "( •̀ᴗ•́ )"] },
    skeptical:    { label:"A little skeptical", tone:"calm", faces:["(¬_¬)", "(￢_￢)", "(눈_눈)"] },
    tender:       { label:"Here with you", tone:"warm", faces:["(づ˘⌣˘)づ", "(っ•ᴗ•)っ", "(˘ᴗ˘)♡"] },
    concerned:    { label:"Concerned", tone:"attention", faces:["(｡•́︿•̀｡)", "(・︵・)", "(；ω；)"] },
    surprised:    { label:"Surprised", tone:"warm", faces:["(⊙_⊙)", "(°o°)", "(o_O)"] },
    focused:      { label:"Determined", tone:"active", faces:["(•̀_•́)", "(ง •̀ᴗ•́)ง", "(｀_´)ゞ"] },
    sleepy:       { label:"Winding down", tone:"calm", faces:["(－ω－) z", "(˘ω˘) z", "(－.－) z"] },
    paused:       { label:"Taking a pause", tone:"calm", faces:["(˘⌣˘)", "(－ᴗ－)", "(˘ω˘)"] },
    greeting:     { label:"Hey, you", tone:"warm", faces:["(•‿•)ノ", "(＾▽＾)ノ", "(◕ᴗ◕)ノ"] },
    music:        { label:"Enjoying the music", tone:"warm", faces:["(˘▽˘)♪", "(＾ᴗ＾)♫", "(ᵔ‿ᵔ)♪"] },
    timer:        { label:"Time is up", tone:"attention", faces:["(⊙ᴗ⊙) !", "(•o•)◷", "(°ᴗ°) !"] },
    moving:       { label:"Coming with you", tone:"calm", faces:["(ง •‿•)ง", "(•ᴗ•)↗", "(＾ᴗ＾)ゞ"] },
    pickedUp:     { label:"Oh! We're moving", tone:"warm", faces:["(°o°)!", "(⊙ᴗ⊙)", "(・o・)ノ"] }
}

var motionFaces = {
    idle:"idle", attentive:"listening", listen:"listening", thinking:"thinking", working:"working",
    speaking:"replying", waiting:"approval", approval:"approval", error:"error", problem:"error",
    interrupted:"interrupted", disconnected:"disconnected", celebrate:"success", success:"success",
    greeting:"greeting", wave:"greeting", wake:"greeting", tender:"tender", giggle:"cheeky",
    amused:"cheeky", wink:"cheeky", skeptical:"skeptical", surprised:"surprised", curious:"curious",
    yawn:"sleepy", sleepy:"sleepy", doze:"sleepy", quiet:"paused", music:"music", timer:"timer",
    runLeft:"moving", runRight:"moving", dragging:"pickedUp", jump:"happy", bow:"happy",
    listening:"listening", attentiveRest:"listening", send:"starting", copy:"success", capture:"focused",
    resize:"surprised", goodbye:"greeting", smug:"cheeky", cheeky:"cheeky", idleSmug:"cheeky",
    idleCurious:"curious", idleSoft:"tender", disbelief:"skeptical", headShake:"skeptical",
    shy:"tender", ponder:"thinking", doubleTake:"surprised", fistPump:"success", glassesAdjust:"focused"
}
function make(key, session, count, detail) {
    var entry = faces[key] || faces.idle
    return {key:key, label:detail || entry.label, tone:entry.tone, faces:entry.faces,
            sessionId:session ? session.id : "", sessionTitle:session ? session.title || "Conversation" : "", count:count || 0}
}
function recentMood(cues, sessionId, now) {
    var cue = (cues || {})[sessionId]
    return cue && now - cue.time < 90000 && faces[cue.mood] ? cue.mood : "neutral"
}
function resolve(input) {
    if (input.live === false) return make(motionFaces[input.motion] || "idle")
    var state = input.state || {}, settings = state.settings || {}, now = input.now || Date.now()
    var sessions = state.sessions || [], approvals = state.approvals || [], cues = input.cues || {}
    var panels = state.panels || {}, attention = state.attention || {}
    var selectedId = (panels.ui && (attention.ui || {}).sessionId)
        || (panels.overlay && (attention.overlay || {}).sessionId) || input.selectedId
    var selected = sessions.filter(function(s) { return s.id === selectedId })[0]
    if (!input.connected) return make("reconnecting")
    if (approvals.length) {
        var request = approvals[0], owner = sessions.filter(function(s) { return s.id === request.sessionId })[0]
        return make(request.kind === "question" ? "question" : "approval", owner, approvals.length)
    }
    var waiting = sessions.filter(function(s) { return s.status === "waiting" })[0]
    if (waiting) return make("question", waiting)
    var problem = sessions.filter(function(s) { return s.status === "error" && (s.id === selectedId || now - s.updated < 90000) })[0]
    if (problem) return make("error", problem)
    var active = sessions.filter(function(s) { return ["starting","working","stopping"].indexOf(s.status) >= 0 })
    if (active.length) {
        var task = active.filter(function(s) { return s.id === selectedId })[0] || active[0]
        if (task.status === "stopping") return make("stopping", task, active.length)
        if (active.length > 1) return make("multitasking", task, active.length, active.length + " conversations working")
        if (task.status === "starting") return make("starting", task)
        var activities = {thinking:"thinking", planning:"planning", working:"working", delegating:"delegating", waitingForAgents:"agents", compacting:"compacting", speaking:"replying"}
        var mood = settings.expressiveCues === false ? "neutral" : recentMood(cues, task.id, now)
        return make(task.activity === "speaking" && mood !== "neutral" ? mood : activities[task.activity] || "thinking", task)
    }
    if (selected && ["interrupted","disconnected"].indexOf(selected.status) >= 0) return make(selected.status, selected)
    if (settings.paused) return make("paused")
    if ((state.speech || {}).state === "speaking") return make("speaking")
    var finished = (state.completions || []).slice(-1)[0]
    var focus = selected
    // Closed panels reflect the most recent conversation, including background runs.
    if (!input.panelOpen) {
        var freshest = sessions.filter(function(s) { return cues[s.id] && now - cues[s.id].time < 90000 })
            .sort(function(a,b) { return cues[b.id].time - cues[a.id].time })[0]
        focus = freshest || focus
    }
    var tone = settings.expressiveCues === false ? "neutral" : recentMood(cues, focus ? focus.id : "", now)
    if (tone !== "neutral") return make(tone, focus)
    if (finished && now - finished.time < 15000) return make("success", sessions.filter(function(s) { return s.id === finished.sessionId })[0])
    if (input.hovered || input.listening) return make("listening", focus)
    if (settings.quiet) return make("paused")
    return make(motionFaces[input.motion] || "idle", focus)
}

function glyph(expression, variant) {
    return expression.faces[Math.abs(variant || 0) % expression.faces.length]
}
