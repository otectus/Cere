import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Store } from './store.ts';
import type { Message, Session, SessionFolder } from './types.ts';

type NavigationSearchEntry = {
  id:string;navigationId?:string;kind:'session'|'transcript'|'bookmark'|'capsule'|'project';
  title:string;detail:string;search:string;value?:string;sessionId?:string;cwd?:string;time?:number;
};

export class Organization {
  store: Store; changed:()=>void;
  constructor(store:Store,changed:()=>void){this.store=store;this.changed=changed;}
  private navigationSearch(p:any) {
    if(typeof p.query!=='string'||p.query.length>500)throw new Error('Navigation search needs a query of at most 500 characters');
    if(p.tag!==undefined&&(typeof p.tag!=='string'||p.tag.length>500))throw new Error('Invalid navigation search tag');
    const limit=p.limit??60;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Navigation search limit must be 1–100');
    const query=p.query.trim().toLocaleLowerCase(),entries:NavigationSearchEntry[]=[];
    const seen=new Set<string>(),add=(entry:NavigationSearchEntry)=>{if(entries.length<limit&&!seen.has(entry.id)){seen.add(entry.id);entries.push(entry)}};
    const byId=new Map<string,Session>(),getSession=(id:string)=>{if(byId.has(id))return byId.get(id);try{const session=this.store.session(id);byId.set(id,session);return session}catch{return undefined}};
    const navigation=this.store.get<{favorites:string[];recents:string[]}>('navigation',{favorites:[],recents:[]});
    const destinationIds=[...navigation.favorites,...navigation.recents];
    const sessionEntry=(session:Session):NavigationSearchEntry=>({
      id:'session:'+session.id,navigationId:'session:'+session.id,kind:'session',title:session.title||'Untitled session',value:session.id,time:session.updated,
      detail:[session.provider,session.archived?'Archived':'',session.cwd].filter(Boolean).join(' · '),
      search:[session.title,session.cwd,session.provider,session.archived?'archived':''].filter(Boolean).join(' '),
    });
    const rankedSessions=query?[...this.store.sessionPage({filter:p.query,archived:false,limit:20}).sessions,...this.store.sessionPage({filter:p.query,archived:true,limit:20}).sessions]:
      destinationIds.filter(id=>id.startsWith('session:')).map(id=>getSession(id.slice(8))).filter((session):session is Session=>!!session);
    for(const session of rankedSessions)byId.set(session.id,session);
    rankedSessions.sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||b.updated-a.updated||a.id.localeCompare(b.id));
    const sessionBudget=Math.max(1,Math.min(20,Math.floor(limit/4)));
    for(const session of rankedSessions.slice(0,sessionBudget))add(sessionEntry(session));

    const bookmarks=new Set(this.store.bookmarks().map(bookmark=>bookmark.messageId));
    const messageSnippet=(message:Message)=>{
      const source=message.text.replace(/\s+/g,' ').trim(),index=query?source.toLocaleLowerCase().indexOf(query):-1,start=index<0?0:Math.max(0,index-90);
      return source.slice(start,start+280)+(source.length>start+280?'…':'');
    };
    let messages:Message[]=[];
    if(query){
      const messageBudget=Math.max(1,Math.min(25,Math.floor(limit/3)));
      messages=this.store.searchMessages(p.query,undefined,messageBudget).map(row=>this.store.messageById(row.id)).filter((message):message is Message=>!!message);
      messages.push(...this.store.volatile.prepare("SELECT data FROM messages WHERE instr(lower(json_extract(data,'$.text')),lower(?))>0 ORDER BY rowid DESC LIMIT ?").all(p.query,messageBudget).map(row=>JSON.parse(String(row.data)) as Message));
      messages.sort((a,b)=>b.time-a.time);
    } else {
      messages=this.store.bookmarks().slice(0,Math.max(1,Math.min(25,Math.floor(limit/3)))).map(bookmark=>this.store.messageById(bookmark.messageId)).filter((message):message is Message=>!!message);
    }
    for(const message of messages.slice(0,Math.max(1,Math.min(25,Math.floor(limit/3))))){
      const session=getSession(message.sessionId);if(!session)continue;
      const bookmarked=bookmarks.has(message.id),snippet=messageSnippet(message),role=message.role||'message';
      add({id:(bookmarked?'bookmark:':'message:')+message.id,navigationId:'session:'+session.id,kind:bookmarked?'bookmark':'transcript',sessionId:session.id,value:session.id,time:message.time,
        title:(bookmarked?'Bookmark':'Transcript')+' · '+(session.title||'Untitled session'),detail:`${role} · ${snippet||'Empty message'} · opens conversation`,
        search:[session.title,session.cwd,role,snippet].join(' ')});
    }

