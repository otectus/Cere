import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Connections › Images & analysis: image backends (OpenAI, Google, or your own ComfyUI server),
// the optional vision helper, OCR, Code Lab and the low-memory profile. Keys for OpenAI and Google are the
// API keys above; a ComfyUI token is kept in its own owner-only file. Testing a connection never makes an image.
ColumnLayout {
    id: page
    objectName: "imageConnections"
    Layout.fillWidth: true; spacing: 10
    readonly property var saved: App.state.settings?.workbench || ({ imageConnections: [], vision: { provider: "", model: "" }, ocr: { languages: "eng" }, codeLab: { enabled: false }, lowMemory: false })
    property var details: ({})
    property string error: ""
    property string feedback: ""
    property int editing: -1
    RpcClient { id: rpc }
    function refresh() { rpc.call("images.connections", {}, value => { if (!value.error) { const next = {}; for (const c of value.connections) next[c.id] = c; details = next } }) }
    function save(list, message) { error = ""; rpc.call("settings.update", { workbench: { imageConnections: list } }, value => { if (value.error) error = value.error; else { feedback = message || "Saved"; refresh() } }) }
    function plain(c) { return { id: c.id, name: c.name, kind: c.kind, model: c.model, enabled: c.enabled, origin: c.origin, route: c.route, targetedInterrupt: c.targetedInterrupt, workflowId: c.workflowId, budget: c.budget } }
    Component.onCompleted: refresh()
    Connections { target: App; function onStateChanged() { if (JSON.stringify(page.saved.imageConnections.map(c => c.revision)) !== page.lastRevisions) { page.lastRevisions = JSON.stringify(page.saved.imageConnections.map(c => c.revision)); page.refresh() } } }
    property string lastRevisions: ""
    Repeater {
        model: page.saved.imageConnections
        Rectangle {
            id: connectionCard
            required property var modelData; required property int index
            Layout.fillWidth: true; implicitHeight: column.implicitHeight + 20; radius: Theme.radiusControl; color: Theme.surface; border.color: Theme.subtle
            ColumnLayout {
                id: column; x: 10; y: 10; width: parent.width - 20; spacing: 6
                RowLayout {
                    Layout.fillWidth: true
                    CText { Layout.fillWidth: true; text: modelData.name + " · " + (modelData.kind === "openai" ? "OpenAI Images" : modelData.kind === "google" ? "Google Gemini" : "ComfyUI") + (modelData.enabled ? "" : " · off"); font.weight: Font.DemiBold }
                    CButton { text: "Test"; quiet: true; implicitHeight: 30; onClicked: rpc.call("images.test", { connectionId: modelData.id }, value => { page.feedback = value.error ? "" : value.note || ((value.missingNodes || []).length || (value.missingModels || []).length ? "Missing: " + [...(value.missingNodes || []), ...(value.missingModels || [])].join(", ") : "ComfyUI " + value.version + " is reachable"); page.error = value.error || "" }) }
                    CButton { text: page.editing === index ? "Done" : "Edit"; quiet: true; implicitHeight: 30; onClicked: page.editing = page.editing === index ? -1 : index }
                }
                CText { color: Theme.muted; font.pixelSize: Theme.caption
                    text: [modelData.kind === "comfyui" ? modelData.origin + " · processes on " + (modelData.route === "local" ? "this computer" : modelData.route === "remote" ? "your own server" : modelData.route) : modelData.model + " · billed to your account",
                        modelData.budget.modelMayStart ? App.assistantName + " may start up to " + modelData.budget.imagesPerDay + " images a day" : App.assistantName + " asks before each image job",
                        modelData.kind !== "comfyui" && !(page.details[modelData.id]?.hasKey) ? "API key needed above" : ""].filter(s => s).join(" · ") }
                ColumnLayout {
                    visible: page.editing === index; Layout.fillWidth: true; spacing: 6
                    CField { id: name; Layout.fillWidth: true; text: modelData.name; placeholderText: "Name"; Accessible.name: "Connection name" }
                    CComboBox { id: model; visible: modelData.kind !== "comfyui"; Layout.fillWidth: true; editable: true; model: page.details[modelData.id]?.suggestions || []; editText: modelData.model; Accessible.name: "Image model ID" }
                    CText { visible: modelData.kind !== "comfyui"; text: "Suggestions come from the provider’s documentation (checked November 2026); availability depends on your account. Test checks it without making an image."; color: Theme.muted; font.pixelSize: Theme.caption }
                    CField { id: origin; visible: modelData.kind === "comfyui"; Layout.fillWidth: true; text: modelData.origin || ""; placeholderText: "http://127.0.0.1:8188"; Accessible.name: "ComfyUI address" }
                    CComboBox { id: route; visible: modelData.kind === "comfyui"; Layout.fillWidth: true; model: ["Runs on this computer", "Runs on my own server", "Not sure"]; currentIndex: modelData.route === "local" ? 0 : modelData.route === "remote" ? 1 : 2; Accessible.name: "Where the server runs" }
                    CCheckBox { id: targeted; visible: modelData.kind === "comfyui"; checked: !!modelData.targetedInterrupt; text: "This server stops only the job named in a cancel request (newer ComfyUI). Without this, Cere never interrupts a running job." }
                    RowLayout { visible: modelData.kind === "comfyui"; Layout.fillWidth: true
                        CField { id: token; Layout.fillWidth: true; echoMode: TextInput.Password; placeholderText: "Access token (optional, sent only to this server)"; Accessible.name: "ComfyUI access token" }
                        CButton { text: "Save token"; onClicked: rpc.call("images.setToken", { connectionId: modelData.id, token: token.text }, value => { token.text = ""; page.feedback = value.error ? "" : value.set ? "Token saved" : "Token removed"; page.error = value.error || "" }) } }
                    RowLayout { Layout.fillWidth: true
                        CCheckBox { id: mayStart; Layout.fillWidth: false; implicitWidth: 260; checked: modelData.budget.modelMayStart; text: App.assistantName + " may start jobs, up to" }
                        CSpinBox { id: perDay; from: 0; to: 500; value: modelData.budget.imagesPerDay; Accessible.name: "Images a day" }
                        CText { Layout.fillWidth: true; text: "images a day"; font.pixelSize: Theme.secondary } }
                    CCheckBox { id: enabled; checked: modelData.enabled; text: "Turned on" }
                    ColumnLayout {
                        visible: modelData.kind === "comfyui"; Layout.fillWidth: true; spacing: 4
                        CText { text: "Workflows"; font.weight: Font.DemiBold; font.pixelSize: Theme.secondary }
                        Repeater {
                            model: page.details[modelData.id]?.workflows || []
                            ColumnLayout {
                                required property var modelData
                                Layout.fillWidth: true; spacing: 2
                                CText { text: modelData.name + " · " + modelData.operation + " · binds " + modelData.bindings.join(", "); font.pixelSize: Theme.secondary }
                                CText { visible: modelData.cloudNodes.length > 0; text: "Uses cloud nodes: " + modelData.cloudNodes.join(", ") + ". Treated as a cloud service."; color: Theme.amber; font.pixelSize: Theme.caption }
                                CCheckBox { visible: modelData.unknownNodes.length > 0; checked: modelData.reviewedLocal; text: "I reviewed these custom nodes and they run locally: " + modelData.unknownNodes.slice(0, 8).join(", ")
                                    onToggled: rpc.call("images.reviewWorkflow", { connectionId: connectionCard.modelData.id, workflowId: modelData.id, reviewedLocal: checked }, value => page.error = value.error || "") }
                            }
                        }
                        CButton { text: "Import workflow (Export (API) JSON)…"; onClicked: { const path = App.chooseWorkflow(); if (path) rpc.call("images.importWorkflow", { connectionId: modelData.id, path: path }, value => { if (value.error) page.error = value.error; else { page.feedback = "Imported " + value.workflow.name + (value.check?.missingNodes?.length ? "; missing nodes: " + value.check.missingNodes.join(", ") : "") + (value.check?.missingModels?.length ? "; missing models: " + value.check.missingModels.join(", ") : ""); page.refresh() } }) } }
                        CText { text: "Cere binds the prompt, seed, size, input image and mask it finds, and downloads only the SaveImage output. It never installs nodes or models."; color: Theme.muted; font.pixelSize: Theme.caption }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        CButton { text: "Remove"; danger: true; onClicked: { page.editing = -1; page.save(page.saved.imageConnections.filter((_, i) => i !== index).map(page.plain), "Removed") } }
                        Item { Layout.fillWidth: true }
                        CButton { text: "Save"; primary: true; onClicked: {
                            const list = page.saved.imageConnections.map(page.plain)
                            list[index] = Object.assign(list[index], { name: name.text.trim(), model: modelData.kind === "comfyui" ? "" : model.editText.trim(), origin: modelData.kind === "comfyui" ? origin.text.trim() : undefined,
                                route: modelData.kind === "comfyui" ? ["local", "remote", "unknown"][route.currentIndex] : undefined, targetedInterrupt: modelData.kind === "comfyui" ? targeted.checked : undefined,
                                enabled: enabled.checked, budget: { imagesPerDay: perDay.value, modelMayStart: mayStart.checked } })
                            page.save(list, "Saved " + name.text.trim()) } }
                    }
                }
            }
        }
    }
    CText { visible: !page.saved.imageConnections.length; text: "No image backend yet. A text-only chat model can still make images through one of these."; color: Theme.muted; font.pixelSize: Theme.secondary }
    Flow {
        Layout.fillWidth: true; spacing: 6
        CButton { objectName: "addOpenAiImages"; text: "Add OpenAI Images"; onClicked: page.save(page.saved.imageConnections.map(page.plain).concat([{ name: "OpenAI images", kind: "openai", model: "gpt-image-2.6-sunburst", budget: { imagesPerDay: 20, modelMayStart: false } }]), "Added; check the model and test it") }
        CButton { objectName: "addGoogleImages"; text: "Add Google Gemini"; onClicked: page.save(page.saved.imageConnections.map(page.plain).concat([{ name: "Gemini images", kind: "google", model: "gemini-3.1-flash-image", budget: { imagesPerDay: 20, modelMayStart: false } }]), "Added; check the model and test it") }
        CButton { objectName: "addComfyUi"; text: "Add ComfyUI server"; onClicked: page.save(page.saved.imageConnections.map(page.plain).concat([{ name: "ComfyUI", kind: "comfyui", origin: "http://127.0.0.1:8188", budget: { imagesPerDay: 0, modelMayStart: false } }]), "Added; import a workflow and test it") }
    }
    CText { visible: !!page.feedback; text: page.feedback; color: Theme.accentText; font.pixelSize: Theme.secondary }
    CText { visible: !!page.error; text: page.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    SectionLabel { text: "Vision helper" }
    CText { text: "Lets a conversation whose model cannot see images ask another model about one selected image. Its answers are labeled as the helper’s. Private images are never sent to a helper their permissions do not allow."; color: Theme.muted; font.pixelSize: Theme.secondary }
    RowLayout {
        Layout.fillWidth: true
        CComboBox { id: visionProvider; objectName: "visionProvider"; Layout.preferredWidth: 200; model: ["None", "Ollama", "OpenAI API", "Claude API", "Google AI API", "Compatible endpoint"]
            currentIndex: ["", "ollama", "openai", "anthropic", "google", "compatible"].indexOf(page.saved.vision.provider); Accessible.name: "Vision helper provider" }
        CField { id: visionModel; objectName: "visionModel"; Layout.fillWidth: true; enabled: visionProvider.currentIndex > 0; text: page.saved.vision.model; placeholderText: "Model, such as an Ollama vision model"; Accessible.name: "Vision helper model" }
        CButton { text: "Save"; onClicked: rpc.call("settings.update", { workbench: { vision: { provider: ["", "ollama", "openai", "anthropic", "google", "compatible"][visionProvider.currentIndex], model: visionModel.text.trim() } } }, value => { page.error = value.error || ""; page.feedback = value.error ? "" : "Vision helper saved" }) }
    }
    SectionLabel { text: "Review helper" }
    CText { text: "A second model a conversation can ask for a narrow review: summarizing documents, reviewing a proposed change, summarizing research. It gets only the inputs chosen for that request, has no tools and changes nothing. Files are never sent to a helper their permissions do not allow."; color: Theme.muted; font.pixelSize: Theme.secondary }
    RowLayout {
        Layout.fillWidth: true
        CComboBox { id: helperProvider; objectName: "helperProvider"; Layout.preferredWidth: 200; model: ["None", "Ollama", "OpenAI API", "Claude API", "Google AI API", "Compatible endpoint"]
            currentIndex: Math.max(0, ["", "ollama", "openai", "anthropic", "google", "compatible"].indexOf(page.saved.helper?.provider || "")); Accessible.name: "Review helper provider" }
        CField { id: helperModel; objectName: "helperModel"; Layout.fillWidth: true; enabled: helperProvider.currentIndex > 0; text: page.saved.helper?.model || ""; placeholderText: "Model, such as a local Ollama model"; Accessible.name: "Review helper model" }
        CButton { text: "Save"; onClicked: rpc.call("settings.update", { workbench: { helper: { provider: ["", "ollama", "openai", "anthropic", "google", "compatible"][helperProvider.currentIndex], model: helperModel.text.trim() } } }, value => { page.error = value.error || ""; page.feedback = value.error ? "" : "Review helper saved" }) }
    }
    SectionLabel { text: "OCR, Code Lab and memory" }
    RowLayout {
        Layout.fillWidth: true
        CText { Layout.fillWidth: false; text: "OCR languages (Tesseract)" }
        CField { id: ocrLanguages; Layout.preferredWidth: 160; text: page.saved.ocr.languages; Accessible.name: "OCR languages" }
        CButton { text: "Save"; onClicked: rpc.call("settings.update", { workbench: { ocr: { languages: ocrLanguages.text.trim() } } }, value => page.error = value.error || "") }
    }
    CCheckBox { objectName: "codeLabEnabled"; checked: page.saved.codeLab.enabled; text: "Turn on Code Lab (isolated Python for analysis, charts and conversions)"; onToggled: rpc.call("settings.update", { workbench: { codeLab: { enabled: checked } } }, value => page.error = value.error || "") }
    CCheckBox { objectName: "lowMemory"; checked: page.saved.lowMemory; text: "Low-memory mode: image work on this computer waits while a reply is being generated"; onToggled: rpc.call("settings.update", { workbench: { lowMemory: checked } }, value => page.error = value.error || "") }
}
