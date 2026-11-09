import type Database from 'better-sqlite3';
import {join} from 'node:path';
import {lstat} from 'node:fs/promises';
import {loadRuntime} from '../config/runtime.js';
import {inspectEvidence,maintainEvidence,type EvidenceRetentionReport} from '../observability/evidence.js';
import {collectEvidenceReferences} from './evidence-references.js';

type Store={db:Database.Database};
interface Options {now?:()=>number;intervalMs?:number}

/** Shared CLI/desktop maintenance. No timer, business writes, browser work or mutation of referenced records. */
export class EvidenceMaintenance {
  private active:Promise<EvidenceRetentionReport>|null=null;
  private abort:AbortController|undefined;
  private closed=false;
  private nextAt=0;
  private latest:EvidenceRetentionReport|null=null;
  private failure:string|null=null;
  private readonly now:()=>number;
  private readonly intervalMs:number;
  constructor(private readonly store:Store,private readonly root:string,options:Options={}){
    this.now=options.now??Date.now;this.intervalMs=options.intervalMs??24*3600_000;
  }
  status(){return {running:this.active!==null,nextAt:this.nextAt,error:this.failure,report:this.latest};}
  report(signal?:AbortSignal):Promise<EvidenceRetentionReport>{return this.run(false,signal);}
  prune(signal?:AbortSignal):Promise<EvidenceRetentionReport>{return this.run(true,signal);}
  async runIfDue(idle:boolean):Promise<EvidenceRetentionReport|null>{
    if(!idle){this.cancel();return null;}
    if(this.closed||this.active||this.now()<this.nextAt)return null;
    return this.prune();
  }
  cancel():void{this.abort?.abort();}
  async close():Promise<void>{this.closed=true;this.cancel();await this.active?.catch(()=>{});}
  private async run(remove:boolean,signal?:AbortSignal):Promise<EvidenceRetentionReport>{
    if(this.active)return this.active;
    if(this.closed)throw new Error('EVIDENCE_MAINTENANCE_CLOSED');
    const abort=new AbortController();this.abort=abort;
    const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const task=(async()=>{
      const rootStat=await lstat(this.root);
      if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('EVIDENCE_DIRECTORY_UNSAFE');
      const config=await loadRuntime(this.root),protection=collectEvidenceReferences(this.store,this.root);
      const options={now:this.now(),signal:combined,protection,refreshProtection:()=>collectEvidenceReferences(this.store,this.root)};
      const result=await (remove?maintainEvidence:inspectEvidence)(join(this.root,'evidence'),config.evidenceRetentionDays,options);
      this.latest=result;this.failure=null;
      if(remove)this.nextAt=result.cancelled?this.now():this.now()+this.intervalMs;
      return result;
    })().catch(error=>{
      this.failure=error instanceof Error&&error.message==='EVIDENCE_DIRECTORY_UNSAFE'?'EVIDENCE_DIRECTORY_UNSAFE':'EVIDENCE_MAINTENANCE_UNAVAILABLE';
      this.nextAt=this.now()+this.intervalMs;throw new Error(this.failure);
    }).finally(()=>{this.active=null;this.abort=undefined;});
    this.active=task;return task;
  }
}
