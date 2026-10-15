#pragma once

#include <QSet>
#include <QVariantMap>

#include <cmath>

// Resolve artwork registration against one shared skeleton before it reaches
// either the motion sampler or the renderer. All output transforms stay rigid:
// proportions change rest geometry, never the animated scene-graph matrix.
namespace AvatarDefinition {

struct Result {
    QVariantMap definition;
    QString error;
};

inline Result resolve(const QVariantMap &base, const QVariantMap &artwork = {})
{
    QVariantMap result = base;
    for (auto it = artwork.cbegin(); it != artwork.cend(); ++it)
        result.insert(it.key(), it.value());

    auto bones = result.value("bones").toList();
    const auto overrideValue = result.take("boneOverrides");
    if (overrideValue.isValid() && overrideValue.metaType().id() != QMetaType::QVariantMap)
        return {{}, QStringLiteral("boneOverrides must be an object")};
    const auto overrides = overrideValue.toMap();
    QSet<QString> names;
    for (auto &value : bones) {
        auto bone = value.toMap();
        const auto name = bone.value("name").toString();
        names.insert(name);
        const auto registration = overrides.value(name).toMap();
        for (auto it = registration.cbegin(); it != registration.cend(); ++it) {
            // Artwork may register a joint, but cannot silently change the
            // shared hierarchy or its motion channels.
            if (it.key() != "x" && it.key() != "y")
                return {{}, QStringLiteral("bone override '%1' may only register x/y").arg(name)};
            bool ok = false;
            const qreal coordinate = it.value().toDouble(&ok);
            if (!ok || !std::isfinite(coordinate) || std::abs(coordinate) > 1000000)
                return {{}, QStringLiteral("invalid joint registration '%1'").arg(name)};
            bone.insert(it.key(), it.value());
        }
        value = bone;
    }
    for (auto it = overrides.cbegin(); it != overrides.cend(); ++it)
        if (!names.contains(it.key()) || it.value().metaType().id() != QMetaType::QVariantMap)
            return {{}, QStringLiteral("invalid bone override '%1'").arg(it.key())};

    const auto proportionValue = result.take("proportions");
    if (proportionValue.isValid() && proportionValue.metaType().id() != QMetaType::QVariantMap)
        return {{}, QStringLiteral("proportions must be an object")};
    const auto proportions = proportionValue.toMap();
    if (!proportions.isEmpty()) {
        const auto finite = [](const QVariant &value, qreal *out) {
            bool ok = false;
            *out = value.toDouble(&ok);
            return ok && std::isfinite(*out);
        };
        qreal sx, sy, cx, ground;
        if (!finite(proportions.value("bodyWidth"), &sx)
                || !finite(proportions.value("bodyHeight"), &sy)
                || !finite(proportions.value("centerX"), &cx)
                || !finite(proportions.value("groundY"), &ground)
                || sx < .5 || sx > 2 || sy < .5 || sy > 2
                || std::abs(cx) > 1000000 || std::abs(ground) > 1000000)
            return {{}, QStringLiteral("invalid avatar proportions")};

        // Preserve the entire head subtree, including expression overlays and
        // independent hair motion. Its attachment follows the shorter torso.
        const auto head = proportions.value("headBone").toString();
        if (head.isEmpty() || !names.contains(head))
            return {{}, QStringLiteral("proportions require a known head bone")};
        QSet<QString> preserved{head};
        for (int pass = 0; pass < bones.size(); ++pass) {
            const auto count = preserved.size();
            for (const auto &value : bones) {
                const auto bone = value.toMap();
                if (preserved.contains(bone.value("parent").toString()))
                    preserved.insert(bone.value("name").toString());
            }
            if (preserved.size() == count) break;
        }
        for (auto &value : bones) {
            auto bone = value.toMap();
            const auto parent = bone.value("parent").toString();
            if (!preserved.contains(parent)) {
                qreal x, y;
                if (!finite(bone.value("x", 0), &x) || !finite(bone.value("y", 0), &y))
                    return {{}, QStringLiteral("invalid bone coordinate")};
                bone["x"] = x * sx + (parent.isEmpty() ? cx * (1 - sx) : 0);
                bone["y"] = y * sy + (parent.isEmpty() ? ground * (1 - sy) : 0);
            }
            value = bone;
        }
        auto parts = result.value("parts").toList();
        for (auto &value : parts) {
            auto part = value.toMap();
            if (!preserved.contains(part.value("bone").toString())) {
                // A rect scales in its own rotated frame; unequal axes would
                // shear the artwork relative to its bone.
                qreal turn = 0;
                if (part.contains("rotation") && (!finite(part.value("rotation"), &turn)
                        || (turn != 0 && sx != sy)))
                    return {{}, QStringLiteral("rotated part '%1' needs uniform proportions").arg(part.value("name").toString())};
                auto rect = part.value("rect").toList();
                if (rect.size() != 4)
                    return {{}, QStringLiteral("part '%1' needs a four-coordinate rect").arg(part.value("name").toString())};
                for (int i = 0; i < 4; ++i) {
                    qreal coordinate;
                    if (!finite(rect[i], &coordinate))
                        return {{}, QStringLiteral("invalid part coordinate")};
                    rect[i] = coordinate * (i % 2 ? sy : sx);
                }
                part["rect"] = rect;
            }
            value = part;
        }
        result["parts"] = parts;
    }
    result["bones"] = bones;
    return {result, {}};
}

} // namespace AvatarDefinition
