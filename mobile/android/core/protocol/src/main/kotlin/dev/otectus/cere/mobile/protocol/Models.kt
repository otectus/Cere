package dev.otectus.cere.mobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

const val PROTOCOL_VERSION = 1
const val PROTOCOL_MIN = 0
const val PROTOCOL_MAX = 0

@Serializable
data class Hello(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "hello",
    val protocolMin: Int = PROTOCOL_MIN,
    val protocolMax: Int = PROTOCOL_MAX,
    val desktopId: String,
    val deviceId: String,
    val keyVersion: Int = 1,
    val clientNonce: String,
    val appVersion: String,
)

@Serializable
data class AuthChallenge(
    val v: Int,
    val type: String,
    val challengeId: String,
    val serverNonce: String,
    val epoch: String,
    val audience: String,
    val expiresAt: Long,
)

@Serializable
data class Auth(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "auth",
    val challengeId: String,
    val signature: String,
)

@Serializable data class ProtocolVersion(val major: Int, val minor: Int)
@Serializable data class Limits(val maxFrameBytes: Int = 1_048_576)

@Serializable
data class Welcome(
    val v: Int,
    val type: String,
    val authSessionId: String,
    val expiresAt: Long,
    val epoch: String,
    val desktopId: String,
    val scopeVersion: String,
    val protocol: ProtocolVersion,
    val operations: Set<String>,
    val limits: Limits = Limits(),
    val brokerBuild: String? = null,
    val sendAuthentication: String = "action-key",
)

@Serializable
data class Proof(val challengeId: String, val signature: String)

@Serializable
data class Request(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "request",
    val id: String,
    val method: String,
    val params: JsonObject,
    val commandId: String? = null,
    val proof: Proof? = null,
)

@Serializable
data class ProtocolError(
    val code: String,
    val message: String,
    val retryable: Boolean = false,
    val details: JsonObject? = null,
)

@Serializable
data class Response(
    val v: Int,
    val type: String,
    val id: String,
    val result: JsonElement? = null,
    val error: ProtocolError? = null,
)

@Serializable
data class Event(
    val v: Int,
    val type: String,
    val cursor: String,
    val eventId: String,
    val name: String,
    val resourceRevision: String,
    val data: JsonObject,
)

@Serializable
data class Session(
    val id: String,
    val provider: String,
    val title: String,
    val projectId: String? = null,
    val project: String? = null,
    val status: String,
    val model: String? = null,
    val effort: String? = null,
    val draft: String = "",
    val draftIncluded: Boolean = true,
    val draftRevision: String = "0",
    val configRevision: String = "0",
    val revision: String = "0",
    val mode: String? = null,
    val remoteRestricted: Boolean = true,
    val turnId: String? = null,
    val canSend: Boolean = false,
    val updated: Long = 0,
    val activity: String? = null,
    val parentId: String? = null,
    val tools: Boolean = false,
    val error: String? = null,
    val ollamaHost: String = "",
    val agents: List<Agent> = emptyList(),
)

@Serializable
data class Agent(
    val id: String,
    val name: String,
    val task: String? = null,
    val status: String,
    val detail: String? = null,
    val parentId: String? = null,
    val updated: Long = 0,
)

@Serializable
data class TextParts(
    val count: Int,
    val partChars: Int,
    val encoding: String,
)

@Serializable
data class Message(
    val id: String,
    val sessionId: String,
    val turnId: String? = null,
    val role: String,
    val kind: String = "text",
    val text: String,
    val revision: String,
    val time: Long = 0,
    val sources: List<JsonObject> = emptyList(),
    val contentTruncated: Boolean = false,
    val contentBytes: Long? = null,
    val contentChars: Long? = null,
    val textParts: TextParts? = null,
)

@Serializable data class ApprovalOption(val label: String, val description: String? = null)
@Serializable
data class ApprovalQuestion(
    val id: String,
    val question: String,
    val header: String? = null,
    val options: List<ApprovalOption> = emptyList(),
    val multiSelect: Boolean = false,
    val isSecret: Boolean = false,
    val allowOther: Boolean = true,
    val required: Boolean = true,
)
@Serializable
data class Approval(
    val id: String,
    val sessionId: String,
    val kind: String,
    val title: String,
    val detail: String? = null,
    val url: String? = null,
    val choices: List<String>,
    val questions: List<ApprovalQuestion> = emptyList(),
    val fields: JsonObject = JsonObject(emptyMap()),
    val time: Long = 0,
    val revision: String,
    val digest: String,
    val turnId: String? = null,
    val canAnswer: Boolean,
)

@Serializable data class Project(val id: String, val name: String, val path: String? = null)
@Serializable data class Provider(val id: String, val name: String, val available: Boolean = true, val models: List<String> = emptyList(), val efforts: List<String> = emptyList())
@Serializable data class ActivityItem(val id: String, val sessionId: String, val title: String, val detail: String? = null, val status: String, val revision: String)
@Serializable data class EffortOption(val id: String, val displayName: String, val description: String = "")
@Serializable data class ModelOption(
    val id: String,
    val displayName: String = id,
    val description: String = "",
    val efforts: List<EffortOption> = emptyList(),
    val defaultEffort: String = "",
    val isDefault: Boolean = false,
    val capabilities: List<String> = emptyList(),
    val cloud: Boolean = false,
    val contextLength: Int? = null,
)

@Serializable
data class SyncSnapshot(
    val cursor: String,
    val sessions: List<Session> = emptyList(),
    val approvals: List<Approval> = emptyList(),
    val projects: List<Project> = emptyList(),
    val providers: JsonObject = JsonObject(emptyMap()),
    val permissions: JsonObject = JsonObject(emptyMap()),
    val settings: JsonObject = JsonObject(emptyMap()),
    val messages: List<Message> = emptyList(),
    val sessionIds: List<String>? = null,
    val nextSessionOffset: Int? = null,
    val cacheEpoch: String? = null,
    val messagesBefore: String? = null,
)

sealed interface Frame {
    data class Challenge(val value: AuthChallenge) : Frame
    data class Accepted(val value: Welcome) : Frame
    data class Reply(val value: Response) : Frame
    data class Push(val value: Event) : Frame
}
