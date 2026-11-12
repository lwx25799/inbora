import { join } from "node:path";
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
  digest,
  requireSafe,
  type Channel,
  type InboundEvent,
  type ReplyAdapter,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { recordEvidence } from "../observability/evidence.js";
import type { CapabilityIdentity } from "./authority.js";
import { InboxCollector } from "./inbox-collector.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type { CollectionSource } from "./collection-scheduler.js";
import {MessagePreviewStore} from '../storage/message-previews.js';
import type {PreviewDisplayTarget} from './media-preview-request.js';
import {resolveStoredDmMessage,locateStoredDmMessage} from './message-view.js';

export interface AdapterHandle {
  adapter: ReplyAdapter;
  dispose(): void;
}
export class BrowserService {
  isIdle():boolean {return !this.owner||this.owner.actor.idle;}
  private owner: BrowserProfileOwner | undefined;
  private mode: "headed" | "headless" = "headless";
  private currentIdentity = new Map<Channel, CapabilityIdentity>();
  private state = "CLOSED";
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private epoch = 0;
  private collector: InboxCollector | undefined;
  private collectorMapping = "";
  private previewHint:{ownId:string;conversationId:string;eventId?:string|PreviewDisplayTarget}|undefined;
  private recoveringLogin=false;
  private autoFinishLogin=true;
  private loginGeneration=0;
  private modeTransition:Promise<void>|undefined;
  private viewRequests=0;
  private latestViewRequest=0;
  get loginRecovery(){return this.recoveringLogin||this.viewRequests>0;}
  get ownerEpoch() { return this.epoch; }
  constructor(
    readonly root: string,
    private readonly launch = BrowserProfileOwner.launch,
  ) {}
  static adopt(
    root: string,
    owner: BrowserProfileOwner,
    mode: "headed" | "headless",
  ): BrowserService {
    const service = new BrowserService(root);
    service.attachOwner(owner);
    service.mode = mode;
    service.state = "OPEN_IDENTITY_UNVERIFIED";
    return service;
  }
  get actor() {
    requireSafe(this.owner, "BROWSER_NOT_RUNNING");
    return this.owner.actor;
  }
  status():{state:string;mode:'headed'|'headless';loginRecovery?:boolean;version:string|null} {
    return {
      state: this.recoveringLogin?this.autoFinishLogin?'LOGIN_RECOVERY':this.owner&&this.mode==='headed'?'MANUAL_VISIBLE':'MANUAL_VISIBLE_PENDING':this.state,
      mode: this.mode,
      loginRecovery:this.recoveringLogin,
      version: this.owner?.version() ?? null,
    };
  }
  async workUrl(event: InboundEvent, store?:EventStore): Promise<string | null> {
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
    owner.context.once("close", () => {
      if (this.owner !== owner) return;
      this.owner = undefined;
      this.collector?.dispose();this.collector=undefined;
      this.epoch++;
      this.state = "CLOSED";
      this.currentIdentity.clear();
      this.closing = owner.close().finally(() => { this.closing = undefined; });
    });
  }
  async open(_legacyMode: "headed" | "headless" = 'headless', signal?:AbortSignal): Promise<void> {
    requireSafe(!this.recoveringLogin,'LOGIN_RECOVERY_IN_PROGRESS');
    await this.openMode('headless',signal);
  }
  private async openMode(mode:'headed'|'headless',signal?:AbortSignal):Promise<void>{
    requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
    if (this.closing) await this.closing;
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
    const opening = this.launchOwner(mode,signal);
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }
  async beginLoginRecovery(autoFinish=true,signal?:AbortSignal,check?:()=>void):Promise<void>{
    check?.();
    this.loginGeneration++;
    this.recoveringLogin=true;
    this.autoFinishLogin=autoFinish;
    await this.changeMode('headed',signal,check);
  }
  async openStoredMessage(store:EventStore,eventId:string,beforeOpen:()=>Promise<AbortSignal>,permitted:()=>void):Promise<{opened:true;located:boolean}>{
    permitted();
    const resolved=resolveStoredDmMessage(store,eventId),mapping=await loadObservationMapping(this.root);
    requireSafe(mapping&&mapping.self.uid===resolved.ownId,'ACCOUNT_CHANGED');
    permitted();const request=++this.latestViewRequest;this.viewRequests++;
    try{
    const signal=AbortSignal.any([await beforeOpen(),AbortSignal.timeout(30_000)]),active=()=>{permitted();requireSafe(!signal.aborted&&request===this.latestViewRequest,'MESSAGE_VIEW_CANCELLED');};
    active();const previous={owner:this.owner,mode:this.mode,recovering:this.recoveringLogin,autoFinish:this.autoFinishLogin},generation=this.loginGeneration+1;
    try{await this.beginLoginRecovery(false,signal,active);}catch(error){
      if(this.loginGeneration===generation&&this.owner===previous.owner&&this.mode===previous.mode){this.recoveringLogin=previous.recovering;this.autoFinishLogin=previous.autoFinish;}
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
    }finally{this.viewRequests--;}
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
    if(!this.autoFinishLogin&&this.owner)return false;
    const generation=this.loginGeneration;
    if(!this.owner)await this.changeMode('headless');
    if(generation!==this.loginGeneration||!this.owner)return false;
    const owner=this.owner,observation=await loadObservationMapping(this.root);
    if(!observation||observation.self.uid!==ownId)return false;
    await owner.actor.run(async()=>{
      requireSafe(this.owner===owner,'BROWSER_CLOSED');
      for(const page of [owner.notification,owner.dm])await new ObservedReader(page,observation).guard();
    });
    return this.finishLoginRecovery(generation);
  }
  async verifyEmergencyRecovery(ownId:string,signal:AbortSignal,check:()=>void,complete:()=>void=()=>{}):Promise<void>{
    const active=()=>{
      check();requireSafe(!signal.aborted,'EMERGENCY_RECOVERY_CANCELLED');
      requireSafe(!this.loginRecovery&&this.mode==='headless','EMERGENCY_RECOVERY_HEADLESS_REQUIRED');
    };
    active();await this.open('headless',signal);active();
    const owner=this.owner,epoch=this.epoch;requireSafe(owner,'BROWSER_NOT_RUNNING');
    const observation=await loadObservationMapping(this.root),mapping=observation?null:await loadMapping(this.root);
    const [commentReply,dmReply]=await Promise.all([loadCommentReplyMapping(this.root),loadDmReplyMapping(this.root)]);
    active();requireSafe((observation?.self.uid??mapping?.ownId)===ownId,'ACCOUNT_CHANGED');
    await owner.actor.run(async()=>{
      for(const [channel,page] of [['COMMENT_NOTIFICATION',owner.notification],['DIRECT_MESSAGE',owner.dm]] as const){
        active();requireSafe(this.owner===owner&&this.epoch===epoch,'BROWSER_CLOSED');
        try{
          if(observation)await new ObservedReader(page,observation,undefined,signal).guard();
          else await new DomAdapter(page,channel,mapping!).guard();
          const reply=channel==='DIRECT_MESSAGE'?dmReply:commentReply;
          if(reply){
            requireSafe(reply.observation.self.uid===ownId&&(!observation||reply.observation.self.secUid===observation.self.secUid),'ACCOUNT_CHANGED');
            for(const selector of [reply.blockers,reply.observation.securityBlockers])
              for(const node of await page.locator(selector).all())requireSafe(!await node.isVisible(),'OBSERVATION_SECURITY_COMPONENT');
          }
        }catch(error){
          if(error instanceof Error&&error.name==='TimeoutError')requireSafe(false,'ACCOUNT_NOT_VERIFIED');
          throw error;
        }
        active();requireSafe(this.owner===owner&&this.epoch===epoch,'BROWSER_CLOSED');
      }
      active();complete();
    });
  }
  private async changeMode(mode:'headed'|'headless',signal?:AbortSignal,check?:()=>void):Promise<void>{
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
          for(const page of [owner.notification,owner.dm]){
            const empty=await page.locator('[contenteditable="true"],textarea,input').evaluateAll(editors=>{
              for(const editor of editors){
                const style=getComputedStyle(editor),rect=editor.getBoundingClientRect();
                if(style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0)continue;
                if(editor instanceof HTMLInputElement&&!['text','search','email','url','tel','password'].includes(editor.type))continue;
                const text=editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement?editor.value:editor.textContent??'';
                if(editor.querySelector('img,video,audio,iframe,object,input,[data-slate-void="true"],[data-attachment]'))return false;
                const marker=editor.matches('[data-slate-editor="true"][data-zone-container="*"]')&&editor.children.length===1&&
                  editor.firstElementChild?.matches('div.ace-line[data-node="true"]')&&editor.firstElementChild.children.length===1&&
                  editor.firstElementChild.firstElementChild?.matches('span[data-enter="true"][data-string="true"][data-leaf="true"]')&&text==='\u200B';
                if(text.length&&!marker)return false;
                for(const node of editor.querySelectorAll('*'))if(!['DIV','P','SPAN','BR','B','I','EM','STRONG','U','S'].includes(node.tagName))return false;
              }
              return true;
            });
            requireSafe(empty,'BROWSER_HAS_HUMAN_INPUT');
            check?.();
          }
          this.owner=undefined;this.epoch++;this.currentIdentity.clear();this.collector?.dispose();this.collector=undefined;this.state='CLOSED';
          await owner.close();
        });
      }
      check?.();await this.openMode(mode,signal);check?.();
    })();
    this.modeTransition=task;
    try{await task;}finally{if(this.modeTransition===task)this.modeTransition=undefined;}
  }
  private async launchOwner(mode: "headed" | "headless", signal?:AbortSignal): Promise<void> {
    this.state = "STARTING";
    this.mode = mode;
    let created: BrowserProfileOwner | undefined;
    try {
      const observation = await loadObservationMapping(this.root);
      let origin = observation?.entryUrl;
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
      requireSafe(this.owner === owner, "BROWSER_CLOSED");
      for (const channel of ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as const)
        await this.refreshIdentity(channel);
      requireSafe(this.owner === owner, "BROWSER_CLOSED");
      this.state = "OPEN_IDENTITY_UNVERIFIED";
    } catch (error) {
      const closed = !!created && this.owner !== created;
      if (created && this.owner === created) { this.owner = undefined; this.epoch++; }
      this.state = closed ? "CLOSED" : "BROWSER_START_FAILED";
      this.currentIdentity.clear();
      await created?.close();
      requireSafe(!closed, "BROWSER_CLOSED");
      throw error;
    }
  }
  async close(): Promise<void> {
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
      this.closing = owner.actor.run(() => owner.close());
      try {
        await this.closing;
      } finally {
        this.closing = undefined;
      }
    }
  }
  async adapter(e: InboundEvent, store?:EventStore, signal?:AbortSignal,options:{manualMedia?:boolean;readonlySignal?:AbortSignal}={}): Promise<AdapterHandle> {
    requireSafe(!this.viewRequests||options.readonlySignal,'LOGIN_RECOVERY_IN_PROGRESS');
    await this.open(this.mode,signal);
    const owner = this.owner!;
    const native =
      e.channel === "DIRECT_MESSAGE"
        ? await loadDmReplyMapping(this.root)
        : await loadCommentReplyMapping(this.root);
    if (native) {
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
              undefined,{...options,onContextChanged:({stage,...counts})=>store?.audit(`DM_CONTEXT_CHANGED_${stage}`,digest(['dm',e.conversationId,e.platformEventId]),counts),
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
              undefined,{...(signal?{signal}:{}),...(options.readonlySignal?{readonlySignal:options.readonlySignal}:{}),onReadbackDiagnostic:report=>{
                const {stage,reason,responseStage,submissionFailure,guardFailure,counts}=commentReadbackAudit(report);
                store?.audit(`COMMENT_READBACK_${stage}_${reason}_GET_${responseStage}_ACK_${submissionFailure}_GUARD_${guardFailure}`,digest(['comment',e.videoId,e.commentId]),counts);
              },onQualification:({stage,code,level,...counts})=>{
                const safeCode=code&&/^COMMENT_REPLY_[A-Z_]+$/u.test(code)?code:'COMPLETE';
                store?.audit(`COMMENT_NESTED_${stage}_${safeCode}`,digest(['comment',e.videoId,e.commentId]),{
                  ...counts,level:typeof level==='number'?level:level==='OTHER'?-1:-2});
              }},
            );
      return { adapter, dispose: () => adapter.dispose() };
    }
    const mapping = await loadMapping(this.root);
    this.currentIdentity.set(e.channel, {
      identityDigest: digest(mapping.ownId),
      mappingDigest: digest(mapping),
      browserVersion: owner.version(),
      browserMode: this.mode,
    });
    return {
      adapter: new DomAdapter(
        e.channel === "DIRECT_MESSAGE" ? owner.dm : owner.notification,
        e.channel,
        mapping,
      ),
      dispose: () => {},
    };
  }
  async refreshIdentity(channel: Channel): Promise<CapabilityIdentity | null> {
    if(this.recoveringLogin)return null;
    return this.readIdentity(channel);
  }
  private async readIdentity(channel:Channel):Promise<CapabilityIdentity|null>{
    const owner = this.owner;
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
          if (this.owner === owner) this.currentIdentity.delete(channel);
          return null;
        }
        throw error;
      }
    }
    const own = native
      ? native.observation.self.uid
      : (mapping as Awaited<ReturnType<typeof loadMapping>>).ownId;
    if (this.owner !== owner) return null;
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
    source: "notifications" | "works" | "dm",
    signal?:AbortSignal,
  ): Promise<void> {
    requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
    await this.open('headless',signal);
    const owner = this.owner!,
      observation = await loadObservationMapping(this.root);
    await owner.actor.run(async () => {
      requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
      if (source !== "notifications" && observation) {
        const reader = new ObservedReader(
          source === "dm" ? owner.dm : owner.notification,
          observation,
          undefined,signal,
        );
        const count =
          source === "dm" ? observation.peers.length : observation.works.length;
        for (let i = 0; i < count; i++) {
          requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
          const batch =
            source === "dm" ? await reader.dm(i) : await reader.comments(i);
          requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
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
          requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
          store.observe(
            source === "dm" ? "DIRECT_MESSAGE" : "COMMENT_NOTIFICATION",
            source === "dm"
              ? observation.peers[i]!.conversationId
              : `work:${observation.works[i]!.id}`,
            batch.events.map((e) => ({ ...e, evidenceId: evidence })),
            observation.self.uid,
            evidence,
          );
        }
      } else {
        requireSafe(source !== "works", "OBSERVATION_MAPPING_REQUIRED");
        const mapping = await loadMapping(this.root),
          channel = source === "dm" ? "DIRECT_MESSAGE" : "COMMENT_NOTIFICATION";
        const adapter = new DomAdapter(
          source === "dm" ? owner.dm : owner.notification,
          channel,
          mapping,
        );
        if (source === "notifications") {
          const batch = await adapter.observeNotifications();
          requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
          store.observe(
            channel,
            "notifications",
            batch.events,
            mapping.ownId,
            batch.evidenceId,
          );
        } else
          for (const conversation of await adapter.conversations()) {
            requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
            const batch = await adapter.observeDm(
              conversation.id,
              conversation.peerId,
            );
            requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
            store.observe(
              channel,
              conversation.id,
              batch.events,
              mapping.ownId,
              batch.evidenceId,
            );
          }
      }
      requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
      requireSafe(this.owner === owner, "BROWSER_CLOSED");
      for (const channel of ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as const)
        await this.refreshIdentity(channel);
      requireSafe(this.owner === owner, "BROWSER_CLOSED");
      this.state = "OPEN_LAST_READ_VERIFIED";
    }).catch(error => {
      requireSafe(this.owner === owner, "BROWSER_CLOSED");
      throw error;
    });
  }
  async collect(data:AutomationStore,source:CollectionSource,signal:AbortSignal):Promise<void> {
    requireSafe(!signal.aborted&&!data.state().emergencyStopped,'COLLECTION_CANCELLED');
    await this.open(this.mode,signal);
    requireSafe(!signal.aborted&&!data.state().emergencyStopped,'COLLECTION_CANCELLED');
    const owner=this.owner!,mapping=await loadObservationMapping(this.root);
    requireSafe(mapping,'OBSERVATION_MAPPING_REQUIRED');
    const key=digest(mapping);
    if(!this.collector||this.collectorMapping!==key) {
      this.collector?.dispose();this.collector=new InboxCollector(owner,mapping,data,this.root,this.mode);this.collectorMapping=key;
    }
    if(source==='dm'&&this.previewHint){const hint=this.previewHint;this.previewHint=undefined;this.collector.prioritize(hint.ownId,hint.conversationId,hint.eventId,'SELECTION');}
    await this.collector.collect(source,signal);
    requireSafe(this.owner===owner,'BROWSER_CLOSED');
  }
  prioritizePreview(data:AutomationStore,event:InboundEvent,eventId?:string):void {
    const state=data.state(),collection=state.collection;
    if(state.emergencyStopped||!collection?.inbox||event.channel!=='DIRECT_MESSAGE'||!event.conversationId||
      event.observationIssue!=='DM_CONTENT_UNVERIFIED'||!['IMAGE','MIXED'].includes(event.contentType??''))return;
    const own=data.store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(event.accountId) as {own_id:string}|undefined;
    const peer=data.store.db.prepare('SELECT own_id FROM discovered_conversations WHERE id=?').get(event.conversationId) as {own_id:string}|undefined;
    if(own?.own_id!==collection.ownId||peer?.own_id!==collection.ownId||
      new MessagePreviewStore(this.root).list(event,collection.ownId).some(item=>item.state==='READY'))return;
    if(this.collector)this.collector.prioritize(collection.ownId,event.conversationId,eventId,'SELECTION');
    else this.previewHint={ownId:collection.ownId,conversationId:event.conversationId,...(eventId?{eventId}:{})};
  }
  prioritizeDisplayPreview(data:AutomationStore,event:InboundEvent,target:PreviewDisplayTarget):boolean {
    const state=data.state(),collection=state.collection;
    if(state.emergencyStopped||!collection?.inbox||!event.conversationId||this.previewHint)return false;
    data.requireAccount(collection.ownId);
    if(this.collector)return this.collector.prioritize(collection.ownId,event.conversationId,target,'SELECTION');
    this.previewHint={ownId:collection.ownId,conversationId:event.conversationId,eventId:target};return true;
  }
  async verifyExisting(
    store: EventStore,
    eventId: string,
    options:{signal?:AbortSignal;background?:boolean}={},
  ): Promise<{ verified: boolean; evidenceId: string; nativeIdDigest?:string }> {
    requireSafe(!options.signal?.aborted,'COLLECTION_CANCELLED');
    const event = store.event(eventId),
      draft = store.db
        .prepare("SELECT id FROM reply_drafts WHERE event_id=?")
        .get(eventId) as { id: string } | undefined;
    const intent = store.db
      .prepare("SELECT id FROM send_intents WHERE event_id=?")
      .get(eventId) as { id: string } | undefined;
    requireSafe(draft && intent, "INTENT_REQUIRED");
    await this.open(this.mode,options.signal);
    const owner = this.owner!;
    const savedApproval=store.draft(draft.id).approval;
    const manualMedia=!!savedApproval?.snapshot.manualObservation&&
      !!store.db.prepare(`SELECT c.command_id FROM manual_send_commands c JOIN manual_send_inputs h ON h.command_id=c.command_id
        JOIN draft_revisions r ON r.draft_id=? AND r.version=? WHERE c.intent_id=? AND c.event_id=? AND r.origin='HUMAN_TYPED'
        AND NOT EXISTS(SELECT 1 FROM policy_commands p WHERE p.command_id=c.command_id)`).get(draft.id,store.draft(draft.id).version,intent.id,eventId);
    const handle = await this.adapter(event.payload,store,undefined,{manualMedia,...(options.signal?{readonlySignal:options.signal}:{})});
    try {
      const proof = await owner.actor.run(async () => {
        requireSafe(!options.signal?.aborted,'COLLECTION_CANCELLED');
        if (handle.adapter instanceof ObservedCommentReply)
          return handle.adapter.verifyExisting(
            event.payload,
            store.draft(draft.id).text,
            store.intentBoundary(intent.id),
          );
        if (handle.adapter instanceof ObservedDmReply)
          return handle.adapter.verifyExisting(
            event.payload,
            store.draft(draft.id).text,
            store.intentBoundary(intent.id),
            store.draft(draft.id).approval?.snapshot.contextDigest,
          );
        // DM readback is read-only: refresh only the already bound empty editor, never prepare/click.
        await handle.adapter.inspect(event.payload);
        return handle.adapter.readback(
          event.payload,
          store.draft(draft.id).text,
          [],
          store.intentBoundary(intent.id),
        );
      },options.background?'background':'interactive');
      requireSafe(!options.signal?.aborted,'VERIFICATION_CANCELLED');
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
      handle.dispose();
    }
  }
}
