#include "../native/controller.h"
#include <QApplication>
#include <QtTest>
#include <QQuickItem>
#include <QTemporaryDir>
#include <QDir>
#include <QJsonDocument>
#include <QJsonObject>
#include <QImage>
#include <QPainter>
#include <QClipboard>
#include <QMimeData>
#include <QDesktopServices>
#include <QQuickTextDocument>
#include <QTextBlock>
#include <QTextFragment>
#include <QTextTable>
#include <QTextList>
#include <QAbstractTextDocumentLayout>
#include <QScreen>
#include <QQmlContext>
#include <QQmlExpression>
#include <QJSValue>
#include <QScopeGuard>
#include <QLocalServer>
#include <QLocalSocket>
#include <QSignalSpy>
#include <memory>
#include <QAccessible>
#include <QJsonArray>
#include <QRandomGenerator>
#include <QWheelEvent>
#include <QStandardPaths>
#include "../native/placement.h"
#include <QMutex>
#include <signal.h>

class UiCheck : public QObject {
    Q_OBJECT
    QTemporaryDir data;
    QProcess ollamaFixture;
    std::unique_ptr<Controller> app;
    // Views are deleted when the interface switches surfaces; a guarded pointer never dangles.
    QPointer<QQuickWindow> window;
    QString sessionId;
    QUrl openedMessageLink;
    QQuickItem *item(const QString &name){
        if(!window)return nullptr;
        std::function<QQuickItem*(QQuickItem*)> find=[&](QQuickItem*root)->QQuickItem*{if(!root->isVisible())return nullptr;if(root->objectName()==name)return root;for(auto child:root->childItems())if(auto match=find(child))return match;return nullptr;};
        return find(window->contentItem());
    }
    void click(const QString &name){
        auto control=item(name);QVERIFY2(control,qPrintable(name));
        for(auto parent=control->parentItem();parent;parent=parent->parentItem())if(parent->property("contentY").isValid()&&parent->property("contentHeight").toDouble()>parent->height()){
            const auto y=control->mapToItem(parent,QPointF(control->width()/2,control->height()/2)).y();
            if(y<10||y>parent->height()-10){parent->setProperty("contentY",std::clamp(parent->property("contentY").toDouble()+y-parent->height()/2,0.,parent->property("contentHeight").toDouble()-parent->height()));QTest::qWait(60);}
        }
        QTest::mouseClick(window,Qt::LeftButton,Qt::NoModifier,control->mapToScene(QPointF(control->width()/2,control->height()/2)).toPoint());QTest::qWait(120);
    }
    // Opens a conversation tool from its row, or from More when a short page folds the row away (F-03).
    void tool(const QString &row,const QString &entry){
        if(item(row)){click(row);return;}
        click("conversationMore");QTRY_VERIFY2(item(entry),qPrintable(entry));click(entry);
    }
    void capture(const QString &name){QVERIFY2(window,"no window to capture");QDir().mkpath("/tmp/cere-ui-evidence");QVERIFY(window->grabWindow().save("/tmp/cere-ui-evidence/"+name+".png"));}
    QJsonDocument hypr(const QStringList &args){QProcess p;p.start("hyprctl",args);if(!p.waitForFinished(2000))return {};return QJsonDocument::fromJson(p.readAllStandardOutput());}
    // Offscreen runs own a virtual pointer and never reach the live compositor.
    bool offscreen(){return qGuiApp->platformName()=="offscreen";}
    bool liveHyprland(){return qGuiApp->platformName().startsWith("wayland")&&!qEnvironmentVariableIsEmpty("HYPRLAND_INSTANCE_SIGNATURE");}
    QPoint pointer(){if(offscreen())return QCursor::pos();const auto p=hypr({"-j","cursorpos"}).object();return {p["x"].toInt(),p["y"].toInt()};}
    void movePointer(QPoint point){if(offscreen()){QCursor::setPos(point);return;}hypr({"dispatch",QString("hl.dsp.cursor.move({x=%1,y=%2})").arg(point.x()).arg(point.y())});}
    QQuickWindow *titled(const QString &title){for(auto w:qGuiApp->allWindows())if(w->title()==title&&w->isVisible())return qobject_cast<QQuickWindow*>(w);return nullptr;}
    // A broker call that waits for its own result.
    QVariantMap call(const QString &method,const QVariantMap &params={},int timeout=8000){
        QVariant value;bool done=false;const int id=app->rpc(method,params);
        const auto connection=connect(app.get(),&Controller::result,this,[&](int result,const QVariant &v){if(result==id){value=v;done=true;}});
        QElapsedTimer clock;clock.start();while(!done&&clock.elapsed()<timeout)QTest::qWait(20);
        disconnect(connection);
        return done?value.toMap():QVariantMap{{"error","No broker result for "+method}};
    }
    int count(const QString &name){
        int found=0;std::function<void(QQuickItem*)> walk=[&](QQuickItem*root){if(!root->isVisible())return;if(root->objectName()==name)++found;for(auto child:root->childItems())walk(child);};
        walk(window->contentItem());return found;
    }
    // Restores the expanded workspace as the window the remaining checks drive.
    // It waits without QTRY, which returns early once a check has already failed.
    void restoreWorkspace(){
        window=nullptr;app->expand();
        QElapsedTimer clock;clock.start();while(!(window=titled("Cere"))&&clock.elapsed()<8000)QTest::qWait(20);
        QVERIFY(window);QTest::qWait(200);
    }
    QRect floatingPet(){for(const auto value:hypr({"-j","clients"}).array()){
        const auto w=value.toObject();if(w["pid"].toInteger()!=QCoreApplication::applicationPid()||w["title"].toString()!="Cere Pet")continue;
        const auto p=w["at"].toArray(),s=w["size"].toArray();return {p[0].toInt(),p[1].toInt(),s[0].toInt(),s[1].toInt()};
    }return {};}
private slots:
    void recordMessageLink(const QUrl &url){openedMessageLink=url;}
    // A failed check must not leave the next one without a window to drive.
    void init(){if(app&&!window)restoreWorkspace();}
    void initTestCase(){
        qputenv("CERE_TTS_DISABLED","1"); // UI fixtures must never speak on the user's speakers.
        // The broker and overlay host inherit this, so an offscreen run is fully isolated.
        if(offscreen())qunsetenv("HYPRLAND_INSTANCE_SIGNATURE");
        ollamaFixture.start("node",{QString(CERE_SOURCE_DIR)+"/tests/fixtures/ui-ollama.mjs"});
        QVERIFY(ollamaFixture.waitForStarted(3000));QVERIFY(ollamaFixture.waitForReadyRead(3000));
        qputenv("CERE_OLLAMA_HOST",ollamaFixture.readAllStandardOutput().trimmed());
        qputenv("CERE_STATE_DIR",(data.path()+"/state").toUtf8());qputenv("CERE_RUNTIME_DIR",(data.path()+"/runtime").toUtf8());
        qputenv("CERE_HOST_EXEC",QByteArray(CERE_SOURCE_DIR)+"/build/cere");
        qputenv("CERE_CODEX_BIN",QByteArray(CERE_SOURCE_DIR)+"/tests/fixtures/ui-codex.mjs");
        qApp->setQuitOnLastWindowClosed(false);
        app=std::make_unique<Controller>(CERE_SOURCE_DIR,false);
        app->start(false);QTRY_VERIFY_WITH_TIMEOUT(app->connected(),10000);
        app->rpc("settings.update",{{"onboarding",false},{"roaming",false},{"position",QVariantMap{{"output","eDP-1"},{"x",.8},{"y",.7}}}});
        app->expand();
        QTRY_VERIFY_WITH_TIMEOUT(([&]{for(auto w:qGuiApp->allWindows())if(w->title()=="Cere"){window=qobject_cast<QQuickWindow*>(w);return window!=nullptr;}return false;})(),5000);
        QTRY_VERIFY(window->isVisible());QTest::qWait(500);
    }
    void navigationAndScreenshots(){
        QVERIFY(item("tab_Chat"));capture("chat-empty");
        click("tab_Desktop");QCOMPARE(window->contentItem()->childItems().first()->property("page").toInt(),2);QTest::qWait(1200);capture("desktop");
        click("tab_Settings");capture("settings");
        click("tab_Sessions");capture("sessions");click("tab_Chat");
    }
    void settingsSectionNavigation(){
        click("tab_Settings");
        auto search=item("settingsSearch"),picker=item("settingsSectionPicker"),scroll=item("settingsScroll");
        QVERIFY(search&&picker&&scroll);
        search->setProperty("text","voice");
        QTRY_COMPARE(picker->property("count").toInt(),1);
        QVERIFY(QMetaObject::invokeMethod(search,"accepted"));
        QTRY_VERIFY(scroll->property("contentY").toDouble()>0);
        QVERIFY(search->mapToScene(QPointF()).y()>=0);
        search->setProperty("text","no-such-setting");QTRY_COMPARE(picker->property("count").toInt(),0);
        search->setProperty("text","");QTRY_COMPARE(picker->property("count").toInt(),11);
        // F-05: the pairing response editor is a plain TextArea; Tab leaves it and inserts nothing.
        auto pairing=item("pairingResponse");QVERIFY(pairing);
        pairing->forceActiveFocus();QTRY_VERIFY(pairing->hasActiveFocus());
        QTest::keyClick(window,Qt::Key_Tab);
        QTRY_VERIFY2(!pairing->hasActiveFocus(),"Tab stayed in the pairing response editor");
        QVERIFY2(pairing->property("text").toString().isEmpty(),"Tab inserted text into the pairing response editor");
        scroll->setProperty("contentY",0);click("tab_Chat");
    }
    void workspaceTelemetryControls(){
        const QString root=data.path()+"/telemetry-project";QVERIFY(QDir().mkpath(root));
        const auto configured=call("settings.update",{{"telemetry",QVariantMap{{"roots",QStringList{root}}}}});QVERIFY(!configured.contains("error"));
        click("tab_Settings");auto scroll=item("settingsScroll");QVERIFY(scroll);scroll->setProperty("contentY",0);
        QVERIFY(item("telemetryEnabled"));click("telemetryEnabled");
        QTRY_COMPARE_WITH_TIMEOUT(app->state().value("telemetry").toMap().value("listener").toString(),QString("listening"),8000);
        QTRY_COMPARE(app->state().value("telemetry").toMap().value("watcher").toString(),QString("watching"));
        QProcess flood;QTimer heartbeat;heartbeat.setTimerType(Qt::PreciseTimer);heartbeat.setInterval(16);
        QElapsedTimer frameClock;frameClock.start();qint64 lastFrame=0,maxFrameGap=0;int frames=0;
        connect(&heartbeat,&QTimer::timeout,this,[&]{const auto now=frameClock.elapsed();maxFrameGap=std::max(maxFrameGap,now-lastFrame);lastFrame=now;frames++;});heartbeat.start();
        flood.start("python3",{"-c","import pathlib,sys,time\np=pathlib.Path(sys.argv[1])/'src';p.mkdir(exist_ok=True)\nfor batch in range(8):\n for i in range(512):\n  t=p/(str(i)+'.tmp');t.write_text(str(batch));t.replace(p/(str(i)+'.txt'))\n time.sleep(.05)\n",root});
        QTRY_COMPARE_WITH_TIMEOUT(flood.state(),QProcess::NotRunning,10000);QCOMPARE(flood.exitCode(),0);QTest::qWait(700);heartbeat.stop();
        QVERIFY(frames>10);QVERIFY2(maxFrameGap<150,qPrintable(QString("UI heartbeat stalled for %1 ms").arg(maxFrameGap)));
        qInfo("Telemetry flood UI heartbeat: %d frames, maximum gap %lld ms",frames,static_cast<long long>(maxFrameGap));
        QVERIFY(item("telemetryCommands"));click("telemetryCommands");
        QTRY_VERIFY(app->state().value("settings").toMap().value("telemetry").toMap().value("commands").toBool());
        click("telemetryPause");QTRY_VERIFY(app->state().value("telemetry").toMap().value("paused").toBool());
        click("telemetryClear");click("telemetryPause");QTRY_VERIFY(!app->state().value("telemetry").toMap().value("paused").toBool());
        capture("workspace-telemetry");
        QVERIFY(!call("settings.update",{{"telemetry",QVariantMap{{"enabled",false},{"commands",false},{"roots",QStringList{}}}}}).contains("error"));
        click("tab_Chat");
    }
    void apiProviderSetup(){
        click("tab_Settings");
        for(const auto &provider:{"openai","anthropic","google"}){
            auto key=item(QString("apiKey_")+provider);QVERIFY(key);
            QCOMPARE(key->property("echoMode").toInt(),2); // Password; never populated from state.
            QVERIFY(key->property("text").toString().isEmpty());
            const auto saved=call("provider.credentials",{{"provider",provider},{"key","fixture-ui-key"}});
            QVERIFY2(!saved.contains("error"),qPrintable(saved.value("error").toString()));
        }
        click("tab_Sessions");click("newSession");
        auto provider=item("sessionProvider");QVERIFY(provider);QCOMPARE(provider->property("count").toInt(),7);
        for(int index=4;index<7;index++){
            provider->setProperty("currentIndex",index);QTest::qWait(50);
            QVERIFY(item("sessionCustomModel"));QVERIFY(!item("sessionEffort"));
            auto tools=item("sessionTools");QVERIFY(tools);QVERIFY(tools->isEnabled());
        }
        item("sessionTitle")->setProperty("text","API setup check");
        item("sessionCustomModel")->setProperty("text","fixture-model");
        auto open=item("sessionOpen");QVERIFY(open);QVERIFY(open->isEnabled());click("sessionOpen");
        QTRY_COMPARE(app->session().value("provider").toString(),QString("google"));
        QCOMPARE(app->session().value("model").toString(),QString("fixture-model"));
        for(const auto &name:{"openai","anthropic","google"})call("provider.credentials",{{"provider",name},{"key",""}});
        click("tab_Chat");
        const auto originalId=app->selectedId();
        item("composer")->setProperty("text","Keep this API draft");
        tool("ollamaModelOptions","menuModelOptions");QTRY_VERIFY(item("conversationCustomModel"));
        QVERIFY(!item("conversationEffort"));
        item("conversationCustomModel")->setProperty("text","another-api-model");
        QTRY_VERIFY(item("ollamaSessionSave")->isEnabled());click("ollamaSessionSave");
        QTRY_COMPARE(app->session().value("model").toString(),QString("another-api-model"));
        QCOMPARE(app->selectedId(),originalId);
        QCOMPARE(item("composer")->property("text").toString(),QString("Keep this API draft"));
    }
    void conversationModelSwitching(){
        const auto created=call("session.create",{{"provider","codex"},{"model","fixture-model"},{"effort","high"},{"cwd",data.path()},{"trusted",true}});
        QVERIFY2(!created.contains("error"),qPrintable(created.value("error").toString()));
        app->select(created.value("id").toString());click("tab_Chat");
        QVERIFY(!call("session.send",{{"id",app->selectedId()},{"text","completion-model-switch"}}).contains("error"));
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        QTRY_VERIFY(app->transcript()->rowCount()>1);
        const auto rows=app->transcript()->rowCount();const auto nativeId=app->session().value("nativeId").toString();
        QVERIFY(!nativeId.isEmpty());
        item("composer")->setProperty("text","My next message");
        tool("ollamaModelOptions","menuModelOptions");auto picker=item("ollamaSessionModel");QVERIFY(picker);
        QTRY_COMPARE(picker->property("count").toInt(),3);
        QCOMPARE(item("conversationEffort")->property("currentValue").toString(),QString("high"));
        picker->setProperty("currentIndex",2);QVERIFY(QMetaObject::invokeMethod(picker,"activated",Q_ARG(int,2)));
        QCOMPARE(item("conversationEffort")->property("currentValue").toString(),QString());
        QCOMPARE(item("conversationEffort")->property("count").toInt(),2);
        item("conversationEffort")->setProperty("currentIndex",1);
        capture("conversation-model-switch");click("ollamaSessionSave");
        QTRY_COMPARE(app->session().value("model").toString(),QString("fixture-fast"));
        QCOMPARE(app->session().value("effort").toString(),QString("low"));
        QCOMPARE(app->session().value("nativeId").toString(),nativeId);
        QCOMPARE(app->transcript()->rowCount(),rows);
        QCOMPARE(item("composer")->property("text").toString(),QString("My next message"));
        QVERIFY(!call("session.send",{{"id",app->selectedId()},{"text","completion-new-model"}}).contains("error"));
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        QTRY_VERIFY(app->transcript()->rowCount()>rows);
    }
    void providerSpeechSwitches(){
        click("tab_Settings");const auto original=app->state().value("settings").toMap().value("speechProviders");
        const auto restore=qScopeGuard([&]{call("settings.update",{{"speechProviders",original}});click("tab_Chat");});
        QTRY_VERIFY(item("speechProvider_codex"));QVERIFY(item("speechProvider_ollama"));QVERIFY(item("speechProvider_google"));
        click("speechProvider_codex");
        QTRY_VERIFY(!app->state().value("settings").toMap().value("speechProviders").toMap().value("codex").toBool());
        QVERIFY(item("speechProvider_claude")->property("checked").toBool());
        capture("speech-provider-switches");
        click("speechProvider_codex");QTRY_VERIFY(app->state().value("settings").toMap().value("speechProviders").toMap().value("codex").toBool());
    }
    void elevenLabsSettings(){
        click("tab_Settings");
        const auto original=app->state().value("settings").toMap();
        const auto restore=qScopeGuard([&]{call("settings.update",{{"ttsProvider",original.value("ttsProvider")},{"elevenlabs",original.value("elevenlabs")}});call("elevenlabs.credentials",{{"key",""}});click("tab_Chat");});
        QVERIFY(!call("settings.update",{{"ttsProvider","elevenlabs"}}).contains("error"));
        QTRY_VERIFY(item("elevenLabsSettings"));QVERIFY(!item("speechVoice"));
        QTRY_VERIFY(item("elevenApiKey"));QCOMPARE(item("elevenApiKey")->property("echoMode").toInt(),2);
        QVERIFY(!call("elevenlabs.credentials",{{"key","fixture-eleven-key"}}).contains("error"));
        QVERIFY(!call("settings.update",{{"elevenlabs",QVariantMap{{"voiceId","fixture-voice"},{"modelId","eleven_flash_v2_5"},{"allowCloud",true}}}}).contains("error"));
        QTRY_COMPARE(item("elevenVoiceId")->property("text").toString(),QString("fixture-voice"));
        QVERIFY(item("elevenCloudConsent")->property("checked").toBool());
        click("elevenVoiceId");capture("elevenlabs-settings");
        QVERIFY(!call("settings.update",{{"ttsProvider","local"}}).contains("error"));
        QTRY_VERIFY(item("speechVoice"));QVERIFY(!item("elevenLabsSettings"));
    }
    void indexTtsSettings(){
        click("tab_Settings");
        const auto original=app->state().value("settings").toMap();
        const auto restore=qScopeGuard([&]{call("settings.update",{{"ttsProvider",original.value("ttsProvider")},{"indextts",original.value("indextts")}});click("tab_Chat");});
        QVERIFY(!call("settings.update",{{"ttsProvider","indextts"},{"indextts",QVariantMap{{"modelDir",data.path()+"/missing-index-model"},{"profileId",""}}}}).contains("error"));
        QTRY_VERIFY(item("indexTtsSettings"));
        auto panel=item("indexTtsSettings");
        QTRY_VERIFY(item("indexVoiceName"));
        QVERIFY(!item("speechVoice"));
        QVariantMap caps{{"languages",QStringList{"en","zh"}},{"emotionModes",QStringList{"same-as-speaker","vector"}},{"durationControl",false}};
        panel->setProperty("caps",caps);QTest::qWait(100);QVERIFY(!item("indexDuration"));
        caps["durationControl"]=true;caps["languages"]=QStringList{"zh","en","ja","es","ar"};panel->setProperty("caps",caps);
        QTRY_VERIFY(item("indexDuration"));
        item("indexVoiceName")->setProperty("text","Fixture voice");
        QCOMPARE(item("indexVoiceName")->property("text").toString(),QString("Fixture voice"));
        click("indexVoiceName");capture("indextts-voice-profile");
        click("ttsProvider");QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(100);capture("indextts-settings");
        QVERIFY(!call("settings.update",{{"ttsProvider","local"}}).contains("error"));
        QTRY_VERIFY(item("speechVoice"));QVERIFY(!item("indexTtsSettings"));
    }
    void voiceSettings(){
        click("tab_Settings");
        auto enabled=item("speechEnabled"),voice=item("speechVoice");QVERIFY(enabled&&voice);
        const auto original=app->state().value("settings").toMap();
        const auto restore=qScopeGuard([&]{call("settings.update",{{"speechEnabled",original.value("speechEnabled")},{"voice",original.value("voice")},{"speechRate",original.value("speechRate")},{"speechPitch",original.value("speechPitch")},{"speechVolume",original.value("speechVolume")}});click("tab_Chat");});
        QCOMPARE(voice->property("displayText").toString(),QString("en_US-amy-medium"));
        QTRY_VERIFY(voice->property("count").toInt()>0);
        QVERIFY(QMetaObject::invokeMethod(enabled,"toggle"));
        QVERIFY(QMetaObject::invokeMethod(enabled,"clicked"));
        QTRY_COMPARE(app->state().value("settings").toMap().value("speechEnabled").toBool(),false);
        QVERIFY(!call("tts.test").contains("error"));
        QVERIFY(!call("tts.stop").contains("error"));
        QVERIFY(item("ttsTest")&&item("ttsStop")&&item("ttsStatus"));
        auto pitch=item("speechPitch"),rate=item("speechRate"),volume=item("speechVolume");QVERIFY(pitch&&rate&&volume);
        click("speechPitch");QTest::keyClick(window,Qt::Key_Right);
        QTRY_COMPARE(app->state().value("settings").toMap().value("speechPitch").toDouble(),.5);
        click("speechRate");QTest::keyClick(window,Qt::Key_End);
        QTRY_COMPARE(app->state().value("settings").toMap().value("speechRate").toDouble(),2.);
        click("speechVolume");QTest::keyClick(window,Qt::Key_Home);
        QTRY_COMPARE(app->state().value("settings").toMap().value("speechVolume").toDouble(),0.);
        QVERIFY(item("ttsStatus")->property("text").toString().contains("muted"));
        click("resetVoiceTuning");
        QTRY_COMPARE(app->state().value("settings").toMap().value("speechPitch").toDouble(),0.);
        QTRY_COMPARE(pitch->property("value").toDouble(),0.);
        QTRY_COMPARE(rate->property("value").toDouble(),1.);
        QTRY_COMPARE(volume->property("value").toDouble(),1.);
        QCOMPARE(app->state().value("settings").toMap().value("voice"),original.value("voice"));
        // A continuous pointer drag writes one setting update on release.
        click("speechPitch");
        const auto revision=app->state().value("settingsRevision");
        const auto start=pitch->mapToScene(QPointF(pitch->width()/2,pitch->height()/2)).toPoint();
        const auto end=pitch->mapToScene(QPointF(pitch->width()*.7,pitch->height()/2)).toPoint();
        QTest::mousePress(window,Qt::LeftButton,Qt::NoModifier,start);
        QTest::mouseMove(window,end);QTest::qWait(100);
        QCOMPARE(app->state().value("settingsRevision"),revision);
        QTest::mouseRelease(window,Qt::LeftButton,Qt::NoModifier,end);
        QTRY_VERIFY(app->state().value("settings").toMap().value("speechPitch").toDouble()>0.);
        QTRY_COMPARE(app->state().value("settingsRevision").toString().toLongLong(),revision.toString().toLongLong()+1);
        QVERIFY(item("ttsTest")->isEnabled());
        auto scroll=item("settingsScroll");QVERIFY(scroll);
        scroll->setProperty("contentY",voice->mapToItem(scroll,QPointF()).y()+scroll->property("contentY").toDouble()-170);
        QTest::qWait(100);capture("voice-settings");
    }
    void personalitySettings(){
        click("tab_Settings");
        auto editor=item("personalityText");QVERIFY(editor);
        const auto original=app->state().value("settings").toMap().value("personality").toString();
        QVERIFY(original.contains("You are Cere, a sharp-tongued desktop companion"));
        QCOMPARE(editor->property("text").toString(),original);
        QVERIFY(!item("personalitySave")->isEnabled());
        const auto restore=qScopeGuard([&]{app->rpc("settings.update",{{"personality",original}});click("tab_Chat");});
        const QString custom="Be calm and quietly encouraging.\nKeep replies concise.";
        editor->setProperty("text",custom);
        app->rpc("settings.update",{{"quiet",false}});QTest::qWait(150);
        QCOMPARE(editor->property("text").toString(),custom);
        click("tab_Chat");click("tab_Settings");
        QCOMPARE(editor->property("text").toString(),custom);
        click("personalitySave");
        QTRY_COMPARE(app->state().value("settings").toMap().value("personality").toString(),custom);
        QVERIFY(!item("personalitySave")->isEnabled());
        editor->setProperty("text","Unsaved local draft");
        app->rpc("settings.update",{{"personality","Saved in another window"}});
        QTRY_COMPARE(app->state().value("settings").toMap().value("personality").toString(),QString("Saved in another window"));
        QCOMPARE(editor->property("text").toString(),QString("Unsaved local draft"));
        click("personalityDiscard");QCOMPARE(editor->property("text").toString(),QString("Saved in another window"));
        editor->setProperty("text",QString(8001,'x'));QVERIFY(!item("personalitySave")->isEnabled());
        editor->setProperty("text",QString("Invalid")+QChar(1));click("personalitySave");
        QTRY_VERIFY(item("personalityError"));
        QVERIFY(item("personalityError")->property("text").toString().contains("control characters"));
        QCOMPARE(editor->property("text").toString(),QString("Invalid")+QChar(1));
        QCOMPARE(app->state().value("settings").toMap().value("personality").toString(),QString("Saved in another window"));
        editor->setProperty("text","");click("personalitySave");
        QTRY_COMPARE(app->state().value("settings").toMap().value("personality").toString(),QString());
        click("personalityReset");QCOMPARE(editor->property("text").toString(),original);
        QCOMPARE(app->state().value("settings").toMap().value("personality").toString(),QString());
        click("personalitySave");QTRY_COMPARE(app->state().value("settings").toMap().value("personality").toString(),original);
        auto scroll=item("settingsScroll");QVERIFY(scroll);
        scroll->setProperty("contentY",editor->mapToItem(scroll,QPointF()).y()+scroll->property("contentY").toDouble()-110);
        QTest::qWait(100);capture("personality-settings");
    }
    void markdownMessages(){
        click("tab_Chat");
        QImage inlineImage(24,24,QImage::Format_ARGB32);inlineImage.fill(QColor("#5dd8ff"));
        const auto imagePath=data.path()+"/markdown-image.png";QVERIFY(inlineImage.save(imagePath));
        const QString markdown=QString::fromUtf8(R"MD(# Markdown heading

**Bold** and *italic*, ~~removed~~ and `inline_code`.

> Quoted **text**

1. First item
   - Nested bullet
2. Second item

- [x] Finished task
- [ ] Open task

| Name | Value |
| --- | --- |
| Cere | **Ready** |

[Documentation](https://example.com/docs) and <https://example.com>.

~~~~cpp
const auto fence = "```";
~~~~

---

Unicode: café ✦ 日本語
)MD")+"\n![Local image]("+QUrl::fromLocalFile(imagePath).toString()+")\n";
        const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Markdown rendering"}});
        QTRY_VERIFY(app->selectedId()!=previous);
        auto model=static_cast<TranscriptModel*>(static_cast<QSortFilterProxyModel*>(app->transcript())->sourceModel());
        model->reset({QVariantMap{{"id","markdown"},{"role","assistant"},{"text",markdown}}});
        QTRY_VERIFY(item("messageBody_markdown"));
        auto body=item("messageBody_markdown");
        auto document=body->property("textDocument").value<QQuickTextDocument*>()->textDocument();
        QVERIFY(document->toPlainText().contains("Markdown heading"));
        QVERIFY(!document->toPlainText().contains("**Bold**"));
        bool heading=false,bold=false,italic=false,strike=false,code=false,quote=false,nested=false,task=false,table=false,link=false,image=false;
        for(auto block=document->begin();block.isValid();block=block.next()){
            heading|=block.blockFormat().headingLevel()==1;
            quote|=block.blockFormat().intProperty(QTextFormat::BlockQuoteLevel)>0;
            task|=block.blockFormat().marker()==QTextBlockFormat::MarkerType::Checked;
            if(block.textList())nested|=block.textList()->format().indent()>1;
            for(auto it=block.begin();!it.atEnd();++it){
                const auto fragment=it.fragment();const auto format=fragment.charFormat();
                bold|=fragment.text().contains("Bold")&&format.fontWeight()>=QFont::Bold;
                italic|=fragment.text().contains("italic")&&format.fontItalic();
                strike|=fragment.text().contains("removed")&&format.fontStrikeOut();
                code|=fragment.text().contains("inline_code")&&format.fontFixedPitch();
                link|=format.anchorHref()=="https://example.com/docs";
                image|=format.isImageFormat();
            }
        }
        for(auto frame:document->rootFrame()->childFrames())if(auto t=qobject_cast<QTextTable*>(frame))table=t->rows()==2&&t->columns()==2;
        QVERIFY(heading);QVERIFY(bold);QVERIFY(italic);QVERIFY(strike);QVERIFY(code);QVERIFY(quote);QVERIFY(nested);QVERIFY(task);QVERIFY(table);QVERIFY(link);QVERIFY(image);
        QVERIFY(document->toPlainText().contains("const auto fence = \"```\";"));
        QVERIFY(document->toPlainText().contains(QString::fromUtf8("café ✦ 日本語")));
        QDesktopServices::setUrlHandler("https",this,"recordMessageLink");
        QDesktopServices::setUrlHandler("file",this,"recordMessageLink");
        const auto restoreLinks=qScopeGuard([]{QDesktopServices::unsetUrlHandler("https");QDesktopServices::unsetUrlHandler("file");});
        QVERIFY(QMetaObject::invokeMethod(body,"linkActivated",Q_ARG(QString,"https://example.com/docs")));
        QCOMPARE(openedMessageLink,QUrl("https://example.com/docs"));
        QVERIFY(QMetaObject::invokeMethod(body,"linkActivated",Q_ARG(QString,"javascript:alert(1)")));
        QCOMPARE(openedMessageLink,QUrl("https://example.com/docs"));
        QVERIFY(QMetaObject::invokeMethod(body,"linkActivated",Q_ARG(QString,"docs/readme.md")));
        QCOMPARE(openedMessageLink,QUrl::fromLocalFile(data.path()+"/docs/readme.md"));
        QVERIFY(body->property("readOnly").toBool());QVERIFY(body->property("selectByMouse").toBool());
        QVERIFY(QMetaObject::invokeMethod(body,"selectAll"));
        QVERIFY(body->property("selectedText").toString().contains("Markdown heading"));
        click("copyMessage_markdown");QCOMPARE(QGuiApplication::clipboard()->text(),markdown);
        QVERIFY(QMetaObject::invokeMethod(body,"deselect"));
        capture("markdown-formatted");
        const auto original=window->size(),minimum=window->minimumSize();window->setMinimumSize({360,560});window->resize(440,720);QTest::qWait(200);
        QVERIFY(body->width()>100);QVERIFY(body->width()<440);
        capture("markdown-compact");window->setMinimumSize(minimum);window->resize(original);QTRY_COMPARE(window->size(),original);QTest::qWait(250);
        model->upsert({{"id","markdown"},{"role","assistant"},{"text","**Streaming"}});
        QTRY_VERIFY(document->toPlainText().contains("Streaming"));
        model->upsert({{"id","markdown"},{"role","assistant"},{"text","**Streaming complete**\n\n```js\nconst ready = true;\n```"}});
        QTRY_VERIFY(document->toPlainText().contains("const ready = true;"));
        QCOMPARE(app->transcript()->rowCount(),1);
        QVERIFY(!document->toPlainText().contains("**Streaming"));
        QStringList columns,dividers;
        for(int i=0;i<30;++i){columns<<QString("Column%1").arg(i);dividers<<"---";}
        const auto wide="|"+columns.join('|')+"|\n|"+dividers.join('|')+"|\n|"+columns.join('|')+"|";
        model->upsert({{"id","markdown"},{"role","assistant"},{"text",wide}});
        const auto horizontal=item("messageViewport_markdown");QVERIFY(horizontal);
        QTRY_VERIFY(horizontal->property("contentWidth").toDouble()>horizontal->width());
        QTRY_VERIFY(body->width()>horizontal->width());
        horizontal->setProperty("contentX",horizontal->property("contentWidth").toDouble()-horizontal->width());
        QVERIFY(horizontal->property("contentX").toDouble()>0);
        QTest::qWait(250);capture("markdown-wide-table");
        model->upsert({{"id","markdown"},{"role","assistant"},{"text","A short response after a wide table."}});
        QTRY_COMPARE(body->width(),horizontal->width());
    }
    void permissionPowerSession(){
        const auto created=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Power permissions check"}});
        QVERIFY(!created.contains("error"));app->select(created.value("id").toString());
        click("shellPermissionCenter");QTRY_VERIFY(item("powerCliAccess"));
        click("powerCliAccess");QTRY_VERIFY(item("startPower")->isEnabled());click("startPower");
        QTRY_COMPARE(app->state().value("power").toList().size(),1);
        const auto lease=app->state().value("power").toList().first().toMap();
        QCOMPARE(lease.value("state").toString(),QString("active"));
        QVERIFY(!app->state().value("settings").toMap().value("bypassCliPermissions").toBool());
        capture("permission-power-session");
        QVERIFY(!call("power.end",{{"id",lease.value("id")}}).contains("error"));
        QTRY_COMPARE(app->state().value("power").toList().first().toMap().value("state").toString(),QString("ended"));
        for(auto w:qGuiApp->allWindows())for(auto center:w->findChildren<QObject*>("permissionCenter"))if(center->property("opened").toBool())QVERIFY(QMetaObject::invokeMethod(center,"close"));
        click("tab_Chat");
    }
    void projectAndDraft(){
        // Wait for the new session itself: an earlier check may have left another one selected.
        const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","UI integration test"}});
        QTRY_VERIFY(!app->selectedId().isEmpty()&&app->selectedId()!=previous);sessionId=app->selectedId();
        QTRY_COMPARE(app->session().value("id").toString(),sessionId);
        auto composer=item("composer");QVERIFY(composer);composer->setProperty("text","A draft that must survive session switching.");
        app->rpc("session.create",{{"provider","claude"},{"cwd",data.path()},{"trusted",true},{"title","Second session"}});
        QTRY_VERIFY(app->selectedId()!=sessionId);app->select(sessionId);
        QTRY_COMPARE(item("composer")->property("text").toString(),QString("A draft that must survive session switching."));capture("draft");
    }
    void queuedOllamaMessages(){
        click("tab_Chat");
        call("settings.update",{{"quiet",true},{"memory",QVariantMap{{"enabled",false}}}});
        const auto session=createSession("ollama","Queue regression","fixture-chat:latest");
        QVERIFY(!session.isEmpty());app->select(session);
        call("session.send",{{"id",session},{"text","queue-validation-hold"}});
        QTRY_COMPARE(app->session().value("status").toString(),QString("working"));
        QTRY_VERIFY(item("sendMessage"));QVERIFY(item("stopMessage"));
        auto composer=item("composer");QVERIFY(composer);QVERIFY(composer->isEnabled());
        composer->setProperty("text","A follow-up while working");
        QTRY_VERIFY(item("sendMessage")->isEnabled());click("sendMessage");
        QTRY_COMPARE(app->session().value("queuedCount").toInt(),1);
        QTRY_COMPARE(composer->property("text").toString(),QString());
        capture("ollama-queued-followup");
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("status").toString(),QString("idle"),8000);
        QTRY_COMPARE(app->session().value("queuedCount").toInt(),0);
        int prompts=0;for(const auto &m:app->messages())if(m.toMap().value("role").toString()=="user")++prompts;
        QCOMPARE(prompts,2);
    }
    void ollamaConversation(){
        click("tab_Settings");
        auto defaults=item("ollamaDefaultModel");QVERIFY(defaults);
        QTRY_COMPARE_WITH_TIMEOUT(defaults->property("count").toInt(),3,5000);
        defaults->setProperty("currentIndex",1);QVERIFY(QMetaObject::invokeMethod(defaults,"activated",Q_ARG(int,1)));
        QTRY_COMPARE(app->state().value("settings").toMap().value("ollama").toMap().value("model").toString(),QString("fixture-chat:latest"));
        auto settings=item("settingsScroll");QVERIFY(settings);
        settings->setProperty("contentY",defaults->mapToItem(settings,QPointF(0,0)).y()+settings->property("contentY").toDouble()-250);
        QTest::qWait(100);capture("ollama-settings");
        click("tab_Sessions");click("newSession");
        auto provider=item("sessionProvider");QVERIFY(provider);
        QCOMPARE(provider->property("count").toInt(),7);
        provider->setProperty("currentIndex",2);QVERIFY(QMetaObject::invokeMethod(provider,"activated",Q_ARG(int,2)));
        QTRY_COMPARE(item("sessionModel")->property("count").toInt(),3);
        QCOMPARE(item("sessionModel")->property("currentValue").toString(),QString());
        QVERIFY(!item("sessionEffort"));QVERIFY(item("sessionTools"));
        QVERIFY(item("sessionTitle"));
        item("sessionTitle")->setProperty("text","  My thoughtfully named session  ");
        QTRY_VERIFY(item("sessionOpen")->isEnabled());capture("ollama-new-session");
        click("sessionOpen");QTRY_COMPARE(app->session().value("provider").toString(),QString("ollama"));
        QCOMPARE(app->session().value("model").toString(),QString("fixture-chat:latest"));
        QCOMPARE(app->session().value("title").toString(),QString("My thoughtfully named session"));
        const auto session=app->selectedId();
        app->rpc("session.send",{{"id",session},{"text","Say hello"}});
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        QTRY_COMPARE(app->transcript()->rowCount(),2);
        QCOMPARE(app->session().value("title").toString(),QString("My thoughtfully named session"));
        capture("ollama-conversation");
        click("renameSession");
        QTRY_VERIFY(item("renameSessionTitle")->hasActiveFocus());
        item("renameSessionTitle")->setProperty("text","  Renamed conversation  ");
        click("saveSessionTitle");
        QTRY_COMPARE(app->session().value("title").toString(),QString("Renamed conversation"));
        tool("ollamaModelOptions","menuModelOptions");auto picker=item("ollamaSessionModel");QVERIFY(picker);
        QTRY_COMPARE(picker->property("count").toInt(),2);
        picker->setProperty("currentIndex",1);QVERIFY(QMetaObject::invokeMethod(picker,"activated",Q_ARG(int,1)));
        QVERIFY(!item("ollamaSessionTools")->isEnabled());capture("ollama-model-options");
        click("ollamaSessionSave");QTRY_COMPARE(app->session().value("model").toString(),QString("fixture-plain:latest"));
        QCOMPARE(app->state().value("settings").toMap().value("ollama").toMap().value("model").toString(),QString("fixture-chat:latest"));
        tool("chatHandoff","menuHandoff");QCOMPARE(item("handoffProvider")->property("count").toInt(),6);
        QVERIFY(item("handoffTrust"));QVERIFY(!item("handoffCreate")->isEnabled());
        item("handoffTrust")->setProperty("checked",true);click("handoffCreate");
        QTRY_COMPARE(app->session().value("provider").toString(),QString("codex"));
        QTRY_VERIFY(item("composer")->property("text").toString().contains("Hello from Ollama"));
        QCOMPARE(app->session().value("status").toString(),QString("idle"));
    }
    void extractionModelSelection(){
        auto fixtureModels=[&](const QString &method){
            QProcess request;
            request.start("node",{"--input-type=module","-e","await fetch(process.env.CERE_OLLAMA_HOST+'/test/extraction-models',{method:process.argv[1]})",method});
            return request.waitForFinished(5000)&&request.exitCode()==0;
        };
        QVERIFY(fixtureModels("POST"));
        const auto previous=app->state().value("settings").toMap().value("memory").toMap();
        auto restore=qScopeGuard([&]{fixtureModels("DELETE");call("provider.models",{{"provider","ollama"}});call("settings.update",{{"memory",previous}});});
        QVERIFY(!call("settings.update",{{"memory",QVariantMap{{"enabled",true},{"extractionModel","nemotron-3-super"}}}}).contains("error"));
        click("tab_Settings");click("extractionModelsRefresh");
        auto picker=item("extractionModel");QVERIFY(picker);
        QTRY_COMPARE(picker->property("count").toInt(),3);
        QTRY_COMPARE(picker->property("currentValue").toString(),QString("nemotron-3-super:cloud"));
        QTRY_VERIFY(picker->isEnabled());
        click("extractionModel");
        auto popup=qvariant_cast<QObject*>(picker->property("popup"));QVERIFY(popup);
        QTRY_VERIFY(popup->property("visible").toBool());
        QTest::keyClick(window,Qt::Key_Home);QTest::keyClick(window,Qt::Key_Return);
        QTRY_COMPARE(app->state().value("settings").toMap().value("memory").toMap().value("extractionModel").toString(),QString("glm-5.3-flash:cloud"));
        QTRY_VERIFY(picker->isEnabled());
        capture("extraction-model-selection");
        // A change from another client must still update the selection after user activation.
        QVERIFY(!call("settings.update",{{"memory",QVariantMap{{"extractionModel","nemotron-3-ultra:cloud"}}}}).contains("error"));
        QTRY_COMPARE(picker->property("currentValue").toString(),QString("nemotron-3-ultra:cloud"));
        click("extractionModelsRefresh");
        QTRY_VERIFY(picker->isEnabled());
        QTRY_COMPARE(picker->property("currentValue").toString(),QString("nemotron-3-ultra:cloud"));
        QVERIFY(!call("settings.update",{{"memory",QVariantMap{{"extractionModel","unregistered-cloud-model"}}}}).contains("error"));
        QTRY_COMPARE(picker->property("count").toInt(),4);
        QTRY_COMPARE(picker->property("currentValue").toString(),QString("unregistered-cloud-model"));
    }
    void searchAndMemory(){
        click("tab_Chat");
        const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","ollama"},{"model","fixture-plain:latest"},{"cwd",data.path()}});
        QTRY_VERIFY(app->selectedId()!=previous);
        click("tab_Settings");
        auto reveal=[&](const QString &name){auto scroll=item("settingsScroll"),control=item(name);if(scroll&&control){scroll->setProperty("contentY",control->mapToItem(scroll,QPointF()).y()+scroll->property("contentY").toDouble()-180);QTest::qWait(100);}};
        reveal("webSearchEnabled");click("webSearchEnabled");
        QTRY_VERIFY(app->state().value("settings").toMap().value("webSearch").toMap().value("enabled").toBool());
        auto provider=item("webSearchProvider");QVERIFY(provider);QCOMPARE(provider->property("count").toInt(),5);
        provider->setProperty("currentIndex",4);QVERIFY(QMetaObject::invokeMethod(provider,"activated",Q_ARG(int,4)));
        QVERIFY(item("searxngUrl"));item("searxngUrl")->setProperty("text",qEnvironmentVariable("CERE_OLLAMA_HOST"));
        reveal("webSearchSave");click("webSearchSave");
        QTRY_COMPARE(app->state().value("settings").toMap().value("webSearch").toMap().value("provider").toString(),QString("searxng"));
        capture("web-search-settings");
        reveal("memoryEnabled");click("memoryEnabled");
        QTRY_VERIFY(app->state().value("settings").toMap().value("memory").toMap().value("enabled").toBool());
        QCOMPARE(item("embeddingModel")->property("text").toString(),QString("nomic-embed-text"));
        reveal("memoryCheck");click("memoryCheck");
        QTRY_COMPARE_WITH_TIMEOUT(app->state().value("memory").toMap().value("state").toString(),QString("ready"),5000);
        capture("memory-settings");
        reveal("manageMemories");click("manageMemories");click("addMemory");
        auto editor=item("memoryText");QVERIFY(editor);editor->setProperty("text","My morning drink is espresso.");click("saveMemory");
        QTRY_COMPARE(app->state().value("memory").toMap().value("saved").toInt(),1);QTest::qWait(100);capture("project-memory");
        click("openGraphInspector");
        QTRY_VERIFY(item("graphMemoryDetails"));
        QTRY_VERIFY_WITH_TIMEOUT(item("graphMemoryDetails")->property("text").toString().contains("sqlite"),5000);
        QVERIFY(item("graphMemoryQuery"));QVERIFY(item("graphMemoryMutation"));
        capture("graph-memory-inspector");
        QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(100);click("closeMemory");
        click("tab_Chat");QVERIFY(item("searchThisTurn"));
        item("composer")->setProperty("text","Find Ollama embeddings documentation");click("searchThisTurn");
        auto composer=item("composer");composer->forceActiveFocus();QTest::keyClick(window,Qt::Key_Return,Qt::ControlModifier);
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("status").toString(),QString("idle"),5000);
        QTRY_VERIFY(app->messages().size()>=3);
        bool linked=false;for(const auto &message:app->messages())if(!message.toMap().value("sources").toList().isEmpty())linked=true;
        QVERIFY(linked);QVERIFY(!item("searchThisTurn")->property("checked").toBool());capture("web-search-conversation");
        auto send=item("sendMessage");
        QVERIFY2(send,qPrintable(QString("status=%1 activity=%2 messages=%3 roles=%4").arg(app->session().value("status").toString(),app->session().value("activity").toString()).arg(app->messages().size())
            .arg([&]{QStringList roles;for(const auto &m:app->messages())roles<<m.toMap().value("role").toString();return roles.join(",");}())));
        QVERIFY(send->mapToScene(QPointF(0,send->height())).y()<window->height());
    }
    void questionsAndAgentActivity(){
        click("tab_Chat");
        app->rpc("settings.update",{{"bypassCliPermissions",false},{"quiet",true},{"reducedMotion",true},{"memory",QVariantMap{{"enabled",false}}}});
        const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Question and agent checks"}});
        QTRY_VERIFY(app->selectedId()!=previous);const auto session=app->selectedId();
        app->rpc("session.send",{{"id",session},{"text","questions"}});
        QTRY_COMPARE(app->state().value("approvals").toList().size(),1);
        QTRY_COMPARE(app->session().value("status").toString(),QString("waiting"));
        const auto approval=app->state().value("approvals").toList().first().toMap().value("id").toString();
        QTRY_VERIFY(item("approval_"+approval+"_answer"));
        QVERIFY(QMetaObject::invokeMethod(item("approval_"+approval+"_answer"),"clicked"));
        QCOMPARE(app->state().value("approvals").toList().size(),1);
        auto choose=[&](const QString &label){auto option=item("question_"+approval+"_checks_"+label);QVERIFY(option);option->setProperty("checked",true);QVERIFY(QMetaObject::invokeMethod(option,"clicked"));};
        choose("Build");choose("Tests");
        QPointer<QQuickItem> answer=item("questionOther_"+approval+"_context");QVERIFY(answer);answer->forceActiveFocus();answer->setProperty("text","Keep my existing edits.\nValidate the result.");
        QTRY_COMPARE(app->questionDraft(approval).value("checks").toMap().value("answers").toList().size(),2);
        QTRY_VERIFY(app->questionDraft(approval).value("context").toMap().value("answers").toList().first().toString().contains("existing edits"));
        app->rpc("settings.update",{{"expressiveCues",false}});QTest::qWait(200);
        QVERIFY(answer);QVERIFY(answer->hasActiveFocus());
        QCOMPARE(item("questionOther_"+approval+"_context"),answer.data());
        click("tab_Sessions");click("tab_Chat");
        QTRY_VERIFY(item("question_"+approval+"_checks_Build"));QVERIFY(item("question_"+approval+"_checks_Build")->property("checked").toBool());
        QCOMPARE(item("questionOther_"+approval+"_context")->property("text").toString(),QString("Keep my existing edits.\nValidate the result."));
        capture("question-form");
        {
            auto original=window;
            const auto restoreWindow=qScopeGuard([&]{window=original;});
            QQuickView compact;compact.setResizeMode(QQuickView::SizeRootObjectToView);
            compact.rootContext()->setContextProperty("App",app.get());compact.setSource(QUrl::fromLocalFile(QString(CERE_SOURCE_DIR)+"/qml/Panel.qml"));
            QCOMPARE(compact.status(),QQuickView::Ready);compact.resize(360,560);compact.show();window=&compact;QTest::qWait(100);
            QTRY_VERIFY(item("question_"+approval+"_checks_Build"));
            QVERIFY(item("question_"+approval+"_checks_Build")->property("checked").toBool());
            QCOMPARE(item("questionOther_"+approval+"_context")->property("text").toString(),QString("Keep my existing edits.\nValidate the result."));
            for(const QString name:{"question_"+approval+"_checks_Build","questionOther_"+approval+"_context","approval_"+approval+"_answer"}){
                auto control=item(name);QVERIFY(control);const auto point=control->mapToScene(QPointF());
                QVERIFY(point.x()>=0&&point.x()+control->width()<=compact.width());
            }
            capture("question-form-compact");compact.hide();
        }
        QVERIFY(QMetaObject::invokeMethod(item("approval_"+approval+"_answer"),"clicked"));
        QTRY_VERIFY(app->state().value("approvals").toList().isEmpty());QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        QVERIFY(app->questionDraft(approval).isEmpty());
        bool found=false;for(const auto &message:app->messages())if(message.toMap().value("kind").toString()=="answer")found=message.toMap().value("text").toString().contains("Build, Tests");QVERIFY(found);
        app->rpc("session.send",{{"id",session},{"text","agents"}});
        QTRY_COMPARE(app->session().value("agents").toList().size(),1);
        QTRY_VERIFY(item("activityToggle")->property("text").toString().contains("1 subagent active"));
        QTest::qWait(750);QCOMPARE(app->session().value("status").toString(),QString("working"));
        QVERIFY(item("stopMessage"));QVERIFY(!item("sendMessage"));
        click("activityToggle");QTRY_VERIFY(item("agent_fixture-child"));click("agent_fixture-child");capture("subagent-active");
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("status").toString(),QString("idle"),10000);
        QCOMPARE(app->session().value("agents").toList().first().toMap().value("status").toString(),QString("completed"));
        for(const auto &message:app->messages())if(message.toMap().value("role").toString()=="assistant")QVERIFY(message.toMap().value("text").toString()!="Reviewed the question UI.");
        capture("subagent-completed");
        app->rpc("settings.update",{{"quiet",false},{"reducedMotion",false},{"expressiveCues",true}});
    }
    void activityAndPermissionBubble(){
        click("tab_Chat");
        const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Activity and permission test"}});
        QTRY_VERIFY(app->selectedId()!=previous);
        const auto session=app->selectedId();
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true}});
        app->rpc("session.send",{{"id",session},{"text","activity"}});
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        QTRY_COMPARE(app->activityCount(),3);
        QTRY_COMPARE(app->transcript()->rowCount(),2);
        for(int i=0;i<app->transcript()->rowCount();++i)
            QVERIFY(app->transcript()->data(app->transcript()->index(i,0),Qt::UserRole+1).toMap().value("role").toString()!="tool");
        QCOMPARE(app->activity()->data(app->activity()->index(0,0),Qt::UserRole+1).toMap().value("text").toString().left(13),QString("Tool result 0"));
        QVERIFY(!item("toolActivity"));click("activityToggle");QVERIFY(item("toolActivity"));
        capture("activity-expanded");click("activityToggle");QVERIFY(!item("toolActivity"));
        capture("activity-collapsed");
        auto workspace=window;
        const auto restore=qScopeGuard([&]{window=workspace;app->rpc("settings.update",{{"topmost",true},{"quiet",false},{"reducedMotion",false}});app->expand();QTest::qWait(200);});
        auto bubble=[]()->QQuickWindow*{for(auto w:qGuiApp->allWindows())if(w->title()=="Cere Approval"&&w->isVisible())return qobject_cast<QQuickWindow*>(w);return nullptr;};
        auto requests=[&]{return app->state().value("approvals").toList();};
        auto dismissCompletions=[&]{for(const auto &entry:app->state().value("completions").toList())call("completion.dismiss",{{"id",entry.toMap().value("id")}});};
        dismissCompletions();
        app->closePanel();
        app->rpc("session.send",{{"id",session},{"text","approval"}});
        QTRY_COMPARE(requests().size(),1);QTRY_VERIFY(bubble());
        QVERIFY(!workspace->isVisible());
        bubble()->close();QTRY_VERIFY(bubble());
        window=bubble();QTest::qWait(180);capture("permission-bubble");
        const auto first=requests().first().toMap().value("id").toString();
        click("approval_"+first+"_allow");
        QTRY_VERIFY(requests().isEmpty());QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        dismissCompletions();QTRY_VERIFY(!bubble());
        QTRY_VERIFY(app->messages().last().toMap().value("text").toString().contains("Decision: accept"));
        // Pending requests move between the workspace, compact panel and bubble.
        app->rpc("session.send",{{"id",session},{"text","approval"}});
        QTRY_COMPARE(requests().size(),1);QTRY_VERIFY(bubble());
        app->expand();QTRY_VERIFY(workspace->isVisible());QTRY_VERIFY(!bubble());
        workspace->showMinimized();QTRY_VERIFY(bubble());
        workspace->showNormal();QTRY_VERIFY(!bubble());
        app->closePanel();QTRY_VERIFY(bubble());
        workspace=nullptr;app->togglePanel();QTRY_VERIFY(!bubble());
        app->closePanel();QTRY_VERIFY(bubble());
        window=bubble();const auto second=requests().first().toMap().value("id").toString();
        QTest::qWait(250); // the bubble grows to fit its card, as for the first request above
        click("approval_"+second+"_deny");
        QTRY_VERIFY(requests().isEmpty());QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        dismissCompletions();QTRY_VERIFY(!bubble());
        QTRY_VERIFY(app->messages().last().toMap().value("text").toString().contains("Decision: decline"));
        // Multiple approvals retain their IDs and stay visible until all are answered.
        app->rpc("session.send",{{"id",session},{"text","multiple"}});
        QTRY_COMPARE(requests().size(),2);QTRY_VERIFY(bubble());window=bubble();QTest::qWait(250);
        const auto a=requests()[0].toMap().value("id").toString(),b=requests()[1].toMap().value("id").toString();
        click("approval_"+a+"_allow");QTRY_COMPARE(requests().size(),1);QTRY_VERIFY(bubble());
        click("approval_"+b+"_deny");QTRY_VERIFY(requests().isEmpty());
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));dismissCompletions();QTRY_VERIFY(!bubble());
        QTRY_VERIFY(app->messages().last().toMap().value("text").toString().contains("Decision: accept, decline"));
        // Provider cancellation removes a stale request without opening a panel.
        app->rpc("session.send",{{"id",session},{"text","approval"}});
        QTRY_COMPARE(requests().size(),1);QTRY_VERIFY(bubble());
        app->rpc("session.stop",{{"id",session}});QTRY_VERIFY(requests().isEmpty());QTRY_VERIFY(!bubble());
        QTRY_COMPARE(app->session().value("status").toString(),QString("interrupted"));
        // Layer-shell host uses its own bubble and also observes the other UI's visibility.
        if(qGuiApp->platformName().startsWith("wayland")){
            app->rpc("settings.update",{{"topmost",true}});
            app->rpc("session.send",{{"id",session},{"text","approval"}});
            QTRY_COMPARE(requests().size(),1);
            auto layerVisible=[&]{return hypr({"-j","layers"}).toJson().contains("cere-approval");};
            QTRY_VERIFY(layerVisible());QVERIFY(!bubble());
            app->expand();QTRY_VERIFY(!layerVisible());
            app->closePanel();QTRY_VERIFY(layerVisible());
            app->rpc("approval.answer",{{"id",requests().first().toMap().value("id")},{"choice","deny"}});
            QTRY_VERIFY(requests().isEmpty());QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
            dismissCompletions();QTRY_VERIFY(!layerVisible());
        }
        window=nullptr;app->expand();
        QTRY_VERIFY(([&]{for(auto w:qGuiApp->allWindows())if(w->title()=="Cere"&&w->isVisible()){window=qobject_cast<QQuickWindow*>(w);return true;}return false;})());
        workspace=window;
    }
    void compactSessionNavigation(){
        auto original=window;
        const auto restoreWindow=qScopeGuard([&]{window=original;original->show();});
        original->hide();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","First compact conversation"}});
        const auto previous=app->selectedId();
        QTRY_VERIFY(app->selectedId()!=previous);
        const auto first=app->selectedId();
        app->rpc("session.create",{{"provider","claude"},{"cwd",data.path()},{"trusted",true},{"title","Second compact conversation"}});
        QTRY_VERIFY(app->selectedId()!=first);
        const auto second=app->selectedId();
        QQuickView panel;
        panel.setTitle("Cere Compact Session Check");
        panel.setFlags(Qt::Tool|Qt::FramelessWindowHint);
        panel.setResizeMode(QQuickView::SizeRootObjectToView);
        panel.rootContext()->setContextProperty("App",app.get());
        panel.setSource(QUrl::fromLocalFile(QString(CERE_SOURCE_DIR)+"/qml/Panel.qml"));
        QCOMPARE(panel.status(),QQuickView::Ready);
        window=&panel;
        auto shell=panel.rootObject();
        for(const QSize size:{QSize(360,560),QSize(440,720),QSize(1040,780)}){
            panel.setMinimumSize(size);panel.setMaximumSize(size);panel.resize(size);
            shell->setProperty("expanded",size.width()>=920);
            panel.show();panel.requestActivate();QTest::qWait(200);
            click("tab_Sessions");
            // Clicking the already-selected session must navigate too.
            capture(QString("compact-before-select-%1").arg(size.width()));
            click("session_"+second);
            QCOMPARE(shell->property("page").toInt(),0);
            QTRY_COMPARE(shell->property("pageOffset").toDouble(),0.);
            auto composer=item("composer");QVERIFY(composer);QVERIFY(composer->isEnabled());
            QTRY_VERIFY(composer->hasActiveFocus());
            const QString draft=QString("Reply from the %1 pixel window").arg(size.width());
            QTest::keyClick(window,Qt::Key_A,Qt::ControlModifier);
            for(const QChar c:draft)QTest::keyClick(window,c.toLatin1());
            QCOMPARE(composer->property("text").toString(),draft);
            if(size.width()<920){
                click("backToSessions");
                QCOMPARE(shell->property("page").toInt(),1);
                QTRY_COMPARE(shell->property("pageOffset").toDouble(),0.);
            }else{
                QVERIFY(!item("backToSessions"));
                // Expanded sidebar selection should keep the conversation open.
                QVERIFY(item("session_"+first));
            }
            click("session_"+first);
            QCOMPARE(shell->property("page").toInt(),0);QCOMPARE(app->selectedId(),first);
            QTRY_COMPARE(shell->property("pageOffset").toDouble(),0.);
            click("tab_Sessions");click("session_"+second);
            QCOMPARE(shell->property("page").toInt(),0);QCOMPARE(app->selectedId(),second);
            QTRY_COMPARE(shell->property("pageOffset").toDouble(),0.);
            QTRY_COMPARE(item("composer")->property("text").toString(),draft);
            // Exercise rendered transcript content without starting a provider turn.
            auto proxy=qobject_cast<QSortFilterProxyModel*>(app->transcript());QVERIFY(proxy);
            auto transcript=qobject_cast<TranscriptModel*>(proxy->sourceModel());QVERIFY(transcript);
            transcript->upsert({{"id","compact-message"},{"sessionId",second},{"role","assistant"},{"text","You can read this conversation and reply right here."}});
            QTest::qWait(100);
            const auto top=item("composer")->mapToScene(QPointF(0,0));
            QVERIFY(top.y()>0&&top.y()+item("composer")->height()<=panel.height());
            capture(QString("compact-conversation-%1x%2").arg(size.width()).arg(size.height()));
            QCOMPARE(panel.size(),size);
        }
        shell->setProperty("expanded",false);
        for(const QString setting:{QString("reducedMotion"),QString("quiet")}){
            app->rpc("settings.update",{{setting,true}});
            QTRY_VERIFY(app->state().value("settings").toMap().value(setting).toBool());
            click("tab_Sessions");click("session_"+second);
            QCOMPARE(shell->property("page").toInt(),0);
            QCOMPARE(shell->property("pageOffset").toDouble(),0.);
            QTRY_VERIFY(item("composer")->hasActiveFocus());
            app->rpc("settings.update",{{setting,false}});
            QTRY_VERIFY(!app->state().value("settings").toMap().value(setting).toBool());
        }
        panel.hide();
    }
    void responsiveLayoutsAndDesktopActions(){
        auto original=window;
        const auto restoreWindow=qScopeGuard([&]{window=original;});
        QQuickView layout;
        layout.setTitle("Cere UI Layout Check");
        layout.setFlags(Qt::Tool|Qt::FramelessWindowHint);
        layout.setResizeMode(QQuickView::SizeRootObjectToView);
        layout.rootContext()->setContextProperty("App",app.get());
        layout.setSource(QUrl::fromLocalFile(QString(CERE_SOURCE_DIR)+"/qml/Panel.qml"));
        QCOMPARE(layout.status(),QQuickView::Ready);
        window=&layout;
        for(const QSize size:{QSize(360,560),QSize(440,720),QSize(720,580),QSize(1040,780)}){
            layout.setMinimumSize(size);layout.setMaximumSize(size);layout.resize(size);layout.show();
            QTest::qWait(180);QCOMPARE(layout.size(),size);
            layout.rootObject()->setProperty("expanded",size.width()>=720);
            for(int page=0;page<4;++page){
                layout.rootObject()->setProperty("page",page);QTest::qWait(180);
                if(page==2){
                    auto desktop=item("desktopPage");QVERIFY(desktop);
                    QVariantList apps;
                    for(int i=0;i<18;++i)apps.append(QVariantMap{{"id",QString("test-%1.desktop").arg(i)},{"name",QString("A very long application name for responsive layout testing %1").arg(i)}});
                    desktop->setProperty("apps",apps);
                    desktop->setProperty("windows",QVariantList{QVariantMap{{"title",QString(200,'W')},{"class","A long application class"},{"address","0x123"},{"workspace",QVariantMap{{"id",2},{"name","2"}}}}});
                    QTest::qWait(80);
                    auto scroll=item("desktopScroll");QVERIFY(scroll);
                    QVERIFY(scroll->property("contentHeight").toDouble()>scroll->height());
                    QCOMPARE(scroll->property("contentWidth").toDouble(),scroll->width());
                    capture(QString("desktop-%1x%2-top").arg(size.width()).arg(size.height()));
                    scroll->setProperty("contentY",scroll->property("contentHeight").toDouble()-scroll->height());
                    QTest::qWait(80);capture(QString("desktop-%1x%2-bottom").arg(size.width()).arg(size.height()));
                    auto search=item("desktopSearch");QVERIFY(search);search->setProperty("text","no-matching-action-xyz");
                    QTest::qWait(80);QCOMPARE(desktop->property("showApps").toBool(),false);
                    search->setProperty("text","timer");QTest::qWait(80);
                    QVERIFY(desktop->property("showTimers").toBool());QVERIFY(!desktop->property("showWindows").toBool());
                    search->setProperty("text","");QTest::qWait(60);
                }
                std::function<void(QQuickItem*)> bounds=[&](QQuickItem *node){
                    if(!node->isVisible())return;
                    const QByteArray type=node->metaObject()->className();
                    if(type.startsWith("CButton_")||type.startsWith("CActionRow_")||type.startsWith("CField_")||type.startsWith("CComboBox_")||type.startsWith("CSpinBox_")||type.startsWith("CCheckBox_")){
                        const auto point=node->mapToItem(layout.rootObject(),QPointF(0,0));
                        QVERIFY2(point.x()>=-1&&point.x()+node->width()<=size.width()+1,qPrintable(QString("%1 x=%2 w=%3 viewport=%4 page=%5").arg(type).arg(point.x()).arg(node->width()).arg(size.width()).arg(page)));
                    }
                    for(auto child:node->childItems())bounds(child);
                };
                bounds(layout.rootObject());
                if(page==3){
                    item("settingsScroll")->setProperty("contentY",0);QTest::qWait(80);
                    capture(QString("settings-%1x%2-top").arg(size.width()).arg(size.height()));
                    auto scroll=item("settingsScroll");QVERIFY(scroll);
                    scroll->setProperty("contentY",scroll->property("contentHeight").toDouble()-scroll->height());
                    QTest::qWait(80);capture(QString("settings-%1x%2-bottom").arg(size.width()).arg(size.height()));
                    auto quit=item("quitKeepSessions");QVERIFY(quit);
                    const auto position=quit->mapToScene(QPointF(0,0));
                    QVERIFY(position.y()>=0&&position.y()+quit->height()<=size.height());
                }
            }
            auto sessionDialog=layout.rootObject()->findChild<QObject*>("createSessionDialog");QVERIFY(sessionDialog);
            QVERIFY(QMetaObject::invokeMethod(sessionDialog,"open"));QTest::qWait(120);
            QVERIFY(sessionDialog->property("visible").toBool());
            QVERIFY(sessionDialog->property("height").toDouble()<=size.height()-30);
            auto modelChoice=item("sessionModel"),effortChoice=item("sessionEffort");
            QVERIFY(modelChoice);QVERIFY(effortChoice);
            QTRY_COMPARE_WITH_TIMEOUT(modelChoice->property("count").toInt(),3,5000);
            QCOMPARE(modelChoice->property("currentValue").toString(),QString());
            modelChoice->setProperty("currentIndex",1);
            QVERIFY(QMetaObject::invokeMethod(modelChoice,"activated",Q_ARG(int,1)));
            QTRY_COMPARE(effortChoice->property("count").toInt(),3);
            effortChoice->setProperty("currentIndex",2);
            QVERIFY(QMetaObject::invokeMethod(effortChoice,"activated",Q_ARG(int,2)));
            QCOMPARE(effortChoice->property("currentValue").toString(),QString("high"));
            click("sessionModelsRefresh");QTest::qWait(150);
            QCOMPARE(modelChoice->property("currentValue").toString(),QString("fixture-model"));
            QCOMPARE(effortChoice->property("currentValue").toString(),QString("high"));
            capture(QString("new-session-%1x%2").arg(size.width()).arg(size.height()));
            click("sessionProvider");QTest::qWait(80);
            auto providerPopup=qvariant_cast<QObject*>(item("sessionProvider")->property("popup"));QVERIFY(providerPopup);
            QVERIFY(providerPopup->property("visible").toBool());
            capture(QString("provider-menu-%1x%2").arg(size.width()).arg(size.height()));
            QVERIFY(QMetaObject::invokeMethod(providerPopup,"close"));
            QVERIFY(QMetaObject::invokeMethod(sessionDialog,"close"));
            auto scriptDialog=layout.rootObject()->findChild<QObject*>("scriptDialog");QVERIFY(scriptDialog);
            QVERIFY(QMetaObject::invokeMethod(scriptDialog,"open"));QTest::qWait(120);
            QVERIFY(scriptDialog->property("height").toDouble()<=size.height()-30);
            capture(QString("script-dialog-%1x%2").arg(size.width()).arg(size.height()));
            QVERIFY(QMetaObject::invokeMethod(scriptDialog,"close"));
        }
        layout.rootObject()->setProperty("page",2);QTest::qWait(100);
        item("desktopSearch")->setProperty("text","timer");QTest::qWait(80);
        item("timerMinutes")->setProperty("value",1);
        item("timerLabel")->setProperty("text","Responsive UI timer");
        click("startTimer");
        QTRY_VERIFY(!app->state().value("timers").toList().isEmpty());
        const auto timer=app->state().value("timers").toList().first().toMap();
        QCOMPARE(timer.value("label").toString(),QString("Responsive UI timer"));
        app->rpc("timer.cancel",{{"id",timer.value("id")}});
        QTRY_VERIFY(app->state().value("timers").toList().isEmpty());
        window=original;layout.hide();
    }
    void spotifyPlaybackRoundTrip(){
        // The session bus is not isolated: an offscreen run must never drive the user's player.
        if(offscreen())QSKIP("Controls the live Spotify player");
        click("tab_Desktop");item("desktopSearch")->setProperty("text","spotify");
        auto desktop=item("desktopPage");QVERIFY(desktop);
        QTRY_VERIFY(desktop->property("mediaRequest").toInt()<0);
        const auto media=[desktop]{auto value=desktop->property("media");if(value.metaType()==QMetaType::fromType<QJSValue>())value=value.value<QJSValue>().toVariant();return value.toMap();};
        const auto before=media();
        if(before.value("player").toString()!="org.mpris.MediaPlayer2.spotify")QSKIP("Spotify is not running");
        const QString initial=before.value("status").toString();
        if(initial!="Playing"&&initial!="Paused")QSKIP("Spotify has no resumable track");
        const auto restorePlayback=qScopeGuard([&]{
            QProcess p;p.start("busctl",{"--user","call","org.mpris.MediaPlayer2.spotify","/org/mpris/MediaPlayer2","org.mpris.MediaPlayer2.Player",initial=="Playing"?"Play":"Pause"});p.waitForFinished(3000);
        });
        for(const QString expected:{initial=="Playing"?QString("Paused"):QString("Playing"),initial}){
            auto scroll=item("desktopScroll");QVERIFY(scroll);
            scroll->setProperty("contentY",std::max(0.,scroll->property("contentHeight").toDouble()-scroll->height()));QTest::qWait(100);
            click("media_PlayPause");
            QTRY_COMPARE_WITH_TIMEOUT(media().value("status").toString(),expected,7000);
            QProcess state;state.start("busctl",{"--user","--json=short","get-property","org.mpris.MediaPlayer2.spotify","/org/mpris/MediaPlayer2","org.mpris.MediaPlayer2.Player","PlaybackStatus"});
            QVERIFY(state.waitForFinished(3000));QCOMPARE(QJsonDocument::fromJson(state.readAllStandardOutput()).object()["data"].toString(),expected);
        }
        capture("spotify-controls");item("desktopSearch")->setProperty("text","");
    }
    void captureEditorRoundTrip(){
        if(!liveHyprland())QSKIP("Needs the live Hyprland compositor");
        click("tab_Desktop");
        item("desktopSearch")->setProperty("text","satty");QTest::qWait(150);
        for(const bool save:{true,false}){
            auto desktop=item("desktopPage");QVERIFY(desktop);
            desktop->setProperty("capturePath",QString());
            click("captureRegion");QTRY_VERIFY(!window->isVisible());
            QString address;
            QTRY_VERIFY_WITH_TIMEOUT(([&]{
                QProcess p;p.start("hyprctl",{"-j","clients"});if(!p.waitForFinished(2000))return false;
                for(const auto value:QJsonDocument::fromJson(p.readAllStandardOutput()).array()){
                    const auto w=value.toObject();if(!w["class"].toString().startsWith("org.satty.cere.capture_"))continue;
                    QFile args(QString("/proc/%1/cmdline").arg(w["pid"].toInt()));
                    if(args.open(QIODevice::ReadOnly)&&args.readAll().contains(data.path().toUtf8())){address=w["address"].toString();return true;}
                }
                return false;
            })(),10000);
            QTest::qWait(800);
            QProcess key;key.start("hyprctl",{"dispatch",QString("hl.dsp.send_shortcut({mods=\"\",key=\"%1\",window=\"address:%2\"})").arg(save?"Return":"Escape",address)});
            QVERIFY(key.waitForFinished(2000));QCOMPARE(key.exitCode(),0);
            QTRY_VERIFY_WITH_TIMEOUT(window->isVisible(),10000);
            if(save){
                QTRY_VERIFY(!desktop->property("capturePath").toString().isEmpty());
                const auto path=desktop->property("capturePath").toString();QVERIFY(QFile::exists(path));
                QVERIFY(!QImage(path).isNull());QTest::qWait(150);capture("satty-saved-preview");
                auto dialog=window->contentItem()->childItems().first()->findChild<QObject*>("capturePreview");QVERIFY(dialog);
                QVERIFY(QMetaObject::invokeMethod(dialog,"close"));
            }else{
                QCOMPARE(desktop->property("capturePath").toString(),QString());
                QCOMPARE(desktop->property("feedback").toString(),QString("Capture cancelled"));
                QVERIFY(!desktop->property("failed").toBool());
            }
            const auto files=QDir(data.path()+"/state/captures").entryList({".capture-*"},QDir::Files|QDir::Hidden);
            QVERIFY(files.isEmpty());QTest::qWait(150);
        }
        item("desktopSearch")->setProperty("text","");
    }
    void mouseFollowing(){
        if(!liveHyprland())QSKIP("Needs the live Hyprland compositor");
        const auto originalPointer=pointer();
        const auto cleanup=qScopeGuard([&]{app->rpc("settings.update",{{"roaming",false},{"quiet",false},{"topmost",true}});app->setPetInteracting(false);movePointer(originalPointer);app->expand();QTest::qWait(200);});
        auto screen=window->screen();const auto g=screen->geometry();
        QQuickWindow backdrop;backdrop.setTitle("Cere Follow Check");backdrop.setMinimumSize({180,80});backdrop.setMaximumSize({180,80});backdrop.resize(180,80);backdrop.show();backdrop.requestActivate();
        app->closePanel();
        app->rpc("settings.update",{{"topmost",false},{"roaming",false},{"quiet",false},{"reducedMotion",false},{"scale",1.0},{"position",QVariantMap{{"output",screen->name()},{"x",.2},{"y",.45}}}});
        QTRY_VERIFY(!floatingPet().isEmpty());
        movePointer(g.topLeft()+QPoint(qRound(g.width()*.8),qRound(g.height()*.55)));
        QTest::qWait(250);const auto start=floatingPet();
        app->rpc("settings.update",{{"roaming",true}});
        QTRY_VERIFY_WITH_TIMEOUT(floatingPet().x()>start.x()+20,8000);
        const auto moving=floatingPet();QElapsedTimer movementClock;movementClock.start();QTest::qWait(1000);const auto after=floatingPet();
        // Compositor queries and event processing can make qWait exceed 1 s.
        const double movementSeconds=movementClock.elapsed()/1000.;
        const double distance=QLineF(moving.topLeft(),after.topLeft()).length();
        QVERIFY(after.x()>moving.x()+20);QVERIFY2(distance<=75*movementSeconds+12,qPrintable(QString("Moved %1 px in %2 s").arg(distance).arg(movementSeconds)));
        app->setPetInteracting(true);QTest::qWait(150);const auto hovered=floatingPet();QTest::qWait(450);QCOMPARE(floatingPet(),hovered);
        // The compositor may already have let her reach the old target while
        // processing the prior wait; give the resumed follower fresh distance.
        movePointer(g.topLeft()+QPoint(qRound(g.width()*.96),qRound(g.height()*.7)));
        app->setPetInteracting(false);QTRY_VERIFY_WITH_TIMEOUT(floatingPet().x()>hovered.x()+10,5000);
        app->rpc("settings.update",{{"quiet",true}});QTRY_COMPARE(app->motion(),QString("quiet"));
        QTest::qWait(150);const auto quiet=floatingPet();QTest::qWait(450);QCOMPARE(floatingPet(),quiet);
        app->rpc("settings.update",{{"quiet",false},{"roaming",false}});
        QTRY_VERIFY(!app->state().value("settings").toMap().value("roaming").toBool());
        QTest::qWait(150);const auto disabled=floatingPet();QTest::qWait(500);QCOMPARE(floatingPet(),disabled);
        QVERIFY(app->state().value("settings").toMap().value("position").toMap().value("x").toDouble()>.2);
        app->rpc("settings.update",{{"roaming",true}});app->expand();QTRY_VERIFY(window->isVisible());
        QTest::qWait(200);const auto panel=floatingPet();QTest::qWait(500);QCOMPARE(floatingPet(),panel);
    }
    void mouseFollowingAcrossOutputs(){
        if(!liveHyprland())QSKIP("Needs the live Hyprland compositor");
        if(qGuiApp->screens().size()<2)QSKIP("Requires two outputs");
        const auto originalPointer=pointer();
        const auto cleanup=qScopeGuard([&]{app->rpc("settings.update",{{"roaming",false}});movePointer(originalPointer);app->expand();QTest::qWait(200);});
        auto source=window->screen();QScreen *target=nullptr;
        for(auto screen:qGuiApp->screens())if(screen!=source){
            const auto a=source->geometry(),b=screen->geometry();
            const bool vertical=(a.right()+1==b.left()||b.right()+1==a.left())&&std::min(a.bottom(),b.bottom())-std::max(a.top(),b.top())>208;
            const bool horizontal=(a.bottom()+1==b.top()||b.bottom()+1==a.top())&&std::min(a.right(),b.right())-std::max(a.left(),b.left())>192;
            if(vertical||horizontal){target=screen;break;}
        }
        if(!target)QSKIP("Requires adjacent outputs");
        QQuickWindow backdrop;backdrop.setTitle("Cere Follow Check");backdrop.setMinimumSize({180,80});backdrop.setMaximumSize({180,80});backdrop.resize(180,80);backdrop.show();backdrop.requestActivate();
        app->closePanel();
        const auto direction=target->geometry().center()-source->geometry().center();
        const double x=std::abs(direction.x())>std::abs(direction.y())?(direction.x()>0?.98:.02):.5;
        const double y=std::abs(direction.x())>std::abs(direction.y())?.5:(direction.y()>0?.98:.02);
        app->rpc("settings.update",{{"roaming",false},{"topmost",true},{"quiet",false},{"scale",1.0},{"position",QVariantMap{{"output",source->name()},{"x",x},{"y",y}}}});
        QTest::qWait(300);
        QFile lock(data.path()+"/runtime/overlay.lock");QVERIFY(lock.open(QIODevice::ReadOnly));const auto pid=lock.readLine().trimmed().toLongLong();QVERIFY(pid>0);
        auto output=[&]{const auto layers=hypr({"-j","layers"}).object();for(auto it=layers.begin();it!=layers.end();++it)for(const auto layer:it.value().toObject()["levels"].toObject()["3"].toArray())if(layer.toObject()["pid"].toInteger()==pid&&layer.toObject()["namespace"].toString()=="cere-pet")return it.key();return QString();};
        QTRY_COMPARE(output(),source->name());
        qInfo()<<"Follow outputs"<<source->name()<<source->geometry()<<target->name()<<target->geometry();
        movePointer(target->geometry().center());QTest::qWait(100);
        QCOMPARE(pointer(),target->geometry().center());app->rpc("settings.update",{{"roaming",true}});
        QTRY_COMPARE_WITH_TIMEOUT(output(),target->name(),12000);
        app->rpc("settings.update",{{"roaming",false}});
        QTRY_COMPARE(app->state().value("settings").toMap().value("position").toMap().value("output").toString(),target->name());
    }
    void overlayAndFloatingModes(){
        if(!liveHyprland())QSKIP("Needs the live Hyprland compositor");
        app->rpc("settings.update",{{"scale",1.5},{"topmost",false}});
        QTRY_VERIFY_WITH_TIMEOUT(([&]{for(auto w:qGuiApp->allWindows())if(w->title()=="Cere Pet"&&w->isVisible())return true;return false;})(),5000);
        app->rpc("settings.update",{{"topmost",true},{"scale",1.0}});
        QTRY_VERIFY_WITH_TIMEOUT(([&]{for(auto w:qGuiApp->allWindows())if(w->title()=="Cere Pet"&&w->isVisible())return false;return true;})(),5000);
        QProcess p;p.start("hyprctl",{"-j","layers"});QVERIFY(p.waitForFinished(2000));QVERIFY(p.readAllStandardOutput().contains("cere-pet"));
    }
    void petGesturesAndReducedMotion(){
        app->closePanel();
        app->rpc("settings.update",{{"scale",1.0},{"topmost",false},{"quiet",false},{"reducedMotion",false}});
        QTRY_VERIFY(!app->state().value("settings").toMap().value("reducedMotion").toBool());
        QTRY_VERIFY(!app->state().value("settings").toMap().value("quiet").toBool());
        QQuickWindow *pet=nullptr;
        QTRY_VERIFY_WITH_TIMEOUT(([&]{for(auto w:qGuiApp->allWindows())if(w->title()=="Cere Pet"&&w->isVisible()){pet=qobject_cast<QQuickWindow*>(w);return pet!=nullptr;}return false;})(),5000);
        auto player=pet->findChild<QQuickItem*>("gesturePlayer");QVERIFY(player);
        app->preview("jump");QCOMPARE(app->motion(),QString("jump"));
        QTest::qWait(380);
        QCOMPARE(player->property("pose").toInt(),11);
        QVERIFY(player->property("shiftY").toDouble()<0);
        QVERIFY(pet->grabWindow().save("/tmp/cere-ui-evidence/pet-jump.png"));
        app->beginDrag(96,150);QCOMPARE(app->motion(),QString("dragging"));
        app->endDrag();QCOMPARE(app->motion(),QString("land"));
        app->rpc("settings.update",{{"quiet",true}});
        QTRY_COMPARE(app->motion(),QString("quiet"));
        QTRY_VERIFY(!player->property("active").toBool());
        QTRY_COMPARE(player->property("pose").toInt(),0);
        QTest::qWait(100);const auto still=pet->grabWindow();
        QTest::qWait(350);const auto later=pet->grabWindow();
        still.save("/tmp/cere-ui-evidence/quiet-before.png");later.save("/tmp/cere-ui-evidence/quiet-after.png");
        QCOMPARE(player->property("shiftY").toDouble(),0.);
        QCOMPARE(later,still);
        app->preview("timer");QCOMPARE(app->motion(),QString("quiet"));
        app->rpc("settings.update",{{"quiet",false},{"reducedMotion",true}});
        QTest::qWait(100);app->preview("wave");QCOMPARE(app->motion(),QString("idle"));
        for(double scale:{.5,1.,3.}){
            app->rpc("settings.update",{{"scale",scale}});
            QTRY_COMPARE(pet->width(),qRound(192*scale));
            QTRY_COMPARE(pet->height(),qRound(208*scale));
            QTest::qWait(150);
            QVERIFY(pet->grabWindow().save(QString("/tmp/cere-ui-evidence/pet-%1-percent.png").arg(qRound(scale*100))));
        }
        // Exercise the broker event path (the same route used by the other UI process).
        // The broker answers requests concurrently: wait for the setting before animating.
        QVERIFY(!call("settings.update",{{"reducedMotion",false},{"scale",1.5}}).contains("error"));
        QTRY_VERIFY(!app->state().value("settings").toMap().value("reducedMotion").toBool());
        QTRY_VERIFY(app->motion()!="quiet"&&app->motion()!="wake");
        app->rpc("ui.animate",{{"name","celebrate"}});
        QTRY_COMPARE(app->motion(),QString("celebrate"));
        QTest::qWait(600);QVERIFY(pet->grabWindow().save("/tmp/cere-ui-evidence/pet-celebrate.png"));
        app->rpc("settings.update",{{"hidden",true}});
        QTRY_VERIFY(!pet->isVisible());QTRY_COMPARE(app->motion(),QString("quiet"));
        app->rpc("settings.update",{{"hidden",false},{"topmost",true},{"scale",1.0}});
        app->expand();QTRY_VERIFY(window->isVisible());
    }
    void fluidAvatarAnimation(){
        QDir().mkpath("/tmp/cere-ui-evidence");
        app->closePanel();
        const auto restore=qScopeGuard([&]{
            app->endDrag();app->setPetInteracting(false);
            app->rpc("settings.update",{{"topmost",true},{"quiet",false},{"reducedMotion",false},{"motionIntensity",.7},{"scale",1.0}});
            restoreWorkspace();
        });
        QVERIFY(!call("settings.update",{{"topmost",false},{"quiet",false},{"reducedMotion",false},{"motionIntensity",1.},{"scale",1.5},{"roaming",false}}).contains("error"));
        QQuickWindow *pet=nullptr;
        QTRY_VERIFY((pet=titled("Cere Pet")));
        auto player=pet->findChild<QQuickItem*>("gesturePlayer");QVERIFY(player);
        std::function<QQuickItem*(QQuickItem*)> findPuppet=[&](QQuickItem *root)->QQuickItem*{
            if(root->objectName()=="avatarPuppet")return root;
            for(auto child:root->childItems())if(auto found=findPuppet(child))return found;
            return nullptr;
        };
        auto puppet=findPuppet(player);QVERIFY(puppet);
        QTRY_VERIFY(puppet->property("ready").toBool());
        app->setPetInteracting(true);
        QTRY_COMPARE_WITH_TIMEOUT(app->motion(),QString("idle"),8000);
        const auto readRig=[&]{return player->property("rig").value<QJSValue>().toVariant().toMap();};
        const int startFrame=player->property("renderedFrames").toInt();
        QSet<int> distinctHead;double maxStep=0,previous=readRig().value("headTilt").toDouble();
        QElapsedTimer sampleClock;sampleClock.start();
        while(sampleClock.elapsed()<900){
            QTest::qWait(8);
            const auto rig=readRig();const double head=rig.value("headTilt").toDouble();
            QVERIFY(std::isfinite(head));maxStep=std::max(maxStep,std::abs(head-previous));previous=head;
            distinctHead.insert(qRound(head*100000));
        }
        const int rendered=player->property("renderedFrames").toInt()-startFrame;
        QVERIFY2(rendered>=30,qPrintable(QString("Only %1 frame updates in 900 ms").arg(rendered)));
        QVERIFY(distinctHead.size()>=25);QVERIFY(maxStep<.3);
        app->preview("wave");QTRY_COMPARE(app->motion(),QString("wave"));
        double minArm=100,maxArm=-100;
        sampleClock.restart();
        while(sampleClock.elapsed()<1500){QTest::qWait(12);const double arm=readRig().value("leftElbow").toDouble();minArm=std::min(minArm,arm);maxArm=std::max(maxArm,arm);}
        QVERIFY(maxArm-minArm>4);
        const auto before=readRig();
        app->beginDrag(96,100);
        QCOMPARE(app->motion(),QString("dragging"));
        QCOMPARE(readRig().value("headTilt").toDouble(),before.value("headTilt").toDouble());
        QTest::qWait(180);app->endDrag();QTRY_COMPARE(app->motion(),QString("land"));
        QDir().mkpath("/tmp/cere-ui-evidence");
        QTest::qWait(1000);
        const auto frame=pet->grabWindow();QVERIFY(!frame.isNull());
        int solid=0;for(int y=0;y<frame.height();++y)for(int x=0;x<frame.width();++x)if(qAlpha(frame.pixel(x,y))>200)++solid;
        QVERIFY2(solid>frame.width()*frame.height()/8,"Avatar puppet must render opaque artwork on this backend");
        QVERIFY(frame.save("/tmp/cere-ui-evidence/fluid-avatar-idle.png"));
        for(const QString &name:QStringList{"nod","stretch","headShake","hairToss","giggle","bow","music"}){
            QTest::qWait(300);app->preview(name);QTRY_COMPARE(app->motion(),name);QTest::qWait(650);
            QVERIFY(pet->grabWindow().save("/tmp/cere-ui-evidence/fluid-avatar-"+name+".png"));
        }
        QVERIFY(!call("settings.update",{{"reducedMotion",true}}).contains("error"));
        QTRY_VERIFY(!player->property("animating").toBool());QTest::qWait(100);
        const int stoppedFrame=player->property("renderedFrames").toInt();const auto still=pet->grabWindow();
        QTest::qWait(400);
        QCOMPARE(player->property("renderedFrames").toInt(),stoppedFrame);
        QCOMPARE(pet->grabWindow(),still);
        qInfo("Avatar cadence: %d updates / 900 ms; %lld distinct head positions; max sampled step %.5f degrees",rendered,qlonglong(distinctHead.size()),maxStep);
    }
    void avatarPresenceShowcase(){
        app->closePanel();
        QQuickItem *player=nullptr;
        const auto restore=qScopeGuard([&]{
            if(player)player->setProperty("followAppMotion",true);
            app->setPetInteracting(false);
            app->rpc("settings.update",{{"topmost",true},{"quiet",false},{"reducedMotion",false},{"motionIntensity",.7},{"scale",1.0}});
            restoreWorkspace();
        });
        QVERIFY(!call("settings.update",{{"topmost",false},{"quiet",false},{"reducedMotion",false},{"motionIntensity",.7},{"scale",1.5},{"roaming",false}}).contains("error"));
        QQuickWindow *pet=nullptr;QTRY_VERIFY((pet=titled("Cere Pet")));
        player=pet->findChild<QQuickItem*>("gesturePlayer");QVERIFY(player);
        app->setPetInteracting(true);
        player->setProperty("followAppMotion",false);
        // Record only when requested. Every run still checks the real renderer,
        // complete entry stages, present idle motion and a static preview.
        const QString directory=qEnvironmentVariable("CERE_AVATAR_RECORD");
        if(!directory.isEmpty())QVERIFY(QDir().mkpath(directory));
        const QList<QPair<QString,int>> program={{"idle",6400},{"wave",3400},{"glassesAdjust",3400},{"working",2600},{"thinking",3500},{"speaking",3300},{"hairTuck",3400},{"idle",2400}};
        int number=0;QSet<QString> phases,beats;QSet<int> poses;
        for(const auto &[name,duration]:program){
            player->setProperty("motion",name);
            QElapsedTimer elapsed;elapsed.start();
            for(int frame=0;frame*1000/24<duration;++frame){
                const int wait=(frame+1)*1000/24-int(elapsed.elapsed());
                if(wait>0)QTest::qWait(wait);
                phases.insert(player->property("phase").toString());
                beats.insert(player->property("idleBeat").toString());
                poses.insert(player->property("pose").toInt());
                if(!directory.isEmpty()){
                    const auto grab=pet->grabWindow();QVERIFY(!grab.isNull());
                    QVERIFY(grab.save(directory+QString("/frame-%1.png").arg(number++,4,10,QChar('0'))));
                }
            }
        }
        for(const auto &phase:{"anticipate","release","transfer","arrive","settle","living"})QVERIFY2(phases.contains(phase),phase);
        for(int pose:{24,25,26,27,28,29,30})QVERIFY2(poses.contains(pose),qPrintable(QString::number(pose)));
        QVERIFY(beats.size()>1);
        player->setProperty("followAppMotion",true);
        player->setProperty("motion",app->motion());
        restoreWorkspace();click("tab_Settings");
        auto stage=item("motionStage");QVERIFY(stage);
        auto actor=stage->findChild<QQuickItem*>("motionStagePlayer");QVERIFY(actor);
        QVERIFY(!actor->property("animating").toBool());
        click("playMotionShowcase");QTRY_VERIFY(actor->property("animating").toBool());
        const auto stateBefore=app->motion();
        QTest::qWait(650);QCOMPARE(app->motion(),stateBefore);
        QVERIFY(!call("settings.update",{{"reducedMotion",true}}).contains("error"));
        QTRY_VERIFY(!actor->property("animating").toBool());
        QVERIFY(!stage->property("playing").toBool());
        capture("presence-settings-preview");
    }
    void livelyGesturesWhileReadingAnOpenConversation(){
        const auto original=app->state().value("settings").toMap();
        const auto restore=qScopeGuard([&]{call("settings.update",original);restoreWorkspace();});
        call("settings.update",{{"topmost",false},{"hidden",false},{"quiet",false},{"reducedMotion",false},{"motionIntensity",.7},{"idleEnergy","lively"}});
        const auto id=call("session.create",{{"provider","ollama"},{"model","fixture-plain:latest"},{"cwd",data.path()},{"title","Reading idle regression"}}).value("id").toString();
        QVERIFY(!id.isEmpty());QTRY_COMPARE(app->selectedId(),id);
        restoreWorkspace();click("tab_Chat");
        auto composer=item("composer"),chat=item("chatView");QVERIFY(composer&&chat);
        composer->setProperty("text",QString());composer->forceActiveFocus();
        app->setPetInteracting(false);
        QTRY_VERIFY(composer->hasActiveFocus());QTRY_VERIFY(!chat->property("listening").toBool());
        const auto pool=app->animations().value("idleProfiles").toMap().value("lively").toMap().value("pool").toList();
        QTRY_VERIFY_WITH_TIMEOUT(pool.contains(app->motion()),15000);
        QVERIFY(window->isVisible()); // The real timer fired with the conversation still open.
        composer->setProperty("text",QString("A draft in progress"));
        QTRY_VERIFY(chat->property("listening").toBool());QTRY_COMPARE(app->motion(),QString("listening"));
        composer->setProperty("text",QString());
        QTRY_VERIFY(!chat->property("listening").toBool());QTRY_COMPARE(app->motion(),QString("idle"));
        call("settings.update",{{"idleEnergy","calm"}});
        QTRY_VERIFY(chat->property("listening").toBool());QTRY_COMPARE(app->motion(),QString("listening"));
    }
    void livelyPreviewAndSharedMood(){
        const auto original=app->state().value("settings").toMap();
        const auto restore=qScopeGuard([&]{call("settings.update",original);restoreWorkspace();});
        QVERIFY(!call("settings.update",{{"topmost",false},{"hidden",false},{"quiet",false},{"reducedMotion",false},{"motionIntensity",.7},{"idleEnergy","lively"}}).contains("error"));
        restoreWorkspace();click("tab_Settings");
        QVERIFY(item("idleEnergy"));auto stage=item("motionStage");QVERIFY(stage);
        auto actor=stage->findChild<QQuickItem*>("motionStagePlayer");QVERIFY(actor);
        click("playMotionShowcase");
        auto scroll=item("settingsScroll");QVERIFY(scroll);
        scroll->setProperty("contentY",scroll->property("contentY").toDouble()+stage->mapToItem(scroll,QPointF()).y()-20);
        QTest::qWait(100);
        const auto profiles=app->animations().value("idleProfiles").toMap();
        auto names=profiles.value("lively").toMap().value("pool").toList();
        for(const auto &old:profiles.value("calm").toMap().value("pool").toList())names.removeAll(old);
        QImage sheet(208*8,249*names.size(),QImage::Format_ARGB32);sheet.fill(QColor("#152331"));QPainter painter(&sheet);
        int row=0;
        for(const auto &entry:names){
            const auto name=entry.toString();const auto clip=app->animations().value("clips").toMap().value(name).toMap();
            int duration=clip.value("entryMs").toInt();for(const auto &key:clip.value("keys").toList())duration+=key.toMap().value("ms").toInt();
            stage->setProperty("playing",false);
            stage->setProperty("program",QVariantList{QVariantMap{{"motion",name},{"ms",duration+1000},{"caption",clip.value("label")}}});
            QVERIFY(QMetaObject::invokeMethod(stage,"start"));QTRY_VERIFY(actor->property("animating").toBool());
            painter.setPen(Qt::white);painter.drawText(4,row*249+17,name);
            for(int frame=0;frame<8;++frame){QTest::qWait(duration/8);
                const auto image=window->grabWindow().copy(actor->mapRectToScene(actor->boundingRect()).toRect());
                QVERIFY(!image.isNull());
                const auto rig=actor->property("rig").value<QJSValue>().toVariant().toMap();
                for(auto it=rig.cbegin();it!=rig.cend();++it)if(it.value().metaType().id()==QMetaType::Double)QVERIFY2(std::isfinite(it.value().toDouble()),qPrintable(name+"/"+it.key()));
                int blue=0;for(int y=0;y<image.height();++y)for(int x=0;x<image.width();++x){const auto pixel=image.pixelColor(x,y);if(pixel.blue()>160&&pixel.blue()>pixel.red()*1.5)++blue;}
                if(blue<1000)qWarning()<<name<<frame<<"missing artwork"<<rig<<"shift"<<actor->property("shiftX")<<actor->property("shiftY")<<"clock"<<actor->property("clock");
                QVERIFY2(blue>1000,qPrintable(name+" frame "+QString::number(frame)+" must retain visible hair"));
                painter.drawImage(QRect(frame*208,row*249+24,208,225),image);
            }
            ++row;
        }
        painter.end();QDir().mkpath("/tmp/cere-motion-evidence");QVERIFY(sheet.save("/tmp/cere-motion-evidence/preview.png"));
        stage->setProperty("playing",false);
        // Both the portrait and body consume the exact host-published settled mood.
        const auto id=call("session.create",{{"provider","ollama"},{"model","fixture-plain:latest"},{"cwd",data.path()},{"title","Shared mood"}}).value("id").toString();
        QVERIFY(!id.isEmpty());QTRY_COMPARE(app->selectedId(),id);click("tab_Settings");
        QTRY_VERIFY(app->moodSourceEnabled());
        app->setConversationMood(id,{{"mood","concerned"},{"moodConfidence",.8},{"reactive",true},{"messageId","test"}});
        QTRY_COMPARE(app->bodyMood(),QString("concerned"));
        auto portrait=item("cerePortrait");QVERIFY(portrait);QTRY_COMPARE(portrait->property("mood").toString(),QString("concerned"));
        QVERIFY(!call("settings.update",{{"expressiveCues",false}}).contains("error"));
        QTRY_COMPARE(app->bodyMood(),QString("neutral"));QTRY_COMPARE(portrait->property("expression").toString(),QString("neutral"));
    }
    void expressiveActing(){
        const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Expressive acting fixture"}});
        QTRY_VERIFY(app->selectedId()!=previous);const auto session=app->selectedId();
        const auto restore=qScopeGuard([&]{app->rpc("ui.panel",{{"owner","overlay"},{"visible",false}});app->rpc("settings.update",{{"topmost",true},{"quiet",false},{"reducedMotion",false},{"motionIntensity",.7},{"expressiveCues",true},{"scale",1.0}});app->expand();});
        app->rpc("settings.update",{{"topmost",false},{"quiet",false},{"reducedMotion",true},{"motionIntensity",.7},{"scale",1.5}});
        QQuickWindow *pet=nullptr;
        QTRY_VERIFY(([&]{for(auto w:qGuiApp->allWindows())if(w->title()=="Cere Pet"&&w->isVisible()){pet=qobject_cast<QQuickWindow*>(w);return pet!=nullptr;}return false;})());
        auto player=pet->findChild<QQuickItem*>("gesturePlayer");QVERIFY(player);
        restoreWorkspace();click("tab_Chat");auto composer=item("composer");QVERIFY(composer);
        if(!offscreen()){
            // Wayland may ignore requestActivate without an activation token.
            // Focus this test's exact workspace, never the installed Cere host.
            QString address;
            for(const auto &value:hypr({"-j","clients"}).array()){
                const auto client=value.toObject();
                if(client["pid"].toInteger()==QCoreApplication::applicationPid()&&client["title"].toString()=="Cere")address=client["address"].toString();
            }
            QVERIFY(!address.isEmpty());
            hypr({"dispatch",QString("hl.dsp.focus({window=\"address:%1\"})").arg(address)});
        }
        window->requestActivate();
        if(!offscreen())QTRY_VERIFY_WITH_TIMEOUT(window->isActive(),5000);
        composer->forceActiveFocus();
        QTRY_VERIFY_WITH_TIMEOUT(composer->hasActiveFocus(),10000);
        QTRY_COMPARE(app->motion(),QString("listening"));
        // Simulate the other host's open composer, including after a state refresh.
        app->closePanel();
        app->rpc("ui.panel",{{"owner","overlay"},{"visible",true}});
        app->rpc("ui.attention",{{"owner","overlay"},{"sessionId",session},{"listening",true}});
        QTRY_COMPARE(app->motion(),QString("listening"));
        app->rpc("state");QTest::qWait(120);QCOMPARE(app->motion(),QString("listening"));
        QVERIFY(!player->property("animating").toBool());
        auto capturePet=[&](const QString &name){
            QTest::qWait(160);const auto image=pet->grabWindow();
            // Every visible opaque point stays inside the stable input envelope.
            const auto region=pet->mask();const double scale=double(image.width())/pet->width();
            for(int y=0;y<image.height();y+=3)for(int x=0;x<image.width();x+=3)
                if(qAlpha(image.pixel(x,y))>200&&!region.contains(QPoint(qRound(x/scale),qRound(y/scale))))return false;
            return image.save("/tmp/cere-ui-evidence/acting-"+name+".png");
        };
        QVERIFY(capturePet("listening"));
        {
            const auto sent=call("session.send",{{"id",session},{"text","acting"}});
            QVERIFY2(!sent.contains("error"),qPrintable(sent.value("error").toString()));
        }
        QTRY_COMPARE(app->motion(),QString("thinking"));QVERIFY(capturePet("thinking"));
        QTRY_COMPARE(app->motion(),QString("working"));QVERIFY(capturePet("working"));
        QTRY_COMPARE(app->motion(),QString("speaking"));QVERIFY(capturePet("speaking"));
        QVERIFY(!player->property("animating").toBool());
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        QTRY_COMPARE(app->motion(),QString("listening"));
        app->rpc("settings.update",{{"reducedMotion",false}});
        QTRY_VERIFY(player->property("active").toBool());
        for(const auto &name:QStringList{"skeptical","smug","disbelief","curious","cheeky","tender"}){
            app->preview(name);QTRY_COMPARE(app->motion(),name);QVERIFY(capturePet(name));
        }
        // Zero intensity cancels a one-shot and stops all animation/timing work.
        app->rpc("settings.update",{{"motionIntensity",0.}});
        QTRY_COMPARE(app->motion(),QString("listening"));QTRY_VERIFY(!player->property("animating").toBool());
        QTest::qWait(200);const auto still=pet->grabWindow();QTest::qWait(450);QCOMPARE(pet->grabWindow(),still);
        app->rpc("settings.update",{{"motionIntensity",.7}});QTRY_VERIFY(player->property("active").toBool());
        {
            const auto sent=call("session.send",{{"id",session},{"text","acting"}});
            QVERIFY2(!sent.contains("error"),qPrintable(sent.value("error").toString()));
        }
        QTRY_COMPARE(app->motion(),QString("thinking"));
        QTRY_COMPARE(app->motion(),QString("working"));
        QTRY_COMPARE(app->motion(),QString("speaking")); // Settled tone cannot replace busy activity.
        const auto afterCue=player->property("keyIndex").toInt();QTest::qWait(500);
        QVERIFY(player->property("keyIndex").toInt()>=afterCue);
        QTRY_COMPARE(app->motion(),QString("celebrate"));QTest::qWait(360);QVERIFY(capturePet("success"));
        QTRY_COMPARE_WITH_TIMEOUT(app->motion(),QString("listening"),5000);
        {
            const auto sent=call("session.send",{{"id",session},{"text","acting"}});
            QVERIFY2(!sent.contains("error"),qPrintable(sent.value("error").toString()));
        }
        QTRY_COMPARE(app->motion(),QString("thinking"));
        app->rpc("session.stop",{{"id",session}});
        QTRY_COMPARE(app->session().value("status").toString(),QString("interrupted"));
        QTRY_COMPARE(app->motion(),QString("interrupted"));QVERIFY(capturePet("stopped"));
        app->rpc("session.send",{{"id",session},{"text","acting-error"}});
        QTRY_COMPARE(app->session().value("status").toString(),QString("error"));
        QTRY_COMPARE(app->motion(),QString("error"));QVERIFY(capturePet("error"));
        QTRY_COMPARE(app->motion(),QString("problem"));
        app->preview("celebrate");QCOMPARE(app->motion(),QString("problem"));
        QStringList terminalMotions;
        const auto observe=connect(app.get(),&Controller::motionChanged,this,[&]{terminalMotions.append(app->motion());});
        app->rpc("session.send",{{"id",session},{"text","acting-late-error"}});
        QTRY_COMPARE(app->motion(),QString("thinking"));
        QTRY_COMPARE(app->session().value("status").toString(),QString("error"));
        QTest::qWait(650);disconnect(observe);
        QVERIFY(!terminalMotions.contains("celebrate"));QVERIFY(!terminalMotions.contains("success"));
        app->rpc("session.send",{{"id",session},{"text","approval"}});
        QTRY_COMPARE(app->state().value("approvals").toList().size(),1);
        QTRY_COMPARE(app->motion(),QString("approval"));
        app->rpc("settings.update",{{"reducedMotion",true}});
        QTRY_COMPARE(app->motion(),QString("waiting"));QVERIFY(capturePet("permission"));
        QTRY_VERIFY(!player->property("animating").toBool());
        QCOMPARE(player->property("symbol").toString(),QString("?"));
        const auto approval=app->state().value("approvals").toList().first().toMap().value("id");
        app->rpc("approval.answer",{{"id",approval},{"choice","deny"}});
        QTRY_VERIFY(app->state().value("approvals").toList().isEmpty());
        restoreWorkspace();click("tab_Settings");QVERIFY(item("motionIntensity"));QVERIFY(item("expressiveCues"));
        click("expressiveCues");QTRY_VERIFY(!app->state().value("settings").toMap().value("expressiveCues").toBool());
        capture("expressive-settings");
    }
    void fullscreenOverlay(){
        if(!liveHyprland())QSKIP("Needs the live Hyprland compositor");
        app->rpc("settings.update",{{"position",QVariantMap{{"output",window->screen()->name()},{"x",.85},{"y",.75}}}});
        window->showFullScreen();QTest::qWait(600);
        QProcess p;p.start("hyprctl",{"-j","layers"});QVERIFY(p.waitForFinished(2000));
        const auto layers=QJsonDocument::fromJson(p.readAllStandardOutput()).object();
        bool found=false;
        for(const auto output:layers)for(const auto layer:output.toObject()["levels"].toObject()["3"].toArray())if(layer.toObject()["namespace"].toString()=="cere-pet")found=true;
        QVERIFY(found);
        QProcess capture;capture.start("grim",{"-o",window->screen()->name(),"/tmp/cere-ui-evidence/fullscreen-overlay.png"});QVERIFY(capture.waitForFinished(3000));QCOMPARE(capture.exitCode(),0);
        window->showNormal();
    }
    // The following checks also run headless, without the live compositor or session bus:
    // env -u HYPRLAND_INSTANCE_SIGNATURE DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent QT_QUICK_BACKEND=software
    //   QT_QPA_PLATFORM=offscreen:configfile=tests/fixtures/offscreen-screens.json build/cere-ui-check SLOT...
    // F-042 policy display, F-006 forget binding, F-019 correction round trip.
    void graphInspectorPolicyForgetAndCorrection(){
        // Memory recall changes later fixture prompts, so it is switched back off (the default).
        const auto restore=qScopeGuard([&]{call("settings.update",{{"memory",QVariantMap{{"enabled",false}}}});restoreWorkspace();});
        click("tab_Chat");const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","ollama"},{"model","fixture-plain:latest"},{"cwd",data.path()},{"title","Graph inspector check"}});
        QTRY_VERIFY(app->selectedId()!=previous);const auto session=app->selectedId();
        QVERIFY(!call("settings.update",{{"memory",QVariantMap{{"enabled",true},{"model","nomic-embed-text"}}}}).contains("error"));
        call("memory.check");
        QTRY_COMPARE_WITH_TIMEOUT(app->state().value("memory").toMap().value("state").toString(),QString("ready"),8000);
        auto graph=[&](const QString &method,const QVariantMap &params){return call("memory.graph",{{"sessionId",session},{"method",method},{"params",params}});};
        // F-042: a nondefault persisted policy, set through the broker before the inspector opens.
        auto policy=QVariantMap{{"fish_enabled",true},{"history_enabled",true},{"capture_titles",true},{"title_applications",QVariantList{"kitty"}},{"approved_roots",QVariantList{data.path()}}};
        QVERIFY(!graph("policy_update",{{"policy",policy}}).contains("error"));
        auto openInspector=[&]{
            click("tab_Settings");
            auto scroll=item("settingsScroll"),manage=item("manageMemories");QVERIFY(scroll&&manage);
            scroll->setProperty("contentY",manage->mapToItem(scroll,QPointF()).y()+scroll->property("contentY").toDouble()-180);QTest::qWait(100);
            click("manageMemories");
            // Open without processing events: before the policy reply arrives, no collector
            // control may be enabled with default or stale values.
            auto open=item("openGraphInspector");QVERIFY(open);QVERIFY(QMetaObject::invokeMethod(open,"clicked"));
            for(const QString name:{QString("policyFish"),QString("policyHistory"),QString("policyTitles"),QString("policyHyprland"),QString("policyTitleApplications"),QString("policyRoots")}){
                auto control=item(name);QVERIFY2(control,qPrintable(name));QVERIFY2(!control->isEnabled(),qPrintable(name));
            }
            QTRY_VERIFY(item("graphMemoryDetails"));
        };
        auto closeInspector=[&]{QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(100);click("closeMemory");};
        openInspector();
        QTRY_VERIFY(item("policyFish")->isEnabled());
        QVERIFY(item("policyFish")->property("checked").toBool());QVERIFY(item("policyHistory")->property("checked").toBool());
        QVERIFY(item("policyTitles")->property("checked").toBool());QVERIFY(!item("policyHyprland")->property("checked").toBool());
        QCOMPARE(item("policyTitleApplications")->property("text").toString(),QString("kitty"));
        QVERIFY(item("policyRoots")->property("text").toString().contains(data.path()));
        click("policyFish");
        QTRY_VERIFY(!graph("policy_get",{}).value("policy").toMap().value("fish_enabled").toBool());
        QTRY_VERIFY(item("policyFish")->isEnabled());QVERIFY(!item("policyFish")->property("checked").toBool());
        QVERIFY(graph("policy_get",{}).value("policy").toMap().value("history_enabled").toBool());
        closeInspector();
        QVERIFY(!graph("policy_update",{{"policy",QVariantMap{{"fish_enabled",true},{"history_enabled",false}}}}).contains("error"));
        openInspector();
        QTRY_VERIFY(item("policyFish")->isEnabled());
        QVERIFY(item("policyFish")->property("checked").toBool());QVERIFY(!item("policyHistory")->property("checked").toBool());
        // A failed policy load keeps every control disabled and submits nothing.
        QObject *inspector=nullptr;
        for(auto w:qGuiApp->allWindows())for(auto candidate:w->findChildren<QObject*>("graphMemoryInspector"))if(candidate->property("opened").toBool())inspector=candidate;
        QVERIFY(inspector);
        inspector->setProperty("sessionId","missing-session");
        QVERIFY(QMetaObject::invokeMethod(inspector,"loadPolicy"));
        QTRY_COMPARE(inspector->property("policyRequest").toInt(),-1);
        QVERIFY(!inspector->property("policyLoaded").toBool());QVERIFY(!item("policyFish")->isEnabled());
        QVERIFY(QMetaObject::invokeMethod(inspector,"updatePolicy",Q_ARG(QVariant,QVariant(QVariantMap{{"fish_enabled",false},{"approved_roots",QVariantList{}}}))));
        QTest::qWait(300);
        const auto kept=graph("policy_get",{}).value("policy").toMap();
        QVERIFY(kept.value("fish_enabled").toBool());QVERIFY(!kept.value("approved_roots").toList().isEmpty());
        inspector->setProperty("sessionId",session);QVERIFY(QMetaObject::invokeMethod(inspector,"loadPolicy"));
        QTRY_VERIFY(item("policyFish")->isEnabled());
        // F-006: a confirmation belongs to exactly the record that was previewed.
        const auto a=call("memory.save",{{"sessionId",session},{"text","Alpha note for the forget check."}}).value("id").toString();
        const auto b=call("memory.save",{{"sessionId",session},{"text","Beta note for the forget check."}}).value("id").toString();
        QVERIFY(!a.isEmpty()&&!b.isEmpty());
        auto listed=[&](const QString &id){return QJsonDocument::fromVariant(call("memory.list",{{"sessionId",session}})).toJson().contains(id.toUtf8());};
        QVERIFY(listed(a));QVERIFY(listed(b));
        auto record=item("graphMemoryRecord");QVERIFY(record);
        record->setProperty("text",a);click("graphMemoryPreviewForget");
        QTRY_VERIFY(item("graphMemoryForget"));QVERIFY(item("graphMemoryForget")->property("text").toString().contains(a));
        record->setProperty("text",b);QTest::qWait(100);
        QVERIFY(!item("graphMemoryForget"));QVERIFY(!item("graphMemoryForgetImpact"));
        // A preview still in flight binds to the ID it was requested for, not a later edit.
        record->setProperty("text",a);
        auto preview=item("graphMemoryPreviewForget");QVERIFY(QMetaObject::invokeMethod(preview,"clicked"));
        record->setProperty("text",b);QTest::qWait(600);
        QVERIFY(!item("graphMemoryForget"));QVERIFY(listed(a));QVERIFY(listed(b));
        click("graphMemoryPreviewForget");
        QTRY_VERIFY(item("graphMemoryForget"));QVERIFY(item("graphMemoryForget")->property("text").toString().contains(b));
        click("graphMemoryForget");
        QTRY_VERIFY(!listed(b));QVERIFY(listed(a));
        // F-019: the correction initializer round-trips every claim field.
        auto observation=[&](const QString &text){return call("memory.save",{{"sessionId",session},{"text",text}}).value("id").toString();};
        auto entity=[](const char *type,const char *name){return QVariantMap{{"type",type},{"name",name}};};
        QVariantMap bounded{{"subject",entity("Project","Atlas")},{"predicate","USES_TOOL"},{"object",entity("Tool","Kitty")},{"qualifiers",QVariantMap{{"purpose","terminals"}}},
            {"valid_mode","bounded"},{"valid_from_us",1772323200000000LL},{"valid_to_us",1775001600000000LL},{"time_precision","date"},{"time_zone","Europe/Berlin"},{"time_expression","from March until April"}};
        // Candidate claims use single-valued predicates, which permit correcting a candidate.
        const QList<QPair<QString,QVariantMap>> claims{
            {"Atlas does not use Ruff.",QVariantMap{{"subject",entity("Project","Atlas")},{"predicate","USES_TOOL"},{"object",entity("Tool","Ruff")},{"polarity","negative"}}},
            {"Jade plans to prefer Black as a formatter.",QVariantMap{{"subject",entity("User","Jade")},{"predicate","PREFERS_TOOL"},{"object",entity("Tool","Black")},{"qualifiers",QVariantMap{{"category","formatter"}}},{"modality","planned"}}},
            {"The handbook says Jade prefers Zed as an editor.",QVariantMap{{"subject",entity("User","Jade")},{"predicate","PREFERS_TOOL"},{"object",entity("Tool","Zed")},{"qualifiers",QVariantMap{{"category","editor"}}},
                {"modality","reported"},{"epistemic_type","document_claim"},{"extraction_confidence",.5},{"time_zone","America/New_York"}}},
            {"Kim probably prefers Helix.",QVariantMap{{"subject",entity("User","Kim")},{"predicate","PREFERS_TOOL"},{"object",entity("Tool","Helix")},{"modality","inferred"},{"epistemic_type","inference"}}},
            {"notes.md is at offset zero.",QVariantMap{{"subject",entity("Document","notes.md")},{"predicate","LOCATED_AT"},{"value",0},{"qualifiers",QVariantMap{{"device",false}}}}},
            {"draft.md is not located anywhere.",QVariantMap{{"subject",entity("Document","draft.md")},{"predicate","LOCATED_AT"},{"value",false}}},
            {"Atlas used Kitty for terminals from March until April.",bounded},
        };
        for(const auto &[text,claim]:claims){
            const auto source=observation(text);QVERIFY(!source.isEmpty());
            const auto saved=graph("remember",{{"claim",claim},{"witness",QVariantMap{{"observation_id",source},{"quote",text}}}});
            QVERIFY2(!saved.contains("error"),qPrintable(text+": "+saved.value("error").toString()));
            const auto original=graph("inspect",{{"id",saved.value("id")}}).value("record").toMap();
            QVERIFY2(original.contains("claim_data"),qPrintable(text));
            record->setProperty("text",saved.value("id"));click("graphMemoryInspect");
            QTRY_VERIFY(item("graphMemoryMutation")->property("text").toString().contains(saved.value("id").toString()));
            auto initializer=QJsonDocument::fromJson(item("graphMemoryMutation")->property("text").toString().toUtf8()).object();
            QCOMPARE(initializer.value("claim").toObject(),QJsonObject::fromVariantMap(original.value("claim_data").toMap()));
            // Change only the witness, then submit through the inspector.
            const auto again=observation(text+" Confirmed.");
            initializer["witness"]=QJsonObject{{"observation_id",again},{"quote",text}};
            item("graphMemoryMutation")->setProperty("text",QString::fromUtf8(QJsonDocument(initializer).toJson()));
            click("graphMemoryCorrect");
            auto details=[&]{return QJsonDocument::fromJson(item("graphMemoryDetails")->property("text").toString().toUtf8()).object();};
            QTRY_VERIFY2(details().contains("slot_id")&&details().value("id").toString()!=saved.value("id").toString(),qPrintable(text+": "+item("graphMemoryDetails")->property("text").toString().left(300)));
            const auto result=details();
            const auto corrected=graph("inspect",{{"id",result.value("id").toString()}}).value("record").toMap();
            QCOMPARE(QJsonObject::fromVariantMap(corrected.value("claim_data").toMap()),QJsonObject::fromVariantMap(original.value("claim_data").toMap()));
            QCOMPARE(corrected.value("status").toString(),original.value("status").toString());
            const auto modality=claim.value("modality").toString();
            if(!modality.isEmpty()&&modality!="actual")QCOMPARE(corrected.value("status").toString(),QString("candidate"));
            if(claim.value("polarity").toString()=="negative")QCOMPARE(corrected.value("polarity").toString(),QString("negative"));
        }
        closeInspector();
    }
    // F-020: every surface names the real requester of each approval.
    void approvalsIdentifyTheirRequester(){
        const auto restore=qScopeGuard([&]{app->rpc("settings.update",{{"topmost",true},{"quiet",false},{"reducedMotion",false}});restoreWorkspace();});
        click("tab_Chat");
        QDir(data.path()).mkpath("alpha");QDir(data.path()).mkpath("beta");
        const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()+"/alpha"},{"trusted",true},{"title","Same approval title"}});
        QTRY_VERIFY(app->selectedId()!=previous);const auto first=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()+"/beta"},{"trusted",true},{"title","Same approval title"}});
        QTRY_VERIFY(app->selectedId()!=first);const auto second=app->selectedId();
        app->select(first);QTRY_COMPARE(app->selectedId(),first);
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true}});
        auto requests=[&]{return app->state().value("approvals").toList();};
        auto owned=[&](const QString &session){for(const auto &r:requests())if(r.toMap().value("sessionId")==session)return r.toMap().value("id").toString();return QString();};
        app->rpc("session.send",{{"id",first},{"text","approval"}});app->rpc("session.send",{{"id",second},{"text","approval"}});
        QTRY_COMPARE_WITH_TIMEOUT(requests().size(),2,8000);
        const auto a=owned(first),b=owned(second);QVERIFY(!a.isEmpty()&&!b.isEmpty());
        auto header=[&](const QString &id){auto h=item("approvalRequester_"+id);return h?h->property("text").toString():QString();};
        auto identifies=[&](const QString &id,const QString &session,const QString &project){const auto text=header(id);return text.contains(session.left(8))&&text.contains(project)&&text.contains("Same approval title");};
        auto surface=[&](const QString &name){
            QTRY_VERIFY2(identifies(a,first,"/alpha"),qPrintable(name+": "+header(a)));
            QTRY_VERIFY2(identifies(b,second,"/beta"),qPrintable(name+": "+header(b)));
            QCOMPARE(count("approvalRequester_"+a),1);QCOMPARE(count("approvalRequester_"+b),1);
        };
        restoreWorkspace();surface("workspace");
        app->closePanel();app->togglePanel();QTRY_VERIFY((window=titled("Cere Panel")));QTest::qWait(200);surface("compact");
        app->closePanel();QTRY_VERIFY((window=titled("Cere Approval")));QTest::qWait(250);surface("bubble");
        // Answering the second requester resolves only its request.
        click("approval_"+b+"_allow");
        QTRY_COMPARE(requests().size(),1);QCOMPARE(owned(first),a);QVERIFY(owned(second).isEmpty());
        QTRY_VERIFY(!item("approvalRequester_"+b));QVERIFY(identifies(a,first,"/alpha"));
        click("approval_"+a+"_deny");QTRY_VERIFY(requests().isEmpty());
    }
    void emoticonBadges(){
        const auto restore=qScopeGuard([&]{
            call("settings.update",{{"scale",1.0},{"topmost",true},{"quiet",false},{"reducedMotion",false}});restoreWorkspace();
        });
        app->closePanel();
        call("settings.update",{{"scale",1.0},{"hidden",false},{"topmost",false},{"quiet",false},{"reducedMotion",true}});
        QQuickWindow *pet=nullptr;QTRY_VERIFY((pet=titled("Cere Pet")));
        auto player=pet->findChild<QQuickItem*>("gesturePlayer"),badge=pet->findChild<QQuickItem*>("emoticonBadge");
        QVERIFY(player&&badge);
        auto key=[&]{return badge->property("emotion").value<QJSValue>().property("key").toString();};
        player->setProperty("followAppMotion",false);
        QDir().mkpath("/tmp/cere-ui-evidence");
        for(const auto &motion:QStringList{"idle","thinking","working","speaking","waiting","error","celebrate","music","tender","skeptical","curious","doze"}){
            player->setProperty("motion",motion);QTest::qWait(70);
            QVERIFY(!badge->property("glyph").toString().isEmpty());
            QVERIFY(badge->width()<=116);QVERIFY(badge->height()>0);
            const auto center=badge->mapToScene(QPointF(badge->width()/2,badge->height()/2)).toPoint();
            QVERIFY(pet->mask().contains(center));
            QVERIFY(pet->grabWindow().save("/tmp/cere-ui-evidence/emoticon-"+motion+".png"));
        }
        player->setProperty("followAppMotion",true);
        const auto id=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true}}).value("id").toString();
        QVERIFY(!call("session.send",{{"id",id},{"text","acting-tender"}}).contains("error"));
        QTRY_COMPARE(key(),QString("thinking"));
        QTRY_COMPARE(key(),QString("working"));
        QTRY_COMPARE(key(),QString("tender"));
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        QCOMPARE(key(),QString("tender"));
        const auto second=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true}}).value("id").toString();
        QVERIFY(app->selectedId()==second);
        // Attention-only events must reach QML without waiting for another snapshot.
        call("ui.attention",{{"owner","overlay"},{"sessionId",id},{"listening",true}});
        call("ui.panel",{{"owner","overlay"},{"visible",true}});
        QTRY_COMPARE(app->state().value("attention").toMap().value("overlay").toMap().value("sessionId").toString(),id);
        QCOMPARE(key(),QString("tender"));
        QCOMPARE(badge->property("emotion").value<QJSValue>().property("sessionId").toString(),id);
        call("ui.panel",{{"owner","overlay"},{"visible",false}});
        for(const auto &entry:app->state().value("completions").toList())call("completion.dismiss",{{"id",entry.toMap().value("id")}});
    }
    void pinnedConversationBubbles(){
        const auto originalSettings=app->state().value("settings").toMap();
        QString first,second;
        const auto restore=qScopeGuard([&]{
            for(const auto &id:{first,second})if(!id.isEmpty())call("session.organize",{{"id",id},{"pinned",false}});
            for(const auto &entry:app->state().value("completions").toList())call("completion.dismiss",{{"id",entry.toMap().value("id")}});
            call("settings.update",{{"hidden",originalSettings.value("hidden")},{"topmost",originalSettings.value("topmost")},{"quiet",originalSettings.value("quiet")}});
            restoreWorkspace();
        });
        QVERIFY(!call("settings.update",{{"topmost",false},{"hidden",false},{"quiet",true}}).contains("error"));
        for(const auto &entry:app->state().value("completions").toList())call("completion.dismiss",{{"id",entry.toMap().value("id")}});
        first=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Pinned project"}}).value("id").toString();
        second=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Another pinned project"}}).value("id").toString();
        QVERIFY(!first.isEmpty()&&!second.isEmpty());
        call("session.organize",{{"id",first},{"pinned",true}});
        auto replies=[&]{return app->state().value("companionReplies").toList();};
        auto workspace=window;
        // The expanded conversation stays open while another conversation speaks.
        movePointer(QPoint(0,0));
        QVERIFY(!call("session.send",{{"id",first},{"text","completion-first"}}).contains("error"));
        QTRY_COMPARE(replies().size(),2);
        QTRY_VERIFY((window=titled("Cere Approval")));
        QTRY_VERIFY(item("companionRequester"));
        QCOMPARE(item("companionRequester")->property("text").toString(),QString("Pinned project"));
        QVERIFY(workspace->isVisible());QCOMPARE(app->selectedId(),second);
        QVERIFY(window->flags().testFlag(Qt::WindowDoesNotAcceptFocus));
        auto bubble=qobject_cast<QQuickView*>(window)->rootObject();QVERIFY(bubble);
        QTRY_COMPARE(bubble->property("currentReply").toMap().value("id"),replies().last().toMap().value("id"));
        QVERIFY(!item("completionOpen"));QVERIFY(!item("companionStopSpeaking"));
        capture("pinned-conversation");
        click("companionPrevious");
        const auto reading=bubble->property("currentReply").toMap().value("id");
        QCOMPARE(reading,replies().first().toMap().value("id"));
        // Browsing an older reply holds it in place while new replies arrive.
        call("session.organize",{{"id",second},{"pinned",true}});
        call("session.send",{{"id",second},{"text","completion-second"}});
        QTRY_COMPARE(replies().size(),4);
        QCOMPARE(bubble->property("currentReply").toMap().value("id"),reading);
        click("companionNext");click("companionNext");click("companionNext");
        QTRY_COMPARE(item("companionRequester")->property("text").toString(),QString("Another pinned project"));
        const auto shown=bubble->property("currentReply").toMap();
        QCOMPARE(shown.value("id"),replies().last().toMap().value("id"));
        // Hovering a current reply also preserves the reader's place.
        call("session.send",{{"id",second},{"text","completion-second"}});
        QTRY_COMPARE(replies().size(),6);
        QCOMPARE(bubble->property("currentReply").toMap().value("id"),shown.value("id"));
        QTest::mouseMove(window,QPoint(-20,-20));movePointer(QPoint(0,0));
        QTRY_COMPARE(bubble->property("currentReply").toMap().value("id"),replies().last().toMap().value("id"));
        // Hidden avatar and drag suppression do not lose the reply queue.
        call("settings.update",{{"hidden",true}});QTRY_VERIFY(!titled("Cere Approval"));
        call("settings.update",{{"hidden",false}});QTRY_VERIFY((window=titled("Cere Approval")));
        app->beginDrag(40,40);QTRY_VERIFY(!titled("Cere Approval"));app->endDrag();
        QTRY_VERIFY((window=titled("Cere Approval")));
        call("session.organize",{{"id",second},{"pinned",false}});
        QTRY_COMPARE(replies().size(),2);
        click("companionOpen");
        QTRY_COMPARE(app->selectedId(),first);
        QTRY_COMPARE(replies().size(),1);
        QTRY_VERIFY((window=titled("Cere Approval")));
        click("companionDismiss");QTRY_VERIFY(replies().isEmpty());
        app->closePanel();QTRY_VERIFY(!titled("Cere Approval"));
    }
    void completionBubbles(){
        const auto restore=qScopeGuard([&]{
            for(const auto &entry:app->state().value("completions").toList())call("completion.dismiss",{{"id",entry.toMap().value("id")}});
            call("settings.update",{{"hidden",false},{"topmost",true},{"quiet",false},{"reducedMotion",false}});restoreWorkspace();
        });
        QVERIFY(!call("settings.update",{{"topmost",false},{"hidden",false},{"quiet",true},{"reducedMotion",true}}).contains("error"));
        auto completed=[&]{return app->state().value("completions").toList();};
        for(const auto &entry:completed())call("completion.dismiss",{{"id",entry.toMap().value("id")}});
        const auto first=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","First completion"}}).value("id").toString();
        const auto second=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Second completion"}}).value("id").toString();
        QVERIFY(!first.isEmpty()&&!second.isEmpty());
        app->closePanel();
        QVERIFY(!call("session.send",{{"id",first},{"text","completion-first"}}).contains("error"));
        QTRY_COMPARE(completed().size(),1);
        QVERIFY(!call("session.send",{{"id",second},{"text","completion-second"}}).contains("error"));
        QTRY_COMPARE(completed().size(),2);
        QTRY_VERIFY((window=titled("Cere Approval")));
        QTRY_VERIFY(item("completionRequester"));
        QVERIFY(item("completionRequester")->property("text").toString().contains("First completion"));
        const auto firstMessage=completed().first().toMap().value("message").toMap().value("id").toString();
        QVERIFY(item("messageBody_"+firstMessage)->property("text").toString().contains("completion-first finished"));
        QCOMPARE(app->selectedId(),second);
        capture("completion-first");
        // Pending input temporarily replaces the card without discarding any replies.
        QVERIFY(!call("session.send",{{"id",first},{"text","approval"}}).contains("error"));
        QTRY_COMPARE(app->state().value("approvals").toList().size(),1);
        QTRY_VERIFY(!item("completionOpen"));
        QVERIFY(item("bubbleHeading")->property("text").toString().contains("Input needed"));
        const auto request=app->state().value("approvals").toList().first().toMap().value("id");
        call("approval.answer",{{"id",request},{"choice","deny"}});
        QTRY_COMPARE(completed().size(),3);
        QTRY_VERIFY(item("completionDismiss"));
        click("completionDismiss");QTRY_COMPARE(completed().size(),2);
        QTRY_VERIFY(item("completionRequester")->property("text").toString().contains("Second completion"));
        app->select(first);click("completionOpen");
        QTRY_COMPARE(app->selectedId(),second);QTRY_COMPARE(completed().size(),1);
        QVERIFY(!titled("Cere Approval"));
        app->closePanel();QTRY_VERIFY((window=titled("Cere Approval")));
        click("completionDismiss");QTRY_VERIFY(completed().isEmpty());QTRY_VERIFY(!titled("Cere Approval"));
        // Long replies scroll, identify truncation, and copy from the correct session.
        QVERIFY(!call("session.send",{{"id",first},{"text","completion-long"}}).contains("error"));
        QTRY_COMPARE(completed().size(),1);QTRY_VERIFY((window=titled("Cere Approval")));
        const auto message=completed().first().toMap().value("message").toMap();
        QVERIFY(message.value("truncated").toBool());
        const auto messageId=message.value("id").toString();
        QTRY_VERIFY(item("copyMessage_"+messageId));click("copyMessage_"+messageId);
        QTRY_VERIFY(QGuiApplication::clipboard()->text().size()>16000);
        QVERIFY(QGuiApplication::clipboard()->text().startsWith("# Final report"));
        QVERIFY(window->height()<=460);capture("completion-long");
        call("settings.update",{{"hidden",true}});QTRY_VERIFY(!titled("Cere Approval"));
        call("settings.update",{{"hidden",false}});QTRY_VERIFY((window=titled("Cere Approval")));
        QVERIFY(item("completionOpen"));
    }
    // F-021: drafts stay coherent across compact and expanded composers.
    void compactProjectsAndEnterToSend(){
        auto original=window;
        const auto restore=qScopeGuard([&]{window=original;original->show();});
        original->hide();
        const QString cwd=data.path()+"/projects-ui";QVERIFY(QDir().mkpath(cwd));
        QQuickView panel;panel.setResizeMode(QQuickView::SizeRootObjectToView);
        panel.rootContext()->setContextProperty("App",app.get());
        panel.setSource(QUrl::fromLocalFile(QString(CERE_SOURCE_DIR)+"/qml/Panel.qml"));
        QCOMPARE(panel.status(),QQuickView::Ready);window=&panel;
        panel.resize(440,860);panel.show();panel.requestActivate();QTest::qWait(200);
        for(const auto name:{"Chat","Sessions","Projects","Desktop","Settings"}){
            auto tab=item(QString("tab_")+name);QVERIFY(tab);QCOMPARE(tab->property("text").toString(),QString());QCOMPARE(tab->property("help").toString(),QString(name));
        }
        click("tab_Projects");QTRY_VERIFY(item("projectSearch"));
        click("addProject");QTRY_VERIFY(item("sessionTitle"));
        item("sessionTitle")->setProperty("text","Projects UI");item("sessionProjectPath")->setProperty("text",cwd);
        click("projectFavorite");click("sessionTrust");
        auto model=item("sessionModel"),effort=item("sessionEffort");QVERIFY(model&&effort);
        QTRY_VERIFY(model->property("count").toInt()>=3);
        model->setProperty("currentIndex",1);QVERIFY(QMetaObject::invokeMethod(model,"activated",Q_ARG(int,1)));QTest::qWait(100);
        effort->setProperty("currentIndex",2);QVERIFY(QMetaObject::invokeMethod(effort,"activated",Q_ARG(int,2)));
        QVERIFY(item("sessionOpen")->isEnabled());click("sessionOpen");QTest::qWait(500);capture("projects-save-check");
        QTRY_VERIFY2(!item("sessionTitle"),qPrintable(item("newSessionError")?item("newSessionError")->property("text").toString():QString("Project settings stayed open")));
        item("projectSearch")->setProperty("text","Projects UI");QTRY_VERIFY(item("projectNew_0"));
        for(const QSize size:{QSize(440,860),QSize(360,560)}){
            panel.setMinimumSize(size);panel.setMaximumSize(size);panel.resize(size);QTest::qWait(150);
            auto settings=item("projectSettings_0"),plus=item("projectNew_0"),row=item("projectOpen_0");QVERIFY(settings&&plus&&row);
            QCOMPARE(settings->width(),settings->height());QCOMPARE(plus->width(),plus->height());
            QVERIFY(settings->mapToScene(QPointF()).x()<plus->mapToScene(QPointF()).x());
            QVERIFY(row->width()>140);QVERIFY(plus->mapToScene(QPointF(plus->width(),0)).x()<panel.width());
            capture(QString("projects-%1x%2").arg(size.width()).arg(size.height()));
        }
        click("projectSettings_0");QTRY_VERIFY(item("sessionTitle"));
        QCOMPARE(item("sessionTitle")->property("text").toString(),QString("Projects UI"));
        QVERIFY(item("sessionProjectPath")->property("readOnly").toBool());
        QTRY_COMPARE(item("sessionModel")->property("currentValue").toString(),QString("fixture-model"));
        QTRY_COMPARE(item("sessionEffort")->property("currentValue").toString(),QString("high"));
        QVERIFY(item("projectFavorite")->property("checked").toBool());QVERIFY(item("sessionTrust")->property("checked").toBool());
        capture("project-defaults-360x560");QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(100);
        click("projectNew_0");QTRY_VERIFY(item("projectSessionName"));QVERIFY(!item("sessionProvider"));
        item("projectSessionName")->setProperty("text","Quick project task");item("projectSessionName")->forceActiveFocus();
        capture("project-quick-session-360x560");QTest::keyClick(window,Qt::Key_Return);
        QTRY_COMPARE(app->session().value("title").toString(),QString("Quick project task"));
        QCOMPARE(app->session().value("cwd").toString(),cwd);QCOMPARE(app->session().value("model").toString(),QString("fixture-model"));QCOMPARE(app->session().value("effort").toString(),QString("high"));
        QTRY_VERIFY(item("composer"));auto composer=item("composer");
        composer->forceActiveFocus();for(const auto ch:QByteArray("completion-first line"))QTest::keyClick(window,ch);QTest::keyClick(window,Qt::Key_Return,Qt::ShiftModifier);for(const auto ch:QByteArray("Second line"))QTest::keyClick(window,ch);
        QCOMPARE(composer->property("text").toString(),QString("completion-first line\nSecond line"));QCOMPARE(app->messages().size(),0);
        QTest::keyClick(window,Qt::Key_Return);
        QTRY_VERIFY_WITH_TIMEOUT(app->messages().size()>=2,10000);
        QCOMPARE(app->messages().first().toMap().value("text").toString(),QString("completion-first line\nSecond line"));
        QTRY_COMPARE(composer->property("text").toString(),QString());
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        const auto messageCount=app->messages().size();QTest::keyClick(window,Qt::Key_Return);QTest::qWait(100);QCOMPARE(app->messages().size(),messageCount);
        click("tab_Projects");QTRY_VERIFY(item("projectOpen_0"));click("projectOpen_0");QTRY_VERIFY(item("sessionFilter"));
        QVERIFY(item("sessionFilter")->property("currentText").toString().contains("projects-ui"));
        panel.hide();
    }
    void compactComposerClipboard(){
        auto original=window;
        const auto restore=qScopeGuard([&]{window=original;original->show();QGuiApplication::clipboard()->clear();});
        original->hide();
        const auto created=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","A little more room to talk"}});
        QVERIFY2(!created.contains("error"),qPrintable(created.value("error").toString()));
        QQuickView panel;panel.setResizeMode(QQuickView::SizeRootObjectToView);
        panel.rootContext()->setContextProperty("App",app.get());
        panel.setSource(QUrl::fromLocalFile(QString(CERE_SOURCE_DIR)+"/qml/Panel.qml"));
        QCOMPARE(panel.status(),QQuickView::Ready);window=&panel;
        for(const QSize size:{QSize(440,860),QSize(360,560)}){
            panel.setMinimumSize(size);panel.setMaximumSize(size);panel.resize(size);panel.show();panel.requestActivate();QTest::qWait(200);
            auto search=item("openCommandPalette"),expand=item("expandWindow"),mic=item("voiceRecord"),send=item("sendMessage");
            QVERIFY(search&&expand&&mic&&send);QCOMPARE(search->width(),search->height());QCOMPARE(mic->width(),mic->height());
            QVERIFY(search->mapToScene(QPointF()).x()<expand->mapToScene(QPointF()).x());
            QCOMPARE(search->mapToScene(QPointF()).y(),expand->mapToScene(QPointF()).y());
            QVERIFY(mic->mapToScene(QPointF()).x()<send->mapToScene(QPointF()).x());
            QCOMPARE(mic->mapToScene(QPointF()).y(),send->mapToScene(QPointF()).y());
            QVERIFY(!item("openWorkflows"));
            auto card=item("composerCard"),row=item("conversationTools"),more=item("conversationMore"),area=item("conversationArea");
            QVERIFY(card&&area&&(row||more));
            // A full-height panel keeps the tools row; a short one folds it into More beside Send (F-03).
            if(size.height()>=860)QVERIFY(row);
            if(row){QVERIFY(row->mapToScene(QPointF()).y()>=card->mapToScene(QPointF(0,card->height())).y());QVERIFY(row->mapToScene(QPointF(0,row->height())).y()<panel.height());}
            else QCOMPARE(more->mapToScene(QPointF()).y(),send->mapToScene(QPointF()).y());
            QVERIFY(area->height()>=120);
            if(size.width()==440){
                QCOMPARE(item("chatHandoff")->mapToScene(QPointF()).y(),item("contextDrawerButton")->mapToScene(QPointF()).y());
                capture("compact-clean-composer");
            }
            click("openCommandPalette");QTRY_VERIFY(item("commandPaletteSearch"));
            QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(100);
        }
        panel.setMinimumSize({440,860});panel.setMaximumSize({440,860});panel.resize(440,860);QTest::qWait(100);
        auto composer=item("composer");QVERIFY(composer);composer->setProperty("text","Replace this");composer->forceActiveFocus();
        QTest::keyClick(window,Qt::Key_A,Qt::ControlModifier);QGuiApplication::clipboard()->setText("Pasted at the selection");
        QTest::keyClick(window,Qt::Key_V,Qt::ControlModifier);
        QTRY_COMPARE(composer->property("text").toString(),QString("Pasted at the selection"));
        QImage screenshot(32,24,QImage::Format_ARGB32);screenshot.fill(QColor("#5dd8ff"));
        auto browserImage=new QMimeData;browserImage->setImageData(screenshot);browserImage->setUrls({QUrl("https://example.com/source.png")});QGuiApplication::clipboard()->setMimeData(browserImage);
        QTest::keyClick(window,Qt::Key_V,Qt::ControlModifier);
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("draftAttachments").toList().size(),1,5000);
        auto asset=app->session().value("draftAttachments").toList().first().toMap();QCOMPARE(asset.value("kind").toString(),QString("image"));QVERIFY(QFile::exists(asset.value("path").toString()));
        QList<QUrl> urls;
        for(const auto name:{"pasted one.txt","pasted-two.md"}){const auto path=data.path()+"/"+name;QFile f(path);QVERIFY(f.open(QIODevice::WriteOnly));f.write("Clipboard file reference");f.close();urls.append(QUrl::fromLocalFile(path));}
        auto files=new QMimeData;files->setUrls(urls);QGuiApplication::clipboard()->setMimeData(files);click("pasteClipboard");
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("draftAttachments").toList().size(),3,5000);
        QTest::qWait(900);QCOMPARE(app->session().value("draftAttachments").toList().size(),3);
        QCOMPARE(composer->property("text").toString(),QString("Pasted at the selection"));
        QVERIFY(!item("draftConflict"));capture("compact-pasted-attachments");
        auto remote=new QMimeData;remote->setUrls({QUrl("https://example.com/not-a-local-file")});QGuiApplication::clipboard()->setMimeData(remote);click("pasteClipboard");
        QCOMPARE(app->session().value("draftAttachments").toList().size(),3);QVERIFY(!item("chatView")->property("attachmentError").toString().isEmpty());
        auto copied=new QMimeData;copied->setData("x-special/gnome-copied-files",("copy\n"+urls.first().toString(QUrl::FullyEncoded)).toUtf8());QGuiApplication::clipboard()->setMimeData(copied);
        const auto decoded=app->clipboardContent();QVERIFY(decoded.value("handled").toBool());QVERIFY(decoded.value("error").toString().isEmpty());QCOMPARE(decoded.value("paths").toStringList(),QStringList{urls.first().toLocalFile()});
        // The UI invokes transcription and gives a useful setup error without opening a microphone.
        click("voiceRecord");QTRY_VERIFY(item("voiceInputStatus"));
        QVERIFY(item("voiceInputStatus")->property("text").toString().contains("Settings"));
        QCOMPARE(app->state().value("transcription").toMap().value("state").toString(),QString("unavailable"));
        panel.hide();
    }
    void persistentPermissionSwitches(){
        click("tab_Settings");
        const auto original=app->state().value("settings").toMap();
        const auto restore=qScopeGuard([&]{call("settings.update",{{"bypassCliPermissions",original.value("bypassCliPermissions")},{"bypassComputerPermissions",original.value("bypassComputerPermissions")}});click("tab_Chat");});
        QVERIFY(!call("settings.update",{{"bypassCliPermissions",false},{"bypassComputerPermissions",false}}).contains("error"));
        click("bypassCliPermissions");QTRY_VERIFY(app->state().value("settings").toMap().value("bypassCliPermissions").toBool());
        click("bypassComputerPermissions");QTRY_VERIFY(app->state().value("settings").toMap().value("bypassComputerPermissions").toBool());
        click("bypassCliPermissions");QTRY_VERIFY(!app->state().value("settings").toMap().value("bypassCliPermissions").toBool());
        click("bypassComputerPermissions");QTRY_VERIFY(!app->state().value("settings").toMap().value("bypassComputerPermissions").toBool());
    }
    void foldersAttachmentsAndPalette(){
        restoreWorkspace();click("tab_Chat");const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Organized project draft"}});
        QTRY_VERIFY(app->selectedId()!=previous);const auto id=app->selectedId();
        click("tab_Sessions");click("createFolder");
        item("folderName")->setProperty("text","Roadmap folder");click("saveFolder");
        QTRY_VERIFY(!app->state().value("folders").toList().isEmpty());
        const auto folder=app->state().value("folders").toList().first().toMap();
        QVERIFY(!call("session.organize",{{"id",id},{"folderId",folder.value("id")},{"pinned",true}}).contains("error"));
        click("tab_Chat");QTRY_VERIFY(item("composer"));
        item("composer")->setProperty("text","A draft with an attachment");
        const auto path=data.path()+"/draft-reference.txt";QFile file(path);QVERIFY(file.open(QIODevice::WriteOnly));file.write("Reference content kept with the draft.");file.close();
        app->attachImage(path);
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("draftAttachments").toList().size(),1,5000);
        const auto asset=app->session().value("draftAttachments").toList().first().toMap();
        QVERIFY(item("attachmentChip_"+asset.value("id").toString()));
        tool("contextDrawerButton","menuContext");QTRY_VERIFY(item("closeContextDrawer"));capture("context-drawer");click("closeContextDrawer");
        app->closePanel();restoreWorkspace();QTRY_COMPARE(app->session().value("draftAttachments").toList().size(),1);
        QCOMPARE(item("composer")->property("text").toString(),QString("A draft with an attachment"));
        QTest::keyClick(window,Qt::Key_K,Qt::ControlModifier);QTRY_VERIFY(item("commandPaletteSearch"));
        item("commandPaletteSearch")->setProperty("text","Organized project draft");QTest::qWait(150);
        QVERIFY(item("command_session_"+QString(id).replace('-','_'))||item("command_session_"+id));
        QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(100);
        const auto removed=call("folders.delete",{{"id",folder.value("id")},{"expectedRevision",folder.value("revision")}});QVERIFY(!removed.contains("error"));
        QTRY_VERIFY(app->session().value("folderId").isNull());QCOMPARE(app->session().value("pinned").toBool(),true);
    }
    void sessionContextActions(){
        restoreWorkspace();window->resize(1040,780);click("tab_Sessions");
        const auto folder=call("folders.save",{{"name","Context menu folder"}});QVERIFY(!folder.contains("error"));
        const auto target=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Context target"}}).value("id").toString();
        const auto current=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Keep current conversation"}}).value("id").toString();
        QVERIFY(!target.isEmpty()&&!current.isEmpty());app->select(current);
        auto session=[&]{
            for(const auto &entry:app->state().value("sessions").toList())if(entry.toMap().value("id")==target)return entry.toMap();
            // Archived conversations leave the broker state unless a window has them selected.
            for(const auto &entry:call("sessions.list",{{"archived",true},{"limit",200}}).value("sessions").toList())if(entry.toMap().value("id")==target)return entry.toMap();
            return QVariantMap{};
        };
        auto row=[&](const QString &viewport)->QQuickItem*{
            auto root=item(viewport);if(!root)return nullptr;
            std::function<QQuickItem*(QQuickItem*)> find=[&](QQuickItem *node)->QQuickItem*{
                if(node->isVisible()&&node->objectName()=="session_"+target)return node;
                for(auto child:node->childItems())if(auto found=find(child))return found;return nullptr;
            };
            if(auto found=find(root))return found;
            // Earlier checks can leave pinned sessions above the target, so scroll its row into view.
            QQuickItem *list=root->parentItem();while(list&&!list->property("filtered").isValid())list=list->parentItem();
            if(!list)return nullptr;
            auto rows=list->property("filtered");if(rows.metaType()==QMetaType::fromType<QJSValue>())rows=rows.value<QJSValue>().toVariant();
            const auto entries=rows.toList();
            for(int index=0;index<entries.size();++index)if(entries[index].toMap().value("id")==target)
                QMetaObject::invokeMethod(root,"positionViewAtIndex",Q_ARG(int,index),Q_ARG(int,1));
            return find(root);
        };
        auto openMenu=[&](const QString &viewport){
            QTest::qWait(180); // Let the prior dialog close and the catalog refresh settle.
            auto control=row(viewport);QVERIFY(control);
            // ListView can shift originY below zero after moving a renamed row.
            // Its own positioning API accounts for that; clamping contentY to zero does not.
            const int index=control->parentItem()->property("index").toInt();
            QVERIFY(QMetaObject::invokeMethod(item(viewport),"positionViewAtIndex",Q_ARG(int,index),Q_ARG(int,1)));
            QTest::qWait(80);control=row(viewport);QVERIFY(control);
            QTest::mouseClick(window,Qt::RightButton,Qt::NoModifier,control->mapToScene(QPointF(control->width()/2,control->height()/2)).toPoint());
            QTest::qWait(80);capture("context-open-"+viewport);
            QTRY_VERIFY(item("sessionContextRename"));QCOMPARE(app->selectedId(),current);
        };
        for(const QString viewport:{QString("sidebarSessionList"),QString("sessionList")}){
            click(viewport=="sidebarSessionList"?"tab_Chat":"tab_Sessions");
            QTRY_VERIFY(row(viewport));openMenu(viewport);capture("session-context-menu-"+viewport);click("sessionContextRename");
            QTRY_VERIFY(item("sessionContextTitle"));const auto title="Renamed from "+viewport;
            item("sessionContextTitle")->setProperty("text",title);click("sessionContextSaveTitle");
            QTRY_COMPARE(session().value("title").toString(),title);QCOMPARE(app->selectedId(),current);
            openMenu(viewport);
            QTRY_VERIFY(item("sessionContextFolderMenuItem"));click("sessionContextFolderMenuItem");
            const auto folderItem="sessionContextFolder_"+folder.value("id").toString();
            QTRY_VERIFY(item(folderItem));click(folderItem);QTRY_COMPARE(session().value("folderId"),folder.value("id"));
            openMenu(viewport);click("sessionContextUnfile");QTRY_VERIFY(session().value("folderId").isNull());
            QTest::qWait(180);auto control=row(viewport);QVERIFY(control);control->forceActiveFocus();QTest::keyClick(window,Qt::Key_F10,Qt::ShiftModifier);
            QTRY_VERIFY(item("sessionContextPin"));click("sessionContextPin");QTRY_VERIFY(session().value("pinned").toBool());
            openMenu(viewport);QCOMPARE(item("sessionContextPin")->property("text").toString(),QString("Unpin"));click("sessionContextPin");QTRY_VERIFY(!session().value("pinned").toBool());
            QCOMPARE(app->selectedId(),current);
        }
        openMenu("sessionList");click("sessionContextArchive");QTRY_VERIFY(session().value("archived").toBool());
        auto filter=item("sessionFilter");QVERIFY(filter);filter->setProperty("currentIndex",5);QVERIFY(QMetaObject::invokeMethod(filter,"activated",Q_ARG(int,5)));
        QTRY_VERIFY(row("sessionList"));openMenu("sessionList");QCOMPARE(item("sessionContextArchive")->property("text").toString(),QString("Unarchive"));click("sessionContextArchive");
        QTRY_VERIFY(!session().value("archived").toBool());filter->setProperty("currentIndex",0);QVERIFY(QMetaObject::invokeMethod(filter,"activated",Q_ARG(int,0)));
        QTRY_VERIFY(row("sessionList"));auto control=row("sessionList");QTest::mouseClick(window,Qt::LeftButton,Qt::NoModifier,control->mapToScene(QPointF(control->width()/2,control->height()/2)).toPoint());
        QTRY_COMPARE(app->selectedId(),target);QTRY_VERIFY(item("composer"));
        QVERIFY(!call("folders.delete",{{"id",folder.value("id")},{"expectedRevision",folder.value("revision")}}).contains("error"));
        // F10: Delete… asks first, then removes the open conversation and moves the selection off it.
        click("tab_Sessions");QTRY_VERIFY(row("sessionList"));control=row("sessionList");
        QTest::mouseClick(window,Qt::RightButton,Qt::NoModifier,control->mapToScene(QPointF(control->width()/2,control->height()/2)).toPoint());
        QTRY_VERIFY(item("sessionContextDelete"));click("sessionContextDelete");
        QTRY_VERIFY(item("sessionDeleteConfirm"));QVERIFY(!session().isEmpty());
        click("sessionDeleteConfirm");
        QTRY_VERIFY(session().isEmpty());QTRY_VERIFY(!row("sessionList"));QTRY_VERIFY(app->selectedId()!=target);
    }
    void projectCapsulesAndRecipeReview(){
        const auto source=call("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Workflow check"}});
        QVERIFY(!source.contains("error"));app->select(source.value("id").toString());
        click(item("sidebarWorkflows")?"sidebarWorkflows":"openWorkflows");QTRY_VERIFY(item("capsuleGoal"));
        item("capsuleGoal")->setProperty("text","Keep the release reviewable");click("saveCapsule");
        QTRY_COMPARE(call("capsules.get",{{"sessionId",source.value("id")}}).value("goal").toString(),QString("Keep the release reviewable"));
        click("resumeCapsule");QTRY_VERIFY(app->selectedId()!=source.value("id").toString());
        QTRY_VERIFY(item("composer"));QTRY_VERIFY(item("composer")->property("text").toString().contains("Keep the release reviewable"));
        click(item("sidebarWorkflows")?"sidebarWorkflows":"openWorkflows");click("workflowTab1");QTRY_VERIFY(item("recipePicker"));
        const auto recipes=call("recipes.list").value("recipes").toList();int index=-1;
        for(int i=0;i<recipes.size();++i)if(recipes[i].toMap().value("id")=="diagnose-crash")index=i;
        QVERIFY(index>=0);item("recipePicker")->setProperty("currentIndex",index);QVERIFY(QMetaObject::invokeMethod(item("recipePicker"),"activated",Q_ARG(int,index)));
        QTRY_VERIFY(item("recipeInput_error"));QString input;for(int i=0;i<40;++i)input+=QString("Crash evidence line %1\n").arg(i);
        item("recipeInput_error")->setProperty("text",input);click("prepareRecipe");QTRY_VERIFY(item("completeRecipePrompt"));
        QTRY_VERIFY(item("completeRecipePrompt")->property("text").toString().contains("Crash evidence line 39"));
        const auto before=app->selectedId();click("createRecipeDraft");QTRY_VERIFY(app->selectedId()!=before);
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));QTRY_VERIFY(item("composer")->property("text").toString().contains("Crash evidence line 39"));
    }
    void draftsStayCoherentAcrossComposers(){
        const auto restore=qScopeGuard([&]{app->rpc("settings.update",{{"topmost",true}});restoreWorkspace();});
        click("tab_Chat");const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Draft coherence"}});
        QTRY_VERIFY(app->selectedId()!=previous);const auto session=app->selectedId();
        app->rpc("settings.update",{{"topmost",false}});
        auto saved=[&]{return app->session().value("draft").toString();};
        auto compact=[&]{
            app->closePanel();app->togglePanel();QTRY_VERIFY((window=titled("Cere Panel")));QTest::qWait(150);
            click("tab_Sessions");click("session_"+session);QTRY_VERIFY(item("composer"));
        };
        // Edits shorter than the 600 ms debounce survive hiding and expanding in both directions.
        restoreWorkspace();
        item("composer")->setProperty("text","typed in the workspace");
        compact();QTRY_COMPARE(item("composer")->property("text").toString(),QString("typed in the workspace"));
        item("composer")->setProperty("text","typed in the compact panel");
        restoreWorkspace();QTRY_COMPARE(item("composer")->property("text").toString(),QString("typed in the compact panel"));
        QTRY_COMPARE(saved(),QString("typed in the compact panel"));
        // A clean composer follows another client's newer draft instead of overwriting it.
        QVERIFY(!call("session.draft",{{"id",session},{"text","from another client"},{"expectedRevision",app->session().value("draftRevision")}}).contains("error"));
        QTRY_COMPARE(item("composer")->property("text").toString(),QString("from another client"));
        app->closePanel();QTest::qWait(800);QCOMPARE(saved(),QString("from another client"));
        // A dirty composer keeps its text and offers review when another client wins.
        restoreWorkspace();QTRY_COMPARE(item("composer")->property("text").toString(),QString("from another client"));
        item("composer")->setProperty("text","my unsaved edit");
        QVERIFY(!call("session.draft",{{"id",session},{"text","external newer"},{"expectedRevision",app->session().value("draftRevision")}}).contains("error"));
        QTRY_VERIFY_WITH_TIMEOUT(item("draftConflict"),3000);
        QCOMPARE(item("composer")->property("text").toString(),QString("my unsaved edit"));QCOMPARE(saved(),QString("external newer"));
        click("draftKeepMine");QTRY_COMPARE(saved(),QString("my unsaved edit"));QTRY_VERIFY(!item("draftConflict"));
        // Hiding saves an edit made inside the 600 ms debounce at once, not when the timer fires.
        item("composer")->setProperty("text","flushed on hide");app->closePanel();QTest::qWait(300);
        QCOMPARE(saved(),QString("flushed on hide"));restoreWorkspace();
        // Destroying the host view saves a pending edit as well.
        item("composer")->setProperty("text","saved on destruction");
        app->closePanel();app->togglePanel();QTRY_VERIFY(titled("Cere Panel"));
        QTRY_COMPARE(saved(),QString("saved on destruction"));
        // F-14: an edit typed while an earlier save is still in flight survives an immediate Expand,
        // even though Expand destroys this editor before that save returns.
        window=titled("Cere Panel");QTRY_VERIFY(item("composer"));
        item("composer")->setProperty("text","saved first");
        QVERIFY(QMetaObject::invokeMethod(item("chatView"),"saveDraft",Q_ARG(QVariant,false),Q_ARG(QVariant,false)));
        item("composer")->setProperty("text","typed during that save");
        restoreWorkspace();
        QTRY_COMPARE(saved(),QString("typed during that save"));
        QTRY_COMPARE(item("composer")->property("text").toString(),QString("typed during that save"));
    }
    // F-036: the compact panel fits short, narrow and negative-origin outputs.
    void compactPanelFitsEveryOutput(){
        const auto restore=qScopeGuard([&]{app->rpc("settings.update",{{"topmost",true},{"roaming",false}});restoreWorkspace();});
        app->rpc("settings.update",{{"topmost",false},{"roaming",false},{"scale",1.0}});
        for(auto screen:qGuiApp->screens())qInfo()<<"Compact panel output"<<screen->name()<<screen->availableGeometry();
        for(auto screen:qGuiApp->screens())for(const QPointF corner:{QPointF(.95,.95),QPointF(.05,.05)}){
            const QString where=(QString("%1 %2x%3 at %4,%5").arg(screen->name()).arg(screen->geometry().width()).arg(screen->geometry().height()).arg(corner.x()).arg(corner.y()));
            app->closePanel();
            app->rpc("settings.update",{{"position",QVariantMap{{"output",screen->name()},{"x",corner.x()},{"y",corner.y()}}}});
            QTRY_VERIFY2(screen->geometry().contains(app->petPosition()),qPrintable(where));
            app->togglePanel();QQuickWindow *panel=nullptr;QTRY_VERIFY2((panel=titled("Cere Panel")),qPrintable(where));
            const QRect area=screen->availableGeometry().adjusted(12,40,-12,-12);
            QTRY_VERIFY2(area.contains(panel->geometry()),qPrintable(QString("%1 panel %2,%3 %4x%5").arg(where).arg(panel->x()).arg(panel->y()).arg(panel->width()).arg(panel->height())));
            QVERIFY2(panel->width()<=440&&panel->height()<=860,qPrintable(where));
            // Compact navigation still works at the capped size.
            window=panel;QTest::qWait(100);click("tab_Sessions");QVERIFY2(item("newSession"),qPrintable(where));
        }
    }
    // F-04: without always-on-top the compact panel is a normal window, so Hyprland must float it
    // at its compact size beside the pet instead of tiling it.
    void compactPanelFloatsWithoutAlwaysOnTop(){
        if(!liveHyprland())QSKIP("Needs the live Hyprland compositor");
        const auto restore=qScopeGuard([&]{app->closePanel();app->rpc("settings.update",{{"topmost",true}});restoreWorkspace();});
        app->rpc("settings.update",{{"topmost",false},{"roaming",false},{"hidden",false}});QTest::qWait(600);
        auto client=[&]{for(const auto value:hypr({"-j","clients"}).array()){const auto w=value.toObject();if(w["pid"].toInteger()==QCoreApplication::applicationPid()&&w["title"].toString()=="Cere Panel")return w;}return QJsonObject();};
        for(int round=0;round<2;++round){ // a hidden window is a new window to Hyprland when it returns
            app->closePanel();QTest::qWait(300);app->togglePanel();
            QTRY_VERIFY_WITH_TIMEOUT(client()["floating"].toBool(),3000);
            const auto w=client();const auto at=w["at"].toArray(),size=w["size"].toArray();
            const QRect geometry(at[0].toInt(),at[1].toInt(),size[0].toInt(),size[1].toInt());
            QVERIFY2(geometry.width()<=440&&geometry.height()<=860,qPrintable(QString("panel %1x%2").arg(geometry.width()).arg(geometry.height())));
            bool onOutput=false;for(auto screen:qGuiApp->screens())if(screen->geometry().contains(geometry))onOutput=true;
            QVERIFY2(onOutput,qPrintable(QString("panel at %1,%2").arg(geometry.x()).arg(geometry.y())));
        }
    }
    // F-09: without always-on-top the approval bubble is a normal window, yet it must not take the
    // keyboard from the application the user is typing in.
    void approvalBubbleNeverTakesFocus(){
        if(!liveHyprland())QSKIP("Needs the live Hyprland compositor");
        const auto restore=qScopeGuard([&]{
            for(const auto &r:app->state().value("approvals").toList())call("approval.answer",{{"id",r.toMap().value("id")},{"choice","deny"}});
            app->rpc("settings.update",{{"topmost",true},{"quiet",false},{"reducedMotion",false}});restoreWorkspace();
        });
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true},{"hidden",false}});QTest::qWait(600);
        const auto session=createSession("codex","Bubble focus");QVERIFY(!session.isEmpty());
        app->closePanel();QTest::qWait(600);
        auto active=[&]{return hypr({"-j","activewindow"}).object().value("title").toString();};
        const QString before=active();
        call("session.send",{{"id",session},{"text","approval"}});
        QQuickWindow *bubble=nullptr;QTRY_VERIFY_WITH_TIMEOUT((bubble=titled("Cere Approval")),8000);
        QTest::qWait(900);
        QVERIFY2(active()!="Cere Approval",qPrintable("Hyprland gave the bubble the keyboard; active before: "+before));
        QVERIFY2(!bubble->isActive(),"the bubble became the active window");
    }
    // F-037: roaming crosses output seams without jumps at every scale.
    void roamingPlacementIsContinuousAcrossOutputs(){
        QList<QPair<QScreen*,QScreen*>> seams;
        for(auto a:qGuiApp->screens())for(auto b:qGuiApp->screens()){
            const auto g=a->geometry(),h=b->geometry();
            if((g.right()+1==h.left()&&std::min(g.bottom(),h.bottom())-std::max(g.top(),h.top())>=700)||
               (g.bottom()+1==h.top()&&std::min(g.right(),h.right())-std::max(g.left(),h.left())>=700))seams.append(qMakePair(a,b));
        }
        if(seams.isEmpty())QSKIP("Requires adjacent outputs");
        for(const auto &[a,b]:seams)qInfo()<<"Roaming seam"<<a->name()<<a->geometry()<<b->name()<<b->geometry();
        const auto originalPointer=pointer();
        const auto restore=qScopeGuard([&]{app->rpc("settings.update",{{"roaming",false},{"scale",1.0},{"topmost",true}});app->setPetInteracting(false);movePointer(originalPointer);restoreWorkspace();});
        QQuickWindow backdrop;backdrop.setTitle("Cere Follow Check");backdrop.setMinimumSize({180,80});backdrop.setMaximumSize({180,80});backdrop.resize(180,80);backdrop.show();backdrop.requestActivate();
        app->closePanel();
        // A reply or completion bubble beside the pet pauses following; earlier checks may have left some.
        for(const auto &entry:app->state().value("completions").toList())call("completion.dismiss",{{"id",entry.toMap().value("id")}});
        for(const auto &entry:app->state().value("companionReplies").toList())call("companion.dismiss",{{"id",entry.toMap().value("id")}});
        QTRY_VERIFY(!titled("Cere Approval"));
        const double tolerance=3; // Rounding plus one timer tick of scheduling slack.
        bool cancelled=false;
        for(const auto &[source,target]:seams)for(const double scale:{.5,1.,3.}){
            const auto a=source->geometry(),b=target->geometry();const bool horizontal=a.right()+1==b.left();
            const QSize size(qRound(192*scale),qRound(208*scale));
            const QString where=(QString("%1 -> %2 at scale %3").arg(source->name(),target->name()).arg(scale));
            app->rpc("settings.update",{{"roaming",false},{"topmost",false},{"quiet",false},{"reducedMotion",false},{"scale",scale},
                {"position",QVariantMap{{"output",source->name()},{"x",horizontal?double(a.width()-size.width()-60)/(a.width()-size.width()):.5},{"y",horizontal?.5:double(a.height()-size.height()-60)/(a.height()-size.height())}}}});
            QTRY_VERIFY2(a.contains(QRect(app->petPosition(),size)),qPrintable(where));
            const int gap=qRound(std::hypot(size.width()/2.,size.height()/2.))+24;
            movePointer(horizontal?QPoint(b.left()+std::min(b.width()-40,size.width()+gap+200),b.center().y()):QPoint(b.center().x(),b.top()+std::min(b.height()-40,size.height()+gap+200)));
            QTest::qWait(100);app->rpc("settings.update",{{"roaming",true}});
            QPoint last=app->petPosition();QElapsedTimer clock;clock.start();qint64 sampled=0;
            bool straddled=false,settled=false;
            auto sample=[&](const char *phase){
                const QPoint now=app->petPosition();const qint64 at=clock.elapsed();
                const QRect rect(now,size);if(rect.intersects(a)&&rect.intersects(b))straddled=true;
                // Speed is measured over about 100 ms, allowing the one frame that straddles the window
                // start (each frame advances at most 50 ms of motion). A jump never fits the bound.
                if(at-sampled<96)return QString();
                const double step=QLineF(last,now).length(),bound=75*((at-sampled)/1000.+.05)+tolerance;
                const QString error=step<=bound?QString():QString("%1 %2: moved %3 px in %4 ms").arg(where,phase).arg(step).arg(at-sampled);
                last=now;sampled=at;
                return error;
            };
            while(clock.elapsed()<45000){
                QTest::qWait(12);{const auto error=sample("roaming");QVERIFY2(error.isEmpty(),qPrintable(error));}
                // Cancelling once mid-crossing keeps the visible point, then settles slowly and persists.
                if(!cancelled&&straddled&&scale==1.){
                    cancelled=true;app->rpc("settings.update",{{"roaming",false}});
                    const QPoint center=app->petPosition()+QPoint(size.width()/2,size.height()/2);
                    QScreen *holder=a.contains(center)?source:target;
                    while(clock.elapsed()<45000&&!holder->geometry().contains(QRect(app->petPosition(),size))){QTest::qWait(12);const auto error=sample("settling");QVERIFY2(error.isEmpty(),qPrintable(error));}
                    QVERIFY2(holder->geometry().contains(QRect(app->petPosition(),size)),qPrintable(where));
                    QTRY_COMPARE(app->state().value("settings").toMap().value("position").toMap().value("output").toString(),holder->name());
                    app->rpc("settings.update",{{"roaming",true}});
                }
                // A pet larger than the output covers it fully in that dimension (Short150 at 300%).
                if((QRect(app->petPosition(),size)&b).size()==size.boundedTo(b.size())&&app->motion()!="runLeft"&&app->motion()!="runRight"){settled=true;break;}
            }
            // The pet only roams when it may idle, so a failure names what held it.
            int busy=0;for(const auto &entry:app->state().value("sessions").toList())if(QStringList{"working","starting","stopping"}.contains(entry.toMap().value("status").toString()))++busy;
            const QString held=QString(" (motion %1; %2 approvals, %3 busy, %4 completions, %5 pinned replies)").arg(app->motion()).arg(app->state().value("approvals").toList().size()).arg(busy)
                .arg(app->state().value("completions").toList().size()).arg(app->state().value("companionReplies").toList().size());
            QVERIFY2(straddled,qPrintable(where+held));QVERIFY2(settled,qPrintable(where+held));
        }
        QVERIFY(cancelled);
    }
    // F-018: reconnection recovers the transcript and resolves every pending request once.
    void reconnectRecoversTranscriptAndFailsPendingRequests(){
        // A test-owned broker on a private runtime directory, driven line by line.
        QTemporaryDir runtime;QVERIFY(runtime.isValid());
        QFile::setPermissions(runtime.path(),QFileDevice::ReadOwner|QFileDevice::WriteOwner|QFileDevice::ExeOwner);
        QLocalServer server;QVERIFY(server.listen(runtime.path()+"/broker.sock"));
        auto message=[](const char *id,const char *role,const QString &text,int revision){return QVariantMap{{"id",id},{"sessionId","fake-a"},{"role",role},{"text",text},{"revision",QString::number(revision)},{"time",1000+revision}};};
        QVariantList transcript{message("m1","user","Explain the plan.",1),message("m2","assistant","The plan",2)};
        const QVariantMap state{{"sessions",QVariantList{
                QVariantMap{{"id","fake-a"},{"title","Fake A"},{"provider","codex"},{"status","idle"},{"cwd","/tmp"}},
                QVariantMap{{"id","fake-b"},{"title","Fake B"},{"provider","codex"},{"status","idle"},{"cwd","/tmp"}}}},
            {"settings",QVariantMap{{"hidden",true},{"personality","Old voice"}}},{"settingsRevision","1"},{"approvals",QVariantList{}}};
        QStringList received;QPointer<QLocalSocket> client;QByteArray buffer;std::function<void()> beforePage;
        auto send=[&](const QJsonObject &o){if(client)client->write(QJsonDocument(o).toJson(QJsonDocument::Compact)+'\n');};
        auto notify=[&](const QVariantMap &params){send(QJsonObject{{"method","message"},{"params",QJsonObject::fromVariantMap(params)}});};
        connect(&server,&QLocalServer::newConnection,this,[&]{
            client=server.nextPendingConnection();buffer.clear();
            connect(client,&QLocalSocket::readyRead,this,[&]{
                buffer+=client->readAll();int newline;
                while((newline=buffer.indexOf('\n'))>=0){
                    const auto request=QJsonDocument::fromJson(buffer.left(newline)).object();buffer.remove(0,newline+1);
                    const auto method=request["method"].toString();const int id=request["id"].toInt();received<<method;
                    auto reply=[&](const QVariant &value){send(QJsonObject{{"id",id},{"result",QJsonValue::fromVariant(value)}});};
                    if(method=="subscribe")reply(state);
                    else if(method=="session.messages"){if(beforePage){beforePage();beforePage=nullptr;}reply(QVariantMap{{"messages",transcript},{"before",0},{"hasMore",false}});}
                    else if(method=="settings.update"||method=="session.create"){} // Left unanswered: their outcome stays unknown.
                    else reply(true);
                }
            });
        });
        const auto previousRuntime=qgetenv("CERE_RUNTIME_DIR");
        const auto restoreRuntime=qScopeGuard([&]{qputenv("CERE_RUNTIME_DIR",previousRuntime);});
        qputenv("CERE_RUNTIME_DIR",runtime.path().toUtf8());
        Controller fake(CERE_SOURCE_DIR,true);QSignalSpy results(&fake,&Controller::result);
        fake.start(false);
        QTRY_VERIFY(fake.connected());QTRY_COMPARE(fake.selectedId(),QString("fake-a"));QTRY_COMPARE(fake.messages().size(),2);
        auto textOf=[&](const QString &id){for(const auto &m:fake.messages())if(m.toMap().value("id").toString()==id)return m.toMap().value("text").toString();return QString();};
        // A partially streamed reply arrives live.
        notify(message("m2","assistant","The plan has three",3));QTRY_COMPARE(textOf("m2"),QString("The plan has three"));
        // The real personality editor, bound to this controller, saves with the reply pending.
        QQuickView view;view.rootContext()->setContextProperty("App",&fake);
        view.setSource(QUrl::fromLocalFile(QString(CERE_SOURCE_DIR)+"/qml/PersonalitySettings.qml"));QCOMPARE(view.status(),QQuickView::Ready);
        view.resize(520,640);view.show();
        auto editor=view.rootObject()->findChild<QQuickItem*>("personalityText"),save=view.rootObject()->findChild<QQuickItem*>("personalitySave");
        QVERIFY(editor&&save);QTRY_COMPARE(editor->property("text").toString(),QString("Old voice"));
        editor->setProperty("text","A new unsaved voice");QTRY_VERIFY(save->isEnabled());
        QVERIFY(QMetaObject::invokeMethod(save,"clicked"));
        const int saving=view.rootObject()->property("requestId").toInt();QVERIFY(saving>0);QVERIFY(editor->property("readOnly").toBool());
        const int creating=fake.rpc("session.create",{{"provider","codex"},{"cwd","/tmp"}});QVERIFY(creating>0);
        QTRY_VERIFY(received.contains("settings.update")&&received.contains("session.create"));
        // While disconnected, the stored transcript moves on.
        client->disconnectFromServer();QTRY_VERIFY(!fake.connected());
        transcript={message("m1","user","Explain the plan.",1),message("m2","assistant","The plan has three steps.",5),message("m3","assistant","Step one is done",6)};
        auto outcomes=[&](int id){int n=0;for(const auto &r:results)if(r.at(0).toInt()==id)++n;return n;};
        QTRY_COMPARE(outcomes(saving),1);QTRY_COMPARE(outcomes(creating),1);
        for(const auto &r:results)if(r.at(0).toInt()==saving||r.at(0).toInt()==creating)QCOMPARE(r.at(1).toMap().value("code").toString(),QString("CONNECTION_LOST"));
        QTRY_COMPARE(view.rootObject()->property("requestId").toInt(),-1);
        QVERIFY(!editor->property("readOnly").toBool());QCOMPARE(editor->property("text").toString(),QString("A new unsaved voice"));
        QVERIFY(!view.rootObject()->property("error").toString().isEmpty());
        // Live events racing the recovery page: a newer revision and a new message must survive it.
        beforePage=[&]{notify(message("m3","assistant","Step one is done; step two is running",9));notify(message("m4","assistant","A newer message",10));};
        const int saves=received.count("settings.update"),creates=received.count("session.create");
        QTRY_VERIFY_WITH_TIMEOUT(fake.connected(),6000);
        QTRY_COMPARE(textOf("m2"),QString("The plan has three steps."));
        QTRY_COMPARE(textOf("m3"),QString("Step one is done; step two is running"));QTRY_COMPARE(textOf("m4"),QString("A newer message"));
        QCOMPARE(fake.selectedId(),QString("fake-a"));
        QTest::qWait(300);
        QCOMPARE(received.count("settings.update"),saves);QCOMPARE(received.count("session.create"),creates); // Nothing is replayed.
        QCOMPARE(outcomes(saving),1);QCOMPARE(outcomes(creating),1);
        view.hide();
    }
