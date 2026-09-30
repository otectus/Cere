import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: card
    property var approval: ({})
    property var answers: ({})
    property var validationErrors: ({})
    property int requestId: -1
    property string error: ""
    property string approvalId: approval.id || ""
    readonly property var questions: approval.questions || []
    readonly property bool isQuestion: approval.kind === "question" || questions.length > 0
    // Every surface shows who is asking: a response answers exactly this requester.
    property var requester: (App.state.sessions || []).find(s => s.id === card.approval.sessionId) || null
    readonly property var requestingAgent: (requester?.agents || []).find(agent => agent.id === card.approval.nativeThreadId) || null

    function cloneAnswers(source) {
        const result = {}
        const input = source || {}
        Object.keys(input).forEach(id => {
            const value = input[id] || {}
            result[id] = {answers: (value.answers || []).map(answer => String(answer))}
        })
        return result
    }
    function loadDraft() {
        if (!approvalId || !isQuestion) {
            answers = ({})
            return
        }
        answers = cloneAnswers(App.questionDraft(approvalId))
    }
    function answerValues(questionId) {
        const value = answers[String(questionId)]
        return value && value.answers ? value.answers : []
    }
    function optionLabel(option) {
        return typeof option === "string" ? option : String(option?.label || "")
    }
    function optionLabels(question) {
        return (question.options || []).map(option => optionLabel(option))
    }
    function setValues(questionId, values) {
        const id = String(questionId)
        const next = cloneAnswers(answers)
        const clean = values.map(value => String(value)).filter(value => value.trim().length > 0)
        if (clean.length) next[id] = {answers: clean}
        else delete next[id]
        answers = next
        const nextErrors = Object.assign({}, validationErrors)
        delete nextErrors[id]
        validationErrors = nextErrors
        error = ""
        if (approvalId) App.setQuestionDraft(approvalId, next)
    }
    function toggleOption(question, label, checked) {
        const id = String(question.id)
        const values = answerValues(id).slice()
        if (question.multiSelect === true) {
            const index = values.indexOf(label)
            if (checked && index < 0) values.push(label)
            else if (!checked && index >= 0) values.splice(index, 1)
            setValues(id, values)
        } else {
            setValues(id, checked ? [label] : [])
        }
    }
    function otherValue(question) {
        const labels = optionLabels(question)
        return answerValues(question.id).filter(value => labels.indexOf(value) < 0).join("\n")
    }
    function setOther(question, text) {
        const value = text
        if (question.multiSelect === true) {
            const labels = optionLabels(question)
            const selected = answerValues(question.id).filter(answer => labels.indexOf(answer) >= 0)
            if (value.trim()) selected.push(value)
            setValues(question.id, selected)
        } else {
            setValues(question.id, value.trim() ? [value] : [])
        }
    }
    function validateAnswers() {
        const problems = {}
        questions.forEach(question => {
            if (question.required !== false && answerValues(question.id).length === 0)
                problems[String(question.id)] = question.multiSelect === true ? "Select at least one answer." : "Choose or enter an answer."
        })
        validationErrors = problems
        if (Object.keys(problems).length) {
            error = "Answer each required question before sending."
            return false
        }
        error = ""
        return true
    }
    function submit(choice) {
        if (requestId >= 0 || !App.connected) return
        if (choice === "answer" && !validateAnswers()) return
        requestId = App.rpc("approval.answer", {id: approvalId, choice: choice, answers: cloneAnswers(answers)})
    }

    onApprovalIdChanged: {
        requestId = -1
        error = ""
        validationErrors = ({})
        loadDraft()
    }
    Component.onCompleted: loadDraft()
    Connections {
        target: App
        function onQuestionDraftsChanged() { card.loadDraft() }
        function onStateChanged() {
            if (!App.connected && card.requestId >= 0) {
                card.requestId = -1
                card.error = "Response was not confirmed. Please try again after reconnecting."
            }
        }
        function onResult(id, value) {
            if (id === card.requestId) {
                card.requestId = -1
                card.error = value?.error || ""
            }
        }
    }

    color: "#29291f"
    border.color: "#867148"
    radius: 9
    implicitHeight: contents.implicitHeight + 24

    ColumnLayout {
        id: contents
        anchors.fill: parent
        anchors.margins: 12
        spacing: 8

        RowLayout {
            Layout.fillWidth: true
            spacing: 6
            Rectangle {
                Layout.preferredWidth: identity.implicitWidth + 12
                Layout.preferredHeight: 22
                radius: 5
                color: card.isQuestion ? "#173746" : "#3a3021"
                border.color: card.isQuestion ? Theme.cyan : Theme.amber
                CText {
                    id: identity
                    anchors.centerIn: parent
                    text: card.isQuestion ? "QUESTION" : "PERMISSION"
                    color: card.isQuestion ? Theme.cyan : Theme.amber
                    font.pixelSize: 9
                    font.bold: true
                    font.letterSpacing: 1
                }
            }
            Text {
                objectName: "approvalRequester_" + card.approvalId
                Layout.fillWidth: true
                Layout.minimumWidth: 0
                text: card.requester
                    ? card.requester.provider.toUpperCase() + " · " + card.requester.title + " · " + card.requester.id.slice(0, 8) + "\n" + card.requester.cwd
                    : card.approval.sessionId
                        ? "Ended conversation · " + card.approval.sessionId.slice(0, 8)
                        : "Cere desktop · manual request"
                textFormat: Text.PlainText
                color: Theme.muted
                font.pixelSize: 11
                elide: Text.ElideMiddle
                maximumLineCount: 2
                wrapMode: Text.Wrap
            }
            CButton {
                visible: !!card.requester && App.selectedId !== card.approval.sessionId
                text: "Open"
                implicitHeight: 26
                help: "Open the requesting conversation"
                onClicked: App.selectedId = card.approval.sessionId
            }
        }

        CText {
            visible: !!card.requestingAgent
            Layout.fillWidth: true
            text: "Subagent · " + (card.requestingAgent?.name || "")
            textFormat: Text.PlainText
            color: Theme.cyan
            font.pixelSize: 11
        }
        Text {
            text: card.approval.title || (card.isQuestion ? "A question needs your answer" : "Permission needed")
            textFormat: Text.PlainText
            Layout.fillWidth: true
            color: card.isQuestion ? Theme.text : Theme.amber
            font.bold: true
            font.pixelSize: 13
            wrapMode: Text.Wrap
        }
        Image {
            visible: !!card.approval.image
            source: card.approval.image ? "file://" + card.approval.image : ""
            Layout.fillWidth: true
            Layout.preferredHeight: 160
            fillMode: Image.PreserveAspectFit
        }
        ColumnLayout {
            visible: !!card.approval.url
            Layout.fillWidth: true
            CText { Layout.fillWidth: true; text: card.approval.url || ""; textFormat: Text.PlainText; color: Theme.muted; font.pixelSize: 11; wrapMode: Text.WrapAnywhere }
            CButton { text: "Open request page"; onClicked: App.openMessageLink(card.approval.url, "") }
            CText { Layout.fillWidth: true; text: "Complete the request in your browser, then confirm below."; color: Theme.muted; font.pixelSize: 11 }
        }
        ScrollView {
            id: details
            visible: !!card.approval.detail
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(130, detailText.implicitHeight)
            clip: true
            contentWidth: availableWidth
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            ScrollBar.vertical: CScrollBar {}
            TextArea {
                id: detailText
                text: card.approval.detail || ""
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
                color: Theme.text
                font.pixelSize: 11
                font.family: "monospace"
                background: null
            }
        }

        Repeater {
            model: card.questions
            Rectangle {
                id: questionBody
                required property var modelData
                required property int index
                readonly property var question: modelData
                readonly property string questionId: String(question.id)
                readonly property var options: question.options || []
                readonly property bool showOther: question.allowOther !== false
                Layout.fillWidth: true
                implicitHeight: questionContents.implicitHeight + 20
                radius: 7
                color: "#22272c"
                border.color: card.validationErrors[questionId] ? Theme.danger : Theme.line

                ColumnLayout {
                    id: questionContents
                    anchors.fill: parent
                    anchors.margins: 10
                    spacing: 7
                    RowLayout {
                        Layout.fillWidth: true
                        CText {
                            text: "Question " + (questionBody.index + 1) + " of " + card.questions.length
                            color: Theme.cyan
                            font.pixelSize: 10
                            font.bold: true
                        }
                        Item { Layout.fillWidth: true }
                        CText {
                            text: questionBody.question.required === false ? "Optional" : "Required"
                            color: Theme.muted
                            font.pixelSize: 10
                        }
                    }
                    Text {
                        text: questionBody.question.header || questionBody.question.question
                        textFormat: Text.PlainText
                        color: Theme.text
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                        font.pixelSize: 12
                        font.bold: !!questionBody.question.header
                    }
                    Text {
                        visible: !!questionBody.question.header && questionBody.question.question !== questionBody.question.header
                        text: questionBody.question.question || ""
                        textFormat: Text.PlainText
                        color: Theme.text
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                        font.pixelSize: 12
                    }

                    Repeater {
                        model: questionBody.options
                        ColumnLayout {
                            required property var modelData
                            readonly property string label: card.optionLabel(modelData)
                            Layout.fillWidth: true
                            spacing: 2
                            CCheckBox {
                                objectName: "question_" + card.approvalId + "_" + questionBody.questionId + "_" + label
                                Layout.fillWidth: true
                                text: label
                                checked: card.answerValues(questionBody.questionId).indexOf(label) >= 0
                                onClicked: card.toggleOption(questionBody.question, label, checked)
                            }
                            CText {
                                visible: typeof modelData !== "string" && !!modelData.description
                                Layout.fillWidth: true
                                Layout.leftMargin: 34
                                text: typeof modelData === "string" ? "" : modelData.description || ""
                                color: Theme.muted
                                font.pixelSize: 11
                                wrapMode: Text.Wrap
                            }
                        }
                    }

                    CField {
                        visible: questionBody.showOther && questionBody.question.isSecret === true
                        objectName: "questionOther_" + card.approvalId + "_" + questionBody.questionId
                        Layout.fillWidth: true
                        placeholderText: questionBody.options.length ? "Other answer" : "Enter your answer"
                        echoMode: TextInput.Password
                        Accessible.name: questionBody.question.question
                        text: card.otherValue(questionBody.question)
                        onTextEdited: card.setOther(questionBody.question, text)
                    }
                    ScrollView {
                        visible: questionBody.showOther && questionBody.question.isSecret !== true
                        Layout.fillWidth: true
                        Layout.preferredHeight: Math.min(130, Math.max(64, writtenAnswer.contentHeight + 20))
                        clip: true
                        contentWidth: availableWidth
                        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                        ScrollBar.vertical: CScrollBar {}
                        TextArea {
                            id: writtenAnswer
                            objectName: "questionOther_" + card.approvalId + "_" + questionBody.questionId
                            text: card.otherValue(questionBody.question)
                            placeholderText: questionBody.options.length ? "Other answer" : "Enter your answer"
                            color: Theme.text
                            placeholderTextColor: Theme.muted
                            selectionColor: "#396982"
                            font.family: Theme.font
                            font.pixelSize: 12
                            wrapMode: TextEdit.Wrap
                            selectByMouse: true
                            Accessible.name: questionBody.question.question
                            background: Rectangle {
                                radius: 6
                                color: Theme.input
                                border.color: writtenAnswer.activeFocus ? Theme.cyan : Theme.line
                            }
                            onTextChanged: if (activeFocus && text !== card.otherValue(questionBody.question)) card.setOther(questionBody.question, text)
                        }
                    }
                    CText {
                        visible: !!card.validationErrors[questionBody.questionId]
                        text: card.validationErrors[questionBody.questionId] || ""
                        color: Theme.danger
                        font.pixelSize: 11
                        Accessible.role: Accessible.AlertMessage
                    }
                }
            }
        }

        CText {
            visible: card.error.length > 0
            text: card.error
            color: Theme.danger
            font.pixelSize: 12
            wrapMode: Text.Wrap
            Accessible.role: Accessible.AlertMessage
        }
        Flow {
            Layout.fillWidth: true
            spacing: 8
            Repeater {
                model: card.approval.choices || []
                CButton {
                    required property string modelData
                    objectName: "approval_" + card.approvalId + "_" + modelData
                    enabled: App.connected && card.requestId < 0
                    width: Math.min(implicitWidth, parent.width)
                    text: modelData === "allow" ? (card.approval.url ? "I've completed it" : "Allow once") : modelData === "answer" ? "Send answers" : modelData === "deny" ? "Decline" : "Cancel turn"
                    primary: modelData === "allow" || modelData === "answer"
                    onClicked: card.submit(modelData)
                }
            }
        }
    }
}
