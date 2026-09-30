.pragma library

// A deliberately small, local classifier.  It reads conversational prose only;
// provider traces, quoted material and code should not animate the portrait.
var MOODS = ["neutral", "curious", "thinking", "happy", "cheeky", "skeptical", "tender", "concerned", "surprised", "focused", "sleepy"]
var MAX_MESSAGES = 96
var MAX_CHARACTERS = 12000
var STALE_MS = 90000

var cues = {
    curious: [
        ["i'm curious", 3.0], ["i am curious", 3.0], ["i wonder", 2.7],
        ["tell me more", 2.7], ["what do you think", 2.2], ["intriguing", 2.0],
        ["i'd love to know", 2.5], ["i would love to know", 2.5]
    ],
    thinking: [
        ["let me think", 3.0], ["thinking this through", 2.8], ["on reflection", 2.5],
        ["a few possibilities", 2.0], ["one possibility", 1.7], ["perhaps", 1.1],
        ["it might be", 1.0], ["i suspect", 1.3]
    ],
    happy: [
        ["great news", 3.2], ["i'm glad", 2.7], ["i am glad", 2.7], ["i'm happy", 3.0],
        ["wonderful", 2.5], ["fantastic", 2.5], ["excellent", 2.1], ["nailed it", 2.8],
        ["that worked", 2.0], ["all set", 1.7], ["success", 1.5], ["nicely done", 2.2],
        ["we did it", 2.8], ["we love to see it", 2.6], ["heck yes", 2.5], ["love that", 2.1]
    ],
    cheeky: [
        ["well, well", 3.1], ["plot twist", 3.2], ["of course it did", 3.0],
        ["naturally, it", 2.3], ["sneaky", 2.0], ["cheeky", 2.3],
        ["because apparently", 2.3], ["for good measure", 1.5], ["tiny rebellion", 2.7],
        ["you absolute menace", 3.5], ["chaos gremlin", 3.2], ["bold move", 2.0],
        ["would you look at that", 2.5], ["look at you", 2.0], ["the audacity", 2.7]
    ],
    skeptical: [
        ["i'm not convinced", 3.4], ["i am not convinced", 3.4], ["i doubt", 2.7],
        ["doesn't add up", 3.1], ["does not add up", 3.1], ["are we sure", 2.8],
        ["i wouldn't assume", 2.8], ["i would not assume", 2.8], ["supposedly", 1.7],
        ["that claim", 1.4], ["unlikely", 1.4], ["questionable", 2.0]
    ],
    tender: [
        ["i'm here with you", 3.5], ["i am here with you", 3.5], ["take your time", 3.0],
        ["that sounds really hard", 3.5], ["that sounds hard", 3.0], ["be gentle with yourself", 3.6],
        ["you don't have to", 2.6], ["you do not have to", 2.6], ["we can go slowly", 3.0],
        ["sorry you're going through", 3.5], ["sorry you are going through", 3.5],
        ["take care of yourself", 3.0], ["you are not alone", 3.2],
        ["we've got this", 2.8], ["we have got this", 2.8], ["i've got you", 3.0],
        ["i have got you", 3.0], ["one step at a time", 2.5]
    ],
    concerned: [
        ["i'm concerned", 3.5], ["i am concerned", 3.5], ["i'm worried", 3.4], ["i am worried", 3.4],
        ["please be careful", 3.0], ["this is serious", 3.0], ["are you safe", 3.8],
        ["could be dangerous", 3.0], ["immediate danger", 3.8], ["please get help", 3.2],
        ["urgent", 1.7], ["alarming", 2.1], ["disaster", 1.7]
    ],
    surprised: [
        ["didn't expect", 3.0], ["did not expect", 3.0], ["that's surprising", 3.0],
        ["that is surprising", 3.0], ["unexpected", 2.0], ["whoa", 2.8],
        ["oh wow", 2.8], ["wait, what", 3.2], ["what a surprise", 3.0]
    ],
    focused: [
        ["here's the plan", 2.8], ["here is the plan", 2.8], ["let's trace", 2.6],
        ["let us trace", 2.6], ["i'll check", 2.0], ["i will check", 2.0],
        ["the key is", 2.0], ["specifically", 1.3], ["step by step", 2.2],
        ["first,", 1.1], ["next,", 1.1], ["the next step", 1.6]
    ],
    sleepy: [
        ["getting sleepy", 3.5], ["i'm sleepy", 3.5], ["i am sleepy", 3.5],
        ["need some rest", 3.0], ["half asleep", 3.2], ["long day", 1.8],
        ["time for bed", 3.0], ["yawn", 2.8], ["good night", 2.2]
    ]
}

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)) }
function messageId(message) { return String(message && message.id || "").slice(0, 256) }

