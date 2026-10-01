.pragma library

// Display names shared by every surface that names a provider.
const providerNames = {codex: "Codex", claude: "Claude", ollama: "Ollama", antigravity: "AntiGravity",
    openai: "OpenAI API", anthropic: "Claude API", google: "Google AI API"}

function provider(id) {
    const value = String(id || "")
    return providerNames[value] || (value ? value.charAt(0).toUpperCase() + value.slice(1) : "")
}
