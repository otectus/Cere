#pragma once
#include <QPoint>
#include <QRect>
#include <QSize>
#include <algorithm>
#include <cmath>

// Pure placement policy, independent of any compositor so it can be tested directly.
namespace Placement {

// A clamp that can never violate std::clamp's ordered-bounds precondition.
inline int bounded(int value,int low,int high){return std::clamp(value,low,std::max(low,high));}

// The compact panel lives inside one rectangle derived from the output's available
// geometry: 12 px side and bottom margins and 40 px below the top edge. Both panel
// dimensions are capped to that rectangle (never below 1 px) before positioning, so
// short or narrow outputs keep the whole window on screen.
inline QRect compactPanel(const QRect &available,const QPoint &pet,const QSize &petSize,const QSize &preferred=QSize(440,720)){
    const QRect area=available.adjusted(12,40,-12,-12);
    const int width=std::clamp(preferred.width(),1,std::max(1,area.width()));
    const int height=std::clamp(preferred.height(),1,std::max(1,area.height()));
    int x=pet.x()-width-12;
    if(x<area.left())x=pet.x()+petSize.width()+12;
    x=bounded(x,area.left(),area.left()+area.width()-width);
    const int y=bounded(pet.y()-height+160,area.top(),area.top()+area.height()-height);
    return {x,y,width,height};
}

// A resting pet is kept wholly on its output. A roaming pet uses the continuous
// follower point unchanged, so crossing between outputs never jumps by its size.
enum class Mode{Resting,Roaming};
inline QPoint pet(const QPoint &global,const QSize &size,const QRect &output,Mode mode){
    if(mode==Mode::Roaming)return global;
    return {bounded(global.x(),output.left(),output.left()+output.width()-size.width()),
            bounded(global.y(),output.top(),output.top()+output.height()-size.height())};
}

// One step toward a resting point at no more than the follower's speed limit. Like the
// follower, a stalled frame counts as at most 50 ms, so a late timer never leaps.
inline QPoint settleStep(const QPoint &from,const QPoint &to,double seconds,double speed=75.){
    const QPoint delta=to-from;
    const double length=std::hypot(double(delta.x()),double(delta.y())),step=std::max(1.,speed*std::clamp(seconds,0.,.05));
    if(length<=step)return to;
    return from+QPoint(qRound(delta.x()*step/length),qRound(delta.y()*step/length));
}

}
