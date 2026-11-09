import { isStrong, targetKey, type Channel } from '../core/contracts.js';
import type { EventStore } from '../storage/store.js';
import type { AutomationStore } from '../storage/automation-store.js';
import type { WorkbenchAuthority } from './authority.js';
import type { BrowserService } from './browser-service.js';
import type { AiSettings, InboxSync, ClientCommand } from './contracts.js';
import type { CollectionScheduler } from './collection-scheduler.js';

interface ViewState {
  settings: AiSettings;
  keyPresent: boolean;
  keyStored: boolean;
  keyStorageError: string | null;
  modelAuthorized: boolean;
  modelBusy: boolean;
  automation: AutomationStore | null;
  collector: ReturnType<CollectionScheduler['status']> | undefined;
  inboxRevision: number;
  sync: InboxSync;
}

/** Read-only product views; raw intents, receipts and freezes remain authoritative. */
export class WorkbenchQueries {
  constructor(readonly store: EventStore, readonly authority: WorkbenchAuthority, readonly browser: BrowserService) {}
  replyStatus(eventId:string,status:string):'WAITING'|'REPLIED' {
    const latest=this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='verification_results'").get()?this.store.db.prepare(`SELECT r.verified FROM verification_results r JOIN send_intents i ON i.id=r.intent_id
      WHERE i.event_id=? ORDER BY r.rowid DESC LIMIT 1`).get(eventId) as {verified:number}|undefined:undefined;
    return latest?latest.verified===1?'REPLIED':'WAITING':status==='CONFIRMED'?'REPLIED':'WAITING';
  }

  thread(token: string, eventId: string, automation: AutomationStore | null) {
    const op = this.authority.operator(token),
      e = this.store.event(eventId),
      draft = this.authority.draftFor(eventId);
    const owner = this.authority.ownership(e),
      identity = this.browser.identity(e.payload.channel);
    const suggestions = this.store.db
      .prepare(
        "SELECT id,text,model,draft_version,context_version,created_at FROM ai_suggestions WHERE event_id=? AND dismissed=0 ORDER BY created_at DESC LIMIT 5",
      )
      .all(eventId);
    const intent =
      this.store.db
        .prepare("SELECT id,status FROM send_intents WHERE event_id=?")
        .get(eventId) ?? null;
    const paused = Boolean(
      (
        this.store.db
          .prepare("SELECT paused FROM pauses WHERE target_key=?")
          .get(targetKey(e.payload)) as { paused: number } | undefined
      )?.paused,
    );
    const frozen = !!this.store.db
      .prepare(
        "SELECT id FROM send_intents WHERE target_key=? AND status IN ('INTENT_RECORDED','UNCERTAIN')",
      )
      .get(targetKey(e.payload));
    return {
      event: e,
      draft,
      history: this.store.history(e.payload),
      ownership: { ...owner, isMine: owner.operator_id === op.id },
      contextVersion: this.authority.contextVersion(e),
      capability: this.authority.capability(e.payload.channel, identity),
      controlledTrial:
        !!draft &&
        this.authority.trialAvailable(
          e.id,
          draft.id,
          draft.version,
          draft.text,
          identity,
        ),
      strong: isStrong(e.payload),
      replyStatus:this.replyStatus(e.id,e.status),
      paused,
      frozen,
      intent,
      receipt: this.store.receiptForEvent(eventId) ?? null,
      suggestions,
      verification:automation?this.store.db.prepare(`SELECT j.state,j.attempts,j.last_error,r.verified,r.evidence_ref,r.checked_at FROM verification_jobs j
        LEFT JOIN verification_results r ON r.intent_id=j.intent_id WHERE j.event_id=? ORDER BY r.rowid DESC LIMIT 1`).get(eventId)??null:null,
      automationJob:automation?this.store.db.prepare('SELECT state,reason,grant_version FROM automation_jobs WHERE event_id=?').get(eventId)??null:null,
    };
  }

  status(token: string, state: ViewState) {
    const { automation } = state;
    const op = this.authority.operator(token);
    const configuredMode=this.authority.mode();
    const anySendAvailable=(['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as Channel[]).some(channel=>
      this.authority.capability(channel,this.browser.identity(channel)).state==='SEND_AVAILABLE')||
      this.store.events().some(event=>{const draft=this.authority.draftFor(event.id);return draft&&this.authority.trialAvailable(event.id,draft.id,draft.version,draft.text,this.browser.identity(event.payload.channel));});
    const effectiveMode=['MANUAL','AI_ASSISTED'].includes(configuredMode)&&!anySendAvailable?'DRAFT_ONLY':configuredMode;
    const account = this.store.db
      .prepare("SELECT own_id FROM accounts WHERE id=?")
      .get("account_001") as { own_id: string } | undefined;
    return {
      runtime: this.browser.root,
      account: account ? { id: "account_001", identity: account.own_id } : null,
      operator: {
        id: op.id,
        permissions: op.permissions,
        expiresAt: op.expires_at,
      },
      mode: effectiveMode,
      configuredMode,
      paused: this.authority.paused(),
      browser: this.browser.status(),
      lastSync: this.store.db
        .prepare(
          "SELECT channel,MAX(observed_at) AS at FROM observations GROUP BY channel",
        )
        .all(),
      capabilities: (
        ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as Channel[]
      ).map((channel) => ({
        channel,
        ...this.authority.capability(channel, this.browser.identity(channel)),
      })),
      budgets: this.store.db.prepare("SELECT * FROM budgets").all(),
      usage: this.store.db
        .prepare(
          `SELECT count(*) AS requests,
        COALESCE(sum(input_tokens),0) AS inputTokens,COALESCE(sum(output_tokens),0) AS outputTokens,
        COALESCE(sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END),0) AS unresolved FROM model_calls`,
        )
        .get(),
      settings: state.settings,
      keyPresent: state.keyPresent,
      keyStored:state.keyStored,keyStorageError:state.keyStorageError,
      modelAuthorized: state.modelAuthorized || automation?.active('MODEL')?.scope.model===state.settings.model,
      automation:automation?{
        ...automation.state(),modelGrant:automation.active('MODEL'),replyPolicy:automation.active('AUTO_REPLY'),
        collector:state.collector,inboxRevision:state.inboxRevision,
        pendingWorks:this.store.db.prepare("SELECT count(*) AS count FROM discovered_works WHERE state='REVIEW'").get(),
        autoStopReason:configuredMode==='LIMITED_AUTO'&&automation.active('AUTO_REPLY')?(!state.keyPresent?'MODEL_KEY_REQUIRED':!automation.allowance(automation.active('AUTO_REPLY')!.version,'SEND')?'SEND_GRANT_EXHAUSTED':
          !automation.allowance(automation.active('AUTO_REPLY')!.version,'MODEL')?'MODEL_GRANT_EXHAUSTED':this.authority.paused()?'ACCOUNT_PAUSED':null):null,
      }:null,
      modelBusy: state.modelBusy,
      sync:structuredClone(state.sync),
      go: "UNVERIFIED",
      schema: 3,
    };
  }

  inbox(c: Extract<ClientCommand, {command:'getInbox'}>) {
    const filter =
      c.status === "PENDING"
        ? null
        : c.status === "REVIEW"
          ? ["MANUAL_REVIEW"]
          : c.status === "UNCERTAIN"
            ? ["UNCERTAIN", "INTENT_RECORDED"]
            : c.status === "CONFIRMED"
              ? ["CONFIRMED"]
              : null;
    const events = this.store
      .events()
      .filter(
        (e) =>
          e.status !== "BASELINE" &&
          (c.channel === "ALL" || e.payload.channel === c.channel) &&
          (c.status==='PENDING'?this.replyStatus(e.id,e.status)==='WAITING':c.status==='CONFIRMED'?this.replyStatus(e.id,e.status)==='REPLIED':!filter||filter.includes(e.status)),
      )
      .reverse();
    return {
      total: events.length,
      page: c.page,
      pageSize: 20,
      items: events.slice(c.page * 20, c.page * 20 + 20).map((e) => ({
        id: e.id,
        status: e.status,
        replyStatus:this.replyStatus(e.id,e.status),
        channel: e.payload.channel,
        author: e.payload.actorName,
        preview: e.payload.text,
        time: e.payload.occurredAt,
        source:
          e.payload.discovery ??
          (e.payload.channel === "DIRECT_MESSAGE"
            ? "DIRECT_MESSAGE"
            : "NOTIFICATION"),
      })),
    };
  }
}
