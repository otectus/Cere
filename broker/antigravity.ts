import { randomUUID } from 'node:crypto';
import { RpcProcess } from './wire.ts';
import { providerExecutable, type Hooks } from './providers.ts';
import { personalityInstructions } from './personality.ts';
import type { Adapter, Session, SendOptions, ModelOption } from './types.ts';

function pinnedEffort(model: string = '') { return /-(low|medium|high|max)$/.exec(model)?.[1]; }

export function antigravityModels(output: string): ModelOption[] {
  return output.split(/\r?\n/).flatMap(line => {
    const [id, label] = line.split('\t');
    const fixed=pinnedEffort(id);
    return id && label && /^[\w.:-]+$/.test(id) ? [{id,displayName:label.trim(),description:'AntiGravity CLI',efforts:(fixed?[fixed]:['low','medium','high']).map(id=>({id,displayName:id})),defaultEffort:fixed||'',isDefault:false}] : [];
  });
}

function resultError(value: unknown) {
  const message=typeof value==='string'?value:value&&typeof value==='object'&&'message' in value&&typeof value.message==='string'?value.message:'';
  return message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'')
    .replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [redacted]')
    .replace(/\b((?:access_token|refresh_token|api_key|apiKey|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,'$1[redacted]')
    .trim().slice(0,2000);
}
/** One headless process per turn: explicit conversation IDs avoid resuming unrelated CLI work. */
export class AntigravityAdapter implements Adapter {
  process?: RpcProcess; task?: Promise<void>; stopped=false;
  readonly session: Session; readonly hooks: Hooks;
  constructor(session: Session, hooks: Hooks) {this.session=session;this.hooks=hooks;}
  async send(text: string, images: string[] = [], options: SendOptions = {}) {
    if(this.task)throw new Error('This AntiGravity session is busy');
    if(this.hooks.restrictive)throw new Error('AntiGravity is available on the desktop only; its CLI cannot confirm Cere’s remote permission policy');
    if(images.length)throw new Error('AntiGravity headless input supports text attachments only. Use an API provider for images.');
    const fixed=pinnedEffort(this.session.model);
    // Catalog slugs such as gemini-3.1-pro-high already select an effort. Also
    // check saved sessions created before the catalog stopped offering conflicts.
    if(fixed&&this.session.effort&&this.session.effort!==fixed)throw new Error(`AntiGravity model ${this.session.model} selects ${fixed} effort and cannot use ${this.session.effort}. Open Model and choose Provider default or ${fixed} effort.`);
    const args=['--input-format','stream-json','--output-format','stream-json','--disable-slash-commands'];
    if(this.session.nativeId)args.push('--conversation',this.session.nativeId);
    if(this.session.model)args.push('--model',this.session.model);
    if(this.session.effort&&!fixed)args.push('--effort',this.session.effort);
    if(this.hooks.bypassCliPermissions?.())args.push('--dangerously-skip-permissions');
    options.beforeAccept?.(); this.stopped=false;
    const child=this.process=new RpcProcess(providerExecutable('antigravity'),args,this.session.cwd);
    let accepted=false, settled=false, resolveAccepted!:()=>void, rejectAccepted!:(error:unknown)=>void;
    const acceptance=new Promise<void>((resolve,reject)=>{resolveAccepted=resolve;rejectAccepted=reject;});
    // Desktop callers do not await an acknowledgement, but still observe failures via hooks.
    void acceptance.catch(()=>{});
    const accept=()=>{if(!accepted){accepted=true;options.onAccepted?.();resolveAccepted();}};
    let timer: NodeJS.Timeout;
    const ids=new Map<number,string>(), replies=new Map<string,string>(), completed=new Set<string>(); let lastReply='';
    let finish!:(event:{type:string;text?:string})=>void;
    this.task=new Promise<void>(resolve=>{
      finish=event=>{if(settled)return;settled=true;clearTimeout(timer);if(!accepted)rejectAccepted(new Error(event.text||'AntiGravity did not accept the turn'));void child.close().finally(()=>{this.task=undefined;this.process=undefined;this.hooks.event(event);resolve();});};
      timer=setTimeout(()=>finish({type:'error',text:'AntiGravity did not finish within ten minutes. The turn was stopped; it was not retried.'}),600000);timer.unref();
      child.on('fault',()=>finish({type:this.stopped?'interrupted':'error',text:'AntiGravity could not start or its stream failed. Check the installed agy CLI and sign in using agy.'}));
      child.on('exit',()=>finish({type:this.stopped?'interrupted':'error',text:'AntiGravity exited before completing its response. Check agy authentication and permissions.'}));
      child.on('message',value=>{
        if(settled)return;
        try {
          const nativeId=value.conversation_id || value.result?.conversation_id;
          if(typeof nativeId==='string'&&nativeId){this.session.nativeId=nativeId;this.hooks.native(nativeId);}
          const step=value.step_update;
          if(value.event==='step_update'&&step){
            if(step.step_type==='user_input')accept();
            const id=ids.get(step.step_index)||randomUUID();ids.set(step.step_index,id);
            if(step.step_type==='agent_response') {
              if(typeof step.text_delta==='string') {lastReply=id;replies.set(id,(replies.get(id)||'')+step.text_delta);this.hooks.event({type:'delta',id,text:step.text_delta});}
              if(step.state==='DONE'&&replies.get(id)){this.hooks.event({type:'message',id,text:replies.get(id)});completed.add(id);}
            } else if(step.step_type==='tool') this.hooks.event({type:'tool',id,text:(step.tool_name||'Tool')+'\n'+JSON.stringify(step.tool_info||{})});
            else if(step.step_type!=='user_input')this.hooks.event({type:'activity',text:'thinking'});
          }
          if(value.event==='result') {
            const result=value.result;
            if(result?.status==='SUCCESS') {accept();if(!lastReply&&result.response)this.hooks.event({type:'message',id:randomUUID(),text:result.response});else if(lastReply&&!completed.has(lastReply))this.hooks.event({type:'message',id:lastReply,text:replies.get(lastReply)});finish({type:'complete'});}
            else finish({type:['CANCELED','INTERRUPTED'].includes(result?.status)?'interrupted':'error',text:`AntiGravity ended with ${result?.status||'an invalid result'}. ${resultError(result?.error)||'The CLI returned no error details.'}`});
          }
        } catch {finish({type:'error',text:'Invalid AntiGravity response'});}
      });
    });
    try {
      child.write({event:'user',message:{content:personalityInstructions(this.hooks.personality?.())+'\n\n'+text}});
      options.onDispatched?.();
    } catch {finish({type:'error',text:'AntiGravity disconnected before the prompt was sent'});}
    if(options.onAccepted)await acceptance;
  }
  async interrupt(){this.stopped=true;await this.process?.close();await this.task;}
  async close(){await this.interrupt();}
}
