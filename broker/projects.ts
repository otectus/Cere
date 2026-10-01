import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { Core } from './core.ts';
import type { Project, ProjectDefaults, Session } from './types.ts';
import { providerIds, isApiProvider } from './provider-catalog.ts';

/** Project identity is the canonical working directory, independent of session folders. */
export class Projects {
  private core: Core;
  constructor(core: Core) { this.core=core; }
  private saved(cwd: string): Project | undefined {
    const row=this.core.store.db.prepare('SELECT data FROM projects WHERE cwd=?').get(cwd);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private expected(cwd: string, revision: unknown) {
    const project=this.saved(cwd);
    if((project?.revision||'0')!==revision)throw new Error('Project settings changed. Reopen settings or the new-session dialog and try again.');
    return project;
  }
  list() {
    // Query durable rows, including archived sessions beyond the bounded UI snapshot.
    // Temporary conversations never introduce persistent project entries.
    const saved=new Map<string,Project>(this.core.store.db.prepare('SELECT data FROM projects').all().map(row=>{
      const project=JSON.parse(String(row.data)) as Project;return [project.cwd,project];
    }));
    const countsSql=`SELECT json_extract(data,'$.cwd') AS cwd,
      count(*) AS total,
      sum(CASE WHEN COALESCE(json_extract(data,'$.archived'),0)=0 THEN 1 ELSE 0 END) AS sessions,
      sum(CASE WHEN COALESCE(json_extract(data,'$.archived'),0)=0 AND json_extract(data,'$.unread')=1 THEN 1 ELSE 0 END) AS unread,
      sum(CASE WHEN json_extract(data,'$.status') IN ('starting','working','waiting','stopping') THEN 1 ELSE 0 END) AS active,
      max(json_extract(data,'$.updated')) AS recent FROM sessions GROUP BY cwd`;
    const rows=this.core.store.db.prepare(countsSql).all();
    const counts=new Map(rows.filter(row=>typeof row.cwd==='string'&&isAbsolute(row.cwd)).map(row=>[String(row.cwd),row]));
    for(const row of this.core.store.volatile.prepare(countsSql).all()){
      const cwd=String(row.cwd);if(!saved.has(cwd)&&!counts.has(cwd))continue;
      const previous=counts.get(cwd);
      counts.set(cwd,{cwd,...Object.fromEntries(['total','sessions','unread','active'].map(key=>[key,Number(previous?.[key]||0)+Number(row[key]||0)])),recent:Math.max(Number(previous?.recent||0),Number(row.recent||0))});
    }
    return [...new Set([...saved.keys(),...counts.keys()])].map(cwd=>{
      const row=counts.get(cwd),project=saved.get(cwd);
      const latest=project?undefined:this.core.store.db.prepare("SELECT data FROM sessions WHERE json_extract(data,'$.cwd')=? ORDER BY json_extract(data,'$.updated') DESC,id DESC LIMIT 1").get(cwd);
      const session:Session|undefined=latest?JSON.parse(String(latest.data)):undefined;
      const defaults:ProjectDefaults=project?.defaults||{provider:session?.provider||'codex',model:session?.model||'',effort:session?.effort||'',tools:!!(session?.ollama?.tools||session?.api?.tools),trusted:false,temporary:false};
      return {...project,cwd,name:project?.name||basename(cwd)||cwd,revision:project?.revision||'0',favorite:project?.favorite||false,defaults,
        configured:!!project,updated:Math.max(project?.updated||0,Number(row?.recent||0)),sessions:Number(row?.sessions||0),total:Number(row?.total||0),
        unread:Number(row?.unread||0),active:Number(row?.active||0)};
    }).sort((a,b)=>Number(b.favorite)-Number(a.favorite)||b.updated-a.updated||a.name.localeCompare(b.name)||a.cwd.localeCompare(b.cwd));
  }
  async dispatch(method:string,p:any) {
    if(method==='projects.list')return {projects:this.list()};
    if(method==='projects.save') {
      if(typeof p.cwd!=='string'||p.cwd.length>4096||!isAbsolute(p.cwd))throw new Error('Choose an absolute project folder');
      const cwd=await realpath(p.cwd);if(!(await stat(cwd)).isDirectory())throw new Error('Project must be a folder');
      this.expected(cwd,p.expectedRevision);
      if(typeof p.name!=='string'||!p.name.trim()||p.name.trim().length>100||/[\x00-\x1f\x7f]/.test(p.name))throw new Error('Project names need 1–100 printable characters');
      if(typeof p.favorite!=='boolean')throw new Error('Invalid project favorite');
      const d=p.defaults;
      if(!d||!(providerIds as readonly string[]).includes(d.provider))throw new Error('Choose a supported provider');
      for(const key of ['tools','trusted','temporary'])if(typeof d[key]!=='boolean')throw new Error('Invalid project '+key+' setting');
      for(const [key,max] of [['model',512],['effort',32]] as const)if(typeof d[key]!=='string'||d[key].length>max||/[\x00-\x1f\x7f]/.test(d[key]))throw new Error('Invalid project '+key);
      const conversation=d.provider==='ollama'||isApiProvider(d.provider);
      if(!conversation&&d.tools)throw new Error('Desktop tools apply to API and Ollama conversations');
      if(conversation&&d.effort)throw new Error('This provider uses the model’s default reasoning settings');
      if(isApiProvider(d.provider)&&!d.model.trim())throw new Error('Choose an API model or enter its model ID');
      if(d.temporary&&d.tools)throw new Error('Temporary conversations cannot use desktop tools');
      const defaults:ProjectDefaults={provider:d.provider,model:d.model.trim(),effort:d.effort.trim(),tools:d.tools,trusted:d.trusted,temporary:d.temporary};
      const project:Project={cwd,name:p.name.trim(),revision:String(BigInt(p.expectedRevision)+1n),updated:Date.now(),favorite:p.favorite,defaults};
      this.core.store.db.prepare('INSERT INTO projects VALUES (?,?) ON CONFLICT(cwd) DO UPDATE SET data=excluded.data').run(cwd,JSON.stringify(project));
      this.core.store.catalogRevision++;this.core.changed();return project;
    }
    if(method==='projects.createSession') {
      if(typeof p.cwd!=='string')throw new Error('Choose a project');
      const project=this.expected(p.cwd,p.expectedRevision);
      if(!project)throw new Error('Save the project settings before starting a session');
      if(typeof p.title!=='string'||!p.title.trim()||p.title.trim().length>100||/[\x00-\x1f\x7f]/.test(p.title))throw new Error('Enter a session name of 1–100 printable characters');
      // Only stored defaults are authority here. The creation path revalidates
      // folder, model availability, tools and current permissions before saving.
      return this.core.create({...project.defaults,cwd:project.cwd,title:p.title.trim()},()=>{
        this.expected(project.cwd,p.expectedRevision);
        const d=project.defaults;
        if(!d.trusted&&!this.core.settings.bypassCliPermissions&&((d.provider!=='ollama'&&!isApiProvider(d.provider))||d.tools))throw new Error('Confirm project trust in its settings before starting a session');
      });
    }
    throw new Error('Unknown project operation');
  }
}
