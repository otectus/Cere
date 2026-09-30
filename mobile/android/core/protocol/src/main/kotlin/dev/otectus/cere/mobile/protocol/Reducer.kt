package dev.otectus.cere.mobile.protocol

data class ReducedState(
    val cursor: String? = null,
    val sessions: Map<String, Session> = emptyMap(),
    val messages: Map<String, Message> = emptyMap(),
    val approvals: Map<String, Approval> = emptyMap(),
    val activity: Map<String, ActivityItem> = emptyMap(),
)

object EventReducer {
    fun snapshot(snapshot: SyncSnapshot) = ReducedState(
        cursor = snapshot.cursor,
        sessions = snapshot.sessions.associateBy(Session::id),
        messages = snapshot.messages.associateBy(Message::id),
        approvals = snapshot.approvals.associateBy(Approval::id),
    )

    fun apply(state: ReducedState, event: Event): ReducedState {
        fun newer(incoming: String, current: String?): Boolean {
            if (current == null) return true
            val nextNumber = incoming.toBigIntegerOrNull()
            val currentNumber = current.toBigIntegerOrNull()
            return if (nextNumber != null && currentNumber != null) nextNumber > currentNumber else incoming != current
        }
        return when (event.name) {
            "session.upsert" -> WireCodec.json.decodeFromJsonElement(Session.serializer(), event.data).let { value ->
                if (newer(value.revision, state.sessions[value.id]?.revision)) state.copy(cursor = event.cursor, sessions = state.sessions + (value.id to value)) else state
            }
            "session.removed" -> state.copy(cursor = event.cursor, sessions = state.sessions - event.data.getValue("sessionId").toString().trim('"'))
            "message.upsert" -> WireCodec.json.decodeFromJsonElement(Message.serializer(), event.data).let { value ->
                if (newer(value.revision, state.messages[value.id]?.revision)) state.copy(cursor = event.cursor, messages = state.messages + (value.id to value)) else state
            }
            "approval.upsert" -> WireCodec.json.decodeFromJsonElement(Approval.serializer(), event.data).let { value ->
                if (newer(value.revision, state.approvals[value.id]?.revision)) state.copy(cursor = event.cursor, approvals = state.approvals + (value.id to value)) else state
            }
            "approval.resolved" -> state.copy(cursor = event.cursor, approvals = state.approvals - event.data.getValue("approvalId").toString().trim('"'))
            "activity.upsert" -> WireCodec.json.decodeFromJsonElement(ActivityItem.serializer(), event.data).let { value ->
                if (newer(value.revision, state.activity[value.id]?.revision)) state.copy(cursor = event.cursor, activity = state.activity + (value.id to value)) else state
            }
            else -> state.copy(cursor = event.cursor)
        }
    }
}
