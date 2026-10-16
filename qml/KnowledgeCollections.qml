import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M06: document collections. Text and Markdown files are indexed on this computer into a memory scope
// of their own; a conversation uses the collections bound to it, its project or everywhere.
// Cloud models read a collection only when it allows them to.
CDialog {
    id:library;objectName:"knowledgeCollections"
    width:Math.min(680,parent?parent.width-32:680)
    property string sessionId:""
    property var collections:[]
    property int listRequest:-1
    property int request:-1
    property string error:""
    property string feedback:""
    property string deleteId:""
    property string jobKey:""
    readonly property var job:App.state.collectionJob||null
    readonly property var session:(App.state.sessions||[]).find(item=>item.id===sessionId)||({})
    readonly property var groundings:[{id:"strict",label:"Only from the documents"},{id:"balanced",label:"Prefer the documents"},{id:"exploratory",label:"Documents as a starting point"}]
    function openFor(id){sessionId=id||"";error="";feedback="";reload();open()}
    function reload(){if(App.connected)listRequest=App.rpc("collections.list",sessionId?{sessionId:sessionId}:{})}
    function call(method,params,done){error="";feedback=done||"";request=App.rpc(method,params)}
    function indexed(time){return time?"indexed "+new Date(time).toLocaleString(Qt.locale(),Locale.ShortFormat):"not indexed yet"}
    CText { text:"Document collections";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:"Ground answers in your own text and Markdown files. Files are indexed on this computer, answers cite the file they used, and the folders stay the source of truth. Cloud models read a collection only if you allow it.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    RowLayout {
        Layout.fillWidth:true
        CField { id:newName;objectName:"collectionName";Layout.fillWidth:true;placeholderText:"New collection name";maximumLength:80;Accessible.name:"New collection name";onAccepted:if(createButton.enabled)createButton.clicked() }
        CButton { id:createButton;objectName:"collectionCreate";text:"Create";enabled:App.connected&&library.request<0&&newName.text.trim().length>0;onClicked:{library.call("collections.create",{name:newName.text.trim()},"Created. Add a folder or file, then index it.");newName.text=""} }
    }
    CText { objectName:"collectionsEmpty";visible:library.listRequest<0&&library.collections.length===0;text:"No collections yet.";color:Theme.muted }
    Repeater {
        model:library.collections
        Rectangle {
            id:card
            required property var modelData
            required property int index
            readonly property bool indexing:!!library.job&&library.job.collectionId===modelData.id&&!library.job.done
            Layout.fillWidth:true;implicitHeight:cardColumn.implicitHeight+24;radius:Theme.radiusControl;color:Theme.raised;border.color:Theme.border
            ColumnLayout {
                id:cardColumn;anchors.fill:parent;anchors.margins:12;spacing:8
                CText { objectName:"collectionTitle_"+card.index;text:card.modelData.name;font.weight:Font.DemiBold;Layout.fillWidth:true;elide:Text.ElideRight }
                CText {
                    objectName:"collectionStatus_"+card.index;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.secondary
                    text:card.modelData.files+(card.modelData.files===1?" file · ":" files · ")+card.modelData.chunks+" passages · "+library.indexed(card.modelData.lastIndexed)
                        +(card.modelData.stale>0?" · "+card.modelData.stale+" changed since indexing":"")+(card.modelData.errors.length?" · "+card.modelData.errors.length+" could not be read":"")
                }
                Repeater { model:card.modelData.errors.slice(0,3);CText { required property var modelData;Layout.fillWidth:true;elide:Text.ElideMiddle;color:Theme.amber;font.pixelSize:Theme.caption;text:modelData.path.split("/").pop()+": "+modelData.error } }
                Flow {
                    visible:!!library.sessionId&&!!card.modelData.bound;Layout.fillWidth:true;spacing:8
                    CText { text:"Use in";color:Theme.muted;font.pixelSize:Theme.secondary;height:32;verticalAlignment:Text.AlignVCenter }
                    CCheckBox { objectName:"collectionBindSession_"+card.index;text:"this conversation";enabled:library.request<0&&library.session.temporary!==true;checked:!!card.modelData.bound?.session;onToggled:library.call("collections.bind",{id:card.modelData.id,target:"session",sessionId:library.sessionId,bound:checked}) }
                    CCheckBox { text:"this project";enabled:library.request<0&&library.session.temporary!==true;checked:!!card.modelData.bound?.project;onToggled:library.call("collections.bind",{id:card.modelData.id,target:"project",sessionId:library.sessionId,bound:checked}) }
                    CCheckBox { text:"every conversation";enabled:library.request<0;checked:!!card.modelData.bound?.global;onToggled:library.call("collections.bind",{id:card.modelData.id,target:"global",bound:checked}) }
                }
                RowLayout {
                    Layout.fillWidth:true
                    CText { text:"Answers";color:Theme.muted;font.pixelSize:Theme.secondary }
                    CComboBox {
                        Layout.fillWidth:true;model:library.groundings;textRole:"label";enabled:library.request<0;Accessible.name:"How answers use "+card.modelData.name
                        currentIndex:Math.max(0,library.groundings.findIndex(item=>item.id===card.modelData.grounding))
                        onActivated:index=>library.call("collections.update",{id:card.modelData.id,expectedRevision:card.modelData.revision,grounding:library.groundings[index].id})
                    }
                }
                CCheckBox { objectName:"collectionCloud_"+card.index;text:"Cloud models may read excerpts from this collection";enabled:library.request<0;checked:card.modelData.allowCloud;onToggled:library.call("collections.update",{id:card.modelData.id,expectedRevision:card.modelData.revision,allowCloud:checked}) }
                Repeater {
                    model:card.modelData.sources
                    RowLayout {
                        required property var modelData
                        Layout.fillWidth:true
                        CText { Layout.fillWidth:true;text:(modelData.kind==="folder"?"Folder · ":"File · ")+modelData.path;elide:Text.ElideMiddle;font.pixelSize:Theme.secondary }
                        CButton { text:"Remove";quiet:true;enabled:library.request<0&&!card.indexing;onClicked:library.call("collections.removeSource",{id:card.modelData.id,expectedRevision:card.modelData.revision,path:modelData.path},"Removed. Its passages leave the index at the next indexing run.") }
                    }
                }
                RowLayout {
                    visible:card.indexing;Layout.fillWidth:true
                    CText { objectName:"collectionProgress_"+card.index;Layout.fillWidth:true;color:Theme.accentText;font.pixelSize:Theme.secondary;text:"Indexing "+(library.job?.processed||0)+" of "+(library.job?.total||"…")+" files" }
                    CButton { text:"Cancel";danger:true;onClicked:App.rpc("collections.cancel",{}) }
                }
                CText { visible:!!library.job&&library.job.collectionId===card.modelData.id&&library.job.done&&!!library.job.error;text:library.job?.error||"";color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
                Flow {
                    Layout.fillWidth:true;spacing:8
                    CButton { objectName:"collectionAddFolder_"+card.index;text:"Add folder…";enabled:library.request<0&&!card.indexing;onClicked:{const path=App.chooseFolder();if(path)library.call("collections.addSource",{id:card.modelData.id,expectedRevision:card.modelData.revision,path:path},"Added. Index the collection to use it.")} }
                    CButton { text:"Add file…";enabled:library.request<0&&!card.indexing;onClicked:{const path=App.chooseFile();if(path)library.call("collections.addSource",{id:card.modelData.id,expectedRevision:card.modelData.revision,path:path},"Added. Index the collection to use it.")} }
                    CButton { objectName:"collectionIndex_"+card.index;text:card.modelData.lastIndexed?"Update index":"Index now";primary:card.modelData.sources.length>0&&(!card.modelData.lastIndexed||card.modelData.stale>0);enabled:library.request<0&&card.modelData.sources.length>0&&!(library.job&&!library.job.done);onClicked:library.call("collections.index",{id:card.modelData.id}) }
                    CButton { text:"Delete…";danger:true;enabled:library.request<0&&!card.indexing;onClicked:{library.deleteId=card.modelData.id;deleteConfirm.open()} }
                }
            }
        }
    }
    CText { visible:!!library.error;text:library.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"collectionsFeedback";visible:!!library.feedback;text:library.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CButton { text:"Close";Layout.fillWidth:true;onClicked:library.close() }
    CDialog {
        id:deleteConfirm
        readonly property var target:library.collections.find(item=>item.id===library.deleteId)||({})
        CText { text:"Delete “"+(deleteConfirm.target.name||"")+"”?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Its index is erased from Cere’s memory and every conversation stops using it. Your files are not touched.";color:Theme.muted;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";Layout.fillWidth:true;onClicked:deleteConfirm.close() }
            CButton { objectName:"collectionDeleteConfirmed";text:"Delete collection";danger:true;Layout.fillWidth:true;onClicked:{deleteConfirm.close();library.call("collections.delete",{id:library.deleteId,expectedRevision:deleteConfirm.target.revision,confirmed:true},"Deleted the collection and its index.")} }
        }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id===library.listRequest){library.listRequest=-1;if(value?.error)library.error=String(value.error);else library.collections=value.collections||[];return}
            if(id!==library.request)return
            library.request=-1
            if(value?.error){library.error=String(value.error);library.feedback=""}
            library.reload()
        }
        function onStateChanged(){
            // Reload when an indexing run finishes or reports progress worth showing.
            const key=JSON.stringify(library.job||null)
            if(key!==library.jobKey){const finished=!!library.job?.done&&library.jobKey!=="";library.jobKey=key;if(library.opened&&finished)library.reload()}
        }
    }
}
