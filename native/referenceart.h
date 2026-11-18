#pragma once

#include <QImage>
#include <QPair>
#include <QPointF>
#include <QRect>
#include <QRectF>
#include <QSizeF>
#include <QVector>

#include <algorithm>
#include <cmath>

// Small CPU-side deformation used by the connected reference illustration.
// It intentionally operates on premultiplied images so the software and RHI
// scene graphs receive the same single, ordinary texture.
namespace ReferenceArt {

struct Pose
{
    qreal breathLift = 0.0;
    qreal bodyTilt = 0.0;
    qreal headTilt = 0.0;
    qreal headX = 0.0;
    qreal headY = 0.0;
    qreal hipX = 0.0;
    qreal hipDrop = 0.0;
    qreal hairRotation = 0.0;
    qreal blink = 0.0;
    qreal wink = 0.0;

    bool operator==(const Pose &) const = default;
};

inline qreal finiteClamp(qreal value, qreal minimum, qreal maximum)
{
    return std::isfinite(value) ? std::clamp(value, minimum, maximum) : 0.0;
}

inline qreal smoothStep(qreal edge0, qreal edge1, qreal value)
{
    const qreal t = std::clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

inline bool hasDeformation(const Pose &pose)
{
    return pose.breathLift != 0.0 || pose.bodyTilt != 0.0
            || pose.headTilt != 0.0 || pose.headX != 0.0
            || pose.headY != 0.0 || pose.hipX != 0.0
            || pose.hipDrop != 0.0 || pose.hairRotation != 0.0;
}

inline quint32 mixColorLanes(quint32 left, quint32 right, int amount)
{
    constexpr quint32 lanes = 0x00ff00ff;
    return (((left & lanes) * (256 - amount)
             + (right & lanes) * amount + 0x00800080) >> 8) & lanes;
}

inline QPointF displacement(const QPointF &point, const QRectF &rect,
                            const Pose &pose)
{
    if (rect.width() <= 0.0 || rect.height() <= 0.0)
        return {};

    const qreal x = std::clamp((point.x() - rect.left()) / rect.width(), 0.0, 1.0);
    const qreal y = std::clamp((point.y() - rect.top()) / rect.height(), 0.0, 1.0);
    // Every contribution reaches zero with a smooth derivative at the soles.
    const qreal footPin = 1.0 - smoothStep(0.80, 1.0, y);
    const qreal head = (1.0 - smoothStep(0.27, 0.57, y)) * footPin;
    const qreal hair = (1.0 - smoothStep(0.04, 0.36, y)) * footPin;
    const qreal upperBody = (1.0 - smoothStep(0.24, 0.88, y)) * footPin;
    const qreal hips = smoothStep(0.48, 0.64, y)
            * (1.0 - smoothStep(0.76, 0.94, y)) * footPin;

    const qreal body = finiteClamp(pose.bodyTilt, -4.0, 4.0) / 4.0;
    const qreal breath = finiteClamp(pose.breathLift, -2.0, 2.0) / 2.0;
    const qreal headTurn = finiteClamp(pose.headTilt, -9.0, 9.0) / 9.0;
    const qreal headShiftX = finiteClamp(pose.headX, -3.0, 3.0) / 3.0;
    const qreal headShiftY = finiteClamp(pose.headY, -3.0, 3.0) / 3.0;
    const qreal hipShift = finiteClamp(pose.hipX, -2.5, 2.5) / 2.5;
    const qreal hipDrop = finiteClamp(pose.hipDrop, -3.0, 3.0) / 3.0;
    const qreal hairTurn = finiteClamp(pose.hairRotation, -2.0, 2.0) / 2.0;

    qreal dx = -0.78 * body * upperBody
            + 0.52 * headShiftX * head
            + 0.54 * headTurn * (0.56 - y) * head
            + 0.38 * hipShift * hips
            + 0.28 * hairTurn * (0.40 - y) * hair;
    qreal dy = 0.42 * breath * upperBody
            + 0.42 * headShiftY * head
            + 0.45 * headTurn * (x - 0.5) * head
            + 0.34 * hipDrop * hips
            - 0.24 * hairTurn * (x - 0.5) * hair;

    // Motion channels can be fed arbitrary values from QML. The individual
    // clamps above preserve their direction; this final radial bound makes the
    // combined surface contract explicit.
    constexpr qreal maximumDisplacement = 1.9;
    const qreal length = std::hypot(dx, dy);
    if (length > maximumDisplacement) {
        const qreal scale = maximumDisplacement / length;
        dx *= scale;
        dy *= scale;
    }
    return {dx, dy};
}

inline QImage blended(const QImage &open, const QImage &closed, qreal amount)
{
    const qreal blend = finiteClamp(amount, 0.0, 1.0);
    if (blend <= 0.0 || closed.isNull())
        return open;
    if (blend >= 1.0)
        return closed;

    QImage result(open.size(), QImage::Format_ARGB32_Premultiplied);
    const int weight = qRound(blend * 256.0);
    for (int y = 0; y < open.height(); ++y) {
        const QRgb *from = reinterpret_cast<const QRgb *>(open.constScanLine(y));
        const QRgb *to = reinterpret_cast<const QRgb *>(closed.constScanLine(y));
        QRgb *output = reinterpret_cast<QRgb *>(result.scanLine(y));
        for (int x = 0; x < open.width(); ++x) {
            output[x] = mixColorLanes(from[x], to[x], weight)
                    | (mixColorLanes(from[x] >> 8, to[x] >> 8, weight) << 8);
        }
    }
    return result;
}

struct WinkSelection
{
    QVector<quint8> pixels;
    // The authored open/closed difference contains either one visible eye or
    // two horizontally separated eye groups. Zero means there is no blink art.
    int eyeGroups = 0;
};

// Derive the eye to wink from the current authored open/closed pair. Dilation
// joins anti-aliased lid and iris fragments belonging to one eye; a substantial
// horizontal gap then separates two visible eyes. This stays avatar-agnostic
// and works for every selected gesture frame and mip level.
inline WinkSelection winkSelection(const QImage &open, const QImage &closed)
{
    WinkSelection result;
    if (open.isNull() || closed.isNull() || open.size() != closed.size())
        return result;
    const int width = open.width(), height = open.height(), count = width * height;
    QVector<quint8> changed(count, 0), expanded(count, 0);
    int changedCount = 0, changedLeft = width, changedRight = -1;
    for (int y = 0; y < height; ++y) {
        const QRgb *from = reinterpret_cast<const QRgb *>(open.constScanLine(y));
        const QRgb *to = reinterpret_cast<const QRgb *>(closed.constScanLine(y));
        for (int x = 0; x < width; ++x) {
            if (from[x] != to[x]) {
                changed[y * width + x] = 1;
                ++changedCount;
                changedLeft = std::min(changedLeft, x);
                changedRight = std::max(changedRight, x);
            }
        }
    }
    if (!changedCount)
        return result;

    const int radius = std::clamp(std::min(width, height) / 160, 1, 4);
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        if (!changed[y * width + x])
            continue;
        for (int yy = std::max(0, y - radius); yy <= std::min(height - 1, y + radius); ++yy)
            for (int xx = std::max(0, x - radius); xx <= std::min(width - 1, x + radius); ++xx)
                expanded[yy * width + xx] = 1;
    }

    struct Component { int area = 0; qint64 xTotal = 0; };
    QVector<int> labels(count, -1), queue;
    QVector<Component> components;
    for (int start = 0; start < count; ++start) {
        if (!expanded[start] || labels[start] >= 0)
            continue;
        const int label = components.size();
        components.append(Component{}); queue.clear(); queue.append(start); labels[start] = label;
        for (int cursor = 0; cursor < queue.size(); ++cursor) {
            const int at = queue[cursor], x = at % width, y = at / width;
            ++components[label].area; components[label].xTotal += x;
            for (int yy = std::max(0, y - 1); yy <= std::min(height - 1, y + 1); ++yy)
                for (int xx = std::max(0, x - 1); xx <= std::min(width - 1, x + 1); ++xx) {
                    const int next = yy * width + xx;
                    if (expanded[next] && labels[next] < 0) {
                        labels[next] = label; queue.append(next);
                    }
                }
        }
    }

    int largest = 0;
    for (const auto &component : components)
        largest = std::max(largest, component.area);
    QVector<QPair<qreal, int>> significant;
    for (int label = 0; label < components.size(); ++label) {
        const auto &component = components[label];
        if (component.area * 8 >= largest)
            significant.append(QPair<qreal, int>(
                    qreal(component.xTotal) / component.area, label));
    }
    std::sort(significant.begin(), significant.end(), [](const auto &left, const auto &right) {
        return left.first < right.first;
    });

    qreal split = -1.0, widestGap = 0.0;
    for (int index = 1; index < significant.size(); ++index) {
        const qreal gap = significant[index].first - significant[index - 1].first;
        if (gap > widestGap) {
            widestGap = gap;
            split = (significant[index].first + significant[index - 1].first) * 0.5;
        }
    }
    bool twoEyes = split >= 0.0
            && widestGap > std::max(qreal(radius * 2), width * 0.025);
    // Close-set authored eyes can have overlapping feathered eyelid regions,
    // producing one connected, horizontally wide difference component. A
    // single visible-eye edit occupies less than one eighth of its frame in
    // the packed reference art; two overlapping edits still exceed that span.
    if (!twoEyes && (changedRight - changedLeft + 1) * 8 > width) {
        twoEyes = true;
        split = (changedLeft + changedRight + 1) * 0.5;
    }
    result.eyeGroups = twoEyes ? 2 : 1;
    result.pixels.resize(count);
    if (!twoEyes) {
        result.pixels = changed;
        return result;
    }
    for (int index = 0; index < count; ++index)
        result.pixels[index] = changed[index] && index % width < split;
    return result;
}

inline QImage expressedEyes(const QImage &open, const QImage &closed,
                            qreal blinkAmount, qreal winkAmount,
                            const WinkSelection *preparedWink = nullptr)
{
    const qreal blink = finiteClamp(blinkAmount, 0.0, 1.0);
    const qreal wink = finiteClamp(winkAmount, 0.0, 1.0);
    if (wink <= blink || closed.isNull())
        return blended(open, closed, blink);
    WinkSelection derived;
    if (!preparedWink) {
        derived = winkSelection(open, closed);
        preparedWink = &derived;
    }
    if (preparedWink->eyeGroups == 0)
        return blended(open, closed, blink);

    QImage result(open.size(), QImage::Format_ARGB32_Premultiplied);
    const int blinkWeight = qRound(blink * 256.0);
    const int winkWeight = qRound(wink * 256.0);
    for (int y = 0; y < open.height(); ++y) {
        const QRgb *from = reinterpret_cast<const QRgb *>(open.constScanLine(y));
        const QRgb *to = reinterpret_cast<const QRgb *>(closed.constScanLine(y));
        QRgb *output = reinterpret_cast<QRgb *>(result.scanLine(y));
        for (int x = 0; x < open.width(); ++x) {
            const int weight = preparedWink->pixels[y * open.width() + x]
                    ? winkWeight : blinkWeight;
            output[x] = mixColorLanes(from[x], to[x], weight)
                    | (mixColorLanes(from[x] >> 8, to[x] >> 8, weight) << 8);
        }
    }
    return result;
}

inline QRgb bilinear(const QImage &image, qreal x, qreal y)
{
    const int x0 = int(std::floor(x));
    const int y0 = int(std::floor(y));
    const int fx = std::clamp(qRound((x - x0) * 256.0), 0, 256);
    const int fy = std::clamp(qRound((y - y0) * 256.0), 0, 256);
    const auto pixel = [&](int px, int py) -> QRgb {
        if (px < 0 || py < 0 || px >= image.width() || py >= image.height())
            return QRgb(0);
        return reinterpret_cast<const QRgb *>(image.constScanLine(py))[px];
    };
    QRgb topLeft;
    QRgb topRight;
    QRgb bottomLeft;
    QRgb bottomRight;
    if (x0 >= 0 && y0 >= 0 && x0 + 1 < image.width()
            && y0 + 1 < image.height()) {
        const QRgb *top = reinterpret_cast<const QRgb *>(image.constScanLine(y0));
        const QRgb *bottom = reinterpret_cast<const QRgb *>(image.constScanLine(y0 + 1));
        topLeft = top[x0];
        topRight = top[x0 + 1];
        bottomLeft = bottom[x0];
        bottomRight = bottom[x0 + 1];
    } else {
        topLeft = pixel(x0, y0);
        topRight = pixel(x0 + 1, y0);
        bottomLeft = pixel(x0, y0 + 1);
        bottomRight = pixel(x0 + 1, y0 + 1);
    }
    const quint32 topRedBlue = mixColorLanes(topLeft, topRight, fx);
    const quint32 bottomRedBlue = mixColorLanes(bottomLeft, bottomRight, fx);
    const quint32 topAlphaGreen = mixColorLanes(topLeft >> 8, topRight >> 8, fx);
    const quint32 bottomAlphaGreen = mixColorLanes(bottomLeft >> 8, bottomRight >> 8, fx);
    return mixColorLanes(topRedBlue, bottomRedBlue, fy)
            | (mixColorLanes(topAlphaGreen, bottomAlphaGreen, fy) << 8);
}

inline QImage render(const QImage &open, const QImage &closed,
                     const QRectF &rect, const Pose &pose,
                     const QSizeF &contentSize = {},
                     const WinkSelection *preparedWink = nullptr)
{
    const QImage source = expressedEyes(open, closed, pose.blink, pose.wink,
                                        preparedWink);
    if (!hasDeformation(pose))
        return source;

    QImage result(source.size(), QImage::Format_ARGB32_Premultiplied);
    result.fill(Qt::transparent);
    const qreal contentWidth = contentSize.width() > 0.0
            ? contentSize.width() : source.width();
    const qreal contentHeight = contentSize.height() > 0.0
            ? contentSize.height() : source.height();
    const qreal logicalPerPixelX = rect.width() / contentWidth;
    const qreal logicalPerPixelY = rect.height() / contentHeight;
    const int outputWidth = std::min(result.width(), int(std::ceil(contentWidth)));
    const int outputHeight = std::min(result.height(), int(std::ceil(contentHeight)));
    // The displacement field varies over anatomical regions tens of pixels
    // tall. Evaluate the inverse map on a small regular grid, then interpolate
    // source coordinates while still bilinearly producing every output pixel.
    // This keeps full selected-mip detail without repeating smooth-step math
    // hundreds of thousands of times per frame.
    constexpr int gridStep = 7;
    const int gridColumns = (outputWidth - 1) / gridStep + 2;
    const int gridRows = (outputHeight - 1) / gridStep + 2;
    QVector<QPointF> inverseGrid(gridColumns * gridRows);
    for (int row = 0; row < gridRows; ++row) {
        const int y = std::min(row * gridStep, outputHeight - 1);
        for (int column = 0; column < gridColumns; ++column) {
            const int x = std::min(column * gridStep, outputWidth - 1);
            const QPointF destination(rect.left() + (x + 0.5) * logicalPerPixelX,
                                      rect.top() + (y + 0.5) * logicalPerPixelY);
            QPointF sample = destination;
            for (int iteration = 0; iteration < 2; ++iteration)
                sample = destination - displacement(sample, rect, pose);
            inverseGrid[row * gridColumns + column] = {
                (sample.x() - rect.left()) / logicalPerPixelX - 0.5,
                (sample.y() - rect.top()) / logicalPerPixelY - 0.5};
        }
    }
    for (int y = 0; y < outputHeight; ++y) {
        QRgb *output = reinterpret_cast<QRgb *>(result.scanLine(y));
        const int gridY = std::min(y / gridStep, gridRows - 2);
        const int y0 = std::min(gridY * gridStep, outputHeight - 1);
        const int y1 = std::min((gridY + 1) * gridStep, outputHeight - 1);
        const qreal fy = y1 == y0 ? 0.0 : qreal(y - y0) / (y1 - y0);
        for (int gridX = 0; gridX < gridColumns - 1; ++gridX) {
            const int x0 = std::min(gridX * gridStep, outputWidth - 1);
            const int x1 = std::min((gridX + 1) * gridStep, outputWidth - 1);
            if (x1 == x0 && gridX + 1 < gridColumns - 1)
                continue;
            const QPointF start = inverseGrid[gridY * gridColumns + gridX]
                    * (1.0 - fy)
                    + inverseGrid[(gridY + 1) * gridColumns + gridX] * fy;
            const QPointF end = inverseGrid[gridY * gridColumns + gridX + 1]
                    * (1.0 - fy)
                    + inverseGrid[(gridY + 1) * gridColumns + gridX + 1] * fy;
            const int span = std::max(1, x1 - x0);
            const QPointF increment = (end - start) / span;
            const int limit = gridX + 1 == gridColumns - 1 ? x1 + 1 : x1;
            QPointF sample = start;
            for (int x = x0; x < limit; ++x, sample += increment)
                output[x] = bilinear(source, sample.x(), sample.y());
        }
    }
    return result;
}

} // namespace ReferenceArt
