// Bake transparent pose intermediates with bidirectional dense optical flow.
//
// Usage:
//   interpolate-avatar-poses FROM.png TO.png OUTPUT_PREFIX STEPS
//
// The program writes OUTPUT_PREFIX-01.png through OUTPUT_PREFIX-STEPS.png.
// Endpoints are excluded: output i is sampled at i / (STEPS + 1). Both inputs
// must be same-size, 8-bit, four-channel PNGs. Warping and blending use
// premultiplied BGRA so transparent edges cannot introduce colored fringes.

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/video/tracking.hpp>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

namespace {

constexpr int maximumSteps = 240;

bool parseSteps(const char *text, int &steps)
{
    const std::string value(text);
    if (value.empty())
        return false;
    const char *begin = value.data();
    const char *end = begin + value.size();
    const auto parsed = std::from_chars(begin, end, steps);
    return parsed.ec == std::errc() && parsed.ptr == end
            && steps >= 1 && steps <= maximumSteps;
}

cv::Mat premultiply(const cv::Mat &bgra)
{
    cv::Mat floating;
    bgra.convertTo(floating, CV_32FC4, 1.0 / 255.0);
    for (int y = 0; y < floating.rows; ++y) {
        auto *row = floating.ptr<cv::Vec4f>(y);
        for (int x = 0; x < floating.cols; ++x) {
            const float alpha = row[x][3];
            row[x][0] *= alpha;
            row[x][1] *= alpha;
            row[x][2] *= alpha;
        }
    }
    return floating;
}

cv::Mat flowInput(const cv::Mat &premultiplied)
{
    // A mid-gray matte supplies a stable, color-neutral boundary around alpha.
    cv::Mat matte(premultiplied.size(), CV_32FC3);
    for (int y = 0; y < premultiplied.rows; ++y) {
        const auto *source = premultiplied.ptr<cv::Vec4f>(y);
        auto *target = matte.ptr<cv::Vec3f>(y);
        for (int x = 0; x < premultiplied.cols; ++x) {
            const float background = 0.5f * (1.0f - source[x][3]);
            target[x] = cv::Vec3f(source[x][0] + background,
                                  source[x][1] + background,
                                  source[x][2] + background);
        }
    }
    cv::Mat grayFloat;
    cv::cvtColor(matte, grayFloat, cv::COLOR_BGR2GRAY);
    cv::Mat gray;
    grayFloat.convertTo(gray, CV_8UC1, 255.0);
    return gray;
}

void coordinateMaps(cv::Size size, cv::Mat &xCoordinates, cv::Mat &yCoordinates)
{
    xCoordinates.create(size, CV_32FC1);
    yCoordinates.create(size, CV_32FC1);
    for (int y = 0; y < size.height; ++y) {
        float *xRow = xCoordinates.ptr<float>(y);
        float *yRow = yCoordinates.ptr<float>(y);
        for (int x = 0; x < size.width; ++x) {
            xRow[x] = float(x);
            yRow[x] = float(y);
        }
    }
}

void splitFlow(const cv::Mat &flow, cv::Mat &x, cv::Mat &y)
{
    std::vector<cv::Mat> channels;
    cv::split(flow, channels);
    x = channels[0];
    y = channels[1];
}

cv::Mat consistency(const cv::Mat &forward, const cv::Mat &backward,
                    const cv::Mat &baseX, const cv::Mat &baseY)
{
    cv::Mat forwardX, forwardY;
    splitFlow(forward, forwardX, forwardY);
    const cv::Mat destinationX = baseX + forwardX;
    const cv::Mat destinationY = baseY + forwardY;

    cv::Mat reverseAtDestination;
    cv::remap(backward, reverseAtDestination, destinationX, destinationY,
              cv::INTER_LINEAR, cv::BORDER_CONSTANT, cv::Scalar(0, 0));

    cv::Mat result(forward.size(), CV_32FC1, cv::Scalar(0));
    for (int y = 0; y < forward.rows; ++y) {
        const auto *flowRow = forward.ptr<cv::Vec2f>(y);
        const auto *reverseRow = reverseAtDestination.ptr<cv::Vec2f>(y);
        const float *destinationXRow = destinationX.ptr<float>(y);
        const float *destinationYRow = destinationY.ptr<float>(y);
        float *resultRow = result.ptr<float>(y);
        for (int x = 0; x < forward.cols; ++x) {
            const float destinationColumn = destinationXRow[x];
            const float destinationLine = destinationYRow[x];
            if (destinationColumn < 0.0f || destinationLine < 0.0f
                    || destinationColumn > forward.cols - 1.0f
                    || destinationLine > forward.rows - 1.0f)
                continue;
            const cv::Vec2f mismatch = flowRow[x] + reverseRow[x];
            const float squaredError = mismatch.dot(mismatch);
            // A reliability floor keeps legitimate appearance changes visible.
            resultRow[x] = 0.2f + 0.8f * std::exp(-squaredError / 18.0f);
        }
    }
    return result;
}

void inverseFlowMap(const cv::Mat &flow, float fraction,
                    const cv::Mat &baseX, const cv::Mat &baseY,
                    cv::Mat &mapX, cv::Mat &mapY)
{
    cv::Mat flowX, flowY;
    splitFlow(flow, flowX, flowY);
    mapX = baseX - fraction * flowX;
    mapY = baseY - fraction * flowY;

    // Solve source + fraction * flow(source) = output by fixed-point iteration.
    // Re-evaluating the dense field avoids the common large-motion midpoint lag.
    for (int iteration = 0; iteration < 5; ++iteration) {
        cv::Mat sampledFlow;
        cv::remap(flow, sampledFlow, mapX, mapY, cv::INTER_LINEAR,
                  cv::BORDER_REPLICATE);
        splitFlow(sampledFlow, flowX, flowY);
        mapX = baseX - fraction * flowX;
        mapY = baseY - fraction * flowY;
    }
}

cv::Mat interpolate(const cv::Mat &fromPremultiplied,
                    const cv::Mat &toPremultiplied,
                    const cv::Mat &fromFlow, const cv::Mat &toFlow,
                    const cv::Mat &fromConfidence,
                    const cv::Mat &toConfidence,
                    const cv::Mat &baseX, const cv::Mat &baseY, float time)
{
    cv::Mat fromX, fromY, toX, toY;
    inverseFlowMap(fromFlow, time, baseX, baseY, fromX, fromY);
    inverseFlowMap(toFlow, 1.0f - time, baseX, baseY, toX, toY);

    cv::Mat warpedFrom, warpedTo, confidenceFrom, confidenceTo;
    cv::remap(fromPremultiplied, warpedFrom, fromX, fromY, cv::INTER_LINEAR,
              cv::BORDER_CONSTANT, cv::Scalar(0, 0, 0, 0));
    cv::remap(toPremultiplied, warpedTo, toX, toY, cv::INTER_LINEAR,
              cv::BORDER_CONSTANT, cv::Scalar(0, 0, 0, 0));
    cv::remap(fromConfidence, confidenceFrom, fromX, fromY, cv::INTER_LINEAR,
              cv::BORDER_CONSTANT, cv::Scalar(0));
    cv::remap(toConfidence, confidenceTo, toX, toY, cv::INTER_LINEAR,
              cv::BORDER_CONSTANT, cv::Scalar(0));

    cv::Mat blended(fromPremultiplied.size(), CV_32FC4, cv::Scalar(0, 0, 0, 0));
    for (int y = 0; y < blended.rows; ++y) {
        const auto *fromRow = warpedFrom.ptr<cv::Vec4f>(y);
        const auto *toRow = warpedTo.ptr<cv::Vec4f>(y);
        const float *fromConfidenceRow = confidenceFrom.ptr<float>(y);
        const float *toConfidenceRow = confidenceTo.ptr<float>(y);
        auto *target = blended.ptr<cv::Vec4f>(y);
        for (int x = 0; x < blended.cols; ++x) {
            const float fromWeight = (1.0f - time) * fromConfidenceRow[x];
            const float toWeight = time * toConfidenceRow[x];
            const float totalWeight = fromWeight + toWeight;
            if (totalWeight > 1e-6f)
                target[x] = (fromRow[x] * fromWeight + toRow[x] * toWeight)
                        * (1.0f / totalWeight);
        }
    }
    return blended;
}

cv::Mat unpremultiply(const cv::Mat &premultiplied)
{
    cv::Mat bgra(premultiplied.size(), CV_8UC4, cv::Scalar(0, 0, 0, 0));
    for (int y = 0; y < premultiplied.rows; ++y) {
        const auto *source = premultiplied.ptr<cv::Vec4f>(y);
        auto *target = bgra.ptr<cv::Vec4b>(y);
        for (int x = 0; x < premultiplied.cols; ++x) {
            const float alpha = std::clamp(source[x][3], 0.0f, 1.0f);
            if (alpha <= 1.0f / 255.0f)
                continue;
            for (int channel = 0; channel < 3; ++channel) {
                const float straight = std::clamp(source[x][channel] / alpha,
                                                  0.0f, 1.0f);
                target[x][channel] = cv::saturate_cast<uchar>(straight * 255.0f);
            }
            target[x][3] = cv::saturate_cast<uchar>(alpha * 255.0f);
        }
    }
    return bgra;
}

std::string outputName(const std::string &prefix, int index, int steps)
{
    const int digits = std::max(2, int(std::to_string(steps).size()));
    std::ostringstream name;
    name << prefix << '-' << std::setfill('0') << std::setw(digits) << index
         << ".png";
    return name.str();
}

} // namespace

