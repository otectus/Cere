#pragma once

#include "avatar-registration.h"
#include <array>
#include <opencv2/imgcodecs.hpp>

// Register recurring painted details to the neutral illustration while allowing
// the head to turn, the arms to gesture and the carried legs to swing.
namespace AvatarAppearance {

using AvatarRegistration::smooth;

inline cv::Mat premultiplied(const cv::Mat &image) {
    cv::Mat result = image.clone();
    for (auto &p : cv::Mat_<cv::Vec4b>(result))
        for (int c = 0; c < 3; ++c)
            p[c] = (p[c] * p[3] + 127) / 255;
    return result;
}

inline cv::Mat resize(const cv::Mat &image, cv::Size size, int method) {
    cv::Mat result;
    cv::resize(image, result, size, 0, 0, method);
    return result;
}

inline cv::Mat coordinates(cv::Size size) {
    cv::Mat result(size, CV_32FC2);
    for (int y = 0; y < size.height; ++y)
        for (int x = 0; x < size.width; ++x)
            result.at<cv::Vec2f>(y, x) = {float(x), float(y)};
    return result;
}

// Track the head as a unit before estimating redraw drift. For example, a
// carried pose can move the whole head sideways while its ears stay attached.
inline cv::Point2f locateHead(const cv::Mat &ref, const cv::Mat &source, cv::Rect head,
                              const cv::Mat &grayRef) {
    const cv::Rect canvas(0, 0, ref.cols, ref.rows);
    const int reach = ref.cols / 5;
    const cv::Rect search = (head + cv::Size(2 * reach, 2 * reach) - cv::Point(reach, reach)) & canvas;
    cv::Mat scores;
    cv::matchTemplate(AvatarRegistration::gray(source)(search), grayRef(head), scores,
                      cv::TM_CCOEFF_NORMED);
    cv::Point best;
    cv::minMaxLoc(scores, nullptr, nullptr, nullptr, &best);
    return cv::Point2f(best + search.tl() - head.tl());
}

inline cv::Mat remap(const cv::Mat &source, const cv::Mat &map) {
    cv::Mat result;
    cv::remap(source, result, map, cv::Mat(), cv::INTER_LINEAR);
    return result;
}

inline cv::Mat straight(const cv::Mat &premul) {
    cv::Mat result = premul.clone();
    for (auto &p : cv::Mat_<cv::Vec4b>(result))
        if (p[3] && p[3] < 255)
            for (int c = 0; c < 3; ++c)
                p[c] = cv::saturate_cast<uchar>((p[c] * 255 + p[3] / 2) / p[3]);
    return result;
}

// Learn colour offsets from opaque, corresponding regions. Group by material
// colour so a pinker hair highlight cannot tint the face or a black boot.
constexpr int bins = 5;
using Palette = std::array<cv::Vec3f, bins * bins * bins>;
inline int bin(int b, int g, int r) { return (b * bins + g) * bins + r; }

inline Palette lighting(const cv::Mat &ref, const cv::Mat &aligned, const cv::Mat &reliability) {
    using Samples = std::array<std::vector<int>, 3>;
    std::array<Samples, bins * bins * bins> samples;
    for (int y = 0; y < ref.rows; ++y)
        for (int x = 0; x < ref.cols; ++x) {
            auto a = ref.at<cv::Vec4b>(y, x), b = aligned.at<cv::Vec4b>(y, x);
            if (a[3] < 250 || b[3] < 250 || reliability.at<float>(y, x) < .5f)
                continue;
            auto &group =
                samples[bin(cvRound(b[0] * (bins - 1) / 255.), cvRound(b[1] * (bins - 1) / 255.),
                            cvRound(b[2] * (bins - 1) / 255.))];
            for (int c = 0; c < 3; ++c)
                group[c].push_back(a[c] - b[c]);
        }
    Palette median{}, result{};
    for (size_t i = 0; i < samples.size(); ++i)
        for (int c = 0; c < 3; ++c) {
            auto &v = samples[i][c];
            if (v.empty())
                continue;
            auto mid = v.begin() + v.size() / 2;
            std::nth_element(v.begin(), mid, v.end());
            median[i][c] = std::clamp(*mid, -40, 40);
        }
    for (int i = 0; i < int(result.size()); ++i) {
        float total = 0;
        for (int j = 0; j < int(samples.size()); ++j) {
            int db = i / (bins * bins) - j / (bins * bins), dg = i / bins % bins - j / bins % bins,
                dr = i % bins - j % bins;
            float w = std::exp(-1.1f * (db * db + dg * dg + dr * dr)) *
                      std::min(1.f, samples[j][0].size() / 35.f);
            total += w;
            result[i] += w * median[j];
        }
        result[i] *= 1 / std::max(total, .15f);
    }
    return result;
}

inline cv::Vec3f correction(cv::Vec4b p, const Palette &palette) {
    int lo[3];
    float f[3];
    for (int c = 0; c < 3; ++c) {
        float n = p[c] * ((bins - 1) / 255.f);
        lo[c] = std::min(bins - 2, int(n));
        f[c] = n - lo[c];
    }
    cv::Vec3f value{};
    for (int b = 0; b <= 1; ++b)
        for (int g = 0; g <= 1; ++g)
            for (int r = 0; r <= 1; ++r)
                value += palette[bin(lo[0] + b, lo[1] + g, lo[2] + r)] *
                         ((b ? f[0] : 1 - f[0]) * (g ? f[1] : 1 - f[1]) * (r ? f[2] : 1 - f[2]));
    return value;
}

struct Drawing {
    cv::Mat open, closed;
    cv::Point2f shift{};
    float turn = 0;
};

inline float length(cv::Vec2f v) { return std::sqrt(v.dot(v)); }

// Bound the gradient of the inverse map. In particular, no adjacent samples
// may reverse order or tear a thin lock of hair when DIS encounters occlusion.
inline void limitGradient(cv::Mat &field) {
    float maximum = 0;
    for (int y = 1; y < field.rows; ++y)
        for (int x = 1; x < field.cols; ++x) {
            const auto v = field.at<cv::Vec2f>(y, x);
            const auto dx = v - field.at<cv::Vec2f>(y, x - 1), dy = v - field.at<cv::Vec2f>(y - 1, x);
            maximum = std::max(maximum, std::sqrt(dx.dot(dx) + dy.dot(dy)));
        }
    if (maximum > .64f)
        field *= .64f / maximum;
}

inline cv::Mat paint(const cv::Mat &source, const cv::Mat &map, const Palette &palette,
                     const cv::Mat &localLight) {
    cv::Mat result = straight(remap(premultiplied(source), map));
    for (int y = 0; y < result.rows; ++y)
        for (int x = 0; x < result.cols; ++x) {
            auto &pixel = result.at<cv::Vec4b>(y, x);
            // Preserve subpixel contours (including the authored matte) exactly
            // wherever registration selects an integer source coordinate.
            if (map.at<cv::Vec2f>(y, x) == cv::Vec2f(x, y))
                pixel = source.at<cv::Vec4b>(y, x);
            if (!pixel[3])
                continue;
            const auto offset = correction(pixel, palette) + localLight.at<cv::Vec3f>(y, x);
            for (int c = 0; c < 3; ++c) {
                const float midtone = std::min({1.f, pixel[c] / 24.f, (255 - pixel[c]) / 24.f});
                pixel[c] = cv::saturate_cast<uchar>(pixel[c] + midtone * offset[c]);
            }
        }
    return result;
}

// Estimate only the broad change in illumination. Copying the reference RGB
// at individual pixels can draw a second hairline across a turned forehead.
inline cv::Mat localIllumination(const cv::Mat &reference, const cv::Mat &aligned,
                                 const cv::Mat &weights, const Palette &palette) {
    cv::Mat bias(reference.size(), CV_32FC3, cv::Scalar(0, 0, 0));
    for (int y = 0; y < bias.rows; ++y)
        for (int x = 0; x < bias.cols; ++x) {
            const auto a = reference.at<cv::Vec4b>(y, x), b = aligned.at<cv::Vec4b>(y, x);
            if (std::min(a[3], b[3]) < 240)
                continue;
            const auto offset = correction(b, palette);
            cv::Vec3f delta;
            for (int c = 0; c < 3; ++c)
                delta[c] = a[c] - b[c] - offset[c];
            const float difference =
                std::max({std::abs(delta[0]), std::abs(delta[1]), std::abs(delta[2])});
            bias.at<cv::Vec3f>(y, x) =
                delta * (1 - smooth(15, 45, difference)) * weights.at<float>(y, x);
        }
    cv::GaussianBlur(bias, bias, {}, 4);
    return bias;
}

// Keep the canvas edge and the planted sole fixed. Taper both axes so even a
// thin, antialiased toe retains its coverage after subpixel registration.
inline void protectMargins(cv::Mat &field, float ground, bool carry) {
    for (int y = 0; y < field.rows; ++y)
        for (int x = 0; x < field.cols; ++x) {
            auto &v = field.at<cv::Vec2f>(y, x);
            v[0] *= smooth(1, 12, std::min(x, field.cols - 1 - x));
            v[1] *= smooth(1, 12, std::min(y, field.rows - 1 - y));
            if (!carry)
                v *= 1 - smooth(ground / 2 - 12, ground / 2 - 4, y);
        }
}

// Fit a smooth head path through the registered key drawings. Penalize sudden
// acceleration while retaining neutral, held expressions and their reviewed
// eye coordinates exactly. Carry applies the correction to the suspended body.
inline cv::Mat headPath(const std::vector<Drawing> &frames) {
    const int count = int(frames.size()) + 1;
    cv::Mat a = cv::Mat::eye(count, count, CV_64F), values = cv::Mat::zeros(count, 3, CV_64F);
    for (int i = 1; i < count; ++i) {
        const auto &frame = frames[i - 1];
        values.at<double>(i, 0) = frame.shift.x;
        values.at<double>(i, 1) = frame.shift.y;
        values.at<double>(i, 2) = frame.turn;
    }
    for (int i = 1; i < count - 1; ++i) {
        const double difference[] = {1, -2, 1};
        for (int j = 0; j < 3; ++j)
            for (int k = 0; k < 3; ++k)
                a.at<double>(i + j - 1, i + k - 1) += 18 * difference[j] * difference[k];
    }
    for (int i = 0; i < count; ++i)
        if (i == 0 || i == count - 1 || !frames[i - 1].closed.empty()) {
            a.row(i).setTo(0);
            a.at<double>(i, i) = 1;
        }
    cv::Mat path;
    if (!cv::solve(a, values, path))
        throw std::runtime_error("singular head path");
    return path;
}

inline void stabilize(const cv::Mat &neutral, std::vector<Drawing> &frames, cv::Point2f eyes,
                      float ground, bool carry) {
    const cv::Size small(neutral.cols / 2, neutral.rows / 2);
    const auto ref = resize(neutral, small, cv::INTER_AREA);
    const auto grayRef = AvatarRegistration::gray(ref);
    const auto base = coordinates(small), fullBase = coordinates(neutral.size());
    cv::Mat alpha;
    cv::extractChannel(ref, alpha, 3);
    int left = small.width, right = -1, top = small.height, bottom = -1;
    for (int y = 0; y < std::min(small.height, int(eyes.y / 2 + 4)); ++y)
        for (int x = 0; x < small.width; ++x) {
            if (alpha.at<uchar>(y, x) <= 180)
                continue;
            left = std::min(left, x);
            right = std::max(right, x);
            top = std::min(top, y);
            bottom = y;
        }
    if (right < left)
        throw std::runtime_error("missing painted head");
    const cv::Rect head(left, top, right - left + 1, bottom - top + 1);
    const cv::Point2f pivot(head.x + head.width * .5f, eyes.y / 2);
    const auto dis = cv::DISOpticalFlow::create(cv::DISOpticalFlow::PRESET_FAST);
    dis->setFinestScale(0);
    cv::Mat lids(small, CV_8U, cv::Scalar(0));
    for (auto &frame : frames) {
        const auto reduced = resize(frame.open, small, cv::INTER_AREA);
        auto shift = locateHead(ref, reduced, head, grayRef);
        // A robust similarity captures authored rotation. Keep the neutral
        // scale to correct frame-to-frame changes in head size.
        cv::Mat flow, shiftedMap = base + cv::Scalar(shift.x, shift.y);
        const auto shifted = remap(reduced, shiftedMap);
        dis->calc(grayRef, AvatarRegistration::gray(shifted), flow);
        const auto transform = AvatarRegistration::fit(ref, shifted, flow, head);
        const auto eye = transform.map(pivot) + shift;
        frame.shift = eye - pivot;
        frame.turn = std::clamp(float(std::atan2(transform.turn, transform.scale)), -.5f, .5f);
        if (!frame.closed.empty()) {
            cv::Mat changed;
            cv::absdiff(frame.open, frame.closed, changed);
            std::vector<cv::Mat> channels;
            cv::split(changed, channels);
            for (int c = 0; c < 3; ++c)
                lids.setTo(255, resize(channels[c], small, cv::INTER_AREA) > 0);
        }
    }
    cv::dilate(lids, lids, cv::Mat(), {-1, -1}, 5);
    const auto neutralPm = premultiplied(neutral);
    const auto path = headPath(frames);
    for (int i = 0; i < int(frames.size()); ++i) {
        auto &frame = frames[i];
        const auto shift = frame.shift;
        const float turn = frame.turn;
        const auto fixed = !frame.closed.empty() || i == int(frames.size()) - 1;
        const cv::Point2f target(fixed ? shift.x : path.at<double>(i + 1, 0),
                                 fixed ? shift.y : path.at<double>(i + 1, 1));
        const float dampedTurn = fixed ? turn : path.at<double>(i + 1, 2);
        cv::Mat displacement(small, CV_32FC2);
        for (int y = 0; y < small.height; ++y)
            for (int x = 0; x < small.width; ++x) {
                const auto p = cv::Point2f(x, y) - pivot - shift;
                const cv::Point2f rotated(std::cos(turn) * p.x + std::sin(turn) * p.y,
                                          -std::sin(turn) * p.x + std::cos(turn) * p.y);
                const float upper =
                    1 - smooth(eyes.y / 2 + 6, eyes.y / 2 + (ground - eyes.y) * .33f, y);
                displacement.at<cv::Vec2f>(y, x) =
                    cv::Vec2f(rotated + pivot - cv::Point2f(x, y)) * upper;
            }
        const auto reference = straight(
            remap(neutralPm, fullBase + 2 * resize(displacement, neutral.size(), cv::INTER_LINEAR)));
        const auto expected = resize(reference, small, cv::INTER_AREA);
        const auto source = resize(frame.open, small, cv::INTER_AREA);
        cv::Mat flow, backward;
        const auto a = AvatarRegistration::gray(expected), b = AvatarRegistration::gray(source);
        dis->calc(a, b, flow);
        dis->calc(b, a, backward);
        const cv::Mat match = base + flow, reverse = remap(backward, match),
                      aligned = remap(source, match);
        cv::Mat reliability(small, CV_32F), weights(small, CV_32F);
        for (int y = 0; y < small.height; ++y)
            for (int x = 0; x < small.width; ++x) {
                auto &v = flow.at<cv::Vec2f>(y, x);
                const float consistency = 1 - smooth(1, 5, length(v + reverse.at<cv::Vec2f>(y, x)));
                reliability.at<float>(y, x) = consistency;
                const float h = (y - pivot.y - shift.y) / ((ground - eyes.y) / 2);
                const float side = std::abs(x - pivot.x - shift.x) / ((ground - eyes.y) / 2);
                const float scalp = 1 - smooth(-.10f, .015f, h);
                const float legs =
                    carry ? 0.f : smooth(.45f, .7f, (2 * y - eyes.y) / (ground - eyes.y));
                const float face = (1 - smooth(.19f, .32f, side)) * smooth(-.15f, -.03f, h) *
                                   (1 - smooth(.14f, .22f, h));
                const float rest = std::max(scalp, legs);
                const float smallMotion =
                    (1 - smooth(3, 10, length(v))) * (carry ? (1 - smooth(.12f, .3f, h)) : 1.f);
                const float weight = std::max(rest, smallMotion * .8f) * (1 - face) * consistency;
                weights.at<float>(y, x) = weight;
                v *= weight * std::min(1.f, 12.f / std::max(1.f, length(v)));
            }
        const auto palette = lighting(expected, aligned, reliability);
        cv::GaussianBlur(flow, flow, {}, 2.4);
        cv::GaussianBlur(weights, weights, {}, 1.5);
        for (int y = 0; y < small.height; ++y)
            for (int x = 0; x < small.width; ++x) {
                auto &v = flow.at<cv::Vec2f>(y, x);
                if (lids.at<uchar>(y, x)) {
                    v = {0, 0};
                    weights.at<float>(y, x) = 0;
                }
            }
        protectMargins(flow, ground, carry);
        limitGradient(flow);
        // Compose the path correction with the detail registration before
        // sampling the drawing. Correct the whole upper body as a connected
        // surface. At the floor the map is the identity.
        cv::Mat placement(small, CV_32FC2);
        const float angle = turn - dampedTurn, cosine = std::cos(angle), sine = std::sin(angle);
        for (int y = 0; y < small.height; ++y)
            for (int x = 0; x < small.width; ++x) {
                const auto p = cv::Point2f(x, y) - pivot - target;
                const cv::Point2f rotated(cosine * p.x - sine * p.y, sine * p.x + cosine * p.y);
                const float upper = carry ? 1.f : 1 - smooth(pivot.y + 8, ground / 2 - 6, y);
                placement.at<cv::Vec2f>(y, x) =
                    fixed ? cv::Vec2f{} : cv::Vec2f(rotated - p + shift - target) * upper;
            }
        protectMargins(placement, ground, carry);
        limitGradient(placement);
        const cv::Mat global = fullBase + 2 * resize(placement, neutral.size(), cv::INTER_LINEAR);
        const cv::Mat map = global + remap(2 * resize(flow, neutral.size(), cv::INTER_LINEAR), global);
        const auto localLight = remap(resize(localIllumination(expected, aligned, weights, palette),
                                             neutral.size(), cv::INTER_LINEAR),
                                      global);
        frame.open = paint(frame.open, map, palette, localLight);
        if (!frame.closed.empty())
            frame.closed = paint(frame.closed, map, palette, localLight);
    }
}

} // namespace AvatarAppearance
