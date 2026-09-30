#pragma once

#include <QPointF>
#include <QString>
#include <QVariantMap>
#include <QVector>

#include <algorithm>
#include <cmath>

// Deterministic rigid-transform math shared by AvatarPuppet and its tests.
// Transform composition follows column-vector order: compose(a, b) maps a
// point through b first and then through a.
namespace AvatarSkeleton {

constexpr qreal maximumOffset = 1000000.0;

struct Transform
{
    qreal m11 = 1.0;
    qreal m12 = 0.0;
    qreal m21 = 0.0;
    qreal m22 = 1.0;
    qreal dx = 0.0;
    qreal dy = 0.0;

    QPointF map(const QPointF &point) const
    {
        return {m11 * point.x() + m12 * point.y() + dx,
                m21 * point.x() + m22 * point.y() + dy};
    }
};

struct Bone
{
    QString name;
    int parent = -1;
    qreal x = 0.0;
    qreal y = 0.0;
    QString angleChannel;
    QString offsetXChannel;
    QString offsetYChannel;
};

inline Transform compose(const Transform &parent, const Transform &local)
{
    return {
        parent.m11 * local.m11 + parent.m12 * local.m21,
        parent.m11 * local.m12 + parent.m12 * local.m22,
        parent.m21 * local.m11 + parent.m22 * local.m21,
        parent.m21 * local.m12 + parent.m22 * local.m22,
        parent.m11 * local.dx + parent.m12 * local.dy + parent.dx,
        parent.m21 * local.dx + parent.m22 * local.dy + parent.dy
    };
}

inline qreal channelValue(const QVariantMap &pose, const QString &channel,
                          bool angle = false)
{
    if (channel.isEmpty())
        return 0.0;
    bool ok = false;
    qreal value = pose.value(channel).toDouble(&ok);
    if (!ok || !std::isfinite(value))
        return 0.0;
    if (angle)
        return std::remainder(value, 360.0);
    return std::clamp(value, -maximumOffset, maximumOffset);
}

inline Transform localTransform(const Bone &bone, const QVariantMap &pose)
{
    constexpr qreal pi = 3.14159265358979323846;
    const qreal radians = channelValue(pose, bone.angleChannel, true) * pi / 180.0;
    const qreal cosine = std::cos(radians);
    const qreal sine = std::sin(radians);
    return {cosine, -sine, sine, cosine,
            bone.x + channelValue(pose, bone.offsetXChannel),
            bone.y + channelValue(pose, bone.offsetYChannel)};
}

inline QVector<Transform> worldTransforms(const QVector<Bone> &bones,
                                          const QVariantMap &pose)
{
    QVector<Transform> result;
    result.reserve(bones.size());
    for (const Bone &bone : bones) {
        const Transform local = localTransform(bone, pose);
        result.append(bone.parent < 0 ? local
                                     : compose(result.at(bone.parent), local));
    }
    return result;
}

inline bool isFinite(const Transform &transform)
{
    return std::isfinite(transform.m11) && std::isfinite(transform.m12)
            && std::isfinite(transform.m21) && std::isfinite(transform.m22)
            && std::isfinite(transform.dx) && std::isfinite(transform.dy);
}

} // namespace AvatarSkeleton
