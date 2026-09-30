package dev.otectus.cere.mobile

import dev.otectus.cere.mobile.protocol.Agent
import dev.otectus.cere.mobile.protocol.ApprovalQuestion
import dev.otectus.cere.mobile.protocol.Session

internal fun Agent.isActive() = status in setOf("starting", "running", "waiting")

internal fun agentStatusLabel(status: String) = when (status) {
    "starting" -> "Starting"
    "running" -> "Working"
    "waiting" -> "Waiting"
    "completed" -> "Completed"
    "failed" -> "Failed"
    "interrupted" -> "Interrupted"
    "closed" -> "Closed"
    else -> status.replaceFirstChar(Char::uppercase)
}

internal fun Session.activeAgentCount() = agents.count(Agent::isActive)

internal fun sessionDisplayStatus(session: Session, pendingInput: Int = 0): String = when {
    pendingInput == 1 -> "Waiting for input"
    pendingInput > 1 -> "${pendingInput} inputs needed"
    session.activeAgentCount() == 1 -> "1 subagent active"
    session.activeAgentCount() > 1 -> "${session.activeAgentCount()} subagents active"
    session.activity == "thinking" -> "Thinking"
    session.activity == "speaking" -> "Responding"
    session.activity == "working" -> "Using tools"
    session.activity == "delegating" -> "Delegating"
    session.activity == "waitingForAgents" -> "Waiting for subagents"
    session.activity == "compacting" -> "Compacting context"
    session.activity == "planning" -> "Planning"
    else -> session.status.replaceFirstChar(Char::uppercase)
}

internal fun questionError(question: ApprovalQuestion, answers: List<String>): String? =
    if (question.required && answers.none(String::isNotBlank))
        if (question.multiSelect) "Select at least one answer." else "Choose or enter an answer."
    else null

internal fun selectQuestionOption(question: ApprovalQuestion, current: List<String>, label: String, selected: Boolean): List<String> {
    if (!question.multiSelect) return if (selected) listOf(label) else emptyList()
    return if (selected) (current + label).distinct() else current - label
}

internal fun questionOtherValue(question: ApprovalQuestion, answers: List<String>): String {
    val labels = question.options.map { it.label }.toSet()
    return answers.filterNot { it in labels }.joinToString("\n")
}

internal fun updateQuestionOther(question: ApprovalQuestion, current: List<String>, text: String): List<String> {
    val selected = if (question.multiSelect) {
        val labels = question.options.map { it.label }.toSet()
        current.filter { it in labels }
    } else emptyList()
    return if (text.isBlank()) selected else selected + text
}
