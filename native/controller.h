#pragma once
#include <QObject>
#include <QVariantMap>
#include <QVariantList>
#include <QLocalSocket>
#include <QTimer>
#include <QQuickView>
#include <QQmlEngine>
#include <QProcess>
#include <QSystemTrayIcon>
#include <QPointer>
#include <QAbstractListModel>
#include <QElapsedTimer>
#include <QSortFilterProxyModel>
#include <QSet>
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
    void prepend(const QVariantList &older){if(older.isEmpty())return;beginInsertRows({},0,older.size()-1);rows=older+rows;endInsertRows();}
};
// Broker message revisions increase with every stored update of the same message.
inline bool newerMessage(const QVariantMap &incoming,const QVariantMap &existing){
    return incoming.value("revision").toString().toULongLong()>=existing.value("revision").toString().toULongLong();
}

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
    Q_PROPERTY(QVariantMap conversationMoods READ conversationMoods NOTIFY conversationMoodsChanged)
    Q_PROPERTY(QString bodyMood READ bodyMood NOTIFY moodContextChanged)
    Q_PROPERTY(QString moodSession READ actingSession NOTIFY moodContextChanged)
    Q_PROPERTY(bool moodSourceEnabled READ moodSourceEnabled NOTIFY moodContextChanged)
    Q_PROPERTY(bool hasOlderMessages READ hasOlderMessages NOTIFY messagesChanged)
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
    QVariantMap conversationMoods() const { return m_conversationMoods; }
    QString bodyMood() const;
    bool moodSourceEnabled() const;
    Q_INVOKABLE void setConversationMood(const QString &sessionId, const QVariantMap &sample);
    Q_INVOKABLE void registerMoodSource() { m_sharedMoodReady=true; }
    Q_PROPERTY(QPointF petVelocity READ petVelocity NOTIFY motionDynamicsChanged)
    Q_PROPERTY(QPointF petSubpixel READ petSubpixel NOTIFY motionDynamicsChanged)
    Q_PROPERTY(bool petMoving READ petMoving NOTIFY motionDynamicsChanged)
    QPointF petVelocity() const { return m_petVelocity; }
    QPointF petSubpixel() const { return m_petSubpixel; }
    bool petMoving() const { return !m_motionPaused && (m_roamStep || m_settling); }
    Q_INVOKABLE void advancePetMotion();
    bool hasOlderMessages() const { return m_olderCursor>0; }
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
    Q_INVOKABLE QString clipboardText() const;
    Q_INVOKABLE QVariantMap clipboardContent();
    Q_INVOKABLE void openPath(const QString &path);
    Q_INVOKABLE void openMessageLink(const QString &link, const QString &directory);
    // proseWidth: the visible width; paragraphs wrap there even when a table or code block is wider.
    Q_INVOKABLE void formatMessage(QQuickTextDocument *document, qreal proseWidth=0);
    Q_INVOKABLE QString chooseFolder();
    Q_INVOKABLE QString chooseImage();
    Q_INVOKABLE QString chooseFile();
    Q_INVOKABLE void saveHomePosition();
    Q_INVOKABLE void goHomePosition();
    Q_INVOKABLE void dockPet(const QString &edge);
    Q_INVOKABLE void notify(const QString &text);
    Q_INVOKABLE void quit(bool stopTasks=false);
    Q_INVOKABLE void setAutostart(bool enabled);
    Q_INVOKABLE bool autostartEnabled() const;
    Q_INVOKABLE void preview(const QString &state);
    Q_INVOKABLE void attachImage(const QString &path) { emit attachmentRequested(path); }
    Q_INVOKABLE void loadOlderMessages();
    Q_INVOKABLE void copyMessage(const QString &messageId);
    Q_INVOKABLE void copySessionMessage(const QString &sessionId, const QString &messageId);
    Q_INVOKABLE void openCompletion(const QString &completionId);
    Q_INVOKABLE void openCompanionReply(const QString &replyId);
    Q_INVOKABLE QVariantMap questionDraft(const QString &approvalId) const { return m_questionDrafts.value(approvalId); }
    Q_INVOKABLE void setQuestionDraft(const QString &approvalId, const QVariantMap &answers);
    // Row of a message in the conversation view, or -1 while it is not loaded.
    Q_INVOKABLE int transcriptRow(const QString &messageId) const;
    // Sends a draft save once the save it depends on succeeds, even if its editor is gone by then.
    Q_INVOKABLE void deferDraft(int afterRequest, const QVariantMap &params);
    // The approval bubble takes keyboard focus only while the pointer is over it.
    Q_INVOKABLE void setBubbleFocusable(bool focusable);
    // The pet's current logical placement in global coordinates (diagnostics and tests).
    QPoint petPosition() const { return m_petPosition; }
    void start(bool show);
    // The broker is trusted only when its socket belongs to the expected user.
    static bool trustedBroker(qintptr descriptor, uint expectedUid);
    static bool privateRuntime(const QString &path);
