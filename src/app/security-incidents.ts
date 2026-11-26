import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readdir,readFile,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {z} from 'zod';
import {digest,requireSafe,type Channel} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import {holdSecurityChannel,readSecurityHold} from '../storage/security-holds.js';
import {inspectSecuritySignal} from '../adapters/security-inspection.js';
import {securitySignalSchema,type SecuritySignal} from '../adapters/security-signal.js';
import {securityRuntime} from './security-runtime.js';

const uuid=/^[a-f0-9-]{36}$/u;
const hash64=/^[a-f0-9]{64}$/u;
const recoveryMetaEvent='SECURITY_INCIDENT_RECOVERY_META';
const maximumFiles=20,maximumBytes=50*1024*1024;
const recoveryMetaSchema=z.object({
  version:z.literal(1),
  channel:z.enum(['COMMENT_NOTIFICATION','DIRECT_MESSAGE']),
  createdAt:z.number().int().positive(),
  mode:z.enum(['headed','headless']),
  epoch:z.number().int().nonnegative(),
  instanceId:z.string().max(128).nullable(),
  mappingDigest:z.string().regex(hash64).nullable(),
  documentDigest:z.string().regex(hash64).optional(),
  href:z.string().max(2048).optional(),
  origin:z.string().max(256).optional(),
  documentStartedAt:z.number().finite().nonnegative().optional(),
  scope:z.enum(['TARGET','ACCOUNT_PAGE']).optional(),
  workId:z.string().max(64).optional(),
  conversationDigest:z.string().regex(hash64).optional(),
}).strict();
type RecoveryMeta=z.infer<typeof recoveryMetaSchema>;
function sanitizeLocation(raw:string):{href:string;origin:string}|null {
  try{
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol))return null;
    url.username='';url.password='';url.search='';url.hash='';
    return {href:url.href.slice(0,2048),origin:url.origin.slice(0,256)};
  }catch{return null;}
}
function signalDigest(signal:SecuritySignal):string {
  // Parsed envelopes and browser snapshots can insert the same fields in different orders.
  return digest([signal.state,
    signal.matches.map(({selector,tag,id,visible,left,top,right,bottom})=>[selector,tag,id,visible,left,top,right,bottom]),
    signal.frames.map(({src,title,left,top,right,bottom})=>[src,title,left,top,right,bottom])]);
}
export interface IncidentContext {mode:'headed'|'headless';epoch:number;instanceId:string|null;selectors:string[];mappingDigest:string|null}
export interface SecurityIncident {
  version:1;id:string;channel:Channel;createdAt:number;context:IncidentContext;
  initial:SecuritySignal|null;afterFailure:SecuritySignal|null;afterScreenshot:SecuritySignal|null;
  frames:{url:string;parent:number|null}[];sameDocument:boolean;
  screenshot:{file:string;digest:string}|null;incomplete:string[];
}
export interface SecurityRecoveryIncident extends SecurityIncident {
  fromFallback:boolean;
  documentDigest?:string;
  conversationDigest?:string;
}

