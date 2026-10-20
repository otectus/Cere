package dev.otectus.cere.mobile

import android.content.Context
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.otectus.cere.mobile.data.PortraitSheet
import dev.otectus.cere.mobile.protocol.PortraitState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** On-phone presentation choices (F95). They change only this phone, never the desktop. */
internal object UiPreferences {
    private const val FILE = "cere-ui"
    private var portrait: MutableStateFlow<Boolean>? = null
    fun portrait(context: Context): StateFlow<Boolean> = portrait ?: MutableStateFlow(context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean("portrait", true)).also { portrait = it }
    fun setPortrait(context: Context, shown: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean("portrait", shown).apply()
        (portrait ?: MutableStateFlow(shown).also { portrait = it }).value = shown
    }
}

private fun color(hex: String?, fallback: Color) = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(fallback)

/**
 * W11 (F93): the desktop's portrait as a still status avatar: the expression the desktop would show for
 * this state, in its colors. It never animates; the state is also written beside it as text.
 */
@Composable
internal fun StatusPortrait(sheet: PortraitSheet, resolved: PortraitState.Resolved, size: Dp = 40.dp) {
    val bitmap = remember(sheet.sha256) { android.graphics.BitmapFactory.decodeByteArray(sheet.bytes, 0, sheet.bytes.size) }
    val index = sheet.frames[resolved.expression] ?: 0
    val face = remember(sheet.sha256, index) {
        bitmap?.takeIf { it.width >= sheet.columns * sheet.cell }?.let {
            val rows = it.height / sheet.cell
            if (index / sheet.columns >= rows) null
            else android.graphics.Bitmap.createBitmap(it, (index % sheet.columns) * sheet.cell, (index / sheet.columns) * sheet.cell, sheet.cell, sheet.cell).asImageBitmap()
        }
    }
    val ring = when (resolved.tone) { "attention" -> color(sheet.palette["portraitAttention"], Color(0xFFBB9155)); "warm" -> color(sheet.palette["portraitWarm"], Color(0xFF70B8CB)); else -> color(sheet.palette["portraitAccent"], Color(0xFF367790)) }
    Box(Modifier.size(size).clip(CircleShape)
        .background(Brush.verticalGradient(listOf(color(sheet.palette["portraitTop"], Color(0xFF23495D)), color(sheet.palette["portraitBottom"], Color(0xFF101C2B)))))
        .border(2.dp, ring, CircleShape)) {
        face?.let { Image(it, contentDescription = null, modifier = Modifier.fillMaxSize()) }
    }
}
