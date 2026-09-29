#include "../native/motion.h"
#include "../native/follow.h"
#include <QtTest>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QImage>

class MotionCheck : public QObject {
    Q_OBJECT
    QVariantMap catalog;
    MotionDirector::Context visible() { MotionDirector::Context c;c.visible=true;return c; }
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
                QCOMPARE(qAlpha(texture.pixel(x,rect.top())),0);
                QCOMPARE(qAlpha(texture.pixel(x,rect.bottom())),0);
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
        c.intensity=1;d.setContext(c);QVERIFY(d.nextIdleDelay()>=18000);
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
};
QTEST_GUILESS_MAIN(MotionCheck)
#include "motion.moc"
