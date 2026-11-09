import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  digest, dmClockToleranceMs, eventBinding, eventSchema, isEligible, isStrong, requireSafe, targetKey, validText,
  validManualMediaProof,
  type Channel, type Draft, type InboundEvent, type StoredEvent, type TargetSnapshot,type SendProof,
} from '../core/contracts.js';

interface EventRow { id: string; payload: string; binding: string; status: StoredEvent['status'] }
interface DraftRow { id: string; event_id: string; text: string; model: string; version: number;
  status: Draft['status']; approval: string | null }
export interface Intent { id: string; event_id: string; target_key: string; status: string }
const retryGrantSchema=z.object({eventId:z.uuid(),draftId:z.uuid(),previousIntentId:z.uuid(),version:z.number().int().positive(),
  textDigest:z.string().regex(/^[a-f0-9]{64}$/),snapshotDigest:z.string().regex(/^[a-f0-9]{64}$/),authorizationDigest:z.string().regex(/^[a-f0-9]{64}$/)});
export type RetryGrant=z.infer<typeof retryGrantSchema>;

export class EventStore {
  readonly db: Database.Database;
  constructor(file: string, initialize = false, private readonly now: () => string = () => new Date().toISOString()) {
    requireSafe(initialize || existsSync(file), 'DATABASE_MISSING_USE_INIT');
    if (initialize) mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { fileMustExist: !initialize });
    try {
      requireSafe(this.db.pragma('quick_check', { simple: true }) === 'ok', 'DATABASE_CORRUPT');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 3000');
      const version = this.db.pragma('user_version', { simple: true });
      requireSafe(version === 2 || version === 3 || (version === 0 && initialize), 'DATABASE_SCHEMA_UNSUPPORTED');
      if (version === 0) this.schema();
    } catch (error) { this.db.close(); throw error; }
  }
  private schema(): void {
    this.db.transaction(() => {
      // Existing unknown databases must never be interpreted as an empty PoC database.
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      requireSafe(tables.length === 0, 'DATABASE_NOT_EMPTY');
      this.db.exec(`
        CREATE TABLE accounts (id TEXT PRIMARY KEY CHECK(id='account_001'), own_id TEXT NOT NULL);
        CREATE TABLE observations (id TEXT PRIMARY KEY, channel TEXT NOT NULL, scope TEXT NOT NULL,
          observed_at TEXT NOT NULL, count INTEGER NOT NULL, evidence_ref TEXT NOT NULL);
        CREATE TABLE inbound_events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
          channel TEXT NOT NULL, source_key TEXT NOT NULL, scope TEXT NOT NULL, target_key TEXT NOT NULL,
          binding TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
          UNIQUE(account_id,channel,source_key));
        CREATE TABLE cursors (channel TEXT NOT NULL, scope TEXT NOT NULL, cursor_data TEXT NOT NULL,
          updated_at TEXT NOT NULL, PRIMARY KEY(channel,scope));
        CREATE TABLE source_collisions (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES inbound_events(id),
          binding TEXT NOT NULL, payload TEXT NOT NULL, evidence_ref TEXT NOT NULL, UNIQUE(event_id,binding));
        CREATE TABLE reply_drafts (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES inbound_events(id),
          text TEXT NOT NULL, model TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
          approval TEXT, approved_at TEXT);
        CREATE TABLE send_intents (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES inbound_events(id),
          draft_id TEXT NOT NULL REFERENCES reply_drafts(id), target_key TEXT NOT NULL,
          target_digest TEXT NOT NULL, text_digest TEXT NOT NULL, status TEXT NOT NULL, attempt_started_at TEXT NOT NULL);
        CREATE TABLE delivery_receipts (id TEXT PRIMARY KEY, send_intent_id TEXT NOT NULL REFERENCES send_intents(id),
          result TEXT NOT NULL, proof_ref TEXT NOT NULL, verified_at TEXT NOT NULL);
        CREATE TABLE audit_events (id TEXT PRIMARY KEY, time TEXT NOT NULL, event_type TEXT NOT NULL,
          entity_id TEXT NOT NULL, detail_redacted TEXT NOT NULL);
        CREATE TABLE pauses (target_key TEXT PRIMARY KEY, paused INTEGER NOT NULL);
        CREATE TABLE budgets (kind TEXT PRIMARY KEY, used INTEGER NOT NULL, maximum INTEGER NOT NULL);
        INSERT INTO budgets VALUES ('MODEL',0,50),('SEND',0,20);
        CREATE TABLE model_calls (id TEXT PRIMARY KEY, model TEXT NOT NULL, status TEXT NOT NULL,
          input_tokens INTEGER, output_tokens INTEGER, elapsed_ms INTEGER, estimated_cost REAL);
        PRAGMA user_version = 2;
      `);
    }).immediate();
  }
  close(): void { this.db.close(); }
  bindAccount(ownId: string): void {
    requireSafe(ownId.length > 0, 'ACCOUNT_REQUIRED');
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT own_id FROM accounts WHERE id=?').get('account_001') as { own_id: string } | undefined;
      requireSafe(!row || row.own_id === ownId, 'ACCOUNT_CHANGED');
      this.db.prepare('INSERT OR IGNORE INTO accounts VALUES (?,?)').run('account_001', ownId);
    }).immediate();
  }
  audit(code: string, id: string, detail: Record<string, number | boolean> = {}): void {
    this.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)')
      .run(randomUUID(), new Date().toISOString(), code, id, JSON.stringify(detail));
  }
  observe(channel: Channel, scope: string, candidates: InboundEvent[], ownId: string, evidenceRef: string, observedAt = this.now(), firstBoundary?: number): string[] {
    return this.db.transaction(() => {
      this.bindAccount(ownId);
      const events = candidates.map(e => eventSchema.parse(e));
      requireSafe(events.every(e => e.channel === channel), 'CHANNEL_MISMATCH');
      const cursor = this.db.prepare('SELECT cursor_data FROM cursors WHERE channel=? AND scope=?').get(channel, scope) as {cursor_data:string}|undefined;
      const priorWatermark = cursor ? z.object({baselineTime:z.number().finite(),highWater:z.number().finite(),bindings:z.array(z.string())}).parse(JSON.parse(cursor.cursor_data)) : null;
      const absoluteTime = (value: string | null): number | null => {
        const parsed = z.iso.datetime({offset:true}).safeParse(value);
        return parsed.success ? Date.parse(parsed.data) : null;
      };
      const baselineTime = absoluteTime(observedAt); requireSafe(baselineTime !== null,'OBSERVATION_TIME_INVALID');
      requireSafe(firstBoundary === undefined || (Number.isSafeInteger(firstBoundary) && firstBoundary > 0 && firstBoundary <= baselineTime), 'OBSERVATION_BOUNDARY_INVALID');
      const times = events.map(e => absoluteTime(e.occurredAt)).filter((n): n is number => n !== null);
      const highWater = Math.max(priorWatermark?.highWater ?? baselineTime,...times);
      const initialBoundary = priorWatermark?.baselineTime ?? firstBoundary ?? highWater;
      const newIds: string[] = [];
      const weakOccurrences = new Map<string, { eventId: string; count: number }>();
      this.db.prepare('INSERT INTO observations VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), channel, scope, observedAt, events.length, evidenceRef);
      for (const e of events) {
        if (!isEligible(e, ownId)) continue;
        const key = e.platformEventId ?? digest([e.actorId, e.occurredAt, targetKey(e), e.text]);
        const binding = eventBinding(e);
        let prior = this.db.prepare('SELECT * FROM inbound_events WHERE account_id=? AND channel=? AND source_key=?')
          .get(e.accountId, e.channel, key) as EventRow | undefined;
        let comparable = e;
        if (!prior && e.channel === 'COMMENT_NOTIFICATION' && e.videoId && e.commentId) {
          prior = this.db.prepare('SELECT * FROM inbound_events WHERE account_id=? AND channel=? AND target_key=?')
            .get(e.accountId,e.channel,targetKey(e)) as EventRow | undefined;
          if (prior) comparable = {...e,platformEventId:this.event(prior.id).payload.platformEventId};
        }
        if (prior) {
          if (!isStrong(e) && !e.observationIssue) weakOccurrences.set(key, { eventId: prior.id, count: (weakOccurrences.get(key)?.count ?? 0) + 1 });
          if (prior.binding !== eventBinding(comparable) || !isStrong(e) && !e.observationIssue) {
            // A source collision or changed original cannot inherit an approval.
            const previous=this.event(prior.id).payload;
            const qualityOnly=(previous.observationIssue!==comparable.observationIssue||previous.contentType!==comparable.contentType)&&
              eventBinding({...previous,observationIssue:undefined,contentType:undefined})===
                eventBinding({...comparable,observationIssue:undefined,contentType:undefined});
            if(prior.status!=='BASELINE'||!qualityOnly)
              this.db.prepare("UPDATE inbound_events SET status='MANUAL_REVIEW' WHERE id=? AND status NOT IN ('CONFIRMED','UNCERTAIN','INTENT_RECORDED')").run(prior.id);
            if(!qualityOnly||!this.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(prior.id))
              this.db.prepare("UPDATE reply_drafts SET status='DRAFT',approval=NULL,approved_at=NULL WHERE event_id=?").run(prior.id);
            this.db.prepare('INSERT OR IGNORE INTO source_collisions VALUES (?,?,?,?,?)')
              .run(randomUUID(),prior.id,binding,JSON.stringify(e),evidenceRef);
            const grants=this.db.prepare("SELECT id FROM audit_events WHERE event_type='MANUAL_RETRY_AUTHORIZED' AND json_extract(detail_redacted,'$.eventId')=?")
              .all(prior.id) as {id:string}[];
            for(const grant of grants)this.revokeCommentRetry(grant.id);
            this.audit('SOURCE_COLLISION', prior.id);
          }
          continue;
        }
        const id = randomUUID();
        const time = absoluteTime(e.occurredAt);
        const overlapsBoundary = time !== null && time <= initialBoundary && time + (e.occurredAtPrecisionMs ?? 1) > initialBoundary;
        const status = e.observationIssue && time !== null && time < initialBoundary && !overlapsBoundary ? 'BASELINE' :
          !isStrong(e) || time === null ? 'MANUAL_REVIEW' : !priorWatermark && firstBoundary === undefined ? 'BASELINE' :
          time > (priorWatermark?.highWater ?? initialBoundary) ? 'AWAITING_DRAFT' : time < initialBoundary && !overlapsBoundary ? 'BASELINE' : 'MANUAL_REVIEW';
        this.db.prepare('INSERT INTO inbound_events VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, e.accountId, channel, key, scope, targetKey(e), binding, JSON.stringify(e), status);
        if (!isStrong(e)) weakOccurrences.set(key, { eventId: id, count: 1 });
        if (status === 'AWAITING_DRAFT') newIds.push(id);
      }
      for (const occurrence of weakOccurrences.values()) if (occurrence.count > 1)
        this.audit('WEAK_SOURCE_MULTIPLICITY', occurrence.eventId, { occurrences: occurrence.count });
      // Watermarks are per channel and conversation, not based only on message body.
      this.db.prepare('INSERT INTO cursors VALUES (?,?,?,?) ON CONFLICT(channel,scope) DO UPDATE SET cursor_data=excluded.cursor_data,updated_at=excluded.updated_at')
        .run(channel, scope, JSON.stringify({baselineTime:initialBoundary,highWater,bindings:events.map(eventBinding)}), observedAt);
      return newIds;
    }).immediate();
  }
  event(id: string): StoredEvent {
    const row = this.db.prepare('SELECT id,payload,binding,status FROM inbound_events WHERE id=?').get(id) as EventRow | undefined;
    requireSafe(row, 'EVENT_NOT_FOUND');
    return { id: row.id, payload: eventSchema.parse(JSON.parse(row.payload)), binding: row.binding, status: row.status };
  }
  assertModelObservation(event:InboundEvent):void {
    const dm=event.channel==='DIRECT_MESSAGE';
    requireSafe(!this.dmContentIncomplete(event),'DM_CONTENT_UNVERIFIED');
    // DM quality belongs to one native message; callers separately validate every bounded history item.
    const scope=dm?'e.source_key=?':'e.target_key=?';
    const unresolved=this.db.prepare(`SELECT e.id FROM inbound_events e WHERE e.account_id=? AND e.channel=? AND ${scope}
      AND (json_extract(e.payload,'$.observationIssue') IS NOT NULL OR json_extract(e.payload,'$.contentType') IS NOT NULL OR EXISTS
        (SELECT 1 FROM source_collisions c WHERE c.event_id=e.id AND
          (json_extract(c.payload,'$.observationIssue') IS NOT NULL OR json_extract(c.payload,'$.contentType') IS NOT NULL))) LIMIT 1`)
      .get(event.accountId,event.channel,dm?event.platformEventId:targetKey(event));
    requireSafe(!event.observationIssue&&!event.contentType&&!unresolved,dm?'DM_CONTENT_UNVERIFIED':'COMMENT_TEXT_UNVERIFIED');
  }
  dmContentIncomplete(event:InboundEvent):boolean {
    if(event.channel!=='DIRECT_MESSAGE'||!this.db.prepare("SELECT name FROM sqlite_master WHERE name='collection_progress'").get())return false;
    return !!this.db.prepare(`SELECT 1 FROM collection_progress p,json_each(json_extract(p.cursor_json,'$.deferred')) d
      WHERE p.source='dm' AND json_extract(d.value,'$.id')=? AND json_extract(d.value,'$.code')='OBSERVATION_DM_CONTENT_DOM_NOT_READY' LIMIT 1`)
      .get(event.conversationId);
  }
  events(): StoredEvent[] {
    return (this.db.prepare('SELECT id FROM inbound_events ORDER BY rowid').all() as { id: string }[]).map(r => this.event(r.id));
  }
  draft(id: string): Draft {
    const row = this.db.prepare('SELECT * FROM reply_drafts WHERE id=?').get(id) as DraftRow | undefined;
    requireSafe(row, 'DRAFT_NOT_FOUND');
    return { id: row.id, eventId: row.event_id, text: row.text, model: row.model, version: row.version,
      status: row.status, approval: row.approval ? JSON.parse(row.approval) as Draft['approval'] : null };
  }
  saveDraft(eventId: string, text: string, model: string): Draft {
    requireSafe(this.db.pragma('user_version',{simple:true})!==3,'CLIENT_USE_VERSIONED_DRAFT_SERVICE');
    text=validText(text);
    return this.db.transaction(() => {
      const e = this.event(eventId);
      requireSafe(['AWAITING_DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(e.status), 'EVENT_NOT_DRAFTABLE');
      requireSafe(!this.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(eventId), 'INTENT_EXISTS');
      const old = this.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').get(eventId) as { id: string } | undefined;
      const id = old?.id ?? randomUUID();
      this.db.prepare(`INSERT INTO reply_drafts (id,event_id,text,model,version,status,approval,approved_at) VALUES (?,?,?,?,1,'DRAFT',NULL,NULL)
        ON CONFLICT(event_id) DO UPDATE SET text=excluded.text,model=excluded.model,version=version+1,
        status='DRAFT',approval=NULL,approved_at=NULL`).run(id, eventId, text, model);
      this.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);
      this.audit('DRAFT_SAVED', id);
      return this.draft(id);
    }).immediate();
  }
  approve(id: string, snapshot: TargetSnapshot, expectedVersion: number, expectedText: string,manualGate?:()=>void): void {
    this.db.transaction(() => {
      const d = this.draft(id); const e = this.event(d.eventId);
      const media=!isStrong(e.payload)&&!!manualGate&&validManualMediaProof(e.payload,snapshot);
      if(media)manualGate!();
      requireSafe(d.status === 'DRAFT' && (e.status === 'AWAITING_APPROVAL'||media&&e.status==='MANUAL_REVIEW'), 'NOT_AWAITING_APPROVAL');
      requireSafe(d.version === expectedVersion && d.text === expectedText, 'DRAFT_CHANGED');
      requireSafe(snapshot.accountId === e.payload.accountId && snapshot.targetKey === targetKey(e.payload) &&
        snapshot.eventBinding === e.binding && (isStrong(e.payload)||media), 'TARGET_CHANGED');
      const account = this.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(e.payload.accountId) as { own_id: string };
      requireSafe(snapshot.ownId === account.own_id, 'ACCOUNT_CHANGED');
      const approval = { snapshot, textDigest: digest(d.text), version: d.version };
      this.db.prepare("UPDATE reply_drafts SET status='APPROVED',approval=?,approved_at=? WHERE id=?")
        .run(JSON.stringify(approval), new Date().toISOString(), id);
      this.db.prepare("UPDATE inbound_events SET status='APPROVED' WHERE id=?").run(e.id);
      this.audit('HUMAN_APPROVED', id);
    }).immediate();
  }
  reject(id: string): void {
    this.db.transaction(() => {
      const d = this.draft(id);
      requireSafe(!this.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(d.eventId), 'INTENT_EXISTS');
      this.db.prepare("UPDATE reply_drafts SET status='REJECTED',approval=NULL WHERE id=?").run(id);
      this.db.prepare("UPDATE inbound_events SET status='REJECTED' WHERE id=?").run(d.eventId);
      this.audit('HUMAN_REJECTED', id);
    }).immediate();
  }
  invalidateApproval(id: string): void {
    this.db.transaction(() => {
      const d = this.draft(id);
      requireSafe(!this.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(d.eventId), 'INTENT_EXISTS');
      this.db.prepare("UPDATE reply_drafts SET status='DRAFT',approval=NULL,approved_at=NULL WHERE id=?").run(id);
      this.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=? AND status='APPROVED'").run(d.eventId);
      this.audit('APPROVAL_INVALIDATED', id);
    }).immediate();
  }
  pause(key: string, paused: boolean): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO pauses VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET paused=excluded.paused').run(key, Number(paused));
      if (paused) {
        if(this.db.pragma('user_version',{simple:true})===3){
          this.db.prepare('UPDATE thread_ownership SET operator_id=NULL,generation=generation+1,lease_expires_at=0 WHERE target_key=?').run(key);
          this.db.prepare(`UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='TARGET_PAUSED'
            WHERE event_id IN (SELECT id FROM inbound_events WHERE target_key=?) AND intent_id IS NULL
            AND status IN ('PREVIEW','QUEUED','PREFLIGHT')`).run(key);
        }
        const drafts = this.db.prepare(`SELECT d.id FROM reply_drafts d JOIN inbound_events e ON e.id=d.event_id
          WHERE e.target_key=? AND d.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id)`).all(key) as {id:string}[];
        for (const d of drafts) this.invalidateApproval(d.id);
        const grants=this.db.prepare(`SELECT g.id FROM audit_events g JOIN send_intents i ON i.id=g.entity_id
          WHERE g.event_type='MANUAL_RETRY_AUTHORIZED' AND i.target_key=? AND NOT EXISTS
          (SELECT 1 FROM audit_events r WHERE r.event_type='MANUAL_RETRY_REVOKED' AND r.entity_id=g.id)`).all(key) as {id:string}[];
        for(const g of grants)this.audit('MANUAL_RETRY_REVOKED',g.id);
      }
      this.audit(paused ? 'PAUSED' : 'RESUMED', digest(key));
    }).immediate();
  }
  assertSendable(eventId: string): void {
    const e = this.event(eventId); const key = targetKey(e.payload);
    requireSafe(!(this.db.prepare('SELECT paused FROM pauses WHERE target_key=?').get(key) as { paused: number } | undefined)?.paused, 'TARGET_PAUSED');
    requireSafe(e.status === 'APPROVED', 'EVENT_NOT_APPROVED');
    requireSafe(!this.db.prepare("SELECT id FROM send_intents WHERE target_key=? AND status IN ('INTENT_RECORDED','UNCERTAIN')").get(key), 'TARGET_FROZEN');
    requireSafe(!this.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(eventId), 'INTENT_EXISTS');
  }
  consumeBudget(kind: 'MODEL' | 'SEND'): void {
    const result = this.db.prepare('UPDATE budgets SET used=used+1 WHERE kind=? AND used<maximum').run(kind);
    requireSafe(result.changes === 1, 'BUDGET_EXHAUSTED');
  }
  recordIntent(draftId: string, snapshot: TargetSnapshot, real: boolean,
    authority?: { check(): void; committed(intentId: string): void;manualMedia?():void }): string {
    return this.db.transaction(() => {
      requireSafe(this.db.pragma('user_version', {simple:true}) !== 3 || authority, 'CLIENT_AUTHORITY_REQUIRED');
      authority?.check();
      const d = this.draft(draftId); this.assertSendable(d.eventId);
      if(!isStrong(this.event(d.eventId).payload)){
        requireSafe(authority?.manualMedia&&d.approval&&validManualMediaProof(this.event(d.eventId).payload,d.approval.snapshot),'HUMAN_MEDIA_APPROVAL_REQUIRED');
        authority.manualMedia();
      }
      requireSafe(d.status === 'APPROVED' && d.approval && d.approval.version === d.version &&
        d.approval.textDigest === digest(d.text) && digest(d.approval.snapshot) === digest(snapshot), 'APPROVAL_INVALID');
      if (real) this.consumeBudget('SEND');
      const id = randomUUID();
      this.db.prepare('INSERT INTO send_intents VALUES (?,?,?,?,?,?,?,?)')
        .run(id, d.eventId, d.id, snapshot.targetKey, digest(snapshot), digest(d.text), 'INTENT_RECORDED', new Date().toISOString());
      this.db.prepare("UPDATE inbound_events SET status='INTENT_RECORDED' WHERE id=?").run(d.eventId);
      this.audit('CLICK_INTENT_RECORDED', id);
      authority?.committed(id);
      return id;
    }).immediate();
  }
  private submissionProof(id:string,proof:SendProof|undefined):void{
    if(proof?.clockSkew)this.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'CLOCK_SKEW_PROOF',id,
      JSON.stringify({...proof.clockSkew,refreshedId:undefined,allowedSkewMs:dmClockToleranceMs,
        observedSkewMs:Date.parse(proof.clockSkew.boundary)-Date.parse(proof.sentAt),nativeIdDigest:digest(proof.id),proofDigest:digest(proof)}));
    if(!proof?.submission)return;
    this.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'SUBMISSION_PROOF',id,
      JSON.stringify({...proof.submission,nativeIdDigest:digest(proof.id),proofDigest:digest(proof)}));
  }
  receipt(intentId: string, result: 'CONFIRMED' | 'UNCERTAIN', proofRef: string,proof?:SendProof): void {
    this.db.transaction(() => {
      const intent = this.db.prepare('SELECT * FROM send_intents WHERE id=?').get(intentId) as Intent | undefined;
      requireSafe(intent && ['INTENT_RECORDED', 'UNCERTAIN'].includes(intent.status), 'INTENT_NOT_REVIEWABLE');
      if(result==='CONFIRMED'){
        this.submissionProof(intentId,proof);
        if(proof?.id&&this.db.prepare("SELECT name FROM sqlite_master WHERE name='chat_delivery_links'").get())
          this.db.prepare('INSERT INTO chat_delivery_links VALUES(?,?) ON CONFLICT(intent_id) DO NOTHING').run(intentId,digest(proof.id));
      }
      this.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,?,?)')
        .run(randomUUID(), intentId, result, proofRef, new Date().toISOString());
      this.db.prepare('UPDATE send_intents SET status=? WHERE id=?').run(result, intentId);
      this.db.prepare('UPDATE inbound_events SET status=? WHERE id=?').run(result, intent.event_id);
      this.audit(result, intentId);
    }).immediate();
  }
  recover(): number {
    return this.db.transaction(() => {
      const pending = this.db.prepare("SELECT id FROM send_intents WHERE status='INTENT_RECORDED'").all() as { id: string }[];
      for (const i of pending) this.receipt(i.id, 'UNCERTAIN', 'RESTART_WITH_UNFINISHED_INTENT');
      const retries=this.db.prepare(`SELECT i.id FROM audit_events i WHERE i.event_type='MANUAL_RETRY_INTENT' AND NOT EXISTS
        (SELECT 1 FROM audit_events r WHERE r.event_type='MANUAL_RETRY_RECEIPT' AND r.entity_id=i.id)`).all() as {id:string}[];
      for(const r of retries)this.commentRetryReceipt(r.id,'UNCERTAIN','RESTART_WITH_UNFINISHED_RETRY');
      return pending.length+retries.length;
    }).immediate();
  }
  uncertain(): Intent[] {
    return this.db.prepare("SELECT id,event_id,target_key,status FROM send_intents WHERE status='UNCERTAIN'").all() as Intent[];
  }
  receiptForEvent(eventId: string): unknown {
    return this.db.prepare(`SELECT r.id,r.result,r.proof_ref,r.verified_at FROM delivery_receipts r
      JOIN send_intents i ON i.id=r.send_intent_id WHERE i.event_id=? ORDER BY r.rowid DESC LIMIT 1`).get(eventId);
  }
  intentBoundary(intentId: string): string {
    const row=this.db.prepare('SELECT attempt_started_at FROM send_intents WHERE id=?').get(intentId) as {attempt_started_at:string}|undefined;
    requireSafe(row,'INTENT_NOT_FOUND');return row.attempt_started_at;
  }
  private retryAudit(id:string,type:string,entityId:string,detail:Record<string,unknown>):void{
    this.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(id,new Date().toISOString(),type,entityId,JSON.stringify(detail));
  }
  retryGrant(id:string):RetryGrant{
    const row=this.db.prepare("SELECT detail_redacted FROM audit_events WHERE id=? AND event_type='MANUAL_RETRY_AUTHORIZED'").get(id) as {detail_redacted:string}|undefined;
    requireSafe(row,'MANUAL_RETRY_AUTHORIZATION_REQUIRED');return retryGrantSchema.parse(JSON.parse(row.detail_redacted));
  }
  revokeCommentRetry(grantId:string):void{
    this.db.transaction(()=>{
      this.retryGrant(grantId);
      if(!this.db.prepare("SELECT id FROM audit_events WHERE event_type='MANUAL_RETRY_REVOKED' AND entity_id=?").get(grantId))
        this.audit('MANUAL_RETRY_REVOKED',grantId);
    }).immediate();
  }
  authorizeCommentRetry(draftId:string,snapshot:TargetSnapshot,authorizationRef:string):string{
    requireSafe(this.db.pragma('user_version',{simple:true})!==3,'CLIENT_UNKNOWN_READ_ONLY');
    requireSafe(authorizationRef.length>0&&authorizationRef.length<=500,'MANUAL_RETRY_AUTHORIZATION_REQUIRED');
    return this.db.transaction(()=>{
      const draft=this.draft(draftId),event=this.event(draft.eventId),key=targetKey(event.payload);
      const prior=this.db.prepare("SELECT id,status FROM send_intents WHERE event_id=?").get(event.id) as {id:string;status:string}|undefined;
      requireSafe(event.payload.channel==='COMMENT_NOTIFICATION'&&event.payload.kind==='COMMENT'&&event.status==='UNCERTAIN'&&prior?.status==='UNCERTAIN',
        'MANUAL_RETRY_REQUIRES_UNKNOWN_COMMENT');
      requireSafe(snapshot.accountId===event.payload.accountId&&snapshot.eventBinding===event.binding&&snapshot.targetKey===key&&snapshot.composerKey===key,
        'MANUAL_RETRY_BINDING_CHANGED');
      requireSafe((this.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(event.payload.accountId) as {own_id:string}|undefined)?.own_id===snapshot.ownId,
        'MANUAL_RETRY_ACCOUNT_CHANGED');
      requireSafe(!(this.db.prepare('SELECT paused FROM pauses WHERE target_key=?').get(key) as {paused:number}|undefined)?.paused,'TARGET_PAUSED');
      requireSafe(!this.db.prepare("SELECT id FROM audit_events WHERE event_type='MANUAL_RETRY_INTENT' AND json_extract(detail_redacted,'$.previousIntentId')=?").get(prior.id),
        'MANUAL_RETRY_ALREADY_ATTEMPTED');
      const id=randomUUID(),grant:RetryGrant={eventId:event.id,draftId:draft.id,previousIntentId:prior.id,version:draft.version,
        textDigest:digest(draft.text),snapshotDigest:digest(snapshot),authorizationDigest:digest(authorizationRef)};
      this.retryAudit(id,'MANUAL_RETRY_AUTHORIZED',prior.id,grant);return id;
    }).immediate();
  }
  recordCommentRetryIntent(grantId:string,snapshot:TargetSnapshot,real:boolean):string{
    return this.db.transaction(()=>{
      const grant=this.assertCommentRetryAvailable(grantId);
      requireSafe(digest(snapshot)===grant.snapshotDigest,'MANUAL_RETRY_BINDING_CHANGED');
      if(real)this.consumeBudget('SEND');const id=randomUUID();
      this.retryAudit(id,'MANUAL_RETRY_INTENT',grantId,{...grant,real});return id;
    }).immediate();
  }
  assertCommentRetryAvailable(grantId:string):RetryGrant{
    requireSafe(this.db.pragma('user_version',{simple:true})!==3,'CLIENT_UNKNOWN_READ_ONLY');
    const grant=this.retryGrant(grantId),draft=this.draft(grant.draftId),event=this.event(grant.eventId),key=targetKey(event.payload);
    const prior=this.db.prepare('SELECT status,event_id FROM send_intents WHERE id=?').get(grant.previousIntentId) as {status:string;event_id:string}|undefined;
    requireSafe(event.status==='UNCERTAIN'&&prior?.status==='UNCERTAIN'&&prior.event_id===event.id,'MANUAL_RETRY_PREVIOUS_STATE_CHANGED');
    requireSafe(draft.eventId===event.id&&draft.version===grant.version&&digest(draft.text)===grant.textDigest,'MANUAL_RETRY_BINDING_CHANGED');
    requireSafe(!(this.db.prepare('SELECT paused FROM pauses WHERE target_key=?').get(key) as {paused:number}|undefined)?.paused,'TARGET_PAUSED');
    requireSafe(!this.db.prepare("SELECT id FROM audit_events WHERE event_type='MANUAL_RETRY_REVOKED' AND entity_id=?").get(grantId),'MANUAL_RETRY_AUTHORIZATION_REVOKED');
    requireSafe(!this.db.prepare("SELECT id FROM audit_events WHERE event_type='MANUAL_RETRY_INTENT' AND json_extract(detail_redacted,'$.previousIntentId')=?")
      .get(grant.previousIntentId),'MANUAL_RETRY_ALREADY_ATTEMPTED');return grant;
  }
  commentRetryBoundary(id:string):string{
    const row=this.db.prepare("SELECT time FROM audit_events WHERE id=? AND event_type='MANUAL_RETRY_INTENT'").get(id) as {time:string}|undefined;
    requireSafe(row,'MANUAL_RETRY_INTENT_MISSING');return row.time;
  }
  commentRetryReceipt(id:string,result:'CONFIRMED'|'UNCERTAIN',proofRef:string,proof?:SendProof):void{
    this.db.transaction(()=>{
      requireSafe(this.db.prepare("SELECT id FROM audit_events WHERE id=? AND event_type='MANUAL_RETRY_INTENT'").get(id),'MANUAL_RETRY_INTENT_MISSING');
      requireSafe(!this.db.prepare("SELECT id FROM audit_events WHERE event_type='MANUAL_RETRY_RECEIPT' AND entity_id=?").get(id),'MANUAL_RETRY_RECEIPT_EXISTS');
      if(result==='CONFIRMED')this.submissionProof(id,proof);
      this.retryAudit(randomUUID(),'MANUAL_RETRY_RECEIPT',id,{result,proofRef});
    }).immediate();
  }
  history(e: InboundEvent): InboundEvent[] {
    const incoming = this.events().filter(item => targetKey(item.payload) === targetKey(e) && item.payload.channel === e.channel)
      .map(item => item.payload).filter((item): item is InboundEvent & { occurredAt: string } => item.occurredAt !== null);
    const outgoing = this.db.prepare(`SELECT e.payload,d.text,i.id,r.verified_at FROM send_intents i
      JOIN inbound_events e ON e.id=i.event_id JOIN reply_drafts d ON d.id=i.draft_id
      JOIN delivery_receipts r ON r.send_intent_id=i.id WHERE i.target_key=? AND r.result='CONFIRMED'
      ORDER BY r.rowid DESC LIMIT 6`).all(targetKey(e)) as {payload:string;text:string;id:string;verified_at:string}[];
    const retried=this.db.prepare(`SELECT e.payload,d.text,i.id,r.time AS verified_at FROM audit_events i
      JOIN audit_events r ON r.entity_id=i.id AND r.event_type='MANUAL_RETRY_RECEIPT'
      JOIN inbound_events e ON e.id=json_extract(i.detail_redacted,'$.eventId')
      JOIN reply_drafts d ON d.id=json_extract(i.detail_redacted,'$.draftId')
      WHERE i.event_type='MANUAL_RETRY_INTENT' AND json_extract(r.detail_redacted,'$.result')='CONFIRMED' AND e.target_key=?
      ORDER BY r.rowid DESC LIMIT 6`).all(targetKey(e)) as {payload:string;text:string;id:string;verified_at:string}[];
    const combined = [...incoming,...[...outgoing,...retried].map(row => ({...eventSchema.parse(JSON.parse(row.payload)),text:row.text,
      direction:'OUTGOING' as const,platformEventId:row.id,occurredAt:row.verified_at}))]
      .sort((a,b) => a.occurredAt.localeCompare(b.occurredAt));
    // Reserve bounded context for confirmed outgoing replies even during incoming bursts.
    const selected = [...combined.filter(item => item.direction !== 'OUTGOING').slice(-3),
      ...combined.filter(item => item.direction === 'OUTGOING').slice(-3)];
    return selected.sort((a,b) => a.occurredAt.localeCompare(b.occurredAt));
  }
  stats(): Record<string, unknown> {
    return {
      events: this.db.prepare('SELECT status,count(*) AS count FROM inbound_events GROUP BY status').all(),
      budgets: this.db.prepare('SELECT * FROM budgets').all(),
      uncertain: this.uncertain().length,
      manualRetries:this.db.prepare(`SELECT i.id AS retryId,i.entity_id AS grantId,
        json_extract(i.detail_redacted,'$.eventId') AS eventId,
        COALESCE((SELECT json_extract(r.detail_redacted,'$.result') FROM audit_events r WHERE r.event_type='MANUAL_RETRY_RECEIPT' AND r.entity_id=i.id),'INTENT_RECORDED') AS result
        FROM audit_events i WHERE i.event_type='MANUAL_RETRY_INTENT' ORDER BY i.rowid`).all(),
      tasks: this.db.prepare(`SELECT e.id AS eventId,e.channel,e.status,d.id AS draftId,d.version,d.status AS draftStatus,
        COALESCE((SELECT MAX(CAST(json_extract(a.detail_redacted,'$.occurrences') AS INTEGER)) FROM audit_events a
          WHERE a.event_type='WEAK_SOURCE_MULTIPLICITY' AND a.entity_id=e.id),1) AS maxObservedOccurrences
        FROM inbound_events e LEFT JOIN reply_drafts d ON d.event_id=e.id WHERE e.status<>'BASELINE' ORDER BY e.rowid`).all(),
    };
  }
}
