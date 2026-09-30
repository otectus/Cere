import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id:remote
    title:"Cere Mobile"
    description:"Pair your Android companion over a selected LAN or WireGuard address. The desktop must stay awake and reachable."
    property var status:({})
    property var offer:({})
    property var review:({})
    property string error:""
    property int requestId:-1
    property string operation:""
    property var selectedCaps:["chat.read","chat.write","approvals.answer"]
    property var selectedCategories:[]
    property string editingDevice:""
    function call(method,params){if(requestId>=0)return;error="";operation=method;requestId=App.rpc(method,params||{})}
    function reload(){call("remote.status",{})}
    Component.onCompleted:reload()
    CText { text:App.state.remote?.listening?"Remote gateway is listening":"Remote gateway is closed";color:App.state.remote?.listening?Theme.cyan:Theme.muted }
    Flow {
        Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:8
        CButton { text:"Refresh";enabled:remote.requestId<0;onClicked:remote.reload() }
        CButton { text:"Disable remote access now";danger:true;enabled:App.connected;onClicked:App.rpc("remote.off",{}) }
        CButton { text:"Enable paired devices";enabled:remote.requestId<0&&(remote.status.devices||[]).some(d=>!d.revokedAt&&d.expiresAt>Date.now());onClicked:remote.call("remote.enable",{}) }
    }
    CText { text:"Disabling or revoking stops remote controlled work. Disconnecting a phone normally leaves accepted work running.";color:Theme.muted;font.pixelSize:12 }
    CField { id:desktopName;Layout.fillWidth:true;text:"Cere";placeholderText:"Desktop name";Accessible.name:"Desktop name for pairing" }
    CField { id:addresses;Layout.fillWidth:true;placeholderText:"Explicit IP addresses, comma separated";Accessible.name:"LAN or WireGuard bind addresses" }
    CText { text:"No public relay or firewall changes. Use your existing WireGuard VPN when away from home. Addresses must belong to this desktop.";color:Theme.muted;font.pixelSize:12 }
    CButton { text:"Prepare offline pairing QR";enabled:remote.requestId<0&&addresses.text.trim().length>0;onClicked:remote.call("remote.preparePair",{name:desktopName.text,addresses:addresses.text.split(",").map(a=>a.trim()).filter(a=>a.length)}) }
    Image { visible:!!remote.offer.qr;source:remote.offer.qr||"";Layout.fillWidth:true;Layout.preferredHeight:visible?320:0;fillMode:Image.PreserveAspectFit;Accessible.name:"Scan this pairing QR in Cere Mobile" }
    CText { visible:!!remote.offer.uri;text:"Scan within five minutes. Pairing does not open a listener until you compare words and confirm below.";color:Theme.muted;font.pixelSize:12 }
    CButton { visible:!!remote.offer.uri;text:"Copy offer text";onClicked:App.copy(remote.offer.uri) }
    ScrollView {
        Layout.fillWidth:true;Layout.preferredHeight:100;clip:true;contentWidth:availableWidth
        ScrollBar.horizontal.policy:ScrollBar.AlwaysOff
        ScrollBar.vertical:CScrollBar{}
        TextArea { id:response;wrapMode:TextEdit.Wrap;selectByMouse:true;placeholderText:"Paste the phone’s public signed response";color:Theme.text;font.pixelSize:12;Accessible.name:"Phone pairing response";onTextChanged:remote.review=({});background:Rectangle{color:Theme.input} }
    }
    CButton { text:"Verify phone response";enabled:remote.requestId<0&&response.text.trim().length>0;onClicked:remote.call("remote.reviewPair",{response:response.text.trim()}) }
    CText { visible:!!remote.review.sas;text:(remote.review.name||"Phone")+" · Compare both screens:\n"+(remote.review.sas||"");color:Theme.cyan;font.pixelSize:16 }
    CField { id:projects;Layout.fillWidth:true;placeholderText:"Approved project folders, separated by semicolons";Accessible.name:"Approved project paths separated by semicolons" }
    CText { text:"Project folders separated by semicolons. Confirming trusts their local CLI configuration for any native execution cap you select.";color:Theme.muted;font.pixelSize:12 }
    GridLayout {
        Layout.fillWidth:true;columns:width>=460?2:1
        Repeater {
            model:["chat.read","chat.write","approvals.answer","providers.execute","approvals.provider","desktop.control","settings.write","memory.read","memory.write","web","attachments.write","capture.preview"]
            CCheckBox { required property string modelData;text:modelData;checked:remote.selectedCaps.indexOf(modelData)>=0;onClicked:remote.selectedCaps=checked?remote.selectedCaps.concat([modelData]):remote.selectedCaps.filter(c=>c!==modelData) }
        }
    }
    CText { text:"Native provider execution and provider approvals grant substantial project access. Claude execution stays unavailable while native restrictions cannot be verified.";color:Theme.amber;font.pixelSize:12 }
    CText { text:"Attachments lets this phone send images to providers. Capture preview lets it view saved screen captures awaiting your sharing decision.";color:Theme.amber;font.pixelSize:12 }
    GridLayout {
        Layout.fillWidth:true;columns:width>=460?3:2
        Repeater {
            model:["apps","files","windows","audio","media","capture","timers","scripts","providers"]
            CCheckBox { required property string modelData;text:modelData;checked:remote.selectedCategories.indexOf(modelData)>=0;onClicked:remote.selectedCategories=checked?remote.selectedCategories.concat([modelData]):remote.selectedCategories.filter(c=>c!==modelData) }
        }
    }
    CText { text:"Categories also need ordinary desktop permission. All bypass toggles are ignored for remote work. Saved scripts need an explicit ID allowlist.";color:Theme.muted;font.pixelSize:12 }
    CField { id:scripts;Layout.fillWidth:true;placeholderText:"Allowed saved script IDs, comma separated (optional)";Accessible.name:"Allowed script IDs" }
    CText { visible:!!remote.editingDevice;text:"Editing this phone’s grants. Saving stops its current work and reconnects it with the reviewed projects, categories, and current desktop Ollama server.";color:Theme.amber;font.pixelSize:12 }
    CButton { visible:!!remote.editingDevice;text:"Save device grants";enabled:remote.requestId<0;onClicked:remote.call("remote.updateDevice",{id:remote.editingDevice,projectPaths:projects.text.split(";").map(p=>p.trim()).filter(p=>p.length),caps:remote.selectedCaps,categories:remote.selectedCategories,scriptIds:scripts.text.split(",").map(s=>s.trim()).filter(s=>s.length)}) }
    CCheckBox { id:compare;text:"All six words match the phone";enabled:!!remote.review.sas }
    CButton { text:"Confirm pairing and enable gateway";primary:true;enabled:remote.requestId<0&&compare.checked&&!!remote.review.sas&&projects.text.trim().length>0;onClicked:remote.call("remote.confirmPair",{response:response.text.trim(),sas:remote.review.sas,confirmed:true,projectPaths:projects.text.split(";").map(p=>p.trim()).filter(p=>p.length),caps:remote.selectedCaps,categories:remote.selectedCategories,scriptIds:scripts.text.split(",").map(s=>s.trim()).filter(s=>s.length)}) }
    Repeater {
        model:remote.status.devices||[]
        ColumnLayout {
            required property var modelData;Layout.fillWidth:true
            CText { Layout.fillWidth:true;text:modelData.name+" · "+(modelData.revokedAt?"Revoked":"Expires "+new Date(modelData.expiresAt).toLocaleDateString())+"\n"+(modelData.caps||[]).join(", ");font.pixelSize:12 }
            Flow { Layout.fillWidth:true;spacing:8;Layout.preferredHeight:childrenRect.height
            CButton { text:"Revoke";danger:true;enabled:!modelData.revokedAt&&remote.requestId<0;onClicked:remote.call("remote.revoke",{id:modelData.id}) }
            CButton { text:"Edit grants";enabled:!modelData.revokedAt&&remote.requestId<0;onClicked:{remote.editingDevice=modelData.id;remote.selectedCaps=modelData.caps;remote.selectedCategories=modelData.categories;projects.text=modelData.projects.map(p=>p.path).join("; ");scripts.text=modelData.scriptIds.join(", ")} }
            CButton { text:"Renew 90 days";enabled:!modelData.revokedAt&&remote.requestId<0;onClicked:remote.call("remote.renewDevice",{id:modelData.id,confirmed:true}) }
            CButton { text:"Clear retained images";enabled:remote.requestId<0;onClicked:remote.call("remote.purgeMedia",{id:modelData.id,confirmed:true}) }
            }
        }
    }
    CText { visible:!!remote.error;text:remote.error;color:Theme.danger;font.pixelSize:12 }
    CText { text:"Changed IP address or expired certificate? Reset the gateway identity, then pair each phone again. This revokes every phone and stops its work.";color:Theme.muted;font.pixelSize:12 }
    CCheckBox { id:resetConfirmed;text:"I will pair all phones again" }
    CButton { text:"Reset gateway identity";danger:true;enabled:resetConfirmed.checked&&remote.requestId<0;onClicked:{remote.call("remote.resetIdentity",{confirmed:true});resetConfirmed.checked=false} }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==remote.requestId)return
            const operation=remote.operation;remote.requestId=-1
            if(value?.error){remote.error=value.error;return}
            if(operation==="remote.status"){remote.status=value;if(!addresses.text)addresses.text=(value.config?.addresses||[]).join(", ")}
            else if(operation==="remote.preparePair"){remote.offer=value;remote.review=({});compare.checked=false}
            else if(operation==="remote.reviewPair"){remote.review=value;compare.checked=false}
            else {if(operation==="remote.confirmPair"||operation==="remote.resetIdentity"){remote.offer=({});remote.review=({});response.text="";compare.checked=false}if(operation==="remote.updateDevice"||operation==="remote.resetIdentity")remote.editingDevice="";remote.reload()}
        }
    }
}
