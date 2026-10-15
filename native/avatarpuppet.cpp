#include "avatarpuppet.h"

#include "avatarskeleton.h"
#include "referenceart.h"

#include <QFileInfo>
#include <QHash>
#include <QImage>
#include <QImageReader>
#include <QMatrix4x4>
#include <QMetaType>
#include <QQuickWindow>
#include <QSGImageNode>
#include <QSGOpacityNode>
#include <QSGTexture>
#include <QSGTransformNode>
#include <QTransform>

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>

namespace {

constexpr qreal defaultReferenceWidth = 192.0;
constexpr qreal defaultReferenceHeight = 208.0;
constexpr qreal maximumDefinitionCoordinate = 1000000.0;
// Each cutout keeps area-averaged half-size copies. Painted atlases are drawn
// several times larger than the desktop pet, and bilinear sampling alone
// aliases (shimmers) at those reductions on both GPU and software backends.
constexpr int maximumTextureLevel = 4;
constexpr int minimumLevelSide = 4;

struct RawBone
{
    AvatarSkeleton::Bone bone;
    QString parentName;
    int parent = -1;
};

struct Part
{
    QString name;
    int bone = -1;
    QRect sourceRect;
    QRectF rect;
    qreal z = 0.0;
    // Fixed artwork rotation about the bone origin, in clockwise degrees. It
    // aligns a painted limb with its bone without resampling the atlas.
    qreal rotation = 0.0;
    AvatarSkeleton::Transform local;
    int order = 0;
    QString opacityChannel;
    QString visibilityChannel;
    qreal visibilityMin = -std::numeric_limits<qreal>::infinity();
    qreal visibilityMax = std::numeric_limits<qreal>::infinity();
    bool mirrorX = false;
    bool surfaceMotion = false;
    QRect blinkSourceRect;
};

QString imagePath(const QUrl &source)
{
    if (source.isLocalFile())
        return source.toLocalFile();
    if (source.scheme() == QLatin1String("qrc"))
        return QLatin1Char(':') + source.path();
    if (source.scheme().isEmpty())
        return source.toString();
    return {};
}

struct ImageCache
{
    QHash<QString, QImage> atlases;
    QHash<QString, QVector<QImage>> crops;
};

ImageCache &imageCache()
{
    // Source and definition setters run on the GUI thread. QImage implicit
    // sharing lets puppet instances reuse both decoded atlases and cutouts.
    static ImageCache cache;
    return cache;
}

QVector<QImage> textureLevels(const QImage &crop)
{
    // Pad to a multiple of the coarsest divisor so each level is an exact
    // reduction: the painted region keeps its registration at every level.
    constexpr int step = 1 << maximumTextureLevel;
    QImage padded(((crop.width() + step - 1) / step) * step,
                  ((crop.height() + step - 1) / step) * step,
                  QImage::Format_ARGB32_Premultiplied);
    padded.fill(Qt::transparent);
    for (int y = 0; y < crop.height(); ++y)
        std::copy_n(reinterpret_cast<const QRgb *>(crop.constScanLine(y)), crop.width(),
                    reinterpret_cast<QRgb *>(padded.scanLine(y)));
    QVector<QImage> levels{crop};
    for (int level = 1; level <= maximumTextureLevel; ++level) {
        const int divisor = 1 << level;
        if (crop.width() / divisor < minimumLevelSide || crop.height() / divisor < minimumLevelSide)
            break;
        // Premultiplied area averaging; every level is reduced from the crop.
        levels.append(padded.scaled(padded.size() / divisor, Qt::IgnoreAspectRatio,
                                    Qt::SmoothTransformation));
    }
    return levels;
}

bool finiteNumber(const QVariant &value, qreal *number)
{
    bool ok = false;
    const qreal candidate = value.toDouble(&ok);
    if (!ok || !std::isfinite(candidate))
        return false;
    *number = candidate;
    return true;
}

bool boundedNumber(const QVariant &value, qreal *number)
{
    return finiteNumber(value, number)
            && std::abs(*number) <= maximumDefinitionCoordinate;
}

bool optionalNumber(const QVariantMap &map, const char *key, qreal fallback,
                    qreal *number, QString *error)
{
    const auto found = map.constFind(QLatin1String(key));
    if (found == map.cend()) {
        *number = fallback;
        return true;
    }
    if (!boundedNumber(*found, number)) {
        *error = QStringLiteral("%1 must be a finite bounded number")
                         .arg(QLatin1String(key));
        return false;
    }
    return true;
}

bool optionalChannel(const QVariantMap &map, const char *key, QString *channel,
                     QString *error)
{
    const auto found = map.constFind(QLatin1String(key));
    if (found == map.cend()) {
        channel->clear();
        return true;
    }
    if (found->metaType().id() != QMetaType::QString) {
        *error = QStringLiteral("%1 must be a channel string")
                         .arg(QLatin1String(key));
        return false;
    }
    *channel = found->toString();
    return true;
}

bool optionalBoolean(const QVariantMap &map, const char *key, bool fallback,
                     bool *value, QString *error)
{
    const auto found = map.constFind(QLatin1String(key));
    if (found == map.cend()) {
        *value = fallback;
        return true;
    }
    if (found->metaType().id() != QMetaType::Bool) {
        *error = QStringLiteral("%1 must be a boolean").arg(QLatin1String(key));
        return false;
    }
    *value = found->toBool();
    return true;
}

bool numberList(const QVariant &value, int expected, QVector<qreal> *numbers)
{
    if (!value.canConvert<QVariantList>())
        return false;
    const QVariantList list = value.toList();
    if (list.size() != expected)
        return false;
    numbers->clear();
    numbers->reserve(expected);
    for (const QVariant &entry : list) {
        qreal number = 0.0;
        if (!boundedNumber(entry, &number))
            return false;
        numbers->append(number);
    }
    return true;
}

QMatrix4x4 matrixFor(const AvatarSkeleton::Transform &transform)
{
    return QMatrix4x4(float(transform.m11), float(transform.m12), 0.0f,
                      float(transform.dx),
                      float(transform.m21), float(transform.m22), 0.0f,
                      float(transform.dy),
                      0.0f, 0.0f, 1.0f, 0.0f,
                      0.0f, 0.0f, 0.0f, 1.0f);
}

class PuppetNode final : public QSGNode
{
public:
    struct RenderPart
    {
        QSGTransformNode *transform = nullptr;
        QSGOpacityNode *opacity = nullptr;
        QSGImageNode *image = nullptr;
        int part = -1;
        ReferenceArt::Pose surfacePose;
        bool surfacePoseValid = false;
        QSGTexture *surfaceOriginal = nullptr;
        QSGTexture *surfaceDynamic = nullptr;
    };

