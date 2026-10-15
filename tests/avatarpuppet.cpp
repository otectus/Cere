#include "avatarpuppet.h"
#include "avatardefinition.h"
#include "avatarskeleton.h"
#include "referenceart.h"

#include <QColor>
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QGuiApplication>
#include <QImage>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
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
    // Off canvas unless its fixed rotation turns it about the root origin:
    // (x, y) -> (-y, x) lands this bar at reference x 54..58, y 2..14.
    QVariantMap rotated = part(QStringLiteral("rotatedArt"), QStringLiteral("root"), 1,
                               QVariantList{2, -58, 12, 4}, 6);
    rotated.insert(QStringLiteral("rotation"), 90);

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
        openHand,
        rotated
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

QImage makeSurfaceAtlas(const QColor &bodyColor)
{
    QImage atlas(96, 32, QImage::Format_ARGB32_Premultiplied);
    atlas.fill(Qt::transparent);
    QPainter painter(&atlas);
    painter.setRenderHint(QPainter::Antialiasing, false);
    painter.setPen(Qt::NoPen);
    painter.setBrush(bodyColor);
    painter.drawRoundedRect(QRectF(6, 2, 20, 27), 5, 5);
    painter.setBrush(QColor(245, 245, 235));
    painter.drawRect(10, 8, 12, 4);
    painter.setBrush(QColor(30, 45, 65));
    painter.drawRect(12, 9, 2, 2);
    painter.drawRect(18, 9, 2, 2);
    painter.end();
    // The second frame differs only over the synthetic eyes.
    const QImage openFrame = atlas.copy(0, 0, 32, 32);
    QPainter closed(&atlas);
    closed.drawImage(QPoint(32, 0), openFrame);
    closed.fillRect(QRect(10 + 32, 8, 12, 4), QColor(245, 245, 235));
    closed.fillRect(QRect(12 + 32, 10, 2, 1), QColor(30, 45, 65));
    closed.fillRect(QRect(18 + 32, 10, 2, 1), QColor(30, 45, 65));
    // A half-resolution posed frame and matching blink frame.
    closed.setBrush(bodyColor.darker(145));
    closed.setPen(Qt::NoPen);
    closed.drawRoundedRect(QRectF(67, 1, 10, 14), 3, 3);
    closed.fillRect(QRect(69, 4, 6, 3), QColor(245, 245, 235));
    closed.fillRect(QRect(70, 5, 1, 1), QColor(30, 45, 65));
    closed.fillRect(QRect(73, 5, 1, 1), QColor(30, 45, 65));
    closed.end();
    const QImage posedOpen = atlas.copy(64, 0, 16, 16);
    QPainter posedFrames(&atlas);
    posedFrames.drawImage(QPoint(80, 0), posedOpen);
    posedFrames.fillRect(QRect(69 + 16, 4, 6, 3), QColor(245, 245, 235));
    posedFrames.fillRect(QRect(70 + 16, 6, 1, 1), QColor(30, 45, 65));
    posedFrames.fillRect(QRect(73 + 16, 6, 1, 1), QColor(30, 45, 65));
    // This frame deliberately has no blinkSourceRect.
    posedFrames.setBrush(bodyColor.lighter(145));
    posedFrames.drawRoundedRect(QRectF(67, 17, 10, 14), 3, 3);
    posedFrames.fillRect(QRect(69, 20, 6, 3), QColor(245, 245, 235));
    posedFrames.fillRect(QRect(70, 21, 1, 1), QColor(30, 45, 65));
    posedFrames.fillRect(QRect(73, 21, 1, 1), QColor(30, 45, 65));
    return atlas;
}

QVariantMap surfaceDefinition()
{
    return {{QStringLiteral("version"), 1},
            {QStringLiteral("referenceSize"), QVariantList{32, 32}},
            {QStringLiteral("bones"), QVariantList{
                 bone(QStringLiteral("root"), {}, 0, 0)}},
            {QStringLiteral("parts"), QVariantList{QVariantMap{
                 {QStringLiteral("name"), QStringLiteral("reference")},
                 {QStringLiteral("bone"), QStringLiteral("root")},
                 {QStringLiteral("sourceRect"), QVariantList{0, 0, 32, 32}},
                 {QStringLiteral("blinkSourceRect"), QVariantList{32, 0, 32, 32}},
                 {QStringLiteral("rect"), QVariantList{0, 0, 32, 32}},
                 {QStringLiteral("surfaceMotion"), true},
                 {QStringLiteral("surfaceFrames"), QVariantList{
                      QVariantMap{{QStringLiteral("sourceRect"),
                                   QVariantList{64, 0, 16, 16}},
                                  {QStringLiteral("blinkSourceRect"),
                                   QVariantList{80, 0, 16, 16}}},
                      QVariantMap{{QStringLiteral("sourceRect"),
                                   QVariantList{64, 16, 16, 16}}}}}}}}};
}

