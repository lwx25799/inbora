import {
  digest,
  isStrong,
  requireSafe,
  targetKey,
  validManualMediaProof,
  validText,
  type StoredEvent,
  type TargetSnapshot,
} from "../core/contracts.js";
import { assertDraftLearningCurrent } from "../knowledge/generation-context.js";
import { AutomationStore } from "../storage/automation-store.js";
import { assertSecurityChannelClear } from "../storage/security-holds.js";
import type { CapabilityIdentity } from "./channel-authority.js";
import type { SendParams } from "./contracts.js";
import type { Grant, ReplyPolicy } from "./automation-contracts.js";
import { humanReplyEligibility } from "./manual-reply-eligibility.js";
import { cancelUnsubmittedFollowups } from "./followup-verification.js";
import type { WorkbenchAuthority } from "./authority.js";

export interface AuthorityInternalHooks {
  writeOwner(e: StoredEvent, operator: string | null, generation: number, expiry: number): void;
  invalidate(e: StoredEvent): void;
  pruneExpiredSelections(): void;
}

/** O(N) resume of idle automation targets with a single ordered event scan. */
export function resumeIdleAutomationImpl(
  authority: WorkbenchAuthority,
  hooks: AuthorityInternalHooks,
): void {
  const { store } = authority;
  store.db
    .transaction(() => {
      const unresolvedTargets = new Set<string>(
        (
          store.db
            .prepare("SELECT DISTINCT target_key FROM send_intents WHERE status IN ('INTENT_RECORDED','UNCERTAIN')")
            .all() as { target_key: string }[]
        ).map((row) => row.target_key),
      );
      if (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='human_reply_turns'").get()) {
        const turns = store.db
          .prepare("SELECT DISTINCT target_key FROM human_reply_turns WHERE status IN ('INTENT_RECORDED','UNCERTAIN')")
          .all() as { target_key: string }[];
        for (const row of turns) unresolvedTargets.add(row.target_key);
      }
      const byTarget = new Map<string, StoredEvent[]>();
      for (const event of store.events()) {
        const key = targetKey(event.payload);
        const list = byTarget.get(key);
        if (list) list.push(event);
        else byTarget.set(key, [event]);
      }
      const clearHumanPause = store.db.prepare("DELETE FROM automation_human_pauses WHERE target_key=?");
      for (const [key, group] of byTarget) {
        if (unresolvedTargets.has(key) && !group.some((next) => !store.sendFrozen(next.id))) continue;
        const representative = group[0]!;
        store.pause(key, false);
        const owner = authority.ownership(representative);
        if (!owner.operator_id || owner.lease_expires_at <= authority.now()) {
          hooks.writeOwner(representative, null, owner.generation + 1, 0);
          hooks.invalidate(representative);
        }
        clearHumanPause.run(key);
      }
    })
    .immediate();
}

