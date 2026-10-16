import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A06: saved styles and recipes as a portable package. Packages never carry API keys, permissions,
// project grants, bindings or local history, and an imported style can only withhold tools.
// Importing shows what is new or changed first; nothing is saved until the reviewed preview is imported.
CDialog {
    id:packages;objectName:"packageDialog"
    width:Math.min(600,parent?parent.width-32:600)
    property string mode:"export"
    property var styles:[]
    property var recipes:[]
    property var chosen:({})
    property var preview:null
    property int request:-1
    property string action:""
    property string error:""
    property string feedback:""
    readonly property int chosenCount:Object.keys(chosen).length
    readonly property var actionLabels:({new:"New",changed:"Updates the saved copy",unchanged:"Already the same"})
    function reset(){styles=[];recipes=[];chosen=({});preview=null;error="";feedback=""}
    function call(method,params){error="";action=method;request=App.rpc(method,params)}
    function openExport(){mode="export";reset();call("presets.list",{});open()}
    function previewFile(path){mode="import";reset();if(path)call("packages.preview",{path:path});open()}
    function toggle(key,on){const next=Object.assign({},chosen);if(on)next[key]=true;else delete next[key];chosen=next}
    function ids(prefix){return Object.keys(chosen).filter(key=>key.startsWith(prefix)).map(key=>key.slice(prefix.length))}
    CText { text:packages.mode==="export"?"Export styles and recipes":"Import a package";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:"Packages hold style text, traits, limits and recipe definitions only. They never include API keys, permissions, project grants, bindings or checkpoints.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    ColumnLayout {
        visible:packages.mode==="export";Layout.fillWidth:true;spacing:6
        CText { text:"Saved styles";font.weight:Font.DemiBold }
        CText { visible:packages.styles.length===0;text:"No saved styles.";color:Theme.muted;font.pixelSize:Theme.secondary }
        Repeater { model:packages.styles;CCheckBox { required property var modelData;required property int index;objectName:"packageStyle_"+index;text:modelData.label;checked:!!packages.chosen["style:"+modelData.id];onToggled:packages.toggle("style:"+modelData.id,checked) } }
        CText { text:"Recipes";font.weight:Font.DemiBold }
        CText { visible:packages.recipes.length===0;text:"No recipes of your own. Built-in recipes are not exported.";color:Theme.muted;font.pixelSize:Theme.secondary }
        Repeater { model:packages.recipes;CCheckBox { required property var modelData;required property int index;objectName:"packageRecipe_"+index;text:modelData.name+" · version "+modelData.version;checked:!!packages.chosen["recipe:"+modelData.id];onToggled:packages.toggle("recipe:"+modelData.id,checked) } }
        CButton { objectName:"packageExportSave";text:packages.request>=0?"Preparing…":"Save package as…";primary:true;Layout.fillWidth:true;enabled:App.connected&&packages.request<0&&packages.chosenCount>0;onClicked:packages.call("packages.export",{profiles:packages.ids("style:"),recipes:packages.ids("recipe:")}) }
    }
    ColumnLayout {
        visible:packages.mode==="import"&&!!packages.preview;Layout.fillWidth:true;spacing:6
        Repeater {
            model:packages.preview?(packages.preview.profiles||[]).map(item=>({kind:"Style",name:item.label,action:item.action})).concat((packages.preview.recipes||[]).map(item=>({kind:"Recipe",name:item.name,action:item.action}))):[]
            RowLayout {
                required property var modelData
                required property int index
                Layout.fillWidth:true
                CText { objectName:"packageItem_"+index;Layout.fillWidth:true;elide:Text.ElideRight;text:modelData.kind+" · "+modelData.name }
                CText { text:packages.actionLabels[modelData.action]||modelData.action;color:modelData.action==="unchanged"?Theme.muted:Theme.accentText;font.pixelSize:Theme.secondary }
            }
        }
        CButton {
            objectName:"packageImportConfirm";text:packages.request>=0?"Importing…":"Import";primary:true;Layout.fillWidth:true
            enabled:App.connected&&packages.request<0&&!!packages.preview&&[...(packages.preview.profiles||[]),...(packages.preview.recipes||[])].some(item=>item.action!=="unchanged")
            onClicked:packages.call("packages.import",{token:packages.preview.token,digest:packages.preview.digest})
        }
    }
    CText { visible:packages.mode==="import"&&packages.request>=0&&!packages.preview;text:"Checking the package…";color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { objectName:"packageError";visible:!!packages.error;text:packages.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"packageFeedback";visible:!!packages.feedback;text:packages.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CButton { text:"Close";Layout.fillWidth:true;onClicked:packages.close() }
    Connections {
        target:App
        function onResult(id,value){
            if(id!==packages.request)return
            packages.request=-1
            if(value?.error){packages.error=String(value.error);if(packages.action==="packages.import")packages.preview=null;return}
            if(packages.action==="presets.list"){packages.styles=value.items||[];packages.call("recipes.list",{});return}
            if(packages.action==="recipes.list"){packages.recipes=(value.recipes||[]).filter(recipe=>!recipe.builtin);return}
            if(packages.action==="packages.export"){const path=App.saveTextAs(value.filename,value.text);packages.feedback=path?"Saved "+value.profiles+" styles and "+value.recipes+" recipes to "+path:"Not saved.";return}
            if(packages.action==="packages.preview"){packages.preview=value;return}
            if(packages.action==="packages.import"){
                const changed=[...(value.profiles||[]),...(value.recipes||[])].filter(item=>item.action!=="unchanged").length
                packages.preview=null;packages.feedback="Imported "+changed+(changed===1?" item":" items")+". Nothing else changed: permissions, bindings and the personality in use stay as they were."
            }
        }
    }
}
