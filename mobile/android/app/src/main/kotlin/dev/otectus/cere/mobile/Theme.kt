package dev.otectus.cere.mobile

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Ink and ice from the desktop portrait, with amber reserved for attention.
private val Night = darkColorScheme(
    primary = Color(0xFF71DCFF), onPrimary = Color(0xFF003546),
    primaryContainer = Color(0xFF163E50), onPrimaryContainer = Color(0xFFBFEFFF),
    secondary = Color(0xFFABC7D4), onSecondary = Color(0xFF17313C),
    secondaryContainer = Color(0xFF293E4A), onSecondaryContainer = Color(0xFFE0EEF4),
    tertiary = Color(0xFFFFCF83), onTertiary = Color(0xFF452C00),
    tertiaryContainer = Color(0xFF483821), onTertiaryContainer = Color(0xFFFFDEAC),
    background = Color(0xFF101923), onBackground = Color(0xFFEAF1F6),
    surface = Color(0xFF15202B), onSurface = Color(0xFFEAF1F6),
    surfaceDim = Color(0xFF101923), surfaceBright = Color(0xFF354350),
    surfaceContainerLowest = Color(0xFF0C141D), surfaceContainerLow = Color(0xFF14202C),
    surfaceContainer = Color(0xFF192734), surfaceContainerHigh = Color(0xFF213140),
    surfaceContainerHighest = Color(0xFF2A3B49), surfaceVariant = Color(0xFF253543),
    onSurfaceVariant = Color(0xFFB2C3D0), outline = Color(0xFF788B99), outlineVariant = Color(0xFF354755),
    error = Color(0xFFFFB2B9), onError = Color(0xFF5F1422),
    errorContainer = Color(0xFF4B2730), onErrorContainer = Color(0xFFFFDADF),
    inverseSurface = Color(0xFFE2EBF1), inverseOnSurface = Color(0xFF1B2B37), inversePrimary = Color(0xFF006581),
    surfaceTint = Color(0xFF71DCFF),
)

private val Day = lightColorScheme(
    primary = Color(0xFF00647F), onPrimary = Color.White,
    primaryContainer = Color(0xFFCDEEF9), onPrimaryContainer = Color(0xFF073F52),
    secondary = Color(0xFF475F6C), onSecondary = Color.White,
    secondaryContainer = Color(0xFFDFEAF0), onSecondaryContainer = Color(0xFF1D3847),
    tertiary = Color(0xFF815000), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFE6BD), onTertiaryContainer = Color(0xFF593900),
    background = Color(0xFFF3F6F8), onBackground = Color(0xFF14232F),
    surface = Color(0xFFFAFCFD), onSurface = Color(0xFF14232F),
    surfaceDim = Color(0xFFD9E3E9), surfaceBright = Color.White,
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF3F6F8),
    surfaceContainer = Color(0xFFEBF1F4), surfaceContainerHigh = Color(0xFFE4ECF1),
    surfaceContainerHighest = Color(0xFFDAE5EB), surfaceVariant = Color(0xFFE1EAF0),
    onSurfaceVariant = Color(0xFF485D6B), outline = Color(0xFF647C8A), outlineVariant = Color(0xFFCAD7DF),
    error = Color(0xFFAB3043), onError = Color.White,
    errorContainer = Color(0xFFFFDDE0), onErrorContainer = Color(0xFF741729),
    inverseSurface = Color(0xFF263845), inverseOnSurface = Color(0xFFEBF2F7), inversePrimary = Color(0xFF71DCFF),
    surfaceTint = Color(0xFF00647F),
)

internal object CereLayout {
    val gutter = 16.dp
    val groupGap = 12.dp
    val readingWidth = 760.dp
    val target = 48.dp
}

private val CereType = Typography().run {
    copy(
        headlineLarge = headlineLarge.copy(fontSize = 32.sp, lineHeight = 38.sp, letterSpacing = (-0.8).sp, fontWeight = FontWeight.SemiBold),
        headlineSmall = headlineSmall.copy(fontSize = 26.sp, lineHeight = 32.sp, letterSpacing = (-0.5).sp, fontWeight = FontWeight.SemiBold),
        titleLarge = titleLarge.copy(fontSize = 21.sp, lineHeight = 27.sp, letterSpacing = (-0.3).sp, fontWeight = FontWeight.SemiBold),
        titleMedium = titleMedium.copy(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = bodyLarge.copy(fontSize = 16.sp, lineHeight = 25.sp, letterSpacing = 0.1.sp),
        bodySmall = bodySmall.copy(fontSize = 13.sp, lineHeight = 19.sp),
        labelSmall = labelSmall.copy(fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.15.sp),
    )
}
private val CereShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp), large = RoundedCornerShape(20.dp), extraLarge = RoundedCornerShape(26.dp),
)

@Composable fun CereTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Night else Day, typography = CereType, shapes = CereShapes, content = content)
}
