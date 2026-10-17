// Captures the documentation screenshots from the scripted demo profile that tools/screenshots/run.sh
// prepares. Every surface renders offscreen in this process (always-on-top off, so the interface owns the
// pet, compact panel and bubble). Desktop scenes draw those windows over a wallpaper at their real
// positions, as a compositor would. Slots run in order and later ones build on earlier conversations;
// name slots on the command line to retake only those images.
#include "../../native/controller.h"
#include <QApplication>
#include <QtTest>
#include <QQuickItem>
#include <QQuickWindow>
#include <QPainter>
#include <QPainterPath>
#include <QScreen>
#include <QDir>
#include <QImageWriter>
#include <cmath>
#include <memory>

class Showcase : public QObject {
    Q_OBJECT
    std::unique_ptr<Controller> app;
    QPointer<QQuickWindow> window;
    QString out;
    const QSize workspaceSize{1280,860};

    bool waitFor(const std::function<bool()> &ready,int timeout=10000){
        QElapsedTimer clock;clock.start();
        while(!ready()){if(clock.elapsed()>timeout)return false;QTest::qWait(25);}
        return true;
    }
    // The top-most visible match, so a control in an open popup wins over one beneath it.
    static QQuickItem *find(QQuickItem *root,const QString &name){
        if(!root||!root->isVisible())return nullptr;
        const auto children=root->childItems();
        for(auto child=children.crbegin();child!=children.crend();++child)if(auto match=find(*child,name))return match;
        return root->objectName()==name?root:nullptr;
    }
    QQuickItem *item(const QString &name){return window?find(window->contentItem(),name):nullptr;}
    // The top-most visible control whose text starts with a prefix, for controls without an object name.
    static QQuickItem *findText(QQuickItem *root,const QString &prefix){
        if(!root||!root->isVisible())return nullptr;
        const auto children=root->childItems();
        for(auto child=children.crbegin();child!=children.crend();++child)if(auto match=findText(*child,prefix))return match;
        return root->inherits("QQuickAbstractButton")&&root->property("text").toString().startsWith(prefix)?root:nullptr;
    }
    bool clickText(const QString &prefix){
        auto control=window?findText(window->contentItem(),prefix):nullptr;if(!control){qWarning()<<"No button"<<prefix;return false;}
        QTest::mouseClick(window,Qt::LeftButton,Qt::NoModifier,control->mapToScene(QPointF(control->width()/2,control->height()/2)).toPoint());
        QTest::qWait(200);return true;
    }
    // Scrolls a control into view inside its flickables, then clicks its centre.
    bool click(const QString &name){
        auto control=item(name);if(!control){qWarning()<<"No control"<<name;return false;}
        for(auto parent=control->parentItem();parent;parent=parent->parentItem())if(parent->property("contentY").isValid()&&parent->property("contentHeight").toDouble()>parent->height()){
            const auto y=control->mapToItem(parent,QPointF(control->width()/2,control->height()/2)).y();
            if(y<10||y>parent->height()-10){parent->setProperty("contentY",std::clamp(parent->property("contentY").toDouble()+y-parent->height()/2,0.,parent->property("contentHeight").toDouble()-parent->height()));QTest::qWait(60);}
        }
        QTest::mouseClick(window,Qt::LeftButton,Qt::NoModifier,control->mapToScene(QPointF(control->width()/2,control->height()/2)).toPoint());
        QTest::qWait(200);return true;
    }
    QQuickWindow *titled(const QString &title){for(auto w:qGuiApp->allWindows())if(w->title()==title&&w->isVisible())return qobject_cast<QQuickWindow*>(w);return nullptr;}
    QVariantMap call(const QString &method,const QVariantMap &params={}){
        QVariant value;bool done=false;const int id=app->rpc(method,params);
        const auto connection=connect(app.get(),&Controller::result,this,[&](int result,const QVariant &v){if(result==id){value=v;done=true;}});
        waitFor([&]{return done;},15000);disconnect(connection);
        const auto map=value.toMap();if(map.contains("error"))qWarning()<<method<<map.value("error");
        return done?map:QVariantMap{{"error","No broker result for "+method}};
    }
    QVariantMap sessionNamed(const QString &title){
        for(const auto &entry:app->state().value("sessions").toList())if(entry.toMap().value("title").toString()==title)return entry.toMap();
        return {};
    }
    QString status(const QString &title){return sessionNamed(title).value("status").toString();}
    QVariantList approvals(){return app->state().value("approvals").toList();}
    QVariantMap approvalFor(const QString &title){
        const auto id=sessionNamed(title).value("id");
        for(const auto &entry:approvals())if(entry.toMap().value("sessionId")==id)return entry.toMap();
        return {};
    }
    bool settings(const QVariantMap &patch){return !call("settings.update",patch).contains("error");}
    // PNG at its strongest compression (quality 0); opaque images drop the alpha channel.
    void save(const QImage &image,const QString &name){
        QVERIFY2(!image.isNull(),qPrintable(name));
        QImage output=image.convertToFormat(QImage::Format_ARGB32);bool opaque=true;
        for(int y=0;y<output.height()&&opaque;++y){const auto line=reinterpret_cast<const QRgb*>(output.constScanLine(y));for(int x=0;x<output.width();++x)if(qAlpha(line[x])!=255){opaque=false;break;}}
        if(opaque)output=output.convertToFormat(QImage::Format_RGB888);
        QImageWriter writer(out+"/"+name+".png","png");writer.setQuality(0);
        QVERIFY2(writer.write(output),qPrintable(writer.errorString()));qInfo().noquote()<<"saved"<<name;
    }
    // Parks the pointer in a corner so no hover state or tooltip shows.
    void rest(){if(window)QTest::mouseMove(window,QPoint(window->width()-3,window->height()-3));}
    // Notices float over the page for a few seconds; shots wait for them to clear.
    void shot(const QString &name){QVERIFY(window);rest();waitFor([&]{return app->toast().isEmpty();},8000);QTest::qWait(400);save(window->grabWindow(),name);}
    // Scrolls the nearest flickable so a control's top sits just below the viewport's top.
    void reveal(const QString &name,qreal gap=8){
        auto control=item(name);QVERIFY2(control,qPrintable(name));
        for(auto parent=control->parentItem();parent;parent=parent->parentItem())if(parent->property("contentY").isValid()&&parent->property("contentHeight").toDouble()>parent->height()){
            const auto y=control->mapToItem(parent,QPointF()).y();
            parent->setProperty("contentY",std::clamp(parent->property("contentY").toDouble()+y-gap,parent->property("originY").toDouble(),parent->property("originY").toDouble()+parent->property("contentHeight").toDouble()-parent->height()));
            QTest::qWait(300);return;
        }
    }

