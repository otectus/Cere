// Startup cost of the interface's controller: wall time to construct it (catalog, avatars, themes)
// and the process's peak resident memory afterwards. Used to compare builds before and after a
// change to startup work; the numbers belong to the machine and build that produced them.
//   cere-measure-startup ROOT [RUNS]
#include "controller.h"
#include <QElapsedTimer>
#include <QFile>
#include <QGuiApplication>
#include <iostream>

static long peakResidentKiB()
{
    QFile status(QStringLiteral("/proc/self/status"));
    if (!status.open(QIODevice::ReadOnly)) return -1;
    for (const QByteArray &line : status.readAll().split('\n'))
        if (line.startsWith("VmHWM:")) return line.mid(6).trimmed().split(' ').first().toLong();
    return -1;
}

int main(int argc, char **argv)
{
    QGuiApplication application(argc, argv);
    const QString root = argc > 1 ? QString::fromLocal8Bit(argv[1]) : QStringLiteral(".");
    const int runs = argc > 2 ? QString::fromLocal8Bit(argv[2]).toInt() : 1;
    const long before = peakResidentKiB();
    for (int run = 0; run < runs; ++run) {
        QElapsedTimer timer; timer.start();
        Controller controller(root, true);
        std::cout << "run " << run + 1 << ": controller " << timer.elapsed() << " ms, avatars " << controller.avatars().size() << '\n';
    }
    std::cout << "peak resident: " << peakResidentKiB() / 1024 << " MiB (process start " << before / 1024 << " MiB)" << std::endl;
    return 0;
}
