import { randomUUID,createHash } from 'node:crypto';
import type { Core } from './core.ts';
import { validateAction } from './desktop.ts';

/** Small deterministic arithmetic grammar. No JavaScript or shell evaluation. */
export function calculate(input:unknown):number {
  if(typeof input!=='string'||input.length>256||!input.trim())throw new Error('Enter an arithmetic expression of up to 256 characters');
  const tokens=input.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+\-*/%^]|\s+|./g)!.filter(t=>!/^\s+$/.test(t));
  let at=0;
  const expression=(minimum=0,depth=0):number=>{
    if(depth>32)throw new Error('Expression nesting is too deep');
    let value:number,token=tokens[at++];
    if(token==='('){value=expression(0,depth+1);if(tokens[at++]!==')')throw new Error('Close the parenthesis');}
    else if(token==='+'||token==='-')value=(token==='-'?-1:1)*expression(3,depth+1);
    else {if(!token||!/^\d|^\.\d/.test(token))throw new Error('Use numbers and arithmetic operators only');value=Number(token);if(!Number.isFinite(value))throw new Error('Invalid number');}
    for(;;){const op=tokens[at],precedence=op==='+'||op==='-'?1:op==='*'||op==='/'||op==='%'?2:op==='^'?4:0;if(!precedence||precedence<minimum)break;at++;const right=expression(op==='^'?precedence:precedence+1,depth+1);if((op==='/'||op==='%')&&right===0)throw new Error('Division by zero');value=op==='+'?value+right:op==='-'?value-right:op==='*'?value*right:op==='/'?value/right:op==='%'?value%right:value**right;if(!Number.isFinite(value))throw new Error('Result exceeds the numeric range');}
    return value;
  };
  const value=expression();if(at!==tokens.length)throw new Error('Unexpected expression input');return value;
}
const units:Record<string,[string,number]>={m:['length',1],cm:['length',.01],km:['length',1000],in:['length',.0254],ft:['length',.3048],mi:['length',1609.344],g:['mass',1],kg:['mass',1000],oz:['mass',28.349523125],lb:['mass',453.59237],s:['time',1],min:['time',60],h:['time',3600],B:['data',1],KiB:['data',1024],MiB:['data',1048576],GiB:['data',1073741824]};
export function convert(value:unknown,from:string,to:string){
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Enter a finite number');
  if(['C','F','K'].includes(from)&&['C','F','K'].includes(to)){const c=from==='F'?(value-32)*5/9:from==='K'?value-273.15:value;if(c< -273.15)throw new Error('Temperature is below absolute zero');return to==='F'?c*9/5+32:to==='K'?c+273.15:c;}
  if(!units[from]||!units[to]||units[from][0]!==units[to][0])throw new Error('Choose units of the same kind');return value*units[from][1]/units[to][1];
}
type Entry={id:string;kind:'note'|'task';title:string;text:string;done:boolean;revision:string;updated:number};
type Step={name:string;args:Record<string,unknown>};
export class Utilities {
  core:Core; previews=new Map<string,{steps:Step[];digest:string;expires:number}>();running=new Map<string,AbortController>();
  constructor(core:Core){this.core=core;}
  async dispatch(method:string,p:any){
    if(method==='utility.calculate')return{value:calculate(p.expression)};
    if(method==='utility.convert')return{value:convert(p.value,p.from,p.to)};
    if(method==='utility.list')return this.core.store.get<Entry[]>('utilityEntries',[]);
    if(method==='utility.save'||method==='utility.delete'){
      const entries=this.core.store.get<Entry[]>('utilityEntries',[]),old=entries.find(e=>e.id===p.id);
      if(p.id&&(!old||old.revision!==p.expectedRevision))throw new Error('This entry changed. Reload before editing.');
      if(method==='utility.delete'){this.core.store.set('utilityEntries',entries.filter(e=>e.id!==p.id));return true;}
      if(!['note','task'].includes(p.kind)||typeof p.title!=='string'||!p.title.trim()||p.title.length>200||typeof p.text!=='string'||p.text.length>20000||typeof p.done!=='boolean')throw new Error('Enter a title and bounded note or task');
      if(!old&&entries.length>=1000)throw new Error('The utility shelf limit is 1,000 entries');
      const entry:Entry={id:old?.id||randomUUID(),kind:p.kind,title:p.title.trim(),text:p.text,done:p.done,revision:String(BigInt(old?.revision||'0')+1n),updated:Date.now()};
      this.core.store.set('utilityEntries',[entry,...entries.filter(e=>e.id!==entry.id)]);return entry;
    }
    if(method==='routine.preview'){
      if(!Array.isArray(p.steps)||!p.steps.length||p.steps.length>8)throw new Error('Choose 1–8 routine steps');
      const allowed=['apps.launch','files.open','windows.focus','windows.move','workspace.switch','timer.start'];
      const steps=p.steps.map((s:any)=>{if(!allowed.includes(s.name))throw new Error('This action is not supported in a reviewed routine');validateAction(s.name,s.args);return{name:s.name,args:structuredClone(s.args)};});
      const digest=createHash('sha256').update(JSON.stringify(steps)).digest('hex'),id=randomUUID();this.previews.clear();this.previews.set(id,{steps,digest,expires:Date.now()+300000});
      return{id,digest,steps,undo:'Only newly created timers can be undone automatically. Applications and workspace changes remain visible in the result.'};
    }
    if(method==='routine.cancel'){this.running.get(p.id)?.abort(new Error('Routine cancelled'));return true;}
    if(method==='routine.run'){
      const preview=this.previews.get(p.id);if(!preview||preview.digest!==p.digest||preview.expires<Date.now())throw new Error('Review the routine again');this.previews.delete(p.id);
      const controller=new AbortController();this.running.set(p.id,controller);const results:any[]=[];
      try{for(const step of preview.steps){controller.signal.throwIfAborted();const result=await this.core.action(step.name,step.args,undefined,controller.signal);results.push({name:step.name,result,...(step.name==='timer.start'?{undoTimerId:result.id}:{})});}return{state:'completed',results};}
      catch(error:any){return{state:controller.signal.aborted?'cancelled':'failed',error:error.message,results};}
      finally{this.running.delete(p.id);}
    }
    if(method==='timer.pause'||method==='timer.resume'||method==='timer.repeat'){
      const timer=this.core.store.timers().find(t=>t.id===p.id);if(!timer)throw new Error('Timer no longer exists');
      if(method==='timer.pause'&&!timer.paused){timer.remaining=Math.max(1,timer.due-Date.now());timer.paused=true;}
      if(method==='timer.resume'&&timer.paused){timer.due=Date.now()+timer.remaining;timer.paused=false;}
      if(method==='timer.repeat'){if(!Number.isInteger(p.minutes)||p.minutes<0||p.minutes>10080)throw new Error('Repeat interval must be 0–10080 minutes');timer.repeatMinutes=p.minutes;}
      this.core.store.timer(timer);this.core.changed();return timer;
    }
    throw new Error('Unknown utility operation');
  }
  close(){for(const controller of this.running.values())controller.abort(new Error('Cere is closing'));}
}
