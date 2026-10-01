#include "motion.h"
#include <algorithm>
#include <QRegularExpression>

MotionDirector::MotionDirector(const QVariantMap &catalog, quint32 seed)
    :m_clips(catalog.value("clips").toMap()),m_catalog(catalog),m_random(seed) {
    for(const auto &name:catalog.value("idlePool").toList())m_idlePool.append(name.toString());
}
QString MotionDirector::base() const {
    if(!m_context.visible||m_context.quiet)return "quiet";
    if(m_context.dragging)return "dragging";
    if(!m_context.connected)return "disconnected";
    if(m_context.waiting)return "waiting";
    if(m_context.problem)return "problem";
    if(m_context.busy){
        if(m_context.activity=="speaking")return "speaking";
        if(m_context.activity=="thinking")return "thinking";
        return "working";
    }
    if(m_context.listening)return "listening";
    if(m_context.roaming)return m_context.roamLeft?"runLeft":"runRight";
    return "idle";
}
int MotionDirector::priority(const QString &name) const {
    return m_clips.value(name).toMap().value("priority").toInt();
}
void MotionDirector::choose(const QString &name,bool transient) {
    m_name=name;m_transient=transient;++m_revision;
}
void MotionDirector::setContext(Context context) {
    const QString previousBase=base();
    const QString profile=m_catalog.value("idleProfiles").toMap().contains(context.idleEnergy)?context.idleEnergy:m_catalog.value("defaultIdleProfile","lively").toString();
    if(m_profile!=profile){
        m_profile=profile;m_bag.clear();m_idlePool.clear();
        const auto pool=m_catalog.value("idleProfiles").toMap().value(profile).toMap().value("pool",m_catalog.value("idlePool")).toList();
        for(const auto &name:pool)m_idlePool.append(name.toString());
    }
    m_context=context;
    const QString next=base();
    // Muting, disappearing and dragging always interrupt. A transient can never
    // obscure an approval or loss of connection. Other state updates do not restart it.
    if(next=="quiet"||next=="dragging"||m_context.reduced||m_context.intensity<=0||priority(next)>priority(m_name)||
       (next!=previousBase&&m_transient&&(priority(m_name)<60||m_clips.value(m_name).toMap().value("outcome").toBool())&&(m_context.busy||m_context.listening))||
       (!m_transient&&next!=previousBase)) {
        if(m_name!=next||m_transient)choose(next,false);
    } else if(!m_transient&&m_name!=next)choose(next,false);
}
bool MotionDirector::play(const QString &name) {
    if(!m_clips.contains(name)||m_clips.value(name).toMap().value("loop").toBool()||
       base()=="quiet"||m_context.reduced||m_context.intensity<=0||m_context.dragging||m_context.roaming||
       priority(name)<priority(base())||(m_transient&&priority(name)<priority(m_name)))return false;
    choose(name,true);return true;
}
bool MotionDirector::finish(quint64 revision) {
    if(revision!=m_revision||!m_transient)return false;
    choose(base(),false);return true;
}
int MotionDirector::duration() const {
    if(!m_transient)return 0;
    int total=m_clips.value(m_name).toMap().value("entryMs").toInt();
    for(const auto &key:m_clips.value(m_name).toMap().value("keys").toList())total+=key.toMap().value("ms").toInt();
    return total;
}
bool MotionDirector::canIdle() const {
    const bool allowPanel=m_catalog.value("idleProfiles").toMap().value(m_profile).toMap().value("idleWhileReading").toBool();
    return base()=="idle"&&!m_context.reduced&&m_context.intensity>0&&!m_transient&&
        !m_context.interacting&&(!m_context.panel||allowPanel)&&!m_context.roaming;
}
bool MotionDirector::reactMood(qint64 now) {
    const auto key=m_context.moodSession+":"+m_context.mood;
    if(key==m_observedMood)return false;
    m_observedMood=key; // Consume even blocked/hidden changes; never queue them.
    if(!m_context.moodReactive||!m_context.expressive||m_context.mood=="neutral"||
       !m_context.visible||m_context.quiet||m_context.reduced||m_context.intensity<=0||
       !m_context.connected||m_context.waiting||m_context.problem||m_context.busy||
       m_context.dragging||m_context.roaming||m_context.listening)return false;
    const auto config=m_catalog.value("bodyMoods").toMap();
    if(m_lastMoodReaction>=0&&now-m_lastMoodReaction<config.value("reactionCooldownMs").toLongLong())return false;
    const auto clip=config.value("moods").toMap().value(m_context.mood).toMap().value("reaction").toString();
    if(clip.isEmpty()||!play(clip))return false;
    m_lastMoodReaction=now;return true;
}
int MotionDirector::nextIdleDelay(){
    const auto profile=m_catalog.value("idleProfiles").toMap().value(m_profile).toMap();
    const int low=profile.value("minMs").toInt(),high=profile.value("maxMs").toInt();
    return qRound((low+(high>low?int(m_random.bounded(high-low)):0))/std::max(.35,m_context.intensity));
}
bool MotionDirector::idle() {
    if(!canIdle()||m_idlePool.isEmpty())return false;
    if(m_bag.isEmpty()){
        m_bag=m_idlePool;
        for(int i=m_bag.size()-1;i>0;--i)m_bag.swapItemsAt(i,int(m_random.bounded(i+1)));
        if(m_bag.size()>1&&m_bag.last()==m_lastIdle)m_bag.swapItemsAt(0,m_bag.size()-1);
    }
    int chosen=m_bag.size()-1;
    if(m_context.expressive&&m_context.mood!="neutral"){
        const auto config=m_catalog.value("bodyMoods").toMap();
        const auto preferred=config.value("moods").toMap().value(m_context.mood).toMap().value("preferred").toList();
        QVector<double> weights;double total=0;
        for(const auto &name:m_bag){
            const double weight=name==m_lastIdle&&m_bag.size()>1?0:
                config.value(preferred.contains(name)?"preferredWeight":"defaultWeight",1).toDouble();
            weights.append(weight);total+=weight;
        }
        double draw=m_random.generateDouble()*total;
        for(int i=0;i<weights.size();++i)if((draw-=weights[i])<0){chosen=i;break;}
    }
    const auto name=m_bag.takeAt(chosen);
    if(!play(name))return false;
    m_lastIdle=name;return true;
}

