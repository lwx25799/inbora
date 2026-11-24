import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Blocked,
  digest,
  requireSafe,
  targetKey,
  type Channel,
  type Draft,
  type SendProof,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { assertSecurityRevision, securityRevision } from "../storage/security-holds.js";
import { ObservedCommentReply } from "../adapters/observed-comment-reply.js";
import { ObservedDmReply } from "../adapters/observed-dm-reply.js";
import { recordEvidence } from "../observability/evidence.js";
import type { BrowserService } from "./browser-service.js";

const hash64 = /^[a-f0-9]{64}$/u;
const attemptAuditType = "HUMAN_FOLLOWUP_VERIFICATION_ATTEMPT";
const maxAttempts = 2;
const initialDelayMs = 2_000;
const retryDelayMs = 10_000;
const deadlineWindowMs = 120_000;

export interface FollowupTurnRow {
  command_id: string;
  event_id: string;
  target_key: string;
  operator_id: string;
  text: string;
  version: number;
  status: string;
  approval: string | null;
  intent_id: string | null;
  attempt_started_at: string | null;
  reason: string | null;
  proof_ref: string | null;
  verified_at: string | null;
  native_id_digest: string | null;
  created_at: number;
}

export interface FollowupVerificationJob {
  commandId: string;
  intentId: string;
  eventId: string;
  channel: Channel;
  targetKey: string;
  boundary: string;
  textDigest: string;
  approvalDigest: string;
  attempts: number;
  deadline: number;
}

export interface FollowupVerificationResult {
  verified: boolean;
  evidenceId: string;
  proofDigest?: string;
  nativeIdDigest?: string;
}

function hasFollowupTables(store: EventStore): boolean {
  return !!store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='human_reply_turns'")
    .get();
}

/** Cancel pre-click human followups and restore their cleared draft text in the same transaction. */
export function cancelUnsubmittedFollowups(
  store: EventStore,
  now: number,
  filter: { operatorId?: string; targetKey?: string; excludeAssistant?: boolean },
  reason: string,
): number {
  if (!hasFollowupTables(store)) return 0;
  const clauses = ["intent_id IS NULL", "status IN ('PREPARING','APPROVED')"];
  const args: unknown[] = [];
  if (filter.operatorId !== undefined) {
    clauses.push("operator_id=?");
    args.push(filter.operatorId);
  }
  if (filter.targetKey !== undefined) {
    clauses.push("target_key=?");
    args.push(filter.targetKey);
  }
  if (
    filter.excludeAssistant &&
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_sessions'").get()
  ) {
    clauses.push("operator_id NOT IN (SELECT operator_id FROM assistant_sessions)");
  }
  const where = clauses.join(" AND ");
  const pending = store.db
    .prepare(`SELECT command_id,event_id,text,version FROM human_reply_turns WHERE ${where} ORDER BY rowid`)
    .all(...args) as { command_id: string; event_id: string; text: string; version: number }[];
  if (!pending.length) return 0;
  const cancelStmt = store.db.prepare(
    "UPDATE human_reply_turns SET status='FAILED_BEFORE_CLICK',reason=?,approval=NULL WHERE command_id=? AND intent_id IS NULL AND status IN ('PREPARING','APPROVED')",
  );
  const restoreStmt = store.db.prepare(
    "UPDATE human_reply_drafts SET text=?,version=version+1,saved_at=? WHERE event_id=? AND text='' AND version=?",
  );
  let cancelled = 0;
  for (const row of pending) {
    if (cancelStmt.run(reason, row.command_id).changes === 1) {
      cancelled++;
      restoreStmt.run(row.text, now, row.event_id, row.version + 1);
    }
  }
  return cancelled;
}

function attemptStats(store: EventStore, intentId: string): { attempts: number; lastCheckedAt: number } {
  const rows = store.db
    .prepare("SELECT detail_redacted FROM audit_events WHERE event_type=? AND entity_id=? ORDER BY rowid")
    .all(attemptAuditType, intentId) as { detail_redacted: string }[];
  let lastCheckedAt = 0;
  for (const row of rows) {
    try {
      const detail = JSON.parse(row.detail_redacted) as { checkedAt?: unknown };
      if (typeof detail.checkedAt === "number" && Number.isFinite(detail.checkedAt)) {
        lastCheckedAt = Math.max(lastCheckedAt, detail.checkedAt);
      }
    } catch {
      /* Ignore malformed audit detail while keeping the attempt count bounded. */
    }
  }
  return { attempts: rows.length, lastCheckedAt };
}

function parseApproval(raw: string | null): NonNullable<Draft["approval"]> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Draft["approval"];
    return value?.snapshot ? value : null;
  } catch {
    return null;
  }
}

