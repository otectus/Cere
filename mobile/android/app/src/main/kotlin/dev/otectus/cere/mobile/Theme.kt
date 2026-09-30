package dev.otectus.cere.mobile

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

private val CereColors = darkColorScheme(
    primary = Color(0xFF5DD8FF), onPrimary = Color(0xFF0F1721), primaryContainer = Color(0xFF203E50), onPrimaryContainer = Color(0xFFECF4FA),
    secondary = Color(0xFF5DD8FF), onSecondary = Color(0xFF0F1721), secondaryContainer = Color(0xFF203E50), onSecondaryContainer = Color(0xFFECF4FA),
    tertiary = Color(0xFFFFD385), onTertiary = Color(0xFF0F1721), tertiaryContainer = Color(0xFF332E22), onTertiaryContainer = Color(0xFFFFD385),
    background = Color(0xFF0F1721), surface = Color(0xFF16222F), surfaceVariant = Color(0xFF203142), surfaceContainer = Color(0xFF16222F), surfaceContainerHigh = Color(0xFF203142),
    onBackground = Color(0xFFECF4FA), onSurface = Color(0xFFECF4FA), onSurfaceVariant = Color(0xFFA0B3C5),
    outline = Color(0xFF304556), outlineVariant = Color(0xFF304556), error = Color(0xFFFF9EAE), errorContainer = Color(0xFF33232E), onErrorContainer = Color(0xFFFF9EAE),
)

@Composable fun CereTheme(content: @Composable () -> Unit) {
    val noto = FontFamily.SansSerif
    MaterialTheme(
        colorScheme = CereColors,
        typography = Typography().run { copy(displayLarge=displayLarge.copy(fontFamily=noto), displayMedium=displayMedium.copy(fontFamily=noto), displaySmall=displaySmall.copy(fontFamily=noto), headlineLarge=headlineLarge.copy(fontFamily=noto), headlineMedium=headlineMedium.copy(fontFamily=noto), headlineSmall=headlineSmall.copy(fontFamily=noto), titleLarge=titleLarge.copy(fontFamily=noto), titleMedium=titleMedium.copy(fontFamily=noto), titleSmall=titleSmall.copy(fontFamily=noto), bodyLarge=bodyLarge.copy(fontFamily=noto), bodyMedium=bodyMedium.copy(fontFamily=noto), bodySmall=bodySmall.copy(fontFamily=noto), labelLarge=labelLarge.copy(fontFamily=noto), labelMedium=labelMedium.copy(fontFamily=noto), labelSmall=labelSmall.copy(fontFamily=noto)) },
        shapes = Shapes(extraSmall=RoundedCornerShape(6.dp), small=RoundedCornerShape(8.dp), medium=RoundedCornerShape(10.dp), large=RoundedCornerShape(14.dp), extraLarge=RoundedCornerShape(18.dp)),
        content = content,
    )
}
