package dev.otectus.cere.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.otectus.cere.mobile.protocol.Agent
import dev.otectus.cere.mobile.protocol.Message
import dev.otectus.cere.mobile.protocol.isConversationMessage
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@Composable
internal fun ConversationTimeline(
    messages: List<Message>, busy: Boolean, status: String,
    modifier: Modifier = Modifier, hasOlder: Boolean = false, loadingOlder: Boolean = false,
    onLoadOlder: () -> Unit = {}, statusText: String? = null, messageContent: @Composable (Message) -> Unit,
) {
    val conversation = messages.filter(Message::isConversationMessage)
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var follow by remember { mutableStateOf(true) }
    // Only user scrolling changes follow mode; a new streaming row may briefly
    // make canScrollForward true before the automatic scroll catches up.
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to list.canScrollForward }.distinctUntilChanged().collect { (scrolling, more) ->
            if (scrolling) follow = !more
        }
    }
    LaunchedEffect(conversation.lastOrNull()?.id, conversation.lastOrNull()?.revision, busy, follow) {
        if (follow) {
            val expectedItems = conversation.size + (if (hasOlder) 1 else 0) + (if (conversation.isEmpty()) 1 else 0) + 1
            snapshotFlow { list.layoutInfo.totalItemsCount }.first { it == expectedItems }
            list.scrollToItem(expectedItems - 1)
        }
    }
    Box(modifier.fillMaxWidth()) {
        LazyColumn(Modifier.fillMaxSize().testTag("conversationTimeline"), state = list,
            contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (hasOlder) item(key = "history") { OutlinedButton(onLoadOlder, enabled = !loadingOlder,
                modifier = Modifier.fillMaxWidth()) { Text(if (loadingOlder) "Loading earlier messages…" else "Load earlier messages") } }
            if (conversation.isEmpty()) item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Start a conversation", style = MaterialTheme.typography.titleLarge)
                    Text("Send a message to your desktop assistant.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(conversation, key = { it.id }) { messageContent(it) }
            item(key = "status") {
                if (busy) Text(statusText ?: when (status) {
                    "waiting" -> "Waiting for your input…"
                    "starting" -> "Starting the provider…"
                    "stopping" -> "Stopping…"
                    else -> "Working on it…"
                }, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall)
                else Spacer(Modifier.height(1.dp))
            }
        }
        if (!follow) FilledTonalButton(onClick = { follow = true; scope.launch {
            if (list.layoutInfo.totalItemsCount > 0) list.animateScrollToItem(list.layoutInfo.totalItemsCount - 1)
        } }, modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp).testTag("latestMessages")) { Text("Latest messages ↓") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ActivityPanel(
    items: List<Message>, loading: Boolean, error: String?, onRefresh: () -> Unit,
    onDismiss: () -> Unit, agents: List<Agent> = emptyList(),
    canOpenAgent: (Agent) -> Boolean = { false }, onOpenAgent: (Agent) -> Unit = {},
    itemContent: @Composable (Message) -> Unit,
) {
    val activity = items.filterNot(Message::isConversationMessage).sortedByDescending(Message::time)
    ModalBottomSheet(onDismiss, modifier = Modifier.testTag("activityPanel"), sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Activity", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onRefresh, enabled = !loading) { Text("Refresh") }
            TextButton(onDismiss) { Text("Close") }
        }
        Text("Subagents, tool calls and provider progress · latest first", color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 20.dp)) }
        if (activity.isEmpty() && agents.isEmpty() && !loading) Text("No activity for this session.", modifier = Modifier.padding(20.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp)) {
            if (agents.isNotEmpty()) {
                item { Text("Subagents · ${agents.size}", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(vertical = 8.dp)) }
                items(agents, key = { "agent-${it.id}" }) { agent -> AgentActivityRow(agent, canOpenAgent(agent), onOpenAgent) }
                if (activity.isNotEmpty()) item { HorizontalDivider(Modifier.padding(vertical = 8.dp)); Text("Tool activity", style = MaterialTheme.typography.titleSmall) }
            }
            items(activity, key = { it.id }) { itemContent(it) }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun AgentActivityRow(agent: Agent, canOpen: Boolean, onOpen: (Agent) -> Unit) {
    var expanded by rememberSaveable(agent.id) { mutableStateOf(false) }
    Surface(
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(agent.name.ifBlank { agent.id }, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text(agentStatusLabel(agent.status), color = when {
                    agent.status == "failed" -> MaterialTheme.colorScheme.error
                    agent.isActive() -> MaterialTheme.colorScheme.primary
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }, style = MaterialTheme.typography.labelMedium)
                Text(if (expanded) "▴" else "▾")
            }
            if (expanded) {
                agent.task?.takeIf(String::isNotBlank)?.let { Text(it) }
                agent.detail?.takeIf(String::isNotBlank)?.let {
                    Text(it, color = if (agent.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                agent.parentId?.let { Text("Parent · ${it.take(8)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (canOpen) TextButton({ onOpen(agent) }, modifier = Modifier.align(Alignment.End)) { Text("Open conversation") }
            }
        }
    }
}