    void workspace(const QString &page="tab_Chat"){
        if(!(window=titled("Cere"))){app->expand();QVERIFY(waitFor([&]{return (window=titled("Cere"))!=nullptr;}));}
        if(window->size()!=workspaceSize){window->resize(workspaceSize);QTest::qWait(300);}
        closePopups();click(page);QTest::qWait(300);
    }
    void compact(){
        if(auto workspace=titled("Cere"))workspace->hide();
        if(!(window=titled("Cere Panel"))){app->togglePanel();QVERIFY(waitFor([&]{return (window=titled("Cere Panel"))!=nullptr;}));}
        QTest::qWait(600);
    }
    void hideWindows(){app->closePanel();if(auto workspace=titled("Cere"))workspace->hide();window=nullptr;QTest::qWait(400);}
    void closePopups(){
        if(!window)return;
        std::function<void(QObject*)> walk=[&](QObject *object){
            if(object->inherits("QQuickPopup")&&object->property("opened").toBool())QMetaObject::invokeMethod(object,"close");
            for(auto child:object->children())walk(child);
        };
        walk(window->contentItem());QTest::qWait(200);
    }
    void open(const QString &title){
        const auto id=sessionNamed(title).value("id").toString();QVERIFY2(!id.isEmpty(),qPrintable(title));
        app->select(id);call("session.read",{{"id",id}});
        QVERIFY(waitFor([&]{return !app->messages().isEmpty();}));QTest::qWait(700);
    }
    void send(const QString &title,const QString &text){QVERIFY(!call("session.send",{{"id",sessionNamed(title).value("id")},{"text",text}}).contains("error"));}
    void create(const QString &provider,const QString &project,const QString &title,const QVariantMap &extra={}){
        if(!sessionNamed(title).isEmpty())return;
        QVariantMap params{{"provider",provider},{"cwd",QDir::homePath()+"/Projects/"+project},{"trusted",true},{"title",title}};
        params.insert(extra);QVERIFY(!call("session.create",params).contains("error"));
        QVERIFY(waitFor([&]{return !sessionNamed(title).isEmpty();}));
    }
    void scrollTo(const QString &list,qreal fraction){
        auto view=item(list);QVERIFY2(view,qPrintable(list));
        const qreal range=view->property("contentHeight").toDouble()-view->height();
        if(range>0)view->setProperty("contentY",view->property("originY").toDouble()+range*fraction);
        QTest::qWait(300);
    }

