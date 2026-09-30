package dev.otectus.cere.mobile

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.commonmark.ext.gfm.tables.*
import org.commonmark.node.*
import org.commonmark.node.Text as TextNode
import org.commonmark.parser.Parser
import java.net.URI

private val markdownParser = Parser.builder().extensions(listOf(TablesExtension.create())).build()
private fun Node.nodes(): List<Node> = buildList { var node = firstChild; while (node != null) { add(node); node = node.next } }

/** Native selectable Markdown. Links open only on tap; image URLs are never fetched here. */
@Composable
fun CereMarkdown(value: String) {
    val document = remember(value) { markdownParser.parse(value) }
    SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { document.nodes().forEach { MarkdownBlock(it, 0) } } }
}

@Composable
private fun MarkdownBlock(node: Node, depth: Int) {
    if (depth > 24) { Text(node.inlineText()); return }
    when (node) {
        is Heading -> Text(node.inlineText(), style = when (node.level) { 1 -> MaterialTheme.typography.headlineSmall; 2 -> MaterialTheme.typography.titleLarge; else -> MaterialTheme.typography.titleMedium }, fontWeight = FontWeight.Bold)
        is FencedCodeBlock -> CodeBlock(node.literal, node.info)
        is IndentedCodeBlock -> CodeBlock(node.literal, "")
        is BlockQuote -> Row(Modifier.fillMaxWidth()) {
            Box(Modifier.width(3.dp).heightIn(min = 28.dp).background(MaterialTheme.colorScheme.primary))
            Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { node.nodes().forEach { MarkdownBlock(it, depth + 1) } }
        }
        is BulletList, is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            node.nodes().forEachIndexed { index, item -> Row {
                Text(if (node is OrderedList) "${node.markerStartNumber + index}. " else "• ", Modifier.widthIn(min = 26.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) { item.nodes().forEach { MarkdownBlock(it, depth + 1) } }
            } }
        }
        is TableBlock -> MarkdownTable(node)
        is ThematicBreak -> HorizontalDivider()
        is HtmlBlock -> Text(node.literal, fontFamily = FontFamily.Monospace)
        is org.commonmark.node.Paragraph -> Text(node.inlineText(), style = MaterialTheme.typography.bodyLarge)
        else -> if (node.firstChild != null) node.nodes().forEach { MarkdownBlock(it, depth + 1) } else Text(node.inlineText())
    }
}

@Composable
private fun CodeBlock(source: String, language: String) {
    val context = LocalContext.current
    Surface(color = MaterialTheme.colorScheme.background, shape = MaterialTheme.shapes.small) {
        Column(Modifier.fillMaxWidth().padding(10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(language.take(48).ifBlank { "Code" }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton({ context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Code", source)) }) { Text("Copy code") }
            }
            Text(source.trimEnd('\n'), Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, softWrap = false)
        }
    }
}

@Composable
private fun MarkdownTable(table: TableBlock) {
    val rows = table.nodes().flatMap { section -> section.nodes() }
    Surface(color = MaterialTheme.colorScheme.background, shape = MaterialTheme.shapes.small) {
        Column(Modifier.horizontalScroll(rememberScrollState())) { rows.forEachIndexed { index, row ->
            Row { row.nodes().forEach { cell ->
                Text(cell.inlineText(), Modifier.width(200.dp).padding(10.dp), style = MaterialTheme.typography.bodyMedium, fontWeight = if (index == 0) FontWeight.Bold else FontWeight.Normal)
            } }
            HorizontalDivider()
        } }
    }
}

private fun safeLink(value: String): String? = runCatching { URI(value) }.getOrNull()?.takeIf { it.scheme in listOf("https", "http") && !it.host.isNullOrBlank() && it.userInfo == null }?.toASCIIString()
private fun Node.inlineText(): AnnotatedString = buildAnnotatedString { appendInline(this@inlineText, 0) }
private fun AnnotatedString.Builder.appendInline(node: Node, depth: Int) {
    if (depth > 64) return
    fun children() { node.nodes().forEach { appendInline(it, depth + 1) } }
    when (node) {
        is TextNode -> append(node.literal)
        is SoftLineBreak -> append("\n")
        is HardLineBreak -> append("\n")
        is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(node.literal) }
        is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { children() }
        is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { children() }
        is Link -> safeLink(node.destination)?.let { url -> withLink(LinkAnnotation.Url(url)) { children() } } ?: children()
        is Image -> { append("[Image: "); children(); append("]"); safeLink(node.destination)?.let { url -> withLink(LinkAnnotation.Url(url)) { append(" Open image") } } }
        is HtmlInline -> append(node.literal)
        else -> children()
    }
}
