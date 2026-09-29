import QtQuick

// Cropped textures are cached independently, with linear filtering and mipmaps.
// Per-frame crops and aspect fitting keep supplemental cels on the foot anchor.
Image {
    property int pose: 0
    property var frame: (App.animations.frames || [])[pose] || ({x:0,y:0,width:320,height:336})
    source: App.assetPath + (frame.texture || App.animations.texture || "cere-polished.png")
    sourceSize: Qt.size(frame.textureWidth || App.animations.textureWidth || 1280, frame.textureHeight || App.animations.textureHeight || 1344)
    sourceClipRect: Qt.rect(frame.x, frame.y, frame.width, frame.height)
    smooth: true
    mipmap: true
    cache: true
    fillMode: Image.PreserveAspectFit
    verticalAlignment: Image.AlignBottom
}
