.pragma library

// The clock animates semantic joint channels. Artwork, bind pivots, limits and
// spring tuning live in cere-rig.json; no body part is inferred from pixels.
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }
function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t) }
function ease(t) { t = clamp(t, 0, 1); return t*t*t*(t*(t*6-15)+10) }
function jointProgress(state, previous, next, channel, time) {
    var articulation = (state.catalog.puppet || {}).articulation || {}
    var arms = articulation.arms || [], lead = articulation.foldLead || 0
    for (var i = 0; i < arms.length; ++i) {
        var arm = arms[i]
        if (channel !== arm.shoulder && channel !== arm.elbow) continue
        var turn = ((next[arm.shoulder] || 0)-(previous[arm.shoulder] || 0))*arm.liftSign
        var fold = Math.abs(next[arm.elbow] || 0)-Math.abs(previous[arm.elbow] || 0)
        // Fold before lifting; lower the shoulder before letting the elbow go.
        // This also keeps face-touching gestures from sweeping a straight arm
        // sideways through a mannequin pose on their way up or down.
        var lifting = turn > 18 || (Math.abs(turn) <= 18 && fold > 25)
        var lowering = turn < -18 || (Math.abs(turn) <= 18 && fold < -25)
        if (!lifting && !lowering) break
        var early = lifting ? channel === arm.elbow : channel === arm.shoulder
        return ease(early ? time/(1-lead) : (time-lead)/(1-lead))
    }
    return ease(time)
}
function neutral(name) { return 0 }
function spring(state, target, dt, omega) {
    if (dt <= 0) return state.value
    var offset = state.value - target, impulse = state.velocity + omega * offset
    var decay = Math.exp(-omega * dt)
    state.value = target + (offset + impulse * dt) * decay
    state.velocity = (state.velocity - omega * impulse * dt) * decay
    return state.value
}
function elastic(state, target, dt, omega, damping) {
    if (dt <= 0) return state.value
    // Exact underdamped spring: hair and shoulders can overshoot and settle,
    // without frame-count-dependent Euler integration or velocity resets.
    var a = damping * omega, b = omega * Math.sqrt(1 - damping * damping)
    var x = state.value - target, c = (state.velocity + a * x) / b
    var sn = Math.sin(b * dt), cs = Math.cos(b * dt), decay = Math.exp(-a * dt)
    state.value = target + decay * (x * cs + c * sn)
    state.velocity = decay * ((c * b - a * x) * cs - (x * b + a * c) * sn)
    return state.value
}
function random(state, lo, hi) {
    state.seed = (Math.imul(1664525, state.seed) + 1013904223) >>> 0
    return lo + (hi - lo) * state.seed / 4294967296
}

function create(seed) {
    return {time:0, rhythmTime:0, elapsed:0, clip:null, catalog:{}, name:"", keyIndex:0, pose:0,
        springs:{}, config:{}, seed:seed === undefined ? 192071 : seed,
        entry:null, phase:"rest", nextBeat:1.6, beat:null, beatCount:0, lastBeat:-1,
        breathStart:0, inhale:1.8, exhale:2.9, breathPower:1,
        blinkAt:-10, nextBlink:null, blinkDouble:false, blink:0, blinkTime:0, lastBlink:0,
        energy:"", mood:"neutral", life:{}, micro:{}}
}
function configure(state, energy, mood) {
    state.energy=energy || state.catalog.defaultIdleProfile
    state.mood=mood || "neutral"
    var profile=(state.catalog.idleProfiles || {})[state.energy] || {}
    var idle=state.name === "idle" || (profile.pool || []).indexOf(state.name)>=0
    state.idle=idle
    var life=Object.assign({}, state.clip.life || {})
    if (idle && state.name === "idle") life=Object.assign(life,profile.life || {})
    else if (idle) Object.keys(profile.gestureLifeScale || {}).forEach(function(k) {
        if (life[k] !== undefined) life[k]*=profile.gestureLifeScale[k]
    })
    var moodConfig=(((state.catalog.bodyMoods || {}).moods || {})[state.mood] || {})
    var tint=moodConfig.lifeScale || {}
    state.idlePose=state.name === "idle" ? moodConfig.idlePose : undefined
    if (idle) Object.keys(tint).forEach(function(k) { life[k]=(life[k] === undefined ? 1 : life[k])*tint[k] })
    state.life=life
    state.micro=idle ? (profile.micro || state.catalog.microActing || {}) : (state.catalog.microActing || {})
    if (!state.beatCount) state.nextBeat=state.micro.firstMs/1000
}
function transition(state, clip) {
    var duration = clip.entryMs || 0, from = state.pose, to = clip.keys[0].pose
    if (!duration) return null
    var frames = state.catalog.frames || [], fromFamily = (frames[from] || {}).family || "rest"
    var toFamily = (frames[to] || {}).family || "rest"
    var routes = state.catalog.transitionRoutes || {}
    var bridge = from === to || duration < 250 ? [] : (routes[fromFamily + ":" + toFamily] || [])
    // The policy state/symbol changes immediately. Urgent reactions take a
    // direct, short route; casual acting gets release, transfer and arrival.
    var direction = to % 2 === 0 ? 1 : -1
    var current = {}
    Object.keys(state.springs).forEach(function(channel) { current[channel]=state.springs[channel].value })
    var initial = {pose:from, joints:current}, keys = []
    if (duration >= 250) keys.push({pose:from, joints:current, ms:duration*.18, phase:"anticipate",
        y:.7, rig:{headTilt:-direction*.7, bodyTilt:-direction*.35, hipX:-direction*.35}})
    var travel = duration * (duration >= 250 ? .52 : .7)
    for (var i = 0; i < bridge.length; ++i) keys.push({pose:bridge[i], ms:travel/(bridge.length+1),
        phase:i === 0 ? "release" : "transfer", rig:{headTilt:direction*.9, hipX:direction*.6, shoulderLeft:-.5}})
    keys.push({pose:to, ms:travel/(bridge.length+1), phase:"arrive",
        rig:{headTilt:direction*1.1, bodyTilt:direction*.45, hairRotation:-direction*.2}})
    keys.push({pose:to, ms:duration*.3, phase:"settle"})
    return {keys:keys, loop:false, duration:duration, initial:initial}
}