/** Pick at most one UNCERTAIN human followup turn due for bounded read-only verification. */
export function claimFollowupVerification(
  store: EventStore,
  now: number,
  heldChannels: readonly Channel[],
): FollowupVerificationJob | undefined {
  if (!hasFollowupTables(store)) return undefined;
  const turns = store.db
    .prepare(
      `SELECT t.*, e.channel FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
       WHERE t.status='UNCERTAIN' AND t.intent_id IS NOT NULL AND t.attempt_started_at IS NOT NULL
       ORDER BY t.rowid`,
    )
    .all() as (FollowupTurnRow & { channel: Channel })[];
  let best: { job: FollowupVerificationJob; nextAt: number } | undefined;
  for (const turn of turns) {
    if (heldChannels.includes(turn.channel)) continue;
    const approval = parseApproval(turn.approval);
    const boundaryMs = Date.parse(turn.attempt_started_at ?? "");
    if (!approval || !Number.isFinite(boundaryMs) || !turn.intent_id) continue;
    const stats = attemptStats(store, turn.intent_id);
    if (stats.attempts >= maxAttempts) continue;
    const deadline = Math.max(boundaryMs, turn.created_at) + deadlineWindowMs;
    if (deadline <= now) continue;
    const nextAt =
      stats.attempts === 0
        ? Math.max(boundaryMs, turn.created_at) + initialDelayMs
        : stats.lastCheckedAt + retryDelayMs;
    if (nextAt > now) continue;
    const job: FollowupVerificationJob = {
      commandId: turn.command_id,
      intentId: turn.intent_id,
      eventId: turn.event_id,
      channel: turn.channel,
      targetKey: turn.target_key,
      boundary: turn.attempt_started_at!,
      textDigest: digest(turn.text),
      approvalDigest: digest(approval),
      attempts: stats.attempts,
      deadline,
    };
    if (!best || nextAt < best.nextAt) best = { job, nextAt };
  }
  return best?.job;
}

function readTurn(store: EventStore, commandId: string): FollowupTurnRow | undefined {
  if (!hasFollowupTables(store)) return undefined;
  return store.db
    .prepare("SELECT * FROM human_reply_turns WHERE command_id=?")
    .get(commandId) as FollowupTurnRow | undefined;
}

export function assertFollowupVerificationBound(store: EventStore, job: FollowupVerificationJob): FollowupTurnRow {
  const row = readTurn(store, job.commandId);
  const event = store.event(job.eventId);
  const approval = parseApproval(row?.approval ?? null);
  requireSafe(
    row &&
      row.status === "UNCERTAIN" &&
      row.intent_id === job.intentId &&
      row.event_id === job.eventId &&
      row.target_key === job.targetKey &&
      row.target_key === targetKey(event.payload) &&
      row.attempt_started_at === job.boundary &&
      digest(row.text) === job.textDigest &&
      approval &&
      digest(approval) === job.approvalDigest,
    "VERIFICATION_BINDING_CHANGED",
  );
  return row;
}

export function commitFollowupVerificationResult(
  store: EventStore,
  now: number,
  job: FollowupVerificationJob,
  security: string,
  result: FollowupVerificationResult,
  recordAttempt = true,
): boolean {
  return store.db
    .transaction(() => {
      assertSecurityRevision(store, job.channel, security);
      const row = assertFollowupVerificationBound(store, job);
      let verified = result.verified;
      if (verified) {
        requireSafe(
          typeof result.proofDigest === "string" &&
            hash64.test(result.proofDigest) &&
            typeof result.nativeIdDigest === "string" &&
            hash64.test(result.nativeIdDigest),
          "VERIFICATION_BINDING_CHANGED",
        );
        if (row.native_id_digest && row.native_id_digest !== result.nativeIdDigest) {
          verified = false;
        }
      }
      if (recordAttempt) {
        store.db
          .prepare("INSERT INTO audit_events VALUES(?,?,?,?,?)")
          .run(
            randomUUID(),
            new Date(now).toISOString(),
            attemptAuditType,
            job.intentId,
            JSON.stringify({
              commandId: job.commandId,
              verified,
              evidenceId: result.evidenceId,
              checkedAt: now,
              previousProofRef: row.proof_ref,
            }),
          );
      }
      if (verified) {
        const verifiedAt = new Date(Math.max(now, Date.parse(job.boundary))).toISOString();
        store.db
          .prepare(
            "UPDATE human_reply_turns SET status='CONFIRMED',proof_ref=?,verified_at=?,native_id_digest=?,reason=NULL WHERE command_id=? AND status='UNCERTAIN'",
          )
          .run(result.proofDigest, verifiedAt, result.nativeIdDigest, job.commandId);
        store.audit("HUMAN_FOLLOWUP_DELIVERY_VERIFIED", job.intentId, { verified: true });
      } else {
        store.audit("HUMAN_FOLLOWUP_PROOF_INCOMPLETE", job.intentId, { verified: false });
      }
      return verified;
    })
    .immediate();
}

export function commitFollowupVerificationFailure(
  store: EventStore,
  now: number,
  job: FollowupVerificationJob,
  cause: unknown,
): string {
  const error = cause instanceof Blocked ? cause.code : "VERIFICATION_FAILED_PRIVATE_DIAGNOSTICS";
  store.db
    .transaction(() => {
      store.db
        .prepare("INSERT INTO audit_events VALUES(?,?,?,?,?)")
        .run(
          randomUUID(),
          new Date(now).toISOString(),
          attemptAuditType,
          job.intentId,
          JSON.stringify({ commandId: job.commandId, verified: false, error, checkedAt: now }),
        );
      store.audit("HUMAN_FOLLOWUP_PROOF_INCOMPLETE", job.intentId, { verified: false });
    })
    .immediate();
  return error;
}

