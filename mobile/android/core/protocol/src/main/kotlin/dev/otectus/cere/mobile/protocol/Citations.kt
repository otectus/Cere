package dev.otectus.cere.mobile.protocol

/**
 * Replies that use recalled memory cite it as [evidence:ID]. The stored reply keeps every marker:
 * memory provenance is read back from it. While citations are hidden (the desktop's
 * showMemoryCitations setting, off by default) they are left out of what the phone shows and copies.
 * The same rules as broker/citations.ts and native/citations.h, checked against the shared
 * tests/fixtures/memory-citations.json corpus. `\z` is JavaScript's `$`: the very end of the text.
 */
object Citations {
    private const val ID = "[0-9a-f-]{36}"
    private const val GROUP = """\[[ \t]*evidence:[ \t]*$ID(?:[ \t]*[,;][ \t]*(?:evidence:[ \t]*)?$ID)*[ \t]*\]"""
    private const val RUN = """$GROUP(?:[ \t]*(?:[,;][ \t]*)?$GROUP)*"""
    // One bracket may list several ids; a run is adjacent brackets, optionally comma separated. A run
    // wrapped only in parentheses or backticks goes with its wrapper. Every quantified part is bounded
    // by a literal, so matching stays linear on long or malformed text.
    private val marker = Regex("""\([ \t]*$RUN[ \t]*\)|`[ \t]*$RUN[ \t]*`|$RUN""", RegexOption.IGNORE_CASE)
    // A marker still streaming in: everything from its bracket to the end of the text.
    private val partial = Regex("""^\[[ \t]*evidence:[ \t]*[0-9a-f-]{0,36}(?:[ \t]*[,;][ \t]*(?:evidence:[ \t]*)?[0-9a-f-]{0,36})*[ \t]*\z""", RegexOption.IGNORE_CASE)
    // What is left of a line that only cited: nothing, a list or quote marker, or a label such as "Sources:".
    private val leftover = Regex("""^(?:>[ \t]*)*(?:#{1,6}[ \t]+)?(?:(?:[-*+]|[0-9]{1,9}[.)])[ \t]*)?(?:[*_]{0,2}(?:evidence|sources?|references?|citations?|memory|memories)[*_]{0,2}[ \t]*(?::[ \t]*)?[*_]{0,2})?\z""", RegexOption.IGNORE_CASE)
    // After these, the space before a removed marker goes too: "Ruff [evidence:…]." reads "Ruff.".
    private const val CLOSING = " \t\r\u000c\u000b .,;:!?)]}>\"'’”…*_`~"

    private fun horizontal(character: Char?) = character == ' ' || character == '\t'
    private fun blank(line: String) = line.all { it == ' ' || it == '\t' || it == '\r' }
    private fun trimEnd(text: String, characters: String): String { var end = text.length; while (end > 0 && text[end - 1] in characters) end--; return text.substring(0, end) }
    private fun trim(text: String): String { var start = 0; while (start < text.length && text[start] in " \t\r") start++; return trimEnd(text.substring(start), " \t\r") }

    /** Drops a marker still arriving at the end of a streaming reply, with the space or wrapper before it. */
    private fun withoutPartialTail(text: String): String {
        val start = text.lastIndexOf('[')
        if (start < 0 || !partial.containsMatchIn(text.substring(start))) return text
        var end = start
        while (end > 0 && horizontal(text[end - 1])) end--
        if (end > 0 && (text[end - 1] == '(' || text[end - 1] == '`')) end--
        return trimEnd(text.substring(0, end), " \t\r\n")
    }

    /** True when [text] cites memory: shown as is only while citations are visible. */
    fun cites(text: String) = text.contains("evidence:", ignoreCase = true)

    /**
     * The reply as shown while citations are hidden. A marker takes the space before it when
     * punctuation or the end of the line follows; one that starts a line takes the space after it
     * instead. A line that only cited is removed, with a blank line it would leave doubled. Code is
     * not exempt. Text without a complete or trailing partial marker is returned unchanged.
     */
    fun strip(text: String): String {
        if (!cites(text)) return text
        val source = withoutPartialTail(text)
        val lines = source.split('\n')
        val kept = ArrayList<String>(lines.size)
        var changed = source != text
        var skipBlank = false
        for ((index, line) in lines.withIndex()) {
            val output = StringBuilder()
            var last = 0
            var found = false
            for (match in marker.findAll(line)) {
                found = true
                output.append(line, last, match.range.first)
                last = match.range.last + 1
                if (output.all { it == ' ' || it == '\t' }) { while (last < line.length && horizontal(line[last])) last++ }
                else if (last >= line.length || line[last] in CLOSING) { val trimmed = trimEnd(output.toString(), " \t"); output.setLength(0); output.append(trimmed) }
            }
            var value = line
            if (found) {
                changed = true
                value = output.toString() + line.substring(last)
                if (leftover.containsMatchIn(trim(value))) {
                    if (kept.isNotEmpty() && blank(kept.last()) && index + 1 < lines.size && blank(lines[index + 1])) skipBlank = true
                    if (index == lines.size - 1) while (kept.isNotEmpty() && blank(kept.last())) kept.removeAt(kept.size - 1)
                    continue
                }
            }
            if (skipBlank) { skipBlank = false; if (blank(value)) continue }
            kept.add(value)
        }
        return if (changed) kept.joinToString("\n") else text
    }

    /** The text a person sees or copies, following the desktop's citation setting. */
    fun shown(text: String, showCitations: Boolean) = if (showCitations) text else strip(text)
}