    // A soft drop shadow beneath a window's opaque pixels.
    static void shadow(QPainter &p,const QImage &image,QPoint at,int spread=28,int alpha=130){
        QImage mask(image.size()+QSize(spread*4,spread*4),QImage::Format_ARGB32_Premultiplied);mask.fill(Qt::transparent);
        {QPainter m(&mask);m.drawImage(spread*2,spread*2,image);m.setCompositionMode(QPainter::CompositionMode_SourceIn);m.fillRect(mask.rect(),QColor(2,6,14,alpha));}
        const auto soft=mask.scaled(mask.size()/10,Qt::IgnoreAspectRatio,Qt::SmoothTransformation).scaled(mask.size(),Qt::IgnoreAspectRatio,Qt::SmoothTransformation);
        p.drawImage(at+QPoint(0,spread/2)-QPoint(spread*2,spread*2),soft);
    }
    static QImage wallpaper(QSize size){
        QImage image(size,QImage::Format_ARGB32_Premultiplied);
        QPainter p(&image);p.setRenderHint(QPainter::Antialiasing);
        QLinearGradient base(0,0,size.width()*.35,size.height());base.setColorAt(0,QColor("#0b1322"));base.setColorAt(1,QColor("#16233b"));
        p.fillRect(image.rect(),base);
        const auto glow=[&](QPointF centre,qreal radius,QColor color){
            QRadialGradient g(centre,radius);g.setColorAt(0,color);color.setAlpha(0);g.setColorAt(1,color);p.fillRect(image.rect(),g);
        };
        glow({size.width()*.12,size.height()*.18},size.width()*.5,QColor(36,128,196,80));
        glow({size.width()*.88,size.height()*.92},size.width()*.42,QColor(86,64,190,70));
        glow({size.width()*.62,size.height()*.05},size.width()*.32,QColor(24,190,200,42));
        // Two low ridgelines for depth.
        for(const auto &[height,alpha]:std::initializer_list<std::pair<qreal,int>>{{.74,38},{.84,52}}){
            QPainterPath ridge;ridge.moveTo(0,size.height());
            for(int x=0;x<=size.width();x+=24)ridge.lineTo(x,size.height()*height+std::sin(x/(size.width()*.11)+height*9)*size.height()*.035+std::sin(x/(size.width()*.043))*size.height()*.01);
            ridge.lineTo(size.width(),size.height());ridge.closeSubpath();
            p.fillPath(ridge,QColor(4,9,18,alpha*2));
        }
        return image;
    }
    // Cere's own windows over a wallpaper of the screen, cropped to the windows plus a margin.
    QImage scene(const QList<QQuickWindow*> &windows,int margin=72){
        rest();QTest::qWait(300);
        const auto screen=qGuiApp->primaryScreen()->geometry();
        QImage canvas=wallpaper(screen.size());QPainter p(&canvas);
        QRect bounds;
        for(auto w:windows){
            if(!w||!w->isVisible())continue;
            const auto image=w->grabWindow();const QPoint at=w->position()-screen.topLeft();
            if(w->title()!="Cere Pet")shadow(p,image,at);
            p.drawImage(at,image);bounds|=QRect(at,image.size());
        }
        p.end();
        return canvas.copy(bounds.adjusted(-margin,-margin,margin,margin).intersected(canvas.rect()));
    }
    // Images side by side on the wallpaper, bottom-aligned.
    static QImage lineup(const QList<QImage> &images,int gap,int margin,bool shadows){
        int width=margin*2+gap*(images.size()-1),height=0;
        for(const auto &image:images){width+=image.width();height=std::max(height,image.height());}
        QImage canvas=wallpaper(QSize(width,height+margin*2));QPainter p(&canvas);
        int x=margin;
        for(const auto &image:images){const QPoint at(x,margin+height-image.height());if(shadows)shadow(p,image,at);p.drawImage(at,image);x+=image.width()+gap;}
        return canvas;
    }
    QQuickWindow *pet(){return titled("Cere Pet");}
    QQuickWindow *bubble(){return titled("Cere Approval");}
    QQuickItem *player(){return pet()?pet()->findChild<QQuickItem*>("gesturePlayer"):nullptr;}
    // The pet's own still pose, trimmed to its visible pixels plus a margin.
    QImage petImage(){
        auto window=pet();if(!window)return {};
        const auto image=window->grabWindow().convertToFormat(QImage::Format_ARGB32);
        QRect used;
        for(int y=0;y<image.height();++y)for(int x=0;x<image.width();++x)if(qAlpha(image.pixel(x,y))>8)used|=QRect(x,y,1,1);
        return image.copy(used.adjusted(-12,-12,12,12).intersected(image.rect()));
    }

private slots:
    void initTestCase(){
        out=qEnvironmentVariable("CERE_SCREENSHOTS_DIR");QVERIFY2(!out.isEmpty(),"Set CERE_SCREENSHOTS_DIR");QVERIFY(QDir().mkpath(out));
        qApp->setQuitOnLastWindowClosed(false);
        app=std::make_unique<Controller>(CERE_SOURCE_DIR,false);
        app->start(false);QVERIFY(waitFor([&]{return app->connected();},15000));
        QVERIFY(waitFor([&]{const auto c=app->state().value("capabilities").toMap();
            for(const auto provider:{"codex","claude","ollama","antigravity"})if(c.value(provider).toMap().value("modelsStatus").toString()!="ready")return false;return true;},20000));
        QVERIFY(waitFor([&]{return pet()!=nullptr;}));
        QVERIFY(settings({{"scale",1.25}}));
        workspace();QTest::qWait(500);
    }

