import { digest, isStrong, requireSafe, targetKey, type StoredEvent } from "../core/contracts.js";
import { collectionSchema, modelGrantSchema, replyPolicySchema, type CollectionSettings, type Grant, type ModelGrant, type ReplyPolicy } from "../app/automation-contracts.js";
import type { EventStore } from "./store.js";

export class AutomationStore {
  constructor(readonly store: EventStore, readonly now: () => number = Date.now) {}
  initialize(startedAt: number): void {
    requireSafe(Number.isSafeInteger(startedAt) && startedAt > 0 && startedAt <= this.now(), "AUTOMATION_START_INVALID");
    this.store.db.prepare("INSERT OR IGNORE INTO automation_state(id,started_at,collection_json) VALUES(1,?,?)")
      .run(startedAt, JSON.stringify(null));
    for (const source of ["works", "dm"])
      this.store.db.prepare("INSERT OR IGNORE INTO collection_progress(source) VALUES(?)").run(source);
  }
  state() {
    const row = this.store.db.prepare("SELECT * FROM automation_state WHERE id=1").get() as {
      started_at: number; emergency_stopped: number; collection_json: string;
    };
    const raw: unknown = JSON.parse(row.collection_json);
    return { startedAt: row.started_at, emergencyStopped: !!row.emergency_stopped,
      collection: raw === null ? null : collectionSchema.parse(raw) };
  }
  requireAccount(ownId: string): void {
    const row = this.store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id: string} | undefined;
    requireSafe(row?.own_id === ownId, "ACCOUNT_NOT_VERIFIED");
  }
  configureCollection(settings: CollectionSettings): void {
    const parsed = collectionSchema.parse(settings);
    this.requireAccount(parsed.ownId);
    this.store.db.prepare("UPDATE automation_state SET collection_json=? WHERE id=1").run(JSON.stringify(parsed));
    this.store.audit("COLLECTION_CONFIGURED", digest(parsed.ownId), {comments: parsed.comments, inbox: parsed.inbox});
  }
  stop(stopped: boolean): void {
    this.store.db.prepare("UPDATE automation_state SET emergency_stopped=? WHERE id=1").run(Number(stopped));
  }
  grant(kind: "MODEL", scope: ModelGrant): Grant<ModelGrant>;
  grant(kind: "AUTO_REPLY", scope: ReplyPolicy): Grant<ReplyPolicy>;
  grant(kind: "MODEL" | "AUTO_REPLY", scope: ModelGrant | ReplyPolicy): Grant {
    const parsed = kind === "MODEL" ? modelGrantSchema.parse(scope) : replyPolicySchema.parse({...scope,containsAny:[]});
    if(kind==='AUTO_REPLY'){
      const policy=parsed as ReplyPolicy;
      requireSafe(policy.channels.every(channel=>channel==='DIRECT_MESSAGE'?policy.entireInbox||policy.conversationIds.length>0:
        policy.futureOwnWorks||policy.workIds.length>0),'POLICY_TARGETS_REQUIRED');
    }
    this.requireAccount(parsed.ownId);
    requireSafe(parsed.expiresAt === null || parsed.expiresAt > this.now(), "GRANT_EXPIRED");
    return this.store.db.transaction(() => {
      const previous=this.active(kind);
      const used=(budgetKind:'MODEL'|'SEND')=>previous?(this.store.db.prepare('SELECT count(*) n FROM grant_reservations WHERE grant_version=? AND kind=?')
        .get(previous.version,budgetKind) as {n:number}).n:0;
      this.saveBudgetLimit('MODEL',parsed.modelLimit,used('MODEL'));
      if(kind==='AUTO_REPLY')this.saveBudgetLimit('SEND',(parsed as ReplyPolicy).sendLimit,used('SEND'));
      this.revoke(kind);
      const row = this.store.db.prepare("INSERT INTO automation_grants(kind,scope_json,scope_digest,created_at) VALUES(?,?,?,?)")
        .run(kind, JSON.stringify(parsed), digest(parsed), this.now());
      this.store.audit("PERSISTENT_GRANT_ENABLED", String(row.lastInsertRowid));
      if(previous)this.store.db.prepare('INSERT INTO grant_reservations SELECT ?,kind,job_key,reserved_at FROM grant_reservations WHERE grant_version=?')
        .run(row.lastInsertRowid,previous.version);
      return {version: Number(row.lastInsertRowid), kind, scope: parsed, createdAt: this.now()};
    }).immediate();
  }
  private saveBudgetLimit(kind:'MODEL'|'SEND',limit:number|null,inherited:number):void{
    const global=this.store.budget(kind);
    requireSafe(limit===null||limit>=inherited,`${kind}_BUDGET_EXCEEDED`);
    const maximum=limit===null?null:global.maximum===null?global.used+limit-inherited:global.maximum;
    requireSafe(limit===null||maximum!==null&&limit-inherited<=maximum-global.used,`${kind}_BUDGET_EXCEEDED`);
    requireSafe(maximum===null||Number.isSafeInteger(maximum),`${kind}_BUDGET_EXCEEDED`);
    const result=this.store.db.prepare('UPDATE budget_limits SET maximum=? WHERE kind=?').run(maximum,kind);
    requireSafe(result.changes===1,'BUDGET_POLICY_UNAVAILABLE');
    if(maximum!==global.maximum)this.store.audit('BUDGET_POLICY_CHANGED',kind,{unlimited:maximum===null,...(maximum===null?{}:{maximum})});
  }
  revoke(kind: "MODEL" | "AUTO_REPLY"): void {
    this.store.db.prepare("UPDATE automation_grants SET revoked_at=? WHERE kind=? AND revoked_at IS NULL").run(this.now(), kind);
    this.store.audit("PERSISTENT_GRANT_REVOKED", kind);
  }
  active(kind: "MODEL" | "AUTO_REPLY"): Grant | null {
    const row = this.store.db.prepare("SELECT * FROM automation_grants WHERE kind=? AND revoked_at IS NULL ORDER BY version DESC LIMIT 1").get(kind) as {
      version: number; scope_json: string; scope_digest: string; created_at: number;
    } | undefined;
    if (!row) return null;
    const scope = kind === "MODEL" ? modelGrantSchema.parse(JSON.parse(row.scope_json)) : replyPolicySchema.parse(JSON.parse(row.scope_json));
    requireSafe(digest(scope) === row.scope_digest, "GRANT_CORRUPT");
    if (scope.expiresAt !== null && scope.expiresAt <= this.now()) return null;
    return {version: row.version, kind, scope, createdAt: row.created_at};
  }
  /** Called inside the same transaction as the global model reservation or send intent. No refunds/replays. */
  allowance(version:number,kind:'MODEL'|'SEND'):boolean {
    const row=this.store.db.prepare('SELECT kind FROM automation_grants WHERE version=? AND revoked_at IS NULL').get(version) as {kind:'MODEL'|'AUTO_REPLY'}|undefined;
    if(!row)return false;
    const grant=this.active(row.kind);if(grant?.version!==version)return false;
    const used=this.store.db.prepare('SELECT count(*) AS used FROM grant_reservations WHERE grant_version=? AND kind=?').get(version,kind) as {used:number};
    const global=this.store.budget(kind),limit=kind==='MODEL'?grant.scope.modelLimit:(grant.scope as ReplyPolicy).sendLimit;
    return (limit===null||used.used<limit)&&(global.maximum===null||global.used<global.maximum);
  }
  reserve(version: number, kind: "MODEL" | "SEND", jobKey: string): void {
    this.store.db.transaction(() => {
      const row = this.store.db.prepare("SELECT kind FROM automation_grants WHERE version=? AND revoked_at IS NULL").get(version) as {kind: "MODEL" | "AUTO_REPLY"} | undefined;
      requireSafe(row, "GRANT_REVOKED");
      const grant = this.active(row.kind);
      requireSafe(grant?.version === version, "GRANT_REVOKED");
      this.requireAccount(grant.scope.ownId);
      requireSafe(!this.state().emergencyStopped, "EMERGENCY_STOPPED");
      const used = this.store.db.prepare("SELECT count(*) AS used FROM grant_reservations WHERE grant_version=? AND kind=?").get(version, kind) as {used: number};
      const limit = kind === "MODEL" ? grant.scope.modelLimit : (grant.scope as ReplyPolicy).sendLimit;
      requireSafe(limit===null||Number.isInteger(limit)&&used.used<limit, `${kind}_GRANT_EXHAUSTED`);
      requireSafe(!this.store.db.prepare("SELECT job_key FROM grant_reservations WHERE grant_version=? AND kind=? AND job_key=?").get(version, kind, jobKey), "GRANT_JOB_ALREADY_RESERVED");
      this.store.db.prepare("INSERT INTO grant_reservations VALUES(?,?,?,?)").run(version, kind, jobKey, this.now());
    }).immediate();
  }
  policyMatches(grant: Grant<ReplyPolicy>, e: StoredEvent, status: 'NEW'|'DRAFT'='NEW'): boolean {
    const active = this.active("AUTO_REPLY");
    if (active?.version !== grant.version || this.state().emergencyStopped || !isStrong(e.payload) ||
      !(status==='NEW'?['AWAITING_DRAFT']:['AWAITING_APPROVAL','APPROVED']).includes(e.status)) return false;
    const p = active.scope as ReplyPolicy;
    if(e.payload.channel==='COMMENT_NOTIFICATION'&&e.payload.kind==='REPLY'&&p.replyToNestedComments===false)return false;
    this.requireAccount(p.ownId);
    const client = this.store.db.prepare("SELECT paused,mode FROM client_state WHERE id=1").get() as {paused: number; mode: string};
    if (client.paused || client.mode !== "LIMITED_AUTO") return false;
    if (!p.channels.includes(e.payload.channel) || e.payload.direction !== "INCOMING" || e.payload.actorId === p.ownId) return false;
    if (this.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(e.id)||this.store.sendFrozen(e.id)) return false;
    const paused = this.store.db.prepare("SELECT paused FROM pauses WHERE target_key=?").get(targetKey(e.payload)) as {paused: number} | undefined;
    // Only an active editing lease pauses a conversation; merely viewing it must not leave a persistent handoff.
    const owner = this.store.db.prepare("SELECT operator_id,lease_expires_at FROM thread_ownership WHERE target_key=?").get(targetKey(e.payload)) as {operator_id: string | null;lease_expires_at:number} | undefined;
    if (paused?.paused || owner?.operator_id&&owner.lease_expires_at>this.now()) return false;
    const hour = Number(new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23"}).format(this.now()));
    if (hour < p.startHour || hour >= p.endHour) return false;
    const text = e.payload.text.toLocaleLowerCase();
    if (p.excludesAny.some(s => text.includes(s.toLocaleLowerCase())) || (p.containsAny.length && !p.containsAny.some(s => text.includes(s.toLocaleLowerCase())))) return false;
    if (e.payload.channel === "DIRECT_MESSAGE") return p.entireInbox || p.conversationIds.includes(e.payload.conversationId!);
    if (p.workIds.includes(e.payload.videoId!)) return true;
    const work = this.store.db.prepare("SELECT own_id,state FROM discovered_works WHERE id=?").get(e.payload.videoId) as {own_id: string; state: string} | undefined;
    return p.futureOwnWorks && work?.own_id === p.ownId && work.state === "INCLUDED";
  }
  registerWork(work: {id: string; ownId: string; url: string; publishedAt: number | null; precisionMs: number}): string {
    this.requireAccount(work.ownId);
    const url = new URL(work.url);
    requireSafe(!url.username && !url.password && !url.search && !url.hash &&
      (url.origin === "https://www.douyin.com" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) &&
      [ `/video/${work.id}`, `/note/${work.id}` ].includes(url.pathname), "UNSAFE_OBSERVATION_URL");
    requireSafe(work.precisionMs >= 1 && Number.isSafeInteger(work.precisionMs) && (work.publishedAt === null || Number.isSafeInteger(work.publishedAt)), "WORK_TIME_INVALID");
    const start = this.state().startedAt;
    const state = work.publishedAt === null || work.publishedAt > this.now() || (work.publishedAt <= start && work.publishedAt + work.precisionMs > start)
      ? "REVIEW" : work.publishedAt > start ? "INCLUDED" : "HISTORICAL";
    return this.store.db.transaction(() => {
      const old = this.store.db.prepare("SELECT own_id,url,published_at,precision_ms,state FROM discovered_works WHERE id=?").get(work.id) as {
        own_id: string; url: string; published_at: number | null; precision_ms: number; state: string;
      } | undefined;
      if (old) {
        requireSafe(old.own_id === work.ownId && old.url === work.url, "WORK_IDENTITY_CONFLICT");
        // Missing time is absence of evidence; a verified interval may only be narrowed, never contradicted.
        if (work.publishedAt === null) {
          this.store.db.prepare("UPDATE discovered_works SET last_seen=? WHERE id=?").run(this.now(), work.id);
          return old.state;
        }
        const same = old.published_at === work.publishedAt && old.precision_ms === work.precisionMs;
        const narrower = old.state === "REVIEW" && (old.published_at === null ||
          (work.publishedAt >= old.published_at && work.publishedAt + work.precisionMs <= old.published_at + old.precision_ms));
        requireSafe(same || narrower, "WORK_IDENTITY_CONFLICT");
        if (!same || old.state !== state) this.store.audit("WORK_PUBLICATION_REFINED", digest(work.id), {
          previousTime: old.published_at ?? 0, previousPrecision: old.precision_ms,
          time: work.publishedAt, precision: work.precisionMs,
        });
        this.store.db.prepare("UPDATE discovered_works SET published_at=?,precision_ms=?,state=?,last_seen=? WHERE id=?")
          .run(work.publishedAt, work.precisionMs, state, this.now(), work.id);
        return state;
      }
      this.store.db.prepare("INSERT INTO discovered_works VALUES(?,?,?,?,?,?,?,?)").run(work.id, work.ownId, work.url, work.publishedAt, work.precisionMs, state, this.now(), this.now());
      this.store.audit("OWN_WORK_DISCOVERED", digest(work.id), {included: state === "INCLUDED", review: state === "REVIEW"});
      return state;
    }).immediate();
  }
}