/** Read-only verification against the live browser page for an UNCERTAIN human followup turn. */
export async function verifyFollowupInBrowser(
  browser: BrowserService,
  store: EventStore,
  commandId: string,
  options: { signal?: AbortSignal; background?: boolean } = {},
): Promise<FollowupVerificationResult> {
  requireSafe(!options.signal?.aborted, "COLLECTION_CANCELLED");
  const turn = readTurn(store, commandId);
  const approval = parseApproval(turn?.approval ?? null);
  requireSafe(
    turn && turn.intent_id && turn.attempt_started_at && approval && turn.status === "UNCERTAIN",
    "INTENT_REQUIRED",
  );
  const event = store.event(turn.event_id);
  await browser.open(browser.status().mode, options.signal);
  const manualMedia = !!approval.snapshot.manualObservation;
  const handle = await browser.adapter(event.payload, store, undefined, {
    manualMedia,
    ...(options.signal ? { readonlySignal: options.signal } : {}),
  });
  try {
    const proof: SendProof | null = await browser.actor.run(
      async () => {
        requireSafe(!options.signal?.aborted, "COLLECTION_CANCELLED");
        if (handle.adapter instanceof ObservedCommentReply) {
          return handle.adapter.verifyExisting(event.payload, turn.text, turn.attempt_started_at!);
        }
        if (handle.adapter instanceof ObservedDmReply) {
          return handle.adapter.verifyExisting(
            event.payload,
            turn.text,
            turn.attempt_started_at!,
            approval.snapshot.contextDigest,
          );
        }
        await handle.adapter.inspect(event.payload);
        return handle.adapter.readback(event.payload, turn.text, [], turn.attempt_started_at!);
      },
      options.background ? "background" : "interactive",
    );
    requireSafe(!options.signal?.aborted, "VERIFICATION_CANCELLED");
    const status = browser.status();
    const rawVersion = status.version ?? browser.identity(event.payload.channel)?.browserVersion ?? "";
    const browserVersion = /^\d+\.\d+\.\d+\.\d+$/u.test(rawVersion) ? rawVersion : "0.0.0.0";
    const evidenceId = await recordEvidence(join(browser.root, "evidence"), {
      caseId: event.payload.channel === "DIRECT_MESSAGE" ? "D05" : "C05",
      browserVersion,
      mode: status.mode,
      taskId: turn.event_id,
      action: "OBSERVE",
      result: proof ? "PASS" : "BLOCKED",
      source: "AUTOMATED_REAL",
      diagnostics: ["CLIENT_READ_ONLY_RECHECK", "HUMAN_FOLLOWUP_RECHECK", "ORIGINAL_RECEIPTS_RETAINED"],
      proofDigest: proof ? digest(proof) : null,
    });
    return {
      verified: !!proof,
      evidenceId,
      ...(proof ? { proofDigest: digest(proof), nativeIdDigest: digest(proof.id) } : {}),
    };
  } finally {
    handle.dispose();
  }
}

export function findUncertainFollowupForEvent(store: EventStore, eventId: string): FollowupTurnRow | undefined {
  if (!hasFollowupTables(store)) return undefined;
  return store.db
    .prepare(
      "SELECT * FROM human_reply_turns WHERE event_id=? AND status='UNCERTAIN' AND intent_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
    )
    .get(eventId) as FollowupTurnRow | undefined;
}

/** Explicit read-only reconciliation for an UNCERTAIN human followup turn. */
export async function reconcileUncertainFollowup(
  store: EventStore,
  browser: BrowserService,
  turn: FollowupTurnRow,
  now: () => number,
  emit: () => void,
): Promise<{ verified: boolean; evidenceId: string; nativeIdDigest?: string }> {
  const approval = parseApproval(turn.approval);
  requireSafe(turn.intent_id && turn.attempt_started_at && approval, "INTENT_REQUIRED");
  const event = store.event(turn.event_id);
  const security = securityRevision(store, event.payload.channel);
  const job: FollowupVerificationJob = {
    commandId: turn.command_id,
    intentId: turn.intent_id,
    eventId: turn.event_id,
    channel: event.payload.channel,
    targetKey: turn.target_key,
    boundary: turn.attempt_started_at,
    textDigest: digest(turn.text),
    approvalDigest: digest(approval),
    attempts: 0,
    deadline: now() + 30_000,
  };
  const result = await verifyFollowupInBrowser(browser, store, turn.command_id);
  const verified = commitFollowupVerificationResult(store, now(), job, security, result, false);
  emit();
  return {
    verified,
    evidenceId: result.evidenceId,
    ...(verified && result.nativeIdDigest ? { nativeIdDigest: result.nativeIdDigest } : {}),
  };
}
