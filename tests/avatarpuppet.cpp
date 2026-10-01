#include "avatarpuppet.h"
#include "avatarskeleton.h"

#include <QColor>
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QGuiApplication>
#include <QImage>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QPainter>
#include <QQuickWindow>
#include <QSGRendererInterface>
#include <QSet>
#include <QTemporaryDir>
#include <QThread>
#include <QTimer>
#include <QJSEngine>
#include <QDir>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>

namespace {

bool check(bool condition, const char *message)
{
    if (!condition)
        std::cerr << message << '\n';
    return condition;
}

bool check(bool condition, const QString &message)
{
    if (!condition)
        std::cerr << message.toStdString() << '\n';
    return condition;
}

QVariantMap bone(const QString &name, const QString &parent, qreal x, qreal y,
                 const QString &angle = {}, const QString &offsetX = {},
                 const QString &offsetY = {})
{
    QVariantMap result{{QStringLiteral("name"), name},
                       {QStringLiteral("parent"), parent},
                       {QStringLiteral("x"), x},
                       {QStringLiteral("y"), y}};
    if (!angle.isEmpty())
        result.insert(QStringLiteral("angle"), angle);
    if (!offsetX.isEmpty())
        result.insert(QStringLiteral("offsetX"), offsetX);
    if (!offsetY.isEmpty())
        result.insert(QStringLiteral("offsetY"), offsetY);
    return result;
}

QVariantMap part(const QString &name, const QString &boneName, int tile,
                 const QVariantList &rect, qreal z)
{
    return {{QStringLiteral("name"), name},
            {QStringLiteral("bone"), boneName},
            {QStringLiteral("sourceRect"), QVariantList{tile * 16, 0, 16, 16}},
            {QStringLiteral("rect"), rect},
            {QStringLiteral("z"), z}};
}

QVariantMap validDefinition()
{
    // Deliberately child-first: validation must topologically sort these bones.
    QVariantList bones{
        bone(QStringLiteral("leftHand"), QStringLiteral("leftForearm"), 0, 10,
             QStringLiteral("leftWrist")),
        bone(QStringLiteral("hair"), QStringLiteral("head"), 0, 0,
             QStringLiteral("hairRotation")),
        bone(QStringLiteral("head"), QStringLiteral("torso"), 0, -20,
             QStringLiteral("headTilt"), QStringLiteral("headX"),
             QStringLiteral("headY")),
        bone(QStringLiteral("leftForearm"), QStringLiteral("leftUpperArm"), 0, 12,
             QStringLiteral("leftElbow")),
        bone(QStringLiteral("torso"), QStringLiteral("root"), 32, 50,
             QStringLiteral("bodyTilt"), QStringLiteral("hipX"),
             QStringLiteral("breathLift")),
        bone(QStringLiteral("leftUpperArm"), QStringLiteral("torso"), -12, -20,
             QStringLiteral("leftArm")),
        bone(QStringLiteral("root"), QString(), 0, 0)
    };

    QVariantMap blink = part(QStringLiteral("closedEyes"), QStringLiteral("head"),
                             4, QVariantList{-10, -10, 20, 20}, 4);
    blink.insert(QStringLiteral("opacityChannel"), QStringLiteral("blink"));
    QVariantMap openHand = part(QStringLiteral("openHand"), QStringLiteral("leftHand"),
                                5, QVariantList{-4, -4, 8, 8}, 5);
    openHand.insert(QStringLiteral("mirrorX"), true);
    openHand.insert(QStringLiteral("visibleWhen"),
                    QVariantMap{{QStringLiteral("channel"), QStringLiteral("leftHandOpen")},
                                {QStringLiteral("min"), 0.5},
                                {QStringLiteral("max"), 1.1}});

    const QVariantList parts{
        part(QStringLiteral("torsoArt"), QStringLiteral("torso"), 1,
             QVariantList{-14, -24, 28, 24}, 1),
        part(QStringLiteral("headArt"), QStringLiteral("head"), 3,
             QVariantList{-10, -10, 20, 20}, 3),
        part(QStringLiteral("backHair"), QStringLiteral("hair"), 0,
             QVariantList{-12, -12, 24, 20}, 0),
        part(QStringLiteral("leftArmArt"), QStringLiteral("leftUpperArm"), 2,
             QVariantList{-4, 0, 8, 24}, 2),
        blink,
        openHand
    };
    return {{QStringLiteral("version"), 1},
            {QStringLiteral("referenceSize"), QVariantList{64, 64}},
            {QStringLiteral("bones"), bones},
            {QStringLiteral("parts"), parts}};
}

QImage makeAtlas()
{
    QImage atlas(96, 16, QImage::Format_ARGB32_Premultiplied);
    atlas.fill(Qt::transparent);
    QPainter painter(&atlas);
    const QColor colors[]{QColor(25, 180, 70), QColor(25, 75, 210),
                          QColor(220, 35, 35), QColor(240, 195, 25),
                          QColor(15, 15, 25), QColor(30, 210, 220)};
    for (int index = 0; index < 6; ++index)
        painter.fillRect(index * 16, 0, 16, 16, colors[index]);
    return atlas;
}

QVector<qreal> matrix(const QVariantMap &transforms, const QString &boneName)
{
    QVector<qreal> result;
    for (const QVariant &value : transforms.value(boneName).toList())
        result.append(value.toDouble());
    return result;
}

QPointF origin(const QVector<qreal> &transform)
{
    return {transform[4], transform[5]};
}

bool close(qreal left, qreal right, qreal tolerance = 0.000001)
{
    return std::abs(left - right) <= tolerance;
}

bool sameMatrix(const QVector<qreal> &left, const QVector<qreal> &right)
{
    if (left.size() != 6 || right.size() != 6)
        return false;
    for (int index = 0; index < 6; ++index) {
        if (!close(left[index], right[index]))
            return false;
    }
    return true;
}

qreal distance(const QPointF &left, const QPointF &right)
{
    return std::hypot(left.x() - right.x(), left.y() - right.y());
}

QImage synchronizedGrab(QQuickWindow &window)
{
    window.show();
    QElapsedTimer exposure;
    exposure.start();
    while (!window.isExposed() && exposure.elapsed() < 1500) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
        QThread::msleep(1);
    }
    if (!window.isExposed())
        return {};
    for (int frame = 0; frame < 3; ++frame) {
        QEventLoop loop;
        QTimer timeout;
        timeout.setSingleShot(true);
        bool rendered = false;
        const auto connection = QObject::connect(
                &window, &QQuickWindow::afterRendering, &loop, [&] {
                    rendered = true;
                    loop.quit();
                }, Qt::QueuedConnection);
        timeout.callOnTimeout(&loop, &QEventLoop::quit);
        timeout.start(2000);
        window.requestUpdate();
        loop.exec();
        QObject::disconnect(connection);
        if (!rendered)
            return {};
    }
    return window.grabWindow();
}