int main(int argc, char **argv)
{
    if (argc != 5) {
        std::cerr << "Usage: " << argv[0]
                  << " FROM.png TO.png OUTPUT_PREFIX STEPS\n";
        return 2;
    }

    int steps = 0;
    if (!parseSteps(argv[4], steps)) {
        std::cerr << "STEPS must be an integer from 1 through "
                  << maximumSteps << ".\n";
        return 2;
    }

    try {
        const cv::Mat from = cv::imread(argv[1], cv::IMREAD_UNCHANGED);
        const cv::Mat to = cv::imread(argv[2], cv::IMREAD_UNCHANGED);
        if (from.empty() || to.empty()) {
            std::cerr << "Both input images must be readable.\n";
            return 2;
        }
        if (from.type() != CV_8UC4 || to.type() != CV_8UC4) {
            std::cerr << "Both input images must be 8-bit four-channel RGBA.\n";
            return 2;
        }
        if (from.size() != to.size()) {
            std::cerr << "Input images must have identical dimensions.\n";
            return 2;
        }

        const std::filesystem::path prefix(argv[3]);
        if (!prefix.parent_path().empty())
            std::filesystem::create_directories(prefix.parent_path());

        cv::setNumThreads(2);
        const cv::Mat fromPremultiplied = premultiply(from);
        const cv::Mat toPremultiplied = premultiply(to);
        const cv::Mat fromGray = flowInput(fromPremultiplied);
        const cv::Mat toGray = flowInput(toPremultiplied);

        const auto dis = cv::DISOpticalFlow::create(cv::DISOpticalFlow::PRESET_MEDIUM);
        dis->setFinestScale(0);
        cv::Mat fromFlow, toFlow;
        dis->calc(fromGray, toGray, fromFlow);
        dis->calc(toGray, fromGray, toFlow);

        cv::Mat baseX, baseY;
        coordinateMaps(from.size(), baseX, baseY);
        const cv::Mat fromConfidence = consistency(fromFlow, toFlow, baseX, baseY);
        const cv::Mat toConfidence = consistency(toFlow, fromFlow, baseX, baseY);

        for (int index = 1; index <= steps; ++index) {
            const float time = float(index) / float(steps + 1);
            const cv::Mat frame = unpremultiply(interpolate(
                    fromPremultiplied, toPremultiplied, fromFlow, toFlow,
                    fromConfidence, toConfidence, baseX, baseY, time));
            const std::string name = outputName(argv[3], index, steps);
            if (!cv::imwrite(name, frame)) {
                std::cerr << "Could not write " << name << ".\n";
                return 1;
            }
        }
    } catch (const cv::Exception &error) {
        std::cerr << "OpenCV error: " << error.what() << '\n';
        return 1;
    } catch (const std::exception &error) {
        std::cerr << "Error: " << error.what() << '\n';
        return 1;
    }

    return 0;
}
