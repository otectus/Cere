#pragma once

#include <opencv2/core.hpp>
#include <algorithm>

namespace AvatarInterpolation {

// Correspondence confidence chooses colour, not temporal coverage. Normalizing
// alpha by confidence makes an old opaque limb persist when its destination
// flow leaves the canvas, even just before the destination frame takes over.
inline cv::Vec4f blend(const cv::Vec4f &from, const cv::Vec4f &to,
                      float fromConfidence, float toConfidence, float time)
{
    const float coverage = (1 - time) * from[3] + time * to[3];
    const cv::Vec4f weighted = from * ((1 - time) * fromConfidence)
            + to * (time * toConfidence);
    cv::Vec4f result = weighted[3] > 1e-6f
            ? weighted * (coverage / weighted[3])
            : from * (1 - time) + to * time;
    result[3] = coverage;
    for (int channel = 0; channel < 3; ++channel)
        result[channel] = std::clamp(result[channel], 0.0f, coverage);
    return result;
}

} // namespace AvatarInterpolation
