import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readdir,readFile,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {digest,requireSafe,type Channel} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import {holdSecurityChannel,readSecurityHold} from '../storage/security-holds.js';
import {inspectSecuritySignal} from '../adapters/security-inspection.js';
import {securitySignalSchema,type SecuritySignal} from '../adapters/security-signal.js';
import {securityRuntime} from './security-runtime.js';

const uuid=/^[a-f0-9-]{36}$/u;
const maximumFiles=20,maximumBytes=50*1024*1024;
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
  async read(id:string):Promise<SecurityIncident|null>{
    if(!uuid.test(id))return null;
    try{
      const directory=await this.directory(),file=join(directory,id+'.json'),stat=await lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>100_000)return null;
      const value=JSON.parse(await readFile(file,'utf8')) as SecurityIncident;
      if(value.version!==1||value.id!==id||!['COMMENT_NOTIFICATION','DIRECT_MESSAGE'].includes(value.channel))return null;
      if(value.initial&&!securitySignalSchema.safeParse(value.initial).success)return null;
      return value;
    }catch{return null;}
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
  async record(channel:Channel,page:Page,initial:SecuritySignal|null,context:IncidentContext):Promise<void>{
    if(readSecurityHold(this.store,channel))return;
    const id=randomUUID(),createdAt=Date.now();
    holdSecurityChannel(this.store,channel,{incidentId:id,reason:'OBSERVATION_SECURITY_SUSPECT',mode:context.mode,
      source:'UNKNOWN',
      ...(initial?{documentDigest:digest([initial.href,initial.documentStartedAt])}:{})},createdAt);
    const record:SecurityIncident={version:1,id,channel,createdAt,context,initial,afterFailure:null,afterScreenshot:null,frames:[],sameDocument:false,screenshot:null,
      incomplete:initial?[]:['INITIAL_SIGNAL_UNAVAILABLE']};
    try{
      const directory=await this.directory();if(!await this.capacity(directory)){
        this.store.audit('SECURITY_EVIDENCE_CAPACITY_REACHED',id);return;
      }
      try{
        record.afterFailure=await page.evaluate(inspectSecuritySignal,{selectors:context.selectors});
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