QString MotionDirector::conversationalCue(const QString &text,bool user) {
    // Inspect only the opening prose, once per live message. Quoted/code content,
    // history and unrecognised languages get neutral acting, not guessed emotion.
    QString opening=text.left(320).trimmed();
    if(opening.startsWith('>')||opening.startsWith('`')||opening.startsWith('~')||opening.startsWith('{')||opening.startsWith('['))return {};
    opening=opening.section('\n',0,0).remove('*').trimmed().toLower();
    const auto matches=[&](const QString &pattern){return QRegularExpression(pattern,QRegularExpression::CaseInsensitiveOption).match(opening).hasMatch();};
    if(user)return matches("^(i['’]m|i am|i feel) (overwhelmed|sad|exhausted|anxious|scared|upset)\\b")?"tender":QString();
    if(matches("^(i['’]m here|i am here|i['’]ve got you|i have got you|take your time|that sounds (hard|rough|painful)|i['’]m sorry|i am sorry)\\b"))return "tender";
    if(matches("^(you (absolute )?menace|oh,? you|well,? well|cheeky|look at you)\\b"))return "cheeky";
    if(matches("^(color me skeptical|colour me sceptical|i['’]m skeptical|i am skeptical|i['’]m sceptical|i am sceptical|really\\?)"))return "skeptical";
    if(matches("^(wait,? what[?!]|you['’]re kidding|you are kidding|oh,? come on)"))return "disbelief";
    if(matches("^(interesting[,.!]|i wonder|let['’]s explore|tell me more|curious[,.!])"))return "curious";
    if(matches("^(naturally[,.!]|of course[,.!]|allow me[,.!])"))return "smug";
    return {};
}