private:
    // ---- UI/UX review scenarios: evidence for docs/ui-review/REVIEW.md ----
    QJsonArray reviewNotes;
    QString longSession,richMessageId;
    void note(const QString &check,bool ok,const QString &detail=QString()){
        reviewNotes.append(QJsonObject{{"check",check},{"ok",ok},{"detail",detail}});
        qInfo().noquote()<<(ok?"REVIEW ok  ":"REVIEW FAIL")<<check<<(detail.isEmpty()?"":"· "+detail);
    }
    void saveNotes(const QString &name){QDir().mkpath("/tmp/cere-ui-evidence");QFile f("/tmp/cere-ui-evidence/"+name+".json");if(f.open(QIODevice::WriteOnly))f.write(QJsonDocument(reviewNotes).toJson());reviewNotes=QJsonArray();}
    bool waitFor(const std::function<bool()> &condition,int timeout=5000){QElapsedTimer clock;clock.start();while(!condition()){if(clock.elapsed()>timeout)return false;QTest::qWait(20);}return true;}
    QString focusName(){
        auto focused=window?window->activeFocusItem():nullptr;if(!focused)return "none";
        QString name=focused->objectName();for(auto p=focused->parentItem();name.isEmpty()&&p;p=p->parentItem())name=p->objectName();
        return QString(focused->metaObject()->className()).section('_',0,0)+":"+name;
    }
    // The message whose part is at the top edge of the conversation (the gap between cards is skipped).
    QString topMessageId(){
        auto list=item("messageList");if(!list)return QString();
        int index=-1;
        for(const double probe:{1.,list->property("spacing").toDouble()+2.}){
            QMetaObject::invokeMethod(list,"indexAt",Q_RETURN_ARG(int,index),Q_ARG(double,list->width()/2),Q_ARG(double,list->property("contentY").toDouble()+probe));
            if(index>=0)break;
        }
        if(index<0)return QString();
        return app->transcript()->data(app->transcript()->index(index,0),Qt::UserRole+1).toMap().value("id").toString();
    }
    QQuickWindow *reviewCompact(){app->closePanel();app->togglePanel();QQuickWindow *panel=nullptr;waitFor([&]{return (panel=titled("Cere Panel"))!=nullptr;},8000);window=panel;QTest::qWait(150);return panel;}
    QQuickWindow *reviewWorkspace(){window=nullptr;app->expand();QQuickWindow *w=nullptr;waitFor([&]{return (w=titled("Cere"))!=nullptr;},8000);window=w;QTest::qWait(150);return w;}
    QString createSession(const QString &provider,const QString &title,const QString &model=QString()){
        QVariantMap params{{"provider",provider},{"cwd",data.path()},{"trusted",true},{"title",title}};
        if(!model.isEmpty())params["model"]=model;
        const auto created=call("session.create",params);
        if(created.contains("error"))note("create session "+title.left(30),false,created.value("error").toString());
        return created.value("id").toString();
    }
    QStringList visibleWindows(){QStringList names;for(auto w:qGuiApp->allWindows())if(w->isVisible()&&(w->title()=="Cere"||w->title()=="Cere Panel"||w->title()=="Cere Approval"))names<<w->title();names.sort();return names;}
