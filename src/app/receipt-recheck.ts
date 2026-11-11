import {digest,dmClockToleranceMs,eventBinding,isStrong,targetKey,type StoredEvent} from '../core/contracts.js';
import {ChatMessageStore} from '../storage/chat-messages.js';
import type {EventStore} from '../storage/store.js';
import type {VerificationJob} from './dm-context-verification.js';

export const receiptRecheckVersion='RECEIPT_RECHECK_V6';
const claimed=receiptRecheckVersion+'_CLAIMED';
const hash=/^[a-f0-9]{64}$/u;
// Scan progress is transient; durable claims still prevent replay after a restart.
const scanAfter=new WeakMap<EventStore,number>();
export interface ReceiptRecheckJob extends VerificationJob {recheckRevision:string}
interface IntentRow {id:string;event_id:string;draft_id:string;target_key:string;target_digest:string;text_digest:string;attempt_started_at:string;status:string}
interface Qualification {revision:string;nativeIdDigest?:string}

/** An observed bubble selects a read-only check. It never becomes a delivery receipt here. */
function dmCandidate(store:EventStore,event:StoredEvent,ownId:string,text:string,boundary:number,now:number):string|undefined {
  const e=event.payload,rows=store.db.prepare('SELECT id,payload,conflicted,observed_at FROM chat_messages WHERE account_id=? AND conversation_id=? LIMIT 1001')
    .all(e.accountId,e.conversationId) as {id:string;payload:string;conflicted:number;observed_at:number}[];
  if(rows.length>1000)return;
  const possible=rows.filter(row=>{const p=JSON.parse(row.payload) as {text?:string;occurredAt?:string};
    return p.text===text&&Date.parse(p.occurredAt??'')>=boundary-dmClockToleranceMs;});
  if(possible.length!==1||possible[0]!.conflicted)return;
  const row=possible[0]!,message=new ChatMessageStore(store).get(row.id),p=message?.payload,time=Date.parse(p?.occurredAt??'');
  if(!message||!p||!isStrong(p)||p.kind!=='DM'||p.direction!=='OUTGOING'||p.accountId!==e.accountId||p.conversationId!==e.conversationId||
    message.ownId!==ownId||p.actorId!==ownId||!p.platformEventId||!/^[1-9]\d{0,63}$/u.test(p.platformEventId)||
    !Number.isFinite(time)||time>now||time>boundary+120_000||row.observed_at<boundary)return;
  const incoming=store.db.prepare("SELECT payload FROM inbound_events WHERE account_id=? AND channel='DIRECT_MESSAGE' AND json_extract(payload,'$.conversationId')=? LIMIT 1001")
    .all(e.accountId,e.conversationId) as {payload:string}[];
  if(incoming.length>1000)return;
  // The existing small-clock-skew proof requires this native candidate to remain the latest message.
  for(const other of [...rows,...incoming]){
    const at=Date.parse((JSON.parse(other.payload) as {occurredAt?:string}).occurredAt??'');
    if(!Number.isFinite(at)||at>time)return;
  }
  return digest(p.platformEventId);
}

