#include "controller.h"
#include <LayerShellQt/Window>
#include <QApplication>
#include <QQmlContext>
#include <QQuickItem>
#include <QQuickTextDocument>
#include <QTextBlock>
#include <QTextCursor>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QDir>
#include <QFile>
#include <QScreen>
#include <QClipboard>
#include <QDesktopServices>
#include <QFileDialog>
#include <QMenu>
#include <QStandardPaths>
#include <QImage>
#include <QPainter>
#include <QLineF>
#include <QRandomGenerator>
#include <QSaveFile>
#include <QDBusConnection>
#include <QDBusMessage>
#include <algorithm>

static QByteArray hyprQuery(const QByteArray &command){
    QLocalSocket socket;
    QString path=qEnvironmentVariable("XDG_RUNTIME_DIR")+"/hypr/"+qEnvironmentVariable("HYPRLAND_INSTANCE_SIGNATURE")+"/.socket.sock";
    socket.connectToServer(path);if(!socket.waitForConnected(50))return {};
    socket.write(command);socket.waitForBytesWritten(50);
    QByteArray response;
    while(socket.waitForReadyRead(50)){response+=socket.readAll();if(socket.state()!=QLocalSocket::ConnectedState)break;}
    response+=socket.readAll();return response;
}
static void hyprDispatch(const QByteArray &lua,const QByteArray &legacy){
    static const bool hasLua=hyprQuery("/eval assert(hl and hl.dsp)").trimmed()=="ok";
    hyprQuery(hasLua?"/dispatch "+lua:"/dispatch "+legacy);
}