bool skeletonChecks(AvatarPuppet &puppet)
{
    bool ok = true;
    const QVariantMap rest = puppet.boneTransforms();
    const QVector<qreal> restHead = matrix(rest, QStringLiteral("head"));
    const QVector<qreal> restHair = matrix(rest, QStringLiteral("hair"));
    const QVector<qreal> restShoulder = matrix(rest, QStringLiteral("leftUpperArm"));
    const QVector<qreal> restForearm = matrix(rest, QStringLiteral("leftForearm"));
    ok &= check(restHead.size() == 6 && restHair.size() == 6,
                "valid bones must expose six-component transforms");

    puppet.setPose({{QStringLiteral("leftArm"), 83.0},
                    {QStringLiteral("leftElbow"), -47.0},
                    {QStringLiteral("leftWrist"), 29.0}});
    const QVariantMap armPose = puppet.boneTransforms();
    ok &= check(sameMatrix(restHead, matrix(armPose, QStringLiteral("head")))
                        && sameMatrix(restHair, matrix(armPose, QStringLiteral("hair"))),
                "left arm channels must not alter head or hair transforms");
    ok &= check(!sameMatrix(restForearm,
                            matrix(armPose, QStringLiteral("leftForearm"))),
                "left arm channels must alter the left arm subtree");
    ok &= check(close(distance(origin(restShoulder), origin(restForearm)), 12.0)
                        && close(distance(origin(matrix(armPose, QStringLiteral("leftUpperArm"))),
                                          origin(matrix(armPose, QStringLiteral("leftForearm")))),
                                 12.0),
                "joint rotation must preserve child segment length");
    ok &= check(origin(restShoulder)
                        == origin(matrix(armPose, QStringLiteral("leftUpperArm"))),
                "joint rotation must keep its attachment pivot fixed");

    puppet.setPose({{QStringLiteral("hairRotation"), 35.0}});
    const QVariantMap hairPose = puppet.boneTransforms();
    ok &= check(sameMatrix(restHead, matrix(hairPose, QStringLiteral("head")))
                        && !sameMatrix(restHair, matrix(hairPose, QStringLiteral("hair"))),
                "hair rotation must affect only the hair subtree");

    puppet.setPose({{QStringLiteral("headTilt"),
                     std::numeric_limits<double>::infinity()},
                    {QStringLiteral("headX"),
                     std::numeric_limits<double>::quiet_NaN()},
                    {QStringLiteral("hipX"), std::numeric_limits<double>::max()},
                    {QStringLiteral("leftArm"), -std::numeric_limits<double>::max()}});
    const QVariantMap extreme = puppet.boneTransforms();
    for (auto entry = extreme.cbegin(); entry != extreme.cend(); ++entry) {
        const QVector<qreal> transform = matrix(extreme, entry.key());
        bool finite = transform.size() == 6;
        for (qreal value : transform)
            finite = finite && std::isfinite(value);
        const qreal firstLength = std::hypot(transform[0], transform[2]);
        const qreal secondLength = std::hypot(transform[1], transform[3]);
        const qreal dot = transform[0] * transform[1]
                + transform[2] * transform[3];
        ok &= check(finite && close(firstLength, 1.0) && close(secondLength, 1.0)
                            && close(dot, 0.0),
                    "every extreme-pose bone transform must remain finite and rigid");
    }
    puppet.setPose({});
    return ok;
}

