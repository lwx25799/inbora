import { Blocked, DEFAULT_ACCOUNT_ID, digest, isManualMediaCandidate, isStrong, requireSafe, targetKey, type StoredEvent } from "../core/contracts.js";
import { collectionSchema, type CollectionSettings, type Grant, type ModelGrant, type ReplyPolicy } from "../app/automation-contracts.js";
import { currentModelGrantScope, parseStoredModelGrant } from "./model-grant-binding.js";
import type { EventStore } from "./store.js";
import type {EmergencySource} from '../core/emergency-stop.js';
import {readEmergencyStop,recordEmergencyStop,emergencyRevision,isEmergencyStopped,resumeEmergency} from './emergency-stop.js';
import {readSecurityHold,assertSecurityChannelClear} from './security-holds.js';
import type { AccountId } from "../contracts/account.js";

export class AutomationStore {
  constructor(readonly store: EventStore, readonly now: () => number = Date.now,
    readonly accountId: AccountId = store.accountId) {
    store.assertAccount(accountId);
  }
  initialize(startedAt: number): void {
    requireSafe(Number.isSafeInteger(startedAt) && startedAt > 0 && startedAt <= this.now(), "AUTOMATION_START_INVALID");
    this.store.db.transaction(()=>{
      this.store.db.prepare("INSERT OR IGNORE INTO automation_state(id,started_at,collection_json,emergency_stopped) VALUES(1,?,?,?)")
        .run(startedAt, JSON.stringify(null), Number(isEmergencyStopped(this.store)));
    }).immediate();
    for (const source of ["works", "dm"])
      this.store.db.prepare("INSERT OR IGNORE INTO collection_progress(source) VALUES(?)").run(source);
  }
  state() {
    const row = this.store.db.prepare("SELECT * FROM automation_state WHERE id=1").get() as {
      started_at: number; emergency_stopped: number; collection_json: string;
    };
    const collectionJson = this.store.schemaVersion() >= 4
      ? this.store.db.prepare('SELECT collection_json FROM account_collection_config WHERE account_id=?').pluck().get(this.accountId) as string | undefined
      : row.collection_json;
    const raw: unknown = JSON.parse(collectionJson ?? 'null');
    return { startedAt: row.started_at, emergencyStopped: !!row.emergency_stopped,
      emergencyStop:row.emergency_stopped?readEmergencyStop(this.store):null,
      collection: raw === null ? null : collectionSchema.parse(raw) };
  }
  requireAccount(ownId: string): void {
    const bound = this.store.accountOwnId(this.accountId);
    requireSafe(bound && bound === ownId, "ACCOUNT_NOT_VERIFIED");
  }
  configureCollection(settings: CollectionSettings): void {
    const parsed = collectionSchema.parse(settings);
    this.requireAccount(parsed.ownId);
    const json = JSON.stringify(parsed);
    this.store.db.transaction(() => {
      const schema4 = this.store.schemaVersion() >= 4;
      if (schema4) this.store.db.prepare(`INSERT INTO account_collection_config (account_id, collection_json, updated_at)
        VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET collection_json=excluded.collection_json, updated_at=excluded.updated_at`)
        .run(this.accountId, json, this.now());
      if (!schema4 || this.accountId === DEFAULT_ACCOUNT_ID)
        this.store.db.prepare("UPDATE automation_state SET collection_json=? WHERE id=1").run(json);
      this.store.audit("COLLECTION_CONFIGURED", digest(parsed.ownId), {comments: parsed.comments, inbox: parsed.inbox});
    }).immediate();
  }
  stop(stopped:boolean,reason='MANUAL_EMERGENCY_STOP',source:EmergencySource='MANUAL'):void {
    recordEmergencyStop(this.store,stopped,this.now(),reason,source);
  }
  emergencyRevision():string {return emergencyRevision(this.store);}
  resumeEmergency(expectedRevision:string):boolean {return resumeEmergency(this.store,expectedRevision,this.now());}
  private grantFilter() {
    return this.store.schemaVersion() >= 4
      ? { sql: ' AND COALESCE((SELECT b.account_id FROM account_grant_bindings b WHERE b.grant_version=automation_grants.version), ?)=?',
        args: [DEFAULT_ACCOUNT_ID, this.accountId] }
      : { sql: '', args: [] };
  }
  grant(kind: "MODEL", scope: ModelGrant): Grant<ModelGrant>;
  grant(kind: "AUTO_REPLY", scope: ReplyPolicy): Grant<ReplyPolicy>;
  grant(kind: "MODEL" | "AUTO_REPLY", scope: ModelGrant | ReplyPolicy): Grant {
    return this.store.db.transaction(() => {
      const parsed = currentModelGrantScope(this.store, kind, kind === "MODEL" ? scope : {...scope,containsAny:[]});
      if(kind==='AUTO_REPLY'){
        const policy=parsed as ReplyPolicy;
        requireSafe(policy.channels.every(channel=>channel==='DIRECT_MESSAGE'?policy.entireInbox||policy.conversationIds.length>0:
          policy.futureOwnWorks||policy.workIds.length>0),'POLICY_TARGETS_REQUIRED');
      }
      this.requireAccount(parsed.ownId);
      requireSafe(parsed.expiresAt === null || parsed.expiresAt > this.now(), "GRANT_EXPIRED");
      const previous=this.active(kind);
      const used=(budgetKind:'MODEL'|'SEND')=>previous?(this.store.db.prepare('SELECT count(*) n FROM grant_reservations WHERE grant_version=? AND kind=?')
        .get(previous.version,budgetKind) as {n:number}).n:0;
      if (this.accountId === DEFAULT_ACCOUNT_ID) {
        this.saveBudgetLimit('MODEL',parsed.modelLimit,used('MODEL'));
        if(kind==='AUTO_REPLY')this.saveBudgetLimit('SEND',(parsed as ReplyPolicy).sendLimit,used('SEND'));
      } else {
        requireSafe(parsed.modelLimit === null || parsed.modelLimit >= used('MODEL'), 'MODEL_BUDGET_EXCEEDED');
        const sendLimit = (parsed as ReplyPolicy).sendLimit;
        if (kind === 'AUTO_REPLY') requireSafe(sendLimit === null || sendLimit >= used('SEND'), 'SEND_BUDGET_EXCEEDED');
      }
      this.revoke(kind);
      const createdAt = this.now();
      const row = this.store.db.prepare("INSERT INTO automation_grants(kind,scope_json,scope_digest,created_at) VALUES(?,?,?,?)")
        .run(kind, JSON.stringify(parsed), digest(parsed), createdAt);
      if (this.store.schemaVersion() >= 4) this.store.db.prepare('INSERT INTO account_grant_bindings VALUES(?,?)')
        .run(row.lastInsertRowid, this.accountId);
      this.store.audit("PERSISTENT_GRANT_ENABLED", String(row.lastInsertRowid));
      if(previous)this.store.db.prepare('INSERT INTO grant_reservations SELECT ?,kind,job_key,reserved_at FROM grant_reservations WHERE grant_version=?')
        .run(row.lastInsertRowid,previous.version);
      return {version: Number(row.lastInsertRowid), kind, scope: parsed, createdAt};
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
  revoke(kind: "MODEL" | "AUTO_REPLY", expected?: { version?: number; ownId?: string }): void {
    this.store.db.transaction(() => {
      if (expected?.version !== undefined || expected?.ownId !== undefined) {
        const current = this.active(kind);
        requireSafe(
          current &&
            (expected.version === undefined || current.version === expected.version) &&
            (expected.ownId === undefined || current.scope.ownId === expected.ownId),
          "GRANT_VERSION_CONFLICT",
        );
      }
      const {sql, args} = this.grantFilter();
      this.store.db.prepare(`UPDATE automation_grants SET revoked_at=? WHERE kind=? AND revoked_at IS NULL${sql}`).run(this.now(), kind, ...args);
      this.store.audit("PERSISTENT_GRANT_REVOKED", kind);
    }).immediate();
  }
  readGrantScope(kind: Grant["kind"], row: { scope_json: string; scope_digest: string; grant_version?: number }): Grant["scope"] {
    if (row.grant_version !== undefined && this.store.schemaVersion() >= 4) {
      requireSafe(this.store.db.prepare('SELECT 1 WHERE COALESCE((SELECT account_id FROM account_grant_bindings WHERE grant_version=?), ?) = ?')
        .get(row.grant_version, DEFAULT_ACCOUNT_ID, this.accountId), 'GRANT_REVOKED');
    }
    let scope: Grant["scope"];
    try { scope = parseStoredModelGrant(kind, JSON.parse(row.scope_json)); }
    catch { throw new Blocked("GRANT_CORRUPT"); }
    requireSafe(digest(scope) === row.scope_digest, "GRANT_CORRUPT");
    return scope;
  }
  active(kind: "MODEL" | "AUTO_REPLY"): Grant | null {
    const {sql, args} = this.grantFilter();
    const row = this.store.db.prepare(`SELECT * FROM automation_grants WHERE kind=? AND revoked_at IS NULL${sql}
      ORDER BY version DESC LIMIT 1`).get(kind, ...args) as {
      version: number; scope_json: string; scope_digest: string; created_at: number;
    } | undefined;
    if (!row) return null;
    const scope = this.readGrantScope(kind, row);
    if (scope.expiresAt !== null && scope.expiresAt <= this.now()) return null;
    return {version: row.version, kind, scope, createdAt: row.created_at};
  }
  /** Called inside the same transaction as the global model reservation or send intent. No refunds/replays. */
  allowance(version:number,kind:'MODEL'|'SEND'):boolean {
    const grant = this.currentGrant(version);
    if (!grant || kind === 'SEND' && grant.kind !== 'AUTO_REPLY') return false;
    const used=this.store.db.prepare('SELECT count(*) AS used FROM grant_reservations WHERE grant_version=? AND kind=?').get(version,kind) as {used:number};
    const global=this.store.budget(kind),limit=kind==='MODEL'?grant.scope.modelLimit:(grant.scope as ReplyPolicy).sendLimit;
    return (limit===null||used.used<limit)&&(global.maximum===null||global.used<global.maximum);
  }
  private currentGrant(version: number): Grant | null {
    const {sql, args} = this.grantFilter();
    const row = this.store.db.prepare(`SELECT kind FROM automation_grants WHERE version=? AND revoked_at IS NULL${sql}`)
      .get(version, ...args) as {kind: Grant['kind']} | undefined;
    const grant = row && this.active(row.kind);
    return grant?.version === version ? grant : null;
  }
  reserve(version: number, kind: "MODEL" | "SEND", jobKey: string,channel?:StoredEvent['payload']['channel']): void {
    this.store.db.transaction(() => {
      const grant = this.currentGrant(version);
      requireSafe(grant && (kind !== 'SEND' || grant.kind === 'AUTO_REPLY'), "GRANT_REVOKED");
      this.requireAccount(grant.scope.ownId);
      requireSafe(!this.state().emergencyStopped, "EMERGENCY_STOPPED");
      const event=this.store.db.prepare('SELECT account_id,channel FROM inbound_events WHERE id=?').get(jobKey) as
        {account_id: AccountId; channel: StoredEvent['payload']['channel']} | undefined;
      requireSafe(!event || event.account_id === this.accountId, 'GRANT_REVOKED');
      if(channel??event?.channel)assertSecurityChannelClear(this.store,(channel??event!.channel));
      const used = this.store.db.prepare("SELECT count(*) AS used FROM grant_reservations WHERE grant_version=? AND kind=?").get(version, kind) as {used: number};
      const limit = kind === "MODEL" ? grant.scope.modelLimit : (grant.scope as ReplyPolicy).sendLimit;
      requireSafe(limit===null||Number.isInteger(limit)&&used.used<limit, `${kind}_GRANT_EXHAUSTED`);
      requireSafe(!this.store.db.prepare("SELECT job_key FROM grant_reservations WHERE grant_version=? AND kind=? AND job_key=?").get(version, kind, jobKey), "GRANT_JOB_ALREADY_RESERVED");
      this.store.db.prepare("INSERT INTO grant_reservations VALUES(?,?,?,?)").run(version, kind, jobKey, this.now());
    }).immediate();
  }
  policyMatches(grant: Grant<ReplyPolicy>, e: StoredEvent, status: 'NEW'|'DRAFT'='NEW', options?: { allowVisionImage?: boolean }): boolean {
    if(e.payload.accountId!==this.accountId||readSecurityHold(this.store,e.payload.channel))return false;
    const active = this.active("AUTO_REPLY");
    const visionImage = Boolean(options?.allowVisionImage && isManualMediaCandidate(e.payload) && e.payload.contentType === 'IMAGE');
    if (active?.version !== grant.version || this.state().emergencyStopped || (!isStrong(e.payload) && !visionImage) ||
      !(status==='NEW'?(visionImage?['AWAITING_DRAFT','MANUAL_REVIEW']:['AWAITING_DRAFT']):['AWAITING_APPROVAL','APPROVED']).includes(e.status)) return false;
    const p = active.scope as ReplyPolicy;
    if(e.payload.channel==='COMMENT_NOTIFICATION'&&e.payload.kind==='REPLY'&&p.replyToNestedComments===false)return false;
    this.requireAccount(p.ownId);
    const client = this.store.clientState();
    if (client.paused || client.mode !== "LIMITED_AUTO") return false;
    if (!p.channels.includes(e.payload.channel) || e.payload.direction !== "INCOMING" || e.payload.actorId === p.ownId) return false;
    if (this.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(e.id)||this.store.sendFrozen(e.id)) return false;
    // Only an active editing lease pauses a conversation; merely viewing it must not leave a persistent handoff.
    const owner = this.store.db.prepare("SELECT operator_id,lease_expires_at FROM thread_ownership WHERE account_id=? AND channel=? AND target_key=?")
      .get(this.accountId,e.payload.channel,targetKey(e.payload)) as {operator_id: string | null;lease_expires_at:number} | undefined;
    if (this.store.targetPaused(targetKey(e.payload)) || owner?.operator_id&&owner.lease_expires_at>this.now()) return false;
    return this.policyScopeMatches(grant,e,options);
  }
  /** Authorization scope only; explicit human suggestions do not inherit automatic scheduling gates. */
  policyScopeMatches(grant:Grant<ReplyPolicy>,e:StoredEvent, options?: { allowVisionImage?: boolean }):boolean {
    if(e.payload.accountId!==this.accountId||readSecurityHold(this.store,e.payload.channel))return false;
    const active=this.active('AUTO_REPLY');
    const visionImage = Boolean(options?.allowVisionImage && isManualMediaCandidate(e.payload) && e.payload.contentType === 'IMAGE');
    if(active?.version!==grant.version||this.state().emergencyStopped||(!isStrong(e.payload)&&!visionImage))return false;
    const p=active.scope as ReplyPolicy;this.requireAccount(p.ownId);
    if(!p.channels.includes(e.payload.channel)||e.payload.direction!=='INCOMING'||e.payload.actorId===p.ownId)return false;
    if(e.payload.channel==='COMMENT_NOTIFICATION'&&e.payload.kind==='REPLY'&&p.replyToNestedComments===false)return false;
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
