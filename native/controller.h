#pragma once
#include <QObject>
#include <QVariantMap>
#include <QVariantList>
#include <QLocalSocket>
#include <QTimer>
#include <QQuickView>
#include <QProcess>
#include <QSystemTrayIcon>
#include <QPointer>
#include <QAbstractListModel>
#include <QElapsedTimer>
#include <QSortFilterProxyModel>
#include "motion.h"
#include "follow.h"
class QQuickTextDocument;

class TranscriptModel : public QAbstractListModel {
    Q_OBJECT
public:
    using QAbstractListModel::QAbstractListModel;
    QVariantList rows;
    int rowCount(const QModelIndex &parent={}) const override {return parent.isValid()?0:rows.size();}
    QVariant data(const QModelIndex &index,int role) const override {return index.isValid()&&index.row()<rows.size()&&role==Qt::UserRole+1?rows.at(index.row()):QVariant();}
    QHash<int,QByteArray> roleNames() const override {return {{Qt::UserRole+1,"entry"}};}
    void reset(QVariantList values){beginResetModel();rows=std::move(values);endResetModel();}
    void upsert(const QVariantMap &message){for(int i=0;i<rows.size();++i)if(rows[i].toMap().value("id")==message.value("id")){rows[i]=message;emit dataChanged(index(i),index(i),{Qt::UserRole+1});return;}int n=rows.size();beginInsertRows({},n,n);rows.append(message);endInsertRows();}
};

// Keep streaming updates incremental in both views, with a single source of truth.
class TranscriptFilter : public QSortFilterProxyModel {
public:
    explicit TranscriptFilter(bool activity):m_activity(activity) {}
protected:
    bool filterAcceptsRow(int row,const QModelIndex &parent) const override {
        const auto message=sourceModel()->data(sourceModel()->index(row,0,parent),Qt::UserRole+1).toMap();
        return (message.value("role").toString()=="tool")==m_activity;
    }
private:
    bool m_activity;
};

class Controller : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantMap state READ state NOTIFY stateChanged)
    Q_PROPERTY(QVariantList messages READ messages NOTIFY messagesChanged)
    Q_PROPERTY(QAbstractItemModel* transcript READ transcript CONSTANT)
    Q_PROPERTY(QAbstractItemModel* activity READ activity CONSTANT)
    Q_PROPERTY(int activityCount READ activityCount NOTIFY activityChanged)
    Q_PROPERTY(QVariantMap session READ session NOTIFY stateChanged)
    Q_PROPERTY(QString selectedId READ selectedId WRITE select NOTIFY stateChanged)
    Q_PROPERTY(bool connected READ connected NOTIFY stateChanged)
    Q_PROPERTY(bool overlay READ overlay CONSTANT)
    Q_PROPERTY(QString assetPath READ assetPath CONSTANT)
    Q_PROPERTY(QVariantMap animations READ animations CONSTANT)
    Q_PROPERTY(QString toast READ toast NOTIFY toastChanged)
    Q_PROPERTY(QString motion READ motion NOTIFY motionChanged)
