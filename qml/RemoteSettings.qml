import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id:remote
    objectName:"remoteSettings"
    title:"Cere Mobile"
    description:"Pair your Android companion: choose where it reaches this computer, scan the QR with Cere Mobile, then compare the same six words on both screens and confirm here. The desktop must stay awake and reachable."
    property var status:({})
    property var offer:({})
    property var review:({})
    property string error:""
    property int requestId:-1
    property string operation:""
    property var selectedCaps:["chat.read","chat.write","approvals.answer"]
    property var selectedCategories:[]
    // Hosted API providers this phone may run with the providers.api grant.
    property var selectedApiProviders:[]
    // The compatible connection whose origin the compatible grant names; empty: the Settings endpoint.
    property string compatibleConnection:""
    property string editingDevice:""
    property string replacingDevice:""
    // The live network-return offer, from the broker: a phone's answer and its six words once it arrives.
    readonly property var pairing:App.state.remote?.pairing||null
    readonly property var received:pairing&&pairing.received&&!pairing.received.contested?pairing.received:null
    readonly property bool contested:!!(pairing&&(pairing.contested||pairing.received?.contested))
    // The words to compare: from a pasted response when one was verified, otherwise from the network answer.
    readonly property string sas:review.sas||(received?received.sas:"")
    onSasChanged:compare.checked=false
    function call(method,params){if(requestId>=0)return;error="";operation=method;requestId=App.rpc(method,params||{})}
    function reload(){call("remote.status",{})}
    function addressList(){return addresses.text.split(",").map(a=>a.trim()).filter(a=>a.length)}
    function toggleAddress(address,on){const list=addressList().filter(a=>a!==address);if(on)list.push(address);addresses.text=list.join(", ")}
    function projectList(){return projects.text.split(";").map(p=>p.trim()).filter(p=>p.length)}
    function toggleProject(path,on){const list=projectList().filter(p=>p!==path);if(on)list.push(path);projects.text=list.join("; ")}
    function kindLabel(kind){return ({tailscale:"Tailscale",wireguard:"WireGuard",lan:"Local network",virtual:"Virtual network",other:"Other"})[kind]||kind}
    function grants(){
        const value={projectPaths:projectList(),caps:remote.selectedCaps,categories:remote.selectedCategories,scriptIds:scripts.text.split(",").map(s=>s.trim()).filter(s=>s.length),apiProviders:remote.selectedCaps.indexOf("providers.api")>=0?remote.selectedApiProviders:[]}
        if(remote.compatibleConnection&&value.apiProviders.indexOf("compatible")>=0)value.compatibleConnectionId=remote.compatibleConnection
        return value
    }
    function preset(caps,categories){remote.selectedCaps=caps;remote.selectedCategories=categories}
    Component.onCompleted:reload()
    CText { text:App.state.remote?.listening?(remote.pairing&&!(remote.status.devices||[]).some(d=>!d.revokedAt&&d.expiresAt>Date.now())?"Listening for the phone’s answer to the pairing QR":"Remote gateway is listening"):(App.state.remote?.enabled?"Waiting for a configured network":"Remote gateway is closed");color:App.state.remote?.listening?Theme.accentText:Theme.muted }
    Flow {
        Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:8
        CButton { text:"Refresh";enabled:remote.requestId<0;onClicked:remote.reload() }
        CButton { objectName:"disableRemote";text:"Disable remote access now";danger:true;enabled:App.connected;onClicked:App.rpc("remote.off",{}) }
        CButton { text:"Enable paired devices";enabled:remote.requestId<0&&(remote.status.devices||[]).some(d=>!d.revokedAt&&d.expiresAt>Date.now());onClicked:remote.call("remote.enable",{}) }
    }
    CText { text:"Disabling or revoking stops remote controlled work. Disconnecting a phone normally leaves accepted work running.";color:Theme.muted;font.pixelSize:12 }

    CText { text:"1 · Where your phone reaches this computer";font.pixelSize:15;Layout.topMargin:8 }
    Repeater {
        model:(remote.status.addressCandidates||[]).filter(c=>c.kind!=="virtual")
        CCheckBox { required property var modelData;required property int index;objectName:"pairAddress_"+index
            text:modelData.address+" · "+remote.kindLabel(modelData.kind)+" ("+modelData.interface+")";checked:remote.addressList().indexOf(modelData.address)>=0
            onClicked:{remote.toggleAddress(modelData.address,checked);checked=Qt.binding(()=>remote.addressList().indexOf(modelData.address)>=0)} }
    }
    CField { id:addresses;objectName:"pairAddresses";Layout.fillWidth:true;placeholderText:"Or type up to three IP addresses, comma separated";Accessible.name:"LAN or WireGuard bind addresses" }
    CText { text:"Choose this PC’s Tailscale address to reach it away from home (keep Tailscale on both devices and Cere monitoring enabled), and its local network address for home Wi-Fi.";color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CField { id:desktopName;Layout.fillWidth:true;text:"Cere";placeholderText:"Desktop name";Accessible.name:"Desktop name for pairing" }
    CCheckBox { id:trustedPhone;text:"Trusted phone — no fingerprint or PIN for Cere actions" }
    CText { text:"Trusted mode keeps commands signed. Anyone using the unlocked phone can perform its granted actions. Changing mode requires replacement pairing.";color:Theme.muted;font.pixelSize:12 }
    CCheckBox { id:networkReturn;objectName:"networkReturn";checked:true;text:"Let the phone send its answer back over the network" }
    CText { text:networkReturn.checked?"For the five minutes the QR is valid, Cere listens on the chosen addresses and accepts only the phone’s signed answer; nothing is paired until you compare the words and confirm below.":"Offline pairing: copy or share the phone’s response to this PC and paste it below. Cere opens no listener until you confirm.";color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:!!remote.replacingDevice;text:"Replacing this phone’s pairing while preserving its drafts and conversation cache.";color:Theme.accentText;font.pixelSize:12 }
    CButton { objectName:"showPairingQr";primary:!remote.offer.uri;text:remote.offer.uri?"Show a new pairing QR":"Show pairing QR";enabled:remote.requestId<0&&remote.addressList().length>0
        onClicked:{let params={name:desktopName.text,addresses:remote.addressList(),actionAuthentication:trustedPhone.checked?"trusted-device":"biometric",networkReturn:networkReturn.checked};if(remote.replacingDevice)params.replacesDeviceId=remote.replacingDevice;remote.review=({});response.text="";remote.call("remote.preparePair",params)} }
    CText { visible:!!App.state.remote?.networkError;text:App.state.remote?.networkError||"";color:Theme.amber;font.pixelSize:12 }
    Image { visible:!!remote.offer.qr;source:remote.offer.qr||"";Layout.fillWidth:true;Layout.preferredHeight:visible?320:0;fillMode:Image.PreserveAspectFit;Accessible.name:"Scan this pairing QR in Cere Mobile" }
    CText { visible:!!remote.offer.uri;text:"In Cere Mobile, tap Scan and point the camera here within five minutes."+(remote.offer.networkReturn?" The phone then sends its answer to this PC by itself.":"");color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Flow {
        visible:!!remote.offer.uri;Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:8
        CButton { text:"Copy offer text";onClicked:App.copy(remote.offer.uri) }
        CButton { objectName:"cancelPairing";text:"Cancel this offer";enabled:remote.requestId<0;onClicked:remote.call("remote.cancelPair",{}) }
    }

    CText { text:"2 · Compare the six words";font.pixelSize:15;Layout.topMargin:8 }
    CText { visible:!!remote.offer.networkReturn&&!!remote.pairing&&!remote.received&&!remote.contested&&!remote.review.sas;text:"Waiting for the phone’s answer…";color:Theme.muted }
    CText { visible:remote.contested;text:"Two different phones answered this QR, so it was cancelled and nothing was paired. Show a new pairing QR and scan it with only your phone.";color:Theme.amber;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"pairingWords";visible:!!remote.sas
        text:((remote.review.sas?remote.review.name:remote.received?.name)||"Phone")+" answered · compare both screens:\n"+remote.sas+"\n"+((remote.review.sas?remote.review.actionAuthentication:remote.received?.actionAuthentication)==="trusted-device"?"Trusted phone: no fingerprint or PIN":"Actions require fingerprint or PIN")
        color:Theme.accentText;font.pixelSize:16;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { text:remote.offer.networkReturn?"No answer arriving (a firewall or a different network)? Copy or share the phone’s response, then paste it or load its file here:":"Paste the phone’s public signed response, or load the file it shared:";color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true }
    ScrollView {
        Layout.fillWidth:true;Layout.preferredHeight:100;clip:true;contentWidth:availableWidth
        ScrollBar.horizontal.policy:ScrollBar.AlwaysOff
        ScrollBar.vertical:CScrollBar{}
        TextArea { id:response;objectName:"pairingResponse";wrapMode:TextEdit.Wrap;selectByMouse:true;placeholderText:"Paste the phone’s public signed response";color:Theme.text;font.pixelSize:12;Accessible.name:"Phone pairing response";onTextChanged:remote.review=({});background:Rectangle{color:Theme.input}
            // Tab and Shift+Tab move between controls, as in CTextArea.
            Keys.onTabPressed:event=>{const next=response.nextItemInFocusChain(true);if(next&&next!==response)next.forceActiveFocus(Qt.TabFocusReason);event.accepted=true}
            Keys.onBacktabPressed:event=>{const previous=response.nextItemInFocusChain(false);if(previous&&previous!==response)previous.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true} }
    }
    Flow {
        Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:8
        CButton { text:"Load response file…";enabled:remote.requestId<0;Accessible.description:"Choose a text file the phone shared that contains its signed response";onClicked:{const p=App.chooseFile();if(p)remote.call("remote.readPairResponse",{path:p})} }
        CButton { text:"Verify pasted response";enabled:remote.requestId<0&&response.text.trim().length>0;onClicked:remote.call("remote.reviewPair",{response:response.text.trim()}) }
    }

    CText { text:"3 · What this phone may use";font.pixelSize:15;Layout.topMargin:8 }
    Repeater {
        model:remote.status.knownProjects||[]
        CCheckBox { required property var modelData;required property int index;objectName:"pairProject_"+index
            text:modelData.name+" · "+modelData.path;checked:remote.projectList().indexOf(modelData.path)>=0;onClicked:{remote.toggleProject(modelData.path,checked);checked=Qt.binding(()=>remote.projectList().indexOf(modelData.path)>=0)} }
    }
    CField { id:projects;objectName:"pairProjects";Layout.fillWidth:true;placeholderText:"Or type project folders, separated by semicolons";Accessible.name:"Approved project paths separated by semicolons" }
    CText { text:"Confirming trusts these folders’ local CLI configuration for any native execution cap you select.";color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Flow {
        Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:8
        CButton { objectName:"grantPresetChat";text:"Chat only";onClicked:remote.preset(["chat.read","chat.write"],[]) }
        CButton { objectName:"grantPresetApprovals";text:"Chat and approvals";onClicked:remote.preset(["chat.read","chat.write","approvals.answer","attachments.write","web"],[]) }
        CButton { objectName:"grantPresetProviders";text:"Chat, approvals and coding agents";onClicked:remote.preset(["chat.read","chat.write","approvals.answer","attachments.write","web","providers.execute","approvals.provider"],[]) }
    }
    GridLayout {
        Layout.fillWidth:true;columns:width>=460?2:1
        Repeater {
            model:["chat.read","chat.write","approvals.answer","providers.execute","providers.api","approvals.provider","desktop.control","settings.write","memory.read","memory.write","web","attachments.write","capture.preview"]
            CCheckBox { required property string modelData;text:modelData;checked:remote.selectedCaps.indexOf(modelData)>=0;onClicked:remote.selectedCaps=checked?remote.selectedCaps.concat([modelData]):remote.selectedCaps.filter(c=>c!==modelData) }
        }
    }
    CText { text:"Native provider execution and provider approvals grant substantial project access. Claude execution stays unavailable while native restrictions cannot be verified.";color:Theme.amber;font.pixelSize:12 }
    CText { text:"Attachments lets this phone send images to providers. Capture preview lets it view saved screen captures awaiting your sharing decision.";color:Theme.amber;font.pixelSize:12 }
    // W08: hosted API use from the phone is billed to this desktop's keys, so each provider is chosen here.
    CText { visible:remote.selectedCaps.indexOf("providers.api")>=0;text:"Hosted API providers this phone may use. Requests use this desktop’s keys and may be billed. The compatible grant covers one endpoint origin: choose which.";color:Theme.amber;font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true }
    GridLayout {
        visible:remote.selectedCaps.indexOf("providers.api")>=0
        Layout.fillWidth:true;columns:width>=460?4:2
        Repeater {
            model:[{id:"openai",label:"OpenAI API"},{id:"anthropic",label:"Claude API"},{id:"google",label:"Google AI API"},{id:"compatible",label:App.state.settings?.compatible?.label||"Compatible endpoint"}]
            CCheckBox { required property var modelData;objectName:"apiGrant_"+modelData.id;text:modelData.label;checked:remote.selectedApiProviders.indexOf(modelData.id)>=0;onClicked:remote.selectedApiProviders=checked?remote.selectedApiProviders.concat([modelData.id]):remote.selectedApiProviders.filter(p=>p!==modelData.id) }
        }
    }
    CComboBox {
        id:compatibleChoice;objectName:"compatibleGrant";Layout.fillWidth:true
        visible:remote.selectedCaps.indexOf("providers.api")>=0&&remote.selectedApiProviders.indexOf("compatible")>=0&&(remote.status.compatibleConnections||[]).length>1
        readonly property var options:[{id:"",label:"The Settings endpoint"}].concat((remote.status.compatibleConnections||[]).filter(c=>!c.settingsDefault).map(c=>({id:c.id,label:c.name+" · "+c.origin})))
        model:options.map(o=>o.label);Accessible.name:"Compatible connection this phone may use"
        currentIndex:Math.max(0,options.findIndex(o=>o.id===remote.compatibleConnection))
        onActivated:index=>remote.compatibleConnection=options[index].id
    }
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
    CButton { visible:!!remote.editingDevice;text:"Save device grants";enabled:remote.requestId<0;onClicked:remote.call("remote.updateDevice",Object.assign({id:remote.editingDevice},remote.grants())) }
    CCheckBox { id:compare;objectName:"pairingWordsMatch";text:"All six words match the phone";enabled:!!remote.sas }
    CButton { objectName:"confirmPairing";text:"Confirm pairing and enable gateway";primary:true;enabled:remote.requestId<0&&compare.checked&&!!remote.sas&&remote.projectList().length>0
        onClicked:remote.call("remote.confirmPair",Object.assign(remote.review.sas?{response:response.text.trim(),sas:remote.review.sas}:{pairingId:remote.pairing.pairingId,sas:remote.received.sas},{confirmed:true},remote.grants())) }
    Repeater {
        model:remote.status.devices||[]
        ColumnLayout {
            required property var modelData;Layout.fillWidth:true
            CText { Layout.fillWidth:true;text:modelData.name+" · "+(modelData.revokedAt?"Revoked":"Expires "+new Date(modelData.expiresAt).toLocaleDateString())+" · "+(modelData.actionAuthentication==="trusted-device"?"Trusted phone":"Biometric actions")+"\n"+(modelData.caps||[]).join(", ");font.pixelSize:12 }
            Flow { Layout.fillWidth:true;spacing:8;Layout.preferredHeight:childrenRect.height
            CButton { text:"Revoke";danger:true;enabled:!modelData.revokedAt&&remote.requestId<0;onClicked:remote.call("remote.revoke",{id:modelData.id}) }
            CButton { text:"Edit grants";enabled:!modelData.revokedAt&&remote.requestId<0;onClicked:{remote.editingDevice=modelData.id;remote.selectedCaps=modelData.caps;remote.selectedCategories=modelData.categories;remote.selectedApiProviders=modelData.apiProviders||[];remote.compatibleConnection=(remote.status.compatibleConnections||[]).find(c=>!c.settingsDefault&&c.origin===modelData.compatibleEndpoint)?.id||"";projects.text=modelData.projects.map(p=>p.path).join("; ");scripts.text=modelData.scriptIds.join(", ")} }
            CButton { text:"Replace pairing";enabled:!modelData.revokedAt&&remote.requestId<0;onClicked:{remote.replacingDevice=modelData.id;remote.selectedCaps=modelData.caps;remote.selectedCategories=modelData.categories;remote.selectedApiProviders=modelData.apiProviders||[];remote.compatibleConnection=(remote.status.compatibleConnections||[]).find(c=>!c.settingsDefault&&c.origin===modelData.compatibleEndpoint)?.id||"";projects.text=modelData.projects.map(p=>p.path).join("; ");scripts.text=modelData.scriptIds.join(", ");trustedPhone.checked=modelData.actionAuthentication==="trusted-device";remote.offer=({});remote.review=({});response.text=""} }
            CButton { text:"Renew 90 days";enabled:!modelData.revokedAt&&remote.requestId<0;onClicked:remote.call("remote.renewDevice",{id:modelData.id,confirmed:true}) }
            CButton { text:"Clear retained images";enabled:remote.requestId<0;onClicked:remote.call("remote.purgeMedia",{id:modelData.id,confirmed:true}) }
            }
        }
    }
    CText { visible:!!remote.error;text:remote.error;color:Theme.danger;font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { text:"Changed IP address or expired certificate? Update the addresses or renew the certificate, then replace each phone’s pairing; or reset the gateway identity and pair each phone again. Reset revokes every phone and stops its work.";color:Theme.muted;font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CCheckBox { id:endpointsConfirmed;text:"Update addresses or renew certificate; paired phones will need replacement pairing" }
    CButton { text:"Update gateway addresses / certificate";enabled:endpointsConfirmed.checked&&remote.requestId<0&&remote.addressList().length>0;onClicked:{remote.call("remote.configureEndpoints",{addresses:remote.addressList(),confirmed:true});endpointsConfirmed.checked=false} }
    CCheckBox { id:resetConfirmed;text:"I will pair all phones again" }
    CButton { text:"Reset gateway identity";danger:true;enabled:resetConfirmed.checked&&remote.requestId<0;onClicked:{remote.call("remote.resetIdentity",{confirmed:true});resetConfirmed.checked=false} }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==remote.requestId)return
            const operation=remote.operation;remote.requestId=-1
            if(value?.error){remote.error=value.error;return}
            if(operation==="remote.status"){
                remote.status=value
                if(!addresses.text){
                    // Configured addresses first; otherwise this PC's first Tailscale and local network IPv4 addresses.
                    const configured=value.config?.addresses||[],candidates=(value.addressCandidates||[]).filter(c=>c.address.indexOf(":")<0)
                    addresses.text=(configured.length?configured:["tailscale","lan"].map(kind=>candidates.find(c=>c.kind===kind)?.address).filter(a=>!!a)).join(", ")
                }
            }
            else if(operation==="remote.preparePair"){remote.offer=value;remote.review=({});compare.checked=false}
            else if(operation==="remote.reviewPair"){remote.review=value;compare.checked=false}
            else if(operation==="remote.readPairResponse"){response.text=value.response||"";remote.review=({});compare.checked=false}
            else if(operation==="remote.cancelPair"){remote.offer=({});remote.review=({});compare.checked=false}
            else {if(operation==="remote.confirmPair"||operation==="remote.resetIdentity"){remote.offer=({});remote.review=({});response.text="";compare.checked=false;remote.replacingDevice=""}if(operation==="remote.updateDevice"||operation==="remote.resetIdentity")remote.editingDevice="";remote.reload()}
        }
    }
}
