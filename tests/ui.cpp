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
    QPoint pointer(){const auto p=hypr({"-j","cursorpos"}).object();return {p["x"].toInt(),p["y"].toInt()};}
    void movePointer(QPoint point){hypr({"dispatch",QString("hl.dsp.cursor.move({x=%1,y=%2})").arg(point.x()).arg(point.y())});}
    QRect floatingPet(){for(const auto value:hypr({"-j","clients"}).array()){
        const auto w=value.toObject();if(w["pid"].toInteger()!=QCoreApplication::applicationPid()||w["title"].toString()!="Cere Pet")continue;
        const auto p=w["at"].toArray(),s=w["size"].toArray();return {p[0].toInt(),p[1].toInt(),s[0].toInt(),s[1].toInt()};
    }return {};}
private slots:
    void recordMessageLink(const QUrl &url){openedMessageLink=url;}
    void initTestCase(){
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
        QTRY_VERIFY(horizontal->property("contentWidth").toDouble()>body->width());
        horizontal->setProperty("contentX",horizontal->property("contentWidth").toDouble()-horizontal->width());
        QVERIFY(horizontal->property("contentX").toDouble()>0);
        QTest::qWait(250);capture("markdown-wide-table");
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
        QTRY_VERIFY(item("sessionOpen")->isEnabled());capture("ollama-new-session");
        click("sessionOpen");QTRY_COMPARE(app->session().value("provider").toString(),QString("ollama"));
        QCOMPARE(app->session().value("model").toString(),QString("fixture-chat:latest"));
        const auto session=app->selectedId();
        app->rpc("session.send",{{"id",session},{"text","Say hello"}});
        QTRY_COMPARE(app->session().value("status").toString(),QString("idle"));
        QTRY_COMPARE(app->transcript()->rowCount(),2);capture("ollama-conversation");
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
        app->closePanel();
        app->rpc("session.send",{{"id",session},{"text","approval"}});
        QTRY_COMPARE(requests().size(),1);QTRY_VERIFY(bubble());
        QVERIFY(!workspace->isVisible());
        bubble()->close();QTRY_VERIFY(bubble());
        window=bubble();QTest::qWait(180);capture("permission-bubble");
        const auto first=requests().first().toMap().value("id").toString();
        click("approval_"+first+"_allow");
        QTRY_VERIFY(requests().isEmpty());QTRY_VERIFY(!bubble());
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
        QTRY_VERIFY(requests().isEmpty());QTRY_VERIFY(!bubble());
        QTRY_VERIFY(app->messages().last().toMap().value("text").toString().contains("Decision: decline"));
        // Multiple approvals retain their IDs and stay visible until all are answered.
        app->rpc("session.send",{{"id",session},{"text","multiple"}});
        QTRY_COMPARE(requests().size(),2);QTRY_VERIFY(bubble());window=bubble();QTest::qWait(250);
        const auto a=requests()[0].toMap().value("id").toString(),b=requests()[1].toMap().value("id").toString();
        click("approval_"+a+"_allow");QTRY_COMPARE(requests().size(),1);QTRY_VERIFY(bubble());
        click("approval_"+b+"_deny");QTRY_VERIFY(requests().isEmpty());QTRY_VERIFY(!bubble());
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
            QTRY_VERIFY(requests().isEmpty());QTRY_VERIFY(!layerVisible());
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
        QCOMPARE(player->property("stretchY").toDouble(),1.);
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
    void expressiveActing(){
        const auto previous=app->selectedId();
        app->rpc("session.create",{{"provider","codex"},{"cwd",data.path()},{"trusted",true},{"title","Expressive acting fixture"}});
        QTRY_VERIFY(app->selectedId()!=previous);const auto session=app->selectedId();
        const auto restore=qScopeGuard([&]{app->rpc("ui.panel",{{"owner","overlay"},{"visible",false}});app->rpc("settings.update",{{"topmost",true},{"quiet",false},{"reducedMotion",false},{"motionIntensity",.7},{"expressiveCues",true},{"scale",1.0}});app->expand();});
        app->rpc("settings.update",{{"topmost",false},{"quiet",false},{"reducedMotion",true},{"motionIntensity",.7},{"scale",1.5}});
        QQuickWindow *pet=nullptr;
        QTRY_VERIFY(([&]{for(auto w:qGuiApp->allWindows())if(w->title()=="Cere Pet"&&w->isVisible()){pet=qobject_cast<QQuickWindow*>(w);return pet!=nullptr;}return false;})());
        auto player=pet->findChild<QQuickItem*>("gesturePlayer");QVERIFY(player);
        click("tab_Chat");auto composer=item("composer");QVERIFY(composer);window->requestActivate();composer->forceActiveFocus();
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
        app->rpc("session.send",{{"id",session},{"text","acting"}});
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
        app->rpc("session.send",{{"id",session},{"text","acting"}});
        QTRY_COMPARE(app->motion(),QString("thinking"));
        QTRY_COMPARE(app->motion(),QString("working"));
        QTRY_COMPARE(app->motion(),QString("cheeky"));
        const auto afterCue=player->property("keyIndex").toInt();QTest::qWait(500);
        QVERIFY(player->property("keyIndex").toInt()>=afterCue);
        QTRY_COMPARE(app->motion(),QString("celebrate"));QTest::qWait(360);QVERIFY(capturePet("success"));
        QTest::qWait(2600);
        app->rpc("session.send",{{"id",session},{"text","acting"}});
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
        app->expand();click("tab_Settings");QVERIFY(item("motionIntensity"));QVERIFY(item("expressiveCues"));
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
