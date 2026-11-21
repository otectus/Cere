package dev.otectus.cere.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.input.key.*
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.otectus.cere.mobile.data.SessionScrollPosition
import dev.otectus.cere.mobile.protocol.Agent
import dev.otectus.cere.mobile.protocol.Message
import dev.otectus.cere.mobile.protocol.isConversationMessage
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.delay

internal fun restoredScrollIndex(position: SessionScrollPosition?, messages: List<Message>, hasOlder: Boolean): Int {
    if (position == null || position.following) return 0
    val conversation = messages.filter(Message::isConversationMessage)
    val anchored = position.anchorMessageId?.let { id -> conversation.indexOfFirst { it.id == id }.takeIf { it >= 0 } }
    val raw = anchored?.plus(if (hasOlder) 1 else 0) ?: position.itemIndex
    return raw.coerceIn(0, conversation.size + if (hasOlder) 1 else 0)
}

@Composable
internal fun ConversationTimeline(
    messages: List<Message>, busy: Boolean, status: String,
    modifier: Modifier = Modifier, hasOlder: Boolean = false, loadingOlder: Boolean = false,
    onLoadOlder: () -> Unit = {}, statusText: String? = null,
    sessionId: String = "", restoredPosition: SessionScrollPosition? = null,
    onPositionChanged: (SessionScrollPosition) -> Unit = {},
    messageContent: @Composable (Message) -> Unit,
) {
    val conversation = remember(messages) { messages.filter(Message::isConversationMessage) }
    val tail = conversation.lastOrNull()
    val list = remember(sessionId) {
        LazyListState(restoredScrollIndex(restoredPosition, conversation, hasOlder), restoredPosition?.offset?.coerceAtLeast(0) ?: 0)
    }
    var follow by remember(sessionId) { mutableStateOf(restoredPosition?.following ?: true) }
    var seenTailId by remember(sessionId) { mutableStateOf(tail?.id) }
    var seenText by remember(sessionId) { mutableStateOf(tail?.text) }
    var tailHeight by remember { mutableIntStateOf(0) }
    // Only user scrolling changes follow mode; a new streaming row may briefly
    // make canScrollForward true before the automatic scroll catches up.
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to list.canScrollForward }.distinctUntilChanged().collect { (scrolling, more) ->
            if (scrolling) follow = !more
        }
    }
    val viewportHeight by remember(list) { derivedStateOf { list.layoutInfo.viewportSize.height } }
    LaunchedEffect(tail?.id, tail?.revision, busy, follow, viewportHeight, hasOlder, tailHeight) {
        if (follow) {
            val expectedItems = conversation.size + (if (hasOlder) 1 else 0) + (if (conversation.isEmpty()) 1 else 0) + 1
            snapshotFlow { list.layoutInfo.totalItemsCount }.first { it == expectedItems }
            list.scrollToItem(expectedItems - 1)
            seenTailId = tail?.id
            seenText = tail?.text
        }
    }
    LaunchedEffect(sessionId, list, conversation) {
        snapshotFlow {
            if (list.isScrollInProgress) null else Triple(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset, follow)
        }.distinctUntilChanged().collectLatest { position ->
            if (position == null || sessionId.isBlank()) return@collectLatest
            delay(250)
            val visibleKey = list.layoutInfo.visibleItemsInfo.firstOrNull()?.key as? String
            onPositionChanged(SessionScrollPosition(
                sessionId = sessionId,
                anchorMessageId = visibleKey?.takeIf { key -> conversation.any { it.id == key } },
                itemIndex = position.first,
                offset = position.second,
                following = position.third,
            ))
        }
    }
    // Count only rows appended after the last-seen tail. Loading older history prepends rows and
    // must not be announced as a new reply.
    val seenTailIndex = seenTailId?.let { id -> conversation.indexOfLast { it.id == id } } ?: -1
    val newMessages = if (seenTailIndex >= 0) conversation.lastIndex - seenTailIndex else 0
    Box(modifier.fillMaxWidth()) {
        LazyColumn(Modifier.fillMaxSize().testTag("conversationTimeline"), state = list,
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (hasOlder) item(key = "history") { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                OutlinedButton({ follow = false; onLoadOlder() }, enabled = !loadingOlder,
                    modifier = Modifier.widthIn(max = 720.dp).fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(stringResource(if (loadingOlder) R.string.transcript_loading_earlier else R.string.transcript_load_earlier))
                }
            } }
            if (conversation.isEmpty()) item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.transcript_empty_title), modifier = Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineSmall)
                    Text(stringResource(R.string.transcript_empty_body), color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge)
                }
            }
            items(conversation, key = { it.id }, contentType = { "conversationMessage" }) { message ->
                val measureTail = if (message.id == tail?.id) Modifier.onSizeChanged { tailHeight = it.height } else Modifier
                Box(measureTail) { messageContent(message) }
            }
            item(key = "status") {
                // "Your input" only when a request is on screen (the caller passes it as statusText).
                val displayedStatus = statusText ?: when (status) {
                    "waiting" -> stringResource(R.string.transcript_waiting)
                    "starting" -> stringResource(R.string.transcript_starting)
                    "stopping" -> stringResource(R.string.transcript_stopping)
                    else -> stringResource(R.string.transcript_working)
                }
                if (busy) Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).semantics {
                    liveRegion = LiveRegionMode.Polite
                }, verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (status == "waiting") Icon(Icons.Default.Info, null, Modifier.size(18.dp))
                    else CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(displayedStatus, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                }
                else Spacer(Modifier.height(1.dp))
            }
        }
        if (!follow) FilledTonalButton(onClick = { follow = true }, modifier = Modifier.align(Alignment.BottomCenter).padding(12.dp).testTag("latestMessages"),
            elevation = ButtonDefaults.filledTonalButtonElevation(defaultElevation = 4.dp)) {
            Text((when {
                newMessages > 0 -> pluralStringResource(R.plurals.transcript_new_messages, newMessages, newMessages)
                tail != null && tail.id == seenTailId && tail.text != seenText -> stringResource(R.string.transcript_updated)
                else -> stringResource(R.string.transcript_latest)
            }) + " ↓")
        }
    }
}

