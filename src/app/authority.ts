import { randomBytes, randomUUID } from "node:crypto";
import {
  digest,
  requireSafe,
  isStrong,
  targetKey,
  validText,
  type Channel,
  type StoredEvent,
  type TargetSnapshot,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import type { SendParams, Mode } from "./contracts.js";

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
export interface CapabilityIdentity {
  identityDigest: string;
  mappingDigest: string;
  browserVersion: string;
  browserMode: "headed" | "headless";
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
  private selection = new Map<
    string,
    { eventId: string | null; selectionId: string }
  >();
  constructor(
    readonly store: EventStore,
    readonly now: () => number = Date.now,
  ) {
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
        WHERE operator_id=? AND intent_id IS NULL AND status IN ('PREVIEW','QUEUED','PREFLIGHT')`,
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
      requireSafe(!this.store.db.prepare("SELECT id FROM send_intents WHERE target_key=? AND status IN ('INTENT_RECORDED','UNCERTAIN')").get(targetKey(e.payload)), "TARGET_FROZEN");
      const owner = this.ownership(e);
      this.writeOwner(e, null, owner.generation + 1, 0);
      this.invalidate(e);
      this.store.db.prepare("INSERT INTO automation_human_pauses VALUES(?,0) ON CONFLICT(target_key) DO UPDATE SET paused=0").run(targetKey(e.payload));
      this.store.audit("TARGET_AUTOMATION_RESUMED", digest(targetKey(e.payload)));
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
        let origin = "HUMAN_TYPED";
        if (suggestionId) {
          const suggestion = this.store.db
            .prepare("SELECT event_id,dismissed FROM ai_suggestions WHERE id=?")
            .get(suggestionId) as
            { event_id: string; dismissed: number } | undefined;
          requireSafe(
            suggestion?.event_id === eventId && !suggestion.dismissed,
            "SUGGESTION_NOT_AVAILABLE",
          );
          origin = "AI_ASSISTED_APPROVED";
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
        this.store.audit("HUMAN_DRAFT_SAVED", id, { version });
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
    if (mode === "MANUAL" || mode === "AI_ASSISTED")
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
  attest(
    channel: Channel,
    state: "READ_OK" | "SEND_REVIEW_ONLY" | "SEND_AVAILABLE" | "BLOCKED",
    identity: CapabilityIdentity,
    evidence: string,
  ): void {
    requireSafe(
      evidence.length > 0 && identity.browserVersion !== "unknown",
      "CAPABILITY_EVIDENCE_REQUIRED",
    );
    this.store.db
      .prepare(
        `INSERT INTO channel_capabilities VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel,browser_mode)
      DO UPDATE SET state=excluded.state,identity_digest=excluded.identity_digest,mapping_digest=excluded.mapping_digest,
      browser_version=excluded.browser_version,evidence_ref=excluded.evidence_ref,verified_at=excluded.verified_at,expires_at=excluded.expires_at`,
      )
      .run(
        channel,
        identity.browserMode,
        state,
        identity.identityDigest,
        identity.mappingDigest,
        identity.browserVersion,
        evidence,
        this.now(),
        this.now() + 24 * 3600_000,
      );
  }
  calibrateTrial(
    draftId: string,
    snapshot: TargetSnapshot,
    identity: CapabilityIdentity,
    evidence: string,
  ): void {
    const d = this.store.draft(draftId),
      e = this.store.event(d.eventId);
    requireSafe(
      isStrong(e.payload) &&
        e.status === "AWAITING_APPROVAL" &&
        d.status === "DRAFT",
      "TARGET_NEEDS_REVIEW",
    );
    validText(d.text);
    requireSafe(
      snapshot.eventBinding === e.binding &&
        snapshot.targetKey === targetKey(e.payload) &&
        snapshot.accountId === e.payload.accountId,
      "TARGET_CHANGED",
    );
    requireSafe(
      identity.identityDigest === digest(snapshot.ownId),
      "ACCOUNT_CHANGED",
    );
    requireSafe(
      !this.store.db
        .prepare("SELECT id FROM send_intents WHERE event_id=?")
        .get(e.id),
      "INTENT_EXISTS",
    );
    this.store.db
      .transaction(() => {
        this.attest(e.payload.channel, "SEND_REVIEW_ONLY", identity, evidence);
        this.store.db
          .prepare(
            `INSERT INTO controlled_trials VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(event_id) DO UPDATE SET
        draft_id=excluded.draft_id,draft_version=excluded.draft_version,text_digest=excluded.text_digest,
        identity_json=excluded.identity_json,evidence_ref=excluded.evidence_ref,expires_at=excluded.expires_at,used=0`,
          )
          .run(
            e.id,
            d.id,
            d.version,
            digest(d.text),
            JSON.stringify(identity),
            evidence,
            this.now() + 3600_000,
          );
        this.store.audit("CONTROLLED_GUI_TRIAL_CALIBRATED", e.id);
      })
      .immediate();
  }
  trialAvailable(
    eventId: string,
    draftId: string,
    version: number,
    text: string,
    identity: CapabilityIdentity | null,
  ): boolean {
    if (!identity) return false;
    const row = this.store.db
      .prepare("SELECT * FROM controlled_trials WHERE event_id=?")
      .get(eventId) as
      | {
          draft_id: string;
          draft_version: number;
          text_digest: string;
          identity_json: string;
          used: number;
          expires_at: number;
        }
      | undefined;
    return (
      !!row &&
      !row.used &&
      row.expires_at > this.now() &&
      row.draft_id === draftId &&
      row.draft_version === version &&
      row.text_digest === digest(text) &&
      digest(JSON.parse(row.identity_json)) === digest(identity)
    );
  }
  completeTrial(
    eventId: string,
    intentId: string,
    identity: CapabilityIdentity | null,
  ): void {
    const trial = this.store.db
      .prepare(
        "SELECT identity_json,evidence_ref FROM controlled_trials WHERE event_id=? AND used=1",
      )
      .get(eventId) as
      { identity_json: string; evidence_ref: string } | undefined;
    if (
      !trial ||
      !identity ||
      digest(JSON.parse(trial.identity_json)) !== digest(identity)
    )
      return;
    const receipt = this.store.db
      .prepare(
        "SELECT r.id FROM delivery_receipts r JOIN send_intents i ON i.id=r.send_intent_id WHERE i.id=? AND i.event_id=? AND r.result='CONFIRMED'",
      )
      .get(intentId, eventId) as { id: string } | undefined;
    requireSafe(receipt, "TRIAL_RECEIPT_REQUIRED");
    const channel = this.store.event(eventId).payload.channel;
    this.store.db
      .transaction(() => {
        const current = this.capability(channel, identity);
        if (
          current.state !== "SEND_REVIEW_ONLY" ||
          current.evidence !== trial.evidence_ref
        )
          return;
        this.attest(
          channel,
          "SEND_AVAILABLE",
          identity,
          `receipt:${receipt.id}`,
        );
        this.store.audit("CONTROLLED_GUI_TRIAL_VERIFIED", eventId);
      })
      .immediate();
  }
  capability(
    channel: Channel,
    identity: CapabilityIdentity | null,
  ): { state: string; reason: string; evidence: string | null } {
    const row = identity
      ? (this.store.db
          .prepare(
            "SELECT * FROM channel_capabilities WHERE channel=? AND browser_mode=?",
          )
          .get(channel, identity.browserMode) as
          | {
              state: string;
              identity_digest: string;
              mapping_digest: string;
              browser_version: string;
              evidence_ref: string;
              expires_at: number;
            }
          | undefined)
      : undefined;
    if (!row || !identity)
      return {
        state: "SEND_REVIEW_ONLY",
        reason: "CAPABILITY_UNVERIFIED",
        evidence: null,
      };
    const valid =
      row.expires_at > this.now() &&
      row.identity_digest === identity.identityDigest &&
      row.mapping_digest === identity.mappingDigest &&
      row.browser_version === identity.browserVersion;
    return valid
      ? {
          state: row.state,
          reason: ({SEND_AVAILABLE:"",READ_OK:"CAPABILITY_READ_ONLY",SEND_REVIEW_ONLY:"CAPABILITY_SEND_UNVERIFIED",BLOCKED:"CAPABILITY_BLOCKED"} as Record<string,string>)[row.state] ?? "CHANNEL_NOT_SENDABLE",
          evidence: row.evidence_ref,
        }
      : {
          state: "SEND_REVIEW_ONLY",
          reason: "CAPABILITY_EXPIRED_OR_CHANGED",
          evidence: row.evidence_ref,
        };
  }
  assertCanSend(
    token: string,
    p: SendParams,
    identity: CapabilityIdentity | null,
    allowApproved = false,
    commandId = "",
  ): void {
    this.operator(token, "APPROVE");
    this.operator(token, "SEND");
    const e = this.store.event(p.eventId);
    this.requireOwner(token, e, p.generation);
    const selection = this.selection.get(digest(token));
    requireSafe(
      selection?.eventId === p.eventId &&
        selection.selectionId === p.selectionId,
      "TARGET_SELECTION_CHANGED",
    );
    requireSafe(!this.paused(), "ACCOUNT_PAUSED");
    requireSafe(
      !this.store.db
        .prepare(
          "SELECT command_id FROM manual_send_commands WHERE event_id=? AND status IN ('QUEUED','PREFLIGHT','SENDING') AND command_id<>? LIMIT 1",
        )
        .get(p.eventId, commandId),
      "COMMAND_ALREADY_QUEUED",
    );
    requireSafe(
      ["MANUAL", "AI_ASSISTED"].includes(this.mode()),
      "MODE_DRAFT_ONLY",
    );
    const capability = this.capability(e.payload.channel, identity);
    requireSafe(
      capability.state === "SEND_AVAILABLE" ||
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
    requireSafe(
      isStrong(e.payload) &&
        ["AWAITING_APPROVAL", ...(allowApproved ? ["APPROVED"] : [])].includes(
          e.status,
        ),
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
      !this.store.db
        .prepare(
          "SELECT id FROM send_intents WHERE target_key=? AND status IN ('UNCERTAIN','INTENT_RECORDED')",
        )
        .get(targetKey(e.payload)),
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
        this.store.db
          .prepare(
            "UPDATE manual_send_commands SET status='PREFLIGHT' WHERE command_id=?",
          )
          .run(id);
      },
      committed: (intentId: string) => {
        this.store.db
          .prepare("UPDATE controlled_trials SET used=1 WHERE event_id=?")
          .run(this.command(id).event_id);
        this.store.db
          .prepare(
            "UPDATE manual_send_commands SET status='SENDING',intent_id=? WHERE command_id=?",
          )
          .run(intentId, id);
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
      reason='RESTART_NO_REPLAY' WHERE status IN ('QUEUED','PREFLIGHT','SENDING','PREVIEW')`,
      )
      .run();
    this.expireOperators();
  }
  expireOperators(): void {
    this.store.db
      .transaction(() => {
        for (const e of this.store.events()) this.invalidate(e);
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
