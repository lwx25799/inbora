import { Blocked, digest, requireSafe, validText } from "../core/contracts.js";
import type { ModelCallPurpose, ModelRouteSnapshot, ModelSelection } from "../contracts/model-providers.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type { Grant, ReplyPolicy } from "../contracts/automation.js";
import { bindModelGrant, grantMatchesModel } from "../storage/model-grant-binding.js";
import type { GenerationOwner, ModelProviderStore } from "../storage/model-provider-store.js";
import { ReplyKnowledgeStore } from "../knowledge/store.js";
import type { ReplyKnowledgeContext } from "../knowledge/contracts.js";

type BusinessPurpose = Exclude<ModelCallPurpose, "PROVIDER_TEST">;
export type BusinessRoute = Exclude<ModelRouteSnapshot, { purpose: "PROVIDER_TEST" }>;
export type RouteRevision = NonNullable<ReturnType<ModelProviderStore["getRevision"]>>;
const grantKinds = ["MODEL", "AUTO_REPLY"] as const;

export function sameReplyPolicy(previous: ReplyPolicy, current: ReplyPolicy, nested: boolean): boolean {
  const rules = ({ modelLimit: _model, sendLimit: _send, expiresAt: _expiry, replyToNestedComments,
    contractVersion: _version, modelBinding: _binding, ...scope }: ReplyPolicy & {
      contractVersion?: unknown; modelBinding?: unknown;
    }) =>
    ({ ...scope, ...(nested ? { replyToNestedComments: replyToNestedComments !== false } : {}) });
  return digest(rules(previous)) === digest(rules(current));
}

export class ModelRouteGuard {
  constructor(readonly models: ModelProviderStore, readonly automation: AutomationStore) {}

  current() {
    const selection = this.models.getSelection();
    const route = selection.connectionId && this.models.getRevision(selection.connectionId, selection.routeRevision);
    requireSafe(route && selection.modelId, "MODEL_CONNECTION_NOT_APPLIED");
    return { selection, route, modelId: selection.modelId };
  }

  eligibleGrant(kind: Grant["kind"]): Grant | null {
    const grant = this.automation.active(kind);
    if (!grant) return null;
    const { selection, route } = this.current();
    return grantMatchesModel(grant, selection, route) ? grant : null;
  }

  statusProjection(): { route: ModelRouteGuard; corrupt: Grant["kind"][] } {
    const corrupt = grantKinds.filter(kind => {
      try { this.automation.active(kind); return false; }
      catch (error) {
        if (error instanceof Blocked && error.code === "GRANT_CORRUPT") return true;
        throw error;
      }
    });
    const route = corrupt.length
      ? Object.assign(new ModelRouteGuard(this.models, this.automation), { eligibleGrant: () => null })
      : this;
    return { route, corrupt };
  }

  snapshot(grant: Grant, purpose: BusinessPurpose): BusinessRoute {
    const { selection, route, modelId } = this.current();
    requireSafe(grantMatchesModel(grant, selection, route), "MODEL_OUTSIDE_GRANT");
    requireSafe(route.credentialRevision && this.models.isCredentialActive({ ...route, credentialRevision: route.credentialRevision }),
      "MODEL_KEY_REQUIRED");
    return Object.freeze({
      purpose, modelId, connectionId: route.connectionId, routeRevision: route.routeRevision,
      credentialRevision: route.credentialRevision, protocol: route.protocol, endpointDigest: route.endpointDigest,
      presetId: route.presetId, selectionRevision: selection.selectionRevision, grantVersion: grant.version,
    });
  }

  assertCurrent(snapshot: BusinessRoute, kind: Grant["kind"]): void {
    const { selection, route } = this.current();
    requireSafe(selection.selectionRevision === snapshot.selectionRevision && selection.modelId === snapshot.modelId
      && route.connectionId === snapshot.connectionId && route.routeRevision === snapshot.routeRevision
      && route.credentialRevision === snapshot.credentialRevision && route.protocol === snapshot.protocol
      && route.endpointDigest === snapshot.endpointDigest && route.presetId === snapshot.presetId
      && this.models.isCredentialActive({ ...route, credentialRevision: snapshot.credentialRevision }), "MODEL_ROUTE_CHANGED");
    requireSafe(!this.automation.state().emergencyStopped, "EMERGENCY_STOPPED");
    const grant = this.automation.active(kind);
    requireSafe(grant?.version === snapshot.grantVersion && grantMatchesModel(grant, selection, route), "GRANT_REVOKED");
    this.automation.requireAccount(grant.scope.ownId);
  }