    ~PuppetNode() override
    {
        for (RenderPart &part : parts) {
            if (!part.surfaceOriginal)
                continue;
            part.image->setOwnsTexture(false);
            delete part.surfaceDynamic;
            delete part.surfaceOriginal;
        }
    }

    quint64 revision = 0;
    QVector<int> levels;
    QVector<RenderPart> parts;
};

} // namespace

struct AvatarPuppet::Private
{
    QUrl source;
    QVariantMap definition;
    QVariantMap pose;
    QImage atlas;
    QString sourceKey;
    QSizeF referenceSize{defaultReferenceWidth, defaultReferenceHeight};
    QVector<AvatarSkeleton::Bone> bones;
    QVector<Part> parts;
    QVector<QVector<QImage>> partLevels;
    QVector<QVector<QImage>> blinkLevels;
    quint64 revision = 0;
    bool ready = false;
    QString error;
};

AvatarPuppet::AvatarPuppet(QQuickItem *parent)
    : QQuickItem(parent), d(std::make_unique<Private>())
{
    setFlag(ItemHasContents, true);
    setImplicitSize(defaultReferenceWidth, defaultReferenceHeight);
}

AvatarPuppet::~AvatarPuppet() = default;

QUrl AvatarPuppet::source() const
{
    return d->source;
}