QVariantMap namedPose(const QVariantMap &definition, const QString &name)
{
    const QVariantMap poses = definition.value(QStringLiteral("poses")).toMap();
    for (auto pose = poses.cbegin(); pose != poses.cend(); ++pose) {
        const QVariantMap value = pose.value().toMap();
        if (value.value(QStringLiteral("name")).toString() == name)
            return value.value(QStringLiteral("joints")).toMap();
    }
    return {};
}

bool transformIsRigid(const QVector<qreal> &transform)
{
    if (transform.size() != 6)
        return false;
    for (qreal value : transform) {
        if (!std::isfinite(value))
            return false;
    }
    const qreal firstLength = std::hypot(transform[0], transform[2]);
    const qreal secondLength = std::hypot(transform[1], transform[3]);
    const qreal dot = transform[0] * transform[1]
            + transform[2] * transform[3];
    return close(firstLength, 1.0) && close(secondLength, 1.0)
            && close(dot, 0.0);
}

bool armIsolationCheck(AvatarPuppet &puppet, const QVariantMap &basePose,
                       const QVariantMap &armChanges, const QString &label)
{
    puppet.setPose(basePose);
    const QVariantMap before = puppet.boneTransforms();
    QVariantMap changedPose = basePose;
    for (auto change = armChanges.cbegin(); change != armChanges.cend(); ++change)
        changedPose.insert(change.key(), change.value());
    puppet.setPose(changedPose);
    const QVariantMap after = puppet.boneTransforms();

    bool ok = true;
    ok &= check(sameMatrix(matrix(before, QStringLiteral("head")),
                           matrix(after, QStringLiteral("head"))),
                label + QStringLiteral(": arm channels changed the head matrix"));
    ok &= check(sameMatrix(matrix(before, QStringLiteral("hair")),
                           matrix(after, QStringLiteral("hair"))),
                label + QStringLiteral(": arm channels changed the hair matrix"));
    const bool leftChanged = !sameMatrix(
            matrix(before, QStringLiteral("leftUpperArm")),
            matrix(after, QStringLiteral("leftUpperArm")))
            || !sameMatrix(matrix(before, QStringLiteral("leftForearm")),
                           matrix(after, QStringLiteral("leftForearm")));
    const bool rightChanged = !sameMatrix(
            matrix(before, QStringLiteral("rightUpperArm")),
            matrix(after, QStringLiteral("rightUpperArm")))
            || !sameMatrix(matrix(before, QStringLiteral("rightForearm")),
                           matrix(after, QStringLiteral("rightForearm")));
    ok &= check(leftChanged && rightChanged,
                label + QStringLiteral(": arm changes did not reach both arm subtrees"));
    return ok;
}

