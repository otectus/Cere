#pragma once

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/video/tracking.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

// Offline registration of a complete authored drawing. The inverse map changes
// coordinates, never mixes a posed torso with pixels from a different pair of
// legs. Runtime frames consequently remain a single connected illustration.
namespace AvatarRegistration {

struct Similarity {
    double scale = 1, turn = 0, x = 0, y = 0;
    cv::Point2f map(cv::Point2f p) const {
        return {float(scale * p.x - turn * p.y + x),
                float(turn * p.x + scale * p.y + y)};
    }
};

inline float smooth(float a, float b, float value) {
    const float t = std::clamp((value - a) / (b - a), 0.f, 1.f);
    return t * t * (3 - 2 * t);
}

inline cv::Mat gray(const cv::Mat &image) {
    cv::Mat result(image.size(), CV_8UC1);
    for (int y = 0; y < image.rows; ++y) for (int x = 0; x < image.cols; ++x) {
        const auto p = image.at<cv::Vec4b>(y, x);
        const float alpha = p[3] / 255.f;
        result.at<uchar>(y, x) = cv::saturate_cast<uchar>(
            (p[0] * .114 + p[1] * .587 + p[2] * .299) * alpha + 128 * (1 - alpha));
    }
    return result;
}

inline Similarity fit(const cv::Mat &reference, const cv::Mat &source,
                      const cv::Mat &flow, cv::Rect region) {
    struct Match { cv::Point2f from, to; double weight = 1; };
    std::vector<Match> matches;
    region &= cv::Rect(0, 0, reference.cols, reference.rows);
    for (int y = region.y; y < region.br().y; y += 2)
        for (int x = region.x; x < region.br().x; x += 2) {
            const cv::Point2f from(x, y), to = from + cv::Point2f(flow.at<cv::Vec2f>(y, x));
            if (reference.at<cv::Vec4b>(y, x)[3] < 220 || to.x < 1 || to.y < 1
                    || to.x >= source.cols - 1 || to.y >= source.rows - 1
                    || source.at<cv::Vec4b>(int(to.y), int(to.x))[3] < 220) continue;
            matches.push_back({from, to});
        }
    if (matches.size() < 20) throw std::runtime_error("insufficient body registration landmarks");

    Similarity result;
    // Huber reweighting stops a moving hand or changed expression from dragging
    // the head fit. A similarity keeps the head's aspect ratio intact.
    for (int iteration = 0; iteration < 6; ++iteration) {
        cv::Mat a = cv::Mat::zeros(4, 4, CV_64F), b = cv::Mat::zeros(4, 1, CV_64F);
        for (const auto &p : matches) {
            const double rows[2][4]{{p.from.x, -p.from.y, 1, 0}, {p.from.y, p.from.x, 0, 1}};
            for (int k = 0; k < 2; ++k) for (int i = 0; i < 4; ++i) {
                b.at<double>(i) += rows[k][i] * (k ? p.to.y : p.to.x) * p.weight;
                for (int j = 0; j < 4; ++j) a.at<double>(i, j) += rows[k][i] * rows[k][j] * p.weight;
            }
        }
        cv::Mat values;
        if (!cv::solve(a, b, values, cv::DECOMP_SVD)) throw std::runtime_error("singular body registration");
        result = {values.at<double>(0), values.at<double>(1), values.at<double>(2), values.at<double>(3)};
        for (auto &p : matches) {
            const double error = cv::norm(p.to - result.map(p.from));
            p.weight = error <= 3 ? 1 : 3 / error;
        }
    }
    if (!std::isfinite(result.scale) || !std::isfinite(result.turn)
            || !std::isfinite(result.x) || !std::isfinite(result.y)
            || result.scale < .6 || result.scale > 1.65 || std::abs(result.turn) > .65)
        throw std::runtime_error("body registration exceeds supported proportions");
    return result;
}

inline std::pair<int, int> verticalBounds(const cv::Mat &image) {
    int top = image.rows, ground = -1;
    for (int y = 0; y < image.rows; ++y) for (int x = 0; x < image.cols; ++x)
        if (image.at<cv::Vec4b>(y, x)[3] > 180) { top = std::min(top, y); ground = y; }
    if (ground <= top) throw std::runtime_error("empty registration image");
    return {top, ground};
}

inline std::pair<double, double> soleMoments(const cv::Mat &image, int ground) {
    double mass = 0, sum = 0, squares = 0;
    // The sole band locates actual feet, including dark boots. Dense color flow
    // can mistake a patterned skirt/cape for a shin and pull the ankle sideways.
    for (int y = std::max(0, ground - 12); y <= ground; ++y)
        for (int x = 0; x < image.cols; ++x) {
            const double weight = image.at<cv::Vec4b>(y, x)[3] / 255.0;
            mass += weight; sum += weight * x; squares += weight * x * x;
        }
    if (mass < 2) throw std::runtime_error("missing sole registration");
    const double mean = sum / mass, variance = squares / mass - mean * mean;
    if (variance <= 0) throw std::runtime_error("degenerate sole registration");
    return {mean, std::sqrt(variance)};
}

struct Registration {
    Similarity head;
    cv::Matx23f body{1, 0, 0, 0, 1, 0};
    float eye = 0, top = 0, ground = 0, sourceGround = 0;
    bool grounded = true;