void AvatarPuppet::setSource(const QUrl &source)
{
    if (d->source == source)
        return;
    d->source = source;
    emit sourceChanged();
    loadSource();
}

QVariantMap AvatarPuppet::definition() const
{
    return d->definition;
}

void AvatarPuppet::setDefinition(const QVariantMap &definition)
{
    if (d->definition == definition)
        return;
    d->definition = definition;
    emit definitionChanged();
    rebuild();
}

QVariantMap AvatarPuppet::pose() const
{
    return d->pose;
}

void AvatarPuppet::setPose(const QVariantMap &pose)
{
    if (d->pose == pose)
        return;
    d->pose = pose;
    emit poseChanged();
    update();
}

bool AvatarPuppet::ready() const
{
    return d->ready;
}

QString AvatarPuppet::error() const
{
    return d->error;
}

void AvatarPuppet::setStatus(bool ready, const QString &error)
{
    const bool readyDidChange = d->ready != ready;
    const bool errorDidChange = d->error != error;
    d->ready = ready;
    d->error = error;
    if (errorDidChange)
        emit errorChanged();
    if (readyDidChange)
        emit readyChanged();
}

void AvatarPuppet::loadSource()
{
    d->atlas = {};
    d->sourceKey.clear();
    const QString path = imagePath(d->source);
    if (!path.isEmpty()) {
        const QString canonical = QFileInfo(path).canonicalFilePath();
        d->sourceKey = canonical.isEmpty() ? path : canonical;
        ImageCache &cache = imageCache();
        const auto cached = cache.atlases.constFind(d->sourceKey);
        if (cached != cache.atlases.cend()) {
            d->atlas = *cached;
        } else {
            QImageReader reader(path);
            reader.setAutoTransform(true);
            QImage image = reader.read();
            if (!image.isNull()) {
                image = image.convertToFormat(QImage::Format_ARGB32_Premultiplied);
                cache.atlases.insert(d->sourceKey, image);
                d->atlas = image;
            }
        }
    }
    rebuild();
}

