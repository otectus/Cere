import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// The image editor. Every change makes a new version: crops, rotations, resizes and format changes run
// locally and deterministically in the broker; annotations and masks are drawn here at the image's own
// pixel size (after EXIF orientation) and kept as an editable recipe beside the flattened result.
// A mask is its own artifact: white edits, transparent keeps.
Item {
    id: editor
    objectName: "imageWorkbench"
    property string sessionId: ""
    readonly property string artifactId: WorkbenchState.artifactId
    readonly property string versionId: WorkbenchState.versionId
    property var info: null
    property string path: ""
    property string error: ""
    property string notice: ""
    property string tool: "pan"
    property color ink: "#ff3b30"
    property int brush: 24
    property var shapes: []
    property var undone: []
    property var maskStrokes: []
    property bool maskInverted: false
    property var cropRect: null
    property string cropRatio: "free"
    property string compareId: ""
    property string comparePath: ""
    property real split: 0.5
    readonly property int naturalWidth: picture.implicitWidth
    readonly property int naturalHeight: picture.implicitHeight
    signal closeRequested()
    signal maskReady(var ref)
    RpcClient { id: rpc }
    function load() {
        if (!artifactId || !versionId || !sessionId) return
        rpc.call("artifacts.get", { sessionId: sessionId, artifactId: artifactId }, value => { if (!value.error) info = value })
        rpc.call("artifacts.file", { sessionId: sessionId, artifactId: artifactId, versionId: versionId }, value => {
            if (value.error) { error = value.error; return }
            path = value.path; error = ""
            const draft = WorkbenchState.draft(versionId)
            shapes = draft ? draft.shapes : []; maskStrokes = draft ? draft.mask : []; maskInverted = draft ? draft.inverted : false; undone = []
        })
    }
    function keepDraft() { WorkbenchState.keepDraft(versionId, shapes.length || maskStrokes.length || maskInverted ? { shapes: shapes, mask: maskStrokes, inverted: maskInverted } : undefined) }
    function add(shape) { if (shape.layer === "mask") maskStrokes = maskStrokes.concat([shape]); else shapes = shapes.concat([shape]); undone = []; keepDraft(); annotations.requestPaint(); maskLayer.requestPaint() }
    function undo() {
        const last = [...shapes, ...maskStrokes].sort((a, b) => b.at - a.at)[0]; if (!last) return
        undone = undone.concat([last]); if (last.layer === "mask") maskStrokes = maskStrokes.filter(s => s !== last); else shapes = shapes.filter(s => s !== last)
        keepDraft(); annotations.requestPaint(); maskLayer.requestPaint()
    }
    function redo() { const shape = undone[undone.length - 1]; if (!shape) return; undone = undone.slice(0, -1); if (shape.layer === "mask") maskStrokes = maskStrokes.concat([shape]); else shapes = shapes.concat([shape]); keepDraft(); annotations.requestPaint(); maskLayer.requestPaint() }
    function applySteps(steps, label) {
        notice = ""; error = ""
        rpc.call("images.transform", { sessionId: sessionId, artifactId: artifactId, versionId: versionId, steps: steps }, value => {
            if (value.error) { error = value.error; return }
            notice = label + " · new version"; WorkbenchState.keepDraft(versionId, undefined); WorkbenchState.versionId = value.versionId; load()
        })
    }
    function saveAnnotations() {
        cropRect = null; annotations.requestPaint()
        Qt.callLater(() => {
            const data = annotations.toDataURL("image/png")
            rpc.call("images.saveEdit", { sessionId: sessionId, artifactId: artifactId, versionId: versionId, layer: data, recipe: JSON.stringify({ base: versionId, shapes: shapes }) }, value => {
                if (value.error) { error = value.error; return }
                notice = "Annotations saved as a new version; the original is unchanged"; WorkbenchState.keepDraft(versionId, undefined); shapes = []; WorkbenchState.versionId = value.versionId; load()
            })
        })
    }
    function saveMask() {
        const data = maskLayer.exportMask()
        rpc.call("images.mask", { sessionId: sessionId, artifactId: artifactId, versionId: versionId, mask: data }, value => {
            if (value.error) { error = value.error; return }
            notice = "Mask saved (" + value.provenance.coverage + "% of the image)"; editor.maskReady({ artifactId: value.artifactId, versionId: value.versionId })
        })
    }
    function applyCrop() {
        if (!cropRect || cropRect.width < 2 || cropRect.height < 2) return
        applySteps([{ op: "crop", left: Math.round(cropRect.x), top: Math.round(cropRect.y), width: Math.round(cropRect.width), height: Math.round(cropRect.height) }], "Cropped"); cropRect = null
    }
    function ratioOf(name) { return name === "1:1" ? 1 : name === "4:3" ? 4 / 3 : name === "3:2" ? 3 / 2 : name === "16:9" ? 16 / 9 : name === "9:16" ? 9 / 16 : 0 }
    function fit() { const z = Math.min(view.width / Math.max(1, naturalWidth), view.height / Math.max(1, naturalHeight)); WorkbenchState.zoom = Math.max(0.05, Math.min(8, z)) }
    onVersionIdChanged: load()
    onSessionIdChanged: load()
    Component.onCompleted: load()
    Keys.onPressed: event => {
        if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_Z) { if (event.modifiers & Qt.ShiftModifier) redo(); else undo(); event.accepted = true }
        else if (event.key === Qt.Key_Escape) { closeRequested(); event.accepted = true }
    }
    ColumnLayout {
        anchors.fill: parent; spacing: 6
        RowLayout {
            Layout.fillWidth: true; spacing: 6
            CButton { objectName: "imageEditorBack"; text: "Gallery"; iconName: "back"; quiet: true; onClicked: editor.closeRequested() }
            CText { Layout.fillWidth: true; text: (info?.artifact?.name || "") + (editor.naturalWidth ? " · " + editor.naturalWidth + "×" + editor.naturalHeight : ""); elide: Text.ElideMiddle; wrapMode: Text.NoWrap; font.weight: Font.DemiBold }
            CComboBox { objectName: "imageVersion"; implicitWidth: 140; model: (editor.info?.versions || []).map((v, i) => "Version " + (i + 1)); currentIndex: Math.max(0, (editor.info?.versions || []).findIndex(v => v.versionId === editor.versionId)); Accessible.name: "Version"
                onActivated: index => WorkbenchState.versionId = editor.info.versions[index].versionId }
        }
        Flow {
            Layout.fillWidth: true; spacing: 4
            Repeater {
                model: [["pan", "Move"], ["crop", "Crop"], ["arrow", "Arrow"], ["rect", "Box"], ["pen", "Draw"], ["text", "Label"], ["mask", "Mask brush"], ["erase", "Mask eraser"]]
                CButton { required property var modelData; objectName: "imageTool_" + modelData[0]; text: modelData[1]; implicitHeight: 30; quiet: editor.tool !== modelData[0]; primary: editor.tool === modelData[0]; Accessible.role: Accessible.RadioButton; Accessible.checked: editor.tool === modelData[0]; onClicked: { editor.tool = modelData[0]; editor.forceActiveFocus() } }
            }
        }
        Flow {
            Layout.fillWidth: true; spacing: 4
            CButton { text: "Fit"; implicitHeight: 30; quiet: true; onClicked: editor.fit() }
            CButton { text: "100%"; implicitHeight: 30; quiet: true; onClicked: WorkbenchState.zoom = 1 }
            CSlider { implicitWidth: 120; from: 0.05; to: 8; value: WorkbenchState.zoom; onMoved: WorkbenchState.zoom = value; Accessible.name: "Zoom" }
            CButton { text: "Undo"; implicitHeight: 30; quiet: true; enabled: editor.shapes.length + editor.maskStrokes.length > 0; onClicked: editor.undo() }
            CButton { text: "Redo"; implicitHeight: 30; quiet: true; enabled: editor.undone.length > 0; onClicked: editor.redo() }
            CButton { text: "Rotate"; implicitHeight: 30; quiet: true; onClicked: editor.applySteps([{ op: "rotate", degrees: 90 }], "Rotated") }
            CButton { text: "Flip"; implicitHeight: 30; quiet: true; onClicked: editor.applySteps([{ op: "flip", axis: "horizontal" }], "Flipped") }
            CButton { text: "Resize…"; implicitHeight: 30; quiet: true; onClicked: resizeDialog.open() }
            CButton { text: "Export as…"; implicitHeight: 30; quiet: true; onClicked: formatDialog.open() }
            CButton { text: "Open in another app"; implicitHeight: 30; quiet: true; help: "Edit a copy elsewhere, then import it back as a new version"; onClicked: externalDialog.open() }
        }
        RowLayout {
            visible: editor.tool === "crop"; Layout.fillWidth: true; spacing: 4
            CComboBox { implicitWidth: 120; model: ["free", "1:1", "4:3", "3:2", "16:9", "9:16"]; onActivated: index => editor.cropRatio = model[index]; Accessible.name: "Crop ratio" }
            CText { Layout.fillWidth: true; text: editor.cropRect ? Math.round(editor.cropRect.width) + "×" + Math.round(editor.cropRect.height) + " at " + Math.round(editor.cropRect.x) + ", " + Math.round(editor.cropRect.y) : "Drag on the image to choose the area"; color: Theme.muted; font.pixelSize: Theme.caption }
            CButton { objectName: "imageApplyCrop"; text: "Crop"; primary: true; implicitHeight: 30; enabled: !!editor.cropRect; onClicked: editor.applyCrop() }
        }
        RowLayout {
            visible: ["arrow", "rect", "pen", "text", "mask", "erase"].indexOf(editor.tool) >= 0; Layout.fillWidth: true; spacing: 4
            Repeater { model: ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"]
                Rectangle { required property string modelData; visible: editor.tool !== "mask" && editor.tool !== "erase"; width: 22; height: 22; radius: 11; color: modelData; border.width: editor.ink == modelData ? 3 : 1; border.color: Theme.focus
                    Accessible.role: Accessible.Button; Accessible.name: "Color " + modelData; MouseArea { anchors.fill: parent; onClicked: editor.ink = parent.modelData } } }
            CText { Layout.fillWidth: false; text: "Size" } CSpinBox { from: 1; to: 400; value: editor.brush; onValueModified: editor.brush = value; Accessible.name: "Brush size" }
            CField { id: labelText; visible: editor.tool === "text"; implicitWidth: 160; placeholderText: "Label text"; Accessible.name: "Label text" }
            CButton { visible: editor.tool === "mask" || editor.tool === "erase"; text: editor.maskInverted ? "Uninvert" : "Invert"; implicitHeight: 30; quiet: true; onClicked: { editor.maskInverted = !editor.maskInverted; editor.keepDraft(); maskLayer.requestPaint() } }
            CButton { visible: editor.tool === "mask" || editor.tool === "erase"; text: "Clear mask"; implicitHeight: 30; quiet: true; onClicked: { editor.maskStrokes = []; editor.maskInverted = false; editor.keepDraft(); maskLayer.requestPaint() } }
        }
        CText { visible: !!editor.error; text: editor.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { visible: !!editor.notice; text: editor.notice; color: Theme.accentText; font.pixelSize: Theme.secondary }
        Flickable {
            id: view; objectName: "imageCanvas"
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true
            contentWidth: stage.width * WorkbenchState.zoom; contentHeight: stage.height * WorkbenchState.zoom
            interactive: editor.tool === "pan"; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: CScrollBar {}
            ScrollBar.horizontal: ScrollBar {}
            Item {
                id: stage; width: editor.naturalWidth; height: editor.naturalHeight; scale: WorkbenchState.zoom; transformOrigin: Item.TopLeft
                // Transparency shows as a checkerboard, never as an invented background color.
                Canvas { anchors.fill: parent; onPaint: { const c = getContext("2d"); for (let y = 0; y < height; y += 16) for (let x = 0; x < width; x += 16) { c.fillStyle = ((x + y) / 16) % 2 ? "#cccccc" : "#ffffff"; c.fillRect(x, y, 16, 16) } } }
                Image { id: picture; source: editor.path ? "file://" + editor.path : ""; autoTransform: true; cache: false; smooth: WorkbenchState.zoom < 2; Accessible.role: Accessible.Graphic; Accessible.name: "Image being edited" }
                // Comparing: the chosen version on the left of the divider (before), this one on the right (after).
                Item { visible: !!editor.comparePath; x: 0; y: 0; width: parent.width * editor.split; height: parent.height; clip: true
                    Image { source: editor.comparePath ? "file://" + editor.comparePath : ""; autoTransform: true; width: stage.width; height: stage.height; fillMode: Image.Stretch } }
                Rectangle { visible: !!editor.comparePath; x: parent.width * editor.split - width / 2; width: 2 / WorkbenchState.zoom; height: parent.height; color: Theme.focus }
                Canvas {
                    id: maskLayer; anchors.fill: parent; opacity: 0.45; canvasSize: Qt.size(width, height)
                    function draw(c, color, overlay) {
                        c.save(); c.clearRect(0, 0, width, height)
                        if (editor.maskInverted) { c.fillStyle = color; c.fillRect(0, 0, width, height); c.globalCompositeOperation = "destination-out" }
                        for (const s of editor.maskStrokes) {
                            c.lineCap = "round"; c.lineJoin = "round"; c.lineWidth = s.size
                            const erase = s.erase !== editor.maskInverted
                            c.globalCompositeOperation = erase ? "destination-out" : "source-over"; c.strokeStyle = color
                            c.beginPath(); c.moveTo(s.points[0].x, s.points[0].y); for (const p of s.points) c.lineTo(p.x, p.y); c.stroke()
                        }
                        c.restore()
                    }
                    onPaint: draw(getContext("2d"), Theme.danger, true)
                    // The exported mask is white where the image may change and transparent elsewhere, at full size.
                    function exportMask() { const c = getContext("2d"); draw(c, "#ffffff", false); const data = toDataURL("image/png"); requestPaint(); return data }
                }
                Canvas {
                    id: annotations; anchors.fill: parent; canvasSize: Qt.size(width, height)
                    onPaint: {
                        const c = getContext("2d"); c.clearRect(0, 0, width, height)
                        for (const s of editor.shapes) {
                            c.strokeStyle = s.color; c.fillStyle = s.color; c.lineWidth = s.size; c.lineCap = "round"; c.lineJoin = "round"
                            if (s.kind === "rect") c.strokeRect(s.x, s.y, s.w, s.h)
                            else if (s.kind === "pen") { c.beginPath(); c.moveTo(s.points[0].x, s.points[0].y); for (const p of s.points) c.lineTo(p.x, p.y); c.stroke() }
                            else if (s.kind === "arrow") { const a = Math.atan2(s.y2 - s.y, s.x2 - s.x), h = Math.max(10, s.size * 3); c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x2, s.y2); c.stroke(); c.beginPath(); c.moveTo(s.x2, s.y2); c.lineTo(s.x2 - h * Math.cos(a - 0.5), s.y2 - h * Math.sin(a - 0.5)); c.lineTo(s.x2 - h * Math.cos(a + 0.5), s.y2 - h * Math.sin(a + 0.5)); c.closePath(); c.fill() }
                            else if (s.kind === "text") { c.font = (s.size * 3) + "px sans-serif"; c.fillText(s.text, s.x, s.y) }
                        }
                        if (editor.cropRect) { c.strokeStyle = Theme.focus; c.lineWidth = 2 / WorkbenchState.zoom; c.setLineDash([6, 4]); c.strokeRect(editor.cropRect.x, editor.cropRect.y, editor.cropRect.width, editor.cropRect.height) }
                    }
                }
                MouseArea {
                    anchors.fill: parent; enabled: editor.tool !== "pan"; cursorShape: Qt.CrossCursor
                    property var current: null
                    function clamp(p) { return { x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) } }
                    onPressed: mouse => {
                        const p = clamp(mouse)
                        if (editor.tool === "crop") current = { x0: p.x, y0: p.y }
                        else if (editor.tool === "pen" || editor.tool === "mask" || editor.tool === "erase") current = { kind: "pen", layer: editor.tool === "pen" ? "annotations" : "mask", erase: editor.tool === "erase", color: editor.ink.toString(), size: editor.brush, points: [p], at: Date.now() }
                        else if (editor.tool === "text") { if (labelText.text.trim()) editor.add({ kind: "text", layer: "annotations", text: labelText.text, x: p.x, y: p.y, color: editor.ink.toString(), size: Math.max(4, editor.brush / 2), at: Date.now() }) }
                        else current = { kind: editor.tool, layer: "annotations", x: p.x, y: p.y, x2: p.x, y2: p.y, w: 0, h: 0, color: editor.ink.toString(), size: Math.max(2, editor.brush / 6), at: Date.now() }
                    }
                    onPositionChanged: mouse => {
                        if (!current) return
                        const p = clamp(mouse)
                        if (editor.tool === "crop") {
                            let w = p.x - current.x0, h = p.y - current.y0; const r = editor.ratioOf(editor.cropRatio)
                            if (r) h = Math.sign(h || 1) * Math.abs(w) / r
                            editor.cropRect = Qt.rect(Math.min(current.x0, current.x0 + w), Math.min(current.y0, current.y0 + h), Math.abs(w), Math.min(Math.abs(h), height)); annotations.requestPaint()
                        } else if (current.points) { current.points.push(p); if (current.layer === "mask") { editor.maskStrokes = editor.maskStrokes.filter(s => s !== current).concat([current]); maskLayer.requestPaint() } else { editor.shapes = editor.shapes.filter(s => s !== current).concat([current]); annotations.requestPaint() } }
                        else { current.x2 = p.x; current.y2 = p.y; current.w = p.x - current.x; current.h = p.y - current.y; editor.shapes = editor.shapes.filter(s => s !== current).concat([current]); annotations.requestPaint() }
                    }
                    onReleased: { if (current && editor.tool !== "crop") { editor.shapes = editor.shapes.filter(s => s !== current); editor.maskStrokes = editor.maskStrokes.filter(s => s !== current); editor.add(current) } current = null }
                }
            }
            onWidthChanged: if (WorkbenchState.zoom === 1 && editor.naturalWidth > width) Qt.callLater(editor.fit)
        }
        RowLayout {
            visible: !!editor.comparePath; Layout.fillWidth: true
            CText { Layout.fillWidth: false; text: "Before" } CSlider { Layout.fillWidth: true; from: 0; to: 1; value: editor.split; onMoved: editor.split = value; Accessible.name: "Comparison divider" } CText { Layout.fillWidth: false; text: "After" }
        }
        Flow {
            Layout.fillWidth: true; spacing: 6
            CComboBox { objectName: "imageCompare"; implicitWidth: 170; model: ["Compare with…"].concat((editor.info?.versions || []).map((v, i) => "Version " + (i + 1))); Accessible.name: "Compare with version"
                onActivated: index => { if (!index) { editor.comparePath = ""; return } const v = editor.info.versions[index - 1]; rpc.call("artifacts.file", { sessionId: editor.sessionId, artifactId: editor.artifactId, versionId: v.versionId }, value => editor.comparePath = value.error ? "" : value.path) } }
            CButton { objectName: "imageSaveAnnotations"; text: "Save annotations"; enabled: editor.shapes.length > 0; onClicked: editor.saveAnnotations() }
            CButton { objectName: "imageSaveMask"; text: "Use mask for an edit"; primary: editor.maskStrokes.length > 0; enabled: editor.maskStrokes.length > 0 || editor.maskInverted; onClicked: editor.saveMask() }
        }
    }
    CDialog {
        id: resizeDialog
        CText { text: "Resize"; font.pixelSize: Theme.title; font.bold: true }
        RowLayout { CSpinBox { id: newWidth; from: 1; to: 16384; value: Math.max(1, editor.naturalWidth); Accessible.name: "Width" } CText { Layout.fillWidth: false; text: "×" } CSpinBox { id: newHeight; from: 1; to: 16384; value: Math.max(1, editor.naturalHeight); Accessible.name: "Height" } }
        CCheckBox { id: nearest; text: "Nearest-neighbor (keeps pixel art crisp)" }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: resizeDialog.close() } CButton { text: "Resize"; primary: true; onClicked: { resizeDialog.close(); editor.applySteps([{ op: "resize", width: newWidth.value, height: newHeight.value, fit: "fill", kernel: nearest.checked ? "nearest" : "lanczos3" }], "Resized") } } }
    }
    CDialog {
        id: formatDialog
        CText { text: "Export as"; font.pixelSize: Theme.title; font.bold: true }
        CComboBox { id: targetFormat; model: ["png", "jpeg", "webp"]; Accessible.name: "Format" }
        CText { visible: targetFormat.currentText === "jpeg"; text: "JPEG cannot store transparency. Transparent areas are filled with:"; font.pixelSize: Theme.secondary }
        CField { id: flattenColor; visible: targetFormat.currentText === "jpeg"; text: "#ffffff"; Accessible.name: "Background color" }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: formatDialog.close() }
            CButton { text: "Make version"; primary: true; onClicked: { formatDialog.close(); editor.applySteps([Object.assign({ op: "format", format: targetFormat.currentText }, targetFormat.currentText === "jpeg" ? { flatten: flattenColor.text } : {})], "Converted to " + targetFormat.currentText.toUpperCase()) } } }
    }
    CDialog {
        id: externalDialog
        property string saved: ""
        CText { text: "Edit in another application"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: "Save a copy, edit it in your editor, then import the edited file back as a new version. The original stays as it is." }
        CButton { text: "Save a copy and open it"; onClicked: { const path = App.chooseSavePath(editor.info?.artifact?.name || "image.png"); if (!path) return; rpc.call("artifacts.saveAs", { sessionId: editor.sessionId, artifactId: editor.artifactId, versionId: editor.versionId, path: path, replace: true }, value => { if (value.error) editor.error = value.error; else { externalDialog.saved = value.path; App.openPath(value.path) } }) } }
        CButton { text: "Import the edited file as a new version"; enabled: !!externalDialog.saved; onClicked: rpc.call("artifacts.import", { sessionId: editor.sessionId, path: externalDialog.saved, artifactId: editor.artifactId, destinations: (editor.info?.versions || []).slice(-1)[0]?.policy || {} }, value => { if (value.error) editor.error = value.error; else { externalDialog.close(); WorkbenchState.versionId = value.versionId; editor.load() } }) }
        CButton { text: "Close"; quiet: true; onClicked: externalDialog.close() }
    }
}
