import type {Page} from 'playwright';
import type {BrowserProfileOwner} from '../browser/profile-owner.js';
import {Blocked,digest,requireSafe,type Channel,type ReplyAdapter} from '../core/contracts.js';
import {securityCandidateCodes,shouldStopGlobally} from '../core/emergency-stop.js';
import type {EventStore} from '../storage/store.js';
import {assertSecurityChannelClear,readSecurityHold,resolveSecurityHold} from '../storage/security-holds.js';
import {loadObservationMapping} from '../config/runtime.js';
import {observedSecurityBlockers} from '../config/site-mapping.js';
import {registerSecurityObserver,isSecurityFailure,parseSecuritySignal,reportSecurityFailure,type SecuritySignal} from '../adapters/security-signal.js';
import {ObservedReader,captureObserved} from '../adapters/observed-reader.js';
import type {CaptureInput} from '../adapters/observed-capture.js';
import {inspectRecoveryNavigation} from './browser-recovery-locations.js';
import {SecurityIncidents} from './security-incidents.js';
import {recordEmergencyStop} from '../storage/emergency-stop.js';

/** Only a complete fixed code is authoritative; page text and error substrings are never causes. */
function strongFailure(error:unknown):Blocked|null {
  if(error instanceof Blocked)return shouldStopGlobally(error.code)?error:null;
  if(!(error instanceof Error))return null;
  const code=error.message.split(/\r?\n/u,1)[0]?.match(/^(?:page\.evaluate: Error: )?([A-Z_]+)$/u)?.[1];
  return code&&shouldStopGlobally(code)?new Blocked(code):null;
}