  assertAutomaticDraft(owner: GenerationOwner, grantVersion: number, eventId: string): void {
    const { store } = this.automation;
    if (this.isVerifiedDirectFaqDraft(owner, grantVersion, eventId)) {
      return;
    }
    const id = this.models.getGenerationCallId(owner);
    requireSafe(id, "LEGACY_MODEL_ROUTE_UNPROVEN");
    const call = this.models.getCallRoute(id);
    requireSafe(call?.purpose === "REPLY_GENERATION" && call.outcome === "SUCCEEDED"
      && call.grantVersion !== null && call.selectionRevision !== null, "MODEL_ROUTE_CHANGED");
    const { selection, route } = this.current();
    this.assertCurrent({
      purpose: call.purpose, connectionId: call.connectionId, routeRevision: call.routeRevision,
      credentialRevision: call.credentialRevision, selectionRevision: call.selectionRevision,
      protocol: call.protocol, endpointDigest: call.endpointDigest, presetId: route.presetId,
      modelId: call.requestedModel, grantVersion,
    }, "AUTO_REPLY");
    const reservation = store.db.prepare("SELECT reserved_at FROM grant_reservations WHERE grant_version=? AND kind='MODEL' AND job_key=?").pluck();
    const original = reservation.get(call.grantVersion, eventId);
    requireSafe(original !== undefined && original === reservation.get(grantVersion, eventId), "POLICY_NO_LONGER_AUTHORIZED");
    if (call.grantVersion === grantVersion) return;

    // An explicit policy revision may inherit this paid draft when only its limits changed.
    const row = store.db.prepare("SELECT scope_json,scope_digest FROM automation_grants WHERE version=? AND kind='AUTO_REPLY'")
      .get(call.grantVersion) as { scope_json: string; scope_digest: string } | undefined;
    requireSafe(row, "POLICY_NO_LONGER_AUTHORIZED");
    const previous = this.automation.readGrantScope("AUTO_REPLY", row);
    const current = this.automation.active("AUTO_REPLY")!;
    requireSafe(grantMatchesModel({ ...current, version: call.grantVersion, scope: previous }, selection, route) &&
      sameReplyPolicy(previous as ReplyPolicy, current.scope as ReplyPolicy, store.event(eventId).payload.kind === "REPLY"),
    "POLICY_NO_LONGER_AUTHORIZED");
  }