    // The expanded workspace reading a finished plan with a table, task list and code.
    void workspaceConversation(){
        workspace();open("Plan the 2.4 release");
        scrollTo("messageList",0);
        shot("workspace-conversation");
    }

    // The compact panel beside the pet after a scripted Codex run: the hero image and the panel alone.
    void compactPanel(){
        create("codex","aurora-web","Fix the flaky login test",{{"model","gpt-6.1-sol"},{"effort","medium"}});
        send("Fix the flaky login test","The login test keeps flaking on CI. Can you find out why?");
        const auto id=sessionNamed("Fix the flaky login test").value("id");
        QVERIFY(waitFor([&]{for(const auto &entry:app->state().value("completions").toList())if(entry.toMap().value("sessionId")==id)return status("Fix the flaky login test")=="idle";return false;},15000));
        open("Fix the flaky login test");compact();QTest::qWait(1500);
        shot("compact-conversation");
        save(scene({pet(),window}),"desktop-companion");
    }

    // A pinned conversation's reply waits in a bubble beside the pet while the panel is closed.
    void replyBubble(){
        const auto session=sessionNamed("Hyprland window rules");
        QVERIFY(!call("session.organize",{{"id",session.value("id")},{"pinned",true},{"expectedRevision",session.value("revision")}}).contains("error"));
        hideWindows();
        send("Hyprland window rules","And Discord on workspace 8?");
        QVERIFY(waitFor([&]{return !app->state().value("companionReplies").toList().isEmpty()&&bubble()!=nullptr;},15000));
        QTest::qWait(1200);
        save(scene({pet(),bubble()}),"desktop-reply-bubble");
        for(const auto &reply:app->state().value("companionReplies").toList())call("companion.dismiss",{{"id",reply.toMap().value("id")}});
        workspace();open("Hyprland window rules");scrollTo("messageList",1);
        shot("workspace-web-sources");
    }