bool productionDefinitionChecks(const QString &root, QVariantMap *definition,
                                QUrl *source)
{
    bool ok = true;
    QFile rigFile(root + QStringLiteral("/assets/cere-rig.json"));
    if (!check(rigFile.open(QIODevice::ReadOnly),
               QStringLiteral("production rig could not be opened at %1")
                       .arg(rigFile.fileName())))
        return false;
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(rigFile.readAll(), &parseError);
    if (!check(parseError.error == QJsonParseError::NoError && document.isObject(),
               QStringLiteral("production rig JSON is invalid: %1")
                       .arg(parseError.errorString())))
        return false;
    *definition = document.object().toVariantMap();

    const QString texture = definition->value(QStringLiteral("texture")).toString();
    const QString atlasPath = root + QStringLiteral("/assets/") + texture;
    const QImage atlas(atlasPath);
    ok &= check(!texture.isEmpty(),
                "production rig must declare its shipped puppet atlas");
    if (!check(!atlas.isNull(),
               QStringLiteral("production puppet atlas could not be decoded at %1")
                       .arg(atlasPath)))
        return false;
    *source = QUrl::fromLocalFile(atlasPath);

    const QVariantMap channels = definition->value(QStringLiteral("channels")).toMap();
    const QVariantList bones = definition->value(QStringLiteral("bones")).toList();
    const QVariantList parts = definition->value(QStringLiteral("parts")).toList();
    const QVariantMap poses = definition->value(QStringLiteral("poses")).toMap();
    ok &= check(!bones.isEmpty() && !parts.isEmpty() && poses.size() == 32,
                "production rig must contain bones, cutouts, and all 32 poses");

    QSet<QString> boneNames;
    for (const QVariant &boneValue : bones)
        boneNames.insert(boneValue.toMap().value(QStringLiteral("name")).toString());
    for (const QString &required : {QStringLiteral("root"), QStringLiteral("torso"),
                                    QStringLiteral("head"), QStringLiteral("hair"),
                                    QStringLiteral("leftUpperArm"),
                                    QStringLiteral("leftForearm"),
                                    QStringLiteral("rightUpperArm"),
                                    QStringLiteral("rightForearm")}) {
        ok &= check(boneNames.contains(required),
                    QStringLiteral("production skeleton is missing bone '%1'")
                            .arg(required));
    }
    for (const QVariant &boneValue : bones) {
        const QVariantMap boneMap = boneValue.toMap();
        const QString name = boneMap.value(QStringLiteral("name")).toString();
        const QString parent = boneMap.value(QStringLiteral("parent")).toString();
        ok &= check(!name.isEmpty() && (parent.isEmpty() || boneNames.contains(parent)),
                    QStringLiteral("production bone '%1' has an invalid parent").arg(name));
        for (const QString &field : {QStringLiteral("angle"), QStringLiteral("offsetX"),
                                     QStringLiteral("offsetY")}) {
            const QString channel = boneMap.value(field).toString();
            ok &= check(channel.isEmpty() || channels.contains(channel),
                        QStringLiteral("production bone '%1' uses undeclared channel '%2'")
                                .arg(name, channel));
        }
    }

    for (const QVariant &partValue : parts) {
        const QVariantMap partMap = partValue.toMap();
        const QString name = partMap.value(QStringLiteral("name")).toString();
        const QVariantList coordinates = partMap.value(QStringLiteral("sourceRect")).toList();
        QRect crop;
        if (coordinates.size() == 4) {
            crop = QRect(coordinates[0].toInt(), coordinates[1].toInt(),
                         coordinates[2].toInt(), coordinates[3].toInt());
        }
        ok &= check(boneNames.contains(partMap.value(QStringLiteral("bone")).toString()),
                    QStringLiteral("production part '%1' refers to an unknown bone")
                            .arg(name));
        ok &= check(coordinates.size() == 4 && crop.isValid()
                            && atlas.rect().contains(crop),
                    QStringLiteral("production part '%1' lies outside the atlas")
                            .arg(name));
        bool hasAlpha = false;
        if (atlas.rect().contains(crop)) {
            for (int y = crop.top(); y <= crop.bottom() && !hasAlpha; ++y) {
                for (int x = crop.left(); x <= crop.right(); ++x) {
                    if (qAlpha(atlas.pixel(x, y)) > 0) {
                        hasAlpha = true;
                        break;
                    }
                }
            }
        }
        ok &= check(hasAlpha,
                    QStringLiteral("production part '%1' has no visible atlas pixels")
                            .arg(name));
        const QString opacity = partMap.value(QStringLiteral("opacityChannel")).toString();
        const QString visibility = partMap.value(QStringLiteral("visibleWhen")).toMap()
                                           .value(QStringLiteral("channel")).toString();
        ok &= check((opacity.isEmpty() || channels.contains(opacity))
                            && (visibility.isEmpty() || channels.contains(visibility)),
                    QStringLiteral("production part '%1' uses an undeclared channel")
                            .arg(name));
    }

    for (auto pose = poses.cbegin(); pose != poses.cend(); ++pose) {
        const QVariantMap poseMap = pose.value().toMap();
        const QVariantMap joints = poseMap.value(QStringLiteral("joints")).toMap();
        for (auto joint = joints.cbegin(); joint != joints.cend(); ++joint) {
            bool numberOk = false;
            const qreal value = joint.value().toDouble(&numberOk);
            const QVariantMap limits = channels.value(joint.key()).toMap();
            const qreal minimum = limits.value(QStringLiteral("min")).toDouble();
            const qreal maximum = limits.value(QStringLiteral("max")).toDouble();
            ok &= check(channels.contains(joint.key()) && numberOk && std::isfinite(value)
                                && value >= minimum && value <= maximum,
                        QStringLiteral("production pose '%1' has invalid channel '%2'")
                                .arg(pose.key(), joint.key()));
        }
    }

    AvatarPuppet puppet;
    puppet.setSource(*source);
    puppet.setDefinition(*definition);
    ok &= check(puppet.ready() && puppet.error().isEmpty(),
                QStringLiteral("production rig failed renderer validation: %1")
                        .arg(puppet.error()));
    const QVariantMap transforms = puppet.boneTransforms();
    ok &= check(transforms.size() == bones.size(),
                "production skeleton did not produce one transform per bone");
    for (auto transform = transforms.cbegin(); transform != transforms.cend(); ++transform)
        ok &= check(transformIsRigid(matrix(transforms, transform.key())),
                    QStringLiteral("production bone '%1' is not rigid").arg(transform.key()));

    const QVariantMap armExtreme{{QStringLiteral("leftArm"), 150.0},
                                 {QStringLiteral("leftElbow"), -155.0},
                                 {QStringLiteral("rightArm"), -150.0},
                                 {QStringLiteral("rightElbow"), 155.0}};
    const QVariantMap wave = namedPose(*definition, QStringLiteral("wave"));
    const QVariantMap thinking = namedPose(*definition, QStringLiteral("thinking"));
    ok &= check(!wave.isEmpty() && !thinking.isEmpty(),
                "production wave and thinking poses must exist");
    ok &= armIsolationCheck(puppet, wave, armExtreme, QStringLiteral("production wave"));
    ok &= armIsolationCheck(puppet, thinking, armExtreme,
                            QStringLiteral("production thinking"));
    const QVariantMap extremeBase{{QStringLiteral("bodyTilt"), 4.0},
                                  {QStringLiteral("hipX"), 2.5},
                                  {QStringLiteral("breathLift"), -2.0},
                                  {QStringLiteral("headTilt"), 9.0},
                                  {QStringLiteral("headX"), 3.0},
                                  {QStringLiteral("headY"), -3.0},
                                  {QStringLiteral("hairRotation"), 2.0}};
    ok &= armIsolationCheck(puppet, extremeBase, armExtreme,
                            QStringLiteral("production extreme pose"));
    return ok;
}

