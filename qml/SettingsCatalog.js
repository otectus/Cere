.pragma library

// The one map of Settings: groups, categories and the settings inside them. The Settings rail and
// chips, its search, the command palette and deep links all read it. Each setting names the
// objectName of the control it opens; tests/settings-catalog.test.ts checks every target exists.
// A category's `chip` is a shorter label for the narrow strip; its full label stays its name.

var groups = [
    {id: "cere", label: "Your companion"},
    {id: "assistant", label: "Assistant"},
    {id: "system", label: "System"}
]

var categories = [
    {id: "companion", group: "cere", label: "Companion", icon: "desktop",
        blurb: "How your companion looks, where they sit, and whether they wander. Profiles reduce distractions when you need to focus.",
        keywords: "appearance avatar character theme color colour cere daemona jade nova soap tactical tan pet window desktop size placement position dock home monitor login startup profile always on top",
        settings: [
            {label: "Avatar & colors", target: "avatarSelection", keywords: "appearance character cere daemona jade nova soap portrait skin theme colour color black red crimson blue violet purple tactical tan"},
            {label: "Desktop profile", target: "desktopProfile", keywords: "normal focus gaming presentation mode"},
            {label: "Always on top", target: "alwaysOnTop", keywords: "topmost above fullscreen windows"},
            {label: "Show or hide companion", target: "hideCere", keywords: "hidden visible pet cere"},
            {label: "Start Cere at login", target: "autostart", keywords: "startup boot autostart"},
            {label: "Character size", target: "characterSize", keywords: "scale pet bigger smaller"},
            {label: "Monitor home and docking", target: "saveHome", keywords: "position dock left right go home save monitor"},
            {label: "Roaming", target: "roaming", keywords: "follow mouse pointer wander move"},
            {label: "Interface size", target: "interfaceScale", keywords: "zoom scale text panel"}
        ]},
    {id: "personality", group: "cere", label: "Personality", icon: "edit",
        blurb: "Your companion’s name and conversation style. Shape their tone and attitude.",
        keywords: "tone style manner prompt attitude identity name",
        settings: [
            {label: "Assistant name", target: "assistantName", keywords: "rename identity call nickname"},
            {label: "Personality text", target: "personalityText", keywords: "prompt instructions tone style edit"},
            {label: "Restore default personality", target: "personalityReset", keywords: "reset original"},
            {label: "Saved styles", target: "behaviorPresetPicker", keywords: "presets profiles named personality load save library"},
            {label: "Preview personality instructions", target: "personalityPreviewToggle", keywords: "prompt preview exact instructions block"},
            {label: "Style details and checkpoints", target: "behaviorPresetDetails", keywords: "traits tone formality warmth humor directness posture tool limits formatting checks emoji checkpoint restore"},
            {label: "Export or import styles", target: "packageExport", keywords: "package share portable json import export"}
        ]},
    {id: "voice", group: "cere", label: "Voice", icon: "microphone",
        blurb: "How replies sound when read aloud, and how voice input hears you.",
        keywords: "speech tts speak read aloud audio sound piper kokoro elevenlabs indextts whisper",
        settings: [
            {label: "Microphone and speaker", target: "audioInputDevice", keywords: "audio device input output headset headphones speakers microphone mic pipewire alsa sink source"},
            {label: "Voice commands", target: "voiceCommandsEnabled", keywords: "spoken command navigation hands free accessibility stop speaking read again"},
            {label: "Read replies aloud", target: "speechEnabled", keywords: "speech tts automatic"},
            {label: "Speak replies from", target: "speechProvider_codex", keywords: "providers codex claude ollama antigravity api automatic speech"},
            {label: "Speech provider", target: "ttsProvider", keywords: "local piper kokoro indextts elevenlabs engine"},
            {label: "Speaking voice", target: "speechVoice", keywords: "piper kokoro heart bella"},
            {label: "Speaking speed", target: "speechRate", keywords: "rate fast slow"},
            {label: "Pitch", target: "speechPitch", keywords: "tone semitones lower higher"},
            {label: "Speaking volume", target: "speechVolume", keywords: "loudness mute cere"},
            {label: "Brief reading", target: "speechBrief", keywords: "short opening summary"},
            {label: "Test voice", target: "ttsTest", keywords: "preview try listen sample"},
            {label: "Local voice input", target: "whisperExecutable", keywords: "whisper transcription microphone push to talk dictation"}
        ]},
    {id: "motion", group: "cere", label: "Motion & expressions", chip: "Motion", icon: "star",
        blurb: "How your companion moves, breathes and reacts while keeping you company.",
        keywords: "animation movement gestures expressions quiet reduced intensity idle energy preview",
        settings: [
            {label: "Quiet mode", target: "quietMode", keywords: "silence pause notifications speech animations"},
            {label: "Reduce motion", target: "reducedMotion", keywords: "accessibility still animations"},
            {label: "Motion intensity", target: "motionIntensity", keywords: "breathing gaze hair sway gestures"},
            {label: "Idle energy", target: "idleEnergy", keywords: "calm lively"},
            {label: "Motion preview", target: "motionStage", keywords: "showcase stage play demo"},
            {label: "Respond to conversational tone", target: "expressiveCues", keywords: "mood reactions cues"},
            {label: "Preview an expression", target: "animationPicker", keywords: "gesture animation wave nod giggle"}
        ]},
    {id: "connections", group: "assistant", label: "Connections", icon: "model",
        blurb: "The available models and keys: your Ollama server, the coding CLIs and direct API access.",
        keywords: "ollama codex claude antigravity cli api keys openai anthropic google gemini models server host",
        settings: [
            {label: "Ollama server", target: "ollamaHost", keywords: "url host connect local"},
            {label: "Default Ollama model", target: "ollamaDefaultModel", keywords: "chat refresh"},
            {label: "Manage local models", target: "manageLocalModels", keywords: "download pull delete load unload vram gpu ollama models disk"},
            {label: "Command-line providers", target: "cliProviders", keywords: "codex claude code antigravity agy installed version status"},
            {label: "OpenAI API key", target: "apiKey_openai", keywords: "gpt"},
            {label: "Claude API key", target: "apiKey_anthropic", keywords: "anthropic"},
            {label: "Google AI API key", target: "apiKey_google", keywords: "gemini"},
            {label: "Compatible endpoint", target: "compatibleBaseUrl", keywords: "openai compatible lm studio llama.cpp vllm localai gateway base url custom server chat completions"}
        ]},
    {id: "knowledge", group: "assistant", label: "Knowledge", icon: "memory",
        blurb: "What your companion can look up and remember across your projects.",
        keywords: "web search memory recall remember embeddings extraction graph searxng duckduckgo brave mojeek documents collections notes vault",
        settings: [
            {label: "Web search", target: "webSearchEnabled", keywords: "internet online lookup sources"},
            {label: "Search provider", target: "webSearchProvider", keywords: "duckduckgo brave mojeek searxng"},
            {label: "Remember and recall conversations", target: "memoryEnabled", keywords: "memory recall shared"},
            {label: "Embedding model", target: "embeddingModel", keywords: "nomic embed ollama"},
            {label: "Graph extraction model", target: "extractionModel", keywords: "glm cloud extraction"},
            {label: "Share recalled memory with cloud models", target: "cloudMemoryEnabled", keywords: "codex claude cloud privacy"},
            {label: "Show memory citations in replies", target: "showMemoryCitations", keywords: "evidence markers references"},
            {label: "Manage project memory", target: "manageMemories", keywords: "facts notes forget correct inspector graph"},
            {label: "Document collections", target: "manageCollections", keywords: "documents files folders markdown index grounding sources rag library"},
            {label: "Markdown notes folder", target: "notesVaultEnabled", keywords: "notes vault obsidian markdown backlinks wiki private"}
        ]},
    {id: "assistance", group: "assistant", label: "AI assistance", icon: "shield",
        blurb: "What your companion may do on your desktop, and when permission is required.",
        keywords: "permissions bypass approvals desktop control categories grants power profile pause",
        settings: [
            {label: "Skip CLI permission prompts", target: "bypassCliPermissions", keywords: "bypass approvals cli"},
            {label: "Skip computer permission prompts", target: "bypassComputerPermissions", keywords: "bypass approvals desktop"},
            {label: "Permission Center and power sessions", target: "openPermissionCenter", keywords: "power lease temporary access"},
            {label: "Desktop assistance profile", target: "assistanceProfile", keywords: "manual scoped broad control"},
            {label: "Desktop categories", target: "assistanceCategories", keywords: "apps files windows audio media capture timers scripts providers"},
            {label: "Pause AI actions", target: "pauseActions", keywords: "stop resume tools"},
            {label: "Standing grants", target: "grantHour", keywords: "one hour project grant revoke broad"},
            {label: "Tool servers (MCP)", target: "addToolServer", keywords: "mcp model context protocol extensions integrations plugins github tools servers"},
            {label: "Custom tools", target: "addCustomTool", keywords: "http rest api request webhook command program template custom tool"}
        ]},
    {id: "scripts", group: "assistant", label: "Saved scripts", chip: "Scripts", icon: "terminal",
        blurb: "Commands you trust Cere to run. Each one is reviewed in Desktop before it runs.",
        keywords: "commands executable shell run working folder",
        settings: [
            {label: "Add a saved script", target: "addScript", keywords: "new command executable"}
        ]},
    {id: "mobile", group: "system", label: "Cere Mobile", icon: "chat",
        blurb: "Take Cere along on your Android phone, paired over a network you choose.",
        keywords: "android phone remote pairing qr wireguard tailscale lan devices gateway",
        settings: [
            {label: "Disable remote access", target: "disableRemote", keywords: "off stop gateway"},
            {label: "Pair a phone", target: "pairingResponse", keywords: "qr pairing response verify"}
        ]},
    {id: "telemetry", group: "system", label: "Workspace telemetry", chip: "Telemetry", icon: "context",
        blurb: "Share recent shell and file activity only from the workspaces you pick.",
        keywords: "shell hooks files activity fish bash zsh cere-run workspaces edits",
        settings: [
            {label: "Enable workspace telemetry", target: "telemetryEnabled", keywords: "activity listener watcher"},
            {label: "Add a workspace", target: "telemetryAddWorkspace", keywords: "folder project root"},
            {label: "Ignore patterns", target: "telemetryIgnores", keywords: "exclude paths"},
            {label: "Include command text", target: "telemetryCommands", keywords: "commands redact secrets"},
            {label: "Include stderr from cere-run", target: "telemetryOutput", keywords: "errors output"}
        ]},
    {id: "application", group: "system", label: "Application", icon: "settings",
        blurb: "Cere’s shortcut, how you send messages, your backups, a health check and the way out.",
        keywords: "hyprland shortcut keybinding send key enter composer backup restore recovery health diagnostics quit exit",
        settings: [
            {label: "Copy Hyprland shortcut", target: "copyShortcut", keywords: "keybinding super toggle"},
            {label: "Send messages with", target: "sendKey", keywords: "enter ctrl control keyboard composer newline new line send button submit"},
            {label: "Backup and restore", target: "openBackup", keywords: "recovery export import profile"},
            {label: "Health and recovery", target: "openHealth", keywords: "diagnostics inspect logs report repair responsiveness slow latency measure timing"},
            {label: "Quit and keep sessions running", target: "quitKeepSessions", keywords: "exit close"},
            {label: "Stop sessions and quit", target: "stopAndQuit", keywords: "exit"}
        ]}
]

