import type {Page} from 'playwright';
import type {BrowserProfileOwner} from '../browser/profile-owner.js';
import {Blocked,digest,requireSafe,type Channel,type ReplyAdapter} from '../core/contracts.js';
import {securityCandidateCodes,shouldStopGlobally} from '../core/emergency-stop.js';
import type {EventStore} from '../storage/store.js';
import {assertSecurityChannelClear,assertSecurityRevision,readSecurityHold,resolveSecurityHold,securityRevision} from '../storage/security-holds.js';
import {loadObservationMapping} from '../config/runtime.js';
import {DomAdapter} from '../adapters/dom-adapter.js';
import {hasVisibleSecurityComponent} from '../adapters/security-components.js';
import type {AccountId} from '../contracts/account.js';
import {observedSecurityBlockers,type ObservationMapping,type SiteMapping,type DmReplyMapping,type CommentReplyMapping} from '../config/site-mapping.js';
import {registerSecurityObserver,isSecurityFailure,parseSecuritySignal,reportSecurityFailure,type SecuritySignal} from '../adapters/security-signal.js';
import {ObservedReader,captureObserved} from '../adapters/observed-reader.js';
import type {CaptureInput} from '../adapters/observed-capture.js';
import {inspectRecoveryNavigation,recoveryComposerSelectors} from './browser-recovery-locations.js';
import {SecurityIncidents} from './security-incidents.js';
import {inspectSecuritySignal} from '../adapters/security-inspection.js';
import {emergencyRevision,recordEmergencyStop} from '../storage/emergency-stop.js';

/** Only a complete fixed code is authoritative; page text and error substrings are never causes. */
function strongFailure(error:unknown):Blocked|null {
  if(error instanceof Blocked)return shouldStopGlobally(error.code)?error:null;
  if(!(error instanceof Error))return null;
  const code=error.message.split(/\r?\n/u,1)[0]?.match(/^(?:page\.evaluate: Error: )?([A-Z_]+)$/u)?.[1];
  return code&&shouldStopGlobally(code)?new Blocked(code):null;
}

