#include "../native/controller.h"
#include <QApplication>
#include <QtTest>
#include <QQuickItem>
#include <QTemporaryDir>
#include <QDir>
#include <QJsonDocument>
#include <QJsonObject>
#include <QImage>
#include <QClipboard>
#include <QDesktopServices>
#include <QQuickTextDocument>
#include <QTextBlock>
#include <QTextFragment>
#include <QTextTable>
#include <QTextList>
#include <QScreen>
#include <QQmlContext>
#include <QQmlExpression>
#include <QJSValue>
#include <QScopeGuard>
#include <QLocalServer>
#include <QLocalSocket>
#include <QSignalSpy>
#include <memory>

class UiCheck : public QObject {
    Q_OBJECT
    QTemporaryDir data;
    QProcess ollamaFixture;
    std::unique_ptr<Controller> app;
    QQuickWindow *window=nullptr;
    QString sessionId;
    QUrl openedMessageLink;
    QQuickItem *item(const QString &name){
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
    void capture(const QString &name){QDir().mkpath("/tmp/cere-ui-evidence");QVERIFY(window->grabWindow().save("/tmp/cere-ui-evidence/"+name+".png"));}
    QJsonDocument hypr(const QStringList &args){QProcess p;p.start("hyprctl",args);if(!p.waitForFinished(2000))return {};return QJsonDocument::fromJson(p.readAllStandardOutput());}
    // Offscreen runs own a virtual pointer and never reach the live compositor.
    bool offscreen(){return qGuiApp->platformName()=="offscreen";}
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
        search->setProperty("text","");QTRY_COMPARE(picker->property("count").toInt(),10);
        scroll->setProperty("contentY",0);click("tab_Chat");
    }
    void voiceSettings(){
        click("tab_Settings");
        auto enabled=item("speechEnabled"),voice=item("speechVoice");QVERIFY(enabled&&voice);
        const auto original=app->state().value("settings").toMap();
        const auto restore=qScopeGuard([&]{call("settings.update",{{"speechEnabled",original.value("speechEnabled")},{"voice",original.value("voice")}});click("tab_Chat");});
        QCOMPARE(voice->property("displayText").toString(),QString("en_US-amy-medium"));
        QTRY_VERIFY(voice->property("count").toInt()>0);
        QVERIFY(QMetaObject::invokeMethod(enabled,"toggle"));
        QVERIFY(QMetaObject::invokeMethod(enabled,"clicked"));
        QTRY_COMPARE(app->state().value("settings").toMap().value("speechEnabled").toBool(),false);
        QVERIFY(!call("tts.test").contains("error"));
        QVERIFY(!call("tts.stop").contains("error"));
        QVERIFY(item("ttsTest")&&item("ttsStop")&&item("ttsStatus"));
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
    void permissionBypassSettings(){
        click("tab_Settings");
        const auto restore=qScopeGuard([&]{app->rpc("settings.update",{{"bypassCliPermissions",false},{"bypassComputerPermissions",false}});click("tab_Chat");});
        QTRY_VERIFY(item("bypassCliPermissions"));
        click("bypassCliPermissions");
        QTRY_VERIFY(app->state().value("settings").toMap().value("bypassCliPermissions").toBool());
        QVERIFY(!app->state().value("settings").toMap().value("bypassComputerPermissions").toBool());
        click("bypassComputerPermissions");
        QTRY_VERIFY(app->state().value("settings").toMap().value("bypassComputerPermissions").toBool());
        capture("permission-bypass-settings");
        click("bypassCliPermissions");
        QTRY_VERIFY(!app->state().value("settings").toMap().value("bypassCliPermissions").toBool());
        QVERIFY(app->state().value("settings").toMap().value("bypassComputerPermissions").toBool());
        click("bypassComputerPermissions");
        QTRY_VERIFY(!app->state().value("settings").toMap().value("bypassComputerPermissions").toBool());
    }
    void projectAndDraft(){
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","UI integration test"}});
        QTRY_VERIFY(!app->selectedId().isEmpty());sessionId=app->selectedId();
        auto composer=item("composer");QVERIFY(composer);composer->setProperty("text","A draft that must survive session switching.");
        app->rpc("session.create",{{"provider","claude"},{"cwd",data.path()},{"trusted",true},{"title","Second session"}});
        QTRY_VERIFY(app->selectedId()!=sessionId);app->select(sessionId);
        QTRY_COMPARE(item("composer")->property("text").toString(),QString("A draft that must survive session switching."));capture("draft");
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
        QCOMPARE(provider->property("count").toInt(),3);
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
        click("ollamaModelOptions");auto picker=item("ollamaSessionModel");QVERIFY(picker);
        QTRY_COMPARE(picker->property("count").toInt(),2);
        picker->setProperty("currentIndex",1);QVERIFY(QMetaObject::invokeMethod(picker,"activated",Q_ARG(int,1)));
        QVERIFY(!item("ollamaSessionTools")->isEnabled());capture("ollama-model-options");
        click("ollamaSessionSave");QTRY_COMPARE(app->session().value("model").toString(),QString("fixture-plain:latest"));
        QCOMPARE(app->state().value("settings").toMap().value("ollama").toMap().value("model").toString(),QString("fixture-chat:latest"));
        click("chatHandoff");QCOMPARE(item("handoffProvider")->property("count").toInt(),2);
        QVERIFY(item("handoffTrust"));QVERIFY(!item("handoffCreate")->isEnabled());
        item("handoffTrust")->setProperty("checked",true);click("handoffCreate");
        QTRY_COMPARE(app->session().value("provider").toString(),QString("codex"));
        QTRY_VERIFY(item("composer")->property("text").toString().contains("Hello from Ollama"));
        QCOMPARE(app->session().value("status").toString(),QString("idle"));
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
        auto send=item("sendMessage");QVERIFY(send);QVERIFY(send->mapToScene(QPointF(0,send->height())).y()<window->height());
    }
    void questionsAndAgentActivity(){
        click("tab_Chat");
        app->rpc("settings.update",{{"bypassCliPermissions",false},{"quiet",true},{"reducedMotion",true}});
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
        app->rpc("settings.update",{{"reducedMotion",false},{"scale",1.5}});
        QTRY_VERIFY(app->motion()!="quiet");
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
        QTRY_COMPARE(app->motion(),QString("cheeky"));
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
        const auto restore=qScopeGuard([&]{restoreWorkspace();});
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
        for(auto w:qGuiApp->allWindows())if(!inspector)inspector=w->findChild<QObject*>("graphMemoryInspector");
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
            QVERIFY2(panel->width()<=440&&panel->height()<=720,qPrintable(where));
            // Compact navigation still works at the capped size.
            window=panel;QTest::qWait(100);click("tab_Sessions");QVERIFY2(item("newSession"),qPrintable(where));
        }
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
                const double step=QLineF(last,now).length(),bound=75*(at-sampled)/1000.+tolerance;
                const QString error=step<=bound?QString():QString("%1 %2: moved %3 px in %4 ms").arg(where,phase).arg(step).arg(at-sampled);
                last=now;sampled=at;
                const QRect rect(now,size);if(rect.intersects(a)&&rect.intersects(b))straddled=true;
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
                if(b.contains(QRect(app->petPosition(),size))&&app->motion()!="runLeft"&&app->motion()!="runRight"){settled=true;break;}
            }
            QVERIFY2(straddled,qPrintable(where));QVERIFY2(settled,qPrintable(where));
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