bool referenceSurfaceImageChecks()
{
    bool ok = true;
    const QImage atlas = makeSurfaceAtlas(QColor(105, 165, 225));
    const QImage open = atlas.copy(0, 0, 32, 32);
    const QImage closed = atlas.copy(32, 0, 32, 32);
    const QRectF rect(0, 0, 32, 32);

    const QImage identity = ReferenceArt::render(open, closed, rect, {});
    ok &= check(identity.constBits() == open.constBits() && identity == open,
                "zero surface pose must reuse the exact unwarped source image");

    ReferenceArt::Pose blink;
    blink.blink = 0.5;
    const QImage halfClosed = ReferenceArt::render(open, closed, rect, blink);
    int changedInside = 0;
    int changedOutside = 0;
    for (int y = 0; y < open.height(); ++y) {
        for (int x = 0; x < open.width(); ++x) {
            if (open.pixel(x, y) == halfClosed.pixel(x, y))
                continue;
            if (QRect(10, 8, 12, 4).contains(x, y))
                ++changedInside;
            else
                ++changedOutside;
        }
    }
    ok &= check(changedInside > 0 && changedOutside == 0,
                "surface blink blend must change only the eye region");

    ReferenceArt::Pose extreme;
    extreme.breathLift = -2;
    extreme.bodyTilt = 4;
    extreme.headTilt = -9;
    extreme.headX = 3;
    extreme.headY = -3;
    extreme.hipX = 2.5;
    extreme.hipDrop = 3;
    extreme.hairRotation = 2;
    extreme.blink = 0.7;
    qreal largest = 0.0;
    qreal sharpestStep = 0.0;
    for (int y = 0; y <= 32; ++y) {
        QPointF previous;
        for (int x = 0; x <= 32; ++x) {
            const QPointF displacement = ReferenceArt::displacement({qreal(x), qreal(y)},
                                                                     rect, extreme);
            largest = std::max(largest, std::hypot(displacement.x(), displacement.y()));
            if (x > 0)
                sharpestStep = std::max(sharpestStep,
                                        std::hypot(displacement.x() - previous.x(),
                                                   displacement.y() - previous.y()));
            previous = displacement;
        }
    }
    ok &= check(largest <= 1.900001 && sharpestStep < 0.12,
                "surface displacement must stay bounded and spatially smooth");
    for (int x = 0; x <= 32; ++x)
        ok &= check(std::hypot(ReferenceArt::displacement({qreal(x), 32}, rect,
                                                          extreme).x(),
                               ReferenceArt::displacement({qreal(x), 32}, rect,
                                                          extreme).y()) < 0.000001,
                    "surface deformation must pin every sole coordinate");

    const QImage moved = ReferenceArt::render(open, closed, rect, extreme);
    QRect alphaBounds;
    bool hasFilteredBoundary = false;
    bool premultiplied = true;
    for (int y = 0; y < moved.height(); ++y) {
        for (int x = 0; x < moved.width(); ++x) {
            const QRgb pixel = moved.pixel(x, y);
            if (qAlpha(pixel) > 0)
                alphaBounds |= QRect(x, y, 1, 1);
            hasFilteredBoundary |= qAlpha(pixel) > 0 && qAlpha(pixel) < 255;
            premultiplied &= qRed(pixel) <= qAlpha(pixel)
                    && qGreen(pixel) <= qAlpha(pixel)
                    && qBlue(pixel) <= qAlpha(pixel);
        }
    }
    ok &= check(moved.size() == open.size() && moved != open
                        && alphaBounds.left() > 0 && alphaBounds.top() > 0
                        && alphaBounds.right() < moved.width() - 1
                        && alphaBounds.bottom() < moved.height() - 1,
                "deformed surface must retain dimensions and alpha margin without clipping");
    ok &= check(hasFilteredBoundary && premultiplied,
                "surface bilinear filtering must preserve a premultiplied alpha boundary");
    return ok;
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
    // Offscreen OpenGL on this NVIDIA stack can keep a new window's first
    // surface size and read back only part of each frame until the window is
    // resized; settle it once with a one-pixel resize.
    if (!window.property("cereSettled").toBool()) {
        window.setProperty("cereSettled", true);
        const QSize size = window.size();
        window.resize(size + QSize(1, 1));
        QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
        window.resize(size);
        QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
    }
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
                                QUrl *source, const QString &overrideFile = {})
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
    QVariantMap artwork;
    if (!overrideFile.isEmpty()) {
        QFile file(root + "/assets/" + overrideFile);
        if (!check(file.open(QIODevice::ReadOnly), "avatar override must open")) return false;
        const auto overrides = QJsonDocument::fromJson(file.readAll(), &parseError);
        if (!check(parseError.error == QJsonParseError::NoError && overrides.isObject(), "avatar override must be an object")) return false;
        artwork = overrides.object().toVariantMap();
    }
    const auto resolved = AvatarDefinition::resolve(*definition, artwork);
    if (!check(resolved.error.isEmpty(), resolved.error)) return false;
    // Resolution is shared with the real catalog loader, and is idempotent.
    // Head/face cutouts must keep their exact authored geometry while the
    // skeleton and body cutouts adopt the common grounded proportions.
    ok &= check(AvatarDefinition::resolve(resolved.definition).definition == resolved.definition,
                "resolving an avatar twice must not shrink it twice");
    const auto rawParts = artwork.value("parts", definition->value("parts")).toList();
    const auto resolvedParts = resolved.definition.value("parts").toList();
    for (int i = 0; i < rawParts.size(); ++i) {
        const auto raw = rawParts[i].toMap(), adjusted = resolvedParts[i].toMap();
        if (raw.value("bone") == "head" || raw.value("bone") == "hair")
            ok &= check(raw == adjusted, "proportion changes must preserve faces and hair exactly");
    }
    const auto badOverride = AvatarDefinition::resolve(*definition,
        {{"boneOverrides", QVariantMap{{"missing", QVariantMap{{"x", 1}}}}}});
    ok &= check(!badOverride.error.isEmpty(), "unknown joint registrations must fail visibly");
    const auto badHierarchy = AvatarDefinition::resolve(*definition,
        {{"boneOverrides", QVariantMap{{"head", QVariantMap{{"parent", "hips"}}}}}});
    ok &= check(!badHierarchy.error.isEmpty(), "artwork registrations cannot replace the shared hierarchy");
    const auto badProportions = AvatarDefinition::resolve(*definition, {{"proportions", "invalid"}});
    ok &= check(!badProportions.error.isEmpty(), "malformed proportion profiles must fail visibly");
    const auto shearedPart = AvatarDefinition::resolve(*definition,
        {{"proportions", QVariantMap{{"bodyWidth", 1.1}, {"bodyHeight", .84}, {"centerX", 96},
                                     {"groundY", 199.8}, {"headBone", "head"}}},
         {"parts", QVariantList{QVariantMap{{"name", "turned"}, {"bone", "torso"},
                                            {"sourceRect", QVariantList{0, 0, 8, 8}},
                                            {"rect", QVariantList{0, 0, 8, 8}}, {"rotation", 12}}}}});
    ok &= check(!shearedPart.error.isEmpty(), "unequal proportions must not shear a rotated cutout");
    // Painted cutouts keep their drawn aspect ratio; registration may move,
    // scale and turn a piece, never squash it. The old shared profile
    // stretched limbs by up to 1.8x and made every joint read as broken.
    for (const auto &value : resolved.definition.value("parts").toList()) {
        const auto part = value.toMap();
        const auto source = part.value("sourceRect").toList(), rect = part.value("rect").toList();
        if (source.size() != 4 || rect.size() != 4) continue;
        const qreal aspect = (rect[2].toDouble() / source[2].toDouble())
                / (rect[3].toDouble() / source[3].toDouble());
        ok &= check(std::abs(aspect - 1) <= .025,
                    QStringLiteral("%1 %2 is stretched %3x").arg(overrideFile, part.value("name").toString())
                            .arg(aspect));
    }
    *definition = resolved.definition;

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

    int surfacePartCount = 0;
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
        if (partMap.value(QStringLiteral("surfaceMotion")).toBool()) {
            ++surfacePartCount;
            const QVariantList blinkCoordinates = partMap.value(
                    QStringLiteral("blinkSourceRect")).toList();
            QRect blinkCrop;
            if (blinkCoordinates.size() == 4) {
                blinkCrop = QRect(blinkCoordinates[0].toInt(), blinkCoordinates[1].toInt(),
                                  blinkCoordinates[2].toInt(), blinkCoordinates[3].toInt());
            }
            ok &= check(partMap.value(QStringLiteral("bone")).toString()
                                == QStringLiteral("root"),
                        "connected surface artwork must attach to the root bone");
            ok &= check(blinkCrop.isValid() && atlas.rect().contains(blinkCrop)
                                && blinkCrop.size() == crop.size(),
                        "connected surface artwork must provide an in-atlas matching blink frame");
        }
    }
    ok &= check(surfacePartCount == 1 && parts.size() == 1,
                "every selectable avatar must use one connected full-body surface");
    if (surfacePartCount == 1 && parts.size() == 1) {
        ok &= check(definition->value(QStringLiteral("presentation")).toString()
                            == QStringLiteral("reference"),
                    "connected avatar artwork must use reference presentation");
        const QVariantMap surfacePart = parts.first().toMap();
        const QVariantList surfaceFrames = surfacePart.value(
                QStringLiteral("surfaceFrames")).toList();
        const QVariantMap surfaceSequences = definition->value(
                QStringLiteral("surfaceSequences")).toMap();
        const QVariantMap routes = surfaceSequences.value(QStringLiteral("routes")).toMap();
        const QVariantMap motions = surfaceSequences.value(QStringLiteral("motions")).toMap();
        const QMap<QString, QStringList> requiredRoutes{
            {QStringLiteral("wave"), QStringList{QStringLiteral("wave")}},
            {QStringLiteral("thinking"), QStringList{QStringLiteral("thinking")}},
            {QStringLiteral("present"), QStringList{QStringLiteral("explainOpen")}},
            {QStringLiteral("celebrate"), QStringList{QStringLiteral("celebrate")}},
            {QStringLiteral("shy"), QStringList{QStringLiteral("shy"), QStringLiteral("blush"), QStringLiteral("hoverBlush"), QStringLiteral("clickBlush")}},
            {QStringLiteral("carry"), QStringList{QStringLiteral("dragging")}}
        };
        for (auto route = requiredRoutes.cbegin(); route != requiredRoutes.cend(); ++route) {
            const QVariantMap sequence = routes.value(route.key()).toMap();
            const QVariantList frames = sequence.value(QStringLiteral("frames")).toList();
            bool frameIdsValid = frames.size() >= 30 && !frames.isEmpty()
                    && frames.first().toInt() == 0;
            for (const QVariant &frameValue : frames) {
                bool idOk = false;
                const int frame = frameValue.toInt(&idOk);
                frameIdsValid &= idOk && frame >= 0 && frame <= surfaceFrames.size();
            }
            ok &= check(frameIdsValid,
                        QStringLiteral("connected %1 route must contain dense valid frame IDs")
                                .arg(route.key()));
            bool timingOk = false;
            const qreal frameMs = sequence.value(QStringLiteral("frameMs")).toDouble(&timingOk);
            ok &= check(timingOk && frameMs > 0 && frameMs <= 17.0,
                        QStringLiteral("connected %1 route must animate at approximately 60 Hz")
                                .arg(route.key()));
            for (const QString &motion : route.value())
                ok &= check(motions.value(motion).toString() == route.key(),
                            QStringLiteral("motion '%1' must select the connected %2 route")
                                    .arg(motion, route.key()));
            if (!frames.isEmpty()) {
                const int endpoint = frames.last().toInt();
                const QVariantMap endpointFrame = endpoint == 0
                        ? surfacePart : surfaceFrames.value(endpoint - 1).toMap();
                ok &= check(endpointFrame.value(QStringLiteral("blinkSourceRect")).toList().size() == 4,
                            QStringLiteral("connected %1 endpoint must provide a blink frame")
                                    .arg(route.key()));
            }
        }
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
    const auto headOrigin = origin(matrix(transforms, "head"));
    const auto hipOrigin = origin(matrix(transforms, "hips"));
    ok &= check(close(headOrigin.x(), 96) && headOrigin.y() > 94 && headOrigin.y() < 103,
                "all avatars must share the compact head attachment and center line");
    ok &= check(hipOrigin.y() - headOrigin.y() < 42,
                "the compact torso must not regress to the elongated silhouette");
    ok &= check(transforms.size() == bones.size(),
                "production skeleton did not produce one transform per bone");
    for (auto transform = transforms.cbegin(); transform != transforms.cend(); ++transform)
        ok &= check(transformIsRigid(matrix(transforms, transform.key())),
                    QStringLiteral("production bone '%1' is not rigid").arg(transform.key()));

    // A stance change carries the entire body through one pelvis attachment.
    // Moving only the legs/hip artwork pulls the waistband away from the torso.
    puppet.setPose({{QStringLiteral("hipX"), 2.5}, {QStringLiteral("hipDrop"), 3.0}});
    const auto shifted = puppet.boneTransforms();
    for (const QString &name : {QStringLiteral("torso"), QStringLiteral("head"),
                                QStringLiteral("leftThigh"), QStringLiteral("rightThigh"),
                                QStringLiteral("leftShin"), QStringLiteral("rightShin")}) {
        const auto delta = origin(matrix(shifted, name)) - origin(matrix(transforms, name));
        ok &= check(close(delta.x(), 2.5) && close(delta.y(), 3.0),
                    QStringLiteral("production %1 must follow hip motion").arg(name));
    }
    puppet.setPose({});

    if (surfacePartCount == 0) {
    // Joint pivots need painted overlap on both adjoining pieces. A valid
    // rectangle alone can still put the knee/elbow in transparent atlas space.
    QMap<QString, QVariantMap> partByName, boneByName;
    for (const auto &value : parts) {
        const auto part = value.toMap();
        partByName.insert(part.value("name").toString(), part);
    }
    for (const auto &value : bones) {
        const auto bone = value.toMap();
        boneByName.insert(bone.value("name").toString(), bone);
    }
    for (const QString &side : {QStringLiteral("left"), QStringLiteral("right")}) {
        const auto boot = partByName.value(side + "Boot");
        const auto rect = boot.value("rect").toList();
        const auto transform = matrix(transforms, side + "Shin");
        const qreal soleY = transform[3] * (rect[1].toDouble() + rect[3].toDouble()) + transform[5];
        ok &= check(close(soleY, 199.8), "both feet must retain the common ground anchor");
    }
    const auto paintedAt = [&](const QString &name, const QPointF &bonePoint) {
        const auto part = partByName.value(name);
        const auto sourceRect = part.value("sourceRect").toList();
        const auto rect = part.value("rect").toList();
        if (sourceRect.size() != 4 || rect.size() != 4) return false;
        // A part's fixed rotation sits between its rect and its bone.
        const QPointF point = AvatarSkeleton::rotation(-part.value("rotation").toDouble())
                .map(bonePoint);
        qreal u = (point.x() - rect[0].toDouble()) / rect[2].toDouble();
        const qreal v = (point.y() - rect[1].toDouble()) / rect[3].toDouble();
        if (part.value("mirrorX").toBool()) u = 1 - u;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
        const QPoint pixel(sourceRect[0].toInt() + int(u * sourceRect[2].toInt()),
                           sourceRect[1].toInt() + int(v * sourceRect[3].toInt()));
        return atlas.rect().contains(pixel) && qAlpha(atlas.pixel(pixel)) >= 200;
    };
    const auto paintedJoint = [&](const QString &name, const QPointF &joint) {
        for (const QPointF &offset : {QPointF(), QPointF(-1, 0), QPointF(1, 0),
                                      QPointF(0, -1), QPointF(0, 1)}) {
            if (!paintedAt(name, joint + offset)) return false;
        }
        return true;
    };
    for (const QString &side : {QStringLiteral("left"), QStringLiteral("right")}) {
        for (const auto &joint : {qMakePair(QStringLiteral("Thigh"), QStringLiteral("Shin")),
                                  qMakePair(QStringLiteral("Sleeve"), QStringLiteral("Forearm"))}) {
            const auto child = boneByName.value(side + joint.second);
            ok &= check(paintedJoint(side + joint.first, {})
                        && paintedJoint(side + joint.first, {child.value("x").toDouble(), child.value("y").toDouble()}),
                        QStringLiteral("production %1%2 must cover both joint pivots").arg(side, joint.first));
        }
        for (const QString &part : {QStringLiteral("Boot"), QStringLiteral("Hand"), QStringLiteral("Palm")})
            ok &= check(paintedJoint(side + part, {}),
                        QStringLiteral("production %1%2 must cover its attachment pivot").arg(side, part));
    }

    // Scan the painted outline across the visible waist join, not just its
    // rectangle. The former generic hip placement made every outfit pinch
    // inward again below the flared torso (by up to nine reference pixels on
    // either side). A torso drawn over the hips joins at its own hem; a
    // waistband drawn over the midriff joins at the waistband's top edge, so
    // the outline must not narrow again just below that edge.
    const auto torsoRect = partByName.value("torso").value("rect").toList();
    const auto hipsRect = partByName.value("hips").value("rect").toList();
    const bool waistbandOver = partByName.value("hips").value("z").toDouble()
            > partByName.value("torso").value("z").toDouble();
    qreal from = 0, to = 0;
    if (waistbandOver) {
        qreal top = hipsRect[1].toDouble() + hipsRect[3].toDouble();
        for (qreal y = hipsRect[1].toDouble(); y < top; y += .25)
            if (paintedAt("hips", {0, y})) top = y;
        from = top - .5;
        to = top + 6;
    } else {
        qreal hem = torsoRect[1].toDouble();
        for (qreal y = hem; y < torsoRect[1].toDouble() + torsoRect[3].toDouble(); y += .25)
            if (paintedAt("torso", {0, y})) hem = y + .25;
        from = hem - 6;
        to = hem + .5;
    }
    qreal widestLeft = 0, widestRight = 0, worstPinch = 0;
    for (qreal y = from; y <= to; y += .25) {
        // The body's outline is the painted run through the centre line; a
        // chain hanging beside the waist is not part of the hips.
        const auto painted = [&](qreal x) {
            return paintedAt("torso", {x, y}) || paintedAt("hips", {x, y});
        };
        qreal left = 0, right = 0;
        while (left > -40 && painted(left - .25)) left -= .25;
        while (right < 40 && painted(right + .25)) right += .25;
        worstPinch = std::max({worstPinch, left - widestLeft, widestRight - right});
        widestLeft = std::min(widestLeft, left);
        widestRight = std::max(widestRight, right);
    }
    ok &= check(worstPinch <= 1.5,
                QStringLiteral("%1 waist must join the hips without a second pinch (got %2 px)")
                    .arg(texture).arg(worstPinch));

    const auto mapPoint = [](const QVector<qreal> &t, const QPointF &p) {
        return QPointF(t[0] * p.x() + t[1] * p.y() + t[4],
                       t[2] * p.x() + t[3] * p.y() + t[5]);
    };
    const auto unmapPoint = [](const QVector<qreal> &t, const QPointF &p) {
        const auto delta = p - origin(t);
        return QPointF(t[0] * delta.x() + t[2] * delta.y(),
                       t[1] * delta.x() + t[3] * delta.y());
    };
    for (const qreal tilt : {-4., 4.}) {
        for (const qreal breath : {-2., 2.}) {
            for (const qreal leg : {-22., 22.}) {
                puppet.setPose({{"bodyTilt", tilt}, {"breathLift", breath},
                                {"hipDrop", 3}, {"hipX", -2.5},
                                {"leftLeg", leg}, {"rightLeg", -leg}});
                const auto moving = puppet.boneTransforms();
                const auto torso = matrix(moving, partByName.value("torso").value("bone").toString());
                const auto hips = matrix(moving, partByName.value("hips").value("bone").toString());
                ok &= check(sameMatrix(torso, hips),
                            "overlapping waist artwork must stay together during tilt and breathing");
                for (const QString &side : {QStringLiteral("left"), QStringLiteral("right")}) {
                    const auto thigh = matrix(moving, side + "Thigh");
                    int overlap = 0;
                    for (qreal y = -2; y <= 4; y += .5)
                        for (qreal x = -3; x <= 3; x += .5) {
                            const QPointF local(x, y);
                            if (paintedAt(side + "Thigh", local)
                                    && paintedAt("hips", unmapPoint(hips, mapPoint(thigh, local))))
                                ++overlap;
                        }
                    ok &= check(overlap >= 12,
                                QStringLiteral("%1 %2 hip/thigh must retain painted overlap at motion limits (got %3 samples)")
                                    .arg(texture, side).arg(overlap));
                }
            }
        }
    }
    puppet.setPose({});
    }

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

bool productionRenderChecks(QQuickWindow &window, AvatarPuppet &puppet,
                            const QUrl &source, const QVariantMap &definition)
{
    bool ok = true;
    window.resize(192, 208);
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

    if (definition.value(QStringLiteral("presentation")).toString()
            == QStringLiteral("reference")) {
        puppet.setPose({});
        puppet.setSurfaceFrame(0);
        const QImage neutral = synchronizedGrab(window);
        const QVariantMap routes = definition.value(QStringLiteral("surfaceSequences")).toMap()
                                           .value(QStringLiteral("routes")).toMap();
        const QStringList routeNames{QStringLiteral("wave"), QStringLiteral("thinking"),
                                     QStringLiteral("present"), QStringLiteral("celebrate"),
                                     QStringLiteral("shy"), QStringLiteral("carry")};
        QImage routeSheet(192 * routeNames.size(), 232, QImage::Format_ARGB32);
        routeSheet.fill(QColor("#20232e"));
        QPainter routePainter(&routeSheet);
        for (int routeIndex = 0; routeIndex < routeNames.size(); ++routeIndex) {
            const QString routeName = routeNames[routeIndex];
            const QVariantList frames = routes.value(routeName).toMap()
                                                .value(QStringLiteral("frames")).toList();
            if (frames.isEmpty()) {
                ok &= check(false, QStringLiteral("production %1 route is missing").arg(routeName));
                continue;
            }
            puppet.setSurfaceFrame(frames.last().toInt());
            const QImage endpoint = synchronizedGrab(window);
            int painted = 0;
            bool clipped = false;
            for (int y = 0; y < endpoint.height(); ++y) {
                for (int x = 0; x < endpoint.width(); ++x) {
                    painted += qAlpha(endpoint.pixel(x, y)) > 200;
                    if ((x == 0 || y == 0 || x == endpoint.width() - 1
                         || y == endpoint.height() - 1)
                            && qAlpha(endpoint.pixel(x, y)) > 128)
                        clipped = true;
                }
            }
            ok &= check(!endpoint.isNull() && endpoint != neutral && painted > 3000 && !clipped,
                        QStringLiteral("production %1 endpoint must be distinct, visible, and unclipped")
                                .arg(routeName));
            routePainter.setPen(Qt::white);
            routePainter.drawText(routeIndex * 192 + 4, 18, routeName);
            routePainter.drawImage(routeIndex * 192, 24, endpoint);
        }
        routePainter.end();
        QDir().mkpath("/tmp/cere-motion-evidence");
        const auto avatar = definition.value("texture").toString().section('-', 0, 0);
        const auto backend = window.rendererInterface()->graphicsApi()
                == QSGRendererInterface::Software ? "software" : "opengl";
        ok &= check(routeSheet.save(QString("/tmp/cere-motion-evidence/routes-%1-%2.png")
                                            .arg(avatar, backend)),
                    "connected route contact sheet must save");
        puppet.setSurfaceFrame(0);
    }

    QImage sheet(192 * 8, 232 * 4, QImage::Format_ARGB32);
    sheet.fill(QColor("#20232e"));
    QPainter painter(&sheet);
    const auto poses = definition.value("poses").toMap();
    for (int index = 0; index < poses.size(); ++index) {
        const auto pose = poses.value(QString::number(index)).toMap();
        puppet.setPose(pose.value("joints").toMap());
        const auto frame = synchronizedGrab(window);
        int painted = 0;
        bool clipped = false;
        for (int y = 0; y < frame.height(); ++y)
            for (int x = 0; x < frame.width(); ++x) {
                painted += qAlpha(frame.pixel(x, y)) > 200;
                if ((x == 0 || y == 0 || x == frame.width() - 1 || y == frame.height() - 1)
                        && qAlpha(frame.pixel(x, y)) > 128) clipped = true;
            }
        ok &= check(!frame.isNull() && painted > 3000,
                    QStringLiteral("production pose %1 must remain visible").arg(pose.value("name").toString()));
        if (clipped && index == 0) {
            QDir().mkpath("/tmp/cere-motion-evidence");
            frame.save("/tmp/cere-motion-evidence/clipped-raw.png");
            std::cerr << "clipping capture " << frame.width() << 'x' << frame.height()
                      << " window " << window.width() << 'x' << window.height()
                      << " DPR " << window.devicePixelRatio() << '\n';
        }
        ok &= check(!clipped, QStringLiteral("production pose %1 must fit without clipped art")
                              .arg(pose.value("name").toString()));
        const int x = (index % 8) * 192, y = (index / 8) * 232;
        painter.setPen(Qt::white);
        painter.drawText(x + 4, y + 18, pose.value("name").toString());
        painter.drawImage(x, y + 24, frame);
    }
    painter.end();
    QDir().mkpath("/tmp/cere-motion-evidence");
    const auto avatar = definition.value("texture").toString().section('-', 0, 0);
    const auto backend = window.rendererInterface()->graphicsApi() == QSGRendererInterface::Software ? "software" : "opengl";
    ok &= check(sheet.save(QString("/tmp/cere-motion-evidence/poses-%1-%2.png").arg(avatar, backend)),
                "production pose contact sheet must save");
    // Render at a second aspect ratio to catch accidental stretching and foot
    // drift in preview cards; the same fit is used by the desktop pet.
    puppet.setPose({});
    window.resize(288, 312);
    puppet.setSize({288, 312});
    const auto rest = synchronizedGrab(window);
    window.resize(384, 312);
    puppet.setSize({384, 312});
    const auto wide = synchronizedGrab(window);
    // A tiling compositor can refuse the requested window dimensions. The
    // item's dimensions and the window's DPR still define the rendered fit.
    const qreal pixelScale = window.devicePixelRatio();
    const auto bounds = [](const QImage &image) {
        QRect rect;
        for (int y = 0; y < image.height(); ++y)
            for (int x = 0; x < image.width(); ++x)
                if (qAlpha(image.pixel(x, y)) > 128) rect |= QRect(x, y, 1, 1);
        return rect;
    };
    const QRect expected = bounds(rest).translated(qRound(48 * pixelScale), 0);
    const QRect actual = bounds(wide);
    ok &= check(!expected.isEmpty() && std::abs(actual.left() - expected.left()) <= 1
                    && std::abs(actual.top() - expected.top()) <= 1
                    && std::abs(actual.right() - expected.right()) <= 1
                    && std::abs(actual.bottom() - expected.bottom()) <= 1,
                QStringLiteral("wider cards must preserve silhouette and ground: expected %1,%2 %3x%4, got %5,%6 %7x%8")
                    .arg(expected.x()).arg(expected.y()).arg(expected.width()).arg(expected.height())
                    .arg(actual.x()).arg(actual.y()).arg(actual.width()).arg(actual.height()));
    ok &= check(rest.save(QString("/tmp/cere-motion-evidence/rest-%1-%2.png").arg(avatar, backend)),
                "enlarged rest render must save");
    return ok;
}

bool motionRenderChecks(QQuickWindow &window, AvatarPuppet &puppet,
                        const QString &root,const QUrl &source,const QVariantMap &definition)
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
    window.resize(192,208);
    puppet.setSize({192,208});puppet.setSource(source);puppet.setDefinition(definition);
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
            puppet.setY(sample.property("y").toNumber());
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
    const auto avatar=definition.value("texture").toString().section('-',0,0);
    ok &= check(sheet.save(QString("/tmp/cere-motion-evidence/clips-%1-%2.png").arg(avatar,backend)),"new clip contact sheet must save");
    puppet.setY(0);return ok;
}