export function guardBrowserAdapter<T extends ReplyAdapter>(adapter:T,active:()=>void,
  check:()=>void=()=>{},failure?:(error:unknown)=>Promise<never>,
  submissionCheck:()=>()=>void=()=>check):T{
  const guarded=new Set(['inspect','prepare','verifyPrepared','baseline','clickOnce','readback','verifyExisting','refreshClock',
    'readSavedDraft','clearSavedDraft','locateSavedDraft','cancelPreparation']);
  return new Proxy(adapter,{get:(target,key)=>{
    const value=Reflect.get(target,key,target) as unknown;
    if(typeof value!=='function')return value;
    if(!guarded.has(String(key)))return value.bind(target);
    return async(...args:unknown[])=>{
      if(key==='cancelPreparation')return Reflect.apply(value,target,args);
      active();check();
      if(key==='clickOnce'){
        const verify=submissionCheck(),requested=args[1] as (()=>void)|undefined;
        args[1]=()=>{active();requested?.();verify();};
      }
      let result:unknown;
      try{result=await Reflect.apply(value,target,args);}
      catch(error){
        // A strong signal from an already-started page action remains authoritative as it closes.
        if(failure&&strongFailure(error))return failure(error);
        active();
        if(failure)return failure(error);
        throw error;
      }
      active();
      return result;
    };
  }});
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
  release(owner:BrowserProfileOwner):void{
    if(this.owner!==owner)return;
    this.detach.forEach(remove=>remove());this.detach=[];this.owner=undefined;
  }
  attach(owner:BrowserProfileOwner,epoch:number,mode:'headed'|'headless'):void{
    this.detach.forEach(remove=>remove());this.detach=[];this.owner=owner;this.epoch=epoch;this.mode=mode;
    for(const [channel,page] of [['COMMENT_NOTIFICATION',owner.notification],['DIRECT_MESSAGE',owner.dm]] as const)
      this.detach.push(registerSecurityObserver(page,signal=>this.record(channel,page,signal)));
  }
  private async record(channel:Channel,page:Page,signal:SecuritySignal|null,replaceRevision?:string):Promise<void>{
    const previous=readSecurityHold(this.store,channel),owner=this.owner,epoch=this.epoch;
    const mapping=await loadObservationMapping(this.root).catch(()=>null);
    await this.incidents.record(channel,page,signal,{mode:this.mode,epoch:this.epoch,instanceId:this.instanceId,
      selectors:[mapping?.securityBlockers??observedSecurityBlockers],mappingDigest:mapping?digest(mapping):null},replaceRevision);
    const held=readSecurityHold(this.store,channel);
    if(held&&held.revision!==previous?.revision&&owner&&this.owner===owner&&this.epoch===epoch){
      try{await this.captureFault?.(owner,channel);}catch{this.store.audit('SECURITY_RECOVERY_LOCATION_UNAVAILABLE',held.incidentId);}
    }
  }
  check(channel:Channel):void {assertSecurityChannelClear(this.store,channel);}
  async failure(channel:Channel,page:Page,error:unknown):Promise<never>{
    if(!this.store.db.open)throw error;
    const code=error instanceof Blocked?error.code:'';
    const strong=strongFailure(error);
    if(strong){
      recordEmergencyStop(this.store,true,Date.now(),strong.code,'UNKNOWN');
      if(['CHALLENGE_REQUIRED','SECURITY_VERIFICATION_CONFIRMED'].includes(strong.code)){
        const mapping=await loadObservationMapping(this.root).catch(()=>null);
        const signal=await page.evaluate(inspectSecuritySignal,{selectors:[mapping?.securityBlockers??observedSecurityBlockers]}).catch(()=>null);
        await this.record(channel,page,signal);
      }
      throw strong;
    }
    if(isSecurityFailure(error)||securityCandidateCodes.has(code)){
      await this.record(channel,page,parseSecuritySignal(error));throw new Blocked('OBSERVATION_SECURITY_SUSPECT');
    }
    throw error;
  }
  wrap<T extends ReplyAdapter>(adapter:T,channel:Channel,page:Page,active:()=>void=()=>{},submit:()=>void=()=>{}):T{
    return guardBrowserAdapter(adapter,active,()=>this.check(channel),error=>this.failure(channel,page,error),()=>{
      const revision=securityRevision(this.store,channel);
      return ()=>{submit();assertSecurityRevision(this.store,channel,revision);};
    });
  }
  async verifyManualCheck(owner:BrowserProfileOwner,mapping:SiteMapping,active:()=>void):Promise<void>{
    const ownId=this.store.accountOwnId();
    requireSafe(!ownId||ownId===mapping.ownId,'ACCOUNT_CHANGED');
    await owner.actor.run(async()=>{
      for(const [channel,page] of [['COMMENT_NOTIFICATION',owner.notification],['DIRECT_MESSAGE',owner.dm]] as const){
        active();this.check(channel);
        try{await new DomAdapter(page,channel,mapping,undefined,this.store.accountId).guard();}
        catch(error){return this.failure(channel,page,error);}
        active();this.check(channel);
      }
    });
  }
  async recover(owner:BrowserProfileOwner,channel:Channel,signal?:AbortSignal,explicit=false,inPlace=false,resolve=true,check:()=>void=()=>{}):Promise<boolean>{
    const held=readSecurityHold(this.store,channel);if(!held)return true;
    if(this.mode!=='headless'||!explicit&&Date.now()<(this.retryAt.get(channel)??0))return false;
    this.retryAt.set(channel,Date.now()+30_000);
    const epoch=this.epoch,stopRevision=emergencyRevision(this.store),page=channel==='DIRECT_MESSAGE'?owner.dm:owner.notification;
    const verify=async()=>{
      const active=()=>{check();requireSafe(this.owner===owner&&this.epoch===epoch&&!signal?.aborted&&
        emergencyRevision(this.store)===stopRevision&&
        readSecurityHold(this.store,channel)?.revision===held.revision,'SECURITY_RECOVERY_CHANGED');};
      let recoveryTarget:string|undefined;
      try{
        active();const incident=await this.incidents.readRecovery(held.incidentId);
        const mapping=await loadObservationMapping(this.root);active();
        let initial=incident?.initial??incident?.afterFailure;
        if(!initial&&incident?.fromFallback&&explicit&&mapping&&incident.channel===channel&&incident.context.mappingDigest===digest(mapping)){
          initial={version:1,state:'SUSPECT',href:mapping.entryUrl,origin:mapping.origin,title:'',
            documentStartedAt:0,observedAt:incident.createdAt,kind:'COMPONENT',scope:'ACCOUNT_PAGE',matches:[],frames:[]};
        }
        requireSafe(initial&&mapping&&incident?.channel===channel&&incident.context.mappingDigest===digest(mapping),'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
        const ownId=this.store.accountOwnId();
        requireSafe(ownId===mapping.self.uid,'ACCOUNT_CHANGED');
        const targetUrl=new URL(initial.href);targetUrl.hash='';targetUrl.search='';
        recoveryTarget=targetUrl.href;
        requireSafe(targetUrl.origin===mapping.origin&&!targetUrl.username&&!targetUrl.password,'UNEXPECTED_ORIGIN');
        const expanded=structuredClone(mapping);
        const entryPath=new URL(mapping.entryUrl).pathname;
        const accountPage=[entryPath,'/'].includes(targetUrl.pathname)&&(
          initial.scope==='ACCOUNT_PAGE'&&!initial.target?.workId&&!initial.target?.conversationId&&!incident.conversationDigest||
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
          let id=initial.target?.conversationId;
          let known=mapping.peers.find(peer=>peer.conversationId===id);
          let discovered=id&&this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='discovered_conversations'").get()?
            this.store.db.prepare('SELECT id,uid,sec_uid,title FROM discovered_conversations WHERE id=? AND own_id=?').get(id,mapping.self.uid) as {id:string;uid:string;sec_uid:string;title:string}|undefined:undefined;
          if(!id&&incident.conversationDigest){
            known=mapping.peers.find(peer=>digest(peer.conversationId)===incident.conversationDigest);
            if(known)id=known.conversationId;
            else if(this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='discovered_conversations'").get()){
              const rows=this.store.db.prepare('SELECT id,uid,sec_uid,title FROM discovered_conversations WHERE own_id=?').all(mapping.self.uid) as {id:string;uid:string;sec_uid:string;title:string}[];
              discovered=rows.find(row=>digest(row.id)===incident.conversationDigest);
              if(discovered)id=discovered.id;
            }
          }
          requireSafe(initial.scope==='ACCOUNT_PAGE'||id&&(known||discovered),'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
          if(id)expanded.peers=[known??{uid:discovered!.uid,secUid:discovered!.sec_uid,title:discovered!.title,conversationId:id}];
          requireSafe(targetUrl.pathname===entryPath,'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
        }
        if(page.url().split('?')[0]!==targetUrl.href){
          requireSafe(explicit&&!inPlace,'SECURITY_RECOVERY_TARGET_UNAVAILABLE');
          const composers=await recoveryComposerSelectors(this.root);active();
          const navigation=await page.evaluate(inspectRecoveryNavigation,{
            origin:mapping.origin,composers:composers[channel],nativeDmComposer:composers.nativeDmComposer,
          });active();
          requireSafe(navigation.originMatches&&navigation.empty,'BROWSER_HAS_HUMAN_INPUT');
          await page.goto(targetUrl.href,{waitUntil:'domcontentloaded'});active();
        }
        await new ObservedReader(page,expanded,undefined,signal,this.store.accountId).guard();active();
        const document=await page.evaluate(()=>({href:location.href,started:performance.timeOrigin}));
        const input:CaptureInput={mapping:expanded,channel:accountPage?'identity':channel==='DIRECT_MESSAGE'?'dm':'comments',index:0,accountId:this.store.accountId,evidenceId:held.incidentId,
          ...(channel==='DIRECT_MESSAGE'&&!accountPage?{peer:expanded.peers[0]!,dmWindow:true,collectionPartial:true}:{})};
        await page.evaluate(captureObserved,input).catch(error=>reportSecurityFailure(page,error));active();
        const after=await page.evaluate(()=>({href:location.href,started:performance.timeOrigin}));active();
        requireSafe(digest(document)===digest(after)&&after.href.split('?')[0]===targetUrl.href,'SECURITY_RECOVERY_CHANGED');
        return explicit&&resolve?resolveSecurityHold(this.store,channel,held.revision,undefined,active):true;
      }catch(error){
        const strong=strongFailure(error);
        const challenge=strong&&['CHALLENGE_REQUIRED','SECURITY_VERIFICATION_CONFIRMED'].includes(strong.code);
        if(explicit&&!inPlace&&recoveryTarget&&(challenge||isSecurityFailure(error)||error instanceof Blocked&&securityCandidateCodes.has(error.code))){
          // A new challenge after an explicit recovery is a new incident, never a restored old instance.
          active();const mapping=await loadObservationMapping(this.root);
          if(mapping){
            const fresh=await page.evaluate(inspectSecuritySignal,{selectors:[mapping.securityBlockers]});active();
            const incident=await this.incidents.readRecovery(held.incidentId),original=incident?.initial??incident?.afterFailure;
            active();
            if(fresh.state==='SUSPECT'&&fresh.origin===mapping.origin&&fresh.href.split('?')[0]===recoveryTarget&&
              (!incident?.sameDocument||!original||fresh.documentStartedAt!==original.documentStartedAt||fresh.href!==original.href||
                incident?.context.epoch!==epoch||incident?.context.instanceId!==this.instanceId)){
              await this.record(channel,page,fresh,held.revision);
            }
          }
        }
        if(strong)return this.failure(channel,page,strong);
        if(explicit)throw error;return false;
      }
    };
    return inPlace?verify():owner.actor.run(verify,'background');
  }
}

/** Both pages must verify before any freeze is lifted. The caller owns the account actor. */
export async function verifyEmergencyPages(owner:BrowserProfileOwner,input:{
  observation:ObservationMapping|null;mapping:SiteMapping|null;commentReply:CommentReplyMapping|null;dmReply:DmReplyMapping|null;
  ownId:string;signal:AbortSignal;accountId:AccountId;active:()=>void;
}):Promise<void>{
  const {observation,mapping,commentReply,dmReply,ownId,signal,accountId,active}=input;
  for(const [channel,page,reply] of [['COMMENT_NOTIFICATION',owner.notification,commentReply],['DIRECT_MESSAGE',owner.dm,dmReply]] as const){
    active();
    try{
      if(observation)await new ObservedReader(page,observation,undefined,signal,accountId).guard();
      else await new DomAdapter(page,channel,mapping!,undefined,accountId).guard();
      active();
      if(reply){
        requireSafe(reply.observation.self.uid===ownId&&(!observation||reply.observation.self.secUid===observation.self.secUid),'ACCOUNT_CHANGED');
        requireSafe(!await page.evaluate(hasVisibleSecurityComponent,[reply.blockers,reply.observation.securityBlockers]),
          channel==='DIRECT_MESSAGE'?'NATIVE_REPLY_INTERACTION_BLOCKED':'COMMENT_REPLY_INTERACTION_BLOCKED');
      }
    }catch(error){
      if(error instanceof Error&&error.name==='TimeoutError')requireSafe(false,'ACCOUNT_NOT_VERIFIED');
      throw error;
    }
    active();
  }
}