    const projects=new Map<string,number>();
    if(query){for(const row of this.store.db.prepare("SELECT json_extract(data,'$.cwd') AS cwd,count(*) AS n FROM sessions WHERE instr(lower(json_extract(data,'$.cwd')),lower(?))>0 GROUP BY cwd ORDER BY max(json_extract(data,'$.updated')) DESC LIMIT 10").all(p.query)){const cwd=String(row.cwd);projects.set(cwd,Number(row.n))}}
    else for(const id of destinationIds.filter(id=>id.startsWith('project:')).slice(0,10)){const cwd=id.slice(8),count=Number(this.store.db.prepare("SELECT count(*) AS n FROM sessions WHERE json_extract(data,'$.cwd')=?").get(cwd)!.n);if(count)projects.set(cwd,count)}
    for(const [cwd,count] of projects){
      const id='project:'+cwd,name=basename(cwd)||cwd;
      add({id,navigationId:id,kind:'project',title:'Open project · '+name,detail:`${cwd} · ${count} conversation${count===1?'':'s'}`,search:name+' '+cwd,cwd});
    }
    if(query){
      for(const row of this.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'capsule:%' AND instr(lower(value),lower(?))>0 LIMIT 30").all(p.query)){
        let capsule:any;try{capsule=JSON.parse(String(row.value))}catch{continue}
        const cwd=typeof capsule.cwd==='string'?capsule.cwd:String(row.key).slice(8),project=basename(cwd)||cwd;
        for(const field of ['decisions','constraints'] as const){if(!Array.isArray(capsule[field]))continue;for(let index=0;index<capsule[field].length;index++){
          const value=capsule[field][index];if(typeof value!=='string'||!(`${project} ${cwd} ${value}`).toLocaleLowerCase().includes(query))continue;
          add({id:`capsule:${cwd}:${field}:${index}`,navigationId:'project:'+cwd,kind:'capsule',title:`${field==='decisions'?'Decision':'Constraint'} · ${project}`,detail:value.replace(/\s+/g,' ').trim()+' · opens project folder',search:project+' '+cwd+' '+value,cwd});
        }}
      }
    }
    return {query,tag:p.tag??query,entries,total:entries.length};
  }
  dispatch(method:string,p:any) {
    let result:any=true;
    if(method==='navigation.search')return this.navigationSearch(p);
    if(method==='sessions.list')return this.store.sessionPage(p);
    if(method==='session.search')return this.store.searchMessages(p.query,p.cwd,p.limit);
    if(method==='bookmarks.list')return this.store.searchMessages(p.query||'',p.cwd,p.limit,true);
    if(method==='folders.save') {
      if(typeof p.name!=='string'||!p.name.trim()||p.name.trim().length>80||/[\x00-\x1f]/.test(p.name))throw new Error('Folder names need 1–80 printable characters');
      const name=p.name.trim(),folders=this.store.folders(),previous=p.id?folders.find(f=>f.id===p.id):undefined;
      if(p.id&&!previous)throw new Error('Folder no longer exists');
      if(previous&&p.expectedRevision!==previous.revision)throw new Error('Folder changed. Reload before editing it.');
      if(folders.some(f=>f.id!==p.id&&f.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw new Error('A folder with this name already exists');
      if(!previous&&folders.length>=200)throw new Error('The folder limit is 200');
      const folder:SessionFolder={id:previous?.id||randomUUID(),name,revision:String(BigInt(previous?.revision||'0')+1n),created:previous?.created||Date.now(),updated:Date.now()};
      this.store.saveFolder(folder);result=folder;
    } else if(method==='folders.delete') {
      const folder=this.store.folders().find(f=>f.id===p.id);if(!folder)throw new Error('Folder no longer exists');
      if(p.expectedRevision!==folder.revision)throw new Error('Folder changed. Reload before deleting it.');
      this.store.transaction(()=>{
        const rows=[...this.store.db.prepare("SELECT data FROM sessions WHERE json_extract(data,'$.folderId')=?").all(folder.id),...this.store.volatile.prepare("SELECT data FROM sessions WHERE json_extract(data,'$.folderId')=?").all(folder.id)];
        for(const row of rows){const s=JSON.parse(String(row.data));delete s.folderId;this.store.saveSession(s);}
        this.store.db.prepare('DELETE FROM session_folders WHERE id=?').run(folder.id);
      });
    } else if(method==='session.organize'||method==='session.read') {
      const s=this.store.session(p.id);
      if(p.expectedRevision!==undefined&&p.expectedRevision!==s.revision)throw new Error('Session changed. Reload before editing it.');
      if(method==='session.read'){s.readAt=Date.now();s.unread=false;}
      else {
        for(const key of ['pinned','archived'] as const)if(key in p){if(typeof p[key]!=='boolean')throw new Error('Invalid '+key);s[key]=p[key];}
        if('folderId' in p){if(p.folderId!==null&&typeof p.folderId!=='string')throw new Error('Invalid folder');if(p.folderId&&!this.store.folders().some(f=>f.id===p.folderId))throw new Error('Folder no longer exists');s.folderId=p.folderId||undefined;}
      }
      this.store.saveSession(s);result=s;
    } else if(method==='message.bookmark') {
      if(this.store.temporary(p.sessionId))throw new Error('Bookmarks are unavailable in temporary conversations');
      const m=this.store.messageById(p.messageId);if(!m||m.sessionId!==p.sessionId)throw new Error('Message no longer exists in this conversation');
      if(typeof p.bookmarked!=='boolean')throw new Error('Invalid bookmark state');
      if(p.bookmarked)this.store.db.prepare('INSERT OR IGNORE INTO message_bookmarks VALUES (?,?,?)').run(m.id,m.sessionId,Date.now());
      else this.store.db.prepare('DELETE FROM message_bookmarks WHERE message_id=?').run(m.id);
    } else if(method==='navigation.record'||method==='navigation.favorite') {
      if(typeof p.id!=='string'||p.id.length>1024||!/^(session|folder|settings|page|action|app|window|script|project):/.test(p.id))throw new Error('Invalid command');
      if(p.id.startsWith('session:')&&this.store.temporary(p.id.slice(8)))return true;
      const navigation=this.store.get<{favorites:string[];recents:string[]}>('navigation',{favorites:[],recents:[]});
      if(method==='navigation.record')navigation.recents=[p.id,...navigation.recents.filter(id=>id!==p.id)].slice(0,30);
      else {if(typeof p.favorite!=='boolean')throw new Error('Invalid favorite state');navigation.favorites=navigation.favorites.filter(id=>id!==p.id);if(p.favorite)navigation.favorites.push(p.id);if(navigation.favorites.length>100)throw new Error('The favorite limit is 100');}
      this.store.set('navigation',navigation);result=navigation;
    } else throw new Error('Unknown organization operation');
    this.changed();return result;
  }
}