function select(state, clip, catalog, name) {
    state.clip=clip; state.elapsed=0; state.keyIndex=0
    if (catalog) state.catalog=catalog
    state.config=(state.catalog.puppet || {}).channels || {}
    Object.keys(state.config).forEach(function(channel) {
        if (!state.springs[channel]) state.springs[channel]={value:0,velocity:0}
    })
    state.name=name || ""; state.entry=transition(state,clip)
    configure(state,state.energy,state.mood)
    state.authoredEyes=clip.keys.some(function(key) {
        var joints=keyStance(state,key), rig=key.rig || {}
        return !!(joints.eyeClose || joints.wink || rig.eyeClose || rig.wink)
    })
    if (state.nextBlink === null) state.nextBlink=state.catalog.blink.initialMs/1000
    // Leave every joint's current value and velocity intact during interruption.
}
function frameAt(clip, elapsed) {
    var keys = clip.keys, total = 0
    for (var i = 0; i < keys.length; ++i) total += keys[i].ms
    var time = clip.loop ? elapsed % total : Math.min(elapsed, total), start = 0
    for (var j = 0; j < keys.length; ++j) {
        if (time < start + keys[j].ms || j === keys.length - 1)
            return {key:keys[j], previous:j > 0 ? keys[j-1] : clip.loop && elapsed >= total ? keys[keys.length-1] : clip.initial || keys[0],
                    index:j, time:clamp((time-start)/(keys[j].easeMs || keys[j].ms),0,1),
                    progress:ease((time-start)/(keys[j].easeMs || keys[j].ms))}
        start += keys[j].ms
    }
}