// Where Settings opens first, and where it reopens in this process: both Cere windows share it.
var defaultCategory = "companion"
var lastCategory = defaultCategory
function remember(id) { if (category(id)) lastCategory = id }

function category(id) {
    for (var index = 0; index < categories.length; index++) if (categories[index].id === id) return categories[index]
    return null
}
function group(id) {
    for (var index = 0; index < groups.length; index++) if (groups[index].id === id) return groups[index]
    return null
}
// Categories offered right now; `hidden` lists ids that are unavailable (Voice without speech).
function visibleCategories(hidden) {
    return categories.filter(function (entry) { return !hidden || hidden.indexOf(entry.id) < 0 })
}
// The category whose page holds a control, by the control's objectName.
function categoryOf(target) {
    for (var index = 0; index < categories.length; index++)
        if (categories[index].settings.some(function (setting) { return setting.target === target })) return categories[index].id
    return ""
}

// A setting's own label beats its keywords, which beat a category; an exact category name leads.
function containsWords(text, words) {
    var tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(function (token) { return token.length > 0 })
    return words.every(function (word) {
        return tokens.some(function (token) { return token.indexOf(word) === 0 })
    })
}
function rank(label, text, words) {
    var phrase = words.join(" ")
    label = label.toLowerCase()
    if (!containsWords(text, words)) return 0
    if (label === phrase) return 100
    if (label.indexOf(phrase) === 0) return 90
    if (label.indexOf(phrase) >= 0) return 80
    if (words.every(function (word) { return label.indexOf(word) >= 0 })) return 70
    return 40
}
// Matches for every word of the query, best first: {category, setting (null for a category), score}.
function search(query, hidden) {
    var words = String(query || "").toLowerCase().split(/\s+/).filter(function (word) { return word.length > 0 })
    if (!words.length) return []
    var results = []
    visibleCategories(hidden).forEach(function (entry) {
        var own = rank(entry.label, (entry.label + " " + entry.keywords).toLowerCase(), words)
        if (own) results.push({category: entry, setting: null, score: own === 100 ? 95 : own >= 70 ? 50 : 20, order: results.length})
        entry.settings.forEach(function (setting) {
            var score = rank(setting.label, (setting.label + " " + setting.keywords).toLowerCase(), words)
            if (score) results.push({category: entry, setting: setting, score: score, order: results.length})
        })
    })
    results.sort(function (a, b) { return b.score - a.score || a.order - b.order })
    return results.slice(0, 40)
}
