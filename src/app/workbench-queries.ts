import { isStrong, targetKey, type Channel } from '../core/contracts.js';
import type { EventStore } from '../storage/store.js';
import type { AutomationStore } from '../storage/automation-store.js';
import type { WorkbenchAuthority } from './authority.js';
import type { BrowserService } from './browser-service.js';
import type { AiSettings, InboxSync, ClientCommand } from './contracts.js';
import type { CollectionScheduler } from './collection-scheduler.js';
import {InboxQueries,inboxGroupKey} from './inbox-queries.js';
import {humanReplyEligibility} from './manual-reply-eligibility.js';
import {readCommentThreadContext,commentThreadPage} from '../storage/comment-thread-context.js';

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

  thread(token: string, eventId: string, automation: AutomationStore | null,timelineBefore?:string) {
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
    const frozen = this.store.sendFrozen(e.id);
    return {
      event: e,
      groupKey:inboxGroupKey(e),
      timeline:new InboxQueries(this.store,this.browser.root,(id,status)=>this.replyStatus(id,status)).timeline(e,e.payload.kind==='REPLY'?undefined:timelineBefore),
      draft,
      history: this.store.history(e.payload),
      ...(e.payload.channel==='COMMENT_NOTIFICATION'&&e.payload.kind==='REPLY'?{
        commentContext:commentThreadPage(readCommentThreadContext(this.store,e.payload),timelineBefore)}:{}),
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
      humanReplyEligibility:humanReplyEligibility(this.store,e),
      replyStatus:this.replyStatus(e.id,e.status),
      conversationReplyStatus:new InboxQueries(this.store,this.browser.root,(id,status)=>this.replyStatus(id,status)).conversationReplyStatus(e),
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
    const needsSendCapability=['MANUAL','AI_ASSISTED'].includes(configuredMode);
    const anySendAvailable=!needsSendCapability||( ['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as Channel[]).some(channel=>
      this.authority.capability(channel,this.browser.identity(channel)).state==='SEND_AVAILABLE')||
      (this.store.db.prepare(`SELECT t.event_id,d.id,d.version,d.text,e.channel FROM controlled_trials t
        JOIN reply_drafts d ON d.event_id=t.event_id JOIN inbound_events e ON e.id=t.event_id
        WHERE t.used=0 AND t.expires_at>? AND t.draft_id=d.id AND t.draft_version=d.version`).all(this.authority.now()) as
        {event_id:string;id:string;version:number;text:string;channel:Channel}[]).some(row=>
          this.authority.trialAvailable(row.event_id,row.id,row.version,row.text,this.browser.identity(row.channel)));
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
      budgets: this.store.budgets(),
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
        unresolvedSends:this.store.db.prepare(`SELECT e.channel,count(*) AS count FROM send_intents i
          JOIN inbound_events e ON e.id=i.event_id WHERE i.status IN ('INTENT_RECORDED','UNCERTAIN')
          AND COALESCE((SELECT v.verified FROM verification_results v WHERE v.intent_id=i.id ORDER BY v.rowid DESC LIMIT 1),0)<>1 GROUP BY e.channel`).all(),
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
    return new InboxQueries(this.store,this.browser.root,(id,status)=>this.replyStatus(id,status)).inbox(c);
  }
}
