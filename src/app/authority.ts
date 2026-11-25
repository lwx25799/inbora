import type { ModelRouteGuard } from './model-route-guard.js';
import { ChannelAuthority, type CapabilityIdentity } from "./channel-authority.js";
export type { CapabilityIdentity } from "./channel-authority.js";
import { randomBytes, randomUUID } from "node:crypto";
import { bindSuggestionLearningToDraft } from "../knowledge/generation-context.js";
import {
  digest,
  requireSafe,
  targetKey,
  validText,
  type StoredEvent,
  type TargetSnapshot,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import type { SendParams, Mode } from "./contracts.js";
import { AutomationStore } from "../storage/automation-store.js";
import { LocalAssistantStore } from "../storage/local-assistant-store.js";
import {
  assertCanSendImpl,
  assertManualMediaApprovalImpl,
  expireOperatorsImpl,
  resumeIdleAutomationImpl,
  type AuthorityInternalHooks,
} from "./authority-guards.js";
import { cancelUnsubmittedFollowups } from "./followup-verification.js";
import type { AccountId } from "../contracts/account.js";

export type Permission = "READ" | "EDIT" | "APPROVE" | "SEND" | "CONTROL";
export interface Operator {
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

const sessionRenewalThresholdMs = 3600_000;

/** Shared authority for CLI and desktop. Only trusted local entrypoints issue sessions or attest capability. */
export class WorkbenchAuthority {
  private readonly channels: ChannelAuthority;
  readonly assistant: LocalAssistantStore;
  modelRoute: ModelRouteGuard | null = null;
  private selection = new Map<string, { eventId: string | null; selectionId: string }>();
  private readonly hooks: AuthorityInternalHooks;
  constructor(
    readonly store: EventStore,
    readonly now: () => number = Date.now,
    readonly accountId: AccountId = store.accountId,
  ) {
    store.assertAccount(accountId);
    this.channels = new ChannelAuthority(store, now);
    this.assistant = new LocalAssistantStore(store, now);
    const version = store.db.pragma("user_version", { simple: true });
    requireSafe(version === 3 || version === 4, "CLIENT_MIGRATION_REQUIRED");
    this.hooks = {
      writeOwner: (e, operator, generation, expiry) => this.writeOwner(e, operator, generation, expiry),
      invalidate: (e) => this.invalidate(e),
      pruneExpiredSelections: () => this.pruneExpiredSelections(),
    };
  }
  issueSession(permissions: Permission[] = ["READ", "EDIT", "APPROVE", "SEND", "CONTROL"]): string {
    const token = randomBytes(32).toString("hex"),
      id = randomUUID();
    const { db } = this.store;
    db.transaction(() => {
      db.prepare("INSERT INTO operator_sessions VALUES(?,?,?,?)")
        .run(id, digest(token), JSON.stringify(permissions), this.now() + 8 * 3600_000);
      if (this.store.schemaVersion() >= 4)
        db.prepare("INSERT INTO account_operator_sessions VALUES(?,?)").run(id, this.accountId);
    }).immediate();
    return token;
  }
  issueAssistantSession(grantVersion: number): string {
    return this.store.db
      .transaction(() => {
        requireSafe(this.assistant.active()?.version === grantVersion, "ASSISTANT_PERMISSION_REQUIRED");
        const token = this.issueSession();
        this.assistant.bindSession(this.operator(token).id, grantVersion);
        return token;
      })
      .immediate();
  }
  assistantVersion(token: string): number | null {
    return this.assistant.session(this.operator(token).id);
  }
  requireGuiControl(
    token: string,
    permission: Permission = "CONTROL",
    errorCode = "ASSISTANT_PERMISSION_REQUIRED",
  ): Operator {
    const op = this.operator(token, permission);
    requireSafe(this.assistant.session(op.id) === null, errorCode);
    return op;
  }
  checkAssistantModel(token: string, event: StoredEvent, checkAllowance = true): void {
    const version = this.assistantVersion(token);
    if (version === null) return;
    this.assistant.requireEvent("read", event, version);
    this.assistant.requireEvent("editControl", event, version);
    this.assistant.requireText(event);
    if (checkAllowance) requireSafe(this.assistant.allowance(version, "MODEL"), "ASSISTANT_MODEL_EXHAUSTED");
  }
  reserveAssistantModel(token: string, event: StoredEvent, jobKey: string): void {
    const version = this.assistantVersion(token);
    if (version !== null) this.assistant.reserve(version, "MODEL", jobKey, event);
  }
  private checkAssistantEdit(token: string, event: StoredEvent): void {
    const version = this.assistantVersion(token);
    if (version === null) return;
    this.assistant.requireEvent("read", event, version);
    this.assistant.requireEvent("editControl", event, version);
  }
  private sessionScope() {
    return this.store.schemaVersion() >= 4
      ? { sql: " AND id IN (SELECT operator_id FROM account_operator_sessions WHERE account_id=?)", args: [this.accountId] }
      : { sql: "", args: [] };
  }
  private sessionRow(tokenDigest: string) {
    const { sql, args } = this.sessionScope();
    return this.store.db.prepare(`SELECT id,permissions,expires_at FROM operator_sessions WHERE token_digest=?${sql}`)
      .get(tokenDigest, ...args) as { id: string; permissions: string; expires_at: number } | undefined;
  }
  operator(token: string, permission: Permission = "READ"): Operator {
    const row = this.sessionRow(digest(token));
    requireSafe(row && row.expires_at > this.now(), "OPERATOR_EXPIRED");
    const result = { ...row, permissions: JSON.parse(row.permissions) as Permission[] };
    if (!result.permissions.includes(permission)) {
      this.store.audit("OPERATOR_PERMISSION_DENIED", digest([row.id, permission]));
    }
    requireSafe(result.permissions.includes(permission), "OPERATOR_PERMISSION_DENIED");
    return result;
  }
  revoke(token: string): void {
    const { sql, args } = this.sessionScope();
    const tokenDigest = digest(token);
    this.store.db.prepare(`UPDATE operator_sessions SET expires_at=0 WHERE token_digest=?${sql}`).run(tokenDigest, ...args);
    this.selection.delete(tokenDigest);
  }
  /** Only the authenticated desktop parent calls this; stop-only sessions cannot be promoted. */
  renewTrustedSession(
    token: string,
    options: { readOnly?: boolean; minRemainingMs?: number } = {},
  ): void {
    const tokenDigest = digest(token);
    const row = this.sessionRow(tokenDigest);
    requireSafe(row, "OPERATOR_EXPIRED");
    const permissions = JSON.parse(row.permissions) as Permission[];
    requireSafe(
      ["READ", "EDIT", "APPROVE", "SEND", "CONTROL"].every((p) => permissions.includes(p as Permission)),
      "OPERATOR_PERMISSION_DENIED",
    );
    const threshold = options.minRemainingMs ?? sessionRenewalThresholdMs;
    if (options.readOnly && row.expires_at - this.now() >= threshold) return;
    const { sql, args } = this.sessionScope();
    this.store.db.prepare(`UPDATE operator_sessions SET expires_at=? WHERE token_digest=?${sql}`)
      .run(this.now() + 8 * 3600_000, tokenDigest, ...args);
  }
  private pruneExpiredSelections(): void {
    if (!this.selection.size) return;
    const now = this.now();
    for (const tokenDigest of [...this.selection.keys()]) {
      const row = this.sessionRow(tokenDigest);
      if (!row || row.expires_at <= now) this.selection.delete(tokenDigest);
    }
  }
  select(token: string, eventId: string | null, selectionId: string): void {
    const op = this.operator(token);
    if (eventId) this.store.event(eventId);
    const old = this.selection.get(digest(token));
    if (old && (old.eventId !== eventId || old.selectionId !== selectionId)) {
      this.store.db
        .transaction(() => {
          this.store.db
            .prepare(
              `UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='TARGET_SELECTION_CHANGED'
               WHERE operator_id=? AND intent_id IS NULL AND status IN ('PREPARING','PREVIEW','QUEUED','PREFLIGHT')`,
            )
            .run(op.id);
          cancelUnsubmittedFollowups(this.store, this.now(), { operatorId: op.id }, "TARGET_SELECTION_CHANGED");
          if (old.eventId) this.invalidate(this.store.event(old.eventId));
        })
        .immediate();
    }
    this.selection.set(digest(token), { eventId, selectionId });
  }
  ownership(e: StoredEvent): Ownership {
    return (
      (this.store.db
        .prepare("SELECT operator_id,generation,lease_expires_at FROM thread_ownership WHERE account_id=? AND channel=? AND target_key=?")
        .get(e.payload.accountId, e.payload.channel, targetKey(e.payload)) as Ownership | undefined) ?? {
        operator_id: null,
        generation: 0,
        lease_expires_at: 0,
      }
    );
  }
  requireSelection(token: string, eventId: string, selectionId: string): void {
    const selection = this.selection.get(digest(token));
    requireSafe(selection?.eventId === eventId && selection.selectionId === selectionId, "TARGET_SELECTION_CHANGED");
  }
  selectionId(token: string, eventId: string): string {
    this.operator(token);
    const selected = this.selection.get(digest(token));
    requireSafe(selected?.eventId === eventId, "TARGET_SELECTION_CHANGED");
    return selected.selectionId;
  }
  private writeOwner(e: StoredEvent, operator: string | null, generation: number, expiry: number): void {
    this.store.db
      .prepare(
        `INSERT INTO thread_ownership VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,channel,target_key)
         DO UPDATE SET operator_id=excluded.operator_id,generation=excluded.generation,lease_expires_at=excluded.lease_expires_at`,
      )
      .run(e.payload.accountId, e.payload.channel, targetKey(e.payload), operator, generation, expiry);
  }
  private invalidate(e: StoredEvent): void {
    const drafts = this.store.db
      .prepare(
        `SELECT d.id FROM reply_drafts d JOIN inbound_events e ON e.id=d.event_id
         WHERE e.account_id=? AND e.channel=? AND e.target_key=? AND d.status='APPROVED'
         AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id)`,
      )
      .all(this.accountId, e.payload.channel, targetKey(e.payload)) as { id: string }[];
    for (const d of drafts) this.store.invalidateApproval(d.id);
  }
  claim(token: string, eventId: string, expected: number): Ownership {
    const op = this.operator(token, "EDIT"),
      e = this.store.event(eventId);
    this.checkAssistantEdit(token, e);
    return this.store.db
      .transaction(() => {
        const old = this.ownership(e);
        requireSafe(old.generation === expected, "OWNERSHIP_CHANGED");
        requireSafe(
          !old.operator_id || old.operator_id === op.id || old.lease_expires_at <= this.now(),
          "OTHER_OPERATOR_OWNS",
        );
        this.writeOwner(e, op.id, old.generation + 1, this.now() + 120_000);
        if (this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_human_pauses'").get()) {
          this.store.db
            .prepare("INSERT INTO automation_human_pauses VALUES(?,1) ON CONFLICT(target_key) DO UPDATE SET paused=1")
            .run(targetKey(e.payload));
        }
        this.invalidate(e);
        this.store.audit("HUMAN_CLAIMED", digest([op.id, targetKey(e.payload)]));
        return this.ownership(e);
      })
      .immediate();
  }
  requireOwner(token: string, e: StoredEvent, generation: number): Operator {
    const op = this.operator(token, "EDIT"),
      o = this.ownership(e);
    requireSafe(
      o.operator_id === op.id && o.generation === generation && o.lease_expires_at > this.now(),
      "LEASE_EXPIRED_OR_CHANGED",
    );
    return op;
  }
  renew(token: string, eventId: string, generation: number): Ownership {
    const e = this.store.event(eventId),
      op = this.operator(token, "EDIT");
    this.checkAssistantEdit(token, e);
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
      .prepare("SELECT binding FROM source_collisions WHERE event_id=? ORDER BY rowid")
      .all(e.id);
    return digest([e.binding, this.store.history(e.payload), collisions]);
  }
  resumeAutomation(token: string, eventId: string): void {
    this.operator(token, "CONTROL");
    const e = this.store.event(eventId);
    this.store.db
      .transaction(() => {
        requireSafe(!this.store.sendFrozen(e.id), "TARGET_FROZEN");
        this.store.pause(targetKey(e.payload), false);
        const owner = this.ownership(e);
        this.writeOwner(e, null, owner.generation + 1, 0);
        this.invalidate(e);
        this.store.db
          .prepare("INSERT INTO automation_human_pauses VALUES(?,0) ON CONFLICT(target_key) DO UPDATE SET paused=0")
          .run(targetKey(e.payload));
        this.store.audit("TARGET_AUTOMATION_RESUMED", digest(targetKey(e.payload)));
      })
      .immediate();
  }
  resumeIdleAutomation(): void {
    resumeIdleAutomationImpl(this, this.hooks);
  }
  draftFor(eventId: string) {
    const row = this.store.db
      .prepare("SELECT id FROM reply_drafts WHERE event_id=?")
      .get(eventId) as { id: string } | undefined;
    if (!row) return null;
    const draft = this.store.draft(row.id);
    const revision = this.store.db
      .prepare("SELECT origin FROM draft_revisions WHERE draft_id=? AND version=?")
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
    const assistantVersion = this.assistant.session(op.id);
    if (assistantVersion !== null) {
      this.assistant.requireEvent("read", e, assistantVersion);
      this.assistant.requireEvent("editControl", e, assistantVersion);
    }
    requireSafe(this.mode() !== "OBSERVE", "OBSERVE_READ_ONLY");
    return this.store.db
      .transaction(() => {
        this.requireOwner(token, e, generation);
        const old = this.draftFor(eventId);
        requireSafe((old?.version ?? 0) === expectedVersion, "DRAFT_VERSION_CONFLICT");
        requireSafe(
          ["AWAITING_DRAFT", "AWAITING_APPROVAL", "APPROVED", "MANUAL_REVIEW"].includes(e.status),
          "EVENT_NOT_DRAFTABLE",
        );
        requireSafe(
          !this.store.db.prepare("SELECT id FROM send_intents WHERE event_id=?").get(eventId),
          "INTENT_EXISTS",
        );
        let origin = assistantVersion === null ? "HUMAN_TYPED" : "MCP_ASSISTED";
        if (suggestionId) {
          const suggestion = this.store.db
            .prepare("SELECT event_id,dismissed FROM ai_suggestions WHERE id=?")
            .get(suggestionId) as { event_id: string; dismissed: number } | undefined;
          requireSafe(suggestion?.event_id === eventId && !suggestion.dismissed, "SUGGESTION_NOT_AVAILABLE");
          if (assistantVersion === null) origin = "AI_ASSISTED_APPROVED";
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
        if (e.status !== "MANUAL_REVIEW") {
          this.store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);
        }
        this.store.db
          .prepare("INSERT INTO draft_revisions VALUES(?,?,?,?,?,?)")
          .run(id, version, origin, text, op.id, this.now());
        if (suggestionId) {
          bindSuggestionLearningToDraft(this.store, suggestionId, id, version);
          this.modelRoute?.models.copyGenerationBinding(
            { ownerKind: "SUGGESTION", ownerId: suggestionId, ownerVersion: 1 },
            { ownerKind: "DRAFT", ownerId: id, ownerVersion: version },
          );
        }
        this.store.audit(assistantVersion === null ? "HUMAN_DRAFT_SAVED" : "ASSISTANT_DRAFT_SAVED", id, { version });
        return this.draftFor(eventId)!;
      })
      .immediate();
  }
  mode(): Mode {
    return this.store.clientState().mode;
  }
  paused(): boolean {
    return !!this.store.clientState().paused;
  }
  pause(token: string, eventId: string | null, paused: boolean): void {
    this.operator(token, "CONTROL");
    this.store.db
      .transaction(() => {
        const events = eventId ? [this.store.event(eventId)] : this.store.events();
        if (!eventId) {
          this.store.updateClientState({ paused: Number(paused) });
          if (paused) cancelUnsubmittedFollowups(this.store, this.now(), {}, "ACCOUNT_PAUSED");
        }
        const seen = new Set<string>();
        for (const e of events) {
          const key = JSON.stringify([e.payload.channel, targetKey(e.payload)]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (eventId) this.store.pause(targetKey(e.payload), paused);
          if (paused && !eventId) {
            const o = this.ownership(e);
            this.writeOwner(e, null, o.generation + 1, 0);
            this.invalidate(e);
          }
        }
        this.store.audit(paused ? "ACCOUNT_STOPPED" : "ACCOUNT_RESUMED", this.accountId);
      })
      .immediate();
  }
  setMode(token: string, mode: Mode): void {
    this.operator(token, "CONTROL");
    if (mode === "LIMITED_AUTO") {
      const hasAutomation =
        !!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_grants'").get() &&
        !!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_state'").get() &&
        !!this.store.db.prepare("SELECT id FROM automation_state WHERE id=1").get();
      requireSafe(hasAutomation, "AUTO_POLICY_REQUIRED");
      const auto = new AutomationStore(this.store, this.now);
      requireSafe(!auto.state().emergencyStopped, "EMERGENCY_STOPPED");
      const grant = auto.active("AUTO_REPLY");
      requireSafe(grant, "AUTO_POLICY_REQUIRED");
      requireSafe(auto.allowance(grant.version, "SEND"), "SEND_GRANT_EXHAUSTED");
      requireSafe(auto.allowance(grant.version, "MODEL"), "MODEL_GRANT_EXHAUSTED");
    }
    if (
      !this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_schema'").get() &&
      (mode === "MANUAL" || mode === "AI_ASSISTED")
    ) {
      requireSafe(
        this.channels.hasSendCapability() ||
          this.store.db
            .prepare(`SELECT t.event_id FROM controlled_trials t JOIN inbound_events e ON e.id=t.event_id
              WHERE e.account_id=? AND t.used=0 AND t.expires_at>? LIMIT 1`)
            .get(this.accountId, this.now()),
        "CAPABILITY_UNVERIFIED",
      );
    }
    this.store.db.transaction(() => {
      this.store.updateClientState({ mode });
      if (mode === "OBSERVE" || mode === "DRAFT_ONLY") {
        for (const e of this.store.events()) this.invalidate(e);
      }
      this.store.audit("MODE_CHANGED", digest(mode));
    }).immediate();
  }
  attest(...args: Parameters<ChannelAuthority["attest"]>): void {
    this.channels.attest(...args);
  }
  calibrateTrial(...args: Parameters<ChannelAuthority["calibrateTrial"]>): void {
    this.channels.calibrateTrial(...args);
  }
  trialAvailable(...args: Parameters<ChannelAuthority["trialAvailable"]>): boolean {
    return this.channels.trialAvailable(...args);
  }
  completeTrial(...args: Parameters<ChannelAuthority["completeTrial"]>): void {
    this.channels.completeTrial(...args);
  }
  capability(...args: Parameters<ChannelAuthority["capability"]>) {
    return this.channels.capability(...args);
  }
  capabilitySnapshot(...args: Parameters<ChannelAuthority["capabilitySnapshot"]>) {
    return this.channels.capabilitySnapshot(...args);
  }
  assertCanSend(
    token: string,
    p: SendParams,
    identity: CapabilityIdentity | null,
    allowApproved = false,
    commandId = "",
    qualifying = false,
  ): void {
    assertCanSendImpl(this, token, p, identity, allowApproved, commandId, qualifying);
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
            snapshot.targetKey === targetKey(this.store.event(p.eventId).payload),
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
          .run(id, p.eventId, op.id, digest(p), JSON.stringify(p), "PREVIEW", null, null, this.now());
        this.store.db
          .prepare("INSERT INTO client_approvals VALUES(?,?,?,?)")
          .run(id, p.draftId, JSON.stringify(snapshot), expires);
        return { commandId: id, expiresAt: expires };
      })
      .immediate();
  }
  command(id: string): CommandRow {
    const row = this.store.db
      .prepare(`SELECT c.* FROM manual_send_commands c JOIN inbound_events e ON e.id=c.event_id
        WHERE c.command_id=? AND e.account_id=?`)
      .get(id, this.store.accountId) as CommandRow | undefined;
    requireSafe(row, "COMMAND_NOT_FOUND");
    return row;
  }
  approvePreparedCommand(
    token: string,
    id: string,
    snapshot: TargetSnapshot,
    identity: CapabilityIdentity | null,
  ): void {
    this.store.db
      .transaction(() => {
        const row = this.command(id),
          params = JSON.parse(row.params) as SendParams;
        requireSafe(row.status === "PREPARING", "COMMAND_NOT_QUEUED");
        this.assertCanSend(token, params, identity, false, id);
        requireSafe(
          snapshot.eventBinding === this.store.event(params.eventId).binding &&
            snapshot.targetKey === targetKey(this.store.event(params.eventId).payload),
          "TARGET_CHANGED",
        );
        this.store.db
          .prepare("INSERT INTO client_approvals VALUES(?,?,?,?)")
          .run(id, params.draftId, JSON.stringify(snapshot), this.now() + 60_000);
        this.store.approve(params.draftId, snapshot, params.draftVersion, params.text, () =>
          assertManualMediaApprovalImpl(this, token, id, snapshot, identity),
        );
        this.store.db.prepare("UPDATE manual_send_commands SET status='QUEUED' WHERE command_id=?").run(id);
        this.store.audit(
          this.store.db.prepare("SELECT command_id FROM policy_commands WHERE command_id=?").get(id)
            ? "AUTO_POLICY_APPROVED"
            : "MANUAL_SEND_APPROVED",
          id,
        );
      })
      .immediate();
  }
  queue(token: string, id: string, p: SendParams, identity: CapabilityIdentity | null): boolean {
    this.operator(token, "SEND");
    this.operator(token, "APPROVE");
    this.operator(token, "EDIT");
    return this.store.db
      .transaction(() => {
        const row = this.command(id),
          op = this.operator(token, "SEND");
        requireSafe(row.operator_id === op.id && row.params_digest === digest(p), "COMMAND_PARAMETERS_CONFLICT");
        if (row.status !== "PREVIEW") return false;
        this.assertCanSend(token, p, identity);
        const approval = this.approval(id);
        requireSafe(approval.expires_at > this.now(), "CONFIRMATION_EXPIRED");
        this.store.approve(p.draftId, JSON.parse(approval.snapshot) as TargetSnapshot, p.draftVersion, p.text);
        this.store.db.prepare("UPDATE manual_send_commands SET status='QUEUED' WHERE command_id=?").run(id);
        this.store.audit("MANUAL_SEND_APPROVED", id);
        return true;
      })
      .immediate();
  }
  approval(id: string): { snapshot: string; expires_at: number } {
    const a = this.store.db
      .prepare(`SELECT a.snapshot,a.expires_at FROM manual_send_commands c JOIN inbound_events e ON e.id=c.event_id
        LEFT JOIN client_approvals a ON a.command_id=c.command_id WHERE c.command_id=? AND e.account_id=?`)
      .get(id, this.store.accountId) as { snapshot: string; expires_at: number } | { snapshot: null; expires_at: null } | undefined;
    requireSafe(a, "COMMAND_NOT_FOUND");
    requireSafe(a.snapshot !== null, "APPROVAL_REQUIRED");
    return a;
  }
  dispatchGuard(token: string, id: string, identity: () => CapabilityIdentity | null) {
    return {
      manualMedia: () =>
        assertManualMediaApprovalImpl(
          this,
          token,
          id,
          JSON.parse(this.approval(id).snapshot) as TargetSnapshot,
          identity(),
        ),
      check: () => {
        const row = this.command(id);
        requireSafe(row.reason !== "MODEL_ROUTE_CHANGED" && row.reason !== "LEGACY_MODEL_ROUTE_UNPROVEN", row.reason!);
        requireSafe(["QUEUED", "PREFLIGHT"].includes(row.status), "COMMAND_NOT_QUEUED");
        requireSafe(this.approval(id).expires_at > this.now(), "CONFIRMATION_EXPIRED");
        this.assertCanSend(token, JSON.parse(row.params) as SendParams, identity(), true, id);
        const snapshot = JSON.parse(this.approval(id).snapshot) as TargetSnapshot;
        if (snapshot.manualObservation) assertManualMediaApprovalImpl(this, token, id, snapshot, identity());
        this.store.db.prepare("UPDATE manual_send_commands SET status='PREFLIGHT' WHERE command_id=?").run(id);
      },
      beforeSubmit: (intentId: string) => {
        const row = this.command(id), params = JSON.parse(row.params) as SendParams;
        requireSafe(row.status === "SENDING" && row.intent_id === intentId && row.event_id === params.eventId &&
          row.params_digest === digest(params) && row.operator_id === this.operator(token, "SEND").id, "COMMAND_INTENT_CHANGED");
        const event = this.store.event(row.event_id), draft = this.store.draft(params.draftId);
        requireSafe(draft.eventId === event.id && draft.version === params.draftVersion && draft.text === params.text, "COMMAND_INTENT_CHANGED");
        this.store.assertTargetUnpaused(targetKey(event.payload));
        requireSafe(this.ownership(event).generation === params.generation, "OWNERSHIP_CHANGED");
        requireSafe(!this.paused(), "ACCOUNT_PAUSED");
      },
      committed: (intentId: string) => {
        this.assistant.commitCommand(id, this.store.event(this.command(id).event_id));
        if (this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='policy_commands'").get()) {
          const policy = this.store.db
            .prepare("SELECT grant_version FROM policy_commands WHERE command_id=?")
            .get(id) as { grant_version: number } | undefined;
          if (policy) new AutomationStore(this.store, this.now).reserve(policy.grant_version, "SEND", this.command(id).event_id);
        }
        this.store.db.prepare("UPDATE controlled_trials SET used=1 WHERE event_id=?").run(this.command(id).event_id);
        this.store.db
          .prepare("UPDATE manual_send_commands SET status='SENDING',intent_id=? WHERE command_id=?")
          .run(intentId, id);
        if (this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='verification_jobs'").get()) {
          const intent = this.store.db
            .prepare("SELECT event_id,attempt_started_at,target_digest FROM send_intents WHERE id=?")
            .get(intentId) as { event_id: string; attempt_started_at: string; target_digest: string };
          this.store.db
            .prepare("INSERT OR IGNORE INTO verification_jobs VALUES(?,?,?,?,0,?,?,'PENDING',NULL)")
            .run(
              intentId,
              intent.event_id,
              intent.attempt_started_at,
              intent.target_digest,
              this.now() + 2000,
              this.now() + 120_000,
            );
        }
      },
    };
  }
  finish(id: string, status: string, reason: string | null = null): void {
    this.store.db
      .prepare(`UPDATE manual_send_commands SET status=?,reason=? WHERE command_id=?
        AND (intent_id IS NOT NULL OR reason IS NULL OR reason NOT IN ('MODEL_ROUTE_CHANGED','LEGACY_MODEL_ROUTE_UNPROVEN'))`)
      .run(status, reason, id);
  }
  recover(): void {
    this.store.recover();
    this.store.db
      .prepare(
        `UPDATE manual_send_commands SET status=COALESCE((SELECT status FROM send_intents WHERE id=intent_id),'FAILED_BEFORE_CLICK'),
         reason='RESTART_NO_REPLAY' WHERE status IN ('PREPARING','QUEUED','PREFLIGHT','SENDING','PREVIEW')
         AND event_id IN (SELECT id FROM inbound_events WHERE account_id=?)`,
      )
      .run(this.accountId);
    this.expireOperators("ALL");
  }
  expireOperators(scope: "ALL" | "DESKTOP" = "ALL"): void {
    if (this.store.schemaVersion() < 4) {
      expireOperatorsImpl(this, this.hooks, scope);
      return;
    }
    const { db } = this.store;
    const desktopOnly = scope === "DESKTOP" && this.assistant.available();
    const excludeAssistant = desktopOnly ? "AND operator_id NOT IN (SELECT operator_id FROM assistant_sessions)" : "";
    db.transaction(() => {
      const now = this.now();
      const excludeAssistantDrafts = desktopOnly ? `AND NOT EXISTS (
        SELECT 1 FROM thread_ownership o JOIN assistant_sessions a ON a.operator_id=o.operator_id
        JOIN operator_sessions s ON s.id=o.operator_id
        WHERE o.account_id=e.account_id AND o.channel=e.channel AND o.target_key=e.target_key
          AND o.lease_expires_at>? AND s.expires_at>?
      ) AND NOT EXISTS (
        SELECT 1 FROM manual_send_commands c JOIN assistant_commands ac ON ac.command_id=c.command_id
        WHERE c.event_id=e.id AND c.status IN ('PREPARING','QUEUED','PREFLIGHT','SENDING')
      )` : "";
      const drafts = db.prepare(`SELECT d.id FROM reply_drafts d JOIN inbound_events e ON e.id=d.event_id
        WHERE e.account_id=? AND d.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id)
        ${excludeAssistantDrafts} ORDER BY d.rowid`).all(this.accountId, ...(desktopOnly ? [now, now] : [])) as { id: string }[];
      for (const draft of drafts) this.store.invalidateApproval(draft.id);
      if (desktopOnly) db.prepare(`UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='OPERATOR_EXPIRED'
        WHERE event_id IN (SELECT id FROM inbound_events WHERE account_id=?) AND intent_id IS NULL
        AND status IN ('PREPARING','PREVIEW','QUEUED','PREFLIGHT') ${excludeAssistant}`).run(this.accountId);
      cancelUnsubmittedFollowups(this.store, now, { excludeAssistant: desktopOnly }, "OPERATOR_EXPIRED");
      db.prepare(`UPDATE thread_ownership SET operator_id=NULL,generation=generation+1,lease_expires_at=0
        WHERE account_id=? AND operator_id IS NOT NULL ${excludeAssistant}`).run(this.accountId);
      db.prepare(`UPDATE operator_sessions SET expires_at=0 WHERE id IN (
        SELECT operator_id FROM account_operator_sessions WHERE account_id=? ${excludeAssistant}
      )`).run(this.accountId);
    }).immediate();
    this.pruneExpiredSelections();
  }
}
