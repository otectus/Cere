#pragma once
#include <QRegularExpression>
#include <QString>
#include <QStringList>

// Replies that use recalled memory cite it as [evidence:ID]. The stored reply keeps every marker:
// memory provenance is read back from it. While citations are hidden the desktop leaves them out of
// what it shows, copies, quotes, speaks and branches. broker/citations.ts applies the same rules, and
// tests/fixtures/memory-citations.json checks both. `\z` here is JavaScript's `$`: the very end.
inline QString stripMemoryCitations(const QString &text){
    if(!text.contains(QLatin1String("evidence:"),Qt::CaseInsensitive))return text;
    // One bracket may list several ids; a run is adjacent brackets, optionally comma separated. A run
    // wrapped only in parentheses or backticks goes with its wrapper. Every quantified part is bounded
    // by a literal, so matching stays linear on long or malformed text.
    static const QString id=QStringLiteral("[0-9a-f-]{36}");
    static const QString group=QStringLiteral(R"(\[[ \t]*evidence:[ \t]*%1(?:[ \t]*[,;][ \t]*(?:evidence:[ \t]*)?%1)*[ \t]*\])").arg(id);
    static const QString run=QStringLiteral(R"(%1(?:[ \t]*(?:[,;][ \t]*)?%1)*)").arg(group);
    static const QRegularExpression marker(QStringLiteral(R"(\([ \t]*%1[ \t]*\)|`[ \t]*%1[ \t]*`|%1)").arg(run),QRegularExpression::CaseInsensitiveOption);
    // A marker still streaming in: everything from its bracket to the end of the text.
    static const QRegularExpression partial(QStringLiteral(R"(^\[[ \t]*evidence:[ \t]*[0-9a-f-]{0,36}(?:[ \t]*[,;][ \t]*(?:evidence:[ \t]*)?[0-9a-f-]{0,36})*[ \t]*\z)"),QRegularExpression::CaseInsensitiveOption);
    // What is left of a line that only cited: nothing, a list or quote marker, or a label such as "Sources:".
    static const QRegularExpression leftover(QStringLiteral(R"(^(?:>[ \t]*)*(?:#{1,6}[ \t]+)?(?:(?:[-*+]|[0-9]{1,9}[.)])[ \t]*)?(?:[*_]{0,2}(?:evidence|sources?|references?|citations?|memory|memories)[*_]{0,2}[ \t]*(?::[ \t]*)?[*_]{0,2})?\z)"),QRegularExpression::CaseInsensitiveOption);
    // After these, the space before a removed marker goes too: "Ruff [evidence:…]." reads "Ruff.".
    static const QString closing=QStringLiteral(" \t\r\f\v .,;:!?)]}>\"'’”…*_`~");
    const auto horizontal=[](QChar character){return character==u' '||character==u'\t';};
    const auto only=[](const QString &value,QStringView characters){for(const QChar character:value)if(!characters.contains(character))return false;return true;};
    const auto blank=[&](const QString &line){return only(line,u" \t\r");};
    const auto trimEnd=[](QString value,QStringView characters){qsizetype end=value.size();while(end>0&&characters.contains(value.at(end-1)))--end;value.truncate(end);return value;};
    const auto trim=[&](const QString &value){qsizetype start=0;while(start<value.size()&&QStringView(u" \t\r").contains(value.at(start)))++start;return trimEnd(value.mid(start),u" \t\r");};

    // Drops a marker still arriving at the end of a streaming reply, with the space or wrapper before it.
    QString source=text;
    if(const qsizetype start=text.lastIndexOf(u'[');start>=0&&partial.match(text.mid(start)).hasMatch()){
        qsizetype end=start;
        while(end>0&&horizontal(text.at(end-1)))--end;
        if(end>0&&(text.at(end-1)==u'('||text.at(end-1)==u'`'))--end;
        source=trimEnd(text.left(end),u" \t\r\n");
    }
    // A marker takes the space before it when punctuation or the end of the line follows; one that
    // starts a line takes the space after it instead. A line that only cited is removed, with a blank
    // line it would leave doubled. Code is not exempt.
    const QStringList lines=source.split(u'\n');
    QStringList kept;bool changed=source!=text,skipBlank=false;
    for(qsizetype index=0;index<lines.size();++index){
        const QString &line=lines.at(index);
        QString output;qsizetype last=0;bool found=false;
        for(auto matches=marker.globalMatch(line);matches.hasNext();){
            const auto match=matches.next();found=true;
            output+=line.mid(last,match.capturedStart()-last);
            last=match.capturedEnd();
            if(only(output,u" \t"))while(last<line.size()&&horizontal(line.at(last)))++last;
            else if(last>=line.size()||closing.contains(line.at(last)))output=trimEnd(output,u" \t");
        }
        QString value=line;
        if(found){
            changed=true;
            value=output+line.mid(last);
            if(leftover.match(trim(value)).hasMatch()){
                if(!kept.isEmpty()&&blank(kept.last())&&index+1<lines.size()&&blank(lines.at(index+1)))skipBlank=true;
                if(index==lines.size()-1)while(!kept.isEmpty()&&blank(kept.last()))kept.removeLast();
                continue;
            }
        }
        if(skipBlank){skipBlank=false;if(blank(value))continue;}
        kept.append(value);
    }
    return changed?kept.join(u'\n'):text;
}
