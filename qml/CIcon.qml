import QtQuick
import QtQuick.Shapes
Item {
    id: icon
    property string name: ""
    property color color: Theme.muted
    implicitWidth: 20
    implicitHeight: 20
    readonly property var paths: ({
        chat: "M4 3 L16 3 Q18 3 18 5 L18 13 Q18 15 16 15 L8 15 L3 18 L3 5 Q3 3 4 3 M7 7 L14 7 M7 11 L11 11",
        sessions: "M6 3 L17 3 L17 15 M3 6 L14 6 L14 18 L3 18 Z M6 10 L11 10 M6 14 L10 14",
        desktop: "M3 3 L17 3 Q18 3 18 4 L18 13 L2 13 L2 4 Q2 3 3 3 M10 13 L10 17 M6 17 L14 17",
        settings: "M3 5 L17 5 M3 10 L17 10 M3 15 L17 15 M7 3 L7 7 M13 8 L13 12 M7 13 L7 17",
        plus: "M10 4 L10 16 M4 10 L16 10",
        search: "M13 13 L18 18 M15 8 A7 7 0 1 1 1 8 A7 7 0 1 1 15 8",
        arrow: "M4 10 L16 10 M11 5 L16 10 L11 15",
        back: "M16 10 L4 10 M9 5 L4 10 L9 15",
        expand: "M3 8 L3 3 L8 3 M12 3 L17 3 L17 8 M17 12 L17 17 L12 17 M8 17 L3 17 L3 12",
        hide: "M4 10 L16 10",
        edit: "M12 4 L16 8 M3 13 L13 3 Q14 2 15 3 L17 5 Q18 6 17 7 L7 17 L3 17 Z",
        image: "M3 3 L17 3 L17 17 L3 17 Z M3 14 L8 9 L12 13 L14 11 L17 14 M12 6 L13 6",
        copy: "M7 6 L17 6 L17 18 L7 18 Z M13 3 L3 3 L3 14",
        close: "M5 5 L15 15 M15 5 L5 15"
    })
    Shape {
        anchors.centerIn: parent
        width: 20; height: 20
        ShapePath {
            strokeColor: icon.color; strokeWidth: 1.5; fillColor: "transparent"
            capStyle: ShapePath.RoundCap; joinStyle: ShapePath.RoundJoin
            PathSvg { path: icon.paths[icon.name] || "" }
        }
    }
}
