import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  Blocked,
  digest,
  requireSafe,
} from "../core/contracts.js";
import { SendCoordinator } from "../core/send-coordinator.js";
import type { EventStore } from "../storage/store.js";
import {
  commandSchema,
  defaultSettings,
  settingsSchema,
  type AiSettings,
  type SendParams,
  type InboxSync,
} from "./contracts.js";
import {HumanReplyWorkflow} from './human-reply-workflow.js';
import {HumanFollowups} from './human-followup.js';
import {migrateFollowups} from '../storage/followup-migration.js';
import {BrowserDraftRecovery} from './browser-draft-recovery.js';
import { WorkbenchQueries } from "./workbench-queries.js";
import {ensureQueryIndexes} from '../storage/query-indexes.js';
import {readOrRefreshPreview} from './media-preview-request.js';
import { WorkbenchAuthority } from "./authority.js";
import { BrowserService } from "./browser-service.js";
import { DeepSeekProvider } from "../ai/deepseek.js";
import { AutomationStore } from "../storage/automation-store.js";
import { migrateAutomation } from "../storage/automation-migration.js";
import { CollectionScheduler, collectionStops } from "./collection-scheduler.js";
import { VerificationScheduler } from "./verification-scheduler.js";
import { CredentialStore } from "./credentials.js";
import {runAutomaticReply} from './automatic-reply.js';
import {readDiagnostics} from './diagnostics.js';
import {markInboxRead} from './inbox-read-state.js';
import {classifyStoredShares} from './message-disposition.js';
import {EvidenceMaintenance} from './evidence-maintenance.js';
import {runtimePerformance} from '../observability/runtime-performance.js';
import {generateSuggestion} from './suggestion-generation.js';
import {migrateLocalAssistant} from '../storage/local-assistant-migration.js';
import type {ReplyPolicy} from './automation-contracts.js';
import {configureAssistantConnection} from './local-assistant-connection.js';
import {recoverEmergency} from './emergency-recovery.js';

export function clientError(error: unknown): string {
  return error instanceof Blocked
    ? error.code
    : "OPERATION_FAILED_PRIVATE_DIAGNOSTICS";
}