bool productionRenderChecks(const QUrl &source, const QVariantMap &definition)
{
    bool ok = true;
    QQuickWindow window;
    window.setColor(Qt::transparent);
    window.resize(192, 208);
    AvatarPuppet puppet(window.contentItem());
    puppet.setSize(QSizeF(192, 208));
    puppet.setSource(source);
    puppet.setDefinition(definition);
    puppet.setPose(namedPose(definition, QStringLiteral("wave")));
    ok &= check(puppet.ready(), "production puppet must be ready before rendering");
    const QImage wave = synchronizedGrab(window);
    int opaquePixels = 0;
    for (int y = 0; y < wave.height(); ++y) {
        for (int x = 0; x < wave.width(); ++x)
            opaquePixels += qAlpha(wave.pixel(x, y)) >= 250;
    }
    ok &= check(!wave.isNull() && opaquePixels > 3000,
                QStringLiteral("production wave render has only %1 opaque pixels")
                        .arg(opaquePixels));

    puppet.setPose(namedPose(definition, QStringLiteral("thinking")));
    const QImage thinking = synchronizedGrab(window);
    ok &= check(!thinking.isNull() && thinking != wave,
                "production thinking pose must repaint differently from wave");
    window.hide();
    return ok;
}

bool motionRenderChecks(const QString &root,const QUrl &source,const QVariantMap &definition)
{
    QFile file(root+"/assets/motions.json"),script(root+"/qml/Motion.js");
    if(!file.open(QIODevice::ReadOnly)||!script.open(QIODevice::ReadOnly))return false;
    auto catalog=QJsonDocument::fromJson(file.readAll()).object().toVariantMap();catalog["puppet"]=definition;
    QJSEngine engine;QString code=QString::fromUtf8(script.readAll());code.remove(".pragma library");
    if(!check(!engine.evaluate(code).isError(),"motion sampler must load"))return false;
    auto global=engine.globalObject();const auto jsCatalog=engine.toScriptValue(catalog);
    const auto profiles=catalog.value("idleProfiles").toMap();const auto calm=profiles.value("calm").toMap().value("pool").toList();
    auto lively=profiles.value("lively").toMap().value("pool").toList();
    for(const auto &name:calm)lively.removeAll(name);
    QQuickWindow window;window.setColor(Qt::transparent);window.resize(192,208);
    QQuickItem artwork(window.contentItem());artwork.setSize({192,208});
    AvatarPuppet puppet(&artwork);puppet.setSize({192,208});puppet.setSource(source);puppet.setDefinition(definition);
    QImage sheet(192*8,232*lively.size(),QImage::Format_ARGB32);sheet.fill(QColor("#152331"));QPainter painter(&sheet);
    bool ok=true;int row=0;
    for(const auto &entry:lively){
        const auto name=entry.toString();const auto clip=catalog.value("clips").toMap().value(name).toMap();
        double duration=clip.value("entryMs").toDouble();for(const auto &key:clip.value("keys").toList())duration+=key.toMap().value("ms").toDouble();
        auto state=global.property("create").call({19});
        global.property("select").call({state,engine.toScriptValue(clip),jsCatalog,name});
        painter.setPen(Qt::white);painter.drawText(4,row*232+17,name);
        int tick=0;
        for(int frame=0;frame<8;++frame){
            const int until=qRound(duration/1000*120*(frame+1)/8);QJSValue sample;
            while(tick++<until)sample=global.property("sample").call({state,1.0/120,.7,0,0,0,0,false});
            --tick;
            ok &= check(!sample.isError(),"new clip sample must succeed");
            artwork.setY(sample.property("y").toNumber());
            puppet.setPose(sample.toVariant().toMap());const auto rendered=synchronizedGrab(window);
            ok &= check(!rendered.isNull(),"each new clip must render throughout its timeline");
            int opaque=0;for(int y=0;y<rendered.height();++y)for(int x=0;x<rendered.width();++x)opaque+=qAlpha(rendered.pixel(x,y))>200;
            ok &= check(opaque>3000,"new clip artwork must remain visible in every captured frame");
            painter.drawImage(frame*192,row*232+24,rendered);
        }
        ++row;
    }
    painter.end();QDir().mkpath("/tmp/cere-motion-evidence");
    const auto backend=window.rendererInterface()->graphicsApi()==QSGRendererInterface::Software?"software":"opengl";
    ok &= check(sheet.save(QString("/tmp/cere-motion-evidence/clips-%1.png").arg(backend)),"new clip contact sheet must save");
    window.hide();return ok;
}

