export const HOOK_VERSION = 1;
export const TTL = 30 * 60_000;
export type TelemetryConfig = { enabled: boolean; roots: string[]; ignores: string[]; commands: boolean; output: boolean };
export const telemetryDefaults: TelemetryConfig = { enabled:false, roots:[], ignores:[], commands:false, output:false };
export type Event = { v:1; type:'command'|'output'; session:string; seq:number; ts:string; pid:number; hook_version:number; cwd?:string; status?:number; cmd?:string; cmd_seq?:number; lines?:string[] };
/** Future managed terminals must submit the same untrusted wire event to validation,
 * capture policy and the bounded ingress queue. They must not mutate state directly. */
export interface ManagedTerminalEventSink { ingest(event:unknown):void }
export function redact(value: string): string {
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,'')
    .replace(/\b((?:[\w]*)(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)[\w]*\s*=\s*)(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s;]+)/gi,'$1[REDACTED]')
    .replace(/(--[\w-]*(?:password|passwd|secret|token|api[-_]?key|credential)[\w-]*(?:=|\s+))(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s;]+)/gi,'$1[REDACTED]')
    .replace(/(authorization\s*:\s*)(?:(?:bearer|basic)\s+)?[^\r\n]+/gi,'$1[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,'[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,})\b/g,'[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi,'$1[REDACTED]@');
}
export function clean(value: string): string {
  return redact(value).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[<>]/g,c=>c==='<'?'\\u003c':'\\u003e');
}
export function validate(value: unknown, config: TelemetryConfig): Event | undefined {
  if (!value || typeof value!=='object' || Array.isArray(value)) return;
  const p=value as Record<string,any>;
  if(p.v!==1 || !['command','output'].includes(p.type) || typeof p.session!=='string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(p.session) ||
    !Number.isSafeInteger(p.seq)||p.seq<1||!Number.isInteger(p.pid)||p.pid<1||!Number.isInteger(p.hook_version)||p.hook_version<1||
    typeof p.ts!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(p.ts)||!Number.isFinite(Date.parse(p.ts)))return;
  const e:Event={v:1,type:p.type,session:p.session,seq:p.seq,ts:p.ts,pid:p.pid,hook_version:p.hook_version};
  if(p.type==='command') {
    if(typeof p.cwd!=='string'||!p.cwd.startsWith('/')||p.cwd.length>4096||p.cwd.includes('\0')||!Number.isInteger(p.status)||p.status<0||p.status>255||
      (p.cmd!==undefined&&(typeof p.cmd!=='string'||p.cmd.length>8192)))return;
    e.cwd=p.cwd;e.status=p.status;if(config.commands&&p.cmd?.trim())e.cmd=redact(p.cmd);
  } else {
    if(!Number.isSafeInteger(p.cmd_seq)||p.cmd_seq<1||p.cmd_seq>=p.seq||!Array.isArray(p.lines)||p.lines.length>5||p.lines.some((s:unknown)=>typeof s!=='string'||s.length>512))return;
    if(!config.output)return;
    e.cmd_seq=p.cmd_seq;e.lines=p.lines.map(redact).filter((line:string)=>line.trim());
  }
  return e;
}