/** Transport-neutral application service. Short controls never wait behind browser/model operations. */
export class ClientService {
  private readonly followups:HumanFollowups;
  private readonly queries: WorkbenchQueries;
  readonly events = new EventEmitter();
  readonly authority: WorkbenchAuthority;
  private readonly humanReplies:HumanReplyWorkflow;
  private settings: AiSettings = { ...defaultSettings };
  private key = "";
  private modelAuthorized = false;
  private modelAbort = new AbortController();
  private automaticAbort = new AbortController();
  private modelPending = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private syncTask: Promise<void> | null = null;
  private syncAbort: AbortController | null = null;
  private observing = false;
  private automation: AutomationStore | null = null;
  private collector: CollectionScheduler | null = null;
  private inboxRevision = 0;
  private readonly startedAt: number;
  private dialogs=new Map<string,{token:string;generation:number}>();
  private leaseTimer:ReturnType<typeof setInterval>|undefined;
  private verification:VerificationScheduler|null=null;
  private autoTimer:ReturnType<typeof setInterval>|undefined;
  private autoTask:Promise<void>|null=null;
  private humanQueue:Promise<void>=Promise.resolve();
  private keyStored=false;
  private keyStorageError:string|null=null;
  private keyGeneration=0;
  private onlineEnabled=false;
  private onlineTask:Promise<void>|null=null;
  private onlineRetryAt=0;
  private onlineAbort=new AbortController();
  private recoveryDiagnosticPending=false;
  private readonly maintenance:EvidenceMaintenance;
  private assistantConnection={ready:false,instanceId:null as string|null,transport:'stdio' as const,tools:16 as const};
  private sync: InboxSync = {
    runId: null, running: false, cancelled: false, source: null, results: [],
  };
  constructor(
    readonly store: EventStore,
    readonly browser: BrowserService,
    private readonly provider = new DeepSeekProvider(),
    now: () => number = Date.now,
    startedAt = now(),
  ) {
    this.startedAt = startedAt;
    this.maintenance=new EvidenceMaintenance(store,browser.root);
    this.authority = new WorkbenchAuthority(store, now);
    this.authority.recover();
    this.followups=new HumanFollowups(store,this.authority,browser,()=>this.closing,()=>this.emit('send_status_updated'),clientError);
    this.humanReplies=new HumanReplyWorkflow(store,this.authority,browser,()=>this.closing,(token,id,params)=>this.deliver(token,id,params),event=>this.emit(event),clientError);
    this.queries = new WorkbenchQueries(store,this.authority,browser);
  }
  async loadSettings(): Promise<void> {
    if(!this.automation) {
      await migrateAutomation(this.store,join(this.browser.root,"backups",`automation-${randomUUID()}.sqlite`));
      await ensureQueryIndexes(this.store,join(this.browser.root,'backups',`query-indexes-${randomUUID()}.sqlite`));
      await migrateFollowups(this.store,join(this.browser.root,'backups',`human-followups-${randomUUID()}.sqlite`));
      await migrateLocalAssistant(this.store,join(this.browser.root,'backups',`local-assistant-${randomUUID()}.sqlite`));
      this.followups.recover();
      this.automation=new AutomationStore(this.store,this.authority.now);
      this.automation.initialize(this.startedAt);
      classifyStoredShares(this.store,this.browser.root);
      this.recoveryDiagnosticPending=new BrowserDraftRecovery(this.store,this.authority,this.browser).hasStartupCandidate();
      if(this.authority.mode()==='LIMITED_AUTO')this.authority.resumeIdleAutomation();
      if(!this.automation.state().emergencyStopped&&this.authority.paused()) {
        this.store.db.prepare('UPDATE client_state SET paused=0 WHERE id=1').run();
        this.store.audit('SINGLE_ACCOUNT_ONLINE_RESTORED','account_001');
      }
      this.store.db.prepare(`UPDATE automation_jobs SET state=COALESCE((SELECT status FROM send_intents WHERE event_id=automation_jobs.event_id),'REVIEW'),
        reason='RESTART_NO_REPLAY',updated_at=? WHERE state IN ('QUALIFYING','GENERATING','PREPARING','QUEUED','PREFLIGHT','SENDING')`).run(this.authority.now());
      this.collector=new CollectionScheduler(this.automation,async(source,signal,trigger)=>{
        requireSafe(trigger==='MANUAL'||!this.syncTask&&!this.observing,'COLLECTION_CANCELLED');
        this.maintenance.cancel();
        const end=runtimePerformance.start('COLLECTION',source==='dm'?'DIRECT_MESSAGE':'COMMENT_NOTIFICATION');
        try{await this.browser.collect(this.automation!,source,signal);end();}
        catch(error){end(signal.aborted?'CANCELLED':'FAILED');throw error;}
      },()=>{this.inboxRevision++;this.emit('inbox_updated');});
      this.verification=new VerificationScheduler(this.automation,(eventId,signal)=>this.browser.verifyExisting(this.store,eventId,{signal,background:true}),()=>{this.inboxRevision++;this.emit('send_status_updated');});
    }
    try {
      this.settings = settingsSchema.parse(
        JSON.parse(
          await readFile(
            join(this.browser.root, "client-settings.json"),
            "utf8",
          ),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.collector?.start();
    this.verification?.start();
    if(!this.autoTimer){this.autoTimer=setInterval(()=>this.automaticTick(),1000);this.autoTimer.unref();}
    if(!this.leaseTimer){this.leaseTimer=setInterval(()=>{
      for(const [id,dialog]of this.dialogs)try{this.authority.renew(dialog.token,id,dialog.generation);}catch{this.dialogs.delete(id);}
    },30_000);this.leaseTimer.unref();}
    const keyGeneration=this.keyGeneration;
    try{const key=await new CredentialStore(this.browser.root).load();if(key&&!this.closing&&keyGeneration===this.keyGeneration){this.key=key;this.keyStored=true;}}
    catch{this.keyStorageError='DPAPI_RESTORE_FAILED';}
  }
  startOnline():void {
    this.onlineEnabled=true;this.keepOnline();
  }
  setAssistantConnection(instanceId:string|null):void{
    this.assistantConnection={ready:instanceId!==null,instanceId,transport:'stdio',tools:16};
    this.emit('status_updated');
  }
  async assistantConnected():Promise<void>{
    const check=()=>requireSafe(!this.closing,'CLIENT_CLOSING');check();
    if(await configureAssistantConnection(this.authority.assistant,this.browser.root,'IF_NEW',check))this.emit('status_updated');
  }
  private maintainEvidence():void {
    const idle=!this.closing&&!this.autoTask&&!this.onlineTask&&!this.syncTask&&!this.observing&&!this.modelPending.size&&
      !this.pending.size&&!this.collector?.status().running&&this.browser.isIdle();
    void this.maintenance.runIfDue(idle).then(report=>{if(report)this.emit('diagnostics_updated');}).catch(()=>this.emit('diagnostics_updated'));
  }
  private automaticTick():void {
    this.keepOnline();
    if(this.autoTask){this.maintenance.cancel();return;}
    const task=this.runAutomaticReply().catch(()=>{}).finally(()=>{this.autoTask=null;});
    this.autoTask=task;this.track(task);
    // Read-only maintenance starts only after the business task has left the tracked set.
    void task.then(()=>this.maintainEvidence());
  }
  private inspectStartupRecovery():void{
    if(!this.recoveryDiagnosticPending||!this.browser.status().state.startsWith('OPEN'))return;
    this.recoveryDiagnosticPending=false;const token=this.authority.issueSession(['READ']);
    const task=new BrowserDraftRecovery(this.store,this.authority,this.browser).available(token).catch(()=>{}).finally(()=>this.authority.revoke(token));
    this.track(task);
  }
  private keepOnline():void {
    if(!this.onlineEnabled||this.closing||this.onlineTask||!this.automation||this.automation.state().emergencyStopped||
      !this.store.db.prepare("SELECT id FROM accounts WHERE id='account_001'").get()||this.authority.now()<this.onlineRetryAt)return;
    if(this.browser.loginRecovery){
      this.onlineRetryAt=this.authority.now()+30_000;
      const own=this.store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string};
      const task=this.browser.completeLoginIfVerified(own.own_id).then(done=>{if(done)this.resumeAfterLogin();})
        .catch(()=>{}).finally(()=>{this.onlineTask=null;if(!this.closing)this.emit('status_updated');});
      this.onlineTask=task;this.track(task);return;
    }
    this.inspectStartupRecovery();
    if(!['CLOSED','BROWSER_START_FAILED'].includes(this.browser.status().state))return;
    if(this.onlineAbort.signal.aborted)this.onlineAbort=new AbortController();
    const task=this.browser.open('headless',this.onlineAbort.signal).catch(error=>{
      if(this.closing||this.onlineAbort.signal.aborted)return;
      const code=clientError(error);
      this.onlineRetryAt=this.authority.now()+30_000;
      if(collectionStops.has(code)){this.automation!.stop(true,code,'CONNECTION');this.collector?.cancel();this.modelAbort.abort();this.modelAbort=new AbortController();}
      this.store.audit('SINGLE_ACCOUNT_CONNECTION_FAILED',digest(code),{stopped:collectionStops.has(code)});
    }).finally(()=>{this.onlineTask=null;if(!this.closing)this.emit('status_updated');});
    this.onlineTask=task;this.track(task);
  }
  private resumeAfterLogin():void{
    if(this.browser.loginRecovery||this.closing)return;
    this.collector?.suspend(false);this.verification?.suspend(false);
    this.modelAbort=new AbortController();this.automaticAbort=new AbortController();this.onlineRetryAt=0;
  }
  private stopAutomaticReply():void {
    this.automaticAbort.abort();
    if(this.automation)this.store.db.prepare(`UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='AUTO_REPLY_DISABLED'
      WHERE command_id IN (SELECT command_id FROM policy_commands) AND intent_id IS NULL
      AND status IN ('PREPARING','QUEUED','PREFLIGHT','PREVIEW')
      AND NOT EXISTS (SELECT 1 FROM send_intents i WHERE i.event_id=manual_send_commands.event_id)`).run();
  }
  private suspendForVisible(stopUnsubmitted=true):void{
    this.stopSync();this.collector?.suspend(true);this.verification?.suspend(true,stopUnsubmitted);
    this.onlineAbort.abort();this.modelAbort.abort();if(stopUnsubmitted)this.stopAutomaticReply();else this.automaticAbort.abort();
  }
  private emit(event: string): void {
    this.events.emit("update", { event });
  }
  private track(task: Promise<unknown>): void {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
  }
  private stopSync(): void {
    if (!this.syncTask) return;
    this.syncAbort?.abort();
    this.sync.cancelled = true;
    for (const result of this.sync.results)
      if (result.state === "PENDING" || result.state === "RUNNING") result.state = "CANCELLED";
    this.emit("inbox_sync_updated");
  }
  private syncMustStop(code: string): boolean {
    return collectionStops.has(code)||["BROWSER_CLOSED","OPERATOR_EXPIRED","OPERATOR_PERMISSION_DENIED"].includes(code);
  }
  private observationFailed(source:"works"|"dm"|"notifications",error:unknown):never {
    const code=clientError(error),mode=this.browser.status().mode;
    if(code!=='BROWSER_CLOSED'){
      if(this.syncMustStop(code))this.store.db.prepare("UPDATE channel_capabilities SET state='BLOCKED'").run();
      else this.store.db.prepare("UPDATE channel_capabilities SET state='BLOCKED' WHERE channel=? AND browser_mode=?")
        .run(source==='dm'?'DIRECT_MESSAGE':'COMMENT_NOTIFICATION',mode);
    }
    this.emit('status_updated');throw error;
  }
  private async observeSource(source:"works"|"dm"|"notifications",signal?:AbortSignal):Promise<void> {
    try{await this.browser.observe(this.store,source,signal);}
    catch(error){if(signal?.aborted&&!this.syncMustStop(clientError(error)))throw error;this.observationFailed(source,error);}
  }
  private async syncSource(source:'works'|'dm',signal:AbortSignal):Promise<string|null> {
    requireSafe(!signal.aborted,'COLLECTION_CANCELLED');
    const collection=this.automation?.state().collection;
    if(!this.collector||!(source==='works'?collection?.comments:collection?.inbox)){
      await this.observeSource(source,signal);return null;
    }
    try{return (await this.collector.runNow(source,signal)).deferredCode;}
    catch(error){
      const code=clientError(error);
      if((signal.aborted||code==='COLLECTION_CANCELLED'||code==='OBSERVATION_CANCELLED')&&!this.syncMustStop(code))throw error;
      this.observationFailed(source,error);
    }
  }
  private startInboxSync(token: string): void {
    const assistantVersion=this.authority.assistantVersion(token);
    const scope=assistantVersion===null?null:this.authority.assistant.require('editControl',assistantVersion);
    const sources:('works'|'dm')[]=scope?scope.scope.channels.map(channel=>channel==='DIRECT_MESSAGE'?'dm':'works'):['works','dm'];
    if (this.syncTask) return;
    requireSafe(!this.observing, "INBOX_SYNC_IN_PROGRESS");
    requireSafe(!this.automation?.state().emergencyStopped,'COLLECTION_CANCELLED');
    this.sync = {
      runId: randomUUID(), running: true, cancelled: false, source: sources[0]!,
      results: sources.map(source=>({source,state:'PENDING',error:null})),
    };
    const ownerEpoch=this.browser.ownerEpoch,abort=new AbortController();this.syncAbort=abort;
    const task = Promise.resolve().then(async () => {
      for (const result of this.sync.results) {
        if (this.closing || this.sync.cancelled) break;
        this.sync.source = result.source;
        result.state = "RUNNING";
        this.emit("inbox_sync_updated");
        try {
          this.authority.operator(token, "CONTROL");
          if(assistantVersion!==null)this.authority.assistant.require('editControl',assistantVersion);
          requireSafe(this.browser.ownerEpoch === ownerEpoch, "BROWSER_CLOSED");
          const deferred=await this.syncSource(result.source,abort.signal);
          if(!this.sync.cancelled){result.state=deferred?'DEFERRED':'SUCCEEDED';result.error=deferred;}
        } catch (error) {
          if (this.sync.cancelled) break;
          const code = clientError(error);
          result.state = code==='COLLECTION_CANCELLED'||code==='OBSERVATION_CANCELLED'?'CANCELLED':'FAILED';
          result.error = code;
          const safeCode=/^[A-Z][A-Z0-9_]{0,99}$/u.test(code)?code:'PRIVATE_DIAGNOSTICS';
          this.store.audit(`INBOX_SYNC_${result.source.toUpperCase()}_${result.state}_${safeCode}`,this.sync.runId!);
          if (this.syncMustStop(code)||code.startsWith('ASSISTANT_')) {
            for (const next of this.sync.results) if (next.state === "PENDING") next.state = "SKIPPED";
            break;
          }
        }
        this.emit("inbox_updated");
      }
    }).finally(() => {
      this.sync.running = false;
      this.sync.source = null;
      this.syncTask = null;
      if(this.syncAbort===abort)this.syncAbort=null;
      this.emit("inbox_updated");
    });
    this.syncTask = task;
    this.track(task);
  }
  private thread(token: string,eventId: string) {
    return this.queries.thread(token,eventId,this.automation,undefined,this.suggestionState(),this.verification?.activeEventId());
  }
  private suggestionState(){return{settings:this.settings,keyPresent:!!this.key,modelAuthorized:this.modelAuthorized,
    modelBusy:this.modelPending.size>0,recovering:this.browser.loginRecovery};}
  private status(token: string) {
    return {...this.queries.status(token,{
      settings:this.settings,keyPresent:!!this.key,keyStored:this.keyStored,keyStorageError:this.keyStorageError,
      modelAuthorized:this.modelAuthorized,modelBusy:this.modelPending.size>0,automation:this.automation,
      collector:this.collector?.status(),inboxRevision:this.inboxRevision,sync:this.sync,
    }),localAssistant:this.authority.assistant.state(),localAssistantConnection:{...this.assistantConnection}};
  }
  async dispatch(token: string, raw: unknown): Promise<unknown> {
    requireSafe(!this.closing, "CLIENT_CLOSING");
    const c = commandSchema.parse(raw);
    this.authority.operator(token);
    if(!['getStatus','getInbox','getThread','getDiagnostics','getAudit','getSendResult','getMessagePreview'].includes(c.command))this.maintenance.cancel();
    switch (c.command) {
      case 'setLocalAssistantGrant': {
        this.authority.operator(token,'CONTROL');
        requireSafe(this.authority.assistantVersion(token)===null,'ASSISTANT_CANNOT_GRANT');
        await configureAssistantConnection(this.authority.assistant,this.browser.root,c.enabled?'ENABLE':'DISABLE',()=>requireSafe(!this.closing,'CLIENT_CLOSING'));
        this.emit('status_updated');return this.status(token);
      }
      case 'openHumanDialog': {
        this.authority.operator(token,'EDIT');
        this.authority.select(token,c.eventId,c.selectionId);
        this.closeOtherDialogs(token,c.eventId);
        const event=this.store.event(c.eventId);
        if(c.editing!==false&&(!this.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(c.eventId)||this.followups.view(c.eventId)?.queueReady)) {
          const current=this.authority.ownership(event);
          const owner=current.operator_id===this.authority.operator(token).id&&current.lease_expires_at>this.authority.now()?current:
            this.authority.claim(token,c.eventId,current.generation);
          if(this.authority.assistantVersion(token)===null)this.dialogs.set(c.eventId,{token,generation:owner.generation});
        }
        this.emit('takeover_updated');return this.thread(token,c.eventId);
      }
      case 'closeHumanDialog':
        this.authority.release(token,c.eventId,c.generation);this.dialogs.delete(c.eventId);this.emit('takeover_updated');return this.thread(token,c.eventId);
      case 'sendHumanReply': {
        requireSafe(!this.browser.loginRecovery,'LOGIN_RECOVERY_IN_PROGRESS');
        requireSafe(this.automation,'AUTOMATION_NOT_READY');
        const input={...c.input,text:c.input.text.replace(/\r\n?/gu,'\n')};
        const fresh=this.humanReplies.queue(token,c.commandId,input);
        if(fresh)this.track(this.enqueueHuman(()=>this.humanReplies.prepare(token,c.commandId)));
        return this.result(token,c.commandId);
      }
      case 'saveHumanFollowupDraft':
        return this.followups.save(token,c.eventId,c.generation,c.expectedVersion,c.text,c.suggestionId);
      case 'sendHumanFollowup': {
        const fresh=this.followups.queue(token,c.commandId,c.input);
        if(fresh)this.track(this.enqueueHuman(()=>this.followups.prepare(token,c.commandId)));
        return this.followups.result(token,c.commandId);
      }
      case 'configureCollection':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        this.automation.configureCollection(c.settings);this.collector?.cancel();
        this.emit('status_updated');return this.status(token);
      case 'setModelGrant':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        this.modelAuthorized=false;
        if(c.scope)this.automation.grant('MODEL',c.scope);else {this.automation.revoke('MODEL');this.modelAbort.abort();this.modelAbort=new AbortController();}
        this.emit('status_updated');return this.status(token);
      case 'setReplyPolicy':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        if(c.policy)this.automation.grant('AUTO_REPLY',c.policy);else {this.automation.revoke('AUTO_REPLY');this.stopAutomaticReply();}
        this.emit('status_updated');return this.status(token);
      case 'enableReplyPolicy':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        this.store.db.transaction(()=>{
          requireSafe(!this.automation!.state().emergencyStopped,'EMERGENCY_STOPPED');
          this.automation!.grant('AUTO_REPLY',c.policy);
          this.authority.setMode(token,'LIMITED_AUTO');
          this.authority.pause(token,null,false);
          this.authority.resumeIdleAutomation();
        }).immediate();
        this.stopAutomaticReply();this.automaticAbort=new AbortController();
        this.emit('status_updated');return this.status(token);
      case 'setAutomaticReply':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        if(this.authority.assistantVersion(token)!==null){
          const scope=this.authority.assistant.require('editControl',this.authority.assistantVersion(token)!),policy=this.automation.active('AUTO_REPLY');
          if(c.enabled&&policy)this.authority.assistant.requirePolicy(scope.version,policy.scope as ReplyPolicy);
        }
        if(c.enabled){
          requireSafe(!this.automation.state().emergencyStopped,'EMERGENCY_STOPPED');
          const grant=this.automation.active('AUTO_REPLY');requireSafe(grant,'AUTO_POLICY_REQUIRED');
          requireSafe(grant.scope.model===this.settings.model,'MODEL_OUTSIDE_GRANT');
          requireSafe(this.automation.allowance(grant.version,'SEND'),'SEND_GRANT_EXHAUSTED');
          requireSafe(this.automation.allowance(grant.version,'MODEL'),'MODEL_GRANT_EXHAUSTED');
          this.authority.setMode(token,'LIMITED_AUTO');
          this.authority.resumeIdleAutomation();
          if(this.automaticAbort.signal.aborted)this.automaticAbort=new AbortController();
        }else{
          this.store.db.transaction(()=>{this.authority.setMode(token,'MANUAL');this.stopAutomaticReply();}).immediate();
        }
        this.emit('status_updated');return this.status(token);
      case 'resumeAutomation':
        this.authority.resumeAutomation(token,c.eventId);this.emit('takeover_updated');return this.thread(token,c.eventId);
      case 'clearModelKey':
        this.authority.operator(token,'CONTROL');this.keyGeneration++;this.key='';this.modelAbort.abort();this.modelAbort=new AbortController();this.emit('status_updated');return this.status(token);
      case 'setKeyStorage': {
        this.authority.operator(token,'CONTROL');const credentials=new CredentialStore(this.browser.root);
        const generation=++this.keyGeneration;
        if(c.storage==='DPAPI'){requireSafe(this.key,'MODEL_KEY_REQUIRED');await credentials.save(this.key);if(generation===this.keyGeneration&&!this.closing)this.keyStored=true;}
        else {await credentials.delete();if(generation===this.keyGeneration&&!this.closing){this.keyStored=false;if(c.storage==='DELETE'){this.key='';this.modelAbort.abort();this.modelAbort=new AbortController();}}}
        this.keyStorageError=null;this.store.audit('MODEL_KEY_STORAGE_CHANGED','account_001',{stored:this.keyStored});this.emit('status_updated');return this.status(token);
      }
      case "getStatus":
        for (const channel of [
          "COMMENT_NOTIFICATION",
          "DIRECT_MESSAGE",
        ] as const)
          await this.browser.refreshIdentity(channel);
        return this.status(token);
      case 'getDiagnostics':
        this.authority.operator(token,'READ');
        return {...readDiagnostics(this.store),performance:runtimePerformance.snapshot(),evidence:this.maintenance.status()};
      case "getThread":
        return {
          ...this.queries.thread(token,c.eventId,this.automation,c.timelineBefore,this.suggestionState(),this.verification?.activeEventId()),
          workUrl: await this.browser.workUrl(
            this.store.event(c.eventId).payload,
            this.store,
          ),
        };
      case 'getMessagePreview': {
        return readOrRefreshPreview(this.store,this.browser,this.automation,()=>{this.authority.operator(token,'CONTROL');},c);
      }
      case "openTarget": {
        this.authority.operator(token, "CONTROL");
        if(c.visible){let suspended=false;const check=()=>{this.authority.operator(token,'CONTROL');requireSafe(!this.closing&&this.automation?.state().collection?.inbox&&
          !this.automation.state().emergencyStopped,'COLLECTION_CANCELLED');};check();
          try{return await this.browser.openStoredMessage(this.store,c.eventId,async()=>{this.suspendForVisible(false);suspended=true;this.onlineAbort=new AbortController();
            await this.verification?.drain();check();return this.onlineAbort.signal;},check);}
          catch(error){if(suspended&&!this.browser.loginRecovery&&!this.automation?.state().emergencyStopped)this.resumeAfterLogin();throw error;}finally{this.emit('status_updated');}}
        const event = this.store.event(c.eventId),
          handle = await this.browser.adapter(event.payload,this.store);
        try {
          await this.browser.actor.run(() =>
            handle.adapter.inspect(event.payload),
          );
          return { opened: true };
        } finally {
          handle.dispose();
        }
      }
      case 'getInbox': return this.queries.inbox(c);
      case 'markInboxRead': {
        this.authority.operator(token,'EDIT');
        const version=this.authority.assistantVersion(token),grant=version===null?null:this.authority.assistant.require('editControl',version);
        const ids=grant?this.store.events().filter(event=>this.authority.assistant.inScope(grant,event)).map(event=>event.id):undefined;
        const result=markInboxRead(this.store,ids);this.inboxRevision++;this.emit('inbox_updated');return result;
      }
      case "selectTarget":
        this.closeOtherDialogs(token,c.eventId);
        this.authority.select(token, c.eventId, c.selectionId);
        if(c.eventId&&this.automation)this.browser.prioritizePreview(this.automation,this.store.event(c.eventId).payload,c.eventId);
        return { selected: true };
      case "claimHuman": {
        const o = this.authority.claim(token, c.eventId, c.generation);
        this.emit("takeover_updated");
        return o;
      }
      case "renewHuman":
        return this.authority.renew(token, c.eventId, c.generation);
      case "releaseHuman":
        this.authority.release(token, c.eventId, c.generation);
        this.emit("takeover_updated");
        return { released: true };
      case "saveDraft": {
        const draft = this.authority.save(
          token,
          c.eventId,
          c.generation,
          c.expectedVersion,
          c.text,
          c.suggestionId,
        );
        this.emit("draft_updated");
        return draft;
      }
      case "setMode":
        this.authority.setMode(token, c.mode);
        if(c.mode!=='LIMITED_AUTO')this.stopAutomaticReply();
        else if(this.automaticAbort.signal.aborted)this.automaticAbort=new AbortController();
        this.emit("status_updated");
        return this.status(token);
      case "pause":
      case "resume":
      case "emergencyStop": {
        if(c.command==='resume'&&c.eventId===null&&this.automation?.state().emergencyStopped){
          this.authority.operator(token,'CONTROL');this.onlineAbort=new AbortController();
          await recoverEmergency({store:this.store,data:this.automation,authority:this.authority,browser:this.browser,token,
            signal:AbortSignal.any([this.onlineAbort.signal,AbortSignal.timeout(30_000)]),closing:()=>this.closing});
          this.resumeAfterLogin();this.keepOnline();this.emit('status_updated');return this.status(token);
        }
        this.authority.pause(
          token,
          c.command === "emergencyStop" ? null : c.eventId,
          c.command !== "resume",
        );
        if (c.command === "emergencyStop") {
          this.inboxRevision++;
          this.automation?.stop(true,'MANUAL_EMERGENCY_STOP','MANUAL');
          this.onlineAbort.abort();
          this.dialogs.clear();
          this.collector?.cancel();
          this.verification?.cancel();
          this.stopSync();
          this.modelAbort.abort();
          this.modelAbort = new AbortController();
        }
        if(c.command==='resume'&&c.eventId===null){this.automation?.stop(false);this.keepOnline();}
        this.emit("takeover_updated");
        this.emit("send_status_updated");
        return this.status(token);
      }
      case "browser": {
        this.authority.operator(token, "CONTROL");
        if('action' in c){
          const recovery=new BrowserDraftRecovery(this.store,this.authority,this.browser);
          if(c.action==='inspectSavedDraftRecovery')return recovery.available(token);
          const result=await recovery.clear(token,c);this.emit('status_updated');return result;
        }
        if(c.open&&c.loginRecovery){
          this.suspendForVisible();
          await this.browser.beginLoginRecovery(!c.manualVisible);this.onlineRetryAt=0;
        }
        else if(c.open&&this.browser.loginRecovery){if(await this.browser.finishLoginRecovery())this.resumeAfterLogin();}
        else if (c.open) await this.browser.open('headless');
        else {this.stopSync();this.collector?.cancel();await this.browser.close();}
        this.emit("status_updated");
        return this.status(token);
      }
      case "observe": {
        this.authority.operator(token, "CONTROL");
        requireSafe(!this.syncTask&&!this.observing,'INBOX_SYNC_IN_PROGRESS');
        this.observing=true;
        try {await this.observeSource(c.source);}finally{this.observing=false;}
        this.emit("inbox_updated");
        return this.status(token);
      }
      case 'syncInbox':
        this.authority.operator(token,'CONTROL');
        this.startInboxSync(token);
        return this.status(token);
      case "getAudit":
        return {
          items: this.store.db
            .prepare(
              "SELECT time,event_type,entity_id,detail_redacted FROM audit_events ORDER BY rowid DESC LIMIT 50 OFFSET ?",
            )
            .all(c.page * 50),
          page: c.page,
        };
      case "previewSend": {
        this.authority.operator(token, "SEND");
        const e = this.store.event(c.params.eventId);
        const handle = await this.browser.adapter(e.payload,this.store);
        try {
          const snapshot = await this.browser.actor.run(async () => {
            await this.browser.refreshIdentity(e.payload.channel);
            this.authority.assertCanSend(
              token,
              c.params,
              this.browser.identity(e.payload.channel),
            );
            return handle.adapter.inspect(e.payload);
          });
          return {
            ...this.authority.preview(
              token,
              c.params,
              snapshot,
              this.browser.identity(e.payload.channel),
            ),
            params: c.params,
            target: e.payload,
            account: snapshot.ownId,
          };
        } finally {
          handle.dispose();
        }
      }
      case "submitManualSend": {
        const e = this.store.event(c.params.eventId);
        await this.browser.refreshIdentity(e.payload.channel);
        const fresh = this.authority.queue(
          token,
          c.commandId,
          c.params,
          this.browser.identity(e.payload.channel),
        );
        if (fresh) this.track(this.deliver(token, c.commandId, c.params));
        return this.result(token, c.commandId);
      }
      case "getSendResult":
        return this.result(token, c.commandId);
      case "reconcileUncertain": {
        this.authority.operator(token, "CONTROL");
        return this.browser.verifyExisting(this.store, c.eventId);
      }
      case "configureAi": {
        this.authority.operator(token, "CONTROL");
        requireSafe(!/[\r\n]/u.test(c.key), "INVALID_MODEL_KEY");
        const generation=c.key?++this.keyGeneration:this.keyGeneration;
        const file = join(this.browser.root, "client-settings.json"),
          temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(c.settings), {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, file);
        const modelChanged=this.settings.model!==c.settings.model;
        this.settings = c.settings;
        if(c.key&&generation===this.keyGeneration&&!this.closing){if(this.keyStored)await new CredentialStore(this.browser.root).save(c.key);if(generation===this.keyGeneration&&!this.closing)this.key = c.key;}
        if(modelChanged)this.modelAuthorized=false;
        if(c.key&&generation===this.keyGeneration&&this.automation){
          const budget=this.store.budget('MODEL'),remaining=budget.maximum===null?null:budget.maximum-budget.used;
          const own=this.store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
          if(own&&(remaining===null||remaining>0)&&!this.automation.active('MODEL')&&!this.automation.active('AUTO_REPLY'))
            this.automation.grant('MODEL',{ownId:own.own_id,channels:['COMMENT_NOTIFICATION','DIRECT_MESSAGE'],model:c.settings.model,modelLimit:remaining,expiresAt:null});
        }
        this.emit('status_updated');return this.status(token);
      }
      case "authorizeAi":
        this.authority.operator(token, "CONTROL");
        requireSafe(!this.automation,'USE_PERSISTENT_MODEL_GRANT');
        requireSafe(!c.authorized || this.key, "MODEL_KEY_REQUIRED");
        this.modelAuthorized = c.authorized;
        this.store.audit(
          c.authorized ? "DEEPSEEK_AUTHORIZED" : "DEEPSEEK_REVOKED",
          "account_001",
        );
        this.emit('status_updated');return this.status(token);
      case "generateSuggestion": {
        return generateSuggestion({store:this.store,authority:this.authority,automation:this.automation,provider:this.provider,
          state:()=>this.suggestionState(),key:()=>this.key,signal:()=>this.modelAbort.signal,pending:this.modelPending,
          emit:event=>this.emit(event),cancelMaintenance:()=>this.maintenance.cancel()},token,c);
      }
      case "dismissSuggestion":
        this.authority.operator(token, "EDIT");
        this.store.db
          .prepare("UPDATE ai_suggestions SET dismissed=1 WHERE id=?")
          .run(c.suggestionId);
        this.emit('suggestion_updated');
        return { dismissed: true };
    }
  }
  private result(token: string, id: string) {
    if(this.followups.turn(id))return this.followups.result(token,id);
    const row = this.authority.command(id);
    this.authority.operator(token);
    return {
      commandId: id,
      status: row.status,
      intentId: row.intent_id,
      reason: row.reason,
      accepted:row.status!=='FAILED_BEFORE_CLICK'&&!!this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='manual_send_inputs'").get()&&
        !!this.store.db.prepare('SELECT command_id FROM manual_send_inputs WHERE command_id=?').get(id),
    };
  }
  private enqueueHuman(operation:()=>Promise<void>):Promise<void>{
    const task=this.humanQueue.then(operation);this.humanQueue=task.catch(()=>{});return task;
  }
  private closeOtherDialogs(token:string,current:string|null):void {
    for(const [id,dialog]of this.dialogs)if(id!==current&&dialog.token===token) {
      try{this.authority.release(token,id,dialog.generation);}catch{/* Pause may already have invalidated the lease. */}
      this.dialogs.delete(id);
    }
  }
  async runAutomaticReply():Promise<void> {
    if(this.closing||this.browser.loginRecovery||!this.automation||!this.key||this.modelPending.size)return;
    await runAutomaticReply({store:this.store,authority:this.authority,automation:this.automation,browser:this.browser,
      provider:this.provider,humanReplies:this.humanReplies,settings:this.settings,key:this.key,modelPending:this.modelPending,
      automaticSignal:this.automaticAbort.signal,modelSignal:this.modelAbort.signal,isClosing:()=>this.closing,
      updated:()=>{this.inboxRevision++;this.emit('inbox_updated');},errorCode:clientError,beforeWork:()=>this.maintenance.cancel(),statusUpdated:()=>this.emit('status_updated'),
      stop:(code:string)=>{this.automation!.stop(true,code,'AUTOMATIC_REPLY');this.collector?.cancel();this.modelAbort.abort();this.modelAbort=new AbortController();}});
  }
  private async deliver(
    token: string,
    id: string,
    p: SendParams,
  ): Promise<void> {
    let dispose = () => {};
    const end=runtimePerformance.start('DELIVERY',this.store.event(p.eventId).payload.channel);
    try {
      const e = this.store.event(p.eventId),
        handle = await this.browser.adapter(e.payload,this.store,undefined,{manualMedia:!!this.store.draft(p.draftId).approval?.snapshot.manualObservation});
      dispose = handle.dispose;
      await this.browser.refreshIdentity(e.payload.channel);
      const outcome = await new SendCoordinator(
        this.store,
        this.browser.actor,
      ).send(
        p.draftId,
        handle.adapter,
        true,
        this.authority.dispatchGuard(token, id, () =>
          this.browser.identity(e.payload.channel),
        ),
      );
      const receipt=this.store.receiptForEvent(e.id) as {proof_ref:string}|undefined;
      this.authority.finish(id, outcome, outcome==='UNCERTAIN'?receipt?.proof_ref??null:null);
      if(outcome==='UNCERTAIN')this.verification?.enqueue(e.id);
      if (outcome === "CONFIRMED")
        this.authority.completeTrial(
          p.eventId,
          this.authority.command(id).intent_id!,
          this.browser.identity(e.payload.channel),
        );
      end(outcome==='CONFIRMED'?'SUCCEEDED':'UNCERTAIN');
    } catch (error) {
      const intent = this.store.db
        .prepare("SELECT id,status FROM send_intents WHERE event_id=?")
        .get(p.eventId) as { id: string; status: string } | undefined;
      end(intent?(intent.status==='CONFIRMED'?'SUCCEEDED':'UNCERTAIN'):'FAILED');
      if (intent && this.authority.command(id).intent_id === intent.id)
        this.authority.finish(
          id,
          intent.status === "CONFIRMED" ? "CONFIRMED" : "UNCERTAIN",
          clientError(error),
        );
      else {
        this.authority.finish(id, "FAILED_BEFORE_CLICK", clientError(error));
        const d = this.store.draft(p.draftId);
        if (d.status === "APPROVED") this.store.invalidateApproval(d.id);
      }
    } finally {
      dispose();
      this.emit("send_status_updated");
    }
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.keyGeneration++;
    this.stopSync();
    this.key = "";
    this.modelAuthorized = false;
    this.modelAbort.abort();
    this.onlineAbort.abort();
    clearInterval(this.leaseTimer);this.dialogs.clear();
    clearInterval(this.autoTimer);
    this.authority.expireOperators();
    await this.collector?.close();
    await this.verification?.close();
    await this.maintenance.close();
    if(!this.automation)this.store.db.prepare("UPDATE client_state SET paused=1 WHERE id=1").run();
    await this.drain();
    await this.browser.close();
  }
}
