.pragma library

// Connected drawings share neutral. Different gestures retrace their route;
// changing the strength of the same gesture travels directly between its poses.
function create() {
    return { catalog: null, route: "", target: "", index: 0, elapsed: 0,
             stage: "idle", loop: false, targetLoop: false, frame: 0,
             end: 0, targetEnd: 0, direction: 1 }
}
function reset(state, catalog) {
    state.catalog = catalog || null
    state.route = ""; state.target = ""; state.index = 0; state.elapsed = 0
    state.stage = "idle"; state.loop = false; state.targetLoop = false; state.frame = 0
    state.end = 0; state.targetEnd = 0; state.direction = 1
}
function begin(state) {
    state.route = state.target; state.loop = state.targetLoop; state.end = state.targetEnd
    state.index = 0; state.stage = state.route ? "enter" : "idle"
    state.frame = 0; state.direction = 1
}
function select(state, catalog, motion, loop, enabled, strength) {
    if (!enabled || !catalog || !catalog.routes) { reset(state, catalog); return }
    if (state.catalog !== catalog) reset(state, catalog)
    const requested = (catalog.motions || {})[motion] || ""
    const route = catalog.routes[requested]
    state.target = route && route.frames && route.frames.length > 1 ? requested : ""
    state.targetLoop = !!loop
    const amount = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 1
    state.targetEnd = state.target ? Math.max(1, Math.round((route.frames.length - 1) * amount)) : 0
    if (!state.route) { state.elapsed = 0; begin(state) }
    else if (state.route === state.target) {
        state.loop = state.targetLoop; state.end = state.targetEnd
        state.stage = state.index < state.end ? "enter" : state.index > state.end ? "settle" : "hold"
        state.elapsed = 0
    } else if (state.stage !== "leave") {
        // The interruption tick keeps its current drawing. Never cut to a
        // different hand position, including during a carried loop.
        state.stage = "leave"; state.elapsed = 0
    }
}
function sample(state, seconds, enabled) {
    if (!enabled) { reset(state, state.catalog); return 0 }
    if (!state.route) return 0
    state.elapsed += Math.max(0, Math.min(.1, Number.isFinite(seconds) ? seconds : 0)) * 1000
    for (let steps = 0; steps < 64 && state.route; steps++) {
        const route = state.catalog.routes[state.route]
        const loopStart = Math.max(1, Math.min(state.end - 1, route.loopStart || 1))
        if (state.stage === "hold") {
            if (state.loop) {
                if (route.loopMode === "pingPong" && state.end > loopStart) {
                    state.stage = "cycle"; state.direction = -1
                } else { state.elapsed = 0; break }
            } else {
                const hold = Math.max(0, route.holdMs || 0)
                if (state.elapsed < hold) break
                state.elapsed -= hold; state.stage = "leave"; state.target = ""
            }
        }
        const frameMs = Math.max(8, route.frameMs || 1000 / 60)
        if (state.elapsed + 1e-7 < frameMs) break
        state.elapsed = Math.max(0, state.elapsed - frameMs)
        if (state.stage === "enter") {
            state.index++
            if (state.index >= state.end) { state.index = state.end; state.stage = "hold" }
        } else if (state.stage === "settle") {
            state.index--
            if (state.index <= state.end) { state.index = state.end; state.stage = "hold" }
        } else if (state.stage === "cycle") {
            state.index += state.direction
            if (state.index <= loopStart) { state.index = loopStart; state.direction = 1 }
            if (state.index >= state.end) { state.index = state.end; state.direction = -1 }
        } else {
            state.index = Math.max(0, state.index - 1)
        }
        state.frame = route.frames[state.index]
        if (state.stage === "leave" && state.index === 0) begin(state)
    }
    return state.frame
}
