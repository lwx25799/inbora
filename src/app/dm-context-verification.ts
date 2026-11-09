import {digest,dmClockToleranceMs,eventBinding,isStrong,targetKey} from '../core/contracts.js';
import {ChatMessageStore} from '../storage/chat-messages.js';
import type {EventStore} from '../storage/store.js';

export interface VerificationJob {intent_id:string;event_id:string;boundary:string;target_digest:string;attempts:number;next_at:number;deadline:number;state:string;nativeIdDigest?:string}

/** A new read-only evidence contract; never renews old attempts or permits another submission. */
export function claimDmContextVerification(store:EventStore,now:number):VerificationJob|undefined {
  return store.db.transaction(()=>{
    if(store.db.prepare("SELECT id FROM audit_events WHERE event_type='DM_CONTEXT_WINDOW_CHECKED' LIMIT 1").get())return undefined;
    const candidates=store.db.prepare(`SELECT j.* FROM verification_jobs j JOIN send_intents i ON i.id=j.intent_id
      JOIN inbound_events e ON e.id=i.event_id WHERE j.state='REVIEW' AND j.attempts=2 AND i.status='UNCERTAIN'
      AND e.channel='DIRECT_MESSAGE' AND j.last_error='NO_COMPLETE_PROOF'
      AND EXISTS(SELECT 1 FROM delivery_receipts r WHERE r.send_intent_id=i.id AND r.result='UNCERTAIN'
        AND r.proof_ref='POST_INTENT_FAILURE:READBACK:UNCLASSIFIED')
      AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.entity_id=i.id AND a.event_type='DM_CONTEXT_WINDOW_CHECKED')
      AND NOT EXISTS(SELECT 1 FROM verification_results r WHERE r.intent_id=i.id AND r.verified=1)
      AND EXISTS(SELECT 1 FROM policy_commands p JOIN manual_send_commands c ON c.command_id=p.command_id
        WHERE c.intent_id=i.id AND c.event_id=i.event_id)
      ORDER BY i.attempt_started_at DESC,i.rowid DESC LIMIT 1`).all() as VerificationJob[];
    const chat=new ChatMessageStore(store);
    for(const job of candidates){
      const intent=store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(job.intent_id) as {
        event_id:string;draft_id:string;target_key:string;target_digest:string;text_digest:string;attempt_started_at:string};
      const event=store.event(job.event_id),draft=store.draft(intent.draft_id),approval=draft.approval;
      if(!isStrong(event.payload)||event.payload.kind!=='DM'||!approval||!Number.isFinite(Date.parse(job.boundary))||
        intent.event_id!==job.event_id||intent.attempt_started_at!==job.boundary||intent.target_digest!==job.target_digest||
        intent.target_key!==targetKey(event.payload)||approval.snapshot.eventBinding!==eventBinding(event.payload)||
        approval.snapshot.accountId!==event.payload.accountId||approval.snapshot.targetKey!==intent.target_key||approval.snapshot.composerKey!==intent.target_key||
        approval.version!==draft.version||approval.textDigest!==digest(draft.text)||intent.text_digest!==digest(draft.text)||
        digest(approval.snapshot)!==job.target_digest||!/^[a-f0-9]{64}$/u.test(approval.snapshot.contextDigest)||
        store.db.prepare('SELECT id FROM source_collisions WHERE event_id=? LIMIT 1').get(event.id)||
        !store.db.prepare("SELECT draft_id FROM draft_revisions WHERE draft_id=? AND version=? AND origin='AUTO_POLICY' AND text=?")
          .get(draft.id,draft.version,draft.text)||!store.db.prepare(`SELECT p.command_id FROM policy_commands p
          JOIN manual_send_commands c ON c.command_id=p.command_id WHERE c.intent_id=? AND c.event_id=?`).get(job.intent_id,event.id))continue;
      const rows=store.db.prepare('SELECT id FROM chat_messages WHERE account_id=? AND conversation_id=? AND conflicted=0')
        .all(event.payload.accountId,event.payload.conversationId) as {id:string}[];
      const boundary=Date.parse(job.boundary);
      const matches=rows.flatMap(row=>{const message=chat.get(row.id),time=Date.parse(message?.payload.occurredAt??'');
        return message&&isStrong(message.payload)&&message.ownId===approval.snapshot.ownId&&message.payload.text===draft.text&&
          time<boundary&&time>=boundary-dmClockToleranceMs?[message]:[];});
      if(matches.length!==1)continue;
      store.audit('DM_CONTEXT_WINDOW_CHECKED',job.intent_id);
      return {...job,deadline:now+30_000,nativeIdDigest:digest(matches[0]!.payload.platformEventId)};
    }
    return undefined;
  }).immediate();
}