  /**
   * 仅放行严格核验的高置信 FAQ 确定性免模型直出草稿（AUTO_FAQ_DIRECT）：
   * 必须同时满足草稿 model/origin 标记、归属当前有效 AUTO_REPLY 策略（或规则未变的策略版本）、
   * 绑定知识快照重检仍一致、确实产出 exactFaqMatch 且 validText(exactFaqMatch.text) === draft.text，且未急停。
   */
  private isVerifiedDirectFaqDraft(owner: GenerationOwner, grantVersion: number, eventId: string): boolean {
    if (owner.ownerKind !== "DRAFT") return false;
    const { store } = this.automation;
    const draft = store.db.prepare(
      `SELECT d.event_id, d.text, d.model, d.version, r.origin, r.operator_id
       FROM reply_drafts d
       JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
       WHERE d.id=? AND d.version=?`,
    ).get(owner.ownerId, owner.ownerVersion) as
      | { event_id: string; text: string; model: string; version: number; origin: string; operator_id: string }
      | undefined;
    if (!draft || draft.event_id !== eventId || draft.model !== "AUTO_FAQ_DIRECT" || draft.origin !== "AUTO_FAQ_DIRECT") {
      return false;
    }
    const match = /^policy:(\d+)$/u.exec(draft.operator_id);
    requireSafe(match, "POLICY_NO_LONGER_AUTHORIZED");
    const originGrantVersion = Number(match[1]);
    requireSafe(!this.automation.state().emergencyStopped, "EMERGENCY_STOPPED");
    const active = this.automation.active("AUTO_REPLY") as Grant<ReplyPolicy> | null;
    requireSafe(active?.version === grantVersion, "GRANT_REVOKED");
    this.automation.requireAccount(active.scope.ownId);
    // 必须存在与本草稿版本绑定的知识库快照，并实时重检产出 exactFaqMatch 且与草稿全文逐字一致
    const ctxRow = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='k_generation_contexts'").get()
      ? (store.db.prepare("SELECT snapshot_json FROM k_generation_contexts WHERE kind='DRAFT' AND entity_id=? AND version=?")
          .get(owner.ownerId, owner.ownerVersion) as { snapshot_json: string } | undefined)
      : undefined;
    requireSafe(ctxRow, "KNOWLEDGE_CONTEXT_INVALID");
    let snapshot: ReplyKnowledgeContext;
    try {
      snapshot = JSON.parse(ctxRow.snapshot_json) as ReplyKnowledgeContext;
      requireSafe(
        snapshot &&
          typeof snapshot.fingerprint === "string" &&
          typeof snapshot.query === "string" &&
          snapshot.accountId === store.accountId,
        "KNOWLEDGE_CONTEXT_INVALID",
      );
    } catch {
      requireSafe(false, "KNOWLEDGE_CONTEXT_INVALID");
    }
    const event = store.event(eventId);
    requireSafe(snapshot.channel === event.payload.channel, "KNOWLEDGE_CONTEXT_INVALID");
    const rechecked = new ReplyKnowledgeStore(store, { now: this.automation.now }).context(
      snapshot.accountId,
      snapshot.channel,
      snapshot.query,
      {
        ...(snapshot.accountPersonaOnly
          ? { personaId: null }
          : snapshot.personaPinned && snapshot.personaId
            ? { personaId: snapshot.personaId }
            : {}),
        ...(snapshot.sourceIds ? { sourceIds: snapshot.sourceIds } : {}),
        ...(snapshot.minScore !== undefined ? { minScore: snapshot.minScore } : {}),
      },
    );
    requireSafe(rechecked.fingerprint === snapshot.fingerprint, "KNOWLEDGE_CONTEXT_CHANGED");
    requireSafe(rechecked.conflicts.length === 0 && rechecked.exactFaqMatch, "KNOWLEDGE_CONTEXT_INVALID");
    requireSafe(validText(rechecked.exactFaqMatch.text) === draft.text, "KNOWLEDGE_CONTEXT_INVALID");
    if (originGrantVersion !== grantVersion) {
      const row = store.db.prepare("SELECT scope_json,scope_digest FROM automation_grants WHERE version=? AND kind='AUTO_REPLY'")
        .get(originGrantVersion) as { scope_json: string; scope_digest: string } | undefined;
      requireSafe(row, "POLICY_NO_LONGER_AUTHORIZED");
      const previous = this.automation.readGrantScope("AUTO_REPLY", { ...row, grant_version: originGrantVersion }) as ReplyPolicy;
      requireSafe(
        sameReplyPolicy(previous, active.scope, event.payload.kind === "REPLY"),
        "POLICY_NO_LONGER_AUTHORIZED",
      );
    }
    return true;
  }

  switchGrants(previous: ModelSelection, next: ModelSelection, route: RouteRevision, legacyOnly = false): void {
    const { store, now } = this.automation;
    requireSafe(store.db.inTransaction, "MODEL_PROVIDER_SCHEMA_INVALID");
    const budget = () => digest([store.budget("MODEL"), store.budget("SEND")]);
    const reservations = (version: number) => store.db.prepare(
      "SELECT kind,job_key,reserved_at FROM grant_reservations WHERE grant_version=? ORDER BY kind,job_key",
    ).all(version);
    const before = budget();
    const previousRoute = previous.connectionId && this.models.getRevision(previous.connectionId, previous.routeRevision);
    for (const kind of grantKinds) {
      let active: Grant | null;
      try { active = this.automation.active(kind); }
      catch (error) {
        if (legacyOnly && error instanceof Blocked && error.code === "GRANT_CORRUPT") continue;
        throw error;
      }
      if (!active || active.scope.ownId !== store.accountOwnId(this.automation.accountId)) continue;
      const { scope, version } = active;
      if (legacyOnly && "contractVersion" in scope) continue;
      if (!("contractVersion" in scope) && (!previousRoute || !grantMatchesModel(active, previous, previousRoute))) continue;
      const rows = digest(reservations(version));
      const updated = bindModelGrant(kind, scope, next, route);
      this.automation.revoke(kind);
      const { lastInsertRowid } = store.db.prepare(
        "INSERT INTO automation_grants(kind,scope_json,scope_digest,created_at) VALUES(?,?,?,?)",
      ).run(kind, JSON.stringify(updated), digest(updated), now());
      store.db.prepare("INSERT INTO grant_reservations SELECT ?,kind,job_key,reserved_at FROM grant_reservations WHERE grant_version=?")
        .run(lastInsertRowid, version);
      requireSafe(rows === digest(reservations(Number(lastInsertRowid))), "MODEL_GRANT_RESERVATIONS_CHANGED");
      store.audit("PERSISTENT_GRANT_ENABLED", String(lastInsertRowid));
    }
    requireSafe(budget() === before, "MODEL_SWITCH_BUDGET_CHANGED");
  }