signals:
    void stateChanged();
    void messagesChanged();
    void conversationMessage(const QVariantMap &message);
    void activityChanged();
    void questionDraftsChanged();
    void toastChanged();
    void motionChanged();
    void conversationMoodsChanged();
    void moodContextChanged();
    void motionDynamicsChanged();
    void result(int id, const QVariant &value);
    // Editors persist unsaved text before a window hides, expands or quits.
    void flushDrafts();
    void attachmentRequested(const QString &path);
private:
    // Pet and output-seam mirror share QML values and one animation sample.
    QQmlEngine m_qmlEngine;
    QString m_root, m_selected, m_toast, m_motion="idle";
    bool m_overlay, m_expanded=false, m_dragging=false, m_roamStep=false;
    QLocalSocket m_socket;
    QByteArray m_buffer;
    QVariantMap m_state, m_animations;
    QVariantList m_messages;
    QHash<QString,QVariantMap> m_questionDrafts;
    QHash<int,QVariantMap> m_deferredDrafts;
    bool m_bubbleFocusable=false;
    TranscriptModel m_transcript;
    TranscriptFilter m_replies{false},m_activity{true};
    QHash<int,QString> m_requests;
    int m_sequence=0;
    int m_messagesRequest=-1, m_olderRequest=-1;
    qint64 m_olderCursor=0;
    QSet<QString> m_liveMessages;
    QHash<int,QVariantMap> m_copies;
    QPointer<QQuickView> m_petMirror;
    QPoint m_settleTarget;
    QPointF m_settlePosition;
    bool m_settling=false, m_motionPaused=false;
    QElapsedTimer m_settleClock;
    void settleOrPersist();
    QTimer m_retry, m_toastTimer, m_roamTimer, m_motionTimer, m_idleTimer;
    QTimer m_successTimer;
    QString m_successSession;
    MotionDirector m_director;
    quint64 m_motionRevision=0, m_motionToken=0;
    QElapsedTimer m_reactionClock;
    QHash<QString,qint64> m_lastReaction;
    MouseFollower m_follower;
    QElapsedTimer m_followClock;
    QElapsedTimer m_dragClock;
    QPointF m_petVelocity, m_petSubpixel;
    QPoint m_followCursor;
    QPointer<QScreen> m_followScreen;
    bool m_roamLeft=false,m_petInteracting=false;
    bool m_listening=false;
    QVariantMap m_attention;
    QVariantMap m_conversationMoods;
    bool m_sharedMoodReady=false;
    void receiveMood(const QString &sessionId, const QVariantMap &sample);
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
    void placePet(QPoint global, QScreen *screen, bool persist, bool roaming=false);
    void syncPetMirror(bool roaming);
    void reloadMessages();
    void failPendingRequests(const QString &message);
    void updateMask();
    void positionPanel();
    void floatPanel();
    void syncApprovalBubble();
    void positionApprovalBubble();
    void roam();
    void followMouse();
    void refreshMotion();
    QString actingSession() const;
    QString moodOwner() const;
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