    // A provider question with options, several selections and a written answer, then its answer.
    void questionForm(){
        create("codex","aurora-web","Write the 2.4 release notes",{{"model","gpt-6.1-sol"},{"effort","medium"}});
        send("Write the 2.4 release notes","Draft the release notes for 2.4.");
        QVERIFY(waitFor([&]{return !approvalFor("Write the 2.4 release notes").isEmpty();},15000));
        workspace();open("Write the 2.4 release notes");
        const auto id=approvalFor("Write the 2.4 release notes").value("id").toString();
        QVERIFY(waitFor([&]{return item("question_"+id+"_audience_Developers")!=nullptr;}));
        for(const QString option:{"audience_Developers","sections_Highlights","sections_Breaking changes"}){
            auto control=item("question_"+id+"_"+option);QVERIFY2(control,qPrintable(option));
            control->setProperty("checked",true);QMetaObject::invokeMethod(control,"clicked");
        }
        auto other=item("questionOther_"+id+"_context");QVERIFY(other);
        other->forceActiveFocus();other->setProperty("text","Give the new SSO setup guide its own section.");
        QVERIFY(waitFor([&]{return app->questionDraft(id).value("context").toMap().value("answers").toList().size()==1;}));
        other->setFocus(false);reveal("approvalRequester_"+id,96);
        shot("workspace-question");
        QVERIFY(QMetaObject::invokeMethod(item("approval_"+id+"_answer"),"clicked"));
        QVERIFY(waitFor([&]{return status("Write the 2.4 release notes")=="idle";},15000));
    }

    // Delegated work with a file change and a deploy command, both waiting beside the pet and in the panel.
    void waitingForYou(){
        create("codex","aurora-web","Speed up the test suite",{{"model","gpt-6-astra"},{"effort","high"}});
        create("codex","tidepool","Deploy the pipeline to staging",{{"model","gpt-6.1-sol"},{"effort","low"}});
        send("Speed up the test suite","The test suite takes four minutes now. Profile it and make it faster.");
        QVERIFY(waitFor([&]{return !approvalFor("Speed up the test suite").isEmpty();},15000));
        send("Deploy the pipeline to staging","Ship the reviewed build to staging so QA can start.");
        QVERIFY(waitFor([&]{return !approvalFor("Deploy the pipeline to staging").isEmpty();},15000));
        hideWindows();QVERIFY(waitFor([&]{return bubble()!=nullptr;}));QTest::qWait(1200);
        save(scene({pet(),bubble()}),"desktop-approval-bubble");
        QVERIFY(!call("approval.answer",{{"id",approvalFor("Speed up the test suite").value("id")},{"choice","allow"}}).contains("error"));
        open("Deploy the pipeline to staging");compact();QTest::qWait(800);
        shot("compact-approval");
        QVERIFY(!call("approval.answer",{{"id",approvalFor("Deploy the pipeline to staging").value("id")},{"choice","allow"}}).contains("error"));
        QVERIFY(waitFor([&]{return approvals().isEmpty();}));
    }

    // The delegated run after approval: its reply, two subagents still working and the tool trail.
    void workspaceActivity(){
        workspace();open("Speed up the test suite");
        auto toggle=item("activityToggle");QVERIFY(toggle);
        if(!toggle->parentItem()->property("expanded").toBool())click("activityToggle");
        QTest::qWait(600);scrollTo("messageList",1);
        shot("workspace-activity");
    }

    // Later pages show a settled desktop: the deploy and the subagents finish first.
    void sessionsPage(){
        QVERIFY(waitFor([&]{for(const auto &entry:app->state().value("sessions").toList())if(entry.toMap().value("status").toString()!="idle")return false;return true;},30000));
        workspace("tab_Sessions");QTest::qWait(800);shot("sessions");
    }
    void projectsPage(){workspace("tab_Projects");QTest::qWait(800);shot("projects");}

    void newSession(){
        workspace();open("Plan the 2.4 release");click("sidebarNewSession");
        QVERIFY(waitFor([&]{return item("sessionProvider")!=nullptr;}));
        item("sessionTitle")->setProperty("text","Add SSO to the admin console");
        item("sessionProjectPath")->setProperty("text",QDir::homePath()+"/Projects/aurora-web");
        click("sessionTrust");QTest::qWait(600);
        shot("new-session");closePopups();
    }

    void commandPalette(){
        workspace();click("sidebarCommandPalette");QVERIFY(waitFor([&]{return item("commandPaletteSearch")!=nullptr;}));
        QTest::qWait(900);shot("command-palette");
        item("commandPaletteSearch")->setProperty("text","release");QTest::qWait(900);
        shot("command-palette-search");closePopups();
    }