/** A keyboard-aware message composer with stable 48dp actions and room for attachment affordances. */
@Composable
internal fun ConversationComposer(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    canSend: Boolean,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
    leadingContent: (@Composable () -> Unit)? = null,
    sendFromKeyboard: Boolean = false,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainer,
        tonalElevation = 2.dp,
        shadowElevation = 3.dp,
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            minLines = 1,
            maxLines = 6,
            shape = RoundedCornerShape(24.dp),
            leadingIcon = leadingContent,
            trailingIcon = {
                FilledIconButton(onClick = onSend, enabled = canSend, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.transcript_send))
                }
            },
            keyboardOptions = KeyboardOptions(imeAction = if (sendFromKeyboard) ImeAction.Send else ImeAction.Default),
            keyboardActions = KeyboardActions(onSend = { if (canSend) onSend() }),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).onPreviewKeyEvent { event ->
                if (event.isCtrlPressed && event.key == Key.Enter) {
                    if (event.type == KeyEventType.KeyDown && event.nativeKeyEvent.repeatCount == 0 && canSend) onSend()
                    true
                } else false
            }.testTag("messageComposer"),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ActivityPanel(
    items: List<Message>, loading: Boolean, error: String?, onRefresh: () -> Unit,
    onDismiss: () -> Unit, agents: List<Agent> = emptyList(),
    canOpenAgent: (Agent) -> Boolean = { false }, onOpenAgent: (Agent) -> Unit = {},
    hasOlder: Boolean = false, loadingOlder: Boolean = false, onLoadOlder: () -> Unit = {},
    itemContent: @Composable (Message) -> Unit,
) {
    val activity = items.filterNot(Message::isConversationMessage).sortedByDescending(Message::time)
    ModalBottomSheet(onDismiss, modifier = Modifier.testTag("activityPanel"), sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Activity", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineSmall)
            }
            TextButton(onRefresh, enabled = !loading, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(4.dp)); Text("Refresh")
            }
            TextButton(onDismiss, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Default.Close, null); Spacer(Modifier.width(4.dp)); Text("Close")
            }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 20.dp)) }
        if (activity.isEmpty() && agents.isEmpty() && !loading && error == null) Text("No activity for this session.", modifier = Modifier.padding(20.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 640.dp), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)) {
            if (agents.isNotEmpty()) {
                item { Text("Subagents · ${agents.size}", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(vertical = 8.dp)) }
                items(agents, key = { "agent-${it.id}" }) { agent -> AgentActivityRow(agent, canOpenAgent(agent), onOpenAgent) }
                if (activity.isNotEmpty()) item { HorizontalDivider(Modifier.padding(vertical = 8.dp)); Text("Tool activity", style = MaterialTheme.typography.titleSmall) }
            }
            items(activity, key = { it.id }) { itemContent(it) }
            // Older records stay on the desktop until asked for; the list says so instead of ending.
            if (hasOlder) item(key = "olderActivity") { OutlinedButton(onLoadOlder, enabled = !loadingOlder, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("olderActivity")) { Text(if (loadingOlder) "Loading older activity…" else "Load older activity") } }
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
                Modifier.fillMaxWidth().clickable { expanded = !expanded }.heightIn(min = CereLayout.target),
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

/**
 * The sources a reply drew on, from its metadata, so each is reachable even when the text names none.
 * Only http(s) addresses open, on tap; anything else is listed without a link.
 */
@Composable
internal fun MessageSources(sources: List<kotlinx.serialization.json.JsonObject>, onOpen: (String) -> Unit) {
    val entries = sources.mapNotNull { source ->
        val url = (source["url"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf(String::isNotBlank) ?: return@mapNotNull null
        ((source["title"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf(String::isNotBlank) ?: url) to url
    }.distinctBy { it.second }
    if (entries.isEmpty()) return
    Column(Modifier.padding(top = 8.dp).testTag("messageSources")) {
        Text(stringResource(R.string.transcript_sources), modifier = Modifier.semantics { heading() },
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        entries.forEach { (title, url) ->
            val safe = safeLink(url)
            val openDescription = stringResource(R.string.transcript_open_source, title)
            if (safe != null) TextButton({ onOpen(safe) }, contentPadding = PaddingValues(horizontal = 0.dp, vertical = 2.dp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = openDescription }) {
                Text("$title · ${java.net.URI(safe).host}", modifier = Modifier.fillMaxWidth(), maxLines = 2,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
            } else Text(stringResource(R.string.transcript_unavailable_source, title), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