bool malformedChecks(const QUrl &source)
{
    bool ok = true;
    const auto rejects = [&](const QVariantMap &definition, const char *message) {
        AvatarPuppet puppet;
        puppet.setSource(source);
        puppet.setDefinition(definition);
        return check(!puppet.ready() && !puppet.error().isEmpty(), message);
    };

    QVariantMap cycle = validDefinition();
    cycle.insert(QStringLiteral("bones"),
                 QVariantList{bone(QStringLiteral("a"), QStringLiteral("b"), 0, 0),
                              bone(QStringLiteral("b"), QStringLiteral("a"), 0, 0)});
    QVariantMap cyclePart = part(QStringLiteral("p"), QStringLiteral("a"), 0,
                                 QVariantList{0, 0, 8, 8}, 0);
    cycle.insert(QStringLiteral("parts"), QVariantList{cyclePart});
    ok &= rejects(cycle, "cyclic bone definitions must be rejected safely");

    QVariantMap unknown = validDefinition();
    unknown.insert(QStringLiteral("bones"),
                   QVariantList{bone(QStringLiteral("root"), QStringLiteral("missing"),
                                     0, 0)});
    ok &= rejects(unknown, "unknown bone parents must be rejected safely");

    QVariantMap duplicate = validDefinition();
    duplicate.insert(QStringLiteral("bones"),
                     QVariantList{bone(QStringLiteral("root"), {}, 0, 0),
                                  bone(QStringLiteral("root"), {}, 1, 1)});
    ok &= rejects(duplicate, "duplicate bones must be rejected safely");

    QVariantMap outside = validDefinition();
    QVariantList parts = outside.value(QStringLiteral("parts")).toList();
    QVariantMap first = parts.first().toMap();
    first.insert(QStringLiteral("sourceRect"), QVariantList{95, 0, 16, 16});
    parts[0] = first;
    outside.insert(QStringLiteral("parts"), parts);
    ok &= rejects(outside, "out-of-atlas cutouts must be rejected safely");
    return ok;
}