/** Expire all sessions (startup/shutdown) or only desktop operator sessions (reconnect), keeping active MCP sessions intact. */
export function expireOperatorsImpl(
  authority: WorkbenchAuthority,
  hooks: AuthorityInternalHooks,
  scope: "ALL" | "DESKTOP" = "ALL",
): void {
  const { store } = authority;
  store.db
    .transaction(() => {
      const desktopOnly = scope === "DESKTOP" && authority.assistant.available();
      const now = authority.now();
      const drafts = desktopOnly
        ? (store.db
            .prepare(
              `SELECT d.id FROM reply_drafts d JOIN inbound_events e ON e.id=d.event_id
               WHERE d.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id)
               AND NOT EXISTS(
                 SELECT 1 FROM thread_ownership o JOIN assistant_sessions a ON a.operator_id=o.operator_id
                 JOIN operator_sessions s ON s.id=o.operator_id
                 WHERE o.account_id=e.account_id AND o.channel=e.channel AND o.target_key=e.target_key
                 AND o.lease_expires_at>? AND s.expires_at>?
               )
               AND NOT EXISTS(
                 SELECT 1 FROM manual_send_commands c JOIN assistant_commands ac ON ac.command_id=c.command_id
                 WHERE c.event_id=e.id AND c.status IN ('PREPARING','QUEUED','PREFLIGHT','SENDING')
               )
               ORDER BY d.rowid`,
            )
            .all(now, now) as { id: string }[])
        : (store.db
            .prepare(
              `SELECT d.id FROM reply_drafts d JOIN inbound_events e ON e.id=d.event_id
               WHERE d.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id) ORDER BY d.rowid`,
            )
            .all() as { id: string }[]);
      for (const draft of drafts) store.invalidateApproval(draft.id);
      if (desktopOnly) {
        store.db
          .prepare(
            `UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='OPERATOR_EXPIRED'
             WHERE intent_id IS NULL AND status IN ('PREPARING','PREVIEW','QUEUED','PREFLIGHT')
             AND operator_id NOT IN (SELECT operator_id FROM assistant_sessions)`,
          )
          .run();
        cancelUnsubmittedFollowups(store, now, { excludeAssistant: true }, "OPERATOR_EXPIRED");
        store.db
          .prepare(
            `UPDATE thread_ownership SET operator_id=NULL,generation=generation+1,lease_expires_at=0
             WHERE operator_id IS NOT NULL AND operator_id NOT IN (SELECT operator_id FROM assistant_sessions)`,
          )
          .run();
        store.db
          .prepare("UPDATE operator_sessions SET expires_at=0 WHERE id NOT IN (SELECT operator_id FROM assistant_sessions)")
          .run();
      } else {
        cancelUnsubmittedFollowups(store, now, {}, "OPERATOR_EXPIRED");
        store.db
          .prepare(
            "UPDATE thread_ownership SET operator_id=NULL,generation=generation+1,lease_expires_at=0 WHERE operator_id IS NOT NULL",
          )
          .run();
        store.db.prepare("UPDATE operator_sessions SET expires_at=0").run();
      }
    })
    .immediate();
  hooks.pruneExpiredSelections();
}

