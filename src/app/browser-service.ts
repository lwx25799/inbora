import { join } from "node:path";
import { accountIdSchema, DEFAULT_ACCOUNT_ID, type AccountId } from "../contracts/account.js";
import {BrowserRecoveryLocations,inspectRecoveryNavigation,recoveryComposerSelectors} from './browser-recovery-locations.js';
import { BrowserProfileOwner } from "../browser/profile-owner.js";
import { ObservedReader } from "../adapters/observed-reader.js";
import { ObservedDmReply } from "../adapters/observed-dm-reply.js";
import { ObservedCommentReply } from "../adapters/observed-comment-reply.js";
import {commentReadbackAudit} from '../adapters/comment-readback-diagnostics.js';
import { DomAdapter } from "../adapters/dom-adapter.js";
import {
  loadObservationMapping,
  loadDmReplyMapping,
  loadCommentReplyMapping,
  loadMapping,
} from "../config/runtime.js";
import {
  Blocked,
  digest,
  requireSafe,
  type Channel,
  type InboundEvent,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { recordEvidence } from "../observability/evidence.js";
import type {
  AdapterHandle, AdapterOptions, CapabilityIdentity, CollectionSource, FollowupVerificationResult, ObservationResult, ObservationSource,
  PlatformStatus, PreviewDisplayTarget, VerificationOptions, VerificationResult,
} from "../platform/platform-connector.js";
export type { AdapterHandle } from "../platform/platform-connector.js";
import { InboxCollector } from "./inbox-collector.js";
import type { AutomationStore } from "../storage/automation-store.js";
import {MessagePreviewStore} from '../storage/message-previews.js';
import {resolveStoredDmMessage,locateStoredDmMessage} from './message-view.js';
import {BrowserSafety,guardBrowserAdapter,verifyEmergencyPages} from './browser-safety.js';
import {BrowserManualRecovery} from './browser-manual-recovery.js';
import type {ManualRecoveryCommand,ManualRecoveryResult} from './manual-recovery-contracts.js';
import {verifyFollowupInBrowser} from './followup-verification.js';
import {readExistingReply} from '../platform/read-existing-reply.js';
import {readSecurityHold,resolveSecurityHold,securityRevision} from '../storage/security-holds.js';

const channels=['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as const;
const accountHome='https://www.douyin.com';

export class BrowserService {
  private recoveryLocations:BrowserRecoveryLocations;
  private safety:BrowserSafety|undefined;
  private manualRecovery:BrowserManualRecovery|undefined;
  private runtimeInstance:string|null=null;
  onManualRecoveryClosed:()=>void=()=>{};
  get manualRecoveryActive(){return this.manualRecovery?.active??false;}
  manualRecoveryStatus(){return this.manualRecovery?.status()??null;}
  async securityRecovery(command:ManualRecoveryCommand,token:string,check:()=>void):Promise<ManualRecoveryResult>{
    requireSafe(this.manualRecovery,'MANUAL_RECOVERY_INCIDENT_REQUIRED');
    return this.manualRecovery.handle(command,token,check);
  }
  async closeManualRecovery():Promise<void>{await this.manualRecovery?.shutdown();}
  bindStore(store:EventStore):void {
    store.assertAccount(this.accountId);
    if(this.safety?.store===store)return;
    if(this.safety){
      requireSafe(!this.owner&&!this.opening&&!this.closing&&!this.closeRequests&&!this.modeTransition&&!this.viewRequests.size&&!this.manualRecoveryActive,'BROWSER_STORE_IN_USE');
      this.recoveryLocations=new BrowserRecoveryLocations(this.root);
      this.previewHint=undefined;
      this.recoveringLogin=false;this.autoFinishLogin=true;this.loginGeneration++;
    }
    const locations=this.recoveryLocations;
    locations.bindStore(store);
    this.safety=new BrowserSafety(this.root,store,(owner,channel)=>locations.captureFault(owner,channel));
    this.safety.instanceId=this.runtimeInstance;
    this.manualRecovery=new BrowserManualRecovery(this.root,store,this.safety,()=>({owner:this.owner,epoch:this.epoch,mode:this.mode,
      transitioning:this.recoveringLogin||!!this.modeTransition||!!this.opening||!!this.closing||!!this.closeRequests}));
    this.manualRecovery.onClosed=()=>this.onManualRecoveryClosed();
    if(this.owner)this.safety.attach(this.owner,this.epoch,this.mode);
  }
  setRuntimeInstance(instanceId:string|null):void {this.runtimeInstance=instanceId;if(this.safety)this.safety.instanceId=instanceId;}
  async recoverSecurityHolds(explicit=false,signal?:AbortSignal,check:()=>void=()=>{}):Promise<void>{
    const owner=this.owner,safety=this.safety;
    if(!owner||!safety||this.mode!=='headless'||this.loginRecovery)return;
    const request=this.securityRecoveryRequest(signal,check);
    for(const {channel,check:unchanged} of request){
      unchanged();await safety.recover(owner,channel,signal,explicit,false,true,unchanged);
    }
  }
  private securityRecoveryRequest(signal:AbortSignal|undefined,check:()=>void){
    const owner=this.owner,epoch=this.epoch,safety=this.safety;
    return safety?channels.map(channel=>{
      const revision=securityRevision(safety.store,channel),hold=readSecurityHold(safety.store,channel);
      return {channel,hold,check:()=>{
        check();
        requireSafe(this.owner===owner&&this.epoch===epoch&&this.safety===safety&&!this.closeRequests&&!this.closing&&
          this.mode==='headless'&&!this.loginRecovery,'BROWSER_CLOSED');
        requireSafe(!signal?.aborted&&securityRevision(safety.store,channel)===revision,'SECURITY_RECOVERY_CHANGED');
      }};
    }):[];
  }
  isIdle():boolean {return !this.owner||this.owner.actor.idle;}
  private owner: BrowserProfileOwner | undefined;
  private mode: "headed" | "headless" = "headless";
  private currentIdentity = new Map<Channel, CapabilityIdentity>();
  private state = "CLOSED";
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closeRequests=0;
  private epoch = 0;
  private collector: InboxCollector | undefined;
  private collectorMapping = "";
  private previewHint:{ownId:string;conversationId:string;eventId?:string|PreviewDisplayTarget}|undefined;
  private recoveringLogin=false;
  private autoFinishLogin=true;
  private loginGeneration=0;
  private modeTransition:Promise<void>|undefined;
  private readonly viewRequests=new Set<number>();
  private latestViewRequest=0;
  get loginRecovery(){return this.recoveringLogin||this.viewRequests.size>0||this.manualRecoveryActive;}
  get ownerEpoch() { return this.epoch; }
  resourceIdentity() {
    return {open:!!this.owner&&this.state.startsWith('OPEN'),epoch:this.epoch,mode:this.mode,pageCount:this.owner?.context.pages().length??0};
  }
  constructor(
    readonly root: string,
    private readonly launch = BrowserProfileOwner.launch,
    readonly accountId: AccountId = DEFAULT_ACCOUNT_ID,
  ) {
    requireSafe(accountIdSchema.safeParse(accountId).success, 'ACCOUNT_ID_INVALID');
    this.recoveryLocations=new BrowserRecoveryLocations(root);
  }
  static adopt(
    root: string,
    owner: BrowserProfileOwner,
    mode: "headed" | "headless",
    accountId: AccountId = DEFAULT_ACCOUNT_ID,
  ): BrowserService {
    const service = new BrowserService(root, undefined, accountId);
    service.attachOwner(owner);
    service.mode = mode;
    service.state = "OPEN_IDENTITY_UNVERIFIED";
    return service;
  }
  get actor() {
    requireSafe(this.owner, "BROWSER_NOT_RUNNING");
    return this.owner.actor;
  }
  status():PlatformStatus {
    return {
      state: this.recoveringLogin?this.autoFinishLogin?'LOGIN_RECOVERY':this.owner&&this.mode==='headed'?'MANUAL_VISIBLE':'MANUAL_VISIBLE_PENDING':this.state,
      mode: this.mode,
      loginRecovery:this.recoveringLogin,
      version: this.owner?.version() ?? null,
    };
  }
  async workUrl(event: InboundEvent, store?:EventStore): Promise<string | null> {
    requireSafe(event.accountId===this.accountId,'ACCOUNT_CHANGED');
    store?.assertAccount(this.accountId);
    if (event.channel !== "COMMENT_NOTIFICATION") return null;
    const observation = await loadObservationMapping(this.root);
    return (
      observation?.works.find((work) => work.id === event.videoId)?.url ??
      (store?.db.prepare("SELECT name FROM sqlite_master WHERE name='discovered_works'").get()?
        (store.db.prepare("SELECT url FROM discovered_works WHERE id=? AND own_id=? AND state='INCLUDED'").get(event.videoId,observation?.self.uid) as {url:string}|undefined)?.url:null)??null
    );
  }
  identity(channel: Channel): CapabilityIdentity | null {
    return this.recoveringLogin?null:this.currentIdentity.get(channel) ?? null;
  }
  private attachOwner(owner: BrowserProfileOwner): void {
    this.owner = owner;
    this.safety?.attach(owner,this.epoch,this.mode);
    owner.context.once("close", () => {
      if (this.owner !== owner) return;
      this.safety?.release(owner);
      this.owner = undefined;
      this.collector?.dispose();this.collector=undefined;
      this.epoch++;
      this.state = "CLOSED";
      this.currentIdentity.clear();
      this.closing = owner.close().finally(() => { this.closing = undefined; });
    });
  }
  async open(_legacyMode: "headed" | "headless" = 'headless', signal?:AbortSignal, entry?:string): Promise<void> {
    requireSafe(!this.manualRecoveryActive,'MANUAL_RECOVERY_IN_PROGRESS');
    requireSafe(!this.recoveringLogin,'LOGIN_RECOVERY_IN_PROGRESS');
    await this.openMode('headless',signal,false,entry);
  }
  async verifyManualCheck(){
    const safety=this.safety,epoch=this.epoch;
    requireSafe(safety,'BROWSER_STORE_REQUIRED');
    for(const channel of channels)safety.check(channel);
    const mapping=await loadMapping(this.root);
    requireSafe(this.epoch===epoch&&this.safety===safety&&!this.closeRequests,'BROWSER_CLOSED');
    await this.open('headless',undefined,mapping.origin);
    const owner=this.owner;requireSafe(owner,'BROWSER_CLOSED');
    await safety.verifyManualCheck(owner,mapping,()=>requireSafe(
      this.owner===owner&&this.epoch===epoch&&this.safety===safety&&!this.closeRequests&&!this.loginRecovery,'BROWSER_CLOSED'));
    return {browserVersion:owner.version(),mode:this.mode,proofDigest:digest(mapping)};
  }
  private async openMode(mode:'headed'|'headless',signal?:AbortSignal,restoreHeld=false,entry?:string):Promise<void>{
    requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
    requireSafe(!this.closeRequests,'BROWSER_CLOSED');
    if (this.closing) await this.closing;
    requireSafe(!this.closeRequests,'BROWSER_CLOSED');
    if (this.opening) {
      await this.opening;
      requireSafe(this.mode === mode, "CLOSE_BROWSER_BEFORE_MODE_CHANGE");
      return;
    }
    requireSafe(
      !this.owner || this.mode === mode,
      "CLOSE_BROWSER_BEFORE_MODE_CHANGE",
    );
    if (this.owner) return;
    const opening = this.launchOwner(mode,signal,restoreHeld,entry);
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }
  async beginLoginRecovery(autoFinish=true,signal?:AbortSignal,check?:()=>void,useAccountHome=false):Promise<void>{
    requireSafe(!this.manualRecoveryActive,'MANUAL_RECOVERY_IN_PROGRESS');
    check?.();
    const previous={owner:this.owner,mode:this.mode,recovering:this.recoveringLogin,autoFinish:this.autoFinishLogin};
    const generation=++this.loginGeneration;
    this.recoveringLogin=true;
    this.autoFinishLogin=autoFinish;
    try{
      await this.changeMode('headed',signal,check,useAccountHome?accountHome:undefined);
    }catch(error){
      if(this.loginGeneration===generation&&(this.owner===previous.owner&&this.mode===previous.mode||!this.owner)){
        this.recoveringLogin=previous.recovering;
        this.autoFinishLogin=previous.autoFinish;
        if(!this.owner)this.mode=previous.mode;
      }
      throw error;
    }
  }
  async openStoredMessage(store:EventStore,eventId:string,beforeOpen:()=>Promise<AbortSignal>,permitted:()=>void):Promise<{opened:true;located:boolean}>{
    permitted();
    store.assertAccount(this.accountId);
    const binding=this.safety;
    requireSafe(binding?.store===store&&!this.closeRequests&&!this.closing,'MESSAGE_VIEW_CANCELLED');
    const request=++this.latestViewRequest;this.viewRequests.add(request);
    const current=()=>{
      permitted();
      requireSafe(this.safety===binding&&request===this.latestViewRequest&&!this.closeRequests&&!this.closing,'MESSAGE_VIEW_CANCELLED');
    };
    try{
    const resolved=resolveStoredDmMessage(store,eventId),mapping=await loadObservationMapping(this.root);
    current();requireSafe(mapping&&mapping.self.uid===resolved.ownId,'ACCOUNT_CHANGED');
    binding.check('DIRECT_MESSAGE');
    const signal=AbortSignal.any([await beforeOpen(),AbortSignal.timeout(30_000)]);
    const active=()=>{current();requireSafe(!signal.aborted,'MESSAGE_VIEW_CANCELLED');binding.check('DIRECT_MESSAGE');};
    active();const generation=this.loginGeneration+1;
    try{await this.beginLoginRecovery(false,signal,active);}catch(error){
      if(this.loginGeneration!==generation)requireSafe(false,'MESSAGE_VIEW_CANCELLED');
      if(signal.aborted){permitted();requireSafe(false,'MESSAGE_VIEW_CANCELLED');}
      throw error;
    }
    const owner=this.owner,epoch=this.epoch;
    const check=()=>{active();requireSafe(this.owner===owner&&this.epoch===epoch&&this.loginGeneration===generation&&
      this.recoveringLogin&&!this.autoFinishLogin&&this.mode==='headed','MESSAGE_VIEW_CANCELLED');};
    check();requireSafe(owner,'BROWSER_NOT_RUNNING');
    return await owner.actor.run(async()=>{check();requireSafe(digest(resolveStoredDmMessage(store,eventId))===digest(resolved),'MESSAGE_PREVIEW_UNAVAILABLE');
      return locateStoredDmMessage({store,eventId,page:owner.dm,mapping,signal,check});});
    }finally{this.viewRequests.delete(request);}
  }
  async finishLoginRecovery(generation=this.loginGeneration):Promise<boolean>{
    if(generation!==this.loginGeneration)return false;
    await this.changeMode('headless');
    if(generation!==this.loginGeneration)return false;
    for(const channel of ['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as const)await this.readIdentity(channel);
    if(generation!==this.loginGeneration)return false;
    this.recoveringLogin=false;
    this.autoFinishLogin=true;
    return true;
  }
  async completeLoginIfVerified(ownId:string):Promise<boolean>{
    if(!this.recoveringLogin||this.modeTransition)return false;
    if(!this.autoFinishLogin&&this.owner&&this.mode==='headed')return false;
    const generation=this.loginGeneration;
    if(!this.owner)await this.changeMode('headless');
    if(generation!==this.loginGeneration||!this.owner)return false;
    if(this.mode==='headless')this.autoFinishLogin=true;
    const owner=this.owner,observation=await loadObservationMapping(this.root);
    if(!observation||observation.self.uid!==ownId)return false;
    await owner.actor.run(async()=>{
      requireSafe(this.owner===owner,'BROWSER_CLOSED');
      for(const page of [owner.notification,owner.dm])await new ObservedReader(page,observation,undefined,undefined,this.accountId).guard();
    });
    return this.finishLoginRecovery(generation);
  }
  async verifyEmergencyRecovery(ownId:string,signal:AbortSignal,check:()=>void,complete:()=>void=()=>{}):Promise<void>{
    let owner=this.owner;
    const epoch=this.epoch,safety=this.safety,locations=this.recoveryLocations;
    const active=()=>{
      check();requireSafe(!signal.aborted,'EMERGENCY_RECOVERY_CANCELLED');
      requireSafe(!this.closeRequests&&!this.closing&&this.epoch===epoch&&this.safety===safety&&
        (!owner||this.owner===owner),'BROWSER_CLOSED');
      requireSafe(!this.loginRecovery&&this.mode==='headless','EMERGENCY_RECOVERY_HEADLESS_REQUIRED');
    };
    active();
    const revisions=safety&&channels.map(channel=>securityRevision(safety.store,channel));
    await this.open('headless',signal);active();
    owner=this.owner;requireSafe(owner,'BROWSER_NOT_RUNNING');
    const request=this.securityRecoveryRequest(signal,active);
    requireSafe(!safety||channels.every((channel,i)=>securityRevision(safety.store,channel)===revisions?.[i]),'SECURITY_RECOVERY_CHANGED');
    const observation=await loadObservationMapping(this.root),mapping=observation?null:await loadMapping(this.root);
    const [commentReply,dmReply]=await Promise.all([loadCommentReplyMapping(this.root),loadDmReplyMapping(this.root)]);
    active();requireSafe((observation?.self.uid??mapping?.ownId)===ownId,'ACCOUNT_CHANGED');
    await locations.restore(owner,signal,true);active();
    if(safety)for(const item of request){
      item.check();
      requireSafe(await safety.recover(owner,item.channel,signal,true,false,false,item.check),'SECURITY_RECOVERY_NOT_VERIFIED');
    }
    await owner.actor.run(async()=>{
      active();await locations.capture(owner,true);active();
      await verifyEmergencyPages(owner,{observation,mapping,commentReply,dmReply,ownId,signal,accountId:this.accountId,active});
      const finish=()=>{
        active();
        if(safety)for(const item of request){
          item.check();
          if(item.hold)requireSafe(resolveSecurityHold(safety.store,item.channel,item.hold.revision,undefined,item.check),'SECURITY_RECOVERY_CHANGED');
        }
        complete();
      };
      if(safety)safety.store.db.transaction(finish).immediate();else finish();
      await locations.clear().catch(()=>{});
    });
  }
  private async changeMode(mode:'headed'|'headless',signal?:AbortSignal,check?:()=>void,entry?:string):Promise<void>{
    if(this.modeTransition)await this.modeTransition.catch(()=>{});
    const task=(async()=>{
      check?.();
      if(this.opening)await this.opening;
      if(this.closing)await this.closing;
      check?.();
      const owner=this.owner;
      if(owner&&this.mode!==mode){
        await owner.actor.run(async()=>{
          check?.();
          requireSafe(this.owner===owner,'BROWSER_CLOSED');
          const composers=await recoveryComposerSelectors(this.root);check?.();
          for(const [channel,page] of [['COMMENT_NOTIFICATION',owner.notification],['DIRECT_MESSAGE',owner.dm]] as const){
            const {empty}=await page.evaluate(inspectRecoveryNavigation,{composers:composers[channel],nativeDmComposer:composers.nativeDmComposer});
            requireSafe(empty,'BROWSER_HAS_HUMAN_INPUT');
            check?.();
          }
          await this.recoveryLocations.capture(owner);check?.();
          requireSafe(this.owner===owner,'BROWSER_CLOSED');
          this.safety?.release(owner);this.owner=undefined;this.epoch++;this.currentIdentity.clear();this.collector?.dispose();this.collector=undefined;this.state='CLOSED';
          await owner.close();
        });
      }
      check?.();await this.openMode(mode,signal,true,entry);check?.();
    })();
    this.modeTransition=task;
    try{await task;}finally{if(this.modeTransition===task)this.modeTransition=undefined;}
  }
  private async launchOwner(mode: "headed" | "headless", signal?:AbortSignal,restoreHeld=false,entry?:string): Promise<void> {
    this.state = "STARTING";
    this.mode = mode;
    let created: BrowserProfileOwner | undefined;
    try {
      let origin = entry ?? (await loadObservationMapping(this.root))?.entryUrl;
      if (!origin) {
        try {
          origin = (await loadMapping(this.root)).origin;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          origin = "https://www.douyin.com/";
        }
      }
      const owner = await this.launch(
        join(this.root, "profile"),
        mode === "headless",
      );
      created = owner;
      requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
      this.attachOwner(owner);
      await owner.open(origin,signal);
      requireSafe(this.owner===owner,"BROWSER_CLOSED");
      if(!entry){
        try{await this.recoveryLocations.restore(owner,signal,restoreHeld);}
        catch(error){
          if(!(error instanceof Blocked&&error.code==='BROWSER_HAS_HUMAN_INPUT'))throw error;
        }
        requireSafe(this.owner === owner, "BROWSER_CLOSED");
        for(const channel of channels)await this.refreshIdentity(channel);
      }
      requireSafe(this.owner === owner, "BROWSER_CLOSED");
      this.state = "OPEN_IDENTITY_UNVERIFIED";
    } catch (error) {
      const closed = !!created && this.owner !== created;
      if (created && this.owner === created) { this.safety?.release(created);this.owner = undefined; this.epoch++; }
      this.state = closed ? "CLOSED" : "BROWSER_START_FAILED";
      this.currentIdentity.clear();
      await created?.close();
      requireSafe(!closed, "BROWSER_CLOSED");
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closeRequests++;this.latestViewRequest++;this.viewRequests.clear();
    try{await this.closeOwner();}finally{this.closeRequests--;}
  }
  private async closeOwner():Promise<void>{
    await this.closeManualRecovery();
    if(this.modeTransition)await this.modeTransition.catch(()=>{});
    this.collector?.dispose();this.collector=undefined;
    if (this.opening) await this.opening.catch(() => {});
    if (this.closing) return this.closing;
    const owner = this.owner;
    this.owner = undefined;
    if (owner) this.epoch++;
    this.currentIdentity.clear();
    this.state = "CLOSED";
    if (owner) {
      this.closing = owner.actor.run(async() => {
        // Preserve the authorized positions before the old holder releases its Profile.
        try{await this.recoveryLocations.capture(owner);}catch{/* Closing must still release the holder. */}
        this.safety?.release(owner);
        await owner.close();
      });
      try {
        await this.closing;
      } finally {
        this.closing = undefined;
      }
    }
  }
  async adapter(e: InboundEvent, store?:EventStore, signal?:AbortSignal,options:AdapterOptions={}): Promise<AdapterHandle> {
    requireSafe(e.accountId===this.accountId,'ACCOUNT_CHANGED');
    if(store)this.bindStore(store);
    const safety=this.safety;
    safety?.check(e.channel);
    requireSafe(!this.viewRequests.size||options.readonlySignal,'LOGIN_RECOVERY_IN_PROGRESS');
    const openSignal=options.readonlySignal??signal;
    const pendingOwner=this.owner,pendingEpoch=this.epoch;
    const beforeOpen=()=>{
      requireSafe(this.epoch===pendingEpoch&&this.safety===safety&&!this.closeRequests&&
        (!pendingOwner||this.owner===pendingOwner),'BROWSER_CLOSED');
      requireSafe(!openSignal?.aborted,'COLLECTION_CANCELLED');safety?.check(e.channel);
    };
    const native =
      e.channel === "DIRECT_MESSAGE"
        ? await loadDmReplyMapping(this.root)
        : await loadCommentReplyMapping(this.root);
    beforeOpen();
    requireSafe(native||!options.nativeCommentOnly,'NATIVE_COMMENT_REPLY_MAPPING_REQUIRED');
    requireSafe(native||!options.nativeReplyOnly,'NATIVE_REPLY_MAPPING_REQUIRED');
    const mapping=native?null:await loadMapping(this.root);
    beforeOpen();await this.open(this.mode,openSignal,native?.observation.entryUrl??mapping!.origin);beforeOpen();
    const owner=this.owner,epoch=this.epoch;
    requireSafe(owner,'BROWSER_CLOSED');
    const active=()=>requireSafe(this.owner===owner&&this.epoch===epoch&&this.safety===safety&&!this.closeRequests,'BROWSER_CLOSED');
    const submit=()=>{active();requireSafe(!openSignal?.aborted,'COLLECTION_CANCELLED');requireSafe(!this.loginRecovery,'LOGIN_RECOVERY_IN_PROGRESS');};
    const page=e.channel==='DIRECT_MESSAGE'?owner.dm:owner.notification;
    const guard=<T extends AdapterHandle['adapter']>(adapter:T):T=>
      safety?.wrap(adapter,e.channel,page,active,submit)??guardBrowserAdapter(adapter,active,submit);
    if (native) {
      if(options.nativeCommentOnly)requireSafe(store?.accountOwnId(this.accountId)===native.observation.self.uid,'ACCOUNT_CHANGED');
      const expanded=structuredClone(native);
      if(store?.db.prepare("SELECT name FROM sqlite_master WHERE name='collection_targets'").get()) {
        const target=store.db.prepare("SELECT own_id,uid,sec_uid,title,conversation_id FROM collection_targets WHERE target_key=?").get(
          e.channel==='DIRECT_MESSAGE'?`dm:${e.conversationId}`:`comment:${e.videoId}:${e.commentId}`) as {
            own_id:string;uid:string;sec_uid:string;title:string;conversation_id:string|null;
          }|undefined;
        if(target) {
          requireSafe(target.own_id===native.observation.self.uid&&target.uid===e.actorId&&target.conversation_id===e.conversationId,'OBSERVATION_TARGET_IDENTITY_CONFLICT');
          if(e.channel==='DIRECT_MESSAGE')expanded.observation.peers=[{uid:target.uid,secUid:target.sec_uid,title:target.title,conversationId:e.conversationId!}];
          else {
            expanded.observation.commentAuthors=[{uid:target.uid,secUid:target.sec_uid,title:target.title}];
            if(!expanded.observation.works.some(w=>w.id===e.videoId)) {
              const work=store.db.prepare("SELECT url FROM discovered_works WHERE id=? AND own_id=? AND state='INCLUDED'").get(e.videoId,target.own_id) as {url:string}|undefined;
              requireSafe(work,'COMMENT_REPLY_SCOPE_REQUIRED');expanded.observation.works=[{id:e.videoId!,url:work.url}];
            }
          }
        }
      }
      this.currentIdentity.set(e.channel, {
        identityDigest: digest(native.observation.self.uid),
        mappingDigest: digest(native),
        browserVersion: owner.version(),
        browserMode: this.mode,
      });
      const adapter =
        e.channel === "DIRECT_MESSAGE"
          ? new ObservedDmReply(
              owner.dm,
              expanded as NonNullable<
                Awaited<ReturnType<typeof loadDmReplyMapping>>
              >,
              undefined,{...options,accountId:this.accountId,onContextChanged:({stage,...counts})=>store?.audit(`DM_CONTEXT_CHANGED_${stage}`,digest(['dm',e.conversationId,e.platformEventId]),counts),
                onReadbackDiagnostic:({stage,code,...counts})=>{
                  const safeCode=/^[A-Z_]{1,80}$/u.test(code)?code:'PRIVATE_DIAGNOSTICS';
                  store?.audit(`DM_READBACK_${stage}_${safeCode}`,digest(['dm',e.conversationId,e.platformEventId]),counts);
                }},
            )
          : new ObservedCommentReply(
              owner.notification,
              expanded as NonNullable<
                Awaited<ReturnType<typeof loadCommentReplyMapping>>
              >,
              undefined,{accountId:this.accountId,...(signal?{signal}:{}),...(options.readonlySignal?{readonlySignal:options.readonlySignal}:{}),onReadbackDiagnostic:report=>{
                const {stage,reason,responseStage,submissionFailure,guardFailure,counts}=commentReadbackAudit(report);
                store?.audit(`COMMENT_READBACK_${stage}_${reason}_GET_${responseStage}_ACK_${submissionFailure}_GUARD_${guardFailure}`,digest(['comment',e.videoId,e.commentId]),counts);
              },onQualification:({stage,code,level,...counts})=>{
                const safeCode=code&&/^COMMENT_REPLY_[A-Z_]+$/u.test(code)?code:'COMPLETE';
                store?.audit(`COMMENT_NESTED_${stage}_${safeCode}`,digest(['comment',e.videoId,e.commentId]),{
                  ...counts,level:typeof level==='number'?level:level==='OTHER'?-1:-2});
              }},
            );
      return { adapter:guard(adapter), dispose: () => adapter.dispose() };
    }
    requireSafe(mapping,'MAPPING_REQUIRED');
    this.currentIdentity.set(e.channel, {
      identityDigest: digest(mapping.ownId),
      mappingDigest: digest(mapping),
      browserVersion: owner.version(),
      browserMode: this.mode,
    });
    const adapter=new DomAdapter(
        e.channel === "DIRECT_MESSAGE" ? owner.dm : owner.notification,
        e.channel,
        mapping,
        undefined,this.accountId,
      );
    return {
      adapter:guard(adapter),
      dispose: () => adapter.dispose(),
    };
  }
  async refreshIdentity(channel: Channel): Promise<CapabilityIdentity | null> {
    if(this.recoveringLogin)return null;
    return this.readIdentity(channel);
  }
  private async readIdentity(channel:Channel):Promise<CapabilityIdentity|null>{
    const owner = this.owner,epoch=this.epoch;
    if (!owner) return null;
    const native =
      channel === "DIRECT_MESSAGE"
        ? await loadDmReplyMapping(this.root)
        : await loadCommentReplyMapping(this.root);
    let mapping:
      NonNullable<typeof native> | Awaited<ReturnType<typeof loadMapping>>;
    if (native) mapping = native;
    else {
      try {
        mapping = await loadMapping(this.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (this.owner === owner&&this.epoch===epoch) this.currentIdentity.delete(channel);
          return null;
        }
        throw error;
      }
    }
    const own = native
      ? native.observation.self.uid
      : (mapping as Awaited<ReturnType<typeof loadMapping>>).ownId;
    if (this.owner !== owner||this.epoch!==epoch) return null;
    const identity = {
      identityDigest: digest(own),
      mappingDigest: digest(mapping),
      browserVersion: owner.version(),
      browserMode: this.mode,
    };
    this.currentIdentity.set(channel, identity);
    return identity;
  }
  async observe(
    store: EventStore,
    source: ObservationSource,
    signal?:AbortSignal,
  ): Promise<ObservationResult> {
    const epochBeforeOpen=this.epoch;
    this.bindStore(store);
    const channel=source==='dm'?'DIRECT_MESSAGE':'COMMENT_NOTIFICATION';
    const safety=this.safety;
    const check=()=>{
      requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
      requireSafe(this.safety===safety&&this.epoch===epochBeforeOpen&&!this.closeRequests,'BROWSER_CLOSED');
      safety?.check(channel);
    };
    check();
    const observation=source==='notifications'?null:await loadObservationMapping(this.root);
    requireSafe(source!=='works'||observation,'OBSERVATION_MAPPING_REQUIRED');
    const mapping=observation?null:await loadMapping(this.root);
    check();await this.open('headless',signal,observation?.entryUrl??mapping!.origin);
    const owner=this.owner,epoch=this.epoch;
    requireSafe(owner,'BROWSER_CLOSED');
    const active=()=>{requireSafe(this.owner===owner&&this.epoch===epoch&&this.safety===safety,'BROWSER_CLOSED');check();};
    active();
    return owner.actor.run(async () => {
      active();
      const newEventIds:string[]=[];
      let loaded=0,unsupported=0;
      if (source !== "notifications" && observation) {
        const own=store.accountOwnId(this.accountId);
        requireSafe(own===undefined||own===observation.self.uid,'ACCOUNT_CHANGED');
        const reader = new ObservedReader(
          source === "dm" ? owner.dm : owner.notification,
          observation,
          undefined,signal,this.accountId,
        );
        const count =
          source === "dm" ? observation.peers.length : observation.works.length;
        for (let i = 0; i < count; i++) {
          active();
          const batch =
            source === "dm" ? await reader.dm(i) : await reader.comments(i);
          active();
          const evidence = await recordEvidence(join(this.root, "evidence"), {
            caseId: source === "dm" ? "D01" : "N01",
            browserVersion: owner.version(),
            mode: this.mode,
            taskId: null,
            action: "OBSERVE",
            result: "UNVERIFIED",
            source: "AUTOMATED_REAL",
            diagnostics: [
              "CLIENT_READ_ONLY",
              source === "dm"
                ? "PERMITTED_CONVERSATION"
                : "ALLOWED_WORK_FALLBACK",
            ],
            proofDigest: digest(batch),
          });
          active();
          newEventIds.push(...store.observe(
            channel,
            source === "dm"
              ? observation.peers[i]!.conversationId
              : `work:${observation.works[i]!.id}`,
            batch.events.map((e) => ({ ...e, evidenceId: evidence })),
            observation.self.uid,
            evidence,
          ));
          loaded+=batch.loaded;unsupported+=batch.unsupported;
        }
      } else {
        requireSafe(mapping,'MAPPING_REQUIRED');
        const own=store.accountOwnId(this.accountId);
        requireSafe(own===undefined||own===mapping.ownId,'ACCOUNT_CHANGED');
        const adapter = new DomAdapter(
          source === "dm" ? owner.dm : owner.notification,
          channel,
          mapping,
          undefined,this.accountId,
        );
        if (source === "notifications") {
          const batch = await adapter.observeNotifications();
          active();
          newEventIds.push(...store.observe(
            channel,
            "notifications",
            batch.events,
            mapping.ownId,
            batch.evidenceId,
          ));
        } else
          for (const conversation of await adapter.conversations()) {
            active();
            const batch = await adapter.observeDm(
              conversation.id,
              conversation.peerId,
            );
            active();
            newEventIds.push(...store.observe(
              channel,
              conversation.id,
              batch.events,
              mapping.ownId,
              batch.evidenceId,
            ));
          }
      }
      active();
      this.state = "OPEN_LAST_READ_VERIFIED";
      return source!=='notifications'&&observation
        ? {newEventIds,loaded,unsupported,sendsEnabled:false as const} : {newEventIds};
    }).catch(async error => {
      requireSafe(this.owner === owner, "BROWSER_CLOSED");
      if(safety)return safety.failure(channel,source==='dm'?owner.dm:owner.notification,error);
      throw error;
    });
  }
  async collect(data:AutomationStore,source:CollectionSource,signal:AbortSignal):Promise<void> {
    requireSafe(!signal.aborted&&!data.state().emergencyStopped,'COLLECTION_CANCELLED');
    this.bindStore(data.store);
    const channel=source==='dm'?'DIRECT_MESSAGE':'COMMENT_NOTIFICATION';
    const safety=this.safety,locations=this.recoveryLocations;
    safety?.check(channel);
    await this.open(this.mode,signal);
    requireSafe(!signal.aborted&&!data.state().emergencyStopped,'COLLECTION_CANCELLED');
    const owner=this.owner,epoch=this.epoch,mapping=await loadObservationMapping(this.root);
    requireSafe(owner&&this.owner===owner&&this.epoch===epoch&&this.safety===safety,'BROWSER_CLOSED');
    safety?.check(channel);
    requireSafe(mapping,'OBSERVATION_MAPPING_REQUIRED');
    const key=digest(mapping);
    if(!this.collector||this.collectorMapping!==key) {
      this.collector?.dispose();this.collector=new InboxCollector(owner,mapping,data,this.root,this.mode);this.collectorMapping=key;
    }
    if(source==='dm'&&this.previewHint){const hint=this.previewHint;this.previewHint=undefined;this.collector.prioritize(hint.ownId,hint.conversationId,hint.eventId,'SELECTION');}
    await this.collector.collect(source,signal,async error=>{
      if(this.owner!==owner||this.epoch!==epoch)return;
      try{await safety?.failure(channel,channel==='DIRECT_MESSAGE'?owner.dm:owner.notification,error);}catch{}
      if(this.owner===owner&&this.epoch===epoch)await locations.captureFault(owner,channel);
    });
    requireSafe(this.owner===owner,'BROWSER_CLOSED');
  }
  prioritizePreview(data:AutomationStore,event:InboundEvent,eventId?:string):void {
    if(data.accountId!==this.accountId||event.accountId!==this.accountId)return;
    const state=data.state(),collection=state.collection;
    if(state.emergencyStopped||!collection?.inbox||event.channel!=='DIRECT_MESSAGE'||!event.conversationId||
      event.observationIssue!=='DM_CONTENT_UNVERIFIED'||!['IMAGE','MIXED'].includes(event.contentType??''))return;
    const ownId=data.store.accountOwnId(this.accountId);
    const peer=data.store.db.prepare('SELECT own_id FROM discovered_conversations WHERE id=?').get(event.conversationId) as {own_id:string}|undefined;
    if(ownId!==collection.ownId||peer?.own_id!==collection.ownId||
      new MessagePreviewStore(this.root).list(event,collection.ownId).some(item=>item.state==='READY'))return;
    if(this.collector)this.collector.prioritize(collection.ownId,event.conversationId,eventId,'SELECTION');
    else this.previewHint={ownId:collection.ownId,conversationId:event.conversationId,...(eventId?{eventId}:{})};
  }
  prioritizeDisplayPreview(data:AutomationStore,event:InboundEvent,target:PreviewDisplayTarget):boolean {
    if(data.accountId!==this.accountId||event.accountId!==this.accountId)return false;
    const state=data.state(),collection=state.collection;
    if(state.emergencyStopped||!collection?.inbox||!event.conversationId||this.previewHint)return false;
    data.requireAccount(collection.ownId);
    if(this.collector)return this.collector.prioritize(collection.ownId,event.conversationId,target,'SELECTION');
    this.previewHint={ownId:collection.ownId,conversationId:event.conversationId,eventId:target};return true;
  }
  async verifyExisting(
    store: EventStore,
    eventId: string,
    options:VerificationOptions={},
  ): Promise<VerificationResult> {
    this.bindStore(store);
    const safety=this.safety;
    requireSafe(!options.signal?.aborted,'COLLECTION_CANCELLED');
    const event = store.event(eventId),
      draft = store.db
        .prepare("SELECT id FROM reply_drafts WHERE event_id=?")
        .get(eventId) as { id: string } | undefined;
    const intent = store.db
      .prepare("SELECT id FROM send_intents WHERE event_id=?")
      .get(eventId) as { id: string } | undefined;
    safety?.check(event.payload.channel);
    const nativeCommentOnly=options.commentDraftId!==undefined;
    if(nativeCommentOnly){
      requireSafe(event.payload.channel==='COMMENT_NOTIFICATION'&&draft?.id===options.commentDraftId,'COMMENT_REPLY_SCOPE_REQUIRED');
      const native=await loadCommentReplyMapping(this.root);
      requireSafe(this.safety===safety,'BROWSER_CLOSED');
      requireSafe(native,'NATIVE_COMMENT_REPLY_MAPPING_REQUIRED');
    }
    requireSafe(draft && intent, nativeCommentOnly?'COMMENT_REPLY_INTENT_REQUIRED':'INTENT_REQUIRED');
    const savedApproval=store.draft(draft.id).approval;
    const manualMedia=!nativeCommentOnly&&!!savedApproval?.snapshot.manualObservation&&
      !!store.db.prepare(`SELECT c.command_id FROM manual_send_commands c JOIN manual_send_inputs h ON h.command_id=c.command_id
        JOIN draft_revisions r ON r.draft_id=? AND r.version=? WHERE c.intent_id=? AND c.event_id=? AND r.origin='HUMAN_TYPED'
        AND NOT EXISTS(SELECT 1 FROM policy_commands p WHERE p.command_id=c.command_id)`).get(draft.id,store.draft(draft.id).version,intent.id,eventId);
    const handle = await this.adapter(event.payload,store,undefined,{manualMedia,nativeCommentOnly,...(options.signal?{readonlySignal:options.signal}:{})});
    try {
      const owner=this.owner,epoch=this.epoch;
      requireSafe(owner,'BROWSER_CLOSED');
      const proof = await owner.actor.run(async () => {
        requireSafe(!options.signal?.aborted,'COLLECTION_CANCELLED');
        const current = store.draft(draft.id);
        const retry=nativeCommentOnly?(store.stats().manualRetries as {retryId:string;eventId:string}[]).find(r=>r.eventId===eventId):undefined;
        const boundary=retry?store.commentRetryBoundary(retry.retryId):store.intentBoundary(intent.id);
        return readExistingReply(handle.adapter, event.payload, current.text, boundary,
          current.approval?.snapshot.contextDigest);
      },options.background?'background':'interactive');
      requireSafe(!options.signal?.aborted,'VERIFICATION_CANCELLED');
      requireSafe(this.owner===owner&&this.epoch===epoch,'BROWSER_CLOSED');
      safety?.check(event.payload.channel);
      const evidenceId = await recordEvidence(join(this.root, "evidence"), {
        caseId: event.payload.channel === "DIRECT_MESSAGE" ? "D05" : "C05",
        browserVersion: owner.version(),
        mode: this.mode,
        taskId: eventId,
        action: "OBSERVE",
        result: proof ? "PASS" : "BLOCKED",
        source: "AUTOMATED_REAL",
        diagnostics: ["CLIENT_READ_ONLY_RECHECK", "ORIGINAL_RECEIPTS_RETAINED"],
        proofDigest: proof ? digest(proof) : null,
      });
      return { verified: !!proof, evidenceId,...(proof?{nativeIdDigest:digest(proof.id)}:{}) };
    } finally {
      await handle.dispose();
    }
  }
  async verifyExistingFollowup(
    store: EventStore,
    commandId: string,
    options: VerificationOptions = {},
  ): Promise<FollowupVerificationResult> {
    store.assertAccount(this.accountId);
    return verifyFollowupInBrowser(this, store, commandId, options);
  }
}