function wholePhrase(text, phrase, index) {
    var before = index > 0 ? text.charAt(index - 1) : ""
    var after = text.charAt(index + phrase.length)
    if (/^[a-z0-9]$/i.test(phrase.charAt(0)) && /^[a-z0-9]$/i.test(before)) return false
    if (/^[a-z0-9]$/i.test(phrase.charAt(phrase.length - 1)) && /^[a-z0-9]$/i.test(after)) return false
    return true
}

function neutral(messageId, ageMs, confidence) {
    return { mood: "neutral", confidence: confidence || 0.04, intensity: 0, messageId: messageId || "", ageMs: ageMs === undefined ? -1 : ageMs }
}

function conversational(message) {
    if (!message || message.role !== "assistant" || typeof message.text !== "string") return false
    var kind = message.kind
    if (kind === undefined || kind === null || kind === "") return true
    return kind === "text"
}

function candidate(messages, sessionId) {
    if (!messages || typeof messages.length !== "number" || typeof sessionId !== "string" || !sessionId) return null
    var examined = 0
    for (var i = messages.length - 1; i >= 0 && examined < MAX_MESSAGES; --i) {
        var message = messages[i]
        ++examined
        if (!message || message.sessionId !== sessionId) continue
        if (message.role === "user") break
        if (conversational(message)) return message
    }
    return null
}

