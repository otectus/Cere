package dev.otectus.cere.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

internal enum class SecureTone { Info, Attention, Danger, Success }

/** Shared visual language for pairing, recovery, settings, and reviewed requests. */
@Composable
internal fun SecureStatusPanel(
    title: String,
    detail: String,
    modifier: Modifier = Modifier,
    tone: SecureTone = SecureTone.Info,
    icon: ImageVector? = null,
) {
    val colors = MaterialTheme.colorScheme
    val (container, content) = when (tone) {
        SecureTone.Info -> colors.primaryContainer to colors.onPrimaryContainer
        SecureTone.Attention -> colors.tertiaryContainer to colors.onTertiaryContainer
        SecureTone.Danger -> colors.errorContainer to colors.onErrorContainer
        SecureTone.Success -> colors.secondaryContainer to colors.onSecondaryContainer
    }
    val symbol = icon ?: when (tone) {
        SecureTone.Info -> Icons.Default.Info
        SecureTone.Attention -> Icons.Default.Warning
        SecureTone.Danger -> Icons.Default.Lock
        SecureTone.Success -> Icons.Default.CheckCircle
    }
    Surface(
        modifier = modifier.fillMaxWidth().semantics { if (tone == SecureTone.Danger || tone == SecureTone.Success) liveRegion = LiveRegionMode.Polite },
        shape = RoundedCornerShape(12.dp),
        color = container,
        contentColor = content,
        border = BorderStroke(1.dp, content.copy(alpha = 0.24f)),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(symbol, null, Modifier.size(22.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(detail, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