    cv::Point2f map(cv::Point2f p) const {
        const auto a = head.map(p);
        if (!grounded) return a; // The complete suspended body follows its head.
        const cv::Point2f b(body(0, 0) * p.x + body(0, 1) * p.y + body(0, 2),
                            body(1, 0) * p.x + body(1, 1) * p.y + body(1, 2));
        // Only the neck bridges two registrations. The torso, hips and legs
        // share one affine map: straight limbs cannot become S-shaped, and a
        // separate hip/ankle fit cannot pull the two sides of a joint apart.
        const float u = smooth(eye + (eye - top) * .15f, eye + (eye - top) * .65f, p.y);
        return a * (1 - u) + b * u;
    }
};

inline Registration estimate(const cv::Mat &reference, const cv::Mat &source,
                             cv::Point2f eye, bool grounded) {
    if (reference.type() != CV_8UC4 || source.type() != CV_8UC4 || reference.size() != source.size())
        throw std::runtime_error("registration needs matching RGBA images");
    const auto [top, ground] = verticalBounds(reference);
    if (!std::isfinite(eye.x) || !std::isfinite(eye.y) || eye.y <= top || eye.y >= ground)
        throw std::runtime_error("invalid registration eye anchor");
    const auto dis = cv::DISOpticalFlow::create(cv::DISOpticalFlow::PRESET_MEDIUM);
    dis->setFinestScale(0);
    cv::Mat flow;
    dis->calc(gray(reference), gray(source), flow);
    const auto region = [](float x, float y, float w, float h) { return cv::Rect(int(x), int(y), int(w), int(h)); };
    const float width = reference.cols;
    Registration result;
    result.eye = eye.y; result.top = top; result.ground = ground;
    result.sourceGround = verticalBounds(source).second; result.grounded = grounded;
    result.head = fit(reference, source, flow,
        region(eye.x - width * .1125f, top + (eye.y - top) * .3f, width * .225f, (eye.y - top) * .85f));
    // Correct drawing size around the eye anchor, but retain the artist's head
    // tilt. Unwinding that rotation only above the neck can fold long hair at
    // either side when it rejoins the unrotated torso. A scale/translation head
    // map has no x-dependent vertical displacement across that transition.
    const auto sourceEye = result.head.map(eye);
    const double headScale = std::hypot(result.head.scale, result.head.turn);
    result.head = {headScale, 0, sourceEye.x - headScale * eye.x,
                                sourceEye.y - headScale * eye.y};
    if (grounded) {
        const auto [referenceX, referenceWidth] = soleMoments(reference, ground);
        const auto [sourceX, sourceWidth] = soleMoments(source, int(result.sourceGround));
        const float neck = eye.y + (eye.y - top) * .45f;
        const auto anchor = result.head.map({eye.x, neck});
        const float sx = std::hypot(result.head.scale, result.head.turn);
        const float sy = (result.sourceGround - anchor.y) / (ground - neck);
        const float shear = (sourceX - anchor.x - sx * (referenceX - eye.x)) / (ground - neck);
        if (!std::isfinite(sy) || sy < .4f || sy > 2.5f || std::abs(shear) > 1)
            throw std::runtime_error("body anchors exceed supported proportions");
        result.body = {sx, shear, anchor.x - sx * eye.x - shear * neck,
                       0, sy, result.sourceGround - sy * ground};
    }
    return result;
}

inline void maps(const Registration &registration, cv::Size size, cv::Mat &x, cv::Mat &y) {
    x.create(size, CV_32F); y.create(size, CV_32F);
    for (int row = 0; row < size.height; ++row) for (int column = 0; column < size.width; ++column) {
        const auto p = registration.map({float(column), float(row)});
        x.at<float>(row, column) = p.x; y.at<float>(row, column) = p.y;
    }
}

// Optical-flow occlusion can move a thin sole by a few texels even with pinned
// endpoint flow. Restore its anchor by mapping the connected lower body, never
// by compositing another image. The upper body and the derivative at the sole
// are unchanged. Input/output are premultiplied, floating-point BGRA.
inline cv::Mat pinGround(const cv::Mat &image, int ground) {
    int bottom = -1;
    for (int y = 0; y < image.rows; ++y) for (int x = 0; x < image.cols; ++x)
        // Match the final 8-bit alpha threshold after rounding, rather than
        // accepting a float such as 180.25 which still packs as alpha 180.
        if (image.at<cv::Vec4f>(y, x)[3] > 180.5f / 255.f) bottom = y;
    if (bottom == ground) return image;
    if (bottom < 0 || std::abs(bottom - ground) > 8)
        throw std::runtime_error("standing sole drift exceeds registration tolerance");
    cv::Mat x(image.size(), CV_32F), y(image.size(), CV_32F), result;
    for (int row = 0; row < image.rows; ++row) for (int column = 0; column < image.cols; ++column) {
        x.at<float>(row, column) = column;
        y.at<float>(row, column) = row + (bottom - ground) * smooth(ground - image.rows * .3f, ground, row);
    }
    cv::remap(image, result, x, y, cv::INTER_LINEAR, cv::BORDER_CONSTANT, cv::Scalar(0, 0, 0, 0));
    return result;
}

} // namespace AvatarRegistration
