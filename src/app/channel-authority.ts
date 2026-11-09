import { digest, requireSafe, isStrong, targetKey, validText, type Channel, type TargetSnapshot } from '../core/contracts.js';
import type { EventStore } from '../storage/store.js';

export interface CapabilityIdentity {
  identityDigest: string;
  mappingDigest: string;
  browserVersion: string;
  browserMode: "headed" | "headless";
}
/** Channel evidence and historical controlled trials; independent from operator/session ownership. */
export class ChannelAuthority {
  constructor(readonly store: EventStore, readonly now: () => number) {}
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
}
