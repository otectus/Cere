#pragma once
#include <QPointF>
#include <QRectF>
#include <QSizeF>
#include <algorithm>
#include <cmath>

// Continuous position/velocity avoids rounding drift at low speeds. Cursor
// sampling and compositor placement are deliberately outside this policy.
class MouseFollower {
public:
    void reset(QPointF position){m_position=position;m_velocity={};m_moving=false;}
    QPointF position()const{return m_position;}
    QPointF velocity()const{return m_velocity;}
    bool moving()const{return m_moving;}
    bool advance(QPointF cursor,QSizeF size,QRectF screen,qreal seconds){
        const auto length=[](QPointF p){return std::hypot(p.x(),p.y());};
        const QPointF half(size.width()/2,size.height()/2);
        const QPointF toward=cursor-(m_position+half);
        const qreal distance=length(toward),gap=length(half)+24;
        auto stop=[this]{m_velocity={};m_moving=false;return false;};
        // Never run away from a click, and don't chase tiny pointer movements.
        if(QRectF(m_position,size).adjusted(-12,-12,12,12).contains(cursor)||
           distance<=gap+(m_moving?1:18))return stop();
        const auto constrain=[&](QPointF p){
            return QPointF(std::clamp(p.x(),screen.left(),std::max(screen.left(),screen.right()-size.width())),
                           std::clamp(p.y(),screen.top(),std::max(screen.top(),screen.bottom()-size.height())));
        };
        QPointF target=constrain(cursor-toward*(gap/distance)-half);
        // At screen edges, prefer the side that leaves the cursor unobstructed.
        if(length(cursor-(target+half))<gap-1){
            const QPointF other=constrain(cursor+toward*(gap/distance)-half);
            if(length(cursor-(other+half))>length(cursor-(target+half)))target=other;
        }
        const QPointF delta=target-m_position;
        const qreal remaining=length(delta);
        if(remaining<1&&length(m_velocity)<4)return stop();
        const qreal dt=std::clamp(seconds,0.,.05);
        const QPointF desired=remaining>0?delta*(std::min(75.,remaining/0.8)/remaining):QPointF();
        m_velocity+=(desired-m_velocity)*(1-std::exp(-dt/.4));
        const QPointF step=m_velocity*dt;
        if(QPointF::dotProduct(step,delta)>0&&length(step)>remaining){m_position=target;return stop();}
        const bool inside=screen.contains(QRectF(m_position,size));
        m_position+=step;
        if(inside){
            const auto clamped=constrain(m_position);
            if(clamped.x()!=m_position.x())m_velocity.setX(0);
            if(clamped.y()!=m_position.y())m_velocity.setY(0);
            m_position=clamped;
        }
        m_moving=true;return true;
    }
private:
    QPointF m_position,m_velocity;
    bool m_moving=false;
};