function stance(state, pose) {
    return (((state.catalog.puppet || {}).poses || {})[String(pose)] || {}).joints || {}
}
function keyStance(state, key) {
    var base=stance(state,key.pose)
    if (!key.joints) return base
    var result={}
    Object.keys(base).forEach(function(channel) { result[channel]=base[channel] })
    Object.keys(key.joints).forEach(function(channel) { result[channel]=key.joints[channel] })
    return result
}
function offset(key, channel) {
    var values = channel === "x" || channel === "y" || channel === "rotation" ? key : key.rig || {}
    return values[channel] || 0
}
function attention(state, enabled, hovered) {
    var t = state.time
    if (enabled && !hovered && t >= state.nextBeat) {
        var kind = Math.floor(random(state, 0, 4))
        if (kind === state.lastBeat) kind = (kind+1)%4
        state.lastBeat = kind; state.beatCount++
        var micro=state.micro, pace=state.life.pace || 1
        state.beat = {kind:kind, start:t, duration:random(state, micro.durationMinMs, micro.durationMaxMs)/1000/pace,
            side:random(state, 0, 1) < .5 ? -1 : 1, strength:random(state, .7, 1)}
        state.nextBeat = t + random(state, micro.minMs, micro.maxMs)/1000/pace
    }
    var b = state.beat
    if (!b || !enabled || hovered) return {amount:0, side:0, kind:-1, label:"At ease"}
    var age = t-b.start, envelope = smooth(age/.65)*(1-smooth((age-b.duration+.9)/.9))
    return {amount:envelope*b.strength, side:b.side, kind:b.kind,
            label:["Looking around", "Shifting her weight", "A little shoulder roll", "An inquisitive glance"][b.kind]}
}
function breathing(state) {
    var age = state.rhythmTime-state.breathStart
    if (age >= state.inhale+state.exhale) {
        state.breathStart = state.rhythmTime; age = 0
        var config = state.catalog.breathing || {}
        state.inhale = random(state, (config.inhaleMinMs || 1500)/1000, (config.inhaleMaxMs || 2100)/1000)
        state.exhale = random(state, (config.exhaleMinMs || 2500)/1000, (config.exhaleMaxMs || 3500)/1000)
        state.breathPower = random(state, .9, 1.15)
    }
    return state.breathPower * (age < state.inhale
        ? (1-Math.cos(Math.PI*age/state.inhale))*.5
        : (1+Math.cos(Math.PI*(age-state.inhale)/state.exhale))*.5)
}
function blink(state, enabled, still, authored) {
    var config = state.catalog.blink || {}
    // Finish an eyelid motion already in progress when a gesture interrupts it.
    // Eligibility controls starting new blinks, not abruptly opening the eyes.
    if (still || authored) { state.blink = 0; state.blinkAt = -10; return }
    var now=state.blinkTime
    if (enabled && now >= Math.min(state.nextBlink,state.lastBlink+config.maxGapMs/1000)) {
        state.blinkAt = now; state.lastBlink=now
        if (!state.blinkDouble && random(state, 0, 1) < (config.doubleChance === undefined ? .16 : config.doubleChance)) {
            state.nextBlink = now+config.doubleGapMs/1000; state.blinkDouble = true
        } else { state.nextBlink = now+random(state, config.minMs/1000, config.maxMs/1000); state.blinkDouble = false }
    }
    var age = now-state.blinkAt, close = (config.closeMs || 65)/1000
    var hold = (config.holdMs || 40)/1000, open = (config.openMs || 145)/1000
    state.blink = age < close ? smooth(age/close) : age < close+hold ? 1 : 1-smooth((age-close-hold)/open)
}

