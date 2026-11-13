import {lstat,mkdir,rename,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {BrowserProcessSampler,type BrowserProcessResult} from './browser-metrics.js';
import {browserResourceReasons,type BrowserResourceLatest,type BrowserResourceReason,type BrowserResourcesSnapshot,type BrowserResourceWindow} from './browser-resource-contracts.js';

export type {BrowserResourcesSnapshot} from './browser-resource-contracts.js';
export interface BrowserResourceIdentity {open:boolean;epoch:number;mode:'headed'|'headless';pageCount:number}
export interface BrowserResourcesOptions {
  root:string;identity:()=>BrowserResourceIdentity;now?:()=>number;
  sample?:(signal:AbortSignal)=>Promise<BrowserProcessResult>;onUpdated?:()=>void;
}
interface ResourceSample extends BrowserResourceLatest {sampledAt:number}
const intervalMs=60_000,staleMs=150_000,retentionMs=86_400_000,maxSamples=1_440,maxReportBytes=2_097_152;

function summarize(samples:readonly ResourceSample[]):BrowserResourceWindow|null {
  if(samples.length===0)return null;
  const distribution=(key:'workingSetBytes'|'privateBytes')=>{
    const values=samples.map(sample=>sample[key]).sort((a,b)=>a-b);
    return {p50:values[Math.ceil(values.length*0.5)-1]!,p95:values[Math.ceil(values.length*0.95)-1]!,max:values.at(-1)!};
  };
  return {samples:samples.length,workingSetBytes:distribution('workingSetBytes'),privateBytes:distribution('privateBytes')};
}

/** Sidecar-owned, single-flight OS sampler. Diagnostics only reads this bounded cache. */
export class BrowserResources {
  private readonly now:()=>number;
  private readonly sample:(signal:AbortSignal)=>Promise<BrowserProcessResult>;
  private readonly sampler:BrowserProcessSampler;
  private readonly directory:string;
  private readonly report:string;
  private readonly temporary:string;
  private timer:ReturnType<typeof setInterval>|null=null;
  private inflight:Promise<void>|null=null;
  private controller:AbortController|null=null;
  private closed=false;
  private started=false;
  private readyOwner:string|null=null;
  private state:BrowserResourcesSnapshot['state']='WAITING';
  private reason:BrowserResourceReason|null='NO_OWNER';
  private samples:ResourceSample[]=[];
  private latestSample:ResourceSample|null=null;
  private segmentKey:string|null=null;
  private segmentEpoch:number|null=null;
  private segmentMode:BrowserResourceIdentity['mode']|null=null;
  private segmentStartedAt:number|null=null;
  constructor(private readonly options:BrowserResourcesOptions) {
    this.now=options.now??Date.now;
    this.sampler=new BrowserProcessSampler();
    this.sample=options.sample??(signal=>this.sampler.sample(signal));
    this.directory=join(resolve(options.root),'reports');
    this.report=join(this.directory,'browser-resources.json');
    this.temporary=this.report+'.tmp';
  }
  start():void {
    if(this.started||this.closed)return;
    this.started=true;
    this.timer=setInterval(()=>{void this.sampleNow();},intervalMs);
    this.timer.unref();
    this.ownerReady();
  }
  ownerReady():void {
    if(!this.started||this.closed)return;
    const current=this.identity();
    if(!current?.open){this.readyOwner=null;return;}
    const key=`${current.epoch}:${current.mode}`;
    if(this.readyOwner===key)return;
    this.readyOwner=key;void this.sampleNow();
  }
  sampleNow():Promise<void> {
    if(this.closed)return Promise.resolve();
    if(this.inflight)return this.inflight;
    const operation=this.collect();
    this.inflight=operation;
    void operation.finally(()=>{if(this.inflight===operation)this.inflight=null;});
    return operation;
  }
  private reset():void {
    this.samples=[];this.latestSample=null;this.segmentKey=null;this.segmentEpoch=null;this.segmentMode=null;this.segmentStartedAt=null;
  }
  private identity():BrowserResourceIdentity|null {
    try{
      const current=this.options.identity();
      if(typeof current.open!=='boolean'||!Number.isSafeInteger(current.epoch)||current.epoch<0||
        !['headed','headless'].includes(current.mode)||!Number.isSafeInteger(current.pageCount)||current.pageCount<0)return null;
      return {...current};
    }catch{return null;}
  }
  private updated():void {
    if(!this.closed){try{this.options.onUpdated?.();}catch{/* A UI subscriber cannot affect monitoring or collection. */}}
  }
  private async collect():Promise<void> {
    const before=this.identity();
    if(!before){this.reset();this.state='UNAVAILABLE';this.reason='PROCESS_UNAVAILABLE';this.updated();return;}
    if(!before.open){this.reset();this.state='WAITING';this.reason='NO_OWNER';this.updated();return;}
    if(this.segmentEpoch!==null&&before.epoch!==this.segmentEpoch)this.reset();
    const controller=new AbortController();this.controller=controller;
    let timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;controller.abort();},5_000);
    timeout.unref();
    const started=performance.now();
    try{
      const cancelled=new Promise<BrowserProcessResult>(resolveResult=>{
        controller.signal.addEventListener('abort',()=>resolveResult({ok:false,reason:timedOut?'TIMEOUT':'CANCELLED'}),{once:true});
      });
      const result=await Promise.race([this.sample(controller.signal),cancelled]);
      if(this.closed)return;
      const after=this.identity();
      if(!after||!after.open||before.epoch!==after.epoch||before.mode!==after.mode){
        this.reset();this.state='WAITING';this.reason='OWNER_CHANGED';return;
      }
      if(!result.ok){this.state='UNAVAILABLE';this.reason=browserResourceReasons.includes(result.reason)?result.reason:'INVALID_SAMPLE';return;}
      const value=result.value;
      if(![value.rootPid,value.rootCreatedAt,value.browserProcesses,value.workingSetBytes,value.privateBytes].every(number=>Number.isSafeInteger(number)&&number>0)||
        !Number.isSafeInteger(after.pageCount)||after.pageCount<0){
        this.state='UNAVAILABLE';this.reason='INVALID_SAMPLE';return;
      }
      const key=`${before.epoch}:${value.rootPid}:${value.rootCreatedAt}`;
      const sampledAt=this.now();
      if(!Number.isSafeInteger(sampledAt)||sampledAt<0){this.state='UNAVAILABLE';this.reason='INVALID_SAMPLE';return;}
      if(this.segmentKey!==key){this.reset();this.segmentKey=key;this.segmentEpoch=before.epoch;this.segmentMode=before.mode;this.segmentStartedAt=sampledAt;}
      this.latestSample={sampledAt,workingSetBytes:value.workingSetBytes,privateBytes:value.privateBytes,
        browserProcesses:value.browserProcesses,pageCount:after.pageCount,elapsedMs:Math.max(0,Math.round(performance.now()-started))};
      this.samples.push(this.latestSample);
      this.trim(sampledAt);this.state='AVAILABLE';this.reason=null;
      if(!await this.saveReport()&&!this.closed)this.reason='REPORT_WRITE_FAILED';
    }catch{
      if(!this.closed){this.state='UNAVAILABLE';this.reason='PROCESS_UNAVAILABLE';}
    }finally{
      clearTimeout(timeout);if(this.controller===controller)this.controller=null;
      // execFile can reject on abort before Windows reports the child closed.
      // Keep single-flight ownership through that final OS cleanup as well.
      await this.sampler.close();
      this.updated();
    }
  }
  private trim(now:number):void {
    this.samples=this.samples.filter(sample=>sample.sampledAt>=now-retentionMs).slice(-maxSamples);
  }
  snapshot():BrowserResourcesSnapshot {
    if(!this.closed){
      const current=this.identity();
      if(!current||!current.open||(this.segmentEpoch!==null&&(current.epoch!==this.segmentEpoch||current.mode!==this.segmentMode))){
        return {state:current?'WAITING':'UNAVAILABLE',reason:!current?'PROCESS_UNAVAILABLE':current.open?'OWNER_CHANGED':'NO_OWNER',
          intervalMs,sampledAt:null,segmentStartedAt:null,latest:null,hour:null,run:null};
      }
    }
    const now=this.now();
    this.trim(now);
    const last=this.latestSample;
    const stale=last!==null&&now-last.sampledAt>staleMs;
    return {state:this.closed?'CLOSED':stale?'STALE':this.state,reason:this.closed?'CLOSED':stale?'SAMPLE_STALE':this.reason,
      intervalMs,sampledAt:last?.sampledAt??null,segmentStartedAt:this.segmentStartedAt,
      latest:last?{workingSetBytes:last.workingSetBytes,privateBytes:last.privateBytes,browserProcesses:last.browserProcesses,
        pageCount:last.pageCount,elapsedMs:last.elapsedMs}:null,
      hour:summarize(this.samples.filter(sample=>sample.sampledAt>=now-3_600_000)),run:summarize(this.samples)};
  }
  private async saveReport():Promise<boolean> {
    const body=JSON.stringify({version:1,...this.snapshot(),samples:this.samples});
    if(Buffer.byteLength(body)>maxReportBytes)return false;
    try{
      await mkdir(this.directory,{recursive:true});
      const directory=await lstat(this.directory);
      if(!directory.isDirectory()||directory.isSymbolicLink())return false;
      for(const path of [this.report,this.temporary]){
        try{const existing=await lstat(path);if(!existing.isFile()||existing.isSymbolicLink())return false;}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return false;}
      }
      if(this.closed)return false;
      await unlink(this.temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
      if(this.closed)return false;
      await writeFile(this.temporary,body,{mode:0o600,flag:'wx'});
      if(this.closed)return false;
      await rename(this.temporary,this.report);
      return true;
    }catch{return false;}
    finally{await unlink(this.temporary).catch(()=>{});}
  }
  async close():Promise<void> {
    if(this.closed){await this.inflight;return;}
    this.closed=true;
    if(this.timer!==null){clearInterval(this.timer);this.timer=null;}
    this.controller?.abort();
    await Promise.all([this.inflight,this.sampler.close()]);
  }
}
