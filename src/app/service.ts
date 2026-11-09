import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  Blocked,
  digest,
  requireSafe,
  targetKey,
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
import { WorkbenchQueries } from "./workbench-queries.js";
import {MessagePreviewStore} from '../storage/message-previews.js';
import {ChatMessageStore} from '../storage/chat-messages.js';
import { WorkbenchAuthority } from "./authority.js";
import { BrowserService } from "./browser-service.js";
import { DeepSeekProvider } from "../ai/deepseek.js";
import { AutomationStore } from "../storage/automation-store.js";
import { migrateAutomation } from "../storage/automation-migration.js";
import { CollectionScheduler, collectionStops } from "./collection-scheduler.js";
import { VerificationScheduler } from "./verification-scheduler.js";
import type { Grant, ReplyPolicy } from "./automation-contracts.js";
import { CredentialStore } from "./credentials.js";

export function clientError(error: unknown): string {
  return error instanceof Blocked
    ? error.code
    : "OPERATION_FAILED_PRIVATE_DIAGNOSTICS";
}

/** Transport-neutral application service. Short controls never wait behind browser/model operations. */
export class ClientService {
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
  private keyStored=false;
  private keyStorageError:string|null=null;
  private keyGeneration=0;
  private onlineEnabled=false;
  private onlineTask:Promise<void>|null=null;
  private onlineRetryAt=0;
  private onlineAbort=new AbortController();
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
    this.authority = new WorkbenchAuthority(store, now);
    this.authority.recover();
    this.humanReplies=new HumanReplyWorkflow(store,this.authority,browser,()=>this.closing,(token,id,params)=>this.deliver(token,id,params),event=>this.emit(event),clientError);
    this.queries = new WorkbenchQueries(store,this.authority,browser);
  }
  async loadSettings(): Promise<void> {
    if(!this.automation) {
      await migrateAutomation(this.store,join(this.browser.root,"backups",`automation-${randomUUID()}.sqlite`));
      this.automation=new AutomationStore(this.store,this.authority.now);
      this.automation.initialize(this.startedAt);
      if(!this.automation.state().emergencyStopped&&this.authority.paused()) {
        this.store.db.prepare('UPDATE client_state SET paused=0 WHERE id=1').run();
        this.store.audit('SINGLE_ACCOUNT_ONLINE_RESTORED','account_001');
      }
      this.store.db.prepare(`UPDATE automation_jobs SET state=COALESCE((SELECT status FROM send_intents WHERE event_id=automation_jobs.event_id),'REVIEW'),
        reason='RESTART_NO_REPLAY',updated_at=? WHERE state IN ('QUALIFYING','GENERATING','PREPARING','QUEUED','PREFLIGHT','SENDING')`).run(this.authority.now());
      this.collector=new CollectionScheduler(this.automation,async(source,signal)=>{
        requireSafe(!this.syncTask&&!this.observing,'INBOX_SYNC_IN_PROGRESS');
        await this.browser.collect(this.automation!,source,signal);
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
    if(!this.autoTimer){this.autoTimer=setInterval(()=>{this.keepOnline();if(!this.autoTask){const task=this.runAutomaticReply().catch(()=>{}).finally(()=>{this.autoTask=null;});this.autoTask=task;this.track(task);}},1000);this.autoTimer.unref();}
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
  private keepOnline():void {
    if(!this.onlineEnabled||this.closing||this.onlineTask||!this.automation||this.automation.state().emergencyStopped||
      !this.store.db.prepare("SELECT id FROM accounts WHERE id='account_001'").get()||this.authority.now()<this.onlineRetryAt||
      !['CLOSED','BROWSER_START_FAILED'].includes(this.browser.status().state))return;
    if(this.onlineAbort.signal.aborted)this.onlineAbort=new AbortController();
    const task=this.browser.open(this.browser.status().mode,this.onlineAbort.signal).catch(error=>{
      if(this.closing||this.onlineAbort.signal.aborted)return;
      const code=clientError(error);
      this.onlineRetryAt=this.authority.now()+30_000;
      if(collectionStops.has(code)){this.automation!.stop(true);this.collector?.cancel();this.modelAbort.abort();this.modelAbort=new AbortController();}
      this.store.audit('SINGLE_ACCOUNT_CONNECTION_FAILED',digest(code),{stopped:collectionStops.has(code)});
    }).finally(()=>{this.onlineTask=null;if(!this.closing)this.emit('status_updated');});
    this.onlineTask=task;this.track(task);
  }
  private stopAutomaticReply():void {
    this.automaticAbort.abort();
    if(this.automation)this.store.db.prepare(`UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='AUTO_REPLY_DISABLED'
      WHERE command_id IN (SELECT command_id FROM policy_commands) AND intent_id IS NULL
      AND status IN ('PREPARING','QUEUED','PREFLIGHT','PREVIEW')
      AND NOT EXISTS (SELECT 1 FROM send_intents i WHERE i.event_id=manual_send_commands.event_id)`).run();
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
    this.sync.cancelled = true;
    for (const result of this.sync.results)
      if (result.state === "PENDING" || result.state === "RUNNING") result.state = "CANCELLED";
    this.emit("inbox_sync_updated");
  }
  private syncMustStop(code: string): boolean {
    return ["OBSERVATION_PAGE_BLOCKED", "OBSERVATION_ACCOUNT_CHANGED", "ACCOUNT_CHANGED", "BROWSER_CLOSED", "PLATFORM_STOP", "CHALLENGE_REQUIRED",
      "LOGIN_REQUIRED", "ACCOUNT_NOT_VERIFIED", "UNEXPECTED_ORIGIN", "OWNER_LOCKED_OR_PORT_UNAVAILABLE",
      "OPERATOR_EXPIRED", "OPERATOR_PERMISSION_DENIED"].includes(code);
  }
  private async observeSource(source: "works" | "dm" | "notifications"): Promise<void> {
    try {
      await this.browser.observe(this.store, source);
    } catch (error) {
      const code = clientError(error), mode = this.browser.status().mode;
      if (code === "BROWSER_CLOSED") { this.emit("status_updated"); throw error; }
      if (this.syncMustStop(code)) this.store.db.prepare("UPDATE channel_capabilities SET state='BLOCKED'").run();
      else this.store.db.prepare("UPDATE channel_capabilities SET state='BLOCKED' WHERE channel=? AND browser_mode=?")
        .run(source === "dm" ? "DIRECT_MESSAGE" : "COMMENT_NOTIFICATION", mode);
      this.emit("status_updated");
      throw error;
    }
  }
  private startInboxSync(token: string): void {
    if (this.syncTask) return;
    requireSafe(!this.observing, "INBOX_SYNC_IN_PROGRESS");
    this.sync = {
      runId: randomUUID(), running: true, cancelled: false, source: "works",
      results: [{source: "works", state: "RUNNING", error: null}, {source: "dm", state: "PENDING", error: null}],
    };
    const ownerEpoch = this.browser.ownerEpoch;
    const task = Promise.resolve().then(async () => {
      for (const result of this.sync.results) {
        if (this.closing || this.sync.cancelled) break;
        this.sync.source = result.source;
        result.state = "RUNNING";
        this.emit("inbox_sync_updated");
        try {
          this.authority.operator(token, "CONTROL");
          requireSafe(this.browser.ownerEpoch === ownerEpoch, "BROWSER_CLOSED");
          await this.observeSource(result.source);
          if (!this.sync.cancelled) result.state = "SUCCEEDED";
        } catch (error) {
          if (this.sync.cancelled) break;
          const code = clientError(error);
          result.state = "FAILED";
          result.error = code;
          if (this.syncMustStop(code)) {
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
      this.emit("inbox_updated");
    });
    this.syncTask = task;
    this.track(task);
  }
  private thread(token: string,eventId: string) {
    return this.queries.thread(token,eventId,this.automation);
  }
  private status(token: string) {
    return this.queries.status(token,{
      settings:this.settings,keyPresent:!!this.key,keyStored:this.keyStored,keyStorageError:this.keyStorageError,
      modelAuthorized:this.modelAuthorized,modelBusy:this.modelPending.size>0,automation:this.automation,
      collector:this.collector?.status(),inboxRevision:this.inboxRevision,sync:this.sync,
    });
  }
  async dispatch(token: string, raw: unknown): Promise<unknown> {
    requireSafe(!this.closing, "CLIENT_CLOSING");
    const c = commandSchema.parse(raw);
    this.authority.operator(token);
    switch (c.command) {
      case 'openHumanDialog': {
        this.authority.operator(token,'EDIT');
        this.authority.select(token,c.eventId,c.selectionId);
        this.closeOtherDialogs(token,c.eventId);
        const event=this.store.event(c.eventId);
        if(!this.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(c.eventId)) {
          const current=this.authority.ownership(event);
          const owner=this.authority.claim(token,c.eventId,current.generation);
          this.dialogs.set(c.eventId,{token,generation:owner.generation});
        }
        this.emit('takeover_updated');return this.thread(token,c.eventId);
      }
      case 'closeHumanDialog':
        this.authority.release(token,c.eventId,c.generation);this.dialogs.delete(c.eventId);return this.thread(token,c.eventId);
      case 'sendHumanReply': {
        requireSafe(this.automation,'AUTOMATION_NOT_READY');
        const input={...c.input,text:c.input.text.replace(/\r\n?/gu,'\n')};
        const fresh=this.humanReplies.queue(token,c.commandId,input);
        if(fresh)this.track(this.humanReplies.prepare(token,c.commandId));
        return this.result(token,c.commandId);
      }
      case 'configureCollection':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        this.automation.configureCollection(c.settings);this.collector?.cancel();
        this.emit('status_updated');return this.status(token);
      case 'setModelGrant':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        this.modelAuthorized=false;
        if(c.scope)this.automation.grant('MODEL',c.scope);else {this.automation.revoke('MODEL');this.modelAbort.abort();this.modelAbort=new AbortController();}
        return this.status(token);
      case 'setReplyPolicy':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        if(c.policy)this.automation.grant('AUTO_REPLY',c.policy);else {this.automation.revoke('AUTO_REPLY');this.stopAutomaticReply();}
        return this.status(token);
      case 'enableReplyPolicy':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        this.store.db.transaction(()=>{
          requireSafe(!this.automation!.state().emergencyStopped,'EMERGENCY_STOPPED');
          this.automation!.grant('AUTO_REPLY',c.policy);
          this.authority.setMode(token,'LIMITED_AUTO');
          this.authority.pause(token,null,false);
        }).immediate();
        this.stopAutomaticReply();this.automaticAbort=new AbortController();
        this.emit('status_updated');return this.status(token);
      case 'setAutomaticReply':
        this.authority.operator(token,'CONTROL');requireSafe(this.automation,'AUTOMATION_NOT_READY');
        if(c.enabled){
          requireSafe(!this.automation.state().emergencyStopped,'EMERGENCY_STOPPED');
          const grant=this.automation.active('AUTO_REPLY');requireSafe(grant,'AUTO_POLICY_REQUIRED');
          requireSafe(grant.scope.model===this.settings.model,'MODEL_OUTSIDE_GRANT');
          requireSafe(this.automation.allowance(grant.version,'SEND'),'SEND_GRANT_EXHAUSTED');
          requireSafe(this.automation.allowance(grant.version,'MODEL'),'MODEL_GRANT_EXHAUSTED');
          this.authority.setMode(token,'LIMITED_AUTO');
          if(this.automaticAbort.signal.aborted)this.automaticAbort=new AbortController();
        }else{
          this.store.db.transaction(()=>{this.authority.setMode(token,'MANUAL');this.stopAutomaticReply();}).immediate();
        }
        this.emit('status_updated');return this.status(token);
      case 'resumeAutomation':
        this.authority.resumeAutomation(token,c.eventId);return this.thread(token,c.eventId);
      case 'clearModelKey':
        this.authority.operator(token,'CONTROL');this.keyGeneration++;this.key='';this.modelAbort.abort();this.modelAbort=new AbortController();return this.status(token);
      case 'setKeyStorage': {
        this.authority.operator(token,'CONTROL');const credentials=new CredentialStore(this.browser.root);
        const generation=++this.keyGeneration;
        if(c.storage==='DPAPI'){requireSafe(this.key,'MODEL_KEY_REQUIRED');await credentials.save(this.key);if(generation===this.keyGeneration&&!this.closing)this.keyStored=true;}
        else {await credentials.delete();if(generation===this.keyGeneration&&!this.closing){this.keyStored=false;if(c.storage==='DELETE'){this.key='';this.modelAbort.abort();this.modelAbort=new AbortController();}}}
        this.keyStorageError=null;this.store.audit('MODEL_KEY_STORAGE_CHANGED','account_001',{stored:this.keyStored});return this.status(token);
      }
      case "getStatus":
        for (const channel of [
          "COMMENT_NOTIFICATION",
          "DIRECT_MESSAGE",
        ] as const)
          await this.browser.refreshIdentity(channel);
        return this.status(token);
      case "getThread":
        return {
          ...this.queries.thread(token,c.eventId,this.automation,c.timelineBefore),
          workUrl: await this.browser.workUrl(
            this.store.event(c.eventId).payload,
            this.store,
          ),
        };
      case 'getMessagePreview': {
        const observed=new ChatMessageStore(this.store).get(c.eventId),event=observed??this.store.event(c.eventId),own=this.store.db.prepare('SELECT own_id FROM accounts WHERE id=?')
          .get(event.payload.accountId) as {own_id:string}|undefined;
        requireSafe(own,'MESSAGE_PREVIEW_UNAVAILABLE');
        return new MessagePreviewStore(this.browser.root).read(event.payload,own.own_id,c.previewId);
      }
      case "openTarget": {
        this.authority.operator(token, "CONTROL");
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
      case "selectTarget":
        this.closeOtherDialogs(token,c.eventId);
        this.authority.select(token, c.eventId, c.selectionId);
        if(c.eventId&&this.automation)this.browser.prioritizePreview(this.automation,this.store.event(c.eventId).payload);
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
        this.authority.pause(
          token,
          c.command === "emergencyStop" ? null : c.eventId,
          c.command !== "resume",
        );
        if (c.command === "emergencyStop") {
          this.inboxRevision++;
          this.onlineAbort.abort();
          this.dialogs.clear();
          this.automation?.stop(true);this.collector?.cancel();
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
        if (c.open) await this.browser.open(c.mode);
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
        return this.status(token);
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
        return this.status(token);
      case "generateSuggestion": {
        this.authority.operator(token, "EDIT");
        requireSafe(
          this.authority.mode() !== "OBSERVE" && !this.authority.paused(),
          "MODEL_PAUSED",
        );
        const e = this.store.event(c.eventId);
        this.store.assertModelObservation(e.payload);
        requireSafe(
          [
            "AWAITING_DRAFT",
            "AWAITING_APPROVAL",
            "APPROVED",
            "MANUAL_REVIEW",
          ].includes(e.status),
          "EVENT_NOT_DRAFTABLE",
        );
        requireSafe(
          (this.authority.draftFor(e.id)?.version ?? 0) === c.draftVersion,
          "DRAFT_VERSION_CONFLICT",
        );
        requireSafe(!this.modelPending.has(e.id), "MODEL_ALREADY_PENDING");
        const context = this.authority.contextVersion(e);
        const grant=this.automation?.active('MODEL');
        if(grant) {
          this.automation!.requireAccount(grant.scope.ownId);
          requireSafe(grant.scope.model===this.settings.model&&grant.scope.channels.includes(e.payload.channel),'MODEL_OUTSIDE_GRANT');
        }
        this.modelPending.add(e.id);
        try {
          const result = await this.provider.generate(
            this.store,
            e.payload,
            this.store.history(e.payload),
            this.settings,
            this.key,
            this.modelAuthorized||!!grant,
            this.modelAbort.signal,
            grant?()=>this.automation!.reserve(grant.version,'MODEL',randomUUID()):undefined,
          );
          const id = randomUUID();
          this.store.db
            .prepare("INSERT INTO ai_suggestions VALUES(?,?,?,?,?,?,?,0)")
            .run(
              id,
              e.id,
              c.draftVersion,
              context,
              result.text,
              result.model,
              Date.now(),
            );
          // Candidate only: a human revision, new context, or new lease is never overwritten.
          this.emit("suggestion_updated");
          return {
            id,
            ...result,
            stale:
              (this.authority.draftFor(e.id)?.version ?? 0) !==
                c.draftVersion || this.authority.contextVersion(e) !== context,
          };
        } finally {
          this.modelPending.delete(e.id);
        }
      }
      case "dismissSuggestion":
        this.authority.operator(token, "EDIT");
        this.store.db
          .prepare("UPDATE ai_suggestions SET dismissed=1 WHERE id=?")
          .run(c.suggestionId);
        return { dismissed: true };
    }
  }
  private result(token: string, id: string) {
    const row = this.authority.command(id);
    this.authority.operator(token);
    return {
      commandId: id,
      status: row.status,
      intentId: row.intent_id,
      reason: row.reason,
    };
  }
  private closeOtherDialogs(token:string,current:string|null):void {
    for(const [id,dialog]of this.dialogs)if(id!==current&&dialog.token===token) {
      try{this.authority.release(token,id,dialog.generation);}catch{/* Pause may already have invalidated the lease. */}
      this.dialogs.delete(id);
    }
  }
  async runAutomaticReply():Promise<void> {
    if(this.closing||!this.automation||!this.key||this.modelPending.size)return;
    const grant=this.automation.active('AUTO_REPLY') as Grant<ReplyPolicy>|null;
    if(!grant||grant.scope.model!==this.settings.model)return;
    if(!this.automation.allowance(grant.version,'MODEL')||!this.automation.allowance(grant.version,'SEND'))return;
    const event=this.store.events().find(e=>!this.store.db.prepare('SELECT event_id FROM automation_jobs WHERE event_id=?').get(e.id)&&
      !this.authority.draftFor(e.id)&&this.automation!.policyMatches(grant,e));
    if(!event)return;
    const generation=this.authority.ownership(event).generation,context=this.authority.contextVersion(event),now=this.authority.now();
    this.store.db.prepare('INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,NULL,NULL,?,?)').run(event.id,grant.version,'QUALIFYING',context,generation,0,now,now);
    this.modelPending.add(event.id);
    const automaticSignal=this.automaticAbort.signal,signal=AbortSignal.any([this.modelAbort.signal,automaticSignal]);
    try {
      const handle=await this.browser.adapter(event.payload,this.store,signal);
      try{await this.browser.actor.run(async()=>{
        requireSafe(!signal.aborted&&this.automation!.policyMatches(grant,this.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
        const prior=await this.browser.refreshIdentity(event.payload.channel),proof=await handle.adapter.inspect(event.payload),identity=await this.browser.refreshIdentity(event.payload.channel);
        requireSafe(!signal.aborted&&prior&&identity&&digest(prior)===digest(identity),'CAPABILITY_CHANGED_DURING_CHECK');
        requireSafe(proof.ownId===grant.scope.ownId&&identity.identityDigest===digest(proof.ownId),'ACCOUNT_CHANGED');
        requireSafe(proof.accountId===event.payload.accountId&&proof.eventBinding===event.binding&&
          proof.targetKey===targetKey(event.payload)&&proof.composerKey===proof.targetKey,'TARGET_CHANGED');
      });}finally{handle.dispose();}
      requireSafe(!signal.aborted&&this.automation!.policyMatches(grant,this.store.event(event.id))&&this.authority.contextVersion(event)===context&&this.authority.ownership(event).generation===generation,'AUTO_RESULT_STALE');
      this.store.db.prepare("UPDATE automation_jobs SET state='GENERATING',updated_at=? WHERE event_id=?").run(this.authority.now(),event.id);
      const result=await this.provider.generate(this.store,event.payload,this.store.history(event.payload),
        {...this.settings,rules:grant.scope.instructions},this.key,true,signal,()=>{
          requireSafe(!signal.aborted,'MODEL_CANCELLED');
          requireSafe(this.automation!.policyMatches(grant,this.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
          requireSafe(this.automation!.allowance(grant.version,'SEND'),'SEND_GRANT_EXHAUSTED');
          this.automation!.reserve(grant.version,'MODEL',event.id);
        });
      requireSafe(!signal.aborted,'MODEL_CANCELLED');
      const commandId=randomUUID(),selectionId=randomUUID();
      const token=this.authority.issueSession();
      try {
        this.store.db.transaction(()=>{
          requireSafe(!this.closing&&this.automation!.policyMatches(grant,this.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
          requireSafe(this.authority.ownership(event).generation===generation&&this.authority.contextVersion(event)===context&&!this.authority.draftFor(event.id),'AUTO_RESULT_STALE');
          const draftId=randomUUID();
          this.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId,event.id,result.text,result.model);
          this.store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_POLICY',?,?,?)").run(draftId,result.text,`policy:${grant.version}`,this.authority.now());
          this.store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(event.id);
          const params:SendParams={eventId:event.id,generation,draftId,draftVersion:1,text:result.text,contextVersion:context,selectionId};
          this.store.db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,?,?,'PREPARING',NULL,NULL,?)").run(commandId,event.id,
            this.authority.operator(token).id,digest(params),JSON.stringify(params),this.authority.now());
          this.store.db.prepare('INSERT INTO policy_commands VALUES(?,?,?)').run(commandId,grant.version,generation);
          this.store.db.prepare("UPDATE automation_jobs SET state='PREPARING',draft_version=1,command_id=?,updated_at=? WHERE event_id=?").run(commandId,this.authority.now(),event.id);
        }).immediate();
        await this.humanReplies.prepare(token,commandId);
        const command=this.authority.command(commandId);
        this.store.db.prepare('UPDATE automation_jobs SET state=?,reason=?,updated_at=? WHERE event_id=?').run(command.status,command.reason,this.authority.now(),event.id);
      }finally{this.authority.revoke(token);}
    }catch(error){
      const code=clientError(error);
      const paid=this.store.db.prepare("SELECT job_key FROM grant_reservations WHERE grant_version=? AND kind='MODEL' AND job_key=?").get(grant.version,event.id);
      if(automaticSignal.aborted&&!paid)this.store.db.prepare("DELETE FROM automation_jobs WHERE event_id=? AND command_id IS NULL AND state IN ('QUALIFYING','GENERATING')").run(event.id);
      else this.store.db.prepare("UPDATE automation_jobs SET state='REVIEW',reason=?,updated_at=? WHERE event_id=?").run(code,this.authority.now(),event.id);
      if(collectionStops.has(code)){this.automation.stop(true);this.collector?.cancel();this.modelAbort.abort();this.modelAbort=new AbortController();}
      this.store.audit('AUTO_REPLY_STOPPED',event.id);
    }finally{this.modelPending.delete(event.id);this.inboxRevision++;this.emit('inbox_updated');}
  }
  private async deliver(
    token: string,
    id: string,
    p: SendParams,
  ): Promise<void> {
    let dispose = () => {};
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
    } catch (error) {
      const intent = this.store.db
        .prepare("SELECT id,status FROM send_intents WHERE event_id=?")
        .get(p.eventId) as { id: string; status: string } | undefined;
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
    if(!this.automation)this.store.db.prepare("UPDATE client_state SET paused=1 WHERE id=1").run();
    await this.drain();
    await this.browser.close();
  }
}
