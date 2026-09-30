#include "controller.h"
#include "avatarpuppet.h"
#include <qqml.h>
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
#include <QFileInfo>
#include <algorithm>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include "placement.h"

bool Controller::trustedBroker(qintptr descriptor,uint expectedUid){
    struct ucred peer{};socklen_t length=sizeof(peer);
    return descriptor>=0&&::getsockopt(int(descriptor),SOL_SOCKET,SO_PEERCRED,&peer,&length)==0&&length==sizeof(peer)&&peer.uid==expectedUid;
}
// Mirrors the broker's check: the directory is a real directory owned by this user,
// and no ancestor lets another user rename a component away (writable ancestors must
// be sticky, and every component must be owned by root or this user).
bool Controller::privateRuntime(const QString &path){
    const uid_t uid=::getuid();
    const QString canonical=QFileInfo(path).canonicalFilePath();
    struct stat leaf{};
    if(canonical.isEmpty()||::lstat(QFile::encodeName(path).constData(),&leaf)!=0||S_ISLNK(leaf.st_mode)||!S_ISDIR(leaf.st_mode)||leaf.st_uid!=uid)return false;
    QString current=canonical;
    while(current!="/"&&!current.isEmpty()){
        const QString parent=QFileInfo(current).path();
        struct stat item{},container{};
        if(::lstat(QFile::encodeName(current).constData(),&item)!=0||::lstat(QFile::encodeName(parent).constData(),&container)!=0)return false;
        if(item.st_uid!=0&&item.st_uid!=uid)return false;
        if((container.st_mode&(S_IWGRP|S_IWOTH))&&!(container.st_mode&S_ISVTX))return false;
        current=parent;
    }
    return true;
}
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
    static const int avatarType=qmlRegisterType<AvatarPuppet>("Cere.Native",1,0,"AvatarPuppet");
    Q_UNUSED(avatarType);
    m_replies.setSourceModel(&m_transcript);m_activity.setSourceModel(&m_transcript);
    connect(&m_activity,&QAbstractItemModel::rowsInserted,this,&Controller::activityChanged);
    connect(&m_activity,&QAbstractItemModel::rowsRemoved,this,&Controller::activityChanged);
    connect(&m_activity,&QAbstractItemModel::modelReset,this,&Controller::activityChanged);
    QFile f(m_root+"/assets/motions.json"); if(f.open(QIODevice::ReadOnly))m_animations=QJsonDocument::fromJson(f.readAll()).object().toVariantMap();
    QFile rigFile(m_root+"/assets/"+m_animations.value("rig","cere-rig.json").toString());
    if(rigFile.open(QIODevice::ReadOnly))m_animations.insert("puppet",QJsonDocument::fromJson(rigFile.readAll()).object().toVariantMap());
    m_director=MotionDirector(m_animations);m_reactionClock.start();
    connect(&m_socket,&QLocalSocket::readyRead,this,&Controller::receive);
    connect(&m_socket,&QLocalSocket::connected,this,[this]{
        m_retry.stop();m_buffer.clear();
        // Authenticate the server before any request is written: a socket owned by
        // another user is never treated as Cere's broker.
        if(!trustedBroker(m_socket.socketDescriptor(),::getuid())){
            m_socket.abort();notify("Cere refused a broker socket owned by another user.");m_retry.start(1500);return;
        }
        rpc("subscribe",{{"role",m_overlay?"overlay":"ui"}});emit stateChanged();
    });
    connect(&m_socket,&QLocalSocket::disconnected,this,[this]{
        // Every request in flight ends exactly once; none is replayed, since its
        // outcome is unknown. Framing restarts with the next connection.
        m_buffer.clear();failPendingRequests("Connection lost; the operation outcome was not confirmed.");
        stopRoaming(false);refreshMotion();emit stateChanged();m_retry.start(1500);
    });
    connect(&m_socket,&QLocalSocket::errorOccurred,this,[this]{m_retry.start(1500);emit stateChanged();});
    connect(&m_retry,&QTimer::timeout,this,&Controller::connectBroker);
    m_toastTimer.setSingleShot(true); connect(&m_toastTimer,&QTimer::timeout,this,[this]{m_toast.clear();emit toastChanged();});
    m_motionTimer.setTimerType(Qt::PreciseTimer);m_motionTimer.setSingleShot(true); connect(&m_motionTimer,&QTimer::timeout,this,&Controller::restoreMotion);
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
    connect(qApp,&QGuiApplication::screenRemoved,this,[this]{stopRoaming(false);m_screen=nullptr;syncPet();refreshMotion();});
    connect(qApp,&QGuiApplication::screenAdded,this,[this]{syncPet();});
}
Controller::~Controller(){
    m_retry.stop();m_roamTimer.stop();m_motionTimer.stop();m_idleTimer.stop();m_toastTimer.stop();m_successTimer.stop();
    QObject::disconnect(&m_socket,nullptr,this,nullptr);
    if(m_overlayProcess){m_overlayProcess->terminate();m_overlayProcess->waitForFinished(2000);}
    if(m_panel)QObject::disconnect(m_panel,nullptr,this,nullptr);
    delete m_petMirror;
    delete m_bubble;m_bubble=nullptr;delete m_panel;m_panel=nullptr;delete m_pet;m_pet=nullptr;
    m_socket.abort();
}
QString Controller::assetPath()const{return QUrl::fromLocalFile(m_root+"/assets/").toString();}
// The same resolution as the broker's paths(), including its private /tmp fallback.
QString Controller::runtimePath()const{
    const QString override=qEnvironmentVariable("CERE_RUNTIME_DIR");if(!override.isEmpty())return QDir(override).absolutePath();
    const QString runtime=qEnvironmentVariable("XDG_RUNTIME_DIR");
    return (runtime.isEmpty()?QDir::tempPath()+"/cere-"+QString::number(::getuid()):runtime)+"/cere";
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
        m_tray=new QSystemTrayIcon(QIcon(m_root+"/assets/cere-emblem.png"),this);m_tray->setToolTip("Cere · your desktop companion");
        auto menu=new QMenu();menu->addAction("Open Cere",this,[this]{expand();});menu->addAction("Show / hide",this,[this]{auto s=m_state.value("settings").toMap();rpc("settings.update",{{"hidden",!s.value("hidden").toBool()}});});
        menu->addAction("Pause AI actions",this,[this]{rpc("settings.update",{{"paused",true}});});
        menu->addAction("Disable remote access now",this,[this]{rpc("remote.off",{});});
        menu->addSeparator();menu->addAction("Quit · keep sessions running",this,[this]{quit(false);});menu->addAction("Quit and stop sessions",this,[this]{quit(true);});
        m_tray->setContextMenu(menu);m_tray->show();connect(m_tray,&QSystemTrayIcon::activated,this,[this](auto reason){if(reason==QSystemTrayIcon::Trigger)expand();});
        if(show) QTimer::singleShot(500,this,[this]{showWorkspace();});
    }
    connectBroker();
}
void Controller::connectBroker(){
    if(m_socket.state()==QLocalSocket::ConnectedState||m_socket.state()==QLocalSocket::ConnectingState)return;
    const auto runtime=runtimePath();
    if(QFileInfo::exists(runtime)&&!privateRuntime(runtime)){notify("Cere's runtime directory is not private to you; refusing to connect.");m_retry.start(5000);return;}
    m_socket.abort();m_socket.connectToServer(runtime+"/broker.sock");
}
void Controller::failPendingRequests(const QString &message){
    const auto pending=std::exchange(m_requests,{});
    m_messagesRequest=-1;m_olderRequest=-1;m_copies.clear();m_liveMessages.clear();
    for(auto it=pending.cbegin();it!=pending.cend();++it)emit result(it.key(),QVariantMap{{"error",message},{"code","CONNECTION_LOST"}});
}
// Refetches the newest transcript page without clearing the selection or composer.
void Controller::reloadMessages(){
    m_liveMessages.clear();
    m_messagesRequest=m_selected.isEmpty()?-1:rpc("session.messages",{{"id",m_selected}});
}
void Controller::loadOlderMessages(){
    if(m_olderCursor<=0||m_olderRequest>=0||m_selected.isEmpty())return;
    m_olderRequest=rpc("session.messages",{{"id",m_selected},{"before",m_olderCursor}});
}
// Copies the complete stored text; a display copy may be shortened for transport.
void Controller::copyMessage(const QString &messageId){
    copySessionMessage(m_selected,messageId);
}
void Controller::copySessionMessage(const QString &sessionId,const QString &messageId){
    const int id=rpc("session.messageText",{{"id",sessionId},{"messageId",messageId},{"offset",0}});
    if(id>=0)m_copies[id]={{"messageId",messageId},{"sessionId",sessionId},{"text",QString()}};
}
void Controller::openCompletion(const QString &completionId){
    for(const auto &entry:m_state.value("completions").toList()){
        const auto completion=entry.toMap();
        if(completion.value("id").toString()!=completionId)continue;
        select(completion.value("sessionId").toString());
        restorePanel();
        if(m_panel&&m_panel->rootObject())m_panel->rootObject()->setProperty("page",0);
        rpc("completion.dismiss",{{"id",completionId}});
        return;
    }
}
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
            if(object.contains("error")){
                const auto error=object["error"].toObject();
                if(id==m_messagesRequest)m_messagesRequest=-1;
                if(id==m_olderRequest)m_olderRequest=-1;
                m_copies.remove(id);
                notify(error["message"].toString());emit result(id,QVariantMap{{"error",error["message"].toString()},{"code",error["code"].toString()}});continue;
            }
            auto value=object["result"].toVariant();
            if(method=="subscribe"||method=="state"){
                applyState(value.toMap());
                if(method=="subscribe"){
                    // A (re)subscription recovers the selected transcript, which the
                    // snapshot does not carry, without disturbing selection or drafts.
                    bool present=false;
                    for(const auto &s:m_state.value("sessions").toList())if(s.toMap().value("id").toString()==m_selected)present=true;
                    if(!present&&!m_selected.isEmpty()){
                        const auto sessions=m_state.value("sessions").toList();
                        const auto next=sessions.isEmpty()?QString():sessions.first().toMap().value("id").toString();
                        m_selected=QStringLiteral("\u0001");select(next);
                    }else reloadMessages();
                }
                if(method=="subscribe"&&m_panel){
                    rpc("ui.panel",{{"owner",m_overlay?"overlay":"ui"},{"visible",m_panel->isVisible()&&m_panel->visibility()!=QWindow::Minimized}});
                    publishAttention();
                }
            }
            if(method=="session.messages"&&id==m_messagesRequest){
                m_messagesRequest=-1;
                const auto page=value.toMap();
                QVariantList merged=page.value("messages").toList();
                QSet<QString> seen;
                // Records by ID: a newer live update received during the reload wins,
                // and messages that arrived after the page was read are kept.
                for(auto &entry:merged){
                    const auto id=entry.toMap().value("id").toString();seen.insert(id);
                    for(const auto &current:m_messages)if(current.toMap().value("id").toString()==id&&m_liveMessages.contains(id)&&newerMessage(current.toMap(),entry.toMap()))entry=current;
                }
                for(const auto &current:m_messages)if(m_liveMessages.contains(current.toMap().value("id").toString())&&!seen.contains(current.toMap().value("id").toString()))merged.append(current);
                m_liveMessages.clear();
                m_olderCursor=page.value("hasMore").toBool()?page.value("before").toLongLong():0;
                m_messages=merged;m_transcript.reset(m_messages);emit messagesChanged();
            }
            if(method=="session.messages"&&id==m_olderRequest){
                m_olderRequest=-1;
                const auto page=value.toMap();QVariantList older;
                for(const auto &entry:page.value("messages").toList()){
                    bool present=false;for(const auto &current:m_messages)if(current.toMap().value("id")==entry.toMap().value("id"))present=true;
                    if(!present)older.append(entry);
                }
                m_olderCursor=page.value("hasMore").toBool()?page.value("before").toLongLong():0;
                m_messages=older+m_messages;m_transcript.prepend(older);emit messagesChanged();
            }
            if(method=="session.messageText"&&m_copies.contains(id)){
                auto copy=m_copies.take(id);const auto chunk=value.toMap();
                copy["text"]=copy.value("text").toString()+chunk.value("text").toString();
                if(chunk.value("next").isNull()||!chunk.contains("next")||chunk.value("next").toLongLong()<=0){QGuiApplication::clipboard()->setText(copy.value("text").toString());notify("Copied to clipboard");}
                else{const int next=rpc("session.messageText",{{"id",copy.value("sessionId")},{"messageId",copy.value("messageId")},{"offset",chunk.value("next")}});if(next>=0)m_copies[next]=copy;}
            }
            if(method=="session.create")select(value.toMap().value("id").toString());
            emit result(id,value);
        }else{
            QString method=object["method"].toString();auto params=object["params"].toObject().toVariantMap();
            if(method=="state")applyState(params);
            if(method=="message")observeConversation(params);
            if(method=="message"&&params.value("sessionId").toString()==m_selected){
                // An older revision can arrive after a newer page; it never overwrites it.
                bool found=false,stale=false;
                for(auto &m:m_messages){if(m.toMap().value("id")==params.value("id")){found=true;if(newerMessage(params,m.toMap()))m=params;else stale=true;break;}}
                if(m_messagesRequest>=0)m_liveMessages.insert(params.value("id").toString());
                if(!found)m_messages.append(params);
                if(!stale){m_transcript.upsert(params);emit messagesChanged();}
            }
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
                    m_state["attention"]=m_attention;emit stateChanged();
                    refreshMotion();
                }
                if(command=="panel"){
                    auto panels=m_state.value("panels").toMap();panels[params.value("owner").toString()]=params.value("visible");
                    m_state["panels"]=panels;emit stateChanged();refreshMotion();
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
    QSet<QString> pendingQuestions;
    for(const auto &entry:state.value("approvals").toList())pendingQuestions.insert(entry.toMap().value("id").toString());
    bool draftsChanged=false;
    for(auto it=m_questionDrafts.begin();it!=m_questionDrafts.end();){
        if(!pendingQuestions.contains(it.key())){it=m_questionDrafts.erase(it);draftsChanged=true;}else ++it;
    }
    if(draftsChanged)emit questionDraftsChanged();
    if(m_tray){QStringList names;for(const auto &device:state.value("remote").toMap().value("connected").toList())names<<device.toMap().value("name").toString();m_tray->setToolTip(names.isEmpty()?"Cere · your desktop companion":"Cere · Remote connected: "+names.join(", "));}
    m_attention=state.value("attention").toMap();
    if(m_selected.isEmpty()&&!state.value("sessions").toList().isEmpty())select(state.value("sessions").toList().first().toMap().value("id").toString());
    emit stateChanged();syncPet();
    refreshMotion();
    const auto after=m_director.context();
    if(!before.busy&&after.busy&&!m_toast.isEmpty()) { m_toastTimer.stop();m_toast.clear();emit toastChanged(); }
    if(!before.visible&&after.visible)playMotion("greeting");
    else if(!before.waiting&&after.waiting)playMotion("approval");
    else if(!before.busy&&after.busy)playMotion("send");
    else if((before.quiet||before.reduced)&&!after.quiet&&!after.reduced)playMotion("wake");
    else if(!oldSettings.isEmpty()&&oldSettings.value("scale")!=state.value("settings").toMap().value("scale"))playMotion("resize");
}
QVariantMap Controller::session()const{for(auto s:m_state.value("sessions").toList())if(s.toMap().value("id").toString()==m_selected)return s.toMap();return {};}
void Controller::setQuestionDraft(const QString &approvalId,const QVariantMap &answers){
    // Shared only in this UI process; private answers never enter persisted settings.
    bool pending=false;
    for(const auto &entry:m_state.value("approvals").toList())if(entry.toMap().value("id").toString()==approvalId){pending=true;break;}
    if(!pending||m_questionDrafts.value(approvalId)==answers)return;
    m_questionDrafts.insert(approvalId,answers);emit questionDraftsChanged();
}
void Controller::select(const QString &id){if(m_selected==id)return;m_selected=id;m_messages.clear();m_olderCursor=0;m_olderRequest=-1;m_transcript.reset({});emit messagesChanged();emit stateChanged();reloadMessages();publishAttention();refreshMotion();}
QQuickView *Controller::view(const QString &file,bool layer,const QString &title){
    auto v=new QQuickView(&m_qmlEngine,nullptr);v->setColor(Qt::transparent);v->setResizeMode(QQuickView::SizeRootObjectToView);v->setTitle(title);
    v->rootContext()->setContextProperty("App",this);
    if(layer&&qGuiApp->platformName().startsWith("wayland")){
        auto shell=LayerShellQt::Window::get(v);shell->setScope(title.startsWith("Cere Pet")?"cere-pet":title=="Cere Approval"?"cere-approval":"cere-panel");shell->setLayer(LayerShellQt::Window::LayerOverlay);shell->setExclusiveZone(-1);
        shell->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorTop)|LayerShellQt::Window::AnchorLeft);
        shell->setKeyboardInteractivity(title.startsWith("Cere Pet")?LayerShellQt::Window::KeyboardInteractivityNone:LayerShellQt::Window::KeyboardInteractivityOnDemand);
        shell->setActivateOnShow(!title.startsWith("Cere Pet")&&title!="Cere Approval");shell->setCloseOnDismissed(false);
    }else if(title=="Cere Pet")v->setFlags(Qt::Tool|Qt::FramelessWindowHint|Qt::WindowDoesNotAcceptFocus);
    else if(title=="Cere Panel"||title=="Cere Approval")v->setFlags(Qt::Tool|Qt::FramelessWindowHint);
    v->setSource(QUrl::fromLocalFile(m_root+"/qml/"+file));
    if(title=="Cere Pet Mirror"&&v->rootObject())v->rootObject()->setProperty("motionDriver",false);
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
    if(!m_dragging&&!m_roamStep&&!m_settling)placePet(g.topLeft()+QPoint(qRound(p.value("x",.86).toDouble()*std::max(0,g.width()-m_pet->width())),qRound(p.value("y",.78).toDouble()*std::max(0,g.height()-m_pet->height()))),target,false);
    updateMask();if(!m_pet->isVisible()){m_pet->show();if(!m_overlay&&qGuiApp->platformName().startsWith("wayland")){
        QTimer::singleShot(150,this,[this]{hyprDispatch("hl.dsp.window.float({window=\"title:^Cere Pet$\",action=\"set\"})","setfloating title:^Cere Pet$");placePet(m_petPosition,m_screen,false);});
    }}
}
void Controller::updateMask(){
    if(!m_pet||m_maskSize==m_pet->size())return;
    m_maskSize=m_pet->size();
    // This is an input region only, never a visual cutout. Include the envelope
    // of every pose/transform so animated hair and outstretched hands stay clickable.
    const auto definition=m_animations.value("puppet").toMap();
    const QString atlasPath=m_root+"/assets/"+definition.value("texture").toString();
    const QImage atlas(atlasPath);
    AvatarPuppet puppet;
    puppet.setDefinition(definition);puppet.setSource(QUrl::fromLocalFile(atlasPath));
    QImage mask(192,208,QImage::Format_ARGB32_Premultiplied);mask.fill(Qt::transparent);
    QPainter painter(&mask);
    const auto poses=definition.value("poses").toMap();
    for(const auto &value:poses){
        puppet.setPose(value.toMap().value("joints").toMap());
        const auto bones=puppet.boneTransforms();
        for(int angle:{-6,0,6}){
            painter.save();
            // Match GesturePlayer's 96% canvas and bottom-pivot root rotation.
            painter.translate(96,203);painter.rotate(angle);
            painter.translate(-92.16,-199.68);painter.scale(.96,.96);
            for(const auto &entry:definition.value("parts").toList()){
                const auto part=entry.toMap();
                const auto matrix=bones.value(part.value("bone").toString()).toList();
                const auto source=part.value("sourceRect").toList(),rect=part.value("rect").toList();
                if(matrix.size()!=6||source.size()!=4||rect.size()!=4)continue;
                painter.save();
                painter.setTransform(QTransform(matrix[0].toDouble(),matrix[2].toDouble(),
                    matrix[1].toDouble(),matrix[3].toDouble(),matrix[4].toDouble(),matrix[5].toDouble()),true);
                const QRectF target(rect[0].toDouble(),rect[1].toDouble(),rect[2].toDouble(),rect[3].toDouble());
                const QRect crop(source[0].toInt(),source[1].toInt(),source[2].toInt(),source[3].toInt());
                if(part.value("mirrorX").toBool()){
                    painter.translate(target.center().x()*2,0);painter.scale(-1,1);
                }
                painter.drawImage(target,atlas,crop);painter.restore();
            }
            painter.restore();
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
    const int margin=std::max(2,qRound(m_pet->width()/192.*12));
    region=region.united(region.translated(-margin,0)).united(region.translated(margin,0));
    region=region.united(region.translated(0,-margin)).united(region.translated(0,margin));
    const qreal badgeScale=std::clamp(m_pet->width()/192.,.8,1.5);
    const int badgeWidth=qRound(116*badgeScale),badgeRight=std::max(4,qRound(m_pet->width()*.07));
    region+=QRect(std::max(0,m_pet->width()-badgeRight-badgeWidth),0,badgeWidth,qRound(34*badgeScale));
    m_pet->setMask(region.intersected(QRect(QPoint(0,0),m_pet->size())));
}
void Controller::placePet(QPoint global,QScreen *screen,bool persist,bool roaming){
    if(!m_pet||!screen)return;auto g=screen->geometry();
    // Resting placement stays on its output; roaming keeps the continuous follower
    // point, so a seam crossing never jumps by the pet's width or height.
    global=Placement::pet(global,m_pet->size(),g,roaming?Placement::Mode::Roaming:Placement::Mode::Resting);
    if(m_screen!=screen){m_pet->hide();m_screen=screen;}
    m_petPosition=global;m_pet->setScreen(screen);
    if(m_overlay&&qGuiApp->platformName().startsWith("wayland")){
        auto shell=LayerShellQt::Window::get(m_pet);shell->setScreen(screen);shell->setDesiredSize(m_pet->size());shell->setMargins(QMargins(global.x()-g.x(),global.y()-g.y(),0,0));
    }else {m_pet->setPosition(global);if(m_pet->isVisible()&&qGuiApp->platformName().startsWith("wayland"))hyprDispatch(QString("hl.dsp.window.move({window=\"title:^Cere Pet$\",x=%1,y=%2,relative=false})").arg(global.x()).arg(global.y()).toUtf8(),QString("movewindowpixel exact %1 %2,title:^Cere Pet$").arg(global.x()).arg(global.y()).toUtf8());}
    if(persist){QVariantMap p{{"output",screen->name()},{"x",double(global.x()-g.x())/std::max(1,g.width()-m_pet->width())},{"y",double(global.y()-g.y())/std::max(1,g.height()-m_pet->height())}};rpc("settings.update",{{"position",p}});}
    syncPetMirror(roaming);
    if(m_panel&&m_panel->isVisible()&&!m_expanded)positionPanel();
    if(m_bubble&&m_bubble->isVisible())positionApprovalBubble();
}
// A layer-shell surface belongs to one output. While a roaming pet straddles a seam,
// a synchronized, input-transparent mirror on the neighbouring output draws the part
// that the primary surface's output clips; it is retired once the pet has crossed.
void Controller::syncPetMirror(bool roaming){
    QScreen *other=nullptr;
    if(roaming&&m_pet&&m_pet->isVisible()&&m_screen&&m_overlay&&qGuiApp->platformName().startsWith("wayland")){
        const QRect rect(m_petPosition,m_pet->size());
        for(auto screen:qGuiApp->screens())if(screen!=m_screen&&screen->geometry().intersects(rect))other=screen;
    }
    if(!other){if(m_petMirror)m_petMirror->hide();return;}
    if(!m_petMirror){
        m_petMirror=view("Pet.qml",true,"Cere Pet Mirror");m_petMirror->setFlag(Qt::WindowTransparentForInput);
        if(m_petMirror->rootObject()&&m_pet->rootObject())
            m_petMirror->rootObject()->setProperty("motionSource",m_pet->rootObject()->property("animationPlayer"));
    }
    const auto size=m_pet->size();m_petMirror->setMinimumSize(size);m_petMirror->setMaximumSize(size);m_petMirror->resize(size);
    const auto origin=other->geometry().topLeft();
    auto shell=LayerShellQt::Window::get(m_petMirror);shell->setScreen(other);shell->setDesiredSize(size);
    shell->setMargins(QMargins(m_petPosition.x()-origin.x(),m_petPosition.y()-origin.y(),0,0));
    if(m_petMirror->screen()!=other){m_petMirror->hide();m_petMirror->setScreen(other);}
    if(!m_petMirror->isVisible())m_petMirror->show();
}
QPoint Controller::cursorPosition()const{
    // Qt's Wayland global cursor is surface-relative; Hyprland provides authoritative output coordinates.
    auto o=QJsonDocument::fromJson(hyprQuery("j/cursorpos")).object();if(o.contains("x"))return {o["x"].toInt(),o["y"].toInt()};return QCursor::pos();
}
void Controller::beginDrag(qreal x,qreal y){stopRoaming(false);m_dragging=true;m_dragClock.start();m_dragOffset={qRound(x),qRound(y)};closePanel();refreshMotion();}
void Controller::drag(qreal,qreal){
    if(!m_dragging||!m_pet)return;
    const auto cursor=cursorPosition();auto screen=qGuiApp->screenAt(cursor);if(!screen)screen=m_screen;
    const auto previous=m_petPosition;const double dt=std::max(.008,m_dragClock.restart()/1000.);
    placePet(cursor-m_dragOffset,screen,false);m_pet->show();
    const QPointF speed=(m_petPosition-previous)/dt;
    m_petVelocity=QPointF(std::clamp(speed.x(),-180.,180.),std::clamp(speed.y(),-180.,180.));
    emit motionDynamicsChanged();
}
void Controller::endDrag(){if(!m_dragging)return;m_dragging=false;m_petVelocity={};emit motionDynamicsChanged();placePet(m_petPosition,m_screen,true);refreshMotion();playMotion("land");}
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
    // One placement rectangle sizes and positions the panel, so short outputs stay valid.
    m_panel->resize(Placement::compactPanel(m_screen?m_screen->availableGeometry():QRect(0,0,464,772),m_petPosition,m_pet?m_pet->size():QSize(192,208)).size());positionPanel();m_panel->show();m_panel->requestActivate();refreshMotion();preview("listen");
}
void Controller::positionPanel(){if(!m_panel||m_expanded||!m_screen)return;auto g=m_screen->geometry();const auto rect=Placement::compactPanel(m_screen->availableGeometry(),m_petPosition,m_pet?m_pet->size():QSize(192,208));if(m_panel->size()!=rect.size())m_panel->resize(rect.size());const int x=rect.x(),y=rect.y();m_panel->setScreen(m_screen);
    if(m_overlay&&qGuiApp->platformName().startsWith("wayland")){auto shell=LayerShellQt::Window::get(m_panel);shell->setScreen(m_screen);shell->setDesiredSize(m_panel->size());shell->setMargins({x-g.x(),y-g.y(),0,0});}else m_panel->setPosition(x,y);
}
void Controller::syncApprovalBubble(){
    const auto panels=m_state.value("panels").toMap();
    const bool ownPanel=m_panel&&m_panel->isVisible()&&m_panel->visibility()!=QWindow::Minimized;
    const bool show=connected()&&m_pet&&m_pet->isVisible()&&!m_dragging
        &&!ownPanel&&!panels.value(m_overlay?"ui":"overlay").toBool()
        &&(!m_state.value("approvals").toList().isEmpty()||!m_state.value("completions").toList().isEmpty());
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
void Controller::closePanel(){emit flushDrafts();if(m_panel)m_panel->hide();refreshMotion();}
void Controller::restorePanel(){if(!m_panel){togglePanel();return;}m_panel->show();m_panel->requestActivate();refreshMotion();}
void Controller::expand(){emit flushDrafts();rpc("ui.expand");}
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
void Controller::quit(bool stopTasks){emit flushDrafts();if(m_overlay){rpc("ui.quit",{{"stopTasks",stopTasks}});return;}if(stopTasks)for(auto s:m_state.value("sessions").toList())rpc("session.stop",{{"id",s.toMap().value("id")}});m_socket.flush();QTimer::singleShot(150,qApp,&QCoreApplication::quit);}
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
    context.panel=m_petInteracting||(m_panel&&m_panel->isVisible())||(m_bubble&&m_bubble->isVisible())||panels.value(m_overlay?"ui":"overlay").toBool();
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
    const bool paused=!context.visible||!context.connected||context.quiet||context.reduced||context.intensity<=0;
    if(paused!=m_motionPaused){
        m_motionPaused=paused;m_followClock.start();m_settleClock.start();emit motionDynamicsChanged();
    }
    const bool canFollow=context.visible&&context.connected&&!context.quiet&&!context.reduced&&context.intensity>0&&!context.waiting&&!context.busy&&!context.dragging&&!context.panel&&settings.value("roaming").toBool();
    if(!canFollow){
        m_roamTimer.stop();
    }
    if(m_roamStep&&!canFollow){
        m_follower.reset(m_petPosition);m_roamStep=false;m_petVelocity={};m_petSubpixel={};emit motionDynamicsChanged();
        if(!context.dragging&&context.connected)settleOrPersist();else syncPetMirror(false);
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
    emit conversationMessage(message);
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
    m_follower.reset(m_petPosition);m_petVelocity={};m_petSubpixel={};
    emit motionDynamicsChanged();
    if(!persist){m_settling=false;emit motionDynamicsChanged();}
    if(!m_roamStep)return;
    m_roamStep=false;emit motionDynamicsChanged();
    if(persist&&connected())settleOrPersist();else syncPetMirror(false);
    refreshMotion();
}
// A pet stopped mid-crossing keeps its visible point, then settles wholly onto the
// output holding its center at no more than the roaming speed before persisting.
void Controller::settleOrPersist(){
    if(!m_pet||!m_screen)return;
    const auto target=Placement::pet(m_petPosition,m_pet->size(),m_screen->geometry(),Placement::Mode::Resting);
    if(target==m_petPosition){m_settling=false;emit motionDynamicsChanged();placePet(target,m_screen,true);return;}
    m_settling=true;m_settleTarget=target;m_settlePosition=m_petPosition;m_settleClock.start();emit motionDynamicsChanged();
}
void Controller::roam(){
    auto s=m_state.value("settings").toMap();
    if((!m_director.canIdle()&&!m_roamStep)||!s.value("roaming").toBool()||!m_screen||!m_pet)return;
    const auto active=QJsonDocument::fromJson(hyprQuery("j/activewindow")).object();
    if(active["fullscreen"].toInt()!=0){stopRoaming(true);return;}
    m_followCursor=cursorPosition();m_followScreen=qGuiApp->screenAt(m_followCursor);
    if(!m_followScreen){stopRoaming(true);return;}
    if(!m_roamStep){
        m_follower.reset(m_petPosition);m_followClock.start();
        // Only animate when there is distance to cover. Stationary pets sample
        // the pointer at 5 Hz instead of running a permanent frame timer.
        if(!m_follower.advance(m_followCursor,m_pet->size(),m_followScreen->geometry(),0))return;
        m_roamLeft=m_followCursor.x()<m_petPosition.x()+m_pet->width()/2;
        m_roamStep=true;refreshMotion();emit motionDynamicsChanged();
    }
}
// Called by the primary pet's FrameAnimation, paced by the display instead of
// an unrelated 16 ms timer. The mirror must never advance the follower twice.
void Controller::advancePetMotion(){
    if(m_motionPaused)return;
    if(m_roamStep){followMouse();return;}
    if(!m_settling)return;
    if(!m_pet||!m_screen||m_dragging){m_settling=false;emit motionDynamicsChanged();return;}
    const double dt=std::clamp(m_settleClock.restart()/1000.,0.,.05);
    const QPointF delta=QPointF(m_settleTarget)-m_settlePosition;
    const double distance=std::hypot(delta.x(),delta.y());
    const bool arrived=distance<=75*dt;
    m_settlePosition=arrived?QPointF(m_settleTarget):m_settlePosition+delta*(75*dt/distance);
    const QPoint next=m_settlePosition.toPoint();
    m_petSubpixel=arrived?QPointF():m_settlePosition-next;
    placePet(next,m_screen,arrived,!arrived);
    if(arrived)m_settling=false;
    emit motionDynamicsChanged();
}
void Controller::followMouse(){
    if(!m_followScreen||!m_screen||!m_pet){stopRoaming(false);return;}
    const bool moving=m_follower.advance(m_followCursor,m_pet->size(),m_followScreen->geometry(),m_followClock.restart()/1000.);
    const QPoint position=m_follower.position().toPoint();
    m_petVelocity=m_follower.velocity();m_petSubpixel=m_follower.position()-position;
    emit motionDynamicsChanged();
    const QPoint center=position+QPoint(m_pet->width()/2,m_pet->height()/2);
    QScreen *screen=qGuiApp->screenAt(center);if(!screen)screen=m_screen;
    if(position!=m_petPosition||screen!=m_screen){placePet(position,screen,false,true);m_pet->show();}
    if(!moving){stopRoaming(true);playMotion("land");return;}
    if(std::abs(m_follower.velocity().x())>2){
        const bool left=m_follower.velocity().x()<0;
        if(left!=m_roamLeft){m_roamLeft=left;refreshMotion();}
    }
}
bool Controller::autostartEnabled()const{return QFile::exists(QStandardPaths::writableLocation(QStandardPaths::ConfigLocation)+"/autostart/cere.desktop");}
void Controller::setAutostart(bool enabled){QString dir=QStandardPaths::writableLocation(QStandardPaths::ConfigLocation)+"/autostart";QString path=dir+"/cere.desktop";if(!enabled){QFile::remove(path);return;}QDir().mkpath(dir);QSaveFile file(path);if(!file.open(QIODevice::WriteOnly)){notify("Could not update login startup");return;}QString exe=QCoreApplication::applicationFilePath();file.write(QString("[Desktop Entry]\nType=Application\nName=Cere\nExec=\"%1\" --root \"%2\"\nIcon=cere\nTerminal=false\n").arg(exe,m_root).toUtf8());file.commit();}