function sample(state, seconds, intensity, gazeX, gazeY, carryX, carryY, still, interaction) {
    seconds=isFinite(seconds) ? Math.max(0,seconds) : 0
    var dt=clamp(seconds,0,.05), info=interaction || {}
    if (!still) {
        state.elapsed+=seconds*1000; state.time+=dt; state.blinkTime+=seconds
        state.rhythmTime+=dt*(state.idle ? state.life.pace || 1 : 1)
    }
    var entryDuration=state.entry ? state.entry.duration : 0
    var entering=!still && state.entry && state.elapsed<entryDuration
    var frame=frameAt(entering ? state.entry : state.clip,
        still ? 0 : Math.max(0,state.elapsed-(entering ? 0 : entryDuration)))
    if (!still && !entering && state.idlePose !== undefined) {
        frame.key=Object.assign({},frame.key,{pose:state.idlePose})
        frame.previous=Object.assign({},frame.previous,{pose:state.idlePose})
    }
    state.keyIndex=entering ? 0 : frame.index; state.pose=frame.key.pose
    state.phase=still ? "still" : entering ? frame.key.phase : frame.key.phase || (state.clip.loop ? "living" : "gesture")
    var previous=keyStance(state,frame.previous), next=keyStance(state,frame.key)
    var target={}, movement={}, result={}, t=state.rhythmTime
    Object.keys(state.config).forEach(function(channel) {
        var a=previous[channel] || 0, b=next[channel] || 0
        // Pose angles are anatomical targets, not amplitudes: reducing intensity
        // must never turn a raised palm into an upside-down half-raised hand.
        var progress=jointProgress(state,previous,next,channel,frame.time)
        target[channel]=still ? b : a+(b-a)*progress
        var u=offset(frame.previous,channel), v=offset(frame.key,channel)
        movement[channel]=u+(v-u)*frame.progress
    })
    var life=state.life || state.clip.life || {}, pace=state.idle ? 1 : life.pace || 1
    var presence=life.presence === undefined ? 1 : life.presence
    var breath=breathing(state), sway=Math.sin(t*.91)*.65+Math.sin(t*.37+1)*.35
    var idle=attention(state,!still && !entering && state.clip.loop && !life.stride && !state.clip.carry && life.autonomy!==0,info.hovered)
    var amount=idle.amount*(life.autonomy === undefined ? 1 : life.autonomy),side=idle.side
    movement.breathLift-=breath*(life.breath === undefined ? 2.1 : life.breath)*.35
    movement.bodyTilt+=sway*(life.sway === undefined ? .85 : life.sway)
    movement.headTilt+=Math.sin(t*.73+.6)*(life.head === undefined ? 1.4 : life.head)+gazeX*3.0
    movement.headX+=gazeX*1.8+Math.sin(t*.57)*.2*presence
    movement.headY+=gazeY*1.2+Math.sin(t*1.9*pace)*(life.nod || 0)
    movement.hipX+=Math.sin(t*.61-.5)*.45*presence
    movement.shoulderLeft-=breath*.16+Math.sin(t*1.1)*.15*presence
    movement.shoulderRight-=breath*.16+Math.sin(t*1.1+.8)*.15*presence
    if (idle.kind===0 || idle.kind===3) {
        movement.headX+=side*amount*1.5; movement.headTilt+=side*amount*(idle.kind===3 ? 2.6 : 1.6)
        movement.headY+=amount*(idle.kind===3 ? -.7 : .3)
        movement.bodyTilt+=side*amount*.4; movement.hipX+=side*amount*.3
    } else if (idle.kind===1) {
        movement.hipX+=side*amount*1.3; movement.bodyTilt-=side*amount*.6
        movement.headTilt+=side*amount
    } else if (idle.kind===2) {
        movement.shoulderLeft-=amount; movement.shoulderRight-=amount*.5
        movement.headTilt-=amount; movement.leftArm-=amount*2
    }
    var hands=life.hands === undefined ? .6 : life.hands
    // A relaxed arm hangs against the torso's sway; it does not rotate as a
    // rigid extension of it. Different rhythms keep both sides from mirroring.
    movement.leftArm-=movement.bodyTilt*.55+Math.sin(t*.83*pace+.4)*hands*.6
    movement.rightArm-=movement.bodyTilt*.55-Math.sin(t*.71*pace+1.8)*hands*.45
    movement.leftElbow+=(Math.sin(t*1.6*pace)*.7+Math.sin(t*.63+.8)*.3)*hands
    movement.rightElbow+=(Math.sin(t*1.4*pace+1.5)*.7+Math.sin(t*.79)*.3)*hands*.7
    if (life.stride) {
        var stride=Math.sin(t*9*pace)
        movement.leftLeg+=stride*life.stride*3; movement.rightLeg-=stride*life.stride*3
        movement.leftKnee-=Math.max(0,stride)*8; movement.rightKnee+=Math.max(0,-stride)*8
        movement.leftArm-=stride*life.stride*4.2; movement.rightArm+=stride*life.stride*4.2
        movement.leftElbow-=Math.max(0,-stride)*7; movement.rightElbow+=Math.max(0,stride)*7
        movement.shoulderLeft+=stride*.3; movement.shoulderRight-=stride*.3
        movement.y-=(1-Math.cos(t*18*pace))*.55
        movement.bodyTilt+=carryX*.012
    }
    if (state.clip.carry) {
        movement.rotation-=clamp(carryX*.035,-4,4)
        movement.leftLeg+=Math.sin(t*4)*4; movement.rightLeg-=Math.sin(t*4)*4
        movement.y+=clamp(carryY*.012,-2,2)
    }
    // Only the back-hair joint receives this lag. The head's pixels and matrix
    // cannot be affected by arm or hair channels anywhere in the hierarchy.
    var headVelocity=(state.springs.headTilt || {}).velocity || 0
    movement.hairRotation+=Math.sin(t*.91-.8)*.35*presence-headVelocity*.035-carryX*.004
    Object.keys(state.config).forEach(function(channel) {
        var config=state.config[channel], s=state.springs[channel]
        var value=clamp(target[channel]+(still ? 0 : movement[channel]*intensity),config.min,config.max)
        if (still) { s.value=value; s.velocity=0 }
        else if (config.damping) elastic(s,value,dt,config.omega,config.damping)
        else spring(s,value,dt,config.omega)
        result[channel]=s.value
    })
    var frames=state.catalog.frames || []
    var eyesVisible=(frames[frame.key.pose] || {}).eyesVisible !== false
        && (frames[frame.previous.pose] || {}).eyesVisible !== false
    blink(state,eyesVisible,still,state.authoredEyes)
    result.eyeClose=Math.max(result.eyeClose || 0,state.blink)
    result.pose=state.pose; result.keyIndex=state.keyIndex; result.phase=state.phase
    result.beat=amount>.1 ? idle.label : "At ease"; result.blink=state.blink
    result.breath=breath*intensity
    return result
}
