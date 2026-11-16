import {randomUUID} from 'node:crypto';
import {lstat,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {loadMapping,loadObservationMapping} from '../config/runtime.js';
import {requireSafe} from '../core/contracts.js';
import type {BrowserProfileOwner} from '../browser/profile-owner.js';
import type {EventStore} from '../storage/store.js';

const savedSchema=z.object({version:z.literal(1),ownId:z.string().min(1).max(128),
  notification:z.string().min(1).max(2000),dm:z.string().min(1).max(2000)}).strict();
type Locations=z.infer<typeof savedSchema>;
interface Scope {ownId:string;origin:string;entry:string;notification:Set<string>;dm:Set<string>}

/** Serialized read-only guard: changing a recovery location must not discard a web draft. */
export function inspectRecoveryNavigation(origin:string):{originMatches:boolean;empty:boolean}{
  if(location.origin!==origin)return {originMatches:false,empty:false};
  for(const editor of document.querySelectorAll('[contenteditable="true"],textarea,input')){
    const style=getComputedStyle(editor),rect=editor.getBoundingClientRect();
    if(style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0)continue;
    if(editor instanceof HTMLInputElement&&!['text','search','email','url','tel','password'].includes(editor.type))continue;
    const text=editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement?editor.value:editor.textContent??'';
    if(editor.querySelector('img,video,audio,iframe,object,input,[data-slate-void="true"],[data-attachment]'))
      return {originMatches:true,empty:false};
    const marker=editor.matches('[data-slate-editor="true"][data-zone-container="*"]')&&editor.children.length===1&&
      editor.firstElementChild?.matches('div.ace-line[data-node="true"]')&&editor.firstElementChild.children.length===1&&
      editor.firstElementChild.firstElementChild?.matches('span[data-enter="true"][data-string="true"][data-leaf="true"]')&&text==='\u200B';
    if(text.length&&!marker)return {originMatches:true,empty:false};
    for(const node of editor.querySelectorAll('*'))if(!['DIV','P','SPAN','BR','B','I','EM','STRONG','U','S'].includes(node.tagName))
      return {originMatches:true,empty:false};
  }
  return {originMatches:true,empty:true};
}

/** Private recovery positions, restricted again against the current account and authorized works. */
export class BrowserRecoveryLocations {
  private store:EventStore|undefined;
  private memory:Locations|undefined;
  private ownedFile=false;
  private pending:Promise<unknown>=Promise.resolve();
  private readonly file:string;
  constructor(readonly root:string){this.file=join(root,'browser-recovery-locations.json');}
  bindStore(store:EventStore):void {this.store=store;}
  private exclusive<T>(run:()=>Promise<T>):Promise<T>{
    const task=this.pending.then(run,run);this.pending=task.then(()=>undefined,()=>undefined);return task;
  }
  private normalize(value:string,origin:string):string|null {
    try{
      const url=new URL(value);
      if(url.origin!==origin||url.username||url.password)return null;
      url.search='';url.hash='';return url.href;
    }catch{return null;}
  }
  private async scope():Promise<Scope|null>{
    const observed=await loadObservationMapping(this.root);
    let legacy=null;
    if(!observed)try{legacy=await loadMapping(this.root);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    const origin=observed?.origin??legacy!.origin,ownId=observed?.self.uid??legacy!.ownId;
    const entry=this.normalize(observed?.entryUrl??origin,origin);
    const home=this.normalize(origin,origin);requireSafe(entry&&home,'BROWSER_RECOVERY_SCOPE_UNAVAILABLE');
    const notification=new Set([home,entry]),dm=new Set([home,entry]);
    const account=this.store?.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
    if(this.store&&!account)return null;
    requireSafe(!account||account.own_id===ownId,'ACCOUNT_CHANGED');
    if(observed){
      for(const work of observed.works){const url=this.normalize(work.url,origin);if(url)notification.add(url);}
      if(account&&this.store?.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_works'").get()){
        const works=this.store.db.prepare("SELECT id,url FROM discovered_works WHERE own_id=? AND state='INCLUDED'")
          .all(ownId) as {id:string;url:string}[];
        for(const work of works){
          const url=this.normalize(work.url,origin);if(!url)continue;
          const path=new URL(url).pathname;
          if(path===`/video/${work.id}`||path===`/note/${work.id}`)notification.add(url);
        }
      }
    }
    return {ownId,origin,entry,notification,dm};
  }
  private validate(value:unknown,scope:Scope):Locations|null {
    const parsed=savedSchema.safeParse(value);if(!parsed.success||parsed.data.ownId!==scope.ownId)return null;
    const notification=this.normalize(parsed.data.notification,scope.origin),dm=this.normalize(parsed.data.dm,scope.origin);
    if(!notification||!dm||!scope.notification.has(notification)||!scope.dm.has(dm))return null;
    return {...parsed.data,notification,dm};
  }
  private async readSaved(scope:Scope):Promise<Locations|null>{
    try{
      const file=await lstat(this.file);
      if(!file.isFile()||file.isSymbolicLink()||file.size>16_000)return null;
      const saved=this.validate(JSON.parse(await readFile(this.file,'utf8')),scope);
      if(saved)this.ownedFile=true;return saved;
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return null;
      throw error;
    }
  }
  /** The caller already owns the account actor; never reacquire it while capturing. */
  capture(owner:BrowserProfileOwner,persist=false):Promise<void>{
    return this.captureLocations(owner,persist,false);
  }
  /** A newly observed platform fault supersedes an older recovery position. */
  captureFault(owner:BrowserProfileOwner):Promise<void>{
    return this.captureLocations(owner,true,true);
  }
  private captureLocations(owner:BrowserProfileOwner,persist:boolean,replaceSaved:boolean):Promise<void>{
    return this.exclusive(async()=>{
      const scope=await this.scope();if(!scope)return;
      const saved=await this.readSaved(scope);
      if(saved&&!replaceSaved){this.memory=saved;return;}
      const notification=this.normalize(owner.notification.url(),scope.origin),dm=this.normalize(owner.dm.url(),scope.origin);
      const locations:Locations={version:1,ownId:scope.ownId,
        notification:notification&&scope.notification.has(notification)?notification:scope.entry,
        dm:dm&&scope.dm.has(dm)?dm:scope.entry};
      this.memory=locations;if(!persist)return;
      const directory=await lstat(this.root);requireSafe(directory.isDirectory()&&!directory.isSymbolicLink(),'BROWSER_RECOVERY_PATH_UNAVAILABLE');
      try{const file=await lstat(this.file);requireSafe(file.isFile()&&!file.isSymbolicLink(),'BROWSER_RECOVERY_PATH_UNAVAILABLE');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const temporary=join(this.root,`.browser-recovery-locations-${randomUUID()}.tmp`);
      try{
        await writeFile(temporary,JSON.stringify(locations)+'\n',{flag:'wx',mode:0o600});
        await rename(temporary,this.file);this.ownedFile=true;
      }finally{await unlink(temporary).catch(()=>{});}
    });
  }
  /** Called outside the actor; only normal navigation to current allowlisted positions is permitted. */
  async restore(owner:BrowserProfileOwner,signal?:AbortSignal):Promise<void>{
    const locations=await this.exclusive(async()=>{
      if(!this.memory)try{await lstat(this.file);}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
      const scope=await this.scope();if(!scope)return null;
      const saved=await this.readSaved(scope);
      return saved??this.validate(this.memory,scope)??{version:1 as const,ownId:scope.ownId,notification:scope.entry,dm:scope.entry};
    });
    if(!locations)return;
    await owner.actor.run(async()=>{
      const scope=await this.scope();if(!scope)return;
      const valid=this.validate(locations,scope);
      const current=valid??{notification:scope.entry,dm:scope.entry};
      for(const [page,url] of [[owner.notification,current.notification],[owner.dm,current.dm]] as const){
        requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
        if(page.url()===url)continue;
        const navigation=await page.evaluate(inspectRecoveryNavigation,scope.origin);
        requireSafe(navigation.originMatches,'UNEXPECTED_ORIGIN');
        requireSafe(navigation.empty,'BROWSER_HAS_HUMAN_INPUT');
        requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
        await page.goto(url,{waitUntil:'domcontentloaded'});
      }
      requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
    });
  }
  clear():Promise<void>{
    return this.exclusive(async()=>{
      this.memory=undefined;if(!this.ownedFile)return;
      try{const file=await lstat(this.file);requireSafe(file.isFile()&&!file.isSymbolicLink(),'BROWSER_RECOVERY_PATH_UNAVAILABLE');await unlink(this.file);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      this.ownedFile=false;
    });
  }
}