/** Only called inside the original account task, before another task can navigate the page. */
export class SecurityIncidents {
  constructor(readonly root:string,readonly store:EventStore){}
  private async directory():Promise<string>{
    const base=await lstat(this.root);requireSafe(base.isDirectory()&&!base.isSymbolicLink(),'SECURITY_EVIDENCE_PATH_UNSAFE');
    const evidence=join(this.root,'evidence');await mkdir(evidence,{recursive:true});
    const parent=await lstat(evidence);requireSafe(parent.isDirectory()&&!parent.isSymbolicLink(),'SECURITY_EVIDENCE_PATH_UNSAFE');
    const directory=join(evidence,'security-incidents');await mkdir(directory,{recursive:true});
    const stat=await lstat(directory);requireSafe(stat.isDirectory()&&!stat.isSymbolicLink(),'SECURITY_EVIDENCE_PATH_UNSAFE');return directory;
  }
  private persistRecoveryMeta(id:string,channel:Channel,createdAt:number,context:IncidentContext,signal:SecuritySignal|null,fallbackUrl?:string):void {
    const clean=signal?sanitizeLocation(signal.href):fallbackUrl?sanitizeLocation(fallbackUrl):null;
    const meta:RecoveryMeta={
      version:1,channel,createdAt,mode:context.mode,epoch:context.epoch,
      instanceId:context.instanceId,mappingDigest:context.mappingDigest,
      ...(signal?{documentDigest:digest([signal.href,signal.documentStartedAt])}:{}),
      ...(clean?{href:clean.href,origin:clean.origin,documentStartedAt:signal?.documentStartedAt??0}:{}),
      ...(signal?.scope?{scope:signal.scope}:clean?{scope:'ACCOUNT_PAGE'}:{}),
      ...(signal?.target?.workId?{workId:signal.target.workId}:{}),
      ...(signal?.target?.conversationId?{conversationDigest:digest(signal.target.conversationId)}:{}),
    };
    const parsed=recoveryMetaSchema.safeParse(meta);
    if(!parsed.success)return;
    this.store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)')
      .run(randomUUID(),new Date(createdAt).toISOString(),recoveryMetaEvent,id,JSON.stringify(parsed.data));
  }
  private readInlineFallback(id:string):SecurityRecoveryIncident|null {
    const row=this.store.db.prepare('SELECT detail_redacted FROM audit_events WHERE event_type=? AND entity_id=? ORDER BY rowid DESC LIMIT 1')
      .get(recoveryMetaEvent,id) as {detail_redacted:string}|undefined;
    if(!row)return null;
    try{
      const parsed=recoveryMetaSchema.safeParse(JSON.parse(row.detail_redacted));
      if(!parsed.success)return null;
      const meta=parsed.data;
      const initial:SecuritySignal|null=meta.href&&meta.origin?{
        version:1,state:'SUSPECT',href:meta.href,origin:meta.origin,title:'',
        documentStartedAt:meta.documentStartedAt??0,observedAt:meta.createdAt,kind:'COMPONENT',
        ...(meta.scope?{scope:meta.scope}:{}),
        ...(meta.workId?{target:{workId:meta.workId}}:{}),
        matches:[],frames:[],
      }:null;
      return {
        version:1,id,channel:meta.channel,createdAt:meta.createdAt,
        context:{mode:meta.mode,epoch:meta.epoch,instanceId:meta.instanceId,selectors:[],mappingDigest:meta.mappingDigest},
        initial,afterFailure:null,afterScreenshot:null,frames:[],sameDocument:false,screenshot:null,
        incomplete:['DISK_EVIDENCE_UNAVAILABLE'],fromFallback:true,
        ...(meta.documentDigest?{documentDigest:meta.documentDigest}:{}),
        ...(meta.conversationDigest?{conversationDigest:meta.conversationDigest}:{}),
      };
    }catch{return null;}
  }
  private async inspectDirectoryReadOnly():Promise<{status:'OK';directory:string}|{status:'MISSING'}|{status:'UNSAFE'}>{
    const evidence=join(this.root,'evidence'),directory=join(evidence,'security-incidents');
    for(const dir of [this.root,evidence,directory]){
      try{
        const stat=await lstat(dir);
        if(!stat.isDirectory()||stat.isSymbolicLink())return {status:'UNSAFE'};
      }catch(error){
        return (error as NodeJS.ErrnoException).code==='ENOENT'?{status:'MISSING'}:{status:'UNSAFE'};
      }
    }
    return {status:'OK',directory};
  }
  private async readFileRecord(file:string,id:string):Promise<SecurityIncident|null>{
    try{
      const stat=await lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>100_000)return null;
      const value=JSON.parse(await readFile(file,'utf8')) as SecurityIncident;
      if(value.version!==1||value.id!==id||!['COMMENT_NOTIFICATION','DIRECT_MESSAGE'].includes(value.channel))return null;
      if(value.initial&&!securitySignalSchema.safeParse(value.initial).success)return null;
      return value;
    }catch{return null;}
  }
  private wasRecordedOnDisk(id:string):boolean{
    return !!this.store.db.prepare("SELECT 1 FROM audit_events WHERE event_type='SECURITY_INCIDENT_RECORDED' AND entity_id=? LIMIT 1").get(id);
  }
  async read(id:string):Promise<SecurityIncident|null>{
    if(!uuid.test(id))return null;
    const dir=await this.inspectDirectoryReadOnly();
    if(dir.status!=='OK')return null;
    return this.readFileRecord(join(dir.directory,id+'.json'),id);
  }
  /** Reads disk evidence when present (preserving tamper checks); falls back to inline SQLite recovery meta only on pure ENOENT when never recorded on disk. */
  async readRecovery(id:string):Promise<SecurityRecoveryIncident|null>{
    if(!uuid.test(id))return null;
    const dir=await this.inspectDirectoryReadOnly();
    if(dir.status==='UNSAFE')return null;
    if(dir.status==='OK'){
      const file=join(dir.directory,id+'.json');
      let missing=false;
      try{
        await lstat(file);
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')return null;
        missing=true;
      }
      if(!missing){
        const saved=await this.readFileRecord(file,id);
        return saved?{...saved,fromFallback:false}:null;
      }
    }
    if(this.wasRecordedOnDisk(id))return null;
    return this.readInlineFallback(id);
  }
  private async capacity(directory:string):Promise<boolean>{
    const protectedIds=new Set(['COMMENT_NOTIFICATION','DIRECT_MESSAGE'].flatMap(channel=>{
      const hold=readSecurityHold(this.store,channel as Channel);return hold?[hold.incidentId]:[];
    }));
    const rows:{id:string;bytes:number;at:number}[]=[];let total=0;
    for(const name of await readdir(directory)){
      const stat=await lstat(join(directory,name));total+=stat.size;
      if(!name.endsWith('.json')||!uuid.test(name.slice(0,-5))||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)continue;
      const saved=await this.read(name.slice(0,-5));if(!saved)continue;
      let bytes=stat.size;
      try{const image=await lstat(join(directory,saved.id+'.jpg'));if(image.isFile()&&!image.isSymbolicLink()&&image.nlink===1)bytes+=image.size;}catch{}
      rows.push({id:saved.id,bytes,at:saved.createdAt});
    }
    rows.sort((a,b)=>a.at-b.at);let count=rows.length;
    for(const row of rows){
      if(count<maximumFiles&&total<maximumBytes-4*1024*1024)break;
      if(protectedIds.has(row.id))continue;
      // Only this recorder's recognized, resolved incident pair may be removed at capacity.
      for(const extension of ['json','jpg']){
        const file=join(directory,row.id+'.'+extension);
        try{const stat=await lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1){await unlink(file);total-=stat.size;}}catch{}
      }
      count--;
    }
    return count<maximumFiles&&total<maximumBytes-4*1024*1024;
  }
  async record(channel:Channel,page:Page,initial:SecuritySignal|null,context:IncidentContext,replaceRevision?:string):Promise<void>{
    const previous=readSecurityHold(this.store,channel);
    if(previous&&previous.revision!==replaceRevision||replaceRevision&&!previous)return;
    const id=randomUUID(),createdAt=Date.now();
    const fallbackUrl=!initial&&typeof (page as Partial<Page>).url==='function'?page.url():undefined;
    this.store.db.transaction(()=>{
      const held=holdSecurityChannel(this.store,channel,{incidentId:id,reason:'OBSERVATION_SECURITY_SUSPECT',mode:context.mode,
        source:'UNKNOWN',
        ...(initial?{documentDigest:digest([initial.href,initial.documentStartedAt])}:{})},createdAt);
      if(held.incidentId===id)this.persistRecoveryMeta(id,channel,createdAt,context,initial,fallbackUrl);
    }).immediate();
    const record:SecurityIncident={version:1,id,channel,createdAt,context,initial,afterFailure:null,afterScreenshot:null,frames:[],sameDocument:false,screenshot:null,
      incomplete:initial?[]:['INITIAL_SIGNAL_UNAVAILABLE']};
    try{
      const directory=await this.directory();if(!await this.capacity(directory)){
        this.store.audit('SECURITY_EVIDENCE_CAPACITY_REACHED',id);return;
      }
      try{
        record.afterFailure=await page.evaluate(inspectSecuritySignal,{selectors:context.selectors});
        if(!initial&&record.afterFailure)this.persistRecoveryMeta(id,channel,createdAt,context,record.afterFailure);
        const frames=page.frames();record.frames=frames.slice(0,16).map(frame=>({url:frame.url().slice(0,2048),parent:frame.parentFrame()?frames.indexOf(frame.parentFrame()!):null}));
        record.sameDocument=!!initial&&initial.href===record.afterFailure.href&&initial.documentStartedAt===record.afterFailure.documentStartedAt;
        if(!record.sameDocument)record.incomplete.push('DOCUMENT_CHANGED_OR_INITIAL_MISSING');
        if(initial&&signalDigest(initial)!==signalDigest(record.afterFailure))
          record.incomplete.push('SIGNAL_CHANGED_BEFORE_SCREENSHOT');
        if(record.sameDocument){
          try{
            const screenshot=await page.screenshot({type:'jpeg',quality:60,timeout:2000,fullPage:false});
            try{
              const candidate=await page.evaluate(inspectSecuritySignal,{selectors:context.selectors});
              if(securitySignalSchema.safeParse(candidate).success){
                record.afterScreenshot=candidate;
                if(candidate.href!==initial!.href||candidate.documentStartedAt!==initial!.documentStartedAt){
                  record.sameDocument=false;record.incomplete.push('DOCUMENT_CHANGED_DURING_SCREENSHOT');
                }
                if(signalDigest(candidate)!==signalDigest(record.afterFailure))
                  record.incomplete.push('SIGNAL_CHANGED_DURING_SCREENSHOT');
              }else record.incomplete.push('POST_SCREENSHOT_SIGNAL_UNAVAILABLE');
            }catch{record.incomplete.push('POST_SCREENSHOT_SIGNAL_UNAVAILABLE');}
            const after=await page.evaluate(()=>({href:location.href,started:performance.timeOrigin}));
            if(!record.sameDocument||after.href!==initial!.href||after.started!==initial!.documentStartedAt){
              record.sameDocument=false;
              if(!record.incomplete.includes('DOCUMENT_CHANGED_DURING_SCREENSHOT'))record.incomplete.push('DOCUMENT_CHANGED_DURING_SCREENSHOT');
            }
            else if(screenshot.length>4*1024*1024)record.incomplete.push('SCREENSHOT_CAPACITY_EXCEEDED');
            else{await writeFile(join(directory,id+'.jpg'),screenshot,{flag:'wx',mode:0o600});record.screenshot={file:id+'.jpg',digest:digest(screenshot.toString('base64'))};}
          }catch{record.incomplete.push('SCREENSHOT_UNAVAILABLE');}
        }
      }catch{record.incomplete.push('AFTER_FAILURE_SNAPSHOT_UNAVAILABLE');}
      await writeFile(join(directory,id+'.json'),JSON.stringify({...record,runtime:securityRuntime(context.instanceId)}),{flag:'wx',mode:0o600});
      this.store.audit('SECURITY_INCIDENT_RECORDED',id,{sameDocument:record.sameDocument,screenshot:!!record.screenshot});
    }catch{this.store.audit('SECURITY_INCIDENT_EVIDENCE_UNAVAILABLE',id);}
  }
}