void AvatarPuppet::rebuild()
{
    d->bones.clear();
    d->parts.clear();
    d->partLevels.clear();
    d->blinkLevels.clear();
    d->referenceSize = QSizeF(defaultReferenceWidth, defaultReferenceHeight);
    ++d->revision;

    QString validationError;
    bool versionOk = false;
    const int version = d->definition.value(QStringLiteral("version")).toInt(&versionOk);
    if (!versionOk || version != 1)
        validationError = QStringLiteral("definition version must be 1");

    QVector<qreal> reference;
    if (validationError.isEmpty()
            && (!numberList(d->definition.value(QStringLiteral("referenceSize")), 2,
                            &reference)
                || reference[0] <= 0.0 || reference[1] <= 0.0)) {
        validationError = QStringLiteral("referenceSize must contain two positive numbers");
    }

    QVariantList boneValues;
    if (validationError.isEmpty()) {
        boneValues = d->definition.value(QStringLiteral("bones")).toList();
        if (boneValues.isEmpty())
            validationError = QStringLiteral("bones must be a non-empty list");
    }

    QVector<RawBone> rawBones;
    QHash<QString, int> rawBoneIndex;
    if (validationError.isEmpty()) {
        rawBones.reserve(boneValues.size());
        for (int index = 0; index < boneValues.size(); ++index) {
            const QVariantMap map = boneValues[index].toMap();
            const QString name = map.value(QStringLiteral("name")).toString();
            if (name.isEmpty()) {
                validationError = QStringLiteral("bone %1 has no name").arg(index);
                break;
            }
            if (rawBoneIndex.contains(name)) {
                validationError = QStringLiteral("duplicate bone '%1'").arg(name);
                break;
            }
            RawBone raw;
            raw.bone.name = name;
            raw.parentName = map.value(QStringLiteral("parent")).toString();
            QString detail;
            if (!optionalNumber(map, "x", 0.0, &raw.bone.x, &detail)
                    || !optionalNumber(map, "y", 0.0, &raw.bone.y, &detail)
                    || !optionalChannel(map, "angle", &raw.bone.angleChannel, &detail)
                    || !optionalChannel(map, "offsetX", &raw.bone.offsetXChannel, &detail)
                    || !optionalChannel(map, "offsetY", &raw.bone.offsetYChannel, &detail)) {
                validationError = QStringLiteral("bone '%1': %2").arg(name, detail);
                break;
            }
            rawBoneIndex.insert(name, rawBones.size());
            rawBones.append(raw);
        }
    }

    if (validationError.isEmpty()) {
        for (RawBone &bone : rawBones) {
            if (bone.parentName.isEmpty())
                continue;
            const auto parent = rawBoneIndex.constFind(bone.parentName);
            if (parent == rawBoneIndex.cend()) {
                validationError = QStringLiteral("bone '%1' has unknown parent '%2'")
                                          .arg(bone.bone.name, bone.parentName);
                break;
            }
            bone.parent = *parent;
        }
    }

    QVector<int> order;
    if (validationError.isEmpty()) {
        QVector<quint8> state(rawBones.size(), 0);
        std::function<bool(int)> visit = [&](int index) {
            if (state[index] == 2)
                return true;
            if (state[index] == 1) {
                validationError = QStringLiteral("bone hierarchy contains a cycle at '%1'")
                                          .arg(rawBones[index].bone.name);
                return false;
            }
            state[index] = 1;
            if (rawBones[index].parent >= 0 && !visit(rawBones[index].parent))
                return false;
            state[index] = 2;
            order.append(index);
            return true;
        };
        for (int index = 0; index < rawBones.size() && validationError.isEmpty(); ++index)
            visit(index);
    }

    QHash<QString, int> boneIndex;
    if (validationError.isEmpty()) {
        QVector<int> remap(rawBones.size(), -1);
        for (int oldIndex : order) {
            AvatarSkeleton::Bone bone = rawBones[oldIndex].bone;
            bone.parent = rawBones[oldIndex].parent < 0
                    ? -1 : remap[rawBones[oldIndex].parent];
            remap[oldIndex] = d->bones.size();
            boneIndex.insert(bone.name, d->bones.size());
            d->bones.append(bone);
        }
    }

    QVariantList partValues;
    if (validationError.isEmpty()) {
        partValues = d->definition.value(QStringLiteral("parts")).toList();
        if (partValues.isEmpty())
            validationError = QStringLiteral("parts must be a non-empty list");
    }

    QHash<QString, bool> partNames;
    if (validationError.isEmpty()) {
        d->parts.reserve(partValues.size());
        for (int index = 0; index < partValues.size(); ++index) {
            const QVariantMap map = partValues[index].toMap();
            Part part;
            part.name = map.value(QStringLiteral("name")).toString();
            if (part.name.isEmpty()) {
                validationError = QStringLiteral("part %1 has no name").arg(index);
                break;
            }
            if (partNames.contains(part.name)) {
                validationError = QStringLiteral("duplicate part '%1'").arg(part.name);
                break;
            }
            partNames.insert(part.name, true);
            const QString boneName = map.value(QStringLiteral("bone")).toString();
            const auto bone = boneIndex.constFind(boneName);
            if (bone == boneIndex.cend()) {
                validationError = QStringLiteral("part '%1' has unknown bone '%2'")
                                          .arg(part.name, boneName);
                break;
            }
            part.bone = *bone;
            part.order = index;

            QVector<qreal> sourceRect;
            if (!numberList(map.value(QStringLiteral("sourceRect")), 4, &sourceRect)
                    || sourceRect[0] < 0.0 || sourceRect[1] < 0.0
                    || sourceRect[2] <= 0.0 || sourceRect[3] <= 0.0
                    || sourceRect[0] != std::floor(sourceRect[0])
                    || sourceRect[1] != std::floor(sourceRect[1])
                    || sourceRect[2] != std::floor(sourceRect[2])
                    || sourceRect[3] != std::floor(sourceRect[3])) {
                validationError = QStringLiteral("part '%1' has an invalid sourceRect")
                                          .arg(part.name);
                break;
            }
            part.sourceRect = QRect(int(sourceRect[0]), int(sourceRect[1]),
                                    int(sourceRect[2]), int(sourceRect[3]));

            QVector<qreal> rect;
            if (!numberList(map.value(QStringLiteral("rect")), 4, &rect)
                    || rect[2] <= 0.0 || rect[3] <= 0.0) {
                validationError = QStringLiteral("part '%1' has an invalid rect")
                                          .arg(part.name);
                break;
            }
            part.rect = QRectF(rect[0], rect[1], rect[2], rect[3]);

            QString detail;
            if (!optionalNumber(map, "z", 0.0, &part.z, &detail)
                    || !optionalNumber(map, "rotation", 0.0, &part.rotation, &detail)
                    || !optionalChannel(map, "opacityChannel", &part.opacityChannel,
                                        &detail)
                    || !optionalBoolean(map, "surfaceMotion", false,
                                        &part.surfaceMotion, &detail)) {
                validationError = QStringLiteral("part '%1': %2").arg(part.name, detail);
                break;
            }
            part.local = AvatarSkeleton::rotation(part.rotation);
            part.mirrorX = map.value(QStringLiteral("mirrorX"), false).toBool();

            const auto blinkValue = map.constFind(QStringLiteral("blinkSourceRect"));
            if (blinkValue != map.cend()) {
                QVector<qreal> blinkRect;
                if (!numberList(*blinkValue, 4, &blinkRect)
                        || blinkRect[0] < 0.0 || blinkRect[1] < 0.0
                        || blinkRect[2] <= 0.0 || blinkRect[3] <= 0.0
                        || blinkRect[0] != std::floor(blinkRect[0])
                        || blinkRect[1] != std::floor(blinkRect[1])
                        || blinkRect[2] != std::floor(blinkRect[2])
                        || blinkRect[3] != std::floor(blinkRect[3])) {
                    validationError = QStringLiteral("part '%1' has an invalid blinkSourceRect")
                                              .arg(part.name);
                    break;
                }
                part.blinkSourceRect = QRect(int(blinkRect[0]), int(blinkRect[1]),
                                             int(blinkRect[2]), int(blinkRect[3]));
                if (!part.surfaceMotion) {
                    validationError = QStringLiteral("part '%1': blinkSourceRect requires surfaceMotion")
                                              .arg(part.name);
                    break;
                }
                if (part.blinkSourceRect.size() != part.sourceRect.size()) {
                    validationError = QStringLiteral("part '%1': blinkSourceRect must match sourceRect size")
                                              .arg(part.name);
                    break;
                }
            }

            const auto visibilityValue = map.constFind(QStringLiteral("visibleWhen"));
            if (visibilityValue != map.cend()) {
                const QVariantMap visibility = visibilityValue->toMap();
                QString visibilityError;
                if (!optionalChannel(visibility, "channel", &part.visibilityChannel,
                                     &visibilityError)
                        || part.visibilityChannel.isEmpty()) {
                    validationError = QStringLiteral("part '%1': visibleWhen requires a channel")
                                              .arg(part.name);
                    break;
                }
                if (visibility.contains(QStringLiteral("min"))
                        && !boundedNumber(visibility.value(QStringLiteral("min")),
                                          &part.visibilityMin)) {
                    validationError = QStringLiteral("part '%1': visibleWhen min is invalid")
                                              .arg(part.name);
                    break;
                }
                if (visibility.contains(QStringLiteral("max"))
                        && !boundedNumber(visibility.value(QStringLiteral("max")),
                                          &part.visibilityMax)) {
                    validationError = QStringLiteral("part '%1': visibleWhen max is invalid")
                                              .arg(part.name);
                    break;
                }
                if (part.visibilityMin >= part.visibilityMax) {
                    validationError = QStringLiteral("part '%1': visibleWhen range is empty")
                                              .arg(part.name);
                    break;
                }
            }
            d->parts.append(part);
        }
    }

    if (validationError.isEmpty()) {
        std::stable_sort(d->parts.begin(), d->parts.end(), [](const Part &left,
                                                              const Part &right) {
            return left.z < right.z;
        });
    }

    if (validationError.isEmpty() && d->atlas.isNull())
        validationError = QStringLiteral("source atlas could not be loaded");

    if (validationError.isEmpty()) {
        d->partLevels.reserve(d->parts.size());
        d->blinkLevels.reserve(d->parts.size());
        ImageCache &cache = imageCache();
        for (const Part &part : std::as_const(d->parts)) {
            if (!d->atlas.rect().contains(part.sourceRect)) {
                validationError = QStringLiteral("part '%1' sourceRect is outside the atlas")
                                          .arg(part.name);
                break;
            }
            const QString cropKey = d->sourceKey + QLatin1Char('#')
                    + QString::number(part.sourceRect.x()) + QLatin1Char(',')
                    + QString::number(part.sourceRect.y()) + QLatin1Char(',')
                    + QString::number(part.sourceRect.width()) + QLatin1Char(',')
                    + QString::number(part.sourceRect.height());
            const auto cached = cache.crops.constFind(cropKey);
            if (cached != cache.crops.cend()) {
                d->partLevels.append(*cached);
            } else {
                const QVector<QImage> levels = textureLevels(d->atlas.copy(part.sourceRect));
                cache.crops.insert(cropKey, levels);
                d->partLevels.append(levels);
            }
            if (part.blinkSourceRect.isNull()) {
                d->blinkLevels.append(QVector<QImage>{});
                continue;
            }
            if (!d->atlas.rect().contains(part.blinkSourceRect)) {
                validationError = QStringLiteral("part '%1' blinkSourceRect is outside the atlas")
                                          .arg(part.name);
                break;
            }
            const QString blinkKey = d->sourceKey + QLatin1String("#blink,")
                    + QString::number(part.blinkSourceRect.x()) + QLatin1Char(',')
                    + QString::number(part.blinkSourceRect.y()) + QLatin1Char(',')
                    + QString::number(part.blinkSourceRect.width()) + QLatin1Char(',')
                    + QString::number(part.blinkSourceRect.height());
            const auto blinkCached = cache.crops.constFind(blinkKey);
            if (blinkCached != cache.crops.cend()) {
                d->blinkLevels.append(*blinkCached);
            } else {
                const QVector<QImage> levels = textureLevels(
                        d->atlas.copy(part.blinkSourceRect));
                cache.crops.insert(blinkKey, levels);
                d->blinkLevels.append(levels);
            }
        }
    }

    if (!validationError.isEmpty()) {
        d->bones.clear();
        d->parts.clear();
        d->partLevels.clear();
        d->blinkLevels.clear();
        setStatus(false, validationError);
    } else {
        d->referenceSize = QSizeF(reference[0], reference[1]);
        setImplicitSize(d->referenceSize.width(), d->referenceSize.height());
        setStatus(true, {});
    }
    update();
}