function qualify(store:EventStore,job:VerificationJob,now:number):Qualification|undefined {
  const intent=store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(job.intent_id) as IntentRow|undefined;
  if(!intent||intent.status!=='UNCERTAIN'||intent.event_id!==job.event_id||intent.attempt_started_at!==job.boundary||intent.target_digest!==job.target_digest)return;
  const event=store.event(job.event_id),e=event.payload,draft=store.draft(intent.draft_id),approval=draft.approval;
  const own=store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(e.accountId) as {own_id:string}|undefined;
  const boundary=Date.parse(job.boundary),persisted=store.db.prepare('SELECT state,attempts,last_error FROM verification_jobs WHERE intent_id=?').get(job.intent_id) as
    {state:string;attempts:number;last_error:string}|undefined;
  if(!persisted||persisted.state!=='REVIEW'||persisted.attempts!==2||event.status!=='UNCERTAIN'||!isStrong(e)||e.direction!=='INCOMING'||
    !own||e.actorId===own.own_id||!approval||!Number.isFinite(boundary)||boundary>now||event.binding!==eventBinding(e)||
    intent.target_key!==targetKey(e)||draft.eventId!==event.id||draft.status!=='APPROVED'||approval.version!==draft.version||
    approval.textDigest!==digest(draft.text)||intent.text_digest!==digest(draft.text)||digest(approval.snapshot)!==intent.target_digest||
    approval.snapshot.eventBinding!==event.binding||approval.snapshot.accountId!==e.accountId||approval.snapshot.ownId!==own.own_id||
    approval.snapshot.targetKey!==intent.target_key||approval.snapshot.composerKey!==intent.target_key||!hash.test(approval.snapshot.contextDigest)||
    store.db.prepare('SELECT id FROM source_collisions WHERE event_id=? LIMIT 1').get(event.id)||
    store.db.prepare('SELECT id FROM verification_results WHERE intent_id=? AND verified=1 LIMIT 1').get(job.intent_id)||
    store.db.prepare("SELECT id FROM delivery_receipts WHERE send_intent_id=? AND result='CONFIRMED' LIMIT 1").get(job.intent_id))return;
  const receipt=store.db.prepare('SELECT result,proof_ref FROM delivery_receipts WHERE send_intent_id=? ORDER BY rowid DESC LIMIT 1').get(job.intent_id) as
    {result:string;proof_ref:string}|undefined;
  if(!receipt||receipt.result!=='UNCERTAIN'||!['NO_UNIQUE_BOUND_PROOF','POST_INTENT_FAILURE:READBACK:UNCLASSIFIED','POST_INTENT_FAILURE'].includes(receipt.proof_ref))return;
  if(store.db.prepare("SELECT name FROM sqlite_master WHERE name='human_reply_turns'").get()&&store.db.prepare(`SELECT command_id FROM human_reply_turns
    WHERE event_id=? AND status IN ('PREPARING','APPROVED','INTENT_RECORDED','UNCERTAIN') LIMIT 1`).get(event.id))return;
  let nativeIdDigest:string|undefined;
  if(e.channel==='COMMENT_NOTIFICATION'){
    if(!['COMMENT','REPLY'].includes(e.kind)||persisted.last_error!=='NO_COMPLETE_PROOF')return;
    const last=store.db.prepare(`SELECT event_type,detail_redacted FROM audit_events WHERE entity_id=? AND time>=?
      AND event_type LIKE 'COMMENT_READBACK_VERIFY_EXISTING_%' ORDER BY rowid DESC LIMIT 1`)
      .get(digest(['comment',e.videoId,e.commentId]),job.boundary) as {event_type:string;detail_redacted:string}|undefined;
    if(last?.event_type.includes('_FILTERED_')){
      const counts=JSON.parse(last.detail_redacted) as Record<string,unknown>;
      if(counts.poll_sameText===1&&counts.poll_afterBoundary===0&&counts.poll_notFuture===1)return;
    }
  }else{
    if(e.kind!=='DM')return;
    if(!['OBSERVATION_DM_CONTENT_DOM_NOT_READY','OBSERVATION_DM_MESSAGES_DOM_NOT_READY'].includes(persisted.last_error)){
      if(persisted.last_error!=='NO_COMPLETE_PROOF')return;
      const diagnostic=store.db.prepare(`SELECT event_type FROM audit_events WHERE entity_id=? AND time>=? AND event_type LIKE 'DM_READBACK_%'
        ORDER BY rowid DESC LIMIT 1`).get(digest(['dm',e.conversationId,e.platformEventId]),job.boundary) as {event_type:string}|undefined;
      if(!diagnostic||!/^DM_READBACK_(?:FIRST_POLL|REFRESH_POLL)_(?:CONTEXT_INCOMPLETE|NO_COMPLETE_PROOF)$/u.test(diagnostic.event_type))return;
    }
    nativeIdDigest=dmCandidate(store,event,own.own_id,draft.text,boundary,now);if(!nativeIdDigest)return;
    const linked=store.db.prepare('SELECT native_id_digest FROM chat_delivery_links WHERE intent_id=?').get(job.intent_id) as {native_id_digest:string}|undefined;
    if(linked&&linked.native_id_digest!==nativeIdDigest)return;
  }
  return {revision:digest([event.binding,intent,approval,draft.version,draft.text,own.own_id,nativeIdDigest??null]),
    ...(nativeIdDigest?{nativeIdDigest}:{})};
}

/** Fixed repair version: one claim per intent, including crashes, with no replay or send capability. */
export function claimReceiptRecheck(store:EventStore,now:number):ReceiptRecheckJob|undefined {
  return store.db.transaction(()=>{
    const jobs=store.db.prepare(`SELECT j.*,i.rowid AS ordinal FROM verification_jobs j JOIN send_intents i ON i.id=j.intent_id
      WHERE j.state='REVIEW' AND j.attempts=2 AND i.status='UNCERTAIN'
      AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.entity_id=i.id AND a.event_type=?)
      ORDER BY CASE WHEN i.rowid>? THEN 0 ELSE 1 END,i.rowid LIMIT 100`)
      .all(claimed,scanAfter.get(store)??0) as (VerificationJob&{ordinal:number})[];
    for(const {ordinal,...job} of jobs){
      // Skips advance the next bounded scan without consuming future eligibility.
      scanAfter.set(store,ordinal);
      let qualified:Qualification|undefined;try{qualified=qualify(store,job,now);}catch{continue;}
      if(!qualified)continue;
      store.audit(claimed,job.intent_id);
      return {...job,deadline:now+30_000,recheckRevision:qualified.revision,...(qualified.nativeIdDigest?{nativeIdDigest:qualified.nativeIdDigest}:{})};
    }
    return undefined;
  }).immediate();
}

/** Check again after asynchronous browsing; a changed target, draft or observed native candidate invalidates the result. */
export function receiptRecheckStillBound(store:EventStore,job:ReceiptRecheckJob,now:number):boolean {
  try{return qualify(store,job,now)?.revision===job.recheckRevision;}catch{return false;}
}
