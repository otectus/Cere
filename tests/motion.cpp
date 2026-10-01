#include "../native/motion.h"
#include "../native/follow.h"
#include "../native/placement.h"
#include <QtTest>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QImage>

class MotionCheck : public QObject {
    Q_OBJECT
    QVariantMap catalog;
    MotionDirector::Context visible() { MotionDirector::Context c;c.visible=true;c.idleEnergy="calm";return c; }
private slots:
    void initTestCase() {
        QFile file(QString(CERE_SOURCE_DIR)+"/assets/motions.json");
        QVERIFY(file.open(QIODevice::ReadOnly));
        catalog=QJsonDocument::fromJson(file.readAll()).object().toVariantMap();
        QVERIFY(!catalog.value("clips").toMap().isEmpty());
    }
    void assetAndTimelineIntegrity() {
        QImage texture(QString(CERE_SOURCE_DIR)+"/assets/"+catalog.value("texture").toString());
        QVERIFY(!texture.isNull());QVERIFY(texture.hasAlphaChannel());
        const auto frames=catalog.value("frames").toList();
        for(const auto &frame:frames){
            const auto f=frame.toMap();
            const QImage texture(QString(CERE_SOURCE_DIR)+"/assets/"+f.value("texture",catalog.value("texture")).toString());
            QVERIFY(!texture.isNull());QVERIFY(texture.hasAlphaChannel());
            QRect rect(f.value("x").toInt(),f.value("y").toInt(),f.value("width").toInt(),f.value("height").toInt());
            QVERIFY(rect.isValid());QVERIFY(texture.rect().contains(rect));
            int clear=0,solid=0,antialiased=0;
            for(int y=rect.top();y<=rect.bottom();++y)for(int x=rect.left();x<=rect.right();++x){
                const int alpha=qAlpha(texture.pixel(x,y));
                if(alpha==0)++clear;else if(alpha>=245)++solid;else ++antialiased;
            }
            const int area=rect.width()*rect.height();
            QVERIFY(clear>area/5);QVERIFY(solid>area/5);QVERIFY(antialiased>20);
            for(int x=rect.left();x<=rect.right();++x){
                QVERIFY(qAlpha(texture.pixel(x,rect.top()))<=8);
                QVERIFY(qAlpha(texture.pixel(x,rect.bottom()))<=8);
            }
        }
        const auto clips=catalog.value("clips").toMap();
        for(auto i=clips.begin();i!=clips.end();++i){
            const auto keys=i.value().toMap().value("keys").toList();
            QVERIFY2(!keys.isEmpty(),qPrintable(i.key()));
            for(const auto &value:keys){
                const auto key=value.toMap();
                QVERIFY2(key.value("ms").toInt()>0,qPrintable(i.key()));
                QVERIFY(key.value("pose").toInt()>=0&&key.value("pose").toInt()<frames.size());
                QVERIFY(qAbs(key.value("rotation").toDouble())<=5);
                QVERIFY(qAbs(key.value("x").toDouble())<=5);
                QVERIFY(qAbs(key.value("y").toDouble())<=6);
            }
        }
        for(const auto &name:catalog.value("idlePool").toList())QVERIFY(clips.contains(name.toString()));
    }
    void entryChoreographyIsIncludedInCompletion() {
        MotionDirector d(catalog,1);d.setContext(visible());
        const auto clips=catalog.value("clips").toMap();
        for(const auto &name:clips.keys()) {
            const auto clip=clips.value(name).toMap();
            if(clip.value("loop").toBool())continue;
            QVERIFY(d.play(name));
            int expected=clip.value("entryMs").toInt();
            for(const auto &key:clip.value("keys").toList())expected+=key.toMap().value("ms").toInt();
            QCOMPARE(d.duration(),expected);QVERIFY(d.finish(d.revision()));
        }
    }
    void completesIntoLatestSessionState() {
        MotionDirector d(catalog,1);auto c=visible();d.setContext(c);
        QVERIFY(d.play("wave"));const auto token=d.revision();const auto duration=d.duration();
        c.busy=true;d.setContext(c);
        QCOMPARE(d.name(),QString("working"));QVERIFY(d.revision()!=token);
        QVERIFY(duration>1200); // The old fixed timeout cut off long gestures.
        QVERIFY(!d.finish(token));QCOMPARE(d.name(),QString("working"));
        QCOMPARE(d.duration(),0);
    }
    void approvalsInterruptIdleAndRejectHover() {
        MotionDirector d(catalog,1);auto c=visible();d.setContext(c);
        QVERIFY(d.play("doze"));const auto stale=d.revision();
        c.waiting=true;d.setContext(c);QCOMPARE(d.name(),QString("waiting"));
        QVERIFY(!d.play("attentive"));QVERIFY(!d.play("celebrate"));
        QVERIFY(!d.finish(stale));QCOMPARE(d.name(),QString("waiting"));
        QVERIFY(d.play("approval"));QVERIFY(d.finish(d.revision()));QCOMPARE(d.name(),QString("waiting"));
        c.waiting=false;c.busy=true;d.setContext(c);QCOMPARE(d.name(),QString("working"));
    }
    void dragAndDisconnectPreemptOneShots() {
        MotionDirector d(catalog,1);auto c=visible();d.setContext(c);
        QVERIFY(d.play("celebrate"));const auto token=d.revision();
        c.dragging=true;d.setContext(c);QCOMPARE(d.name(),QString("dragging"));
        QVERIFY(!d.play("error"));QVERIFY(!d.finish(token));
        c.dragging=false;c.connected=false;d.setContext(c);QCOMPARE(d.name(),QString("disconnected"));
        QVERIFY(!d.play("wave"));c.connected=true;d.setContext(c);QCOMPARE(d.name(),QString("idle"));
    }
    void mutingAndHidingCancelInsteadOfQueueing() {
        for(int setting=0;setting<3;++setting){
            MotionDirector d(catalog,1);auto c=visible();d.setContext(c);
            QVERIFY(d.play("jump"));auto old=d.revision();
            if(setting==0)c.quiet=true;else if(setting==1)c.reduced=true;else c.visible=false;
            d.setContext(c);QCOMPARE(d.name(),setting==1?QString("idle"):QString("quiet"));
            QVERIFY(!d.play("timer"));QVERIFY(!d.idle());QVERIFY(!d.finish(old));
            c=visible();d.setContext(c);QCOMPARE(d.name(),QString("idle"));
        }
    }
    void shuffleBagVariesWithoutImmediateRepeats() {
        MotionDirector d(catalog,42);d.setContext(visible());
        const int count=catalog.value("idlePool").toList().size();
        QString previous;
        for(int cycle=0;cycle<5;++cycle){
            QSet<QString> seen;
            for(int i=0;i<count;++i){
                QVERIFY(d.idle());QVERIFY(d.name()!=previous);
                previous=d.name();seen.insert(d.name());QVERIFY(d.finish(d.revision()));
            }
            QCOMPARE(seen.size(),count);
        }
    }
    void interactionAndWorkSuppressRandomPlay() {
        MotionDirector d(catalog,1);auto c=visible();c.panel=true;d.setContext(c);QVERIFY(!d.idle());
        c.panel=false;c.busy=true;d.setContext(c);QVERIFY(!d.idle());
        c.busy=false;c.roaming=true;c.roamLeft=true;d.setContext(c);
        QCOMPARE(d.name(),QString("runLeft"));QVERIFY(!d.idle());QVERIFY(!d.play("wave"));
        c.roaming=false;d.setContext(c);QVERIFY(d.idle());
    }
    void livelyReadingAllowsGesturesButKeepsInteractionGuards() {
        MotionDirector d(catalog,1);auto c=visible();c.panel=true;c.idleEnergy="lively";
        d.setContext(c);QVERIFY(d.canIdle());QVERIFY(d.idle());QVERIFY(d.finish(d.revision()));
        for(int guard=0;guard<11;++guard){
            auto blocked=c;
            if(guard==0)blocked.interacting=true;if(guard==1)blocked.listening=true;
            if(guard==2)blocked.busy=true;if(guard==3)blocked.waiting=true;
            if(guard==4)blocked.problem=true;if(guard==5)blocked.dragging=true;
            if(guard==6)blocked.connected=false;if(guard==7)blocked.visible=false;
            if(guard==8)blocked.quiet=true;if(guard==9)blocked.reduced=true;
            if(guard==10)blocked.intensity=0;
            d.setContext(blocked);QVERIFY(!d.canIdle());QVERIFY(!d.idle());
        }
        d.setContext(c);QVERIFY(d.canIdle());
        c.idleEnergy="calm";d.setContext(c);QVERIFY(!d.canIdle());
        c.panel=false;c.interacting=true;d.setContext(c);QVERIFY(!d.canIdle());
        c.interacting=false;d.setContext(c);QVERIFY(d.canIdle());
    }
    void staleCompletionCannotEndNewReaction() {
        MotionDirector d(catalog,1);d.setContext(visible());
        QVERIFY(d.play("wave"));auto old=d.revision();
        QVERIFY(d.play("timer"));QVERIFY(!d.finish(old));QCOMPARE(d.name(),QString("timer"));
        QVERIFY(!d.play("unknown"));QVERIFY(!d.play("runRight"));
        QVERIFY(d.finish(d.revision()));QCOMPARE(d.name(),QString("idle"));
    }
    void statesAndStaticAccessibility(){
        MotionDirector d(catalog,2);auto c=visible();c.listening=true;d.setContext(c);QCOMPARE(d.name(),QString("listening"));
        c.busy=true;c.activity="thinking";d.setContext(c);QCOMPARE(d.name(),QString("thinking"));
        c.activity="speaking";d.setContext(c);QCOMPARE(d.name(),QString("speaking"));
        QVERIFY(d.play("cheeky"));const auto token=d.revision();
        c.activity="working";d.setContext(c);QCOMPARE(d.name(),QString("working"));QVERIFY(!d.finish(token));
        c.problem=true;c.busy=false;d.setContext(c);QCOMPARE(d.name(),QString("problem"));QVERIFY(!d.play("celebrate"));
        c.waiting=true;d.setContext(c);QCOMPARE(d.name(),QString("waiting"));QVERIFY(!d.play("error"));
        c.reduced=true;d.setContext(c);QCOMPARE(d.name(),QString("waiting"));QVERIFY(!d.play("approval"));QCOMPARE(d.duration(),0);
        c.waiting=false;c.problem=false;c.reduced=false;c.intensity=0;d.setContext(c);
        QCOMPARE(d.name(),QString("listening"));QVERIFY(!d.idle());QVERIFY(!d.play("wave"));
        c.listening=false;c.intensity=.3;d.setContext(c);const int gentle=d.nextIdleDelay();QVERIFY(gentle>=18000);
        c.intensity=1;d.setContext(c);QVERIFY(d.nextIdleDelay()>=9000);
    }
    void localToneNeverInventsSuccess(){
        QCOMPARE(MotionDirector::conversationalCue("You absolute menace. Let's try it."),QString("cheeky"));
        QCOMPARE(MotionDirector::conversationalCue("I'm here. Take your time."),QString("tender"));
        QCOMPARE(MotionDirector::conversationalCue("Really? That seems unlikely."),QString("skeptical"));
        QCOMPARE(MotionDirector::conversationalCue("Wait, what?!"),QString("disbelief"));
        QCOMPARE(MotionDirector::conversationalCue("Interesting, let's look closer."),QString("curious"));
        QCOMPARE(MotionDirector::conversationalCue("Naturally. I have a suggestion."),QString("smug"));
        QCOMPARE(MotionDirector::conversationalCue("I'm overwhelmed by this.",true),QString("tender"));
        for(const QString text:{QString("Success!"),QString("Done, it worked."),QString("I failed. Success was not possible."),QString("```\nYou absolute menace."),QString("> I'm here."),QString("{\"text\":\"Naturally.\"}"),QString("The log says: you absolute menace."),QString("Bonjour!")})
            QVERIFY2(MotionDirector::conversationalCue(text).isEmpty(),qPrintable(text));
    }
    void profilesUseAuthoredTimingAndCompleteBags(){
        for(const auto &profile:QStringList{"calm","lively"}){
            MotionDirector d(catalog,42);auto c=visible();c.idleEnergy=profile;d.setContext(c);
            const auto data=catalog.value("idleProfiles").toMap().value(profile).toMap();
            for(double intensity:{.1,.35,.7,1.}){
                c.intensity=intensity;d.setContext(c);
                for(int i=0;i<100;++i){const int delay=d.nextIdleDelay();
                    QVERIFY(delay>=qRound(data.value("minMs").toInt()/std::max(.35,intensity)));
                    QVERIFY(delay<=qRound(data.value("maxMs").toInt()/std::max(.35,intensity)));
                }
            }
            QString previous;
            for(const auto &mood:QStringList{"neutral","happy","concerned"}){
                c.mood=mood;d.setContext(c);
                for(int cycle=0;cycle<3;++cycle){QSet<QString> seen;
                    for(int i=0;i<data.value("pool").toList().size();++i){
                        QVERIFY(d.idle());QVERIFY(d.name()!=previous);previous=d.name();seen.insert(d.name());QVERIFY(d.finish(d.revision()));
                    }
                    QCOMPARE(seen.size(),data.value("pool").toList().size());
                }
            }
        }
    }
    void moodReactionsAreSettledEventsNotQueuedWork(){
        MotionDirector d(catalog,1);auto c=visible();c.moodSession="session";c.moodReactive=true;c.mood="curious";
        d.setContext(c);QVERIFY(d.reactMood(0));QCOMPARE(d.name(),QString("curious"));d.finish(d.revision());
        QVERIFY(!d.reactMood(7000)); // Same mood is not a new event.
        c.mood="happy";d.setContext(c);QVERIFY(!d.reactMood(2000));
        QVERIFY(!d.reactMood(7000)); // Cooldown never becomes a delayed queue.
        c.mood="concerned";c.busy=true;d.setContext(c);QVERIFY(!d.reactMood(8000));
        c.busy=false;d.setContext(c);QVERIFY(!d.reactMood(9000));
        c.mood="sleepy";d.setContext(c);QVERIFY(d.reactMood(10000));QCOMPARE(d.name(),QString("doze"));
        for(int guard=0;guard<10;++guard){
            MotionDirector blocked(catalog,2);auto x=visible();x.mood="happy";x.moodSession="s";x.moodReactive=true;
            if(guard==0)x.waiting=true;if(guard==1)x.problem=true;if(guard==2)x.connected=false;
            if(guard==3)x.dragging=true;if(guard==4)x.visible=false;if(guard==5)x.quiet=true;
            if(guard==6)x.reduced=true;if(guard==7)x.intensity=0;if(guard==8)x.expressive=false;if(guard==9)x.moodReactive=false;
            blocked.setContext(x);QVERIFY(!blocked.reactMood(0));
        }
    }
    void moodWeightBiasPreservesEveryBagMember(){
        int matching=0;
        for(int seed=0;seed<500;++seed){
            MotionDirector d(catalog,seed);auto c=visible();c.idleEnergy="lively";c.mood="happy";d.setContext(c);
            QVERIFY(d.idle());if(QStringList{"buoyantBounce","heelRock","easySway"}.contains(d.name()))matching++;
        }
        QVERIFY(matching>110); // Uniform selection would average 71/500.
    }
    void mouseFollowingIsSlowAndSettlesShortOfCursor(){
        MouseFollower f;f.reset({100,300});const QSizeF size(192,208);const QRectF screen(0,0,1920,1080);const QPointF cursor(900,500);
        qreal firstStep=0;
        for(int i=0;i<1500;++i){
            const auto before=f.position();f.advance(cursor,size,screen,.016);
            const auto distance=QLineF(before,f.position()).length();
            if(i==0)firstStep=distance;
            QVERIFY(distance<=75*.016+.0001);QVERIFY(screen.contains(QRectF(f.position(),size)));
        }
        QVERIFY(firstStep<.1);QVERIFY(!f.moving());QVERIFY(f.position().x()>600);
        const auto center=f.position()+QPointF(size.width()/2,size.height()/2);
        const auto gap=QLineF(center,cursor).length();QVERIFY(gap>160&&gap<170);
        const auto settled=f.position();QVERIFY(!f.advance(cursor+QPointF(5,0),size,screen,.016));QCOMPARE(f.position(),settled);
    }
    void followingRetargetsWithoutJumpingAndPausesForPointer(){
        MouseFollower f;f.reset({600,300});const QSizeF size(192,208);const QRectF screen(0,0,1920,1080);
        for(int i=0;i<100;++i)f.advance({1400,500},size,screen,.016);
        const auto before=f.position();f.advance({100,500},size,screen,10.);
        QVERIFY(QLineF(before,f.position()).length()<=3.751); // Waking never produces a large leap.
        for(int i=0;i<100;++i)f.advance({100,500},size,screen,.016);
        QVERIFY(f.velocity().x()<0);
        const auto hovered=f.position();QVERIFY(!f.advance(hovered+QPointF(96,104),size,screen,.016));
        QCOMPARE(f.position(),hovered);QCOMPARE(f.velocity(),QPointF());
    }
    void followingHandlesScaledPetsAndNegativeMonitorCoordinates(){
        for(const QSizeF size:{QSizeF(96,104),QSizeF(576,624)}){
            MouseFollower f;const QRectF screen(-1920,-1080,1920,1080);f.reset({-1500,-950});
            for(int i=0;i<2200;++i)f.advance({-8,-8},size,screen,.016);
            QVERIFY(screen.contains(QRectF(f.position(),size)));QVERIFY(!f.moving());
        }
    }
    // F-036: ordered clamp bounds and a panel wholly inside its placement rectangle.
    void compactPanelStaysInsideItsPlacementRectangle(){
        struct Output{const char *name;QRect available;};
        const QList<Output> outputs{
            {"1920x1080",{0,0,1920,1080}},{"1920x1080 below a top bar",{0,32,1920,1048}},
            {"1280x720",{0,0,1280,720}},{"1280x720 with top and left panels",{56,40,1224,680}},
            {"1366x768",{0,0,1366,768}},{"360x640",{0,0,360,640}},
            {"negative origin",{-1920,-1080,1920,1080}},{"negative 1280x720",{-1280,200,1280,720}},
            {"smaller than the margins",{10,10,20,30}},
        };
        for(const auto &o:outputs){
            const QRect area=o.available.adjusted(12,40,-12,-12);
            for(const QSize pet:{QSize(96,104),QSize(192,208),QSize(576,624)})
                for(const double fx:{-.2,0.,.5,1.,1.2})for(const double fy:{-.2,0.,.5,1.,1.2}){
                    const QPoint position(o.available.left()+qRound(o.available.width()*fx)-pet.width()/2,o.available.top()+qRound(o.available.height()*fy)-pet.height()/2);
                    const QRect panel=Placement::compactPanel(o.available,position,pet);
                    const QString where=(QString("%1 pet %2x%3 at %4,%5 -> %6,%7 %8x%9").arg(o.name).arg(pet.width()).arg(pet.height()).arg(position.x()).arg(position.y())
                        .arg(panel.x()).arg(panel.y()).arg(panel.width()).arg(panel.height()));
                    QVERIFY2(panel.width()>=1&&panel.height()>=1,qPrintable(where));
                    if(area.isValid())QVERIFY2(area.contains(panel),qPrintable(where));
                    else QVERIFY2(panel.topLeft()==area.topLeft(),qPrintable(where));
                }
        }
        // The preferred size is kept where it fits and capped where it does not.
        QCOMPARE(Placement::compactPanel({0,0,1920,1080},{1500,700},{192,208}).size(),QSize(440,720));
        QCOMPARE(Placement::compactPanel({0,0,1280,720},{900,400},{192,208}).size(),QSize(440,668));
        QCOMPARE(Placement::compactPanel({0,0,1366,768},{900,400},{192,208}).size(),QSize(440,716));
        QCOMPARE(Placement::compactPanel({0,0,360,640},{100,300},{192,208}).size(),QSize(336,588));
        // These are the outputs where the former formulas gave std::clamp unordered bounds.
        for(const int height:{720,768}){const int former=std::min(720,height-40);QVERIFY(height-1-former-12<40);}
        QCOMPARE(Placement::bounded(5,40,27),40);
    }
    // F-037: consecutive roaming placements stay within the follower speed at seams.
    void roamingCrossesOutputSeamsWithoutJumping(){
        struct Layout{const char *name;QRect a,b;};
        const QList<Layout> layouts{
            {"horizontal",{0,0,1920,1080},{1920,0,1920,1080}},
            {"vertical",{0,0,1920,1080},{0,1080,1920,1080}},
            {"horizontal negative",{-1920,-1080,1920,1080},{0,-1080,1920,1080}},
            {"vertical negative",{-1920,-2160,1920,1080},{-1920,-1080,1920,1080}},
            {"mixed sizes",{0,0,1280,720},{1280,-200,2560,1440}},
        };
        const double dt=.016,rounding=1.5; // toPoint() moves each coordinate by at most half a pixel.
        for(const double scale:{.5,1.,3.})for(const auto &l:layouts){
            const QSize size(qRound(192*scale),qRound(208*scale));
            const bool horizontal=l.b.left()>l.a.right();
            const int gap=qRound(std::hypot(size.width()/2.,size.height()/2.))+24;
            const QPoint start=horizontal?QPoint(l.a.right()-size.width()-40,l.a.center().y()-size.height()/2):QPoint(l.a.center().x()-size.width()/2,l.a.bottom()-size.height()-40);
            const QPoint cursor=horizontal?QPoint(l.b.left()+std::min(l.b.width()-40,size.width()+gap+200),l.b.center().y())
                                          :QPoint(l.b.center().x(),l.b.top()+std::min(l.b.height()-40,size.height()+gap+200));
            const QString where=(QString("%1 at scale %2").arg(l.name).arg(scale));
            MouseFollower f;f.reset(start);
            QPoint shown=start,clampedBefore=start;QRect output=l.a;
            bool straddled=false;double clampedLargest=0;int frames=0;
            for(bool moving=true;moving&&frames<20000;++frames){
                // As in Controller::followMouse: the cursor's output constrains the follower,
                // and the output holding the pet's center hosts its surface.
                moving=f.advance(cursor,QSizeF(size),QRectF(l.b),dt);
                const QPoint position=f.position().toPoint(),center=position+QPoint(size.width()/2,size.height()/2);
                if(l.a.contains(center))output=l.a;else if(l.b.contains(center))output=l.b;
                const QPoint placed=Placement::pet(position,size,output,Placement::Mode::Roaming);
                QVERIFY2(QLineF(shown,placed).length()<=75*dt+rounding,qPrintable(where));
                const QRect rect(placed,size);
                if(rect.intersects(l.a)&&rect.intersects(l.b))straddled=true;
                // The whole-output clamp this replaces, for comparison.
                const QPoint clamped=Placement::pet(position,size,output,Placement::Mode::Resting);
                clampedLargest=std::max(clampedLargest,QLineF(clampedBefore,clamped).length());
                shown=placed;clampedBefore=clamped;
            }
            QVERIFY2(frames<20000,qPrintable(where));QVERIFY2(straddled,qPrintable(where));
            QVERIFY2(output==l.b,qPrintable(where));QVERIFY2(l.b.contains(QRect(shown,size)),qPrintable(where));
            QVERIFY2(clampedLargest>=std::min(size.width(),size.height())/2.,qPrintable(where));
        }
    }
    void cancellingMidCrossingKeepsTheVisiblePointAndSettlesAtRoamingSpeed(){
        const QRect a(-1920,0,1920,1080),b(0,0,1920,1080);
        for(const double scale:{.5,1.,3.}){
            const QSize size(qRound(192*scale),qRound(208*scale));
            const QPoint visible(-size.width()/2+7,300),center=visible+QPoint(size.width()/2,size.height()/2);
            QVERIFY(b.contains(center));QVERIFY(QRect(visible,size).intersects(a));
            QCOMPARE(Placement::pet(visible,size,b,Placement::Mode::Roaming),visible);
            const QPoint target=Placement::pet(visible,size,b,Placement::Mode::Resting);
            QVERIFY(b.contains(QRect(target,size)));
            QPoint at=visible;int frames=0;
            while(at!=target&&frames<10000){
                const QPoint next=Placement::settleStep(at,target,.016);
                QVERIFY(QLineF(at,next).length()<=std::max(1.,75*.016)+1.5);
                at=next;++frames;
            }
            QCOMPARE(at,target);QVERIFY(frames>1);
        }
        // A stalled timer is treated like the follower's 50 ms cap, and no interval stalls.
        QVERIFY(QLineF(QPointF(0,0),QPointF(Placement::settleStep({0,0},{500,0},10.))).length()<=75*.05+1);
        QCOMPARE(Placement::settleStep({0,0},{500,0},0.),QPoint(1,0));
        QCOMPARE(Placement::settleStep({0,0},{1,1},.016),QPoint(1,1));
    }
};
QTEST_GUILESS_MAIN(MotionCheck)
#include "motion.moc"
