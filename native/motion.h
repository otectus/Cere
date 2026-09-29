#pragma once
#include <QVariantMap>
#include <QStringList>
#include <QRandomGenerator>

// Policy is independent of wall-clock timers and QML, so interruptions are testable.
class MotionDirector {
public:
    struct Context {
        bool visible=false, quiet=false, reduced=false, connected=true;
        bool dragging=false, waiting=false, busy=false, panel=false, roaming=false, roamLeft=false;
        bool listening=false, problem=false;
        QString activity;
        double intensity=.7;
    };
    explicit MotionDirector(const QVariantMap &catalog={}, quint32 seed=QRandomGenerator::global()->generate());
    void setContext(Context context);
    bool play(const QString &name);
    bool finish(quint64 revision);
    bool idle();
    QString name() const { return m_name; }
    quint64 revision() const { return m_revision; }
    int duration() const;
    bool canIdle() const;
    int nextIdleDelay();
    Context context() const { return m_context; }
    // Deliberately small, local language cues; never infer action outcomes from prose.
    static QString conversationalCue(const QString &text, bool user=false);
private:
    QVariantMap m_clips;
    QStringList m_idlePool, m_bag;
    QString m_name="quiet", m_lastIdle;
    Context m_context;
    QRandomGenerator m_random;
    quint64 m_revision=0;
    bool m_transient=false;
    QString base() const;
    int priority(const QString &name) const;
    void choose(const QString &name, bool transient);
};