function prose(text) {
    text = String(text || "")
    // Tail truncation cannot preserve whether it began inside a fence or quotation.
    // Conservatively neutralize oversized live replies instead of scoring fragments.
    if (text.length > MAX_CHARACTERS) return ""
    text = text.replace(/[’‘]/g, "'")
    text = text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ")
    // One remaining delimiter can be an opening delimiter in a streaming reply,
    // or a closing delimiter after the bounded tail began inside code. Neither
    // case has a trustworthy prose boundary, so discard the fragment.
    if (/```|~~~/.test(text)) return ""
    text = text.replace(/^\s*>.*$/gm, " ")
    text = text.replace(/^\s*(?:\d{4}-\d\d-\d\d[T ][^\n]*|at\s+\S+\s*\([^\n]*:\d+(?::\d+)?\)|(?:error|warn|info|debug|trace)\s*[:|].*|\$\s+.*|\w+Error:\s+.*)$/gim, " ")
    var ticks = text.match(/`/g) || []
    if (ticks.length % 2) return ""
    text = text.replace(/`[^`\n]*`/g, " ")
    text = text.replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    text = text.replace(/[“\"][^”\"\n]{2,240}[”\"]/g, " ")
    if (/[“”]/.test(text) || (text.match(/\"/g) || []).length % 2) return ""
    text = text.replace(/^\s{2,}\S.*$/gm, " ")
    return text.replace(/[*_#]+/g, " ").replace(/\s+/g, " ").trim()
}

function mostlyEnglish(text) {
    var words = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []
    if (words.length < 3) return true
    var nonAscii = text.match(/[\u00c0-\u024f\u0370-\u052f\u0600-\u06ff\u0900-\u0dff\u3040-\u30ff\u3400-\u9fff]/g) || []
    return nonAscii.length <= Math.max(3, words.join("").length * 0.18)
}

function negated(text, index) {
    var prefix = text.slice(Math.max(0, index - 46), index)
    prefix = prefix.slice(Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"), prefix.lastIndexOf(";")) + 1)
    return /(?:^|\b)(?:not|no|never|hardly|isn't|isnt|aren't|arent|wasn't|wasnt|don't|dont|doesn't|doesnt|no longer)\s+(?:at all\s+)?(?:\w+\s+){0,3}$/i.test(prefix)
}

function technical(clause) {
    return /\b(?:api|build|code|command|compile|compiler|connection|database|dependency|deployment|exception|file|install|job|lint|log|module|package|pipeline|process|query|request|script|server|socket|stack|test|tests|tool|typecheck)\b/i.test(clause)
}

function clauses(text) {
    // Contrast words begin a fresh, later-weighted clause so a streaming reply can
    // visibly change its mind: “Great! However, I’m concerned …” becomes concerned.
    text = text.replace(/\b(?:but|however|though|yet|instead|on the other hand)\b/gi, ". $& ")
    return text.split(/(?:[.!?;]+|\n+)/).map(function (part) { return part.trim() }).filter(function (part) { return !!part }).slice(-24)
}

function analyze(messages, nowMs, sessionId) {
    var message = candidate(messages, sessionId)
    if (!message) return neutral("", -1, 0.03)
    var now = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now()
    var time = typeof message.time === "number" && isFinite(message.time) ? message.time : now
    var age = clamp(Math.round(now - time), 0, 2147483647)
    if (age >= STALE_MS) return neutral(messageId(message), age, 0.03)

    var text = prose(message.text)
    if (!text || !mostlyEnglish(text)) return neutral(messageId(message), age, 0.05)
    var parts = clauses(text)
    if (!parts.length) return neutral(messageId(message), age, 0.04)
    var scores = {}, evidence = {}
    var cueHits = {}
    for (var m = 1; m < MOODS.length; ++m) { scores[MOODS[m]] = 0; evidence[MOODS[m]] = 0 }

    for (var p = 0; p < parts.length; ++p) {
        var clause = parts[p].toLowerCase()
        // Exponential clause recency lets the tail of a streaming response revise
        // its expression without an enthusiastic opening dominating forever.
        var recency = 1.2 * Math.pow(0.78, parts.length - 1 - p)
        if (/^(?:but|however|though|yet|instead|on the other hand)\b/.test(clause)) recency *= 1.32
        var isTechnical = technical(clause)
        for (var mood in cues) {
            var list = cues[mood]
            for (var c = 0; c < list.length; ++c) {
                var start = 0, found
                while ((found = clause.indexOf(list[c][0], start)) >= 0) {
                    start = found + list[c][0].length
                    if (!wholePhrase(clause, list[c][0], found)) continue
                    var cueKey = mood + "|" + list[c][0]
                    cueHits[cueKey] = (cueHits[cueKey] || 0) + 1
                    if (cueHits[cueKey] > 2) continue
                    var value = list[c][1] * recency
                    if (negated(clause, found)) value *= -0.35
                    // A failed build is technical state, not personal alarm. Explicit
                    // concern and safety language above remain expressive.
                    if (mood === "concerned" && isTechnical && list[c][1] < 2.5) value *= 0.12
                    scores[mood] += value
                    evidence[mood] += 1
                }
            }
        }
        if (/[😉😏🙃]/u.test(parts[p])) { scores.cheeky += 2.6 * recency; evidence.cheeky++ }
        if (/[❤♥💙💜🤍]/u.test(parts[p])) { scores.tender += 2.2 * recency; evidence.tender++ }
        if (/[🎉🥳😊😄]/u.test(parts[p])) { scores.happy += 2.1 * recency; evidence.happy++ }
        if (/[😮🤯]/u.test(parts[p])) { scores.surprised += 2.5 * recency; evidence.surprised++ }
        if (/[😟😰]/u.test(parts[p])) { scores.concerned += 2.4 * recency; evidence.concerned++ }
        if (/\b(?:hmm|hmmm)\b/.test(clause)) {
            if (/\b(?:sure|claim|really|supposed)\b/.test(clause)) { scores.skeptical += 1.7 * recency; evidence.skeptical++ }
            else { scores.thinking += 1.5 * recency; evidence.thinking++ }
        }
        if (/\b(?:failed|failure|broken|crashed|error)\b/.test(clause) && !isTechnical && !negated(clause, clause.search(/\b(?:failed|failure|broken|crashed|error)\b/))) {
            scores.concerned += 1.2 * recency; evidence.concerned++
        }
    }

    var exclamations = (text.match(/!/g) || []).length
    if (exclamations && scores.happy > 0) scores.happy += Math.min(0.8, exclamations * 0.2)
    if (exclamations && scores.surprised > 0) scores.surprised += Math.min(1.0, exclamations * 0.25)

    var ranked = MOODS.slice(1).sort(function (a, b) { return scores[b] - scores[a] })
    var best = ranked[0], top = scores[best], second = Math.max(0, scores[ranked[1]])
    var margin = top - second
    if (top < 1.45 || margin < 0.32 || evidence[best] === 0) return neutral(messageId(message), age, clamp(0.06 + Math.max(0, top) * 0.035, 0.06, 0.18))

    var freshness = age <= 45000 ? 1 : clamp((STALE_MS - age) / 45000, 0, 1)
    var confidence = clamp((0.36 + top * 0.09 + margin * 0.055) * (0.42 + 0.58 * freshness), 0.22, 0.94)
    var intensity = clamp((0.22 + top * 0.105 + Math.min(0.15, evidence[best] * 0.025)) * freshness, 0.08, 1)
    if (freshness < 0.18) return neutral(messageId(message), age, 0.06)
    return { mood: best, confidence: confidence, intensity: intensity, messageId: messageId(message), ageMs: age }
}