Controller::Controller(QString root,bool overlay,QObject *parent):QObject(parent),m_root(root),m_overlay(overlay) {
    m_replies.setSourceModel(&m_transcript);m_activity.setSourceModel(&m_transcript);
    connect(&m_activity,&QAbstractItemModel::rowsInserted,this,&Controller::activityChanged);
    connect(&m_activity,&QAbstractItemModel::rowsRemoved,this,&Controller::activityChanged);
    connect(&m_activity,&QAbstractItemModel::modelReset,this,&Controller::activityChanged);
    QFile f(m_root+"/assets/motions.json"); if(f.open(QIODevice::ReadOnly))m_animations=QJsonDocument::fromJson(f.readAll()).object().toVariantMap();
    m_director=MotionDirector(m_animations);m_reactionClock.start();
    connect(&m_socket,&QLocalSocket::readyRead,this,&Controller::receive);
    connect(&m_socket,&QLocalSocket::connected,this,[this]{m_retry.stop();m_buffer.clear();rpc("subscribe",{{"role",m_overlay?"overlay":"ui"}});emit stateChanged();});
    connect(&m_socket,&QLocalSocket::disconnected,this,[this]{stopRoaming(false);refreshMotion();emit stateChanged();m_retry.start(1500);});
    connect(&m_socket,&QLocalSocket::errorOccurred,this,[this]{m_retry.start(1500);emit stateChanged();});
    connect(&m_retry,&QTimer::timeout,this,&Controller::connectBroker);
    m_toastTimer.setSingleShot(true); connect(&m_toastTimer,&QTimer::timeout,this,[this]{m_toast.clear();emit toastChanged();});
    m_motionTimer.setSingleShot(true); connect(&m_motionTimer,&QTimer::timeout,this,&Controller::restoreMotion);
    m_idleTimer.setSingleShot(true);connect(&m_idleTimer,&QTimer::timeout,this,[this]{if(m_director.idle())publishMotion();});
    m_successTimer.setSingleShot(true);m_successTimer.setInterval(450);
    connect(&m_successTimer,&QTimer::timeout,this,[this]{
        const auto c=m_director.context();
        if(c.busy||c.waiting||c.problem)return;
        for(const auto &entry:m_state.value("sessions").toList()){
            const auto s=entry.toMap();
            if(s.value("id").toString()==m_successSession&&s.value("status").toString()=="idle")
                playMotion(m_successSession==m_tenderSession?"tender":"celebrate");
        }
    });
    m_roamTimer.setInterval(200);
    connect(&m_roamTimer,&QTimer::timeout,this,&Controller::roam);
    m_followTimer.setInterval(16);m_followTimer.setTimerType(Qt::PreciseTimer);
    connect(&m_followTimer,&QTimer::timeout,this,&Controller::followMouse);
    connect(qApp,&QGuiApplication::screenRemoved,this,[this]{stopRoaming(false);m_screen=nullptr;syncPet();refreshMotion();});
    connect(qApp,&QGuiApplication::screenAdded,this,[this]{syncPet();});
}
Controller::~Controller(){
    m_retry.stop();m_roamTimer.stop();m_followTimer.stop();m_motionTimer.stop();m_idleTimer.stop();m_toastTimer.stop();m_successTimer.stop();
    QObject::disconnect(&m_socket,nullptr,this,nullptr);
    if(m_overlayProcess){m_overlayProcess->terminate();m_overlayProcess->waitForFinished(2000);}
    if(m_panel)QObject::disconnect(m_panel,nullptr,this,nullptr);
    delete m_bubble;m_bubble=nullptr;delete m_panel;m_panel=nullptr;delete m_pet;m_pet=nullptr;
    m_socket.abort();
}
QString Controller::assetPath()const{return QUrl::fromLocalFile(m_root+"/assets/").toString();}
QString Controller::runtimePath()const{
    const QString override=qEnvironmentVariable("CERE_RUNTIME_DIR");if(!override.isEmpty())return override;
    return QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation)+"/cere";
}
void Controller::start(bool show){
    if(!m_overlay){
        // Broker is independent of the UI. Development launches use the same entry point as the service.
        bool managed=false;
        const auto userData=QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
        const bool installed=(m_root=="/usr/share/cere"&&QFile::exists("/usr/lib/systemd/user/cere-broker.service"))||
            (m_root==userData+"/cere"&&QFile::exists(userData+"/systemd/user/cere-broker.service"));
        if(installed&&qEnvironmentVariable("CERE_STATE_DIR").isEmpty()&&qEnvironmentVariable("CERE_RUNTIME_DIR").isEmpty()){
            QProcess environment;environment.start("systemctl",{"--user","import-environment","WAYLAND_DISPLAY","DISPLAY","HYPRLAND_INSTANCE_SIGNATURE"});environment.waitForFinished(2000);
            QProcess service;service.start("systemctl",{"--user","start","cere-broker.service"});managed=service.waitForFinished(3000)&&service.exitCode()==0;
        }
        if(!managed){QProcess broker;broker.setProgram(QStandardPaths::findExecutable("node"));broker.setArguments({m_root+"/broker/main.ts"});broker.setStandardOutputFile(QProcess::nullDevice());broker.setStandardErrorFile(QProcess::nullDevice());broker.startDetached();}
        m_overlayProcess=new QProcess(this);m_overlayProcess->setProgram(qEnvironmentVariable("CERE_HOST_EXEC",QCoreApplication::applicationFilePath()));
        m_overlayProcess->setArguments({"--overlay","--root",m_root});m_overlayProcess->setProcessChannelMode(QProcess::ForwardedChannels);m_overlayProcess->start();
        m_tray=new QSystemTrayIcon(QIcon(m_root+"/assets/cere-polished-icon.png"),this);m_tray->setToolTip("Cere · your desktop companion");
        auto menu=new QMenu();menu->addAction("Open Cere",this,[this]{expand();});menu->addAction("Show / hide",this,[this]{auto s=m_state.value("settings").toMap();rpc("settings.update",{{"hidden",!s.value("hidden").toBool()}});});
        menu->addAction("Pause AI actions",this,[this]{rpc("settings.update",{{"paused",true}});});
        menu->addSeparator();menu->addAction("Quit · keep sessions running",this,[this]{quit(false);});menu->addAction("Quit and stop sessions",this,[this]{quit(true);});
        m_tray->setContextMenu(menu);m_tray->show();connect(m_tray,&QSystemTrayIcon::activated,this,[this](auto reason){if(reason==QSystemTrayIcon::Trigger)expand();});
        if(show) QTimer::singleShot(500,this,[this]{showWorkspace();});
    }
    connectBroker();
}
void Controller::connectBroker(){if(m_socket.state()==QLocalSocket::ConnectedState||m_socket.state()==QLocalSocket::ConnectingState)return;m_socket.abort();m_socket.connectToServer(runtimePath()+"/broker.sock");}
int Controller::rpc(const QString &method,const QVariantMap &params){
    if(!connected()){notify("Cere is reconnecting to her session broker.");return -1;}
    const int id=++m_sequence;m_requests[id]=method;
    m_socket.write(QJsonDocument(QJsonObject{{"id",id},{"method",method},{"params",QJsonObject::fromVariantMap(params)}}).toJson(QJsonDocument::Compact)+'\n');return id;
}
void Controller::receive(){
    m_buffer+=m_socket.readAll();if(m_buffer.size()>16*1024*1024){m_socket.abort();return;}
    int newline;
    while((newline=m_buffer.indexOf('\n'))>=0){auto line=m_buffer.left(newline);m_buffer.remove(0,newline+1);auto object=QJsonDocument::fromJson(line).object();
        if(object.contains("id")){
            int id=object["id"].toInt();QString method=m_requests.take(id);
            if(object.contains("error")){notify(object["error"].toObject()["message"].toString());emit result(id,QVariantMap{{"error",object["error"].toObject()["message"].toString()}});continue;}
            auto value=object["result"].toVariant();
            if(method=="subscribe"||method=="state"){
                applyState(value.toMap());
                if(method=="subscribe"&&m_panel){
                    rpc("ui.panel",{{"owner",m_overlay?"overlay":"ui"},{"visible",m_panel->isVisible()&&m_panel->visibility()!=QWindow::Minimized}});
                    publishAttention();
                }
            }
            if(method=="session.messages"&&id==m_messagesRequest){m_messages=value.toList();m_transcript.reset(m_messages);emit messagesChanged();}
            if(method=="session.create")select(value.toMap().value("id").toString());
            emit result(id,value);
        }else{
            QString method=object["method"].toString();auto params=object["params"].toObject().toVariantMap();
            if(method=="state")applyState(params);
            if(method=="message")observeConversation(params);
            if(method=="message"&&params.value("sessionId").toString()==m_selected){bool found=false;for(auto &m:m_messages){if(m.toMap().value("id")==params.value("id")){m=params;found=true;break;}}if(!found)m_messages.append(params);m_transcript.upsert(params);emit messagesChanged();}
            if(method=="notice"){
                auto kind=params.value("kind").toString();notify(params.value("text").toString());
                // A background completion must not replace the work being watched.
                if(kind=="error"||kind=="interrupted"||kind=="approval")m_successTimer.stop();
                const auto reactionContext=m_director.context();
                if(kind=="complete"&&reactionContext.visible&&reactionContext.connected&&!reactionContext.busy&&!reactionContext.problem&&!reactionContext.waiting&&!reactionContext.dragging&&!reactionContext.quiet&&!reactionContext.reduced&&reactionContext.intensity>0){
                    // Allow adjacent terminal faults/new work to cancel the reaction.
                    m_successSession=params.value("sessionId").toString();m_successTimer.start();
                }
                else if(kind=="interrupted")playMotion("interrupted");
                else if(kind=="approval")playMotion("approval");
                else if(kind=="error")playMotion("error");
                else if(kind=="timer")playMotion("timer");
                if(m_tray&&!m_state.value("settings").toMap().value("quiet").toBool())m_tray->showMessage("Cere",params.value("text").toString(),QSystemTrayIcon::Information,5000);
            }
            if(method=="ui"){
                QString command=params.value("command").toString();bool top=m_state.value("settings").toMap().value("topmost",true).toBool();
                if(command=="expand"){if(m_overlay)closePanel();else showWorkspace();}
                if(command=="toggle"&&top==m_overlay)togglePanel();
                if(command=="animate"&&top==m_overlay)playMotion(params.value("name").toString());
                if(command=="attention"){
                    m_attention[params.value("owner").toString()]=params;
                    refreshMotion();
                }
                if(command=="panel"){
                    auto panels=m_state.value("panels").toMap();panels[params.value("owner").toString()]=params.value("visible");
                    m_state["panels"]=panels;refreshMotion();
                }
                if(command=="quit"&&!m_overlay)quit(params.value("stopTasks").toBool());
            }
        }
    }
}
void Controller::applyState(const QVariantMap &state){
    const auto before=m_director.context();
    const auto oldSettings=m_state.value("settings").toMap();
    m_state=state;
    m_attention=state.value("attention").toMap();
    if(m_selected.isEmpty()&&!state.value("sessions").toList().isEmpty())select(state.value("sessions").toList().first().toMap().value("id").toString());
    emit stateChanged();syncPet();
    refreshMotion();
    const auto after=m_director.context();
    if(!before.visible&&after.visible)playMotion("greeting");
    else if(!before.waiting&&after.waiting)playMotion("approval");
    else if(!before.busy&&after.busy)playMotion("send");
    else if((before.quiet||before.reduced)&&!after.quiet&&!after.reduced)playMotion("wake");
    else if(!oldSettings.isEmpty()&&oldSettings.value("scale")!=state.value("settings").toMap().value("scale"))playMotion("resize");
}
QVariantMap Controller::session()const{for(auto s:m_state.value("sessions").toList())if(s.toMap().value("id").toString()==m_selected)return s.toMap();return {};}
void Controller::select(const QString &id){if(m_selected==id)return;m_selected=id;m_messages.clear();m_transcript.reset({});emit messagesChanged();emit stateChanged();if(!id.isEmpty())m_messagesRequest=rpc("session.messages",{{"id",id}});publishAttention();refreshMotion();}
QQuickView *Controller::view(const QString &file,bool layer,const QString &title){
    auto v=new QQuickView();v->setColor(Qt::transparent);v->setResizeMode(QQuickView::SizeRootObjectToView);v->setTitle(title);
    v->rootContext()->setContextProperty("App",this);
    if(layer&&qGuiApp->platformName().startsWith("wayland")){
        auto shell=LayerShellQt::Window::get(v);shell->setScope(title=="Cere Pet"?"cere-pet":title=="Cere Approval"?"cere-approval":"cere-panel");shell->setLayer(LayerShellQt::Window::LayerOverlay);shell->setExclusiveZone(-1);
        shell->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorTop)|LayerShellQt::Window::AnchorLeft);
        shell->setKeyboardInteractivity(title=="Cere Pet"?LayerShellQt::Window::KeyboardInteractivityNone:LayerShellQt::Window::KeyboardInteractivityOnDemand);
        shell->setActivateOnShow(title!="Cere Pet"&&title!="Cere Approval");shell->setCloseOnDismissed(false);
    }else if(title=="Cere Pet")v->setFlags(Qt::Tool|Qt::FramelessWindowHint|Qt::WindowDoesNotAcceptFocus);
    else if(title=="Cere Panel"||title=="Cere Approval")v->setFlags(Qt::Tool|Qt::FramelessWindowHint);
    v->setSource(QUrl::fromLocalFile(m_root+"/qml/"+file));
    if(title=="Cere"||title=="Cere Panel")connect(v,&QWindow::visibilityChanged,this,[this,v]{
        if(connected())rpc("ui.panel",{{"owner",m_overlay?"overlay":"ui"},{"visible",v->isVisible()&&v->visibility()!=QWindow::Minimized}});
        publishAttention();
        refreshMotion();
    });
    return v;
}
void Controller::syncPet(){
    if(m_state.isEmpty())return;const auto s=m_state.value("settings").toMap();const bool top=s.value("topmost",true).toBool();
    const bool visible=top==m_overlay&&!s.value("hidden").toBool();
    if(!visible){if(m_pet)m_pet->hide();if(m_panel&&!m_expanded)m_panel->hide();return;}
    if(!m_pet)m_pet=view("Pet.qml",m_overlay,"Cere Pet");
    qreal scale=s.value("scale",1).toDouble();
    const QSize petSize(qRound(192*scale),qRound(208*scale));
    m_pet->setMinimumSize(petSize);m_pet->setMaximumSize(petSize);m_pet->resize(petSize);
    const auto p=s.value("position").toMap();
    if(!m_screen){for(auto screen:qGuiApp->screens())if(screen->name()==p.value("output").toString())m_screen=screen;if(!m_screen)m_screen=qGuiApp->screenAt(cursorPosition());if(!m_screen)m_screen=qGuiApp->primaryScreen();}
    QScreen *target=m_screen;if(!target)return;
    if(!m_dragging&&!m_roamStep)for(auto screen:qGuiApp->screens())if(screen->name()==p.value("output").toString())target=screen;
    auto g=target->geometry();
    if(!m_dragging&&!m_roamStep)placePet(g.topLeft()+QPoint(qRound(p.value("x",.86).toDouble()*std::max(0,g.width()-m_pet->width())),qRound(p.value("y",.78).toDouble()*std::max(0,g.height()-m_pet->height()))),target,false);
    updateMask();if(!m_pet->isVisible()){m_pet->show();if(!m_overlay&&qGuiApp->platformName().startsWith("wayland")){
        QTimer::singleShot(150,this,[this]{hyprDispatch("hl.dsp.window.float({window=\"title:^Cere Pet$\",action=\"set\"})","setfloating title:^Cere Pet$");placePet(m_petPosition,m_screen,false);});
    }}
}
void Controller::updateMask(){
    if(!m_pet||m_maskSize==m_pet->size())return;
    m_maskSize=m_pet->size();
    // This is an input region only, never a visual cutout. Include the envelope
    // of every pose/transform so animated hair and outstretched hands stay clickable.
    QHash<QString,QImage> sheets;
    QImage mask(192,208,QImage::Format_ARGB32_Premultiplied);mask.fill(Qt::transparent);
    QPainter painter(&mask);
    for(const auto &value:m_animations.value("frames").toList()){
        const auto f=value.toMap();
        const auto texture=f.value("texture",m_animations.value("texture")).toString();
        if(!sheets.contains(texture))sheets[texture]=QImage(m_root+"/assets/"+texture);
        const auto &sheet=sheets[texture];
        const QRect source(f.value("x").toInt(),f.value("y").toInt(),f.value("width").toInt(),f.value("height").toInt());
        const QSizeF size=QSizeF(source.size()).scaled(QSizeF(172.8,187.2),Qt::KeepAspectRatio);
        for(int angle:{-5,0,5}){
            painter.save();painter.translate(96,206);painter.rotate(angle);painter.scale(1.035,1.035);
            painter.drawImage(QRectF(-size.width()/2,-size.height(),size.width(),size.height()),sheet,source);painter.restore();
        }
    }
    painter.end();
    mask=mask.scaled(m_pet->width(),m_pet->height(),Qt::IgnoreAspectRatio,Qt::SmoothTransformation);
    QRegion region;
    for(int y=0;y<mask.height();++y){
        int start=-1;
        for(int x=0;x<=mask.width();++x){
            bool on=x<mask.width()&&qAlpha(mask.pixel(x,y))>40;
            if(on&&start<0)start=x;
            if(!on&&start>=0){region+=QRect(start,y,x-start,1);start=-1;}
        }
    }
    const int margin=std::max(2,qRound(m_pet->width()/192.*5));
    region=region.united(region.translated(-margin,0)).united(region.translated(margin,0));
    region=region.united(region.translated(0,-margin)).united(region.translated(0,margin));
    region+=QRect(m_pet->width()-qRound(m_pet->width()*.07)-29,0,29,27);
    m_pet->setMask(region.intersected(QRect(QPoint(0,0),m_pet->size())));
}
void Controller::placePet(QPoint global,QScreen *screen,bool persist){
    if(!m_pet||!screen)return;auto g=screen->geometry();
    global.setX(std::clamp(global.x(),g.left(),g.left()+std::max(0,g.width()-m_pet->width())));
    global.setY(std::clamp(global.y(),g.top(),g.top()+std::max(0,g.height()-m_pet->height())));
    if(m_screen!=screen){m_pet->hide();m_screen=screen;}
    m_petPosition=global;m_pet->setScreen(screen);
    if(m_overlay&&qGuiApp->platformName().startsWith("wayland")){
        auto shell=LayerShellQt::Window::get(m_pet);shell->setScreen(screen);shell->setDesiredSize(m_pet->size());shell->setMargins(QMargins(global.x()-g.x(),global.y()-g.y(),0,0));
    }else {m_pet->setPosition(global);if(m_pet->isVisible()&&qGuiApp->platformName().startsWith("wayland"))hyprDispatch(QString("hl.dsp.window.move({window=\"title:^Cere Pet$\",x=%1,y=%2,relative=false})").arg(global.x()).arg(global.y()).toUtf8(),QString("movewindowpixel exact %1 %2,title:^Cere Pet$").arg(global.x()).arg(global.y()).toUtf8());}
    if(persist){QVariantMap p{{"output",screen->name()},{"x",double(global.x()-g.x())/std::max(1,g.width()-m_pet->width())},{"y",double(global.y()-g.y())/std::max(1,g.height()-m_pet->height())}};rpc("settings.update",{{"position",p}});}
    if(m_panel&&m_panel->isVisible()&&!m_expanded)positionPanel();
    if(m_bubble&&m_bubble->isVisible())positionApprovalBubble();
}
QPoint Controller::cursorPosition()const{
    // Qt's Wayland global cursor is surface-relative; Hyprland provides authoritative output coordinates.
    auto o=QJsonDocument::fromJson(hyprQuery("j/cursorpos")).object();if(o.contains("x"))return {o["x"].toInt(),o["y"].toInt()};return QCursor::pos();
}
void Controller::beginDrag(qreal x,qreal y){stopRoaming(false);m_dragging=true;m_dragOffset={qRound(x),qRound(y)};closePanel();refreshMotion();}
void Controller::drag(qreal,qreal){if(!m_dragging||!m_pet)return;auto cursor=cursorPosition();auto screen=qGuiApp->screenAt(cursor);if(!screen)screen=m_screen;placePet(cursor-m_dragOffset,screen,false);m_pet->show();}
void Controller::endDrag(){if(!m_dragging)return;m_dragging=false;placePet(m_petPosition,m_screen,true);refreshMotion();playMotion("land");}
void Controller::setPetInteracting(bool interacting){m_petInteracting=interacting;refreshMotion();}
void Controller::setListening(bool listening){if(m_listening==listening)return;m_listening=listening;publishAttention();refreshMotion();}
void Controller::publishAttention(){
    if(!connected())return;
    const bool visible=m_panel&&m_panel->isVisible()&&m_panel->visibility()!=QWindow::Minimized;
    rpc("ui.attention",{{"owner",m_overlay?"overlay":"ui"},{"sessionId",m_selected},{"listening",m_listening&&visible}});
}
void Controller::resizePet(qreal factor){rpc("settings.update",{{"scale",std::clamp(factor,.5,3.)}});}
void Controller::togglePanel(){
    if(m_panel&&m_panel->isVisible()){closePanel();return;}
    if(m_panel&&m_expanded){delete m_panel;m_panel=nullptr;}
    m_expanded=false;if(!m_panel)m_panel=view("Panel.qml",m_overlay,"Cere Panel");
    stopRoaming(true);
    m_panel->resize(440,std::min(720,m_screen?m_screen->availableGeometry().height()-40:720));positionPanel();m_panel->show();m_panel->requestActivate();refreshMotion();preview("listen");
}
void Controller::positionPanel(){if(!m_panel||m_expanded||!m_screen)return;auto g=m_screen->geometry();int x=m_petPosition.x()-m_panel->width()-12;if(x<g.x()+12)x=m_petPosition.x()+(m_pet?m_pet->width():192)+12;x=std::clamp(x,g.x()+12,g.right()-m_panel->width()-12);int y=std::clamp(m_petPosition.y()-m_panel->height()+160,g.y()+40,g.bottom()-m_panel->height()-12);m_panel->setScreen(m_screen);
    if(m_overlay&&qGuiApp->platformName().startsWith("wayland")){auto shell=LayerShellQt::Window::get(m_panel);shell->setScreen(m_screen);shell->setDesiredSize(m_panel->size());shell->setMargins({x-g.x(),y-g.y(),0,0});}else m_panel->setPosition(x,y);
}
void Controller::syncApprovalBubble(){
    const auto panels=m_state.value("panels").toMap();
    const bool ownPanel=m_panel&&m_panel->isVisible()&&m_panel->visibility()!=QWindow::Minimized;
    const bool show=connected()&&m_pet&&m_pet->isVisible()&&!m_dragging
        &&!ownPanel&&!panels.value(m_overlay?"ui":"overlay").toBool()
        &&!m_state.value("approvals").toList().isEmpty();
    if(!show){if(m_bubble)m_bubble->hide();return;}
    if(!m_bubble){
        m_bubble=view("ApprovalBubble.qml",m_overlay,"Cere Approval");
        m_bubble->setTransientParent(m_pet);
        // A compositor close/minimize must not strand an unresolved request.
        // Queue this so intentional hides can finish updating panel visibility first.
        connect(m_bubble,&QWindow::visibilityChanged,this,[this]{
            QTimer::singleShot(0,this,&Controller::syncApprovalBubble);
        });
        if(m_bubble->rootObject())connect(m_bubble->rootObject(),&QQuickItem::implicitHeightChanged,this,&Controller::positionApprovalBubble);
    }
    positionApprovalBubble();
    if(!m_bubble->isVisible()||m_bubble->visibility()==QWindow::Minimized){
        m_bubble->showNormal();
        if(!m_overlay&&qGuiApp->platformName().startsWith("wayland"))QTimer::singleShot(100,this,[this]{
            if(!m_bubble||!m_bubble->isVisible())return;
            hyprDispatch("hl.dsp.window.float({window=\"title:^Cere Approval$\",action=\"set\"})","setfloating title:^Cere Approval$");
            positionApprovalBubble();
        });
    }
}
void Controller::positionApprovalBubble(){
    if(!m_bubble||!m_screen||!m_bubble->rootObject())return;
    const auto g=m_screen->availableGeometry().adjusted(12,12,-12,-12);
    const int w=std::min(392,g.width());
    const int h=std::min(qRound(m_bubble->rootObject()->implicitHeight()),g.height());
    m_bubble->setMinimumSize({w,h});m_bubble->setMaximumSize({w,h});m_bubble->resize(w,h);
    const bool onLeft=m_petPosition.x()-g.left()>=w||g.right()-m_petPosition.x()-m_pet->width()<w;
    const int x=std::clamp(onLeft?m_petPosition.x()-w:m_petPosition.x()+m_pet->width(),g.left(),g.left()+g.width()-w);
    const int head=m_petPosition.y()+qRound(m_pet->height()*.3);
    const int y=std::clamp(head-h/2,g.top(),g.top()+g.height()-h);
    m_bubble->rootObject()->setProperty("tailOnRight",onLeft);
    m_bubble->rootObject()->setProperty("tailY",std::clamp(head-y,24,std::max(24,h-24)));
    m_bubble->setScreen(m_screen);
    if(m_overlay&&qGuiApp->platformName().startsWith("wayland")){
        auto shell=LayerShellQt::Window::get(m_bubble);shell->setScreen(m_screen);shell->setDesiredSize({w,h});
        const auto origin=m_screen->geometry().topLeft();shell->setMargins({x-origin.x(),y-origin.y(),0,0});
    }else{
        m_bubble->setPosition(x,y);
        if(m_bubble->isVisible()&&qGuiApp->platformName().startsWith("wayland"))hyprDispatch(QString("hl.dsp.window.move({window=\"title:^Cere Approval$\",x=%1,y=%2,relative=false})").arg(x).arg(y).toUtf8(),QString("movewindowpixel exact %1 %2,title:^Cere Approval$").arg(x).arg(y).toUtf8());
    }
}
void Controller::closePanel(){if(m_panel)m_panel->hide();refreshMotion();}
void Controller::restorePanel(){if(!m_panel){togglePanel();return;}m_panel->show();m_panel->requestActivate();refreshMotion();}
void Controller::expand(){rpc("ui.expand");}
void Controller::showWorkspace(){stopRoaming(true);if(m_panel&&!m_expanded){delete m_panel;m_panel=nullptr;}m_expanded=true;if(!m_panel){m_panel=view("Workspace.qml",false,"Cere");m_panel->resize(1040,780);m_panel->setMinimumSize({720,580});connect(m_panel,&QWindow::visibleChanged,this,[this]{refreshMotion();});}m_panel->show();m_panel->requestActivate();refreshMotion();preview("listen");}
void Controller::copy(const QString &text){QGuiApplication::clipboard()->setText(text);notify("Copied to clipboard");preview("copy");}
void Controller::openPath(const QString &path){QDesktopServices::openUrl(QUrl::fromLocalFile(path));}
void Controller::formatMessage(QQuickTextDocument *quickDocument){
    if(!quickDocument)return;
    auto document=quickDocument->textDocument();
    QTextCursor edit(document);edit.beginEditBlock();
    for(auto block=document->begin();block.isValid();block=block.next()){
        auto format=block.blockFormat();
        const bool code=format.hasProperty(QTextFormat::BlockCodeFence)||format.hasProperty(QTextFormat::BlockCodeLanguage);
        format.setTopMargin(block==document->begin()?0:code||block.textList()?2:format.headingLevel()?12:8);
        format.setBottomMargin(code?2:0);
        if(code){format.setBackground(QColor("#0d131c"));format.setLeftMargin(8);format.setRightMargin(8);}
        QTextCursor cursor(block);cursor.setBlockFormat(format);
    }
    edit.endEditBlock();
}
void Controller::openMessageLink(const QString &link,const QString &directory){
    if(link.startsWith('#'))return;
    const auto url=QUrl::fromLocalFile(QDir(directory).absolutePath()+"/").resolved(QUrl(link));
    const auto scheme=url.scheme().toLower();
    if(url.isValid()&&(scheme=="https"||scheme=="http"||scheme=="mailto"||(scheme=="file"&&url.isLocalFile())))QDesktopServices::openUrl(url);
}
QString Controller::chooseFolder(){return QFileDialog::getExistingDirectory(nullptr,"Choose a trusted project folder",QDir::homePath());}
QString Controller::chooseImage(){return QFileDialog::getOpenFileName(nullptr,"Attach an image",QDir::homePath(),"Images (*.png *.jpg *.jpeg *.webp)");}
QString Controller::chooseFile(){return QFileDialog::getOpenFileName(nullptr,"Open a local file",QDir::homePath());}
void Controller::notify(const QString &text){m_toast=text;emit toastChanged();m_toastTimer.start(8000);}
void Controller::quit(bool stopTasks){if(m_overlay){rpc("ui.quit",{{"stopTasks",stopTasks}});return;}if(stopTasks)for(auto s:m_state.value("sessions").toList())rpc("session.stop",{{"id",s.toMap().value("id")}});m_socket.flush();QTimer::singleShot(150,qApp,&QCoreApplication::quit);}
void Controller::refreshMotion(){
    syncApprovalBubble();
    const auto settings=m_state.value("settings").toMap();
    MotionDirector::Context context;
    context.visible=m_pet&&m_pet->isVisible()&&!settings.value("hidden").toBool()&&settings.value("topmost",true).toBool()==m_overlay;
    context.quiet=settings.value("quiet").toBool();context.reduced=settings.value("reducedMotion").toBool();
    context.intensity=settings.value("motionIntensity",.7).toDouble();
    context.connected=connected();context.dragging=m_dragging;
    context.waiting=!m_state.value("approvals").toList().isEmpty();
    const auto panels=m_state.value("panels").toMap();
    context.panel=m_petInteracting||(m_panel&&m_panel->isVisible())||panels.value(m_overlay?"ui":"overlay").toBool();
    for(const auto &s:m_state.value("sessions").toList())
        if(QStringList{"working","starting","stopping"}.contains(s.toMap().value("status").toString()))context.busy=true;
    const auto focus=actingSession();
    for(const auto &entry:m_state.value("sessions").toList()){
        const auto s=entry.toMap();if(s.value("id").toString()!=focus)continue;
        if(QStringList{"working","starting"}.contains(s.value("status").toString()))context.activity=s.value("activity","thinking").toString();
        context.problem=s.value("status").toString()=="error";
    }
    const bool ownPanel=m_panel&&m_panel->isVisible()&&m_panel->visibility()!=QWindow::Minimized;
    const auto other=m_attention.value(m_overlay?"ui":"overlay").toMap();
    context.listening=(ownPanel&&m_listening)||(panels.value(m_overlay?"ui":"overlay").toBool()&&other.value("listening").toBool());
    const bool canFollow=context.visible&&context.connected&&!context.quiet&&!context.reduced&&context.intensity>0&&!context.waiting&&!context.busy&&!context.dragging&&!context.panel&&settings.value("roaming").toBool();
    if(!canFollow){
        m_roamTimer.stop();m_followTimer.stop();
    }
    if(m_roamStep&&!canFollow){
        m_follower.reset(m_petPosition);m_roamStep=false;
        if(!context.dragging&&context.connected)placePet(m_petPosition,m_screen,true);
    }
    context.roaming=m_roamStep;context.roamLeft=m_roamLeft;
    if(!context.visible||!context.connected||context.quiet||context.reduced||context.intensity<=0||context.busy||context.waiting||context.problem||context.dragging)m_successTimer.stop();
    m_director.setContext(context);publishMotion();
    if(canFollow&&!m_roamTimer.isActive())m_roamTimer.start();
}
QString Controller::actingSession() const {
    if(m_panel&&m_panel->isVisible()&&m_panel->visibility()!=QWindow::Minimized)return m_selected;
    const auto owner=m_overlay?"ui":"overlay";
    if(m_state.value("panels").toMap().value(owner).toBool()){
        const auto id=m_attention.value(owner).toMap().value("sessionId").toString();
        if(!id.isEmpty())return id;
    }
    // Without an open conversation, attend to the most recently updated live task.
    for(const auto &entry:m_state.value("sessions").toList()){
        const auto s=entry.toMap();
        if(QStringList{"starting","working","waiting","stopping"}.contains(s.value("status").toString()))return s.value("id").toString();
    }
    return m_selected;
}
void Controller::observeConversation(const QVariantMap &message){
    const auto sid=message.value("sessionId").toString(),id=message.value("id").toString();
    const auto role=message.value("role").toString();
    if(sid!=actingSession()||(role!="user"&&role!="assistant")||m_cuedMessages.value(sid)==id)return;
    const auto settings=m_state.value("settings").toMap();
    if(!settings.value("expressiveCues",true).toBool())return;
    const auto cue=MotionDirector::conversationalCue(message.value("text").toString(),role=="user");
    if(role=="user")m_tenderSession=cue=="tender"?sid:QString();
    if(cue.isEmpty())return;
    if(cue=="tender")m_tenderSession=sid;
    // Never accumulate hidden reactions or repeat a cue for every streaming delta.
    if(m_cuedMessages.size()>128)m_cuedMessages.clear();
    m_cuedMessages[sid]=id;
    const auto context=m_director.context();
    if(!context.visible||context.quiet||context.reduced||context.intensity<=0||context.waiting||context.problem)return;
    const auto now=m_reactionClock.elapsed();
    if(m_lastReaction.contains("conversation")&&now-m_lastReaction.value("conversation")<8000)return;
    m_lastReaction["conversation"]=now;
    playMotion(cue);
}
void Controller::publishMotion(){
    if(m_motionRevision!=m_director.revision()||m_motion!=m_director.name()){
        m_motionRevision=m_director.revision();m_motion=m_director.name();m_motionToken=m_motionRevision;
        m_motionTimer.stop();
        if(m_director.duration()>0)m_motionTimer.start(m_director.duration());
        emit motionChanged();
    }
    if(m_director.canIdle()){
        if(!m_idleTimer.isActive())m_idleTimer.start(m_director.nextIdleDelay());
    }else m_idleTimer.stop();
}
void Controller::playMotion(const QString &motion){
    const auto now=m_reactionClock.elapsed();
    const int cooldown=motion=="attentive"?6000:motion=="resize"?600:motion=="music"?3000:250;
    if(m_lastReaction.contains(motion)&&now-m_lastReaction.value(motion)<cooldown)return;
    if(m_director.play(motion)){m_lastReaction[motion]=now;publishMotion();}
}
void Controller::restoreMotion(){m_director.finish(m_motionToken);refreshMotion();}
void Controller::preview(const QString &state){
    if(!m_animations.value("clips").toMap().contains(state))return;
    if(m_state.value("settings").toMap().value("topmost",true).toBool()==m_overlay)playMotion(state);
    else rpc("ui.animate",{{"name",state}});
}
void Controller::stopRoaming(bool persist){
    m_followTimer.stop();m_follower.reset(m_petPosition);
    if(!m_roamStep)return;
    m_roamStep=false;
    if(persist&&connected())placePet(m_petPosition,m_screen,true);
    refreshMotion();
}
void Controller::roam(){
    auto s=m_state.value("settings").toMap();
    if((!m_director.canIdle()&&!m_roamStep)||!s.value("roaming").toBool()||!m_screen||!m_pet)return;
    const auto active=QJsonDocument::fromJson(hyprQuery("j/activewindow")).object();
    if(active["fullscreen"].toInt()!=0){stopRoaming(true);return;}
    m_followCursor=cursorPosition();m_followScreen=qGuiApp->screenAt(m_followCursor);
    if(!m_followScreen){stopRoaming(true);return;}
    if(!m_followTimer.isActive()){
        m_follower.reset(m_petPosition);m_followClock.start();
        // Only animate when there is distance to cover. Stationary pets sample
        // the pointer at 5 Hz instead of running a permanent frame timer.
        if(!m_follower.advance(m_followCursor,m_pet->size(),m_followScreen->geometry(),0))return;
        m_roamLeft=m_followCursor.x()<m_petPosition.x()+m_pet->width()/2;
        m_roamStep=true;refreshMotion();m_followTimer.start();
    }
}
void Controller::followMouse(){
    if(!m_followScreen||!m_screen||!m_pet){stopRoaming(false);return;}
    const bool moving=m_follower.advance(m_followCursor,m_pet->size(),m_followScreen->geometry(),m_followClock.restart()/1000.);
    const QPoint position=m_follower.position().toPoint();
    const QPoint center=position+QPoint(m_pet->width()/2,m_pet->height()/2);
    QScreen *screen=qGuiApp->screenAt(center);if(!screen)screen=m_screen;
    if(position!=m_petPosition||screen!=m_screen){placePet(position,screen,false);m_pet->show();}
    if(!moving){stopRoaming(true);playMotion("land");return;}
    if(std::abs(m_follower.velocity().x())>2){
        const bool left=m_follower.velocity().x()<0;
        if(left!=m_roamLeft){m_roamLeft=left;refreshMotion();}
    }
}
bool Controller::autostartEnabled()const{return QFile::exists(QStandardPaths::writableLocation(QStandardPaths::ConfigLocation)+"/autostart/cere.desktop");}
void Controller::setAutostart(bool enabled){QString dir=QStandardPaths::writableLocation(QStandardPaths::ConfigLocation)+"/autostart";QString path=dir+"/cere.desktop";if(!enabled){QFile::remove(path);return;}QDir().mkpath(dir);QSaveFile file(path);if(!file.open(QIODevice::WriteOnly)){notify("Could not update login startup");return;}QString exe=QCoreApplication::applicationFilePath();file.write(QString("[Desktop Entry]\nType=Application\nName=Cere\nExec=\"%1\" --root \"%2\"\nIcon=cere\nTerminal=false\n").arg(exe,m_root).toUtf8());file.commit();}