export function assertCanSendImpl(
  authority: WorkbenchAuthority,
  token: string,
  p: SendParams,
  identity: CapabilityIdentity | null,
  allowApproved = false,
  commandId = "",
  qualifying = false,
): void {
  const { store } = authority;
  authority.operator(token, "APPROVE");
  authority.operator(token, "SEND");
  const e = store.event(p.eventId);
  assertSecurityChannelClear(store, e.payload.channel);
  authority.assistant.requireSend(authority.operator(token).id, e);
  const policy =
    store.db.prepare("SELECT name FROM sqlite_master WHERE name='policy_commands'").get() && commandId
      ? (store.db
          .prepare("SELECT grant_version,ownership_generation FROM policy_commands WHERE command_id=?")
          .get(commandId) as { grant_version: number; ownership_generation: number } | undefined)
      : null;
  if (policy) {
    const auto = new AutomationStore(store, authority.now),
      grant = auto.active("AUTO_REPLY") as Grant<ReplyPolicy> | null;
    requireSafe(grant?.version === policy.grant_version && auto.policyMatches(grant, e, "DRAFT"), "POLICY_NO_LONGER_AUTHORIZED");
    requireSafe(
      authority.ownership(e).generation === policy.ownership_generation && p.generation === policy.ownership_generation,
      "OWNERSHIP_CHANGED",
    );
  } else {
    authority.requireOwner(token, e, p.generation);
    authority.requireSelection(token, p.eventId, p.selectionId);
  }
  requireSafe(!authority.paused(), "ACCOUNT_PAUSED");
  requireSafe(
    !store.db
      .prepare(
        "SELECT command_id FROM manual_send_commands WHERE event_id=? AND status IN ('PREPARING','QUEUED','PREFLIGHT','SENDING') AND command_id<>? LIMIT 1",
      )
      .get(p.eventId, commandId),
    "COMMAND_ALREADY_QUEUED",
  );
  requireSafe(["MANUAL", "AI_ASSISTED", "LIMITED_AUTO"].includes(authority.mode()), "MODE_DRAFT_ONLY");
  const capability = authority.capability(e.payload.channel, identity);
  requireSafe(
    qualifying ||
      capability.state === "SEND_AVAILABLE" ||
      (capability.state === "SEND_REVIEW_ONLY" &&
        authority.trialAvailable(p.eventId, p.draftId, p.draftVersion, p.text, identity)),
    capability.reason,
  );
  const manualMedia =
    !isStrong(e.payload) &&
    !policy &&
    !!commandId &&
    humanReplyEligibility(store, e).eligible &&
    !!store.db.prepare("SELECT command_id FROM manual_send_inputs WHERE command_id=?").get(commandId) &&
    authority.command(commandId).operator_id === authority.operator(token).id &&
    authority.command(commandId).params_digest === digest(p);
  requireSafe(
    ((isStrong(e.payload) || manualMedia) &&
      ["AWAITING_APPROVAL", ...(allowApproved ? ["APPROVED"] : [])].includes(e.status)) ||
      (manualMedia && e.status === "MANUAL_REVIEW"),
    "TARGET_NEEDS_REVIEW",
  );
  requireSafe(
    !(
      store.db.prepare("SELECT paused FROM pauses WHERE target_key=?").get(targetKey(e.payload)) as
        | { paused: number }
        | undefined
    )?.paused,
    "TARGET_PAUSED",
  );
  requireSafe(!store.sendFrozen(e.id), "TARGET_FROZEN");
  requireSafe(!store.db.prepare("SELECT id FROM send_intents WHERE event_id=?").get(e.id), "INTENT_EXISTS");
  const d = authority.draftFor(e.id);
  requireSafe(d && d.id === p.draftId && d.version === p.draftVersion && d.text === p.text, "DRAFT_VERSION_CONFLICT");
  validText(d.text);
  assertDraftLearningCurrent(store, d.id, d.version);
  requireSafe(authority.contextVersion(e) === p.contextVersion, "CONTEXT_VERSION_CONFLICT");
}

export function assertManualMediaApprovalImpl(
  authority: WorkbenchAuthority,
  token: string,
  id: string,
  snapshot: TargetSnapshot,
  identity: CapabilityIdentity | null,
): void {
  const { store } = authority;
  const row = authority.command(id),
    params = JSON.parse(row.params) as SendParams,
    event = store.event(params.eventId),
    approval = authority.approval(id);
  requireSafe(
    !store.db.prepare("SELECT command_id FROM policy_commands WHERE command_id=?").get(id) &&
      !!store.db.prepare("SELECT command_id FROM manual_send_inputs WHERE command_id=?").get(id) &&
      row.intent_id === null &&
      ["PREPARING", "QUEUED", "PREFLIGHT"].includes(row.status) &&
      row.operator_id === authority.operator(token).id &&
      row.params_digest === digest(params),
    "HUMAN_MEDIA_APPROVAL_REQUIRED",
  );
  authority.requireOwner(token, event, params.generation);
  authority.requireSelection(token, event.id, params.selectionId);
  requireSafe(
    humanReplyEligibility(store, event).eligible &&
      authority.draftFor(event.id)?.origin === "HUMAN_TYPED" &&
      authority.contextVersion(event) === params.contextVersion &&
      approval.expires_at > authority.now() &&
      digest(JSON.parse(approval.snapshot)) === digest(snapshot) &&
      validManualMediaProof(event.payload, snapshot) &&
      identity?.identityDigest === digest(snapshot.ownId) &&
      authority.capability(event.payload.channel, identity).evidence === `readonly-contract:${digest([snapshot, identity])}`,
    "HUMAN_MEDIA_APPROVAL_REQUIRED",
  );
}