public:
    explicit Controller(QString root, bool overlay, QObject *parent=nullptr);
    ~Controller();
    QVariantMap state() const { return m_state; }
    QVariantList messages() const { return m_messages; }
    QAbstractItemModel *transcript(){return &m_replies;}
    QAbstractItemModel *activity(){return &m_activity;}
    int activityCount() const {return m_activity.rowCount();}
    QVariantMap session() const;
    QString selectedId() const { return m_selected; }
    bool connected() const { return m_socket.state()==QLocalSocket::ConnectedState; }
    bool overlay() const { return m_overlay; }
    QString assetPath() const;
    QVariantMap animations() const { return m_animations; }
    QString toast() const { return m_toast; }
    QString motion() const { return m_motion; }
    Q_INVOKABLE int rpc(const QString &method, const QVariantMap &params={});
    Q_INVOKABLE void select(const QString &id);
    Q_INVOKABLE void togglePanel();
    Q_INVOKABLE void closePanel();
    Q_INVOKABLE void restorePanel();
    Q_INVOKABLE void expand();
    Q_INVOKABLE void beginDrag(qreal x, qreal y);
    Q_INVOKABLE void drag(qreal x, qreal y);
    Q_INVOKABLE void endDrag();
    Q_INVOKABLE void setPetInteracting(bool interacting);
    Q_INVOKABLE void setListening(bool listening);
    Q_INVOKABLE void resizePet(qreal factor);
    Q_INVOKABLE void copy(const QString &text);
    Q_INVOKABLE void openPath(const QString &path);
    Q_INVOKABLE void openMessageLink(const QString &link, const QString &directory);
    Q_INVOKABLE void formatMessage(QQuickTextDocument *document);
    Q_INVOKABLE QString chooseFolder();
    Q_INVOKABLE QString chooseImage();
    Q_INVOKABLE QString chooseFile();
    Q_INVOKABLE void notify(const QString &text);
    Q_INVOKABLE void quit(bool stopTasks=false);
    Q_INVOKABLE void setAutostart(bool enabled);
    Q_INVOKABLE bool autostartEnabled() const;
    Q_INVOKABLE void preview(const QString &state);
    Q_INVOKABLE void attachImage(const QString &path) { emit attachmentRequested(path); }
    void start(bool show);
signals:
    void stateChanged();
    void messagesChanged();
    void activityChanged();
    void toastChanged();
    void motionChanged();
    void result(int id, const QVariant &value);
    void attachmentRequested(const QString &path);
private:
    QString m_root, m_selected, m_toast, m_motion="idle";
    bool m_overlay, m_expanded=false, m_dragging=false, m_roamStep=false;
    QLocalSocket m_socket;
    QByteArray m_buffer;
    QVariantMap m_state, m_animations;
    QVariantList m_messages;
    TranscriptModel m_transcript;
    TranscriptFilter m_replies{false},m_activity{true};
    QHash<int,QString> m_requests;
    int m_sequence=0;
    int m_messagesRequest=-1;
    QTimer m_retry, m_toastTimer, m_roamTimer, m_followTimer, m_motionTimer, m_idleTimer;
    QTimer m_successTimer;
    QString m_successSession;
    MotionDirector m_director;
    quint64 m_motionRevision=0, m_motionToken=0;
    QElapsedTimer m_reactionClock;
    QHash<QString,qint64> m_lastReaction;
    MouseFollower m_follower;
    QElapsedTimer m_followClock;
    QPoint m_followCursor;
    QPointer<QScreen> m_followScreen;
    bool m_roamLeft=false,m_petInteracting=false;
    bool m_listening=false;
    QVariantMap m_attention;
    QHash<QString,QString> m_cuedMessages;
    QString m_tenderSession;
    QQuickView *m_pet=nullptr, *m_panel=nullptr, *m_bubble=nullptr;
    QSystemTrayIcon *m_tray=nullptr;
    QProcess *m_overlayProcess=nullptr;
    QPoint m_dragOffset, m_petPosition;
    QSize m_maskSize;
    QPointer<QScreen> m_screen;
    void connectBroker();
    void receive();
    void applyState(const QVariantMap &state);
    void syncPet();
    void placePet(QPoint global, QScreen *screen, bool persist);
    void updateMask();
    void positionPanel();
    void syncApprovalBubble();
    void positionApprovalBubble();
    void roam();
    void followMouse();
    void refreshMotion();
    QString actingSession() const;
    void publishAttention();
    void observeConversation(const QVariantMap &message);
    void publishMotion();
    void playMotion(const QString &motion);
    void stopRoaming(bool persist);
    void restoreMotion();
    void showWorkspace();
    QQuickView *view(const QString &file, bool layer, const QString &title);
    QString runtimePath() const;
    QPoint cursorPosition() const;
};
