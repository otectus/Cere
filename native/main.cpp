#include "controller.h"
#include <QApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QStringList>
#include <QCommandLineParser>
#include <QLocalSocket>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QStandardPaths>
#include <QLockFile>
#include <QIcon>
#include <QSocketNotifier>
#include <csignal>
#include <unistd.h>
#include <fcntl.h>

static int signalPipe[2]={-1,-1};
static void stopSignal(int){if(signalPipe[1]>=0){const char value=1;const auto written=::write(signalPipe[1],&value,1);(void)written;}}
// Another Cere process asks this interface to show its workspace while the broker is unreachable.
static void expandSignal(int){if(signalPipe[1]>=0){const char value=2;const auto written=::write(signalPipe[1],&value,1);(void)written;}}

int main(int argc,char **argv) {
    qputenv("QT_QUICK_CONTROLS_STYLE","Basic");
    QApplication app(argc,argv);
    if(::pipe2(signalPipe,O_NONBLOCK|O_CLOEXEC)!=0){qCritical("Cannot initialize signal handling");return 1;}
    QSocketNotifier stopNotifier(signalPipe[0],QSocketNotifier::Read);
    Controller *active=nullptr;
    QObject::connect(&stopNotifier,&QSocketNotifier::activated,&app,[&app,&active]{
        char data[32];const auto received=::read(signalPipe[0],data,sizeof(data));
        for(ssize_t i=0;i<received;++i)if(data[i]==1){app.quit();return;}
        if(received>0&&active)active->showWorkspaceLocally();
    });
    std::signal(SIGTERM,stopSignal);std::signal(SIGINT,stopSignal);std::signal(SIGUSR1,expandSignal);
    app.setApplicationName("cere"); app.setOrganizationName("Cere");
    app.setDesktopFileName("cere"); app.setQuitOnLastWindowClosed(false);
    QCommandLineParser parser; parser.addHelpOption();
    parser.addOption({"overlay","Run the overlay host"});
    parser.addOption({"show","Open the workspace"});
    parser.addOption({"toggle","Open or close the compact panel"});
    parser.addOption({"root","Application data directory","directory"});
    parser.process(app);
    QString runtime=qEnvironmentVariable("CERE_RUNTIME_DIR");
    if(runtime.isEmpty()){const QString base=qEnvironmentVariable("XDG_RUNTIME_DIR");runtime=(base.isEmpty()?QDir::tempPath()+"/cere-"+QString::number(::getuid()):base)+"/cere";}
    QDir().mkpath(runtime);
    // Lock files and the broker socket live here: it must be private to this user.
    if(!Controller::privateRuntime(runtime)){qCritical("Cere runtime directory %s is not private to this user.",qPrintable(runtime));return 1;}
    QLockFile instance(runtime+(parser.isSet("overlay")?"/overlay.lock":"/ui.lock"));
    instance.setStaleLockTime(0);
    if(!instance.tryLock(0)){
        if(!parser.isSet("overlay")){
            QLocalSocket client;client.connectToServer(runtime+"/broker.sock");
            const QByteArray method=parser.isSet("toggle")?"ui.toggle":"ui.expand";
            if(client.waitForConnected(1000)&&Controller::trustedBroker(client.socketDescriptor(),::getuid())){client.write("{\"id\":1,\"method\":\""+method+"\"}\n");client.waitForBytesWritten(1000);}
            // Without a broker, the running interface still opens its workspace.
            else Controller::signalInterface(runtime,SIGUSR1);
        }
        return 0;
    }
    QString root=parser.value("root");
    if(root.isEmpty()) root=qEnvironmentVariable("CERE_ROOT");
    if(root.isEmpty()) root="/usr/share/cere";
    if(!QFileInfo::exists(root+"/qml/Pet.qml")) root=CERE_SOURCE_DIR;
    QCoreApplication::addLibraryPath(QCoreApplication::applicationDirPath()+"/plugins");
    // Development autostart can launch the binary directly, outside tools/run.sh.
    if(QDir(root+"/.local-deps/usr/lib/qt6/plugins").exists())QCoreApplication::addLibraryPath(root+"/.local-deps/usr/lib/qt6/plugins");
    const auto requireAsset=[&root](const QString &name){
        if(QFileInfo::exists(root+"/assets/"+name))return true;
        qCritical("Cere artwork is missing or belongs to an older installation (assets/%s). Restore the complete assets directory.",qPrintable(name));
        return false;
    };
    const auto loadObject=[&root,&requireAsset](const QString &name,QJsonObject *result){
        if(!requireAsset(name))return false;
        QFile file(root+"/assets/"+name);QJsonParseError error;
        if(!file.open(QIODevice::ReadOnly)){qCritical("Cere asset metadata cannot be read (assets/%s).",qPrintable(name));return false;}
        const auto document=QJsonDocument::fromJson(file.readAll(),&error);
        if(error.error==QJsonParseError::NoError&&document.isObject()){*result=document.object();return true;}
        qCritical("Cere asset metadata is invalid (assets/%s): %s",qPrintable(name),qPrintable(error.errorString()));
        return false;
    };
    if(!requireAsset("avatars.json")||!requireAsset("palettes.json"))return 1;
    QJsonObject motions;
    if(!loadObject("motions.json",&motions))return 1;
    const QString baseRigName=motions.value("rig").toString("cere-rig.json");
    QJsonObject baseRig;
    if(baseRigName.isEmpty()||!loadObject(baseRigName,&baseRig))return 1;
    const QString baseTexture=baseRig.value("texture").toString();
    if(baseTexture.isEmpty()||!requireAsset(baseTexture))return 1;
    QFile avatarFile(root+"/assets/avatars.json");QJsonParseError avatarError;
    if(!avatarFile.open(QIODevice::ReadOnly)){qCritical("Cere avatar catalog cannot be read.");return 1;}
    const auto avatarDocument=QJsonDocument::fromJson(avatarFile.readAll(),&avatarError);
    if(avatarError.error!=QJsonParseError::NoError||!avatarDocument.isArray()){
        qCritical("Cere avatar catalog is invalid: %s",qPrintable(avatarError.errorString()));return 1;
    }
    QStringList missingIds{"cere","daemona","jade","nova","soap"};
    for(const auto &value:avatarDocument.array()){
        if(!value.isObject()){qCritical("Cere avatar catalog contains a non-object entry.");return 1;}
        const auto entry=value.toObject();const QString id=entry.value("id").toString();
        if(missingIds.removeAll(id)!=1){qCritical("Cere avatar catalog contains an unsupported or duplicate id: %s",qPrintable(id));return 1;}
        const QString portrait=entry.value("portrait").toString(),rigName=entry.value("rig").toString();
        QJsonObject rig;
        if(portrait.isEmpty()||rigName.isEmpty()||!requireAsset(portrait)||!loadObject(rigName,&rig))return 1;
        const QString texture=rig.value("texture").toString(baseTexture);
        if(texture.isEmpty()||!requireAsset(texture))return 1;
    }
    if(!missingIds.isEmpty()){
        qCritical("Cere avatar catalog belongs to an older installation; missing: %s",qPrintable(missingIds.join(", ")));return 1;
    }
    Controller controller(root,parser.isSet("overlay"));active=&controller;
    controller.start(parser.isSet("show"),parser.isSet("toggle"));
    return app.exec();
}