bool waistRenderChecks(QQuickWindow &window, AvatarPuppet &puppet,
                       const QUrl &source, const QVariantMap &definition)
{
    // Magnify the actual scene graph around the join. Small selection cards
    // can hide a second waist or clothing that separates during a stance.
    constexpr int scale = 4, width = 320, height = 208;
    window.resize(width, height);
    puppet.setSource(source);
    puppet.setDefinition(definition);
    puppet.setSize({192 * scale, 208 * scale});
    puppet.setPosition({-56 * scale, -112 * scale});
    const QList<QVariantMap> poses{
        {}, {{"bodyTilt", -4}, {"breathLift", -2}, {"hipDrop", 3}},
        {{"bodyTilt", 4}, {"breathLift", 2}, {"hipDrop", -2}}
    };
    QImage sheet(width * poses.size(), height, QImage::Format_ARGB32);
    sheet.fill(QColor("#20232e"));
    QPainter painter(&sheet);
    bool ok = true;
    for (int i = 0; i < poses.size(); ++i) {
        puppet.setPose(poses[i]);
        const auto frame = synchronizedGrab(window);
        ok &= check(!frame.isNull(), "magnified waist must render");
        painter.drawImage(QRect(i * width, 0, width, height), frame,
                          QRectF(0, 0, width * window.devicePixelRatio(), height * window.devicePixelRatio()));
    }
    painter.end();
    const auto avatar = definition.value("texture").toString().section('-', 0, 0);
    const auto backend = window.rendererInterface()->graphicsApi() == QSGRendererInterface::Software ? "software" : "opengl";
    ok &= check(sheet.save(QString("/tmp/cere-motion-evidence/waist-%1-%2.png").arg(avatar, backend)),
                "waist motion contact sheet must save");
    puppet.setPosition({0, 0});
    return ok;
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

    const auto withFirstPart = [](QVariantMap definition, const QVariantMap &changes) {
        QVariantList changedParts = definition.value(QStringLiteral("parts")).toList();
        QVariantMap changed = changedParts.first().toMap();
        for (auto entry = changes.cbegin(); entry != changes.cend(); ++entry)
            changed.insert(entry.key(), entry.value());
        changedParts[0] = changed;
        definition.insert(QStringLiteral("parts"), changedParts);
        return definition;
    };
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), QStringLiteral("true")}}),
                  "non-boolean surfaceMotion must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("blinkSourceRect"),
                                  QVariantList{16, 0, 16, 16}}}),
                  "blinkSourceRect without surfaceMotion must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("blinkSourceRect"),
                                  QVariantList{16, 0, 15, 16}}}),
                  "mismatched surface blink dimensions must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("blinkSourceRect"),
                                  QVariantList{96, 0, 16, 16}}}),
                  "out-of-atlas surface blink frame must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceFrames"), QVariantList{}}}),
                  "surfaceFrames on a rigid part must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("surfaceFrames"), QStringLiteral("invalid")}}),
                  "non-list surfaceFrames metadata must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("surfaceFrames"), QVariantList{17}}}),
                  "non-object surface frame metadata must be rejected visibly");
    QVariantList tooManyFrames;
    for (int index = 0; index < 385; ++index)
        tooManyFrames.append(QVariantMap{{QStringLiteral("sourceRect"),
                                          QVariantList{16, 0, 16, 16}}});
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("surfaceFrames"), tooManyFrames}}),
                  "more than 384 surface frames must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("surfaceFrames"), QVariantList{
                                      QVariantMap{{QStringLiteral("sourceRect"),
                                                   QVariantList{16.5, 0, 16, 16}}}}}}),
                  "non-integral surface frame rectangles must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("surfaceFrames"), QVariantList{
                                      QVariantMap{{QStringLiteral("sourceRect"),
                                                   QVariantList{QStringLiteral("16"), 0,
                                                                16, 16}}}}}}),
                  "non-numeric surface frame coordinates must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("surfaceFrames"), QVariantList{
                                      QVariantMap{{QStringLiteral("sourceRect"),
                                                   QVariantList{16, 0, 8, 16}}}}}}),
                  "surface frame aspect mismatch must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("surfaceFrames"), QVariantList{
                                      QVariantMap{{QStringLiteral("sourceRect"),
                                                   QVariantList{16, 0, 16, 16}},
                                                  {QStringLiteral("blinkSourceRect"),
                                                   QVariantList{32, 0, 8, 16}}}}}}),
                  "surface frame blink dimensions must be rejected visibly");
    ok &= rejects(withFirstPart(validDefinition(),
                                {{QStringLiteral("surfaceMotion"), true},
                                 {QStringLiteral("surfaceFrames"), QVariantList{
                                      QVariantMap{{QStringLiteral("sourceRect"),
                                                   QVariantList{96, 0, 16, 16}}}}}}),
                  "out-of-atlas surface frame rectangles must be rejected visibly");
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
    // Display = 16 + 1.5 * reference x, 1.5 * reference y for this window.
    ok &= check(rest.pixelColor(100, 12).blue() > 180 && rest.pixelColor(100, 5).blue() > 180
                        && rest.pixelColor(92, 12).alpha() == 0 && rest.pixelColor(107, 12).alpha() == 0,
                "a part's fixed rotation must turn its artwork about the bone origin");

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