bool renderChecks(const QUrl &source)
{
    bool ok = true;
    QQuickWindow window;
    window.setColor(Qt::transparent);
    window.resize(128, 96);
    AvatarPuppet puppet(window.contentItem());
    puppet.setSize(QSizeF(128, 96));
    puppet.setSource(source);
    puppet.setDefinition(validDefinition());
    ok &= check(puppet.ready() && puppet.error().isEmpty(),
                "valid puppet source and definition must become ready");

    const QImage rest = synchronizedGrab(window);
    int visible = 0;
    for (int y = 0; y < rest.height(); ++y) {
        for (int x = 0; x < rest.width(); ++x)
            visible += qAlpha(rest.pixel(x, y)) > 0;
    }
    ok &= check(!rest.isNull() && visible > 500,
                "layered puppet must render non-empty on the selected backend");

    // Reference (32,30) maps to display (64,45). Opaque head is above opaque
    // torso and hair there. Fading another opaque overlay over it must keep
    // normal source-over alpha and cannot additively brighten the color.
    const QColor uncovered = rest.pixelColor(64, 45);
    ok &= check(uncovered.red() > 200 && uncovered.green() > 150
                        && uncovered.blue() < 80,
                "stable z sorting must place the head above back hair and torso");
    puppet.setPose({{QStringLiteral("blink"), 0.5},
                    {QStringLiteral("leftHandOpen"), 1.0}});
    const QImage blink = synchronizedGrab(window);
    const QColor covered = blink.pixelColor(64, 45);
    ok &= check(uncovered.alpha() >= 254 && covered.alpha() >= 254,
                "overlapping opaque puppet parts must retain opaque alpha");
    ok &= check(covered.red() <= uncovered.red()
                        && covered.green() <= uncovered.green()
                        && covered.blue() <= uncovered.blue(),
                "part overlap must source-over rather than brighten additively");
    ok &= check(blink != rest, "opacity and visibility channels must repaint");

    for (int step = 0; step < 120; ++step) {
        puppet.setPose({{QStringLiteral("leftArm"), qreal(step % 61 - 30)},
                        {QStringLiteral("leftElbow"), qreal(30 - step % 61)},
                        {QStringLiteral("hairRotation"), qreal(step % 19 - 9)},
                        {QStringLiteral("blink"), qreal(step % 10) / 10.0}});
        QCoreApplication::processEvents(QEventLoop::AllEvents, 1);
    }
    const QImage updated = synchronizedGrab(window);
    ok &= check(!updated.isNull() && updated != rest,
                "repeated rigid pose updates must remain live");

    puppet.setSource(QUrl::fromLocalFile(source.toLocalFile() + QStringLiteral(".missing")));
    ok &= check(!puppet.ready() && !puppet.error().isEmpty(),
                "missing replacement source must clear readiness safely");
    puppet.setSource(source);
    ok &= check(puppet.ready(), "restoring a cached source must restore readiness");
    ok &= check(!synchronizedGrab(window).isNull(),
                "textures must rebuild after source invalidation");

    std::cout << "avatarpuppet graphics API "
              << int(window.rendererInterface()->graphicsApi()) << '\n';
    window.hide();
    return ok;
}

} // namespace