void AvatarPuppet::itemChange(ItemChange change, const ItemChangeData &value)
{
    // A new pixel ratio can need a different texture level even when the
    // pose is static (reduced motion, previews).
    if (change == ItemDevicePixelRatioHasChanged)
        update();
    QQuickItem::itemChange(change, value);
}

QVariantMap AvatarPuppet::boneTransforms() const
{
    QVariantMap output;
    const QVector<AvatarSkeleton::Transform> transforms =
            AvatarSkeleton::worldTransforms(d->bones, d->pose);
    for (int index = 0; index < d->bones.size(); ++index) {
        const auto &transform = transforms[index];
        output.insert(d->bones[index].name,
                      QVariantList{transform.m11, transform.m12,
                                   transform.m21, transform.m22,
                                   transform.dx, transform.dy});
    }
    return output;
}

QSGNode *AvatarPuppet::updatePaintNode(QSGNode *oldNode, UpdatePaintNodeData *)
{
    if (!d->ready || !window() || width() <= 0.0 || height() <= 0.0) {
        delete oldNode;
        return nullptr;
    }

    const qreal scale = std::min(width() / d->referenceSize.width(),
                                 height() / d->referenceSize.height());
    // Sample each cutout from the smallest level that still has at least one
    // texel per device pixel, including any scaling applied by ancestors.
    bool mapped = false;
    const QTransform scene = itemTransform(nullptr, &mapped);
    const qreal sceneScale = mapped ? std::sqrt(std::abs(scene.determinant())) : 1.0;
    const qreal deviceScale = scale * window()->effectiveDevicePixelRatio()
            * (std::isfinite(sceneScale) && sceneScale > 0.0 ? sceneScale : 1.0);
    QVector<int> levels(d->parts.size(), 0);
    for (int index = 0; index < d->parts.size(); ++index) {
        const Part &part = d->parts[index];
        const qreal density = deviceScale
                * std::max(part.rect.width() / part.sourceRect.width(),
                           part.rect.height() / part.sourceRect.height());
        if (density > 0.0 && density < 1.0)
            levels[index] = std::min(int(std::floor(std::log2(1.0 / density))),
                                     int(d->partLevels[index].size()) - 1);
    }

    auto *root = dynamic_cast<PuppetNode *>(oldNode);
    if (!root || root->revision != d->revision || root->levels != levels) {
        delete oldNode;
        root = new PuppetNode;
        root->revision = d->revision;
        root->levels = levels;
        root->parts.reserve(d->parts.size());
        for (int index = 0; index < d->parts.size(); ++index) {
            const Part &part = d->parts[index];
            QSGTexture *texture = window()->createTextureFromImage(
                    d->partLevels[index][levels[index]]);
            if (!texture) {
                delete root;
                return nullptr;
            }
            texture->setFiltering(QSGTexture::Linear);

            auto *transformNode = new QSGTransformNode;
            auto *opacityNode = new QSGOpacityNode;
            QSGImageNode *imageNode = window()->createImageNode();
            imageNode->setTexture(texture);
            imageNode->setOwnsTexture(!part.surfaceMotion);
            imageNode->setFiltering(QSGTexture::Linear);
            // Level 0 is the crop itself; coarser levels hold it in their corner.
            const qreal divisor = qreal(1 << levels[index]);
            imageNode->setSourceRect(levels[index] == 0
                    ? QRectF(QPointF(), texture->textureSize())
                    : QRectF(0, 0, part.sourceRect.width() / divisor,
                             part.sourceRect.height() / divisor));
            imageNode->setRect(part.rect);
            imageNode->setTextureCoordinatesTransform(part.mirrorX
                    ? QSGImageNode::MirrorHorizontally : QSGImageNode::NoTransform);
            opacityNode->appendChildNode(imageNode);
            transformNode->appendChildNode(opacityNode);
            root->appendChildNode(transformNode);
            PuppetNode::RenderPart rendered;
            rendered.transform = transformNode;
            rendered.opacity = opacityNode;
            rendered.image = imageNode;
            rendered.part = index;
            rendered.surfaceOriginal = part.surfaceMotion ? texture : nullptr;
            root->parts.append(rendered);
        }
    }

    const QVector<AvatarSkeleton::Transform> bones =
            AvatarSkeleton::worldTransforms(d->bones, d->pose);
    const qreal originX = (width() - d->referenceSize.width() * scale) * 0.5;
    const qreal originY = height() - d->referenceSize.height() * scale;
    const AvatarSkeleton::Transform fit{scale, 0.0, 0.0, scale, originX, originY};

    for (PuppetNode::RenderPart &renderPart : root->parts) {
        const Part &part = d->parts[renderPart.part];
        renderPart.transform->setMatrix(matrixFor(AvatarSkeleton::compose(
                fit, AvatarSkeleton::compose(bones[part.bone], part.local))));
        qreal opacity = part.opacityChannel.isEmpty()
                ? 1.0 : AvatarSkeleton::channelValue(d->pose, part.opacityChannel);
        opacity = std::clamp(opacity, 0.0, 1.0);
        if (!part.visibilityChannel.isEmpty()) {
            const qreal value = AvatarSkeleton::channelValue(d->pose,
                                                              part.visibilityChannel);
            if (value < part.visibilityMin || value >= part.visibilityMax)
                opacity = 0.0;
        }
        renderPart.opacity->setOpacity(opacity);

        if (part.surfaceMotion) {
            ReferenceArt::Pose surfacePose;
            surfacePose.breathLift = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("breathLift")),
                    -2.0, 2.0);
            surfacePose.bodyTilt = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("bodyTilt")),
                    -4.0, 4.0);
            surfacePose.headTilt = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("headTilt")),
                    -9.0, 9.0);
            surfacePose.headX = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("headX")),
                    -3.0, 3.0);
            surfacePose.headY = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("headY")),
                    -3.0, 3.0);
            surfacePose.hipX = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("hipX")),
                    -2.5, 2.5);
            surfacePose.hipDrop = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("hipDrop")),
                    -3.0, 3.0);
            surfacePose.hairRotation = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("hairRotation")),
                    -2.0, 2.0);
            surfacePose.blink = std::clamp(std::max(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("blink")),
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("eyeClose"))),
                    0.0, 1.0);
            if (d->blinkLevels[renderPart.part].isEmpty())
                surfacePose.blink = 0.0;
            if (!renderPart.surfacePoseValid
                    || renderPart.surfacePose != surfacePose) {
                const bool rest = !ReferenceArt::hasDeformation(surfacePose)
                        && surfacePose.blink <= 0.0;
                if (rest) {
                    renderPart.image->setTexture(renderPart.surfaceOriginal);
                    delete renderPart.surfaceDynamic;
                    renderPart.surfaceDynamic = nullptr;
                } else {
                    const int level = levels[renderPart.part];
                    const QImage closed = d->blinkLevels[renderPart.part].isEmpty()
                            ? QImage() : d->blinkLevels[renderPart.part][level];
                    const QImage image = ReferenceArt::render(
                            d->partLevels[renderPart.part][level], closed,
                            part.rect, surfacePose,
                            QSizeF(part.sourceRect.width() / qreal(1 << level),
                                   part.sourceRect.height() / qreal(1 << level)));
                    QSGTexture *texture = window()->createTextureFromImage(image);
                    if (!texture)
                        continue;
                    texture->setFiltering(QSGTexture::Linear);
                    renderPart.image->setTexture(texture);
                    delete renderPart.surfaceDynamic;
                    renderPart.surfaceDynamic = texture;
                }
                renderPart.image->setFiltering(QSGTexture::Linear);
                renderPart.surfacePose = surfacePose;
                renderPart.surfacePoseValid = true;
            }
        }
    }
    // Joint-only updates must invalidate the software scene graph even after
    // the containing QQuickItem's entry translation has stopped changing.
    root->markDirty(QSGNode::DirtyForceUpdate);
    return root;
}