private slots:
    void reviewEmptyStates(){
        note("fresh state has no sessions",app->state().value("sessions").toList().isEmpty(),QString::number(app->state().value("sessions").toList().size()));
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true},{"roaming",false}});QTest::qWait(300);
        reviewWorkspace();window->resize(1040,780);QTest::qWait(250);capture("review-empty-workspace-chat");
        click("tab_Sessions");QTest::qWait(200);capture("review-empty-workspace-sessions");
        click("tab_Desktop");QTest::qWait(700);capture("review-empty-workspace-desktop");
        click("tab_Chat");
        reviewCompact();QTest::qWait(200);capture("review-empty-compact-chat");
        note("compact initial focus",true,focusName());
        click("tab_Sessions");QTest::qWait(200);capture("review-empty-compact-sessions");
        click("tab_Chat");
        // Ollama unreachable: the new-session dialog has no models to offer.
        const auto ollama=app->state().value("settings").toMap().value("ollama").toMap();
        call("settings.update",{{"ollama",QVariantMap{{"host","http://127.0.0.1:9"}}}});
        auto dialog=window->contentItem()->findChild<QObject*>("createSessionDialog");
        if(dialog){
            QMetaObject::invokeMethod(dialog,"open");QTest::qWait(200);
            if(auto provider=item("sessionProvider")){provider->setProperty("currentIndex",2);QMetaObject::invokeMethod(provider,"activated",Q_ARG(int,2));}
            QTest::qWait(2000);capture("review-empty-compact-new-session-ollama-unreachable");
            note("ollama unreachable error shown",item("newSessionError")!=nullptr,item("newSessionError")?item("newSessionError")->property("text").toString():"no error text");
            QMetaObject::invokeMethod(dialog,"close");
        }else note("createSessionDialog found",false);
        // The broker refuses a default model until the restored host's catalog has refreshed.
        call("settings.update",{{"ollama",QVariantMap{{"host",ollama.value("host")}}}});
        call("provider.models",{{"provider","ollama"}});
        if(!ollama.value("model").toString().isEmpty())
            note("ollama model restored",!call("settings.update",{{"ollama",QVariantMap{{"model",ollama.value("model")}}}}).contains("error"));
        note("ollama host restored",app->state().value("settings").toMap().value("ollama").toMap().value("host")==ollama.value("host"));
        reviewWorkspace();saveNotes("review-empty-states");
    }
    void reviewLongContent(){
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true},{"webSearch",QVariantMap{{"enabled",true}}}});
        reviewWorkspace();click("tab_Chat");
        longSession=createSession("ollama","Long conversation · "+QString(80,'x'),"fixture-chat:latest");
        if(longSession.isEmpty()){saveNotes("review-long-content");return;}
        QElapsedTimer clock;clock.start();int turns=0;
        for(;turns<110&&clock.elapsed()<150000;++turns){
            const auto sent=call("session.send",{{"id",longSession},{"text",QString("Turn %1: ").arg(turns+1)+QString("Please keep the explanation short. ").repeated(1+turns%4)}});
            if(sent.contains("error")){note("long session send",false,sent.value("error").toString());break;}
            if(!waitFor([&]{return app->session().value("status").toString()=="idle";},8000)){note("long session turn idle",false,QString::number(turns));break;}
        }
        note("200+ messages created",app->messages().size()>=200,QString("messages=%1 turns=%2 ms=%3").arg(app->messages().size()).arg(turns).arg(clock.elapsed()));
        const auto other=createSession("codex","Rich reply");
        app->select(longSession);waitFor([&]{return app->messages().size()>=100;},8000);QTest::qWait(500);
        note("transcript loaded after reselect",app->messages().size()>=200,QString("messages=%1 hasOlder=%2").arg(app->messages().size()).arg(app->hasOlderMessages()));
        capture("review-long-session-workspace");
        reviewCompact();waitFor([&]{return item("messageList")!=nullptr;});QTest::qWait(400);capture("review-long-session-compact");
        reviewWorkspace();
        QImage picture(320,180,QImage::Format_ARGB32);picture.fill(QColor("#49dfff"));const auto imagePath=data.path()+"/review-image.png";picture.save(imagePath);
        app->select(other);waitFor([&]{return app->selectedId()==other;});
        call("session.send",{{"id",other},{"text","completion-rich:"+imagePath}});
        waitFor([&]{return app->session().value("status").toString()=="idle"&&app->messages().size()>=2;},10000);QTest::qWait(500);
        for(const auto &m:app->messages())if(m.toMap().value("role")=="assistant"&&m.toMap().value("text").toString().contains("Review fixture"))richMessageId=m.toMap().value("id").toString();
        note("rich reply persisted",!richMessageId.isEmpty());
        QStringList wideProse; // F-10: prose wraps within the visible width; only code and tables may reach past it
        auto inspect=[&](const QString &label){
            auto viewport=item("messageViewport_"+richMessageId),body=item("messageBody_"+richMessageId);
            if(!viewport||!body){note(label+" rich message visible",false);wideProse<<label+" missing";return;}
            const double content=viewport->property("contentWidth").toDouble();
            auto document=body->property("textDocument").value<QQuickTextDocument*>()->textDocument();
            double widestProse=0;int proseBlocks=0;
            for(auto block=document->begin();block.isValid();block=block.next()){
                const auto format=block.blockFormat();
                if(format.hasProperty(QTextFormat::BlockCodeFence)||format.hasProperty(QTextFormat::BlockCodeLanguage)||QTextCursor(block).currentTable()||!block.layout())continue;
                const auto rect=document->documentLayout()->blockBoundingRect(block);++proseBlocks;
                // An empty line has no extent, wherever Qt places it.
                for(int i=0;i<block.layout()->lineCount();++i){const auto line=block.layout()->lineAt(i);if(line.naturalTextWidth()>0)widestProse=std::max(widestProse,rect.x()+line.x()+line.naturalTextWidth());}
            }
            const bool fits=proseBlocks>0&&widestProse<=viewport->width()+1;
            note(label+" rich message width",fits,QString("viewport=%1 content=%2 body=%3 overflow=%4 widestProse=%5 proseBlocks=%6").arg(viewport->width()).arg(content).arg(body->width()).arg(content>viewport->width()+1).arg(widestProse).arg(proseBlocks));
            if(!fits)wideProse<<QString("%1 prose %2 > %3").arg(label).arg(widestProse).arg(viewport->width());
        };
        window->resize(1040,780);QTest::qWait(400);inspect("workspace 1040");capture("review-rich-reply-workspace-1040");
        window->resize(720,580);QTest::qWait(500);inspect("workspace 720");capture("review-rich-reply-workspace-720");
        window->resize(1040,780);QTest::qWait(300);
        reviewCompact();waitFor([&]{return item("messageBody_"+richMessageId)!=nullptr;});QTest::qWait(400);inspect("compact 440");capture("review-rich-reply-compact");
        reviewWorkspace();saveNotes("review-long-content");
        if(!richMessageId.isEmpty())QVERIFY2(wideProse.isEmpty(),qPrintable(wideProse.join("; ")));
    }
    void reviewApprovalsAndKeyboard(){
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true}});
        reviewWorkspace();click("tab_Chat");
        QStringList sessions;for(int i=0;i<3;++i)sessions<<createSession("codex",QString("Approval requester %1 · ").arg(i+1)+QString(60,'y'));
        auto requests=[&]{return app->state().value("approvals").toList();};
        for(const auto &id:sessions)call("session.send",{{"id",id},{"text","multiple"}});
        waitFor([&]{return requests().size()>=6;},10000);
        note("six pending approvals",requests().size()==6,QString::number(requests().size()));
        app->select(sessions.first());QTest::qWait(500);
        window->resize(1040,780);QTest::qWait(300);capture("review-approvals-workspace");
        if(!requests().isEmpty())note("workspace shows the last requester",count("approvalRequester_"+requests().last().toMap().value("id").toString())==1);
        reviewCompact();QTest::qWait(400);capture("review-approvals-compact");
        auto composer=item("composer");if(composer)composer->forceActiveFocus();
        QStringList chain;const QString first=focusName();
        for(int i=0;i<60;++i){QTest::keyClick(window,Qt::Key_Tab);QTest::qWait(15);const auto name=focusName();chain<<name;if(name==first&&i>2)break;}
        note("compact tab chain from composer",true,first+" > "+chain.join(" > "));
        note("composer text after Tab",composer&&composer->property("text").toString().isEmpty(),composer?composer->property("text").toString():"missing");
        // F-05: Tab leaves the composer at once, inserts nothing, and comes back around (no trap).
        QVERIFY2(composer&&composer->property("text").toString().isEmpty(),"Tab inserted text into the composer");
        QVERIFY2(!chain.isEmpty()&&chain.first()!=first,qPrintable("Tab stayed in "+first));
        QVERIFY2(chain.contains(first),qPrintable("Tab never returned to the composer: "+chain.join(" > ")));
        composer->forceActiveFocus();QTest::keyClick(window,Qt::Key_Backtab);QTest::qWait(15);
        QVERIFY2(focusName()!=first&&composer->property("text").toString().isEmpty(),qPrintable("Shift+Tab stayed in the composer: "+focusName()));
        if(composer)composer->setProperty("text","");
        if(!requests().isEmpty()){
            const auto allowId=requests().first().toMap().value("id").toString();
            if(auto allow=item("approval_"+allowId+"_allow")){
                allow->forceActiveFocus();QTest::qWait(50);
                const int before=requests().size();
                QTest::keyClick(window,Qt::Key_Return);QTest::qWait(600);
                note("Enter on focused Allow does not approve",requests().size()==before,QString("before=%1 after=%2").arg(before).arg(requests().size()));
                const int afterEnter=requests().size();
                QTest::keyClick(window,Qt::Key_Space);
                note("Space on focused Allow approves",waitFor([&]{return requests().size()==afterEnter-1;},4000));
            }else note("allow button present in compact",false);
        }
        app->closePanel();QQuickWindow *bubble=nullptr;waitFor([&]{return (bubble=titled("Cere Approval"))!=nullptr;},5000);
        if(bubble){
            window=bubble;QTest::qWait(500);capture("review-approvals-bubble");
            note("bubble has no default-focused control",!bubble->activeFocusItem()||bubble->activeFocusItem()==bubble->contentItem(),focusName());
            note("bubble leaves the keyboard alone",!bubble->isActive());
            QTest::keyClick(window,Qt::Key_Tab);QTest::qWait(30);note("bubble first Tab target",true,focusName());
            const int before=requests().size();QTest::keyClick(window,Qt::Key_Return);QTest::qWait(500);
            note("Enter in bubble does not approve",requests().size()==before,focusName());
        }else note("bubble appeared",false);
        reviewWorkspace();
        app->select(sessions[1]);QTest::qWait(400);
        composer=item("composer");if(composer){composer->setProperty("text","Escape keeps this draft");composer->forceActiveFocus();}
        click("renameSession");QTest::qWait(150);note("rename dialog open",item("renameSessionTitle")!=nullptr);
        QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(200);
        note("Escape closes the dialog only",item("renameSessionTitle")==nullptr&&window->isVisible());
        click("tab_Settings");QTest::qWait(150);QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(200);
        note("Escape on Settings returns to Chat",item("composer")!=nullptr);
        call("session.send",{{"id",sessions[1]},{"text","acting"}});waitFor([&]{return app->session().value("status").toString()=="working";},4000);
        if(auto c=item("composer"))c->forceActiveFocus();
        QTest::keyClick(window,Qt::Key_Escape);QTest::qWait(300);
        note("Escape on Chat hides the window",!window->isVisible());
        note("Escape does not stop the running turn",app->session().value("status").toString()=="working",app->session().value("status").toString());
        reviewWorkspace();
        note("draft survives Escape",item("composer")&&item("composer")->property("text").toString()=="Escape keeps this draft",item("composer")?item("composer")->property("text").toString():"missing");
        waitFor([&]{return app->session().value("status").toString()=="idle";},8000);
        if(auto c=item("composer"))c->setProperty("text","");
        reviewCompact();QTest::qWait(300);capture("review-long-title-compact");
        if(auto title=item("chatView")){Q_UNUSED(title);}
        reviewWorkspace();
        for(const auto &r:requests())call("approval.answer",{{"id",r.toMap().value("id")},{"choice","deny"}});
        waitFor([&]{return requests().isEmpty();},8000);
        saveNotes("review-approvals-keyboard");
    }
    void reviewTransitions(){
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true},{"webSearch",QVariantMap{{"enabled",true}}}});
        reviewWorkspace();click("tab_Chat");
        if(longSession.isEmpty())longSession=createSession("ollama","Transition session","fixture-chat:latest");
        const auto approvalSession=createSession("codex","Approval during transitions");
        call("session.send",{{"id",approvalSession},{"text","approval"}});waitFor([&]{return !app->state().value("approvals").toList().isEmpty();},8000);
        app->select(longSession);waitFor([&]{return app->messages().size()>=2;},8000);QTest::qWait(500);
        const QString text="Draft kept across surfaces";
        auto composer=item("composer");if(!composer){note("composer present",false);saveNotes("review-transitions");return;}
        composer->setProperty("text",text);composer->forceActiveFocus();
        QMetaObject::invokeMethod(composer,"select",Q_ARG(int,6),Q_ARG(int,10));
        const auto path=data.path()+"/transition-note.txt";{QFile f(path);f.open(QIODevice::WriteOnly);f.write("kept");}
        app->attachImage(path);note("attachment imported",waitFor([&]{return item("chatView")&&item("chatView")->property("attachments").toList().size()==1;},5000));
        if(auto web=item("searchThisTurn"))web->setProperty("checked",true);else note("web toggle visible",false);
        if(auto list=item("messageList")){
            // Flick back to the middle of the conversation, as a reader would.
            const double target=list->property("originY").toDouble()+std::max(0.,list->property("contentHeight").toDouble()-list->height())*0.5;
            for(int i=0;i<80&&list->property("contentY").toDouble()>target;++i){QMetaObject::invokeMethod(list,"flick",Q_ARG(double,0.),Q_ARG(double,5000.));QTest::qWait(100);}
            QMetaObject::invokeMethod(list,"cancelFlick");QTest::qWait(500);
            note("reading earlier messages",!item("chatView")->property("follow").toBool(),QString("contentY=%1 target=%2").arg(list->property("contentY").toDouble()).arg(target));
        }
        QString anchor=topMessageId();for(int i=0;i<10&&anchor.isEmpty();++i){QTest::qWait(100);anchor=topMessageId();}
        note("scroll anchor recorded",!anchor.isEmpty(),anchor);
        QTest::qWait(900); // let the debounced draft save finish before the first transition
        QStringList lost; // F-01 regression: every switch keeps the composer and the reading position
        auto snapshot=[&](const QString &surface,int cycle){
            auto c=item("composer"),chat=item("chatView"),web=item("searchThisTurn");
            const auto approvals=app->state().value("approvals").toList();
            const QString top=topMessageId();
            QJsonObject s{{"surface",surface},{"cycle",cycle},{"text",c?c->property("text").toString():"missing"},
                {"cursor",c?c->property("cursorPosition").toInt():-1},{"selectionStart",c?c->property("selectionStart").toInt():-1},{"selectionEnd",c?c->property("selectionEnd").toInt():-1},
                {"attachments",chat?int(chat->property("attachments").toList().size()):-1},{"web",web?web->property("checked").toBool():false},{"webVisible",web!=nullptr},
                {"topMessage",top},{"anchorKept",top==anchor},{"focus",focusName()},
                {"approvalCards",approvals.isEmpty()?-1:count("approvalRequester_"+approvals.first().toMap().value("id").toString())},
                {"bubbleVisible",titled("Cere Approval")!=nullptr},{"windows",visibleWindows().join("+")},{"status",app->session().value("status").toString()}};
            reviewNotes.append(s);qInfo().noquote()<<"REVIEW transition"<<QJsonDocument(s).toJson(QJsonDocument::Compact);
            if(cycle>0){
                QStringList fields;
                if(s["text"].toString()!=text)fields<<"text";
                if(s["cursor"].toInt()!=10||s["selectionStart"].toInt()!=6||s["selectionEnd"].toInt()!=10)fields<<"cursor/selection";
                if(s["attachments"].toInt()!=1)fields<<"attachments";
                if(!s["web"].toBool())fields<<"Search web";
                if(!s["anchorKept"].toBool())fields<<"top message "+s["topMessage"].toString();
                // Cycle 7 leaves the compact panel on Sessions, so the workspace has no editor to return to.
                if(!(cycle==7&&surface=="workspace")&&s["focus"].toString()!="TextArea:composer")fields<<"focus "+s["focus"].toString();
                if(s["windows"].toString().contains('+'))fields<<"windows "+s["windows"].toString();
                if(!fields.isEmpty())lost<<QString("%1 %2: %3").arg(surface).arg(cycle).arg(fields.join(", "));
            }
        };
        snapshot("workspace-initial",0);
        auto loaded=[&]{auto c=item("composer");return c&&c->property("text").toString()==text;};
        for(int cycle=1;cycle<=10;++cycle){
            reviewCompact();waitFor(loaded,3000);QTest::qWait(300);
            if(cycle==1)capture("review-transition-compact");
            snapshot("compact",cycle);
            if(cycle==7){
                click("tab_Sessions");QTest::qWait(200);
                if(auto row=item("session_"+longSession)){QTest::mouseClick(window,Qt::RightButton,Qt::NoModifier,row->mapToScene(QPointF(row->width()/2,row->height()/2)).toPoint());QTest::qWait(200);auto menu=window->contentItem()->findChild<QObject*>("sessionContextMenu");note("session menu open before expand",menu&&menu->property("visible").toBool());}
                else note("session row found for menu",false);
            }
            reviewWorkspace();waitFor(loaded,3000);QTest::qWait(300);
            if(cycle==1)capture("review-transition-workspace");
            snapshot("workspace",cycle);
        }
        note("transition cycles complete",lost.isEmpty(),lost.join("; "));
        if(auto c=item("composer"))c->setProperty("text","");
        if(auto chat=item("chatView"))chat->setProperty("attachments",QVariantList{});
        QTest::qWait(900);
        // Mid-stream: a reply is streaming, the user types the next message, then switches surfaces twice.
        const auto streamSession=createSession("codex","Streaming during transitions");
        call("session.send",{{"id",streamSession},{"text","activity"}});waitFor([&]{return app->activityCount()>=3;},8000);
        app->select(streamSession);QTest::qWait(400);
        if(auto toggle=item("activityToggle")){QMetaObject::invokeMethod(toggle,"clicked");QTest::qWait(200);}
        note("activity panel expanded before transition",item("activityPanel")&&item("activityPanel")->property("expanded").toBool());
        call("session.send",{{"id",streamSession},{"text","acting"}});waitFor([&]{return app->session().value("status").toString()=="working";},4000);
        if(auto c=item("composer")){c->setProperty("text","typed while streaming");c->forceActiveFocus();}
        QTest::qWait(700);
        auto streamSnapshot=[&](const QString &surface){
            auto c=item("composer"),panel=item("activityPanel");
            QJsonObject s{{"surface",surface},{"cycle",-1},{"text",c?c->property("text").toString():"missing"},{"status",app->session().value("status").toString()},{"stopVisible",item("stopMessage")!=nullptr},{"activityExpanded",panel?panel->property("expanded").toBool():false},{"focus",focusName()},{"windows",visibleWindows().join("+")}};
            reviewNotes.append(s);qInfo().noquote()<<"REVIEW streaming transition"<<QJsonDocument(s).toJson(QJsonDocument::Compact);
        };
        auto streaming=[&](const QString &surface){
            auto c=item("composer"),panel=item("activityPanel");
            if(!c||c->property("text").toString()!="typed while streaming"||!panel||!panel->property("expanded").toBool()||!item("stopMessage"))lost<<"mid-stream "+surface;
        };
        reviewCompact();waitFor([&]{auto c=item("composer");return c&&c->property("text").toString()=="typed while streaming";},3000);QTest::qWait(200);streamSnapshot("compact");streaming("compact");capture("review-streaming-transition-compact");
        reviewWorkspace();waitFor([&]{auto c=item("composer");return c&&c->property("text").toString()=="typed while streaming";},3000);QTest::qWait(200);streamSnapshot("workspace");streaming("workspace");capture("review-streaming-transition-workspace");
        waitFor([&]{return app->session().value("status").toString()=="idle";},10000);
        if(auto c=item("composer"))c->setProperty("text","");
        for(const auto &r:app->state().value("approvals").toList())call("approval.answer",{{"id",r.toMap().value("id")},{"choice","deny"}});
        saveNotes("review-transitions");
        QVERIFY2(lost.isEmpty(),qPrintable(lost.join("; ")));
    }
    void reviewResponsiveness(){
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true}});
        reviewWorkspace();click("tab_Chat");
        if(longSession.isEmpty()){note("long session available",false);saveNotes("review-responsiveness");return;}
        app->select(longSession);waitFor([&]{return app->messages().size()>=100;},8000);QTest::qWait(600);
        QMutex guard;QVector<qint64> frames;QElapsedTimer clock;clock.start();
        const auto connection=connect(window,&QQuickWindow::frameSwapped,this,[&]{QMutexLocker lock(&guard);frames.append(clock.nsecsElapsed()/1000);},Qt::DirectConnection);
        auto stats=[&](const QString &phase,qint64 fromUs,qint64 toUs){
            QVector<qint64> gaps;qint64 previous=-1;{QMutexLocker lock(&guard);for(auto t:frames){if(t<fromUs||t>toUs)continue;if(previous>=0)gaps.append(t-previous);previous=t;}}
            std::sort(gaps.begin(),gaps.end());
            auto pct=[&](double p)->double{return gaps.isEmpty()?0.:gaps[std::min(gaps.size()-1,qsizetype(p*gaps.size()))]/1000.;};
            int slow=0;for(auto g:gaps)if(g>33000)++slow;
            QJsonObject s{{"phase",phase},{"frames",qint64(gaps.size()+1)},{"p50ms",pct(.5)},{"p95ms",pct(.95)},{"maxms",gaps.isEmpty()?0.:gaps.last()/1000.},{"over33ms",slow},{"durationMs",(toUs-fromUs)/1000.}};
            reviewNotes.append(s);qInfo().noquote()<<"REVIEW frames"<<QJsonDocument(s).toJson(QJsonDocument::Compact);
        };
        auto model=static_cast<TranscriptModel*>(static_cast<QSortFilterProxyModel*>(app->transcript())->sourceModel());
        auto last=app->messages().last().toMap();QString text;
        const qint64 streamStart=clock.nsecsElapsed()/1000;
        for(int i=0;i<200;++i){text+="Streaming token group "+QString::number(i)+(i%9==8?"\n\n":" ");last["text"]=text;last["revision"]=QString::number(100000+i);model->upsert(last);QTest::qWait(16);}
        QTest::qWait(120);stats("streaming-200-revisions",streamStart,clock.nsecsElapsed()/1000);
        auto list=item("messageList");
        if(list){
            const double height=list->property("contentHeight").toDouble();
            const qint64 scrollStart=clock.nsecsElapsed()/1000;
            for(int i=0;i<=120;++i){list->setProperty("contentY",std::max(0.,height-list->height())*(1-i/120.));QTest::qWait(16);}
            QTest::qWait(120);stats("scrolling-120-steps",scrollStart,clock.nsecsElapsed()/1000);
            const qint64 flickStart=clock.nsecsElapsed()/1000;QMetaObject::invokeMethod(list,"flick",Q_ARG(double,0.),Q_ARG(double,-6000.));QTest::qWait(1500);stats("flick-to-end",flickStart,clock.nsecsElapsed()/1000);
        }else note("message list present",false);
        const qint64 resizeStart=clock.nsecsElapsed()/1000;
        for(int i=0;i<=40;++i){window->resize(720+i*20,580+i*10);QTest::qWait(25);}
        QTest::qWait(200);stats("resizing-40-steps",resizeStart,clock.nsecsElapsed()/1000);
        window->resize(1040,780);QTest::qWait(400);
        auto composer=item("composer");QVector<double> latency;
        if(composer){
            composer->setProperty("text","");composer->forceActiveFocus();
            for(int i=0;i<30;++i){
                const qint64 t0=clock.nsecsElapsed()/1000;QTest::keyClick(window,'a'+(i%26));
                qint64 next=-1;QElapsedTimer wait;wait.start();
                while(next<0&&wait.elapsed()<500){QTest::qWait(1);QMutexLocker lock(&guard);for(auto it=frames.crbegin();it!=frames.crend();++it){if(*it<=t0)break;next=*it;}}
                if(next>0)latency.append((next-t0)/1000.);QTest::qWait(30);
            }
            composer->setProperty("text","");
        }
        std::sort(latency.begin(),latency.end());
        QJsonObject l{{"phase","key-to-frame"},{"samples",qint64(latency.size())},{"p50ms",latency.isEmpty()?0.:latency[latency.size()/2]},{"p95ms",latency.isEmpty()?0.:latency[std::min(latency.size()-1,qsizetype(.95*latency.size()))]},{"maxms",latency.isEmpty()?0.:latency.last()}};
        reviewNotes.append(l);qInfo().noquote()<<"REVIEW latency"<<QJsonDocument(l).toJson(QJsonDocument::Compact);
        disconnect(connection);
        app->select(QString());app->select(longSession); // discard the synthetic revisions by reloading the stored transcript
        saveNotes("review-responsiveness");
    }
    void reviewAccessibilityInventory(){
        QAccessible::setActive(true);
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true}});
        reviewWorkspace();click("tab_Chat");
        if(!longSession.isEmpty()){app->select(longSession);QTest::qWait(500);}
        auto inventory=[&](const QString &surface){
            QJsonArray rows;int small=0,unnamed=0,total=0;
            std::function<void(QQuickItem*)> walk=[&](QQuickItem *node){
                if(!node->isVisible()||node->width()<=0)return;
                const QByteArray type=node->metaObject()->className();
                const bool control=type.startsWith("CButton_")||type.startsWith("CActionRow_")||type.startsWith("CField_")||type.startsWith("CComboBox_")||type.startsWith("CSpinBox_")||type.startsWith("CCheckBox_")||type.startsWith("CSlider_")||type.startsWith("CScrollBar_")||type.startsWith("CerePortrait_")||type.startsWith("VoiceInput_")||type.startsWith("QQuickTextArea")||type.startsWith("QQuickTextField")||type.startsWith("QQuickScrollBar")||type.startsWith("QQuickCheckBox")||type.startsWith("QQuickButton")||type.startsWith("QQuickSlider")||type.startsWith("QQuickSpinBox")||type.startsWith("QQuickComboBox");
                if(control){
                    ++total;QString name;int role=0;
                    if(auto iface=QAccessible::queryAccessibleInterface(node)){
                        name=iface->text(QAccessible::Name);role=int(iface->role());
                        // Qt drops the name of password fields; screen readers announce their description instead.
                        if(name.isEmpty()&&iface->state().passwordEdit)name=iface->text(QAccessible::Description);
                    }
                    const bool tiny=node->width()<24||node->height()<24;if(tiny)++small;if(name.trimmed().isEmpty())++unnamed;
                    rows.append(QJsonObject{{"type",QString(type).section('_',0,0)},{"objectName",node->objectName()},{"name",name},{"role",role},{"w",node->width()},{"h",node->height()},{"focusable",node->activeFocusOnTab()},{"tiny",tiny}});
                    if(!type.startsWith("QQuickScrollBar")&&!type.startsWith("CScrollBar_"))return; // inner labels are not separate targets
                }
                for(auto child:node->childItems())walk(child);
            };
            walk(window->contentItem());
            QJsonObject s{{"surface",surface},{"controls",total},{"unnamed",unnamed},{"under24px",small},{"rows",rows}};
            reviewNotes.append(s);qInfo().noquote()<<"REVIEW a11y"<<surface<<"controls"<<total<<"unnamed"<<unnamed<<"under24"<<small;
        };
        inventory("workspace-chat");click("tab_Desktop");QTest::qWait(600);inventory("workspace-desktop");click("tab_Settings");QTest::qWait(300);inventory("workspace-settings");click("tab_Sessions");QTest::qWait(300);inventory("workspace-sessions");click("tab_Chat");
        reviewCompact();QTest::qWait(300);inventory("compact-chat");click("tab_Desktop");QTest::qWait(600);inventory("compact-desktop");click("tab_Chat");
        reviewWorkspace();
        // F-08 and F-18: every control, including scroll bars and API key fields, has an accessible name.
        QStringList unnamed;for(const auto &value:reviewNotes){const auto s=value.toObject();if(s["unnamed"].toInt()>0)for(const auto &row:s["rows"].toArray())if(row.toObject()["name"].toString().trimmed().isEmpty())unnamed<<s["surface"].toString()+":"+row.toObject()["type"].toString()+":"+row.toObject()["objectName"].toString();}
        saveNotes("review-accessibility");
        QVERIFY2(unnamed.isEmpty(),qPrintable(unnamed.join(", ")));
    }
    void reviewLiveOutputs(){
        if(!qGuiApp->platformName().startsWith("wayland"))QSKIP("Layer-shell surfaces need the live compositor");
        app->closePanel();
        app->rpc("settings.update",{{"topmost",true},{"hidden",false},{"roaming",false},{"quiet",true},{"reducedMotion",true}});QTest::qWait(1000);
        const auto session=createSession("codex","Layer surfaces");
        auto layerOn=[&](const QString &output,const QString &ns){
            QJsonArray found;const auto layers=hypr({"-j","layers"}).object();
            for(const auto level:layers.value(output).toObject().value("levels").toObject())for(const auto layer:level.toArray())if(layer.toObject().value("namespace").toString()==ns)found.append(layer);
            return found;
        };
        auto crop=[&](const QJsonObject &layer,const QString &file){
            if(layer.isEmpty())return;QProcess grim;grim.start("grim",{"-g",QString("%1,%2 %3x%4").arg(layer.value("x").toInt()-8).arg(layer.value("y").toInt()-8).arg(layer.value("w").toInt()+16).arg(layer.value("h").toInt()+16),"/tmp/cere-ui-evidence/"+file+".png"});grim.waitForFinished(5000);
        };
        for(auto screen:qGuiApp->screens()){
            app->rpc("settings.update",{{"position",QVariantMap{{"output",screen->name()},{"x",.9},{"y",.8}}}});QTest::qWait(700);
            app->rpc("ui.toggle");QTest::qWait(1500);
            const auto panels=layerOn(screen->name(),"cere-panel");
            note("compact layer on "+screen->name()+" scale "+QString::number(screen->devicePixelRatio()),!panels.isEmpty(),QJsonDocument(panels).toJson(QJsonDocument::Compact));
            if(!panels.isEmpty())crop(panels.last().toObject(),"review-live-compact-"+screen->name());
            app->rpc("ui.toggle");QTest::qWait(700);
        }
        call("session.send",{{"id",session},{"text","approval"}});waitFor([&]{return !app->state().value("approvals").toList().isEmpty();},8000);QTest::qWait(1500);
        const auto last=qGuiApp->screens().last();
        const auto bubbles=layerOn(last->name(),"cere-approval"),pets=layerOn(last->name(),"cere-pet");
        note("bubble layer beside pet on "+last->name(),!bubbles.isEmpty(),QJsonDocument(bubbles).toJson(QJsonDocument::Compact)+" pet "+QJsonDocument(pets).toJson(QJsonDocument::Compact));
        if(!bubbles.isEmpty()&&!pets.isEmpty()){
            const auto b=bubbles.last().toObject(),p=pets.last().toObject();
            const int x=std::min(b.value("x").toInt(),p.value("x").toInt()),y=std::min(b.value("y").toInt(),p.value("y").toInt());
            const int r=std::max(b.value("x").toInt()+b.value("w").toInt(),p.value("x").toInt()+p.value("w").toInt()),d=std::max(b.value("y").toInt()+b.value("h").toInt(),p.value("y").toInt()+p.value("h").toInt());
            crop(QJsonObject{{"x",x},{"y",y},{"w",r-x},{"h",d-y}},"review-live-bubble-"+last->name());
        }
        for(const auto &r:app->state().value("approvals").toList())call("approval.answer",{{"id",r.toMap().value("id")},{"choice","deny"}});
        app->rpc("settings.update",{{"topmost",false}});QTest::qWait(600);
        saveNotes("review-live-outputs");
    }
    void reviewSurfacesAtScale(){
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true}});
        QQuickWindow *original=window;QStringList unreachable,cramped;
        // Run on its own, the review still needs a conversation for the composer and its tools.
        const QString reviewed=longSession.isEmpty()?createSession("ollama","Scale review","fixture-chat:latest"):longSession;
        if(!reviewed.isEmpty()){app->select(reviewed);QTest::qWait(400);}
        for(auto screen:qGuiApp->screens()){
            const auto g=screen->availableGeometry();
            for(const QString file:{"Panel.qml","Workspace.qml"}){
                QQuickView view;view.setResizeMode(QQuickView::SizeRootObjectToView);view.rootContext()->setContextProperty("App",app.get());
                view.setScreen(screen);view.setSource(QUrl::fromLocalFile(QString(CERE_SOURCE_DIR)+"/qml/"+file));
                const QRect rect=file=="Panel.qml"?Placement::compactPanel(g,QPoint(g.right()-200,g.bottom()-220),QSize(192,208),QSize(440,860)):QRect(g.topLeft()+QPoint(40,40),QSize(std::min(1040,g.width()-80),std::min(780,g.height()-80)));
                view.setGeometry(rect);view.show();window=&view;QTest::qWait(500);
                const QString tag=QString("review-scale-%1-dpr%2-%3").arg(screen->name()).arg(screen->devicePixelRatio()).arg(file=="Panel.qml"?"compact":"workspace");
                capture(tag);
                int outside=0;std::function<void(QQuickItem*)> bounds=[&](QQuickItem *node){if(!node->isVisible())return;const QByteArray type=node->metaObject()->className();if(type.startsWith("CButton_")||type.startsWith("CField_")||type.startsWith("CComboBox_")||type.startsWith("CCheckBox_")){const auto p=node->mapToItem(view.rootObject(),QPointF());if(p.x()<-1||p.x()+node->width()>view.width()+1)++outside;}for(auto c:node->childItems())bounds(c);};
                bounds(view.rootObject());
                auto tools=item("conversationTools"),card=item("composerCard"),area=item("conversationArea"),page=item("chatPage"),more=item("conversationMore");
                const double toolsBottom=tools?tools->mapToScene(QPointF(0,tools->height())).y():-1,cardBottom=card?card->mapToScene(QPointF(0,card->height())).y():-1;
                // F-03: the tools are either in their row or behind More, and anything below the window scrolls into view.
                const double lowest=std::max(toolsBottom,cardBottom);
                const bool reachable=(tools||more)&&(lowest<=view.height()+1||(page&&page->property("interactive").toBool()));
                note(tag,outside==0&&reachable,QString("size=%1x%2 dpr=%3 controlsOutsideX=%4 toolsBottom=%5 composerBottom=%6 conversationHeight=%7 folded=%8 pageScrolls=%9").arg(view.width()).arg(view.height()).arg(view.devicePixelRatio()).arg(outside).arg(toolsBottom).arg(cardBottom).arg(area?area->height():-1).arg(more!=nullptr).arg(page&&page->property("interactive").toBool()));
                if(outside!=0||!reachable)unreachable<<tag;
                // F-11: at 860 px the compact panel keeps at least 420 px for the conversation.
                if(file=="Panel.qml"&&view.height()>=860&&(!area||area->height()<420))cramped<<QString("%1 (%2 px)").arg(tag).arg(area?area->height():0.);
                if(file=="Workspace.qml"){
                    // F-07: at the 720x520 minimum every control stays inside or scrolls into view.
                    view.resize(720,520);QTest::qWait(400);capture(tag+"-min");outside=0;bounds(view.rootObject());
                    auto minCard=item("composerCard"),minPage=item("chatPage");
                    const bool minReachable=minCard&&(minCard->mapToScene(QPointF(0,minCard->height())).y()<=view.height()+1||(minPage&&minPage->property("interactive").toBool()));
                    note(tag+"-min",outside==0&&minReachable,QString("controlsOutsideX=%1 composerReachable=%2").arg(outside).arg(minReachable));
                    if(outside!=0||!minReachable)unreachable<<tag+"-min";
                }
                view.hide();
            }
        }
        window=original;saveNotes("review-scales");
        QVERIFY2(unreachable.isEmpty(),qPrintable(unreachable.join(", ")));
        QVERIFY2(cramped.isEmpty(),qPrintable("Compact conversation below 420 px: "+cramped.join(", ")));
    }
    void reviewWorkflows(){
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true},{"webSearch",QVariantMap{{"enabled",true}}}});
        reviewWorkspace();click("tab_Chat");
        // Compose and send with an attachment and Web search on.
        const auto chatSession=createSession("ollama","Workflow · compose","fixture-chat:latest");
        app->select(chatSession);QTest::qWait(400);
        const auto noteFile=data.path()+"/workflow-note.txt";{QFile f(noteFile);f.open(QIODevice::WriteOnly);f.write("Workflow attachment");}
        app->attachImage(noteFile);note("workflow attachment imported",waitFor([&]{return item("chatView")&&item("chatView")->property("attachments").toList().size()==1;},5000));
        if(auto web=item("searchThisTurn"))web->setProperty("checked",true);
        if(auto c=item("composer")){c->setProperty("text","Send this with the attachment and web search");c->forceActiveFocus();}
        QTest::qWait(800);capture("review-workflow-compose-workspace");
        reviewCompact();waitFor([&]{auto c=item("composer");return c&&!c->property("text").toString().isEmpty();},3000);QTest::qWait(300);capture("review-workflow-compose-compact");
        const int before=app->messages().size();
        if(auto send=item("sendMessage")){note("send enabled with draft",send->isEnabled());QMetaObject::invokeMethod(send,"clicked");}else note("send button present",false);
        note("message sent from compact",waitFor([&]{return app->messages().size()>=before+2;},10000),QString::number(app->messages().size()));
        waitFor([&]{return app->session().value("status").toString()=="idle";},8000);QTest::qWait(300);
        note("composer cleared after send",item("composer")&&item("composer")->property("text").toString().isEmpty());
        note("attachments cleared after send",item("chatView")&&item("chatView")->property("attachments").toList().isEmpty());
        note("web toggle reset after send",!item("searchThisTurn")||!item("searchThisTurn")->property("checked").toBool());
        capture("review-workflow-sent-compact");
        // Attachment limits: eight files accepted, the ninth refused; a 19.5 MiB image accepted, a 21 MiB file refused.
        for(int i=0;i<9;++i){const auto path=data.path()+QString("/limit-%1.txt").arg(i);QFile f(path);f.open(QIODevice::WriteOnly);f.write("limit");f.close();app->attachImage(path);QTest::qWait(250);}
        waitFor([&]{return item("chatView")&&item("chatView")->property("attachments").toList().size()>=8;},8000);QTest::qWait(400);
        note("eight attachments accepted, ninth refused",item("chatView")&&item("chatView")->property("attachments").toList().size()==8,item("chatView")?QString("count=%1 error=%2").arg(item("chatView")->property("attachments").toList().size()).arg(item("chatView")->property("attachmentError").toString()):"missing");
        capture("review-workflow-attachment-limit-compact");
        if(auto chat=item("chatView"))chat->setProperty("attachments",QVariantList{});
        note("cleared attachments persisted",waitFor([&]{return app->session().value("draftAttachments").toList().isEmpty();},5000));
        QImage big(2200,2200,QImage::Format_ARGB32);{QRandomGenerator *rng=QRandomGenerator::global();for(int y=0;y<big.height();++y){auto line=reinterpret_cast<quint32*>(big.scanLine(y));for(int x=0;x<big.width();++x)line[x]=rng->generate()|0xff000000;}}
        const auto bigPath=data.path()+"/near-limit.png";big.save(bigPath);const qint64 bigSize=QFileInfo(bigPath).size();
        app->attachImage(bigPath);
        const bool bigAccepted=waitFor([&]{return item("chatView")&&item("chatView")->property("attachments").toList().size()==1;},15000);
        note("near-limit image attachment",bigAccepted==(bigSize<=20*1024*1024),QString("bytes=%1 accepted=%2 error=%3").arg(bigSize).arg(bigAccepted).arg(item("chatView")?item("chatView")->property("attachmentError").toString():""));
        const auto overPath=data.path()+"/over-limit.bin";{QFile f(overPath);f.open(QIODevice::WriteOnly);f.resize(21*1024*1024);}
        const int countBefore=item("chatView")?item("chatView")->property("attachments").toList().size():-1;
        app->attachImage(overPath);QTest::qWait(1500);
        note("over-limit file refused",item("chatView")&&item("chatView")->property("attachments").toList().size()==countBefore&&item("chatView")->property("attachmentError").toString().contains("20 MiB"),item("chatView")?item("chatView")->property("attachmentError").toString():"");
        capture("review-workflow-attachment-error-compact");
        if(auto chat=item("chatView"))chat->setProperty("attachments",QVariantList{});
        reviewWorkspace();
        // Stop mid-stream, then a provider error.
        const auto codexSession=createSession("codex","Workflow · stop and error");
        app->select(codexSession);QTest::qWait(300);
        call("session.send",{{"id",codexSession},{"text","acting"}});waitFor([&]{return app->session().value("status").toString()=="working";},4000);QTest::qWait(300);
        if(auto stop=item("stopMessage")){QMetaObject::invokeMethod(stop,"clicked");}else note("stop button visible while working",false);
        note("stop interrupts the turn",waitFor([&]{return app->session().value("status").toString()=="interrupted";},6000),app->session().value("status").toString());
        QTest::qWait(300);capture("review-workflow-interrupted-workspace");
        reviewCompact();QTest::qWait(300);capture("review-workflow-interrupted-compact");reviewWorkspace();
        call("session.send",{{"id",codexSession},{"text","acting-error"}});
        note("provider error state",waitFor([&]{return app->session().value("status").toString()=="error";},6000),app->session().value("status").toString()+" · "+app->session().value("error").toString());
        QTest::qWait(400);capture("review-workflow-error-workspace");
        reviewCompact();QTest::qWait(300);capture("review-workflow-error-compact");
        note("error banner in compact",!app->session().value("error").toString().isEmpty());
        // Handoff from the compact panel.
        tool("chatHandoff","menuHandoff");QTest::qWait(300);note("handoff dialog open",item("handoffCreate")!=nullptr);capture("review-workflow-handoff-compact");
        if(auto trust=item("handoffTrust")){trust->setProperty("checked",true);}
        if(auto create=item("handoffCreate")){note("handoff create enabled",create->isEnabled());const auto previous=app->selectedId();QMetaObject::invokeMethod(create,"clicked");
            note("handoff session created with draft",waitFor([&]{return app->selectedId()!=previous&&item("composer")&&item("composer")->property("text").toString().startsWith("Continue this work");},8000),item("composer")?item("composer")->property("text").toString().left(60):"");
            QTest::qWait(300);capture("review-workflow-handoff-draft-compact");
            if(auto c=item("composer"))c->setProperty("text","");}
        // Change a setting and run a desktop control from the compact panel.
        click("tab_Settings");QTest::qWait(300);
        if(auto scroll=item("settingsScroll")){if(auto control=item("motionIntensity")){scroll->setProperty("contentY",control->mapToItem(scroll,QPointF()).y()+scroll->property("contentY").toDouble()-120);QTest::qWait(150);}}
        capture("review-workflow-settings-compact");
        const bool reducedBefore=app->state().value("settings").toMap().value("reducedMotion").toBool();
        click("reducedMotion");note("setting toggled from compact",waitFor([&]{return app->state().value("settings").toMap().value("reducedMotion").toBool()!=reducedBefore;},4000));
        click("reducedMotion");waitFor([&]{return app->state().value("settings").toMap().value("reducedMotion").toBool()==reducedBefore;},4000);
        click("tab_Desktop");QTest::qWait(600);
        if(auto search=item("desktopSearch"))search->setProperty("text","timer");QTest::qWait(200);
        if(auto minutes=item("timerMinutes"))minutes->setProperty("value",1);
        click("startTimer");note("timer started from compact",waitFor([&]{return !app->state().value("timers").toList().isEmpty();},5000));
        QTest::qWait(300);capture("review-workflow-desktop-feedback-compact");
        for(const auto &t:app->state().value("timers").toList())call("timer.cancel",{{"id",t.toMap().value("id")}});
        if(auto search=item("desktopSearch"))search->setProperty("text","");
        click("tab_Chat");reviewWorkspace();
        saveNotes("review-workflows");
    }
    void reviewBrokerDisconnectMidTurn(){
        app->rpc("settings.update",{{"topmost",false},{"quiet",true},{"reducedMotion",true}});QTest::qWait(800);
        reviewWorkspace();
        if(!window){note("workspace window after expand",false,"titled(\"Cere\") not found; windows: "+visibleWindows().join("+"));app->togglePanel();QTest::qWait(500);reviewWorkspace();}
        if(!window){saveNotes("review-broker-disconnect");QSKIP("no workspace window");}
        click("tab_Chat");
        const auto session=createSession("codex","Broker restart mid-turn");
        call("session.send",{{"id",session},{"text","acting"}});
        waitFor([&]{return app->session().value("status").toString()=="working";},5000);QTest::qWait(1700);
        capture("review-midstream-workspace");
        reviewCompact();QTest::qWait(400);capture("review-midstream-compact");reviewWorkspace();
        QFile pidFile(data.path()+"/runtime/broker.pid");pidFile.open(QIODevice::ReadOnly);const int pid=pidFile.readAll().trimmed().toInt();
        note("isolated broker pid found",pid>1,QString::number(pid));
        if(pid>1)::kill(pid,SIGTERM);
        note("ui noticed the disconnect",waitFor([&]{return !app->connected();},8000));
        QTest::qWait(800);capture("review-broker-disconnected-workspace");
        note("composer state while disconnected",true,item("composer")?QString("enabled=%1").arg(item("composer")->isEnabled()):"missing");
        note("send disabled while disconnected",!item("sendMessage")||!item("sendMessage")->isEnabled());
        reviewCompact();QTest::qWait(500);capture("review-broker-disconnected-compact");reviewWorkspace();
        // The interface relaunches a broker that stays down (F9); the review never starts one itself.
        note("ui relaunched the broker and reconnected",waitFor([&]{return app->connected();},40000));
        waitFor([&]{return app->session().value("status").toString()!="working";},10000);QTest::qWait(800);
        note("turn status after restart",true,app->session().value("status").toString()+" · warning: "+app->state().value("recoveryWarning").toString()+" · error: "+app->session().value("error").toString());
        capture("review-broker-reconnected-workspace");
        saveNotes("review-broker-disconnect");
    }
    // F-19: a notice floats over the page without moving it or taking clicks from the controls beneath.
    // F-25: a provider error shown on the open conversation is not repeated as a notice there.
    void noticesFloatOverPagesAndAreNotRepeated(){
        const auto restore=qScopeGuard([&]{restoreWorkspace();});
        restoreWorkspace();click("tab_Sessions");
        auto create=item("newSession");QVERIFY(create);
        const QPointF before=create->mapToScene(QPointF());
        app->notify("Notice overlay check");QTRY_VERIFY(item("toast"));auto toast=item("toast");
        QCOMPARE(create->mapToScene(QPointF()),before);
        const QPointF covered=create->mapToScene(QPointF(create->width()/2,create->height()/2));
        QVERIFY2(toast->mapRectToScene(QRectF(0,0,toast->width(),toast->height())).contains(covered),"The notice no longer covers New session; pick a covered control");
        click("newSession");QTRY_VERIFY(item("sessionProvider"));QCOMPARE(app->toast(),QString("Notice overlay check"));
        QTest::keyClick(window,Qt::Key_Escape);QTRY_VERIFY(!item("sessionProvider"));
        click("tab_Chat");
        const auto failing=createSession("codex","Notice duplicate check");QVERIFY(!failing.isEmpty());
        app->select(failing);QTRY_COMPARE(app->selectedId(),failing);
        QVERIFY(!call("session.send",{{"id",failing},{"text","acting-error"}}).contains("error"));
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("error").toString(),QString("Fixture failure"),8000);
        QTRY_COMPARE(app->toast(),QString("Fixture failure"));
        QVERIFY(!item("toast"));
        click("tab_Sessions");QTRY_VERIFY(item("toast"));
    }
    // F9: a draft edited while the broker is down is kept, the interface relaunches the broker on
    // its own, and the kept draft is saved once it reconnects.
    void offlineDraftSurvivesBrokerRelaunch(){
        restoreWorkspace();click("tab_Chat");
        const auto session=createSession("ollama","Offline draft","fixture-chat:latest");QVERIFY(!session.isEmpty());
        app->select(session);QTRY_COMPARE(app->selectedId(),session);
        QTRY_VERIFY(item("composer"));item("composer")->setProperty("text","Saved before the outage");
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("draft").toString(),QString("Saved before the outage"),5000);
        QFile pidFile(data.path()+"/runtime/broker.pid");QVERIFY(pidFile.open(QIODevice::ReadOnly));
        const int pid=pidFile.readAll().trimmed().toInt();QVERIFY(pid>1);
        QCOMPARE(::kill(pid,SIGTERM),0);
        QTRY_VERIFY_WITH_TIMEOUT(!app->connected(),8000);
        auto composer=item("composer");QVERIFY(composer);
        composer->setProperty("text","Typed while the broker was down");
        QTRY_VERIFY(!item("sendMessage")||!item("sendMessage")->isEnabled());
        QTest::qWait(1200); // Longer than the draft save delay, so the edit is kept while offline.
        QTRY_VERIFY_WITH_TIMEOUT(app->connected(),40000);
        QTRY_COMPARE_WITH_TIMEOUT(app->session().value("draft").toString(),QString("Typed while the broker was down"),10000);
        QCOMPARE(item("composer")->property("text").toString(),QString("Typed while the broker was down"));
        QFile relaunched(data.path()+"/runtime/broker.pid");QVERIFY(relaunched.open(QIODevice::ReadOnly));
        QVERIFY(relaunched.readAll().trimmed().toInt()!=pid);
    }
    void cleanupTestCase(){
        QString runtime=data.path()+"/runtime";
        app.reset();
        // The isolated broker intentionally outlives the UI; stop this test-owned instance.
        QProcess cleanup;cleanup.start("node",{QString(CERE_SOURCE_DIR)+"/tools/stop-test-broker.ts",runtime});cleanup.waitForFinished(5000);
        ollamaFixture.terminate();ollamaFixture.waitForFinished(3000);
    }
};
QTEST_MAIN(UiCheck)
#include "ui.moc"