  invalidateUnsent(reason: "MODEL_ROUTE_CHANGED" | "LEGACY_MODEL_ROUTE_UNPROVEN"): void {
    const { store, now } = this.automation;
    const ts = now();
    const legacy = reason === "LEGACY_MODEL_ROUTE_UNPROVEN" ? `
      AND NOT EXISTS (SELECT 1 FROM reply_drafts d JOIN m_generation_bindings b ON b.owner_kind='DRAFT'
        AND b.owner_id=d.id AND b.owner_version=d.version WHERE d.event_id=automation_jobs.event_id)
      AND EXISTS (SELECT 1 FROM reply_drafts d JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
        WHERE d.event_id=automation_jobs.event_id AND r.origin='AUTO_POLICY')` : "";
    const legacyCommand = reason === "LEGACY_MODEL_ROUTE_UNPROVEN" ? `
      AND NOT EXISTS (SELECT 1 FROM m_generation_bindings b WHERE b.owner_kind='DRAFT'
        AND b.owner_id=json_extract(manual_send_commands.params,'$.draftId')
        AND b.owner_version=json_extract(manual_send_commands.params,'$.draftVersion'))
      AND EXISTS (SELECT 1 FROM reply_drafts d JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
        WHERE d.id=json_extract(manual_send_commands.params,'$.draftId')
        AND d.version=json_extract(manual_send_commands.params,'$.draftVersion')
        AND r.origin='AUTO_POLICY')` : "";
    store.db.prepare(`UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason=?
        WHERE command_id IN (SELECT command_id FROM policy_commands) AND intent_id IS NULL
        AND (status IN ('PREPARING','PREVIEW','QUEUED','PREFLIGHT') OR (?='LEGACY_MODEL_ROUTE_UNPROVEN' AND status='FAILED_BEFORE_CLICK'))
        AND NOT EXISTS (SELECT 1 FROM send_intents i WHERE i.event_id=manual_send_commands.event_id)${legacyCommand}`).run(reason, reason);
    store.db.prepare(`UPDATE automation_jobs SET state='REVIEW',reason=?,updated_at=? WHERE
      NOT EXISTS (SELECT 1 FROM send_intents i WHERE i.event_id=automation_jobs.event_id)
      AND (draft_version>0 OR state IN ('QUALIFYING','GENERATING','PREPARING','QUEUED','PREFLIGHT'))
      AND reason IS NOT 'LEGACY_MODEL_ROUTE_UNPROVEN'${legacy}`)
      .run(reason, ts);
    // 锚点因路由失效置为 REVIEW 时，同步把关联的 MERGED 碎片也置为 REVIEW，防止前序碎片永久滞留
    store.db.prepare(`UPDATE automation_jobs SET state='REVIEW',reason=?,updated_at=? WHERE
      state='MERGED' AND command_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM send_intents i WHERE i.event_id=automation_jobs.event_id)
      AND NOT EXISTS (SELECT 1 FROM reply_drafts d WHERE d.event_id=automation_jobs.event_id)
      AND EXISTS (
        SELECT 1 FROM automation_jobs anchor
        WHERE anchor.command_id=automation_jobs.command_id
          AND anchor.event_id<>automation_jobs.event_id
          AND anchor.state='REVIEW' AND anchor.reason=?
      )`).run(reason, ts, reason);
    if (reason === "MODEL_ROUTE_CHANGED") store.audit(reason, store.accountId);
  }
}
