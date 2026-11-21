package dev.otectus.cere.mobile.data

import java.io.IOException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import dev.otectus.cere.mobile.protocol.WireCodec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** What the desktop answers on a network-return pairing socket. */
sealed interface PairingReply {
    /** The desktop has the answer and shows its six words; the owner confirms there. */
    data object Received : PairingReply
    data object Confirmed : PairingReply
    /** The offer ended without this phone being paired; [message] is written for people. */
    data class Closed(val reason: String, val message: String) : PairingReply
}

/** Sending a staged pairing's answer to the desktop, as the pairing screen shows it. */
sealed interface PairingReturnState {
    data object Idle : PairingReturnState
    data object Sending : PairingReturnState
    /** The desktop received the answer; it is waiting for the owner to compare the words and confirm. */
    data object Waiting : PairingReturnState
    data class Retrying(val reason: String) : PairingReturnState
    /** The desktop confirmed: the pairing can be saved and used. */
    data object Confirmed : PairingReturnState
    /** The offer ended on the desktop; nothing is retried. */
    data class Ended(val message: String) : PairingReturnState
    /** The answer could not be delivered; the manual route (copy, share) is the way on. */
    data class Unreachable(val reason: String) : PairingReturnState
}

/** The desktop refused the frame without saying why: an older desktop that takes answers only by hand. */
class PairingReturnUnsupported : IOException("This desktop takes the pairing answer only by hand. Copy or share it to the PC.")

internal object PairingReturnFrames {
    fun request(responseUri: String): String = buildJsonObject { put("v", 1); put("type", "pair.response"); put("response", responseUri) }.toString()

    fun parse(text: String): PairingReply? {
        val value = runCatching { WireCodec.json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
        if (value["v"]?.jsonPrimitive?.contentOrNull != "1") return null
        return when (value["type"]?.jsonPrimitive?.contentOrNull) {
            "pair.received" -> PairingReply.Received
            "pair.confirmed" -> PairingReply.Confirmed
            "pair.closed" -> { val reason = value["reason"]?.jsonPrimitive?.contentOrNull ?: "refused"; PairingReply.Closed(reason, closedText(reason, value["message"]?.jsonPrimitive?.contentOrNull)) }
            else -> null
        }
    }

    fun closedText(reason: String, message: String?): String = when (reason) {
        "expired" -> "The pairing QR expired before the PC confirmed it. Show a new QR on the PC and scan it again."
        "cancelled" -> "The PC cancelled this pairing offer. Show a new QR on the PC to pair."
        "replaced" -> "The PC is showing a newer pairing QR. Scan that one."
        "contested" -> "Another phone answered this pairing QR, so the PC cancelled it. Show a new QR and scan it with only this phone."
        else -> message?.take(300) ?: "The PC did not accept this answer. Show a new pairing QR and scan it again."
    }
}

/**
 * One delivery of a staged pairing's answer: connects to each of the offer's addresses in turn,
 * pinned to the certificate the QR carried, sends the signed answer and reports the desktop's
 * replies until it confirms or ends the offer. A dropped connection is thrown for the caller to retry.
 */
internal class PairingReturnClient(private val client: OkHttpClient) {
    private data class SocketClosed(val code: Int)
    private object Opened

    /** [untilReceived]: return as soon as the desktop has the answer (a status check), instead of waiting for its decision. */
    suspend fun deliver(endpoints: List<String>, responseUri: String, timeoutMs: Long, untilReceived: Boolean = false, onReceived: () -> Unit = {}): PairingReply {
        var last: Throwable = IOException("The pairing offer has no desktop address")
        for (endpoint in endpoints) {
            try { return attempt(endpoint, responseUri, timeoutMs, untilReceived, onReceived) }
            catch (unsupported: PairingReturnUnsupported) { throw unsupported }
            catch (error: IOException) { last = error }
        }
        throw last
    }

    private suspend fun attempt(endpoint: String, responseUri: String, timeoutMs: Long, untilReceived: Boolean, onReceived: () -> Unit): PairingReply {
        val events = Channel<Any>(Channel.UNLIMITED)
        val socket = client.newWebSocket(Request.Builder().url(endpoint).header("Sec-WebSocket-Protocol", "cere.mobile.v1").build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send(PairingReturnFrames.request(responseUri)); events.trySend(Opened) }
            override fun onMessage(webSocket: WebSocket, text: String) { PairingReturnFrames.parse(text)?.let { events.trySend(it) } }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null); events.trySend(SocketClosed(code)) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { events.trySend(SocketClosed(code)) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { events.trySend(t) }
        })
        try {
            return withTimeout(timeoutMs) {
                var received = false
                var decision: PairingReply? = null
                while (decision == null) {
                    when (val event = events.receive()) {
                        Opened -> Unit
                        PairingReply.Received -> { received = true; onReceived(); if (untilReceived) decision = PairingReply.Received }
                        PairingReply.Confirmed, is PairingReply.Closed -> decision = event as PairingReply
                        // 4001 before any reply: the desktop does not take answers over the network.
                        is SocketClosed -> throw if (event.code == 4001 && !received) PairingReturnUnsupported() else IOException("The PC closed the connection before deciding")
                        is IOException -> throw event
                        is Throwable -> throw IOException(event.message ?: "The PC could not be reached", event)
                    }
                }
                decision
            }
        } finally { socket.cancel() }
    }
}
