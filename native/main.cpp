#include "controller.h"
#include <QApplication>
#include <QDir>
#include <QFileInfo>
#include <QCommandLineParser>
#include <QLocalSocket>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStandardPaths>
#include <QLockFile>
#include <QPalette>
#include <QSocketNotifier>
#include <csignal>
#include <unistd.h>
#include <fcntl.h>

static int signalPipe[2]={-1,-1};
static void stopSignal(int){if(signalPipe[1]>=0){const char value=1;const auto written=::write(signalPipe[1],&value,1);(void)written;}}

int main(int argc,char **argv) {
    qputenv("QT_QUICK_CONTROLS_STYLE","Basic");
    QApplication app(argc,argv);
    if(::pipe2(signalPipe,O_NONBLOCK|O_CLOEXEC)!=0){qCritical("Cannot initialize signal handling");return 1;}
    QSocketNotifier stopNotifier(signalPipe[0],QSocketNotifier::Read);
    QObject::connect(&stopNotifier,&QSocketNotifier::activated,&app,[&app]{char data[32];const auto received=::read(signalPipe[0],data,sizeof(data));(void)received;app.quit();});
    std::signal(SIGTERM,stopSignal);std::signal(SIGINT,stopSignal);
    app.setApplicationName("cere"); app.setOrganizationName("Cere");
    app.setDesktopFileName("cere"); app.setQuitOnLastWindowClosed(false);
    QCommandLineParser parser; parser.addHelpOption();
    parser.addOption({"overlay","Run the overlay host"});
    parser.addOption({"show","Open the workspace"});
    parser.addOption({"root","Application data directory","directory"});
    parser.process(app);
    QString runtime=qEnvironmentVariable("CERE_RUNTIME_DIR");
    if(runtime.isEmpty())runtime=QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation)+"/cere";
    QDir().mkpath(runtime);
    QLockFile instance(runtime+(parser.isSet("overlay")?"/overlay.lock":"/ui.lock"));
    instance.setStaleLockTime(0);
    if(!instance.tryLock(0)){
        if(!parser.isSet("overlay")){
            QLocalSocket client;client.connectToServer(runtime+"/broker.sock");
            if(client.waitForConnected(1000)){client.write("{\"id\":1,\"method\":\"ui.expand\"}\n");client.waitForBytesWritten(1000);}
        }
        return 0;
    }
    QPalette palette=app.palette();
    palette.setColor(QPalette::Window,QColor("#19202b"));palette.setColor(QPalette::WindowText,QColor("#ecf4fa"));
    palette.setColor(QPalette::Base,QColor("#101923"));palette.setColor(QPalette::Text,QColor("#ecf4fa"));
    palette.setColor(QPalette::Button,QColor("#222d3a"));palette.setColor(QPalette::ButtonText,QColor("#ecf4fa"));
    palette.setColor(QPalette::Highlight,QColor("#396982"));palette.setColor(QPalette::HighlightedText,QColor("#ffffff"));app.setPalette(palette);
    QString root=parser.value("root");
    if(root.isEmpty()) root=qEnvironmentVariable("CERE_ROOT");
    if(root.isEmpty()) root="/usr/share/cere";
    if(!QFileInfo::exists(root+"/qml/Pet.qml")) root=CERE_SOURCE_DIR;
    QCoreApplication::addLibraryPath(QCoreApplication::applicationDirPath()+"/plugins");
    // Development autostart can launch the binary directly, outside tools/run.sh.
    if(QDir(root+"/.local-deps/usr/lib/qt6/plugins").exists())QCoreApplication::addLibraryPath(root+"/.local-deps/usr/lib/qt6/plugins");
    if(!QFileInfo::exists(root+"/assets/cere-polished.png")||!QFileInfo::exists(root+"/assets/motions.json")) { qCritical("Cere artwork or motion catalog is missing. Restore the assets directory."); return 1; }
    Controller controller(root,parser.isSet("overlay"));
    controller.start(parser.isSet("show"));
    return app.exec();
}
