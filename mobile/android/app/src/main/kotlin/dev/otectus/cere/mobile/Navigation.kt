package dev.otectus.cere.mobile

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.otectus.cere.mobile.data.ConnectionState

internal enum class Destination(val label: Int) {
    Sessions(R.string.nav_chats), Inbox(R.string.nav_inbox), Desktop(R.string.nav_desktop), Settings(R.string.nav_settings)
}

@Composable
private fun needsLargeTypePhoneLayout(): Boolean = with(LocalDensity.current) {
    fontScale >= 1.6f && LocalWindowInfo.current.containerSize.width < 500.dp.roundToPx()
}

@Composable
private fun DestinationIcon(item: Destination, count: Int, description: String?) {
    when (item) {
        Destination.Sessions -> Icon(painterResource(R.drawable.ic_chat), description)
        Destination.Desktop -> Icon(painterResource(R.drawable.ic_desktop), description)
        Destination.Settings -> Icon(Icons.Default.Settings, description)
        Destination.Inbox -> BadgedBox(badge = {
            if (count > 0) Badge(containerColor = MaterialTheme.colorScheme.tertiaryContainer, contentColor = MaterialTheme.colorScheme.onTertiaryContainer) {
                Text(if (count > 99) "99+" else count.toString(), Modifier.clearAndSetSemantics {})
            }
        }) { Icon(Icons.Default.Notifications, description) }
    }
}

@Composable
internal fun CereNavigation(destination: Destination, count: Int, rail: Boolean, select: (Destination) -> Unit, compactRail: Boolean = false) {
    val inboxStatus = if (count > 0) pluralStringResource(R.plurals.waiting_requests, count, count) else ""
    // At large type a phone-width row cannot fit four translated destination names.
    // One labelled selector keeps the full names and request count within thumb reach.
    if (!rail && needsLargeTypePhoneLayout()) {
        var expanded by remember { mutableStateOf(false) }
        val switchLabel = stringResource(R.string.switch_section)
        Box(Modifier.fillMaxWidth()) {
            Surface({ expanded = true }, color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth().semantics { onClick(switchLabel, action = null) }) {
                Row(Modifier.heightIn(min = 56.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    DestinationIcon(destination, count, null)
                    Text(stringResource(destination.label), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    Icon(Icons.Default.ArrowDropDown, null)
                }
            }
            DropdownMenu(expanded, { expanded = false }) {
                Destination.entries.forEach { item ->
                    DropdownMenuItem(text = { Text(stringResource(item.label)) }, onClick = { expanded = false; select(item) },
                        leadingIcon = { DestinationIcon(item, count, null) },
                        trailingIcon = if (destination == item) { { Icon(Icons.Default.Check, null) } } else null,
                        modifier = Modifier.semantics {
                            selected = destination == item
                            if (item == Destination.Inbox && count > 0) stateDescription = inboxStatus
                        })
                }
            }
        }
        return
    }
    val showLabels = !rail || !compactRail
    if (rail) NavigationRail(windowInsets = WindowInsets(0), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Destination.entries.forEach { item ->
                val name = stringResource(item.label)
                val modifier = if (item == Destination.Inbox && count > 0) Modifier.semantics { stateDescription = inboxStatus } else Modifier
                NavigationRailItem(selected = destination == item, onClick = { select(item) }, modifier = modifier,
                    icon = { DestinationIcon(item, count, name.takeUnless { showLabels }) },
                    label = if (showLabels) { { Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis) } } else null)
            }
        }
    }
    else Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        // NavigationBarItem uses RowScope to share the available width.
        Destination.entries.forEach { item ->
            val name = stringResource(item.label)
            NavigationBarItem(selected = destination == item, onClick = { select(item) },
                icon = { DestinationIcon(item, count, name.takeUnless { showLabels }) },
                label = if (showLabels) { { Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis) } } else null,
                modifier = if (item == Destination.Inbox && count > 0) Modifier.semantics { stateDescription = inboxStatus } else Modifier)
        }
    }
}

@Composable
internal fun CompanionHeader(detail: String, connection: ConnectionState, connectionText: String,
    onConnection: () -> Unit, onRetry: () -> Unit) {
    val online = connection is ConnectionState.Online
    val retry = connection is ConnectionState.Offline
    val label = stringResource(if (retry) R.string.retry_connection else R.string.connection_details)
    if (needsLargeTypePhoneLayout()) {
        Surface(if (retry) onRetry else onConnection, color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().semantics { onClick(label, action = null) }) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Image(painterResource(R.drawable.cere_face_icon), null, Modifier.size(40.dp))
                Column(Modifier.weight(1f)) {
                    Text("Cere", style = MaterialTheme.typography.titleMedium)
                    Text(connectionText, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(if (retry) Icons.Default.Refresh else Icons.Default.Info, null)
            }
        }
        return
    }
    Surface(color = MaterialTheme.colorScheme.surface) {
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(start = 16.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Image(painterResource(R.drawable.cere_face_icon), null, Modifier.size(40.dp))
            Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                Text("Cere", style = MaterialTheme.typography.titleLarge)
                Text(detail, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Surface(onClick = if (retry) onRetry else onConnection, shape = MaterialTheme.shapes.medium,
                color = if (online) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.tertiaryContainer,
                modifier = Modifier.widthIn(max = 176.dp).semantics { liveRegion = LiveRegionMode.Polite; onClick(label, action = null) }) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    if (connection == ConnectionState.Connecting || connection == ConnectionState.Authenticating)
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    else Icon(if (online) Icons.Default.Check else Icons.Default.Refresh, null, Modifier.size(16.dp))
                    Text(connectionText, style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
