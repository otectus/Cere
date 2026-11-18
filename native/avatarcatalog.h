#pragma once
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>
#include <QVariantMap>

// Runtime validation shared by startup, the controller and native tests. The
// complete authoring schema is checked by broker/avatars.ts at build time.
namespace AvatarCatalog {
struct Result {
    QJsonArray entries;
    QString defaultId;
    QVariantMap aliases, palettes;
    QString error;
    QString canonical(const QString &id) const { return aliases.value(id, defaultId).toString(); }
};

inline Result parse(const QByteArray &bytes) {
    const auto fail=[](const QString &message) { Result result; result.error=message; return result; };
    QJsonParseError error;
    const auto document=QJsonDocument::fromJson(bytes,&error);
    if(error.error!=QJsonParseError::NoError||!document.isArray()||document.array().isEmpty())
        return fail(QStringLiteral("Avatar manifest must be a nonempty JSON array: %1").arg(error.errorString()));
    const QRegularExpression identifier(QStringLiteral("\\A[a-z][a-z0-9_]{0,63}\\z"));
    const QRegularExpression png(QStringLiteral("\\A[a-zA-Z0-9_-]+\\.png\\z"));
    const QRegularExpression rig(QStringLiteral("\\A[a-zA-Z0-9_-]+\\.json\\z"));
    const QRegularExpression color(QStringLiteral("\\A#(?:[a-f0-9]{6}|[a-f0-9]{8})\\z"));
    Result result;
    QSet<QString> names;
    QStringList paletteKeys;
    for(const auto &value:document.array()) {
        if(!value.isObject())return fail("Avatar manifest contains a non-object entry");
        auto entry=value.toObject();
        const auto id=entry.value("id").toString();
        if(!identifier.match(id).hasMatch())return fail("Invalid avatar ID: "+id);
        for(const auto *key:{"label","description","themeLabel"})
            if(entry.value(QLatin1String(key)).toString().trimmed().isEmpty())return fail(id+": missing "+QLatin1String(key));
        if(!png.match(entry.value("portrait").toString()).hasMatch()||!rig.match(entry.value("rig").toString()).hasMatch())
            return fail(id+": invalid portrait or rig filename");
        if(!entry.value("default").isBool()||!entry.value("aliases").isArray()||!entry.value("authoring").isObject())
            return fail(id+": missing default, aliases or authoring metadata");
        if(entry.value("default").toBool()) {
            if(!result.defaultId.isEmpty())return fail("Avatar manifest has multiple defaults");
            result.defaultId=id;
        }
        auto aliases=entry.value("aliases").toArray();aliases.prepend(id);
        for(const auto &alias:aliases) {
            const auto name=alias.toString();
            if(!identifier.match(name).hasMatch()||names.contains(name))return fail("Invalid or duplicate avatar ID/alias: "+name);
            names.insert(name);result.aliases.insert(name,id);
        }
        const auto palette=entry.value("palette").toObject();
        if(palette.isEmpty())return fail(id+": missing palette");
        if(paletteKeys.isEmpty())paletteKeys=palette.keys();
        if(palette.keys()!=paletteKeys)return fail(id+": incomplete palette");
        for(auto it=palette.begin();it!=palette.end();++it)
            if(!color.match(it.value().toString()).hasMatch())return fail(id+": invalid palette color "+it.key());
        result.palettes.insert(id,palette.toVariantMap());
        // QML needs identity and runtime assets, not thousands of source landmarks.
        entry.remove("authoring");result.entries.append(entry);
    }
    if(result.defaultId.isEmpty())return fail("Avatar manifest has no default");
    return result;
}
inline Result load(const QString &path) {
    QFile file(path);
    if(!file.open(QIODevice::ReadOnly)){Result result;result.error="Cannot read avatar manifest: "+path;return result;}
    return parse(file.readAll());
}
} // namespace AvatarCatalog
