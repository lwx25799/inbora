import { ChannelAuthority, type CapabilityIdentity } from './channel-authority.js';
export type { CapabilityIdentity } from './channel-authority.js';
import { randomBytes, randomUUID } from "node:crypto";
import {
  digest,
  requireSafe,
  isStrong,
  validManualMediaProof,
  targetKey,
  validText,
  type StoredEvent,
  type TargetSnapshot,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import type { SendParams, Mode } from "./contracts.js";
import { AutomationStore } from "../storage/automation-store.js";
import type { Grant, ReplyPolicy } from "./automation-contracts.js";
import {humanReplyEligibility} from './manual-reply-eligibility.js';
import {LocalAssistantStore} from '../storage/local-assistant-store.js';

export type Permission = "READ" | "EDIT" | "APPROVE" | "SEND" | "CONTROL";
interface Operator {
  id: string;
  permissions: Permission[];
  expires_at: number;
}
export interface Ownership {
  operator_id: string | null;
  generation: number;
  lease_expires_at: number;
}
export interface CommandRow {
  command_id: string;
  event_id: string;
  operator_id: string;
  params_digest: string;
  params: string;
  status: string;
  intent_id: string | null;
  reason: string | null;
  created_at: number;
}

/** Shared authority for CLI and desktop. Only trusted local entrypoints issue sessions or attest capability. */
export class WorkbenchAuthority {
  private readonly channels: ChannelAuthority;
  readonly assistant:LocalAssistantStore;
  private selection = new Map<
    string,
    { eventId: string | null; selectionId: string }
  >();
  constructor(
    readonly store: EventStore,
    readonly now: () => number = Date.now,
  ) {
    this.channels = new ChannelAuthority(store,now);
    this.assistant=new LocalAssistantStore(store,now);
    requireSafe(
      store.db.pragma("user_version", { simple: true }) === 3,
      "CLIENT_MIGRATION_REQUIRED",
    );
  }
  issueSession(
    permissions: Permission[] = ["READ", "EDIT", "APPROVE", "SEND", "CONTROL"],
  ): string {
    const token = randomBytes(32).toString("hex"),
      id = randomUUID();
    this.store.db
      .prepare("INSERT INTO operator_sessions VALUES(?,?,?,?)")
      .run(
        id,
        digest(token),
        JSON.stringify(permissions),
        this.now() + 8 * 3600_000,
      );
    return token;
  }
  issueAssistantSession(grantVersion:number):string {
    return this.store.db.transaction(()=>{
      const token=this.issueSession();this.assistant.bindSession(this.operator(token).id,grantVersion);return token;
    }).immediate();
  }
  assistantVersion(token:string):number|null {return this.assistant.session(this.operator(token).id);}
  checkAssistantModel(token:string,event:StoredEvent,checkAllowance=true):void {
    const version=this.assistantVersion(token);if(version===null)return;
    this.assistant.requireEvent('read',event,version);this.assistant.requireEvent('editControl',event,version);this.assistant.requireText(event);
    if(checkAllowance)requireSafe(this.assistant.allowance(version,'MODEL'),'ASSISTANT_MODEL_EXHAUSTED');
  }
  reserveAssistantModel(token:string,event:StoredEvent,jobKey:string):void {
    const version=this.assistantVersion(token);if(version!==null)this.assistant.reserve(version,'MODEL',jobKey,event);
  }
  private checkAssistantEdit(token:string,event:StoredEvent):void {
    const version=this.assistantVersion(token);if(version===null)return;
    this.assistant.requireEvent('read',event,version);this.assistant.requireEvent('editControl',event,version);
  }
  operator(token: string, permission: Permission = "READ"): Operator {
    const row = this.store.db
      .prepare(
        "SELECT id,permissions,expires_at FROM operator_sessions WHERE token_digest=?",
      )
      .get(digest(token)) as
      { id: string; permissions: string; expires_at: number } | undefined;
    requireSafe(row && row.expires_at > this.now(), "OPERATOR_EXPIRED");
    const result = {
      ...row,
      permissions: JSON.parse(row.permissions) as Permission[],
    };
    if (!result.permissions.includes(permission))
      this.store.audit(
        "OPERATOR_PERMISSION_DENIED",
        digest([row.id, permission]),
      );
    requireSafe(
      result.permissions.includes(permission),
      "OPERATOR_PERMISSION_DENIED",
    );
    return result;
  }
  revoke(token: string): void {
    this.store.db
      .prepare("UPDATE operator_sessions SET expires_at=0 WHERE token_digest=?")
      .run(digest(token));
    this.selection.delete(digest(token));
  }
  /** Only the authenticated desktop parent calls this; stop-only sessions cannot be promoted. */
  renewTrustedSession(token:string):void {
    const row=this.store.db.prepare('SELECT permissions FROM operator_sessions WHERE token_digest=?').get(digest(token)) as {permissions:string}|undefined;
    requireSafe(row,'OPERATOR_EXPIRED');
    const permissions=JSON.parse(row.permissions) as Permission[];
    requireSafe(['READ','EDIT','APPROVE','SEND','CONTROL'].every(p=>permissions.includes(p as Permission)),'OPERATOR_PERMISSION_DENIED');
    this.store.db.prepare('UPDATE operator_sessions SET expires_at=? WHERE token_digest=?').run(this.now()+8*3600_000,digest(token));
  }
  select(token: string, eventId: string | null, selectionId: string): void {
    const op = this.operator(token);
    if (eventId) this.store.event(eventId);
    const old = this.selection.get(digest(token));
    if (old && (old.eventId !== eventId || old.selectionId !== selectionId))
      this.store.db
        .transaction(() => {
          this.store.db
            .prepare(
              `UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='TARGET_SELECTION_CHANGED'
        WHERE operator_id=? AND intent_id IS NULL AND status IN ('PREPARING','PREVIEW','QUEUED','PREFLIGHT')`,
            )
            .run(op.id);
          if (old.eventId) this.invalidate(this.store.event(old.eventId));
        })
        .immediate();
    this.selection.set(digest(token), { eventId, selectionId });
  }
  ownership(e: StoredEvent): Ownership {
    return (
      (this.store.db
        .prepare(
          "SELECT operator_id,generation,lease_expires_at FROM thread_ownership WHERE account_id=? AND channel=? AND target_key=?",
        )
        .get(e.payload.accountId, e.payload.channel, targetKey(e.payload)) as
        Ownership | undefined) ?? {
        operator_id: null,
        generation: 0,
        lease_expires_at: 0,
      }
    );
  }
  requireSelection(token:string,eventId:string,selectionId:string):void {
    const selection=this.selection.get(digest(token));
    requireSafe(selection?.eventId===eventId&&selection.selectionId===selectionId,'TARGET_SELECTION_CHANGED');
  }
  selectionId(token:string,eventId:string):string {
    this.operator(token);const selected=this.selection.get(digest(token));
    requireSafe(selected?.eventId===eventId,'TARGET_SELECTION_CHANGED');return selected.selectionId;
  }
  private writeOwner(
    e: StoredEvent,
    operator: string | null,
    generation: number,
    expiry: number,
  ): void {
    this.store.db
      .prepare(
        `INSERT INTO thread_ownership VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,channel,target_key)
      DO UPDATE SET operator_id=excluded.operator_id,generation=excluded.generation,lease_expires_at=excluded.lease_expires_at`,
      )
      .run(
        e.payload.accountId,
        e.payload.channel,
        targetKey(e.payload),
        operator,
        generation,
        expiry,
      );
  }
  private invalidate(e: StoredEvent): void {
    const drafts = this.store.db
      .prepare(
        `SELECT d.id FROM reply_drafts d JOIN inbound_events e ON e.id=d.event_id
      WHERE e.target_key=? AND d.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id)`,
      )
      .all(targetKey(e.payload)) as { id: string }[];
    for (const d of drafts) this.store.invalidateApproval(d.id);
  }
  claim(token: string, eventId: string, expected: number): Ownership {
    const op = this.operator(token, "EDIT"),
      e = this.store.event(eventId);
    this.checkAssistantEdit(token,e);
    return this.store.db
      .transaction(() => {
        const old = this.ownership(e);
        requireSafe(old.generation === expected, "OWNERSHIP_CHANGED");
        requireSafe(
          !old.operator_id ||
            old.operator_id === op.id ||
            old.lease_expires_at <= this.now(),
          "OTHER_OPERATOR_OWNS",
        );
        this.writeOwner(e, op.id, old.generation + 1, this.now() + 120_000);
        if (this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_human_pauses'").get())
          this.store.db.prepare("INSERT INTO automation_human_pauses VALUES(?,1) ON CONFLICT(target_key) DO UPDATE SET paused=1").run(targetKey(e.payload));
        this.invalidate(e);
        this.store.audit(
          "HUMAN_CLAIMED",
          digest([op.id, targetKey(e.payload)]),
        );
        return this.ownership(e);
      })
      .immediate();
  }
  requireOwner(token: string, e: StoredEvent, generation: number): Operator {
    const op = this.operator(token, "EDIT"),
      o = this.ownership(e);
    requireSafe(
      o.operator_id === op.id &&
        o.generation === generation &&
        o.lease_expires_at > this.now(),
      "LEASE_EXPIRED_OR_CHANGED",
    );
    return op;
  }
  renew(token: string, eventId: string, generation: number): Ownership {
    const e = this.store.event(eventId),
      op = this.operator(token, "EDIT");
    this.checkAssistantEdit(token,e);
    return this.store.db
      .transaction(() => {
        const updated = this.store.db
          .prepare(
            `UPDATE thread_ownership SET lease_expires_at=? WHERE account_id=? AND channel=? AND target_key=?
        AND operator_id=? AND generation=? AND lease_expires_at>?`,
          )
          .run(
            this.now() + 120_000,
            e.payload.accountId,
            e.payload.channel,
            targetKey(e.payload),
            op.id,
            generation,
            this.now(),
          );
        requireSafe(updated.changes === 1, "LEASE_EXPIRED_OR_CHANGED");
        return this.ownership(e);
      })
      .immediate();
  }
  release(token: string, eventId: string, generation: number): void {
    const e = this.store.event(eventId);
    this.store.db
      .transaction(() => {
        this.requireOwner(token, e, generation);
        this.writeOwner(e, null, generation + 1, 0);
        this.invalidate(e);
        this.store.audit("HUMAN_RELEASED", digest(targetKey(e.payload)));
      })
      .immediate();
  }
  contextVersion(e: StoredEvent): string {
    const collisions = this.store.db
      .prepare(
        "SELECT binding FROM source_collisions WHERE event_id=? ORDER BY rowid",
      )
      .all(e.id);
    return digest([e.binding, this.store.history(e.payload), collisions]);
  }
  resumeAutomation(token: string, eventId: string): void {
    this.operator(token, "CONTROL");
    const e = this.store.event(eventId);
    this.store.db.transaction(() => {
      requireSafe(!this.store.sendFrozen(e.id), "TARGET_FROZEN");
      this.store.pause(targetKey(e.payload),false);
      const owner = this.ownership(e);
      this.writeOwner(e, null, owner.generation + 1, 0);
      this.invalidate(e);
      this.store.db.prepare("INSERT INTO automation_human_pauses VALUES(?,0) ON CONFLICT(target_key) DO UPDATE SET paused=0").run(targetKey(e.payload));
      this.store.audit("TARGET_AUTOMATION_RESUMED", digest(targetKey(e.payload)));
    }).immediate();
  }
  resumeIdleAutomation():void {
    this.store.db.transaction(()=>{
      const seen=new Set<string>();
      for(const event of this.store.events()){
        const key=targetKey(event.payload);if(seen.has(key))continue;seen.add(key);
        if(!this.store.events().some(next=>targetKey(next.payload)===key&&!this.store.sendFrozen(next.id)))continue;
        this.store.pause(key,false);
        const owner=this.ownership(event);
        if(!owner.operator_id||owner.lease_expires_at<=this.now()){
          this.writeOwner(event,null,owner.generation+1,0);this.invalidate(event);
        }
        this.store.db.prepare('DELETE FROM automation_human_pauses WHERE target_key=?').run(key);
      }
    }).immediate();
  }
  draftFor(eventId: string) {
    const row = this.store.db
      .prepare("SELECT id FROM reply_drafts WHERE event_id=?")
      .get(eventId) as { id: string } | undefined;
    if (!row) return null;
    const draft = this.store.draft(row.id);
    const revision = this.store.db
      .prepare(
        "SELECT origin FROM draft_revisions WHERE draft_id=? AND version=?",
      )
      .get(draft.id, draft.version) as { origin: string } | undefined;
    return { ...draft, origin: revision?.origin ?? "LEGACY" };
  }
  save(
    token: string,
    eventId: string,
    generation: number,
    expectedVersion: number,
    text: string,
    suggestionId: string | null = null,
  ) {
    text = text.replace(/\r\n?/gu, "\n");
    if (text) validText(text);
    const e = this.store.event(eventId),
      op = this.requireOwner(token, e, generation);
    const assistantVersion=this.assistant.session(op.id);
    if(assistantVersion!==null){this.assistant.requireEvent('read',e,assistantVersion);this.assistant.requireEvent('editControl',e,assistantVersion);}
    requireSafe(this.mode() !== "OBSERVE", "OBSERVE_READ_ONLY");
    return this.store.db
      .transaction(() => {
        this.requireOwner(token, e, generation);
        const old = this.draftFor(eventId);
        requireSafe(
          (old?.version ?? 0) === expectedVersion,
          "DRAFT_VERSION_CONFLICT",
        );
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
          !this.store.db
            .prepare("SELECT id FROM send_intents WHERE event_id=?")
            .get(eventId),
          "INTENT_EXISTS",
        );
        let origin = assistantVersion===null?"HUMAN_TYPED":"MCP_ASSISTED";
        if (suggestionId) {
          const suggestion = this.store.db
            .prepare("SELECT event_id,dismissed FROM ai_suggestions WHERE id=?")
            .get(suggestionId) as
            { event_id: string; dismissed: number } | undefined;
          requireSafe(
            suggestion?.event_id === eventId && !suggestion.dismissed,
            "SUGGESTION_NOT_AVAILABLE",
          );
          if(assistantVersion===null)origin = "AI_ASSISTED_APPROVED";
        }
        const id = old?.id ?? randomUUID(),
          version = expectedVersion + 1;
        this.store.db
          .prepare(
            `INSERT INTO reply_drafts(id,event_id,text,model,version,status,approval,approved_at)
        VALUES(?,?,?,?,?,'DRAFT',NULL,NULL) ON CONFLICT(event_id) DO UPDATE SET text=excluded.text,model=excluded.model,
        version=excluded.version,status='DRAFT',approval=NULL,approved_at=NULL`,
          )
          .run(id, eventId, text, origin, version);
        if (e.status !== "MANUAL_REVIEW")
          this.store.db
            .prepare(
              "UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?",
            )
            .run(eventId);
        this.store.db
          .prepare("INSERT INTO draft_revisions VALUES(?,?,?,?,?,?)")
          .run(id, version, origin, text, op.id, this.now());
        this.store.audit(assistantVersion===null?"HUMAN_DRAFT_SAVED":"ASSISTANT_DRAFT_SAVED", id, { version });
        return this.draftFor(eventId)!;
      })
      .immediate();
  }
  mode(): Mode {
    return (
      this.store.db
        .prepare("SELECT mode FROM client_state WHERE id=1")
        .get() as { mode: Mode }
    ).mode;
  }
  paused(): boolean {
    return !!(
      this.store.db
        .prepare("SELECT paused FROM client_state WHERE id=1")
        .get() as { paused: number }
    ).paused;
  }
  pause(token: string, eventId: string | null, paused: boolean): void {
    this.operator(token, "CONTROL");
    this.store.db
      .transaction(() => {
        const events = eventId
          ? [this.store.event(eventId)]
          : this.store.events();
        if (!eventId)
          this.store.db
            .prepare("UPDATE client_state SET paused=? WHERE id=1")
            .run(Number(paused));
        const seen = new Set<string>();
        for (const e of events) {
          const key = targetKey(e.payload);
          if (seen.has(key)) continue;
          seen.add(key);
          if (eventId) this.store.pause(key, paused);
          if (paused && !eventId) {
            const o = this.ownership(e);
            this.writeOwner(e, null, o.generation + 1, 0);
            this.invalidate(e);
          }
        }
        this.store.audit(
          paused ? "ACCOUNT_STOPPED" : "ACCOUNT_RESUMED",
          "account_001",
        );
      })
      .immediate();
  }
  setMode(token: string, mode: Mode): void {
    this.operator(token, "CONTROL");
    if (mode === "LIMITED_AUTO")requireSafe(this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_grants'").get()&&
      this.store.db.prepare("SELECT version FROM automation_grants WHERE kind='AUTO_REPLY' AND revoked_at IS NULL").get(),'AUTO_POLICY_REQUIRED');
    if (!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_schema'").get()&&(mode === "MANUAL" || mode === "AI_ASSISTED"))
      requireSafe(
        this.store.db
          .prepare(
            "SELECT channel FROM channel_capabilities WHERE state='SEND_AVAILABLE' AND expires_at>? LIMIT 1",
          )
          .get(this.now()) ||
          this.store.db
            .prepare(
              "SELECT event_id FROM controlled_trials WHERE used=0 AND expires_at>? LIMIT 1",
            )
            .get(this.now()),
        "CAPABILITY_UNVERIFIED",
      );
    this.store.db
      .prepare("UPDATE client_state SET mode=? WHERE id=1")
      .run(mode);
    if (mode === "OBSERVE" || mode === "DRAFT_ONLY")
      for (const e of this.store.events()) this.invalidate(e);
    this.store.audit("MODE_CHANGED", digest(mode));
  }
  attest(...args: Parameters<ChannelAuthority['attest']>): void { this.channels.attest(...args); }
  calibrateTrial(...args: Parameters<ChannelAuthority['calibrateTrial']>): void { this.channels.calibrateTrial(...args); }
  trialAvailable(...args: Parameters<ChannelAuthority['trialAvailable']>): boolean { return this.channels.trialAvailable(...args); }
  completeTrial(...args: Parameters<ChannelAuthority['completeTrial']>): void { this.channels.completeTrial(...args); }
  capability(...args: Parameters<ChannelAuthority['capability']>) { return this.channels.capability(...args); }
  assertCanSend(
    token: string,
    p: SendParams,
    identity: CapabilityIdentity | null,
    allowApproved = false,
    commandId = "",
    qualifying = false,
  ): void {
    this.operator(token, "APPROVE");
    this.operator(token, "SEND");
    const e = this.store.event(p.eventId);
    this.assistant.requireSend(this.operator(token).id,e);
    const policy=this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='policy_commands'").get()&&commandId?
      this.store.db.prepare('SELECT grant_version,ownership_generation FROM policy_commands WHERE command_id=?').get(commandId) as {grant_version:number;ownership_generation:number}|undefined:null;
    if(policy) {
      const auto=new AutomationStore(this.store,this.now),grant=auto.active('AUTO_REPLY') as Grant<ReplyPolicy>|null;
      requireSafe(grant?.version===policy.grant_version&&auto.policyMatches(grant,e,'DRAFT'),'POLICY_NO_LONGER_AUTHORIZED');
      requireSafe(this.ownership(e).generation===policy.ownership_generation&&p.generation===policy.ownership_generation,'OWNERSHIP_CHANGED');
    }else {
      this.requireOwner(token, e, p.generation);
      this.requireSelection(token,p.eventId,p.selectionId);
    }
    requireSafe(!this.paused(), "ACCOUNT_PAUSED");
    requireSafe(
      !this.store.db
        .prepare(
          "SELECT command_id FROM manual_send_commands WHERE event_id=? AND status IN ('PREPARING','QUEUED','PREFLIGHT','SENDING') AND command_id<>? LIMIT 1",
        )
        .get(p.eventId, commandId),
      "COMMAND_ALREADY_QUEUED",
    );
    requireSafe(
      ["MANUAL", "AI_ASSISTED", "LIMITED_AUTO"].includes(this.mode()),
      "MODE_DRAFT_ONLY",
    );
    const capability = this.capability(e.payload.channel, identity);
    requireSafe(
      qualifying || capability.state === "SEND_AVAILABLE" ||
        (capability.state === "SEND_REVIEW_ONLY" &&
          this.trialAvailable(
            p.eventId,
            p.draftId,
            p.draftVersion,
            p.text,
            identity,
          )),
      capability.reason,
    );
    const manualMedia=!isStrong(e.payload)&&!policy&&!!commandId&&humanReplyEligibility(this.store,e).eligible&&
      !!this.store.db.prepare('SELECT command_id FROM manual_send_inputs WHERE command_id=?').get(commandId)&&
      this.command(commandId).operator_id===this.operator(token).id&&this.command(commandId).params_digest===digest(p);
    requireSafe(
      (isStrong(e.payload)||manualMedia) &&
        ["AWAITING_APPROVAL", ...(allowApproved ? ["APPROVED"] : [])].includes(
          e.status,
        )||manualMedia&&e.status==='MANUAL_REVIEW',
      "TARGET_NEEDS_REVIEW",
    );
    requireSafe(
      !(
        this.store.db
          .prepare("SELECT paused FROM pauses WHERE target_key=?")
          .get(targetKey(e.payload)) as { paused: number } | undefined
      )?.paused,
      "TARGET_PAUSED",
    );
    requireSafe(
      !this.store.sendFrozen(e.id),
      "TARGET_FROZEN",
    );
    requireSafe(
      !this.store.db
        .prepare("SELECT id FROM send_intents WHERE event_id=?")
        .get(e.id),
      "INTENT_EXISTS",
    );
    const d = this.draftFor(e.id);
    requireSafe(
      d &&
        d.id === p.draftId &&
        d.version === p.draftVersion &&
        d.text === p.text,
      "DRAFT_VERSION_CONFLICT",
    );
    validText(d.text);
    requireSafe(
      this.contextVersion(e) === p.contextVersion,
      "CONTEXT_VERSION_CONFLICT",
    );
  }
  preview(
    token: string,
    p: SendParams,
    snapshot: TargetSnapshot,
    identity: CapabilityIdentity | null,
  ): { commandId: string; expiresAt: number } {
    return this.store.db
      .transaction(() => {
        this.assertCanSend(token, p, identity);
        const op = this.operator(token, "APPROVE");
        requireSafe(
          snapshot.eventBinding === this.store.event(p.eventId).binding &&
            snapshot.targetKey ===
              targetKey(this.store.event(p.eventId).payload),
          "TARGET_CHANGED",
        );
        const id = randomUUID(),
          expires = this.now() + 60_000;
        this.store.db
          .prepare(
            "UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='PREVIEW_REPLACED' WHERE event_id=? AND status='PREVIEW'",
          )
          .run(p.eventId);
        this.store.db
          .prepare("INSERT INTO manual_send_commands VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            p.eventId,
            op.id,
            digest(p),
            JSON.stringify(p),
            "PREVIEW",
            null,
            null,
            this.now(),
          );
        this.store.db
          .prepare("INSERT INTO client_approvals VALUES(?,?,?,?)")
          .run(id, p.draftId, JSON.stringify(snapshot), expires);
        return { commandId: id, expiresAt: expires };
      })
      .immediate();
  }
  command(id: string): CommandRow {
    const row = this.store.db
      .prepare("SELECT * FROM manual_send_commands WHERE command_id=?")
      .get(id) as CommandRow | undefined;
    requireSafe(row, "COMMAND_NOT_FOUND");
    return row;
  }
  approvePreparedCommand(token:string,id:string,snapshot:TargetSnapshot,identity:CapabilityIdentity|null):void {
    this.store.db.transaction(()=>{
      const row=this.command(id),params=JSON.parse(row.params) as SendParams;
      requireSafe(row.status==='PREPARING','COMMAND_NOT_QUEUED');
      this.assertCanSend(token,params,identity,false,id);
      requireSafe(snapshot.eventBinding===this.store.event(params.eventId).binding&&snapshot.targetKey===targetKey(this.store.event(params.eventId).payload),'TARGET_CHANGED');
      this.store.db.prepare('INSERT INTO client_approvals VALUES(?,?,?,?)').run(id,params.draftId,JSON.stringify(snapshot),this.now()+60_000);
      this.store.approve(params.draftId,snapshot,params.draftVersion,params.text,()=>this.assertManualMediaApproval(token,id,snapshot,identity));
      this.store.db.prepare("UPDATE manual_send_commands SET status='QUEUED' WHERE command_id=?").run(id);
      this.store.audit(this.store.db.prepare('SELECT command_id FROM policy_commands WHERE command_id=?').get(id)?'AUTO_POLICY_APPROVED':'MANUAL_SEND_APPROVED',id);
    }).immediate();
  }
  private assertManualMediaApproval(token:string,id:string,snapshot:TargetSnapshot,identity:CapabilityIdentity|null):void {
    const row=this.command(id),params=JSON.parse(row.params) as SendParams,event=this.store.event(params.eventId),approval=this.approval(id);
    requireSafe(!this.store.db.prepare('SELECT command_id FROM policy_commands WHERE command_id=?').get(id)&&
      !!this.store.db.prepare('SELECT command_id FROM manual_send_inputs WHERE command_id=?').get(id)&&row.intent_id===null&&
      ['PREPARING','QUEUED','PREFLIGHT'].includes(row.status)&&row.operator_id===this.operator(token).id&&row.params_digest===digest(params),
      'HUMAN_MEDIA_APPROVAL_REQUIRED');
    this.requireOwner(token,event,params.generation);this.requireSelection(token,event.id,params.selectionId);
    requireSafe(humanReplyEligibility(this.store,event).eligible&&this.draftFor(event.id)?.origin==='HUMAN_TYPED'&&
      this.contextVersion(event)===params.contextVersion&&approval.expires_at>this.now()&&digest(JSON.parse(approval.snapshot))===digest(snapshot)&&
      validManualMediaProof(event.payload,snapshot)&&identity?.identityDigest===digest(snapshot.ownId)&&
      this.capability(event.payload.channel,identity).evidence===`readonly-contract:${digest([snapshot,identity])}`,
      'HUMAN_MEDIA_APPROVAL_REQUIRED');
  }
  queue(
    token: string,
    id: string,
    p: SendParams,
    identity: CapabilityIdentity | null,
  ): boolean {
    this.operator(token, "SEND");
    this.operator(token, "APPROVE");
    this.operator(token, "EDIT");
    return this.store.db
      .transaction(() => {
        const row = this.command(id),
          op = this.operator(token, "SEND");
        requireSafe(
          row.operator_id === op.id && row.params_digest === digest(p),
          "COMMAND_PARAMETERS_CONFLICT",
        );
        if (row.status !== "PREVIEW") return false;
        this.assertCanSend(token, p, identity);
        const approval = this.approval(id);
        requireSafe(approval.expires_at > this.now(), "CONFIRMATION_EXPIRED");
        this.store.approve(
          p.draftId,
          JSON.parse(approval.snapshot) as TargetSnapshot,
          p.draftVersion,
          p.text,
        );
        this.store.db
          .prepare(
            "UPDATE manual_send_commands SET status='QUEUED' WHERE command_id=?",
          )
          .run(id);
        this.store.audit("MANUAL_SEND_APPROVED", id);
        return true;
      })
      .immediate();
  }
  approval(id: string): { snapshot: string; expires_at: number } {
    const a = this.store.db
      .prepare(
        "SELECT snapshot,expires_at FROM client_approvals WHERE command_id=?",
      )
      .get(id) as { snapshot: string; expires_at: number } | undefined;
    requireSafe(a, "APPROVAL_REQUIRED");
    return a;
  }
  dispatchGuard(
    token: string,
    id: string,
    identity: () => CapabilityIdentity | null,
  ) {
    return {
      manualMedia:()=>this.assertManualMediaApproval(token,id,JSON.parse(this.approval(id).snapshot) as TargetSnapshot,identity()),
      check: () => {
        const row = this.command(id);
        requireSafe(
          ["QUEUED", "PREFLIGHT"].includes(row.status),
          "COMMAND_NOT_QUEUED",
        );
        requireSafe(
          this.approval(id).expires_at > this.now(),
          "CONFIRMATION_EXPIRED",
        );
        this.assertCanSend(
          token,
          JSON.parse(row.params) as SendParams,
          identity(),
          true,
          id,
        );
        const snapshot=JSON.parse(this.approval(id).snapshot) as TargetSnapshot;
        if(snapshot.manualObservation)this.assertManualMediaApproval(token,id,snapshot,identity());
        this.store.db
          .prepare(
            "UPDATE manual_send_commands SET status='PREFLIGHT' WHERE command_id=?",
          )
          .run(id);
      },
      committed: (intentId: string) => {
        this.assistant.commitCommand(id,this.store.event(this.command(id).event_id));
        if(this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='policy_commands'").get()) {
          const policy=this.store.db.prepare('SELECT grant_version FROM policy_commands WHERE command_id=?').get(id) as {grant_version:number}|undefined;
          if(policy)new AutomationStore(this.store,this.now).reserve(policy.grant_version,'SEND',this.command(id).event_id);
        }
        this.store.db
          .prepare("UPDATE controlled_trials SET used=1 WHERE event_id=?")
          .run(this.command(id).event_id);
        this.store.db
          .prepare(
            "UPDATE manual_send_commands SET status='SENDING',intent_id=? WHERE command_id=?",
          )
          .run(intentId, id);
        if(this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='verification_jobs'").get()) {
          const intent=this.store.db.prepare('SELECT event_id,attempt_started_at,target_digest FROM send_intents WHERE id=?').get(intentId) as {event_id:string;attempt_started_at:string;target_digest:string};
          this.store.db.prepare("INSERT OR IGNORE INTO verification_jobs VALUES(?,?,?,?,0,?,?,'PENDING',NULL)")
            .run(intentId,intent.event_id,intent.attempt_started_at,intent.target_digest,this.now()+2000,this.now()+120_000);
        }
      },
    };
  }
  finish(id: string, status: string, reason: string | null = null): void {
    this.store.db
      .prepare(
        "UPDATE manual_send_commands SET status=?,reason=? WHERE command_id=?",
      )
      .run(status, reason, id);
  }
  recover(): void {
    this.store.recover();
    this.store.db
      .prepare(
        `UPDATE manual_send_commands SET status=COALESCE((SELECT status FROM send_intents WHERE id=intent_id),'FAILED_BEFORE_CLICK'),
      reason='RESTART_NO_REPLAY' WHERE status IN ('PREPARING','QUEUED','PREFLIGHT','SENDING','PREVIEW')`,
      )
      .run();
    this.expireOperators();
  }
  expireOperators(): void {
    this.store.db
      .transaction(() => {
        // Expiry invalidates each unsubmitted approval once, rather than re-scanning its target for every historical message.
        const drafts=this.store.db.prepare(`SELECT d.id FROM reply_drafts d JOIN inbound_events e ON e.id=d.event_id
          WHERE d.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id) ORDER BY d.rowid`)
          .all() as {id:string}[];
        for(const draft of drafts)this.store.invalidateApproval(draft.id);
        this.store.db
          .prepare(
            "UPDATE thread_ownership SET operator_id=NULL,generation=generation+1,lease_expires_at=0 WHERE operator_id IS NOT NULL",
          )
          .run();
        this.store.db
          .prepare("UPDATE operator_sessions SET expires_at=0")
          .run();
      })
      .immediate();
  }
}
