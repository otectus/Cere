package dev.otectus.cere.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import android.text.format.DateUtils
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.otectus.cere.mobile.data.ConnectionState
import dev.otectus.cere.mobile.data.MobileState
import dev.otectus.cere.mobile.data.OfflineKind
import dev.otectus.cere.mobile.protocol.Session

@Composable
internal fun connectionTitle(state: MobileState): String = stringResource(when (val connection = state.connection) {
    is ConnectionState.Online -> R.string.connection_online
    is ConnectionState.Offline -> if (connection.kind == OfflineKind.Unreachable) R.string.connection_offline else R.string.connection_disconnected
    ConnectionState.Connecting -> if (state.cursor != null) R.string.connection_reconnecting else R.string.connection_connecting
    ConnectionState.Authenticating -> R.string.connection_signing_in
    is ConnectionState.Blocked -> R.string.connection_action_needed
    ConnectionState.Unpaired -> R.string.connection_unpaired
})

@Composable
internal fun PageTitle(text: String, modifier: Modifier = Modifier) {
    val type = MaterialTheme.typography
    Text(text, modifier.semantics { heading() }, style = if (LocalDensity.current.fontScale >= 1.6f) type.headlineSmall else type.headlineLarge)
}

@Composable
internal fun LibraryConversation(session: Session, status: String, open: () -> Unit, handoff: (() -> Unit)?) {
    val colors = MaterialTheme.colorScheme
    Surface(onClick = open, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
        color = colors.surface, border = BorderStroke(1.dp, colors.outlineVariant)) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                val provider = session.provider.replaceFirstChar(Char::uppercase)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val project = session.folderName?.takeIf(String::isNotBlank) ?: session.project?.substringAfterLast('/')?.takeIf(String::isNotBlank)
                    Text(listOfNotNull(provider, project).joinToString(" · "), style = MaterialTheme.typography.labelMedium,
                        color = colors.onSurfaceVariant, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (session.updated > 0) Text(
                        DateUtils.formatDateTime(LocalContext.current, session.updated, if (DateUtils.isToday(session.updated))
                            DateUtils.FORMAT_SHOW_TIME else DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH),
                        style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                }
                Text(session.title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                val indicators = listOfNotNull(
                    stringResource(R.string.session_pinned).takeIf { session.pinned },
                    stringResource(R.string.session_unread).takeIf { session.unread },
                    status.takeIf { session.status != "idle" || status != "Idle" },
                )
                if (indicators.isNotEmpty()) Text(indicators.joinToString("  ·  "), style = MaterialTheme.typography.labelMedium,
                    color = if (session.status == "waiting") colors.tertiary else colors.primary)
                session.model?.takeIf(String::isNotBlank)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (handoff != null) IconButton(handoff) {
                Icon(Icons.Default.Share, stringResource(R.string.hand_off_session, session.title), Modifier.size(20.dp), tint = colors.onSurfaceVariant)
            }
        }
    }
}

internal enum class SettingsGroup(val title: Int, val hint: Int?, val icon: ImageVector) {
    Connection(R.string.connection_settings, null, Icons.Default.Refresh),
    Phone(R.string.appearance_alerts, R.string.appearance_hint, Icons.Default.Notifications),
    Assistant(R.string.assistant_memory, R.string.assistant_hint, Icons.Default.Star),
    Access(R.string.desktop_access, R.string.access_hint, Icons.Default.Lock),
    Pairing(R.string.pairing_maintenance, R.string.maintenance_hint, Icons.Default.Settings),
}

@Composable
internal fun SettingsIndex(state: MobileState, select: (SettingsGroup) -> Unit) {
    LazyColumn(contentPadding = PaddingValues(CereLayout.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { PageTitle(stringResource(R.string.nav_settings), Modifier.padding(bottom = 8.dp)) }
        for (group in SettingsGroup.entries) {
            if (group == SettingsGroup.Assistant && listOf("settings.get", "memory.list", "memory.retrieve").none(state::supports)) continue
            item(key = group.name) {
                val connected = group == SettingsGroup.Connection
                val colors = MaterialTheme.colorScheme
                Surface({ select(group) }, shape = MaterialTheme.shapes.medium,
                    color = if (connected) colors.primaryContainer else colors.surface,
                    border = if (connected) null else BorderStroke(1.dp, colors.outlineVariant)) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        if (connected) Icon(painterResource(R.drawable.ic_desktop), null)
                        else Icon(group.icon, null, tint = colors.onSurfaceVariant)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(stringResource(group.title), style = MaterialTheme.typography.titleMedium)
                            Text(group.hint?.let { stringResource(it) } ?: listOfNotNull(connectionTitle(state), state.desktop?.desktopName).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = if (connected) colors.onPrimaryContainer else colors.onSurfaceVariant)
                        }
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}