int main(int argc, char **argv)
{
    if (qEnvironmentVariableIsSet("CERE_PUPPET_TEST_SOFTWARE"))
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    else
        QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);
    QGuiApplication application(argc, argv);

    QTemporaryDir directory(QStringLiteral("/tmp/cere-avatarpuppet-XXXXXX"));
    if (!check(directory.isValid(), "temporary fixture directory must be created"))
        return 1;
    const QString atlasPath = directory.filePath(QStringLiteral("atlas.png"));
    if (!check(makeAtlas().save(atlasPath), "generated cutout atlas must be saved"))
        return 1;
    const QUrl source = QUrl::fromLocalFile(atlasPath);

    AvatarPuppet puppet;
    puppet.setSource(source);
    puppet.setDefinition(validDefinition());
    bool ok = check(puppet.ready(), "valid child-first skeleton must parse")
            && skeletonChecks(puppet)
            && malformedChecks(source)
            && renderChecks(source);
    const QString root = argc > 1 ? QString::fromLocal8Bit(argv[1])
                                  : QStringLiteral(".");
    QVariantMap productionDefinition;
    QUrl productionSource;
    const bool productionOk = productionDefinitionChecks(
            root, &productionDefinition, &productionSource);
    ok &= productionOk;
    if (productionOk)
        ok &= productionRenderChecks(productionSource, productionDefinition)
            && motionRenderChecks(root,productionSource,productionDefinition);
    return ok ? 0 : 1;
}
