#include "../tools/avatar-registration.h"
#include <iostream>

int main() {
    using namespace AvatarRegistration;
    cv::setNumThreads(2);
    cv::Mat reference(460, 400, CV_8UC4, cv::Scalar(0, 0, 0, 0));
    cv::Mat mask(reference.size(), CV_8U, cv::Scalar(0));
    cv::ellipse(mask, {200, 140}, {65, 72}, 0, 0, 360, cv::Scalar(255), -1);
    cv::rectangle(mask, {165, 200, 70, 120}, cv::Scalar(255), -1);
    cv::rectangle(mask, {166, 300, 26, 131}, cv::Scalar(255), -1);
    cv::rectangle(mask, {208, 300, 26, 131}, cv::Scalar(255), -1);
    for (int y = 0; y < reference.rows; ++y) for (int x = 0; x < reference.cols; ++x)
        if (mask.at<uchar>(y, x)) reference.at<cv::Vec4b>(y, x) = {
            uchar(80 + 70 * std::sin(x * .17) * std::cos(y * .11)),
            uchar(120 + 95 * std::cos(x * .09 + y * .13)), uchar(70 + y % 170), 255};
    cv::Mat source;
    const cv::Matx23d affine(1.08, 0, -16, 0, 1.08, -34.4);
    cv::warpAffine(reference, source, affine, reference.size());
    const auto registered = estimate(reference, source, {200, 162}, true);
    const auto require = [](bool condition, const char *message) {
        if (!condition) { std::cerr << message << '\n'; std::exit(1); }
    };
    require(std::abs(registered.head.scale - 1.08) < .025, "head-size drift must be recovered");
    require(std::abs(registered.body(0, 0) - 1.08) < .025, "body-size drift must be recovered");
    require(cv::norm(registered.head.map({200, 140}) - cv::Point2f(200, 116.8)) < 2,
            "head registration must recover its location");
    // A turned source head is an authored pose, not a size defect. Correcting
    // its rotation above an upright body folds long hair beside the neck.
    const double a = 1.08 * std::cos(24 * CV_PI / 180), b = 1.08 * std::sin(24 * CV_PI / 180);
    const cv::Matx23d rotation(a, b, (1-a)*200-b*162, -b, a, b*200+(1-a)*162);
    cv::Mat turned;
    cv::warpAffine(reference, turned, rotation, reference.size());
    const auto tilted = estimate(reference, turned, {200, 162}, true);
    require(tilted.head.turn == 0, "size registration must preserve authored head tilt");
    for (int y = 162; y < 430; ++y) for (int x = 0; x < 400; x += 5) {
        const auto p = tilted.map({float(x), float(y)});
        const auto dx = tilted.map({float(x+1), float(y)}) - p;
        const auto dy = tilted.map({float(x), float(y+1)}) - p;
        require(dx.x * dy.y - dx.y * dy.x > 0,
                "a tilted head may not fold hair or clothing beside its neck");
    }
    for (int x = 0; x < 400; ++x)
        require(std::abs(registered.map({float(x), registered.ground}).y - registered.sourceGround) < 1e-4,
                "every sole must use the same geometric anchor");
    // Unlike an alpha splice, one continuous coordinate field carries both
    // sides of the waist. Test continuity and orientation through all regions.
    for (int y = 0; y < 459; ++y) for (int x = 100; x < 300; ++x) {
        const auto p = registered.map({float(x), float(y)});
        const auto dx = registered.map({float(x + 1), float(y)}) - p;
        const auto dy = registered.map({float(x), float(y + 1)}) - p;
        require(cv::norm(dx) < 2 && cv::norm(dy) < 2, "registration may not introduce a seam");
        require(dx.x * dy.y - dx.y * dy.x > .5, "registration may not fold the drawing");
    }
    auto carried = registered;
    carried.grounded = false;
    require(carried.map({210, 410}) == carried.head.map({210, 410}),
            "pickup must transform the entire body without pinning the legs");
    for (int y = 260; y < 425; ++y) {
        const auto midpoint = (registered.map({175, float(y - 4)}) + registered.map({175, float(y + 4)})) * .5f;
        require(cv::norm(registered.map({175, float(y)}) - midpoint) < 1e-4,
                "the torso and legs must use one affine map without curved seams or limbs");
    }
    cv::Mat floating;
    reference.convertTo(floating, CV_32FC4, 1.0 / 255);
    const auto pinned = pinGround(floating, 434);
    require(pinned.at<cv::Vec4f>(434, 178)[3] == 1, "interpolated soles must return to their exact anchor");
    require(cv::norm(floating.row(140), pinned.row(140), cv::NORM_INF) == 0,
            "sole correction may not rescale or blur the upper body");
    require(pinGround(floating, 430).data == floating.data,
            "already planted artwork must remain byte-exact without resampling");
    auto rounded = floating.clone();
    for (int x = 0; x < rounded.cols; ++x)
        rounded.at<cv::Vec4f>(430, x)[3] *= 180.25f / 255.f;
    require(pinGround(rounded, 430).at<cv::Vec4f>(430, 178)[3] == 1,
            "sole anchoring must survive final alpha quantization");
    bool rejected = false;
    try { estimate(reference, cv::Mat(source.size(), CV_8UC4, cv::Scalar(0, 0, 0, 0)), {200, 162}, true); }
    catch (const std::runtime_error &) { rejected = true; }
    require(rejected, "empty or invalid artwork must fail registration visibly");
    std::cout << "Registration scale, anchors, connected waist, pickup and invalid input passed.\n";
}
