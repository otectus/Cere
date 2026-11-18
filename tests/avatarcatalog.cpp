#include "avatarcatalog.h"
#include <QCoreApplication>
#include <iostream>

int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    QFile file(QString::fromLocal8Bit(argv[1])+"/assets/avatars.json");
    if(!file.open(QIODevice::ReadOnly))return 1;
    const auto entries=QJsonDocument::fromJson(file.readAll()).array();
    bool ok=true;
    const auto expect=[&](const QJsonArray &value,bool valid,const char *message) {
        const auto result=AvatarCatalog::parse(QJsonDocument(value).toJson());
        if(result.error.isEmpty()!=valid){std::cerr<<message<<": "<<result.error.toStdString()<<'\n';ok=false;}
        return result;
    };
    const auto catalog=expect(entries,true,"shipped manifest");
    if(catalog.canonical("cere")!="cere_default"||catalog.canonical("unknown")!=catalog.defaultId)ok=false;
    if(catalog.entries.size()!=entries.size())ok=false;
    auto future=entries.first().toObject();
    future["id"]="future_companion";future["label"]="Future companion";future["default"]=false;future["aliases"]=QJsonArray{"past_companion"};
    auto expanded=entries;expanded.append(future);
    const auto next=expect(expanded,true,"new entry without a native allowlist");
    if(next.canonical("past_companion")!="future_companion")ok=false;
    QJsonArray reordered;for(const auto &entry:expanded)reordered.prepend(entry);
    if(expect(reordered,true,"reordered default").defaultId!=catalog.defaultId)ok=false;
    expect({},false,"empty catalog");
    auto duplicate=entries;duplicate.append(entries.first());expect(duplicate,false,"duplicate ID");
    future["aliases"]=QJsonArray{catalog.defaultId};expanded=entries;expanded.append(future);expect(expanded,false,"alias collision");
    future["aliases"]=QJsonArray{"repeat","repeat"};expanded=entries;expanded.append(future);expect(expanded,false,"duplicate aliases");
    future["aliases"]=QJsonArray{};future["default"]=true;expanded=entries;expanded.append(future);expect(expanded,false,"multiple defaults");
    future["default"]=false;expect(QJsonArray{future},false,"missing default");
    for(const auto *key:{"id","label","description","themeLabel","portrait","rig","palette","aliases","authoring","default"}) {
        auto missing=entries.first().toObject();missing.remove(QLatin1String(key));
        expect(QJsonArray{missing},false,key);
    }
    for(const auto *key:{"portrait","rig"}) {
        auto escaped=entries.first().toObject();escaped[QLatin1String(key)]="../outside.png";
        expect(QJsonArray{escaped},false,"unsafe asset path");
    }
    auto broken=entries.first().toObject(),palette=broken.value("palette").toObject();
    palette["accent"]="red";broken["palette"]=palette;expect(QJsonArray{broken},false,"malformed palette");
    broken=entries.last().toObject();palette=broken.value("palette").toObject();palette.remove("accent");broken["palette"]=palette;
    auto incomplete=entries;incomplete.replace(incomplete.size()-1,broken);expect(incomplete,false,"missing palette token");
    if(ok)std::cout<<"Native avatar catalog: all "<<entries.size()<<" entries, future entry, aliases, defaults and malformed cases passed\n";
    return ok?0:1;
}