QRect alphaBounds(const QImage &image)
{
    QRect bounds;
    for (int y = 0; y < image.height(); ++y)
        for (int x = 0; x < image.width(); ++x)
            if (qAlpha(image.pixel(x, y)) > 8)
                bounds |= QRect(x, y, 1, 1);
    return bounds;
}

bool surfaceRenderChecks(const QUrl &firstSource, const QUrl &secondSource)
{
    bool ok = true;
    QQuickWindow window;
    window.setColor(Qt::transparent);
    window.resize(64, 64);
    AvatarPuppet puppet(window.contentItem());
    puppet.setSize({64, 64});
    puppet.setSource(firstSource);
    puppet.setDefinition(surfaceDefinition());
    ok &= check(puppet.ready() && puppet.error().isEmpty()
                        && puppet.surfaceFrame() == 0,
                "valid surface puppet must become ready");

    const QImage rest = synchronizedGrab(window);
    const QRect restBounds = alphaBounds(rest);
    puppet.setPose({{QStringLiteral("breathLift"), -2.0},
                    {QStringLiteral("bodyTilt"), 4.0},
                    {QStringLiteral("headTilt"), -9.0},
                    {QStringLiteral("headX"), 3.0},
                    {QStringLiteral("headY"), -3.0},
                    {QStringLiteral("hipX"), 2.5},
                    {QStringLiteral("hipDrop"), 3.0},
                    {QStringLiteral("hairRotation"), 2.0}});
    const QImage moving = synchronizedGrab(window);
    const QRect movingBounds = alphaBounds(moving);
    ok &= check(!rest.isNull() && !moving.isNull() && moving != rest,
                "surface motion must repaint on the selected scene-graph backend");
    ok &= check(!restBounds.isEmpty() && !movingBounds.isEmpty()
                        && movingBounds.left() > 0 && movingBounds.top() > 0
                        && movingBounds.right() < moving.width() - 1
                        && movingBounds.bottom() < moving.height() - 1
                        && std::abs(movingBounds.bottom() - restBounds.bottom()) <= 1,
                "surface motion must remain unclipped with pinned soles");

    puppet.setPose({{QStringLiteral("eyeClose"), 1.0}});
    const QImage blink = synchronizedGrab(window);
    ok &= check(!blink.isNull() && blink != rest,
                "authored eye-close must repaint the surface blink frame on the selected backend");

    puppet.setPose({});
    puppet.setSurfaceFrame(1);
    const QImage posed = synchronizedGrab(window);
    ok &= check(puppet.surfaceFrame() == 1 && !posed.isNull() && posed != rest,
                "selecting a surface frame must visibly replace neutral pixels");
    puppet.setPose({{QStringLiteral("blink"), 1.0}});
    const QImage posedBlink = synchronizedGrab(window);
    ok &= check(!posedBlink.isNull() && posedBlink != posed,
                "a selected surface frame must use its own blink crop");

    // Authored playback repeatedly replaces the sole prepared CPU frame and
    // the selected GPU texture. Exercise forward/reverse switching on both
    // scene-graph backends so bounded caches cannot leave dangling images.
    for (int step = 0; step < 18; ++step) {
        const int frame = step % 3;
        puppet.setPose(frame == 1
                ? QVariantMap{{QStringLiteral("blink"), qreal(step % 2)}}
                : QVariantMap{});
        puppet.setSurfaceFrame(frame);
        const QImage switchedFrame = synchronizedGrab(window);
        ok &= check(puppet.ready() && !switchedFrame.isNull(),
                    "repeated surface frame replacement must remain ready and visible");
    }

    puppet.setPose({});
    puppet.setSurfaceFrame(2);
    const QImage noBlinkFrame = synchronizedGrab(window);
    puppet.setPose({{QStringLiteral("eyeClose"), 1.0}});
    const QImage suppressedBlink = synchronizedGrab(window);
    ok &= check(!noBlinkFrame.isNull() && suppressedBlink == noBlinkFrame,
                "a surface frame without blinkSourceRect must suppress blinking");

    puppet.setPose({});
    puppet.setSurfaceFrame(999);
    const QImage fallback = synchronizedGrab(window);
    ok &= check(fallback == rest,
                "an out-of-range surface frame must safely render frame zero");

    QVariantMap oneFrameDefinition = surfaceDefinition();
    QVariantList oneFrameParts = oneFrameDefinition.value(QStringLiteral("parts")).toList();
    QVariantMap oneFramePart = oneFrameParts.first().toMap();
    oneFramePart.remove(QStringLiteral("surfaceFrames"));
    oneFrameParts[0] = oneFramePart;
    oneFrameDefinition.insert(QStringLiteral("parts"), oneFrameParts);
    puppet.setSurfaceFrame(1);
    puppet.setDefinition(oneFrameDefinition);
    ok &= check(puppet.ready() && synchronizedGrab(window) == rest,
                "switching to a definition without the selected frame must fall back safely");

    puppet.setDefinition(surfaceDefinition());
    puppet.setSurfaceFrame(1);
    const QImage firstPosedSource = synchronizedGrab(window);
    puppet.setSource(secondSource);
    ok &= check(puppet.ready(), "surface source switch must remain ready");
    const QImage switched = synchronizedGrab(window);
    ok &= check(!switched.isNull() && switched != firstPosedSource,
                "surface source switch must replace the selected frame texture");
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
    const QString surfaceAtlasPath = directory.filePath(QStringLiteral("surface.png"));
    const QString secondSurfaceAtlasPath = directory.filePath(
            QStringLiteral("surface-second.png"));
    if (!check(makeSurfaceAtlas(QColor(105, 165, 225)).save(surfaceAtlasPath)
                       && makeSurfaceAtlas(QColor(215, 105, 135)).save(secondSurfaceAtlasPath),
               "generated surface atlases must be saved"))
        return 1;

    AvatarPuppet puppet;
    puppet.setSource(source);
    puppet.setDefinition(validDefinition());
    bool ok = check(puppet.ready(), "valid child-first skeleton must parse")
            && referenceSurfaceImageChecks()
            && skeletonChecks(puppet)
            && malformedChecks(source)
            && renderChecks(source)
            && surfaceRenderChecks(QUrl::fromLocalFile(surfaceAtlasPath),
                                   QUrl::fromLocalFile(secondSurfaceAtlasPath));
    const QString root = argc > 1 ? QString::fromLocal8Bit(argv[1])
                                  : QStringLiteral(".");
    QFile avatars(root + "/assets/avatars.json");
    if (!check(avatars.open(QIODevice::ReadOnly), "avatar catalog must open")) return 1;
    const auto entries=QJsonDocument::fromJson(avatars.readAll()).array();
    ok &= check(entries.size()==5, "all five selectable connected avatars must be checked");
    // Match the application: switch every avatar on one live scene graph.
    QQuickWindow productionWindow;
    productionWindow.setColor(Qt::transparent);
    AvatarPuppet productionPuppet(productionWindow.contentItem());
    for (const auto &value:entries) {
        const auto entry=value.toObject();
        QVariantMap productionDefinition;
        QUrl productionSource;
        const bool productionOk = productionDefinitionChecks(
                root, &productionDefinition, &productionSource, entry["rig"].toString());
        ok &= productionOk;
        if (productionOk)
            ok &= productionRenderChecks(productionWindow, productionPuppet, productionSource, productionDefinition)
                && motionRenderChecks(productionWindow, productionPuppet,root,productionSource,productionDefinition)
                && waistRenderChecks(productionWindow, productionPuppet, productionSource, productionDefinition);
        std::cout << "checked avatar " << entry["id"].toString().toStdString() << '\n';
    }
    return ok ? 0 : 1;
}