    void desktopPage(){
        call("action.run",{{"name","timer.start"},{"args",QVariantMap{{"minutes",25},{"label","Stretch and refill tea"}}}});
        workspace("tab_Desktop");QTest::qWait(1500);
        shot("desktop");
        reveal("workspaceNumber",64);shot("desktop-apps");
        compact();click("tab_Desktop");QTest::qWait(1500);
        shot("compact-desktop");
        click("tab_Chat");hideWindows();
    }

    void workflows(){
        workspace();open("Plan the 2.4 release");
        QVERIFY(!call("capsules.save",{{"sessionId",app->selectedId()},{"expectedRevision","0"},{"sources",QVariantList{}},
            {"goal","Ship 2.4 with offline drafts and the new settings page in two weeks"},
            {"decisions",QStringList{"SSO can slip to 2.4.1 without blocking the release","Release candidate on Thursday, not Friday"}},
            {"constraints",QStringList{"Keep the draft storage schema frozen after week one"}},{"questions",QStringList{"Who signs off on the staging identity provider?"}},
            {"nextSteps",QStringList{"Land offline drafts behind drafts.offline","Port the last four settings panels"}},
            {"relevantSessionIds",QStringList{sessionNamed("Fix the flaky login test").value("id").toString(),sessionNamed("Speed up the test suite").value("id").toString()}}}).contains("error"));
        click("sidebarWorkflows");QVERIFY(waitFor([&]{return item("capsuleGoal")!=nullptr&&!item("capsuleGoal")->property("text").toString().isEmpty();}));QTest::qWait(600);
        shot("workflows");closePopups();
    }

    void handoff(){
        workspace();open("Plan the 2.4 release");QVERIFY(click("chatHandoff"));QTest::qWait(800);
        shot("handoff");closePopups();
    }
    void completionInbox(){
        workspace();open("Plan the 2.4 release");QVERIFY(click("chatInbox"));QTest::qWait(800);
        shot("completion-inbox");closePopups();
    }
    void permissionCenter(){
        workspace();open("Plan the 2.4 release");QVERIFY(click("shellPermissionCenter"));QTest::qWait(800);
        shot("permissions");closePopups();
    }

    // Project memory: Knowledge settings, saved facts and the graph inspector.
    void memory(){
        QVERIFY(settings({{"memory",QVariantMap{{"enabled",true},{"model","nomic-embed-text"},{"extractionModel","nemotron-3-super"},{"allowCloudExtraction",true},{"allowCloudMemory",false}}}}));
        call("memory.check");
        QVERIFY(waitFor([&]{return app->state().value("memory").toMap().value("state").toString()=="ready";},15000));
        const auto session=sessionNamed("Plan the 2.4 release").value("id");
        for(const QString fact:{"Prefers short answers with the command first.","Use pnpm, never npm, in aurora-web.","Priya owns the settings page; Marcus owns SSO.","Release candidates go out on Thursdays so problems surface before the weekend."})
            call("memory.save",{{"sessionId",session},{"text",fact}});
        workspace();open("Plan the 2.4 release");
        click("tab_Settings");QVERIFY(waitFor([&]{return item("settingsPage")!=nullptr;}));
        QMetaObject::invokeMethod(item("settingsPage"),"open",Q_ARG(QVariant,"knowledge"),Q_ARG(QVariant,QString()));QTest::qWait(900);
        shot("settings-knowledge");
        QVERIFY(click("manageMemories"));QVERIFY(waitFor([&]{return item("addMemory")!=nullptr;}));QTest::qWait(1200);
        shot("memory");
        QVERIFY(click("openGraphInspector"));QVERIFY(waitFor([&]{return item("graphMemoryQuery")!=nullptr;}));QTest::qWait(1500);
        shot("memory-inspector");closePopups();
    }