/** Owns no browser or queue. Every page call is made by the existing account actor. */
export class BrowserSafety {
  private detach:(()=>void)[]=[];
  private owner:BrowserProfileOwner|undefined;
  private epoch=0;
  private mode:'headed'|'headless'='headless';
  private retryAt=new Map<Channel,number>();
  instanceId:string|null=null;
  readonly incidents:SecurityIncidents;
  constructor(readonly root:string,readonly store:EventStore,
    private readonly captureFault?:(owner:BrowserProfileOwner,channel:Channel)=>Promise<void>){this.incidents=new SecurityIncidents(root,store);}
  attach(owner:BrowserProfileOwner,epoch:number,mode:'headed'|'headless'):void{
    this.detach.forEach(remove=>remove());this.detach=[];this.owner=owner;this.epoch=epoch;this.mode=mode;
    for(const [channel,page] of [['COMMENT_NOTIFICATION',owner.notification],['DIRECT_MESSAGE',owner.dm]] as const)
      this.detach.push(registerSecurityObserver(page,signal=>this.record(channel,page,signal)));
  }
  private async record(channel:Channel,page:Page,signal:SecuritySignal|null):Promise<void>{
    const previous=readSecurityHold(this.store,channel),owner=this.owner,epoch=this.epoch;
    const mapping=await loadObservationMapping(this.root).catch(()=>null);
    await this.incidents.record(channel,page,signal,{mode:this.mode,epoch:this.epoch,instanceId:this.instanceId,
      selectors:[mapping?.securityBlockers??observedSecurityBlockers],mappingDigest:mapping?digest(mapping):null});
    const held=readSecurityHold(this.store,channel);
    if(!previous&&held&&owner&&this.owner===owner&&this.epoch===epoch){
      try{await this.captureFault?.(owner,channel);}catch{this.store.audit('SECURITY_RECOVERY_LOCATION_UNAVAILABLE',held.incidentId);}
    }
  }
  check(channel:Channel):void {assertSecurityChannelClear(this.store,channel);}
  async failure(channel:Channel,page:Page,error:unknown):Promise<never>{
    const code=error instanceof Blocked?error.code:'';
    const strong=strongFailure(error);
    if(strong){
      recordEmergencyStop(this.store,true,Date.now(),strong.code,'UNKNOWN');throw strong;
    }
    if(isSecurityFailure(error)||securityCandidateCodes.has(code)){
      await this.record(channel,page,parseSecuritySignal(error));throw new Blocked('OBSERVATION_SECURITY_SUSPECT');
    }
    throw error;
  }
  wrap<T extends ReplyAdapter>(adapter:T,channel:Channel,page:Page):T{
    const guarded=new Set(['inspect','prepare','verifyPrepared','baseline','clickOnce','readback','verifyExisting','refreshClock',
      'readSavedDraft','clearSavedDraft','locateSavedDraft']);
    return new Proxy(adapter,{get:(target,key)=>{
      const value=Reflect.get(target,key,target) as unknown;
      if(typeof value!=='function')return value;
      if(!guarded.has(String(key)))return value.bind(target);
      return async(...args:unknown[])=>{
        this.check(channel);
        try{return await Reflect.apply(value,target,args);}catch(error){return this.failure(channel,page,error);}
      };
    }});
  }
  async recover(owner:BrowserProfileOwner,channel:Channel,signal?:AbortSignal,explicit=false):Promise<boolean>{
    const held=readSecurityHold(this.store,channel);if(!held)return true;
    if(this.mode!=='headless'||!explicit&&Date.now()<(this.retryAt.get(channel)??0))return false;
    this.retryAt.set(channel,Date.now()+30_000);
    const epoch=this.epoch,page=channel==='DIRECT_MESSAGE'?owner.dm:owner.notification;
    return owner.actor.run(async()=>{
      const active=()=>requireSafe(this.owner===owner&&this.epoch===epoch&&!signal?.aborted&&
        readSecurityHold(this.store,channel)?.revision===held.revision,'SECURITY_RECOVERY_CHANGED');
      try{
        active();const incident=await this.incidents.read(held.incidentId),initial=incident?.initial??incident?.afterFailure;
        const mapping=await loadObservationMapping(this.root);active();
        requireSafe(initial&&mapping&&incident?.channel===channel&&incident.context.mappingDigest===digest(mapping),'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
        const own=this.store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
        requireSafe(own?.own_id===mapping.self.uid,'ACCOUNT_CHANGED');
        const targetUrl=new URL(initial.href);targetUrl.hash='';targetUrl.search='';
        requireSafe(targetUrl.origin===mapping.origin&&!targetUrl.username&&!targetUrl.password,'UNEXPECTED_ORIGIN');
        const expanded=structuredClone(mapping);
        const entryPath=new URL(mapping.entryUrl).pathname;
        const accountPage=[entryPath,'/'].includes(targetUrl.pathname)&&(
          initial.scope==='ACCOUNT_PAGE'&&!initial.target?.workId&&!initial.target?.conversationId||
          channel==='COMMENT_NOTIFICATION'&&!initial.target?.workId);
        if(accountPage){
          requireSafe([new URL(mapping.entryUrl).pathname,'/'].includes(targetUrl.pathname),'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
        }else if(channel==='COMMENT_NOTIFICATION'){
          const id=initial.target?.workId??targetUrl.pathname.match(/^\/(?:video|note)\/(\d+)$/u)?.[1];
          const known=mapping.works.find(work=>work.id===id&&work.url.split('?')[0]===targetUrl.href);
          const discovered=this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='discovered_works'").get()?
            this.store.db.prepare("SELECT url FROM discovered_works WHERE id=? AND own_id=? AND state='INCLUDED'").get(id??'',mapping.self.uid) as {url:string}|undefined:undefined;
          requireSafe(id&&(known||discovered?.url===targetUrl.href),'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
          expanded.works=[{id,url:targetUrl.href}];
        }else{
          const id=initial.target?.conversationId;
          const known=mapping.peers.find(peer=>peer.conversationId===id);
          const discovered=id&&this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='discovered_conversations'").get()?
            this.store.db.prepare('SELECT uid,sec_uid,title FROM discovered_conversations WHERE id=? AND own_id=?').get(id,mapping.self.uid) as {uid:string;sec_uid:string;title:string}|undefined:undefined;
          requireSafe(initial.scope==='ACCOUNT_PAGE'||id&&(known||discovered),'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
          if(id)expanded.peers=[known??{uid:discovered!.uid,secUid:discovered!.sec_uid,title:discovered!.title,conversationId:id}];
          requireSafe(targetUrl.pathname===entryPath,'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
        }
        if(page.url().split('?')[0]!==targetUrl.href){
          requireSafe(explicit,'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
          const navigation=await page.evaluate(inspectRecoveryNavigation,mapping.origin);active();
          requireSafe(navigation.originMatches&&navigation.empty,'BROWSER_HAS_HUMAN_INPUT');
          await page.goto(targetUrl.href,{waitUntil:'domcontentloaded'});active();
        }
        await new ObservedReader(page,expanded,undefined,signal).guard();active();
        const document=await page.evaluate(()=>({href:location.href,started:performance.timeOrigin}));
        const input:CaptureInput={mapping:expanded,channel:accountPage?'identity':channel==='DIRECT_MESSAGE'?'dm':'comments',index:0,evidenceId:held.incidentId,
          ...(channel==='DIRECT_MESSAGE'&&!accountPage?{peer:expanded.peers[0]!,dmWindow:true,collectionPartial:true}:{})};
        await page.evaluate(captureObserved,input).catch(error=>reportSecurityFailure(page,error));active();
        const after=await page.evaluate(()=>({href:location.href,started:performance.timeOrigin}));active();
        requireSafe(digest(document)===digest(after)&&after.href.split('?')[0]===targetUrl.href,'SECURITY_RECOVERY_CHANGED');
        return resolveSecurityHold(this.store,channel,held.revision);
      }catch(error){
        const strong=strongFailure(error);
        if(strong)return this.failure(channel,page,strong);
        if(explicit)throw error;return false;
      }
    },'background');
  }
}
