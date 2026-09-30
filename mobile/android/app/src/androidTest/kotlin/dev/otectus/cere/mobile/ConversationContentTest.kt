package dev.otectus.cere.mobile

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.height
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import dev.otectus.cere.mobile.protocol.Message
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Rule
import org.junit.Test

class ConversationContentTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun timelineExcludesActivityMessagesFromChat() {
        val messages = listOf(
            message("user", role = "user", kind = "text", text = "Visible user prompt"),
            message("thinking", role = "assistant", kind = "thinking", text = "Private reasoning activity"),
            message("tool", role = "assistant", kind = "tool", text = "Tool execution activity"),
            message("assistant", role = "assistant", kind = "text", text = "Visible assistant reply"),
        )

        compose.setContent {
            MaterialTheme {
                ConversationTimeline(
                    messages = messages,
                    busy = false,
                    status = "idle",
                    messageContent = { Text(it.text) },
                )
            }
        }

        compose.onNodeWithTag("conversationTimeline").assertIsDisplayed()
        compose.onNodeWithText("Visible user prompt").assertIsDisplayed()
        compose.onNodeWithText("Visible assistant reply").assertIsDisplayed()
        compose.onNodeWithText("Private reasoning activity").assertDoesNotExist()
        compose.onNodeWithText("Tool execution activity").assertDoesNotExist()
    }

    @Test
    fun activityUpdatesDoNotReplaceExistingConversation() {
        val messages = mutableStateOf(listOf(
            message("user", role = "user", kind = "text", text = "Keep this prompt"),
            message("assistant", role = "assistant", kind = "message", text = "Keep this answer"),
        ))

        compose.setContent {
            MaterialTheme {
                ConversationTimeline(
                    messages = messages.value,
                    busy = true,
                    status = "working",
                    messageContent = { Text(it.text) },
                )
            }
        }

        compose.onNodeWithText("Keep this prompt").assertIsDisplayed()
        compose.onNodeWithText("Keep this answer").assertIsDisplayed()
        compose.runOnIdle {
            messages.value += message(
                "late-tool",
                role = "assistant",
                kind = "tool",
                text = "Late activity update",
            )
        }
        compose.onNodeWithText("Keep this prompt").assertIsDisplayed()
        compose.onNodeWithText("Keep this answer").assertIsDisplayed()
        compose.onNodeWithText("Late activity update").assertDoesNotExist()
        compose.onNodeWithText("Working on it…").assertIsDisplayed()
    }

    @Test
    fun timelineFollowsNewConversationMessageWhileAtBottom() {
        val messages = mutableStateOf((1..20).map { index ->
            message("message-$index", role = "assistant", kind = "text", text = "Conversation line $index")
        })

        compose.setContent {
            MaterialTheme {
                ConversationTimeline(
                    messages = messages.value,
                    busy = false,
                    status = "idle",
                    modifier = Modifier.height(240.dp),
                    messageContent = { Text(it.text) },
                )
            }
        }

        compose.onNodeWithText("Conversation line 20").assertIsDisplayed()
        compose.runOnIdle {
            messages.value += message(
                "message-21",
                role = "assistant",
                kind = "text",
                text = "New streaming response",
            )
        }
        compose.onNodeWithText("New streaming response").assertIsDisplayed()
    }

    @Test
    fun newReplyDoesNotInterruptReadingOlderMessagesAndLatestReturnsToBottom() {
        val messages = mutableStateOf((1..20).map { index ->
            message("history-$index", role = "assistant", kind = "text", text = "History line $index")
        })

        compose.setContent {
            MaterialTheme {
                ConversationTimeline(
                    messages = messages.value,
                    busy = false,
                    status = "idle",
                    modifier = Modifier.height(240.dp),
                    messageContent = { Text(it.text) },
                )
            }
        }

        compose.onNodeWithText("History line 20").assertIsDisplayed()
        compose.onNodeWithTag("conversationTimeline").performTouchInput {
            repeat(3) { swipeDown() }
        }
        compose.onNodeWithTag("latestMessages").assertIsDisplayed()
        compose.runOnIdle {
            messages.value += message(
                "history-21",
                role = "assistant",
                kind = "text",
                text = "Reply while reading older",
            )
        }
        compose.onNodeWithText("Reply while reading older").assertDoesNotExist()
        compose.onNodeWithTag("latestMessages").assertIsDisplayed().performClick()
        compose.onNodeWithText("Reply while reading older").assertIsDisplayed()
    }

    @Test
    fun activityMessagesRenderInDedicatedPanel() {
        val activity = listOf(
            message("user", role = "user", kind = "text", text = "Visible user prompt"),
            message("thinking", role = "assistant", kind = "thinking", text = "Private reasoning activity", time = 1),
            message("tool", role = "assistant", kind = "tool", text = "Tool execution activity", time = 2),
        )
        val refreshes = AtomicInteger()
        val dismissals = AtomicInteger()

        compose.setContent {
            MaterialTheme {
                ActivityPanel(
                    items = activity,
                    loading = false,
                    error = null,
                    onRefresh = { refreshes.incrementAndGet() },
                    onDismiss = { dismissals.incrementAndGet() },
                    itemContent = { Text(it.text) },
                )
            }
        }

        compose.onNodeWithTag("activityPanel").assertIsDisplayed()
        compose.onNodeWithText("Private reasoning activity").assertIsDisplayed()
        compose.onNodeWithText("Tool execution activity").assertIsDisplayed()
        compose.onNodeWithText("Visible user prompt").assertDoesNotExist()
        val latest = compose.onNodeWithText("Tool execution activity").fetchSemanticsNode().boundsInRoot.top
        val older = compose.onNodeWithText("Private reasoning activity").fetchSemanticsNode().boundsInRoot.top
        check(latest < older) { "Activity was not ordered latest first" }
        compose.onNodeWithText("Refresh").performClick()
        compose.onNodeWithText("Close").performClick()
        compose.runOnIdle {
            check(refreshes.get() == 1)
            check(dismissals.get() == 1)
        }
    }

    private fun message(id: String, role: String, kind: String, text: String, time: Long = 0) = Message(
        id = id,
        sessionId = "session-under-test",
        role = role,
        kind = kind,
        text = text,
        revision = "1",
        time = time,
    )
}