    // A memory-backed turn, then what the next message would carry: draft, destination and recalled evidence.
    void contextDrawer(){
        // Recall into a cloud provider's turn is opt-in; this turn allows it, then the default returns.
        const auto memory=[&](bool cloud){return settings({{"memory",QVariantMap{{"enabled",true},{"model","nomic-embed-text"},{"extractionModel","nemotron-3-super"},{"allowCloudExtraction",true},{"allowCloudMemory",cloud}}}});};
        QVERIFY(memory(true));const auto restore=qScopeGuard([&]{memory(false);});
        send("Fix the flaky login test","Great, open a PR with that fix and run the checks with pnpm.");
        QVERIFY(waitFor([&]{return status("Fix the flaky login test")=="idle";},15000));QTest::qWait(1500);
        workspace();open("Fix the flaky login test");
        auto composer=item("composer");QVERIFY(composer);
        composer->setProperty("text","Also add the 50-run check to the nightly CI job.");
        QVERIFY(click("contextDrawerButton"));QTest::qWait(1500);
        shot("context-drawer");closePopups();composer->setProperty("text","");
    }

    // A decision proposed from a message, with its supporting passage and the review choices.
    void memoryReview(){
        workspace();open("Plan the 2.4 release");
        QVariantMap decision;
        for(const auto &message:app->messages())if(message.toMap().value("text").toString().startsWith("Decision recorded"))decision=message.toMap();
        QVERIFY(!decision.isEmpty());
        QVERIFY(!call("memoryReview.propose",{{"sessionId",decision.value("sessionId")},{"messageId",decision.value("id")},{"kind","decision"}}).contains("error"));
        QVERIFY(click("chatMemoryReview"));
        QVERIFY(waitFor([&]{return findText(window->contentItem(),"Model suggestion")!=nullptr;}));
        QVERIFY(clickText("Model suggestion"));QTest::qWait(800);
        shot("memory-review");closePopups();
    }

    void settingsPages(){
        workspace();open("Plan the 2.4 release");click("tab_Settings");
        auto page=item("settingsPage");QVERIFY(page);
        for(const QString id:{"companion","personality","voice","motion","connections","assistance","scripts","mobile","telemetry","application"}){
            QMetaObject::invokeMethod(page,"open",Q_ARG(QVariant,id),Q_ARG(QVariant,QString()));
            QVERIFY(waitFor([&]{return page->property("category").toString()==id;}));QTest::qWait(900);
            if(id=="motion"){QMetaObject::invokeMethod(page,"revealControl",Q_ARG(QVariant,"motionStage"));QTest::qWait(1500);}
            shot("settings-"+id);
        }
        QVERIFY(clickText("Health and recovery"));QTest::qWait(1500);
        shot("health");closePopups();
        auto search=item("settingsSearch");QVERIFY(search);
        search->setProperty("text","voice");QTest::qWait(800);shot("settings-search");
        search->setProperty("text","");
    }

    // Every avatar's theme in the compact panel, and the characters side by side.
    void themesAndAvatars(){
        QVERIFY(settings({{"reducedMotion",true}}));
        QList<QImage> panels,pets;
        for(const auto &entry:app->avatars()){
            const QString id=entry.toMap().value("id").toString();
            QVERIFY(settings({{"avatar",id}}));QTest::qWait(900);
            open("Fix the flaky login test");compact();QTest::qWait(900);scrollTo("messageList",0);rest();
            panels<<window->grabWindow();pets<<petImage();
        }
        QVERIFY(settings({{"avatar","cere"},{"reducedMotion",false}}));
        save(lineup(panels,40,56,true),"themes");
        save(lineup(pets,24,40,false),"avatars");
        hideWindows();
    }

    // The six illustrated gestures, each held at its endpoint.
    void gestures(){
        QVERIFY(settings({{"avatar","cere"},{"reducedMotion",false},{"motionIntensity",.7}}));
        hideWindows();auto actor=player();QVERIFY(actor);
        actor->setProperty("followAppMotion",false);
        QList<QImage> poses;
        for(const QString motion:{"wave","thinking","explainOpen","celebrate","clickBlush","dragging"}){
            actor->setProperty("motion","idle");QTest::qWait(900);
            actor->setProperty("motion",motion);QTest::qWait(1600);
            poses<<petImage();
        }
        actor->setProperty("followAppMotion",true);
        save(lineup(poses,8,40,false),"gestures");
    }

    void cleanupTestCase(){QTest::qWait(200);}
};

int main(int argc,char **argv){
    qputenv("QT_QUICK_CONTROLS_STYLE","Basic");
    QApplication application(argc,argv);
    application.setApplicationName("cere");application.setOrganizationName("Cere");
    Showcase showcase;
    return QTest::qExec(&showcase,argc,argv);
}
#include "capture.moc"
