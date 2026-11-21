package dev.otectus.cere.mobile

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import org.commonmark.ext.gfm.tables.*
import org.commonmark.node.*
import org.commonmark.node.Text as TextNode
import org.commonmark.parser.Parser
import java.net.URI
import java.util.Locale

private val markdownParser = Parser.builder().extensions(listOf(TablesExtension.create())).build()
private fun Node.nodes(): List<Node> = buildList { var node = firstChild; while (node != null) { add(node); node = node.next } }

/** Native selectable Markdown. Links open only on tap; image URLs are never fetched here. */
@Composable
fun CereMarkdown(value: String) {
    // A large response can arrive in successive revisions. Parse those away from the input
    // thread, retaining the visible prefix while the next revision is being formatted.
    val document = if (value.length <= 4096) remember(value) { markdownParser.parse(value) } else {
        val source = value
        val parsed by produceState<Pair<String, Node>?>(null, source) {
            this.value = withContext(Dispatchers.Default) { source to markdownParser.parse(source) }
        }
        parsed?.takeIf { value.startsWith(it.first) }?.second
    }
    if (document == null) {
        LinearProgressIndicator(Modifier.fillMaxWidth())
        return
    }
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceContainerHighest
    val resources = LocalResources.current
    SelectionContainer {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            document.nodes().forEach { MarkdownBlock(it, 0, linkColor, codeBackground, resources) }
        }
    }
}

@Composable
private fun MarkdownBlock(node: Node, depth: Int, linkColor: Color, codeBackground: Color, resources: android.content.res.Resources) {
    if (depth > 24) { Text(node.inlineText(linkColor, codeBackground, resources)); return }
    when (node) {
        is Heading -> Text(node.inlineText(linkColor, codeBackground, resources), modifier = Modifier.semantics { heading() },
            style = when (node.level) { 1 -> MaterialTheme.typography.headlineSmall; 2 -> MaterialTheme.typography.titleLarge; else -> MaterialTheme.typography.titleMedium },
            fontWeight = FontWeight.Bold)
        is FencedCodeBlock -> CodeBlock(node.literal, node.info)
        is IndentedCodeBlock -> CodeBlock(node.literal, "")
        is BlockQuote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
            Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                node.nodes().forEach { MarkdownBlock(it, depth + 1, linkColor, codeBackground, resources) }
            }
        }
        is BulletList, is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            node.nodes().forEachIndexed { index, item -> Row {
                Text(if (node is OrderedList) "${node.markerStartNumber + index}. " else "• ", Modifier.widthIn(min = 26.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    item.nodes().forEach { MarkdownBlock(it, depth + 1, linkColor, codeBackground, resources) }
                }
            } }
        }
        is TableBlock -> MarkdownTable(node, linkColor, codeBackground, resources)
        is ThematicBreak -> HorizontalDivider()
        is HtmlBlock -> Text(node.literal, fontFamily = FontFamily.Monospace)
        is org.commonmark.node.Paragraph -> Text(node.inlineText(linkColor, codeBackground, resources), style = MaterialTheme.typography.bodyLarge)
        else -> if (node.firstChild != null) node.nodes().forEach {
            MarkdownBlock(it, depth + 1, linkColor, codeBackground, resources)
        } else Text(node.inlineText(linkColor, codeBackground, resources))
    }
}

@Composable
private fun CodeBlock(source: String, language: String) {
    val context = LocalContext.current
    var copied by remember(source) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(2_000)
            copied = false
        }
    }
    val languageLabel = language.trim().take(48).ifBlank { stringResource(R.string.markdown_code) }
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "$languageLabel code block" }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(languageLabel, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton({
                    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(languageLabel, source))
                    copied = true
                }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(stringResource(if (copied) R.string.markdown_code_copied else R.string.markdown_copy_code))
                }
            }
            Text(source.trimEnd('\n'), Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 4.dp),
                fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, softWrap = false)
        }
    }
}

@Composable
private fun MarkdownTable(table: TableBlock, linkColor: Color, codeBackground: Color, resources: android.content.res.Resources) {
    val rows = table.nodes().flatMap { section -> section.nodes().map { it to (section is TableHead) } }
    val columns = rows.maxOfOrNull { (row) -> row.nodes().size } ?: 0
    val tableDescription = stringResource(R.string.markdown_table_description, rows.size, columns)
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = tableDescription }) {
        Column(Modifier.horizontalScroll(rememberScrollState())) { rows.forEachIndexed { index, (row, header) ->
            Row { row.nodes().forEach { cell ->
                Text(cell.inlineText(linkColor, codeBackground, resources), Modifier.width(200.dp).padding(10.dp),
                    style = MaterialTheme.typography.bodyMedium, fontWeight = if (header) FontWeight.Bold else FontWeight.Normal)
            } }
            if (index != rows.lastIndex) HorizontalDivider()
        } }
    }
}

/** An address the app may open on tap: http(s) with a host and no embedded credentials. */
internal fun safeLink(value: String): String? {
    if (value.isBlank() || value.any { it.isISOControl() }) return null
    return runCatching { URI(value) }.getOrNull()?.takeIf {
        it.scheme?.lowercase(Locale.ROOT) in setOf("https", "http") && !it.host.isNullOrBlank() && it.userInfo == null
    }?.toASCIIString()
}

private fun Node.inlineText(linkColor: Color, codeBackground: Color, resources: android.content.res.Resources): AnnotatedString =
    buildAnnotatedString { appendInline(this@inlineText, 0, linkColor, codeBackground, resources) }

private fun AnnotatedString.Builder.appendInline(
    node: Node,
    depth: Int,
    linkColor: Color,
    codeBackground: Color,
    resources: android.content.res.Resources,
) {
    if (depth > 64) return
    fun children() { node.nodes().forEach { appendInline(it, depth + 1, linkColor, codeBackground, resources) } }
    fun linkStyles() = TextLinkStyles(style = SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))
    when (node) {
        is TextNode -> append(node.literal)
        is SoftLineBreak -> append("\n")
        is HardLineBreak -> append("\n")
        is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(node.literal) }
        is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { children() }
        is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { children() }
        is Link -> safeLink(node.destination)?.let { url -> withLink(LinkAnnotation.Url(url, linkStyles())) { children() } } ?: children()
        is Image -> {
            val alt = buildAnnotatedString { node.nodes().forEach {
                appendInline(it, depth + 1, linkColor, codeBackground, resources)
            } }.text.trim()
            append(if (alt.isBlank()) resources.getString(R.string.markdown_image_without_description)
                else resources.getString(R.string.markdown_image, alt))
            safeLink(node.destination)?.let { url ->
                append(" · ")
                withLink(LinkAnnotation.Url(url, linkStyles())) { append(resources.getString(R.string.markdown_open_image)) }
            }
        }
        // Raw HTML is neither executed nor exposed as visual markup. Its text children remain.
        is HtmlInline -> Unit
        else -> children()
    }
}
