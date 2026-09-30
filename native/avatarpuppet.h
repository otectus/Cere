#pragma once

#include <QQuickItem>
#include <QUrl>
#include <QVariantMap>

#include <memory>

class AvatarPuppet : public QQuickItem
{
    Q_OBJECT
    Q_PROPERTY(QUrl source READ source WRITE setSource NOTIFY sourceChanged)
    Q_PROPERTY(QVariantMap definition READ definition WRITE setDefinition NOTIFY definitionChanged)
    Q_PROPERTY(QVariantMap pose READ pose WRITE setPose NOTIFY poseChanged)
    Q_PROPERTY(bool ready READ ready NOTIFY readyChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)

public:
    explicit AvatarPuppet(QQuickItem *parent = nullptr);
    ~AvatarPuppet() override;

    QUrl source() const;
    void setSource(const QUrl &source);

    QVariantMap definition() const;
    void setDefinition(const QVariantMap &definition);

    QVariantMap pose() const;
    void setPose(const QVariantMap &pose);

    bool ready() const;
    QString error() const;

    // Reference-space world matrices, encoded as
    // [m11, m12, m21, m22, dx, dy] for each bone name.
    Q_INVOKABLE QVariantMap boneTransforms() const;

signals:
    void sourceChanged();
    void definitionChanged();
    void poseChanged();
    void readyChanged();
    void errorChanged();

protected:
    QSGNode *updatePaintNode(QSGNode *oldNode, UpdatePaintNodeData *) override;

private:
    struct Private;
    std::unique_ptr<Private> d;

    void loadSource();
    void rebuild();
    void setStatus(bool ready, const QString &error);
};
